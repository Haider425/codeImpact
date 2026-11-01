/// <reference types="node" />
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyzeRepository } from './engine'
import type { AnalysisResult, DemoRepository, SourceFile } from './types'

const wasmBasePath = fileURLToPath(new URL('../../public/wasm', import.meta.url))

const py = (path: string, source: string): SourceFile => ({ path, source, language: 'python' })
const ts = (path: string, source: string): SourceFile => ({ path, source, language: 'typescript' })

function repository(baseFiles: SourceFile[], headFiles: SourceFile[]): DemoRepository {
  return {
    owner: 'test',
    name: 'repository',
    pullRequest: { number: 1, title: 'test change', author: 'test', baseRef: 'main', headRef: 'change' },
    base: { sha: 'base', files: baseFiles },
    head: { sha: 'head', files: headFiles },
  }
}

/** Apply `edits` (path → new source) to `files` to build the head revision. */
function analyze(files: SourceFile[], edits: Record<string, string>, maxDepth?: number) {
  const head = files.map((file) => (file.path in edits ? { ...file, source: edits[file.path] } : file))
  return analyzeRepository(repository(files, head), { wasmBasePath, maxDepth })
}

const findingNames = (result: AnalysisResult) => result.findings.map((finding) => finding.symbol.qualifiedName).sort()
const testNames = (result: AnalysisResult) => result.tests.map((test) => test.test.name).sort()

describe('Python resolution', () => {
  it('follows relative imports, multi-line import lists, and package re-exports', async () => {
    const files = [
      py('src/pkg/__init__.py', 'from .core import (\n    compute,\n    helper as h,\n)\n'),
      py('src/pkg/core.py', 'def compute(x):\n    return x + 1\n\ndef helper():\n    return 0\n'),
      py('src/pkg/api.py', 'from . import core\nfrom .core import helper\n\ndef via_module():\n    return core.compute(1)\n\ndef via_name():\n    return helper()\n'),
      py('tests/test_pkg.py', 'from pkg import compute\n\ndef test_compute():\n    assert compute(1) == 2\n'),
    ]
    const result = await analyze(files, { 'src/pkg/core.py': 'def compute(x):\n    return x + 2\n\ndef helper():\n    return 0\n' })
    expect(findingNames(result)).toEqual(['via_module'])
    expect(testNames(result)).toEqual(['test_compute'])
    expect(result.tests[0].connection).toBe('call-path')
  }, 30_000)

  it('resolves self method calls and constructor calls without flagging the whole class', async () => {
    const files = [
      py('src/shop.py', [
        'class Cart:',
        '    def __init__(self, items):',
        '        self.items = items',
        '',
        '    def total(self):',
        '        return self._sum()',
        '',
        '    def _sum(self):',
        '        return sum(self.items)',
        '',
        'def make_cart():',
        '    return Cart([])',
        '',
      ].join('\n')),
    ]
    const changedInit = files[0].source.replace('self.items = items', 'self.items = list(items)')
    const result = await analyze(files, { 'src/shop.py': changedInit })
    expect(result.changes.map((change) => change.head?.qualifiedName)).toEqual(['Cart.__init__'])
    expect(findingNames(result)).toEqual(['make_cart'])

    const changedSum = files[0].source.replace('return sum(self.items)', 'return sum(self.items) or 0')
    const second = await analyze(files, { 'src/shop.py': changedSum })
    expect(findingNames(second)).toEqual(['Cart.total'])
    const edge = second.edges.find((candidate) => candidate.id === second.findings[0].path.edgeIds[0])
    expect(edge).toMatchObject({ resolutionStatus: 'resolved', extractionMethod: expect.stringContaining('self/this') })
  }, 30_000)

  it('marks receiver-unknown method calls as inferred and says so in the reasons', async () => {
    const files = [
      py('src/signer.py', 'class Signer:\n    def sign(self, value):\n        return value\n'),
      py('tests/test_signer.py', 'from src.signer import Signer\n\ndef test_sign():\n    s = Signer()\n    assert s.sign("a") == "a"\n'),
    ]
    const result = await analyze(files, { 'src/signer.py': 'class Signer:\n    def sign(self, value):\n        return value + "."\n' })
    const test = result.tests.find((candidate) => candidate.test.name === 'test_sign')
    expect(test?.connection).toBe('call-path')
    expect(result.edges.find((edge) => edge.id === test?.path.edgeIds[0])?.resolutionStatus).toBe('inferred')
    expect(test?.reasons.join(' ')).toContain('inferred')
  }, 30_000)

  it('detects renames, module-level edits, and changed tests', async () => {
    const files = [
      py('src/config.py', 'LIMIT = 10\n\ndef old_name():\n    return LIMIT\n'),
      py('tests/test_config.py', 'import src.config\n\ndef test_limit():\n    assert src.config.LIMIT == 10\n'),
    ]
    const result = await analyze(files, {
      'src/config.py': 'LIMIT = 20\n\ndef new_name():\n    return LIMIT\n',
      'tests/test_config.py': 'import src.config\n\ndef test_limit():\n    assert src.config.LIMIT == 20\n',
    })
    const types = Object.fromEntries(result.changes.map((change) => [change.head?.qualifiedName ?? change.base?.qualifiedName, change.changeType]))
    expect(types).toMatchObject({ new_name: 'renamed', 'src/config.py': 'module', test_limit: 'modified' })
    expect(result.tests).toHaveLength(1)
    expect(result.tests[0]).toMatchObject({ connection: 'changed', score: 100 })
  }, 30_000)

  it('falls back to file-import evidence when no call path resolves', async () => {
    const files = [
      py('src/settings.py', 'TIMEOUT = 5\n'),
      py('tests/test_settings.py', 'from src.settings import TIMEOUT\n\ndef test_timeout():\n    assert TIMEOUT > 0\n'),
    ]
    const result = await analyze(files, { 'src/settings.py': 'TIMEOUT = 6\n' })
    expect(result.tests).toHaveLength(1)
    expect(result.tests[0]).toMatchObject({ connection: 'file-import', score: 15 })
    expect(result.graphSymbolIds).not.toContain(result.tests[0].test.id)
  }, 30_000)

  it('ignores @overload stubs and attributes decorator edits to the decorated function', async () => {
    const source = [
      'import typing',
      '',
      '@typing.overload',
      'def load(x: int) -> int: ...',
      '@typing.overload',
      'def load(x: str) -> str: ...',
      'def load(x):',
      '    return x',
      '',
      '@cached',
      'def other():',
      '    return load(1)',
      '',
    ].join('\n')
    const files = [py('src/io.py', source)]
    const shifted = await analyze(files, { 'src/io.py': `\n\n\n${source}` })
    expect(shifted.changes).toEqual([])

    const decorated = await analyze(files, { 'src/io.py': source.replace('@cached', '@cached(maxsize=2)') })
    expect(decorated.changes.map((change) => [change.head?.qualifiedName, change.changeType])).toEqual([['other', 'signature']])
  }, 30_000)

  it('links small override families as inferred polymorphic edges', async () => {
    const files = [
      py('src/base.py', 'class Base:\n    def run(self):\n        return 1\n'),
      py('src/child.py', 'from src.base import Base\n\nclass Child(Base):\n    def run(self):\n        return 2\n'),
      py('tests/test_run.py', 'from src.base import Base\nfrom src.child import Child\n\ndef test_run(thing):\n    assert thing.run()\n'),
    ]
    const result = await analyze(files, { 'src/child.py': files[1].source.replace('return 2', 'return 3') })
    expect(result.tests.map((test) => test.test.name)).toEqual(['test_run'])
    const edge = result.edges.find((candidate) => candidate.id === result.tests[0].path.edgeIds[0])
    expect(edge).toMatchObject({ resolutionStatus: 'inferred', extractionMethod: expect.stringContaining('one of 2') })
  }, 30_000)

  it('honours the traversal depth limit and reports it', async () => {
    const files = [py('src/chain.py', 'def a():\n    return 1\n\ndef b():\n    return a()\n\ndef c():\n    return b()\n\ndef d():\n    return c()\n')]
    const result = await analyze(files, { 'src/chain.py': files[0].source.replace('return 1', 'return 2') }, 2)
    expect(findingNames(result)).toEqual(['b', 'c'])
    expect(result.settings).toMatchObject({ maxDepth: 2, depthLimited: true })
    expect(result.limitations.some((item) => item.includes('limit was reached'))).toBe(true)
  }, 30_000)
})

describe('TypeScript resolution', () => {
  it('follows barrel re-exports, namespace imports, default imports, and TSX files', async () => {
    const files = [
      ts('src/lib/math.ts', 'export function add(a: number, b: number) {\n  return a + b\n}\n'),
      ts('src/lib/index.ts', 'export { add } from "./math"\nexport * from "./format"\n'),
      ts('src/lib/format.ts', 'export default function fmt(n: number) {\n  return String(n)\n}\nexport function pad(s: string) {\n  return s\n}\n'),
      ts('src/total.ts', 'import { add } from "./lib"\nimport * as lib from "./lib/format"\nimport fmt from "./lib/format"\n\nexport function total() {\n  return add(1, 2)\n}\nexport function show() {\n  return lib.pad(fmt(total()))\n}\n'),
      ts('src/View.tsx', 'import { show } from "./total"\n\nexport function View() {\n  return <span>{show()}</span>\n}\n'),
      ts('src/total.test.ts', 'import { total } from "./total"\n\ndescribe("total", () => {\n  it("adds", () => {\n    expect(total()).toBe(3)\n  })\n})\n'),
    ]
    const result = await analyze(files, { 'src/lib/math.ts': 'export function add(a: number, b: number) {\n  return b + a\n}\n' })
    expect(findingNames(result)).toEqual(['View', 'show', 'total'])
    expect(result.tests.map((test) => test.test.qualifiedName)).toEqual(['total > adds'])

    const fmtChange = await analyze(files, { 'src/lib/format.ts': files[2].source.replace('String(n)', 'n.toString()') })
    expect(findingNames(fmtChange)).toEqual(['View', 'show'])
  }, 30_000)

  it('resolves this.method() and new Class() calls', async () => {
    const files = [
      ts('src/store.ts', [
        'export class Store {',
        '  constructor(private items: number[]) {}',
        '  count() {',
        '    return this.size()',
        '  }',
        '  size() {',
        '    return this.items.length',
        '  }',
        '}',
        'export function makeStore() {',
        '  return new Store([])',
        '}',
        '',
      ].join('\n')),
    ]
    const result = await analyze(files, { 'src/store.ts': files[0].source.replace('this.items.length', 'this.items.length + 0') })
    expect(findingNames(result)).toEqual(['Store.count'])
    const ctor = await analyze(files, { 'src/store.ts': files[0].source.replace('private items: number[]', 'private items: number[] = []') })
    expect(findingNames(ctor)).toEqual(['makeStore'])
  }, 30_000)
})
