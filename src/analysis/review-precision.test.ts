/// <reference types="node" />
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyzeRepository } from './engine'
import { exceptionAncestors, isCaught } from './exceptions'
import { RULES } from './review'
import type { AnalysisResult, SourceFile } from './types'

const wasmBasePath = fileURLToPath(new URL('../../public/wasm', import.meta.url))
const py = (path: string, source: string): SourceFile => ({ path, source, language: 'python' })
const ts = (path: string, source: string): SourceFile => ({ path, source, language: 'typescript' })

function analyze(files: SourceFile[], edits: Record<string, string>) {
  return analyzeRepository({
    owner: 't', name: 'r',
    pullRequest: { number: 1, title: 't', author: 't', baseRef: 'main', headRef: 'change' },
    base: { sha: 'base', files },
    head: { sha: 'head', files: files.map((file) => (file.path in edits ? { ...file, source: edits[file.path] } : file)) },
  }, { wasmBasePath })
}

const grouped = (result: AnalysisResult) => result.review.find((finding) => finding.ruleId === RULES.unupdatedCaller)
const kinds = (result: AnalysisResult) => grouped(result)?.details?.changeKinds
const pyCaller = py('app/use.py', 'from app.core import f\n\ndef go():\n    return f(1)\n')
const tsCaller = ts('src/use.ts', 'import { f } from "./core"\n\nexport function go() {\n  return f(1)\n}\n')

describe('formatting-insensitive return comparison', () => {
  it.each([
    ['whitespace and comments', 'def f(a):\n    return a+1\n', 'def f(a):\n    # add one\n    return a + 1  # still one\n'],
    ['redundant parentheses and line breaks', 'def f(a):\n    return a + 1\n', 'def f(a):\n    return (\n        a + 1\n    )\n'],
    ['quote style', "def f(a):\n    return {'k': a}\n", 'def f(a):\n    return {"k": a}\n'],
    ['trailing commas', 'def f(a):\n    return [a, 2]\n', 'def f(a):\n    return [\n        a,\n        2,\n    ]\n'],
    ['annotation and default spacing', 'def f(a: int=1) -> int:\n    return a\n', 'def f(a: int = 1) -> int:\n    return a\n'],
  ])('treats %s in Python as internals only', async (_label, before, after) => {
    const result = await analyze([py('app/core.py', before), pyCaller], { 'app/core.py': after })
    // A pure formatting edit may not even register as a change; if it does, it must be internals only.
    if (grouped(result)) {
      expect(kinds(result)).toEqual(['internals'])
      expect(grouped(result)!.severity).toBe('low')
    }
  }, 30_000)

  it('treats reformatted TypeScript object returns as internals only', async () => {
    const before = 'export function f(a: number) {\n  return { a: a, b: 2 }\n}\n'
    const after = 'export function f(a: number) {\n  // same value\n  return {\n    a: a,\n    b: 2,\n  };\n}\n'
    const result = await analyze([ts('src/core.ts', before), tsCaller], { 'src/core.ts': after })
    expect(kinds(result)).toEqual(['internals'])
  }, 30_000)

  it.each([
    ['an operator', 'def f(a):\n    return a + 1\n', 'def f(a):\n    return a - 1\n'],
    ['a bytes prefix', 'def f(a):\n    return "x"\n', 'def f(a):\n    return b"x"\n'],
    ['a tuple versus a parenthesized value', 'def f(a):\n    return (a)\n', 'def f(a):\n    return (a,)\n'],
  ])('still detects a real return change: %s', async (_label, before, after) => {
    const result = await analyze([py('app/core.py', before), pyCaller], { 'app/core.py': after })
    expect(kinds(result)).toEqual(['return-value'])
    expect(grouped(result)!.severity).toBe('medium')
  }, 30_000)

  it('still detects a real type change but not a reformatted one', async () => {
    const base = 'def f(a: Optional[int]) -> int:\n    return 1\n'
    const reformatted = await analyze([py('app/core.py', base), pyCaller], { 'app/core.py': 'def f(a: Optional[ int ]) -> int:\n    return 1\n' })
    expect(grouped(reformatted)).toMatchObject({ severity: 'low', details: { changeKinds: ['internals'] } })
    const changed = await analyze([py('app/core.py', base), pyCaller], { 'app/core.py': 'def f(a: Optional[str]) -> int:\n    return 1\n' })
    expect(kinds(changed)).toEqual(['param-types'])
  }, 30_000)
})

describe('exception inheritance', () => {
  it('walks the built-in Python hierarchy', () => {
    const none = new Map<string, string[]>()
    expect([...exceptionAncestors('FileNotFoundError', none)]).toEqual(['FileNotFoundError', 'OSError', 'Exception', 'BaseException'])
    expect(isCaught(['LookupError'], 'KeyError', none)).toBe(true)
    expect(isCaught(['IndexError'], 'KeyError', none)).toBe(false)
    expect(isCaught(['Exception'], 'SystemExit', none)).toBe(false)
    expect(isCaught(['BaseException'], 'SystemExit', none)).toBe(true)
    expect(isCaught(['*'], 'Anything', none)).toBe(true)
    expect(isCaught(null, 'ValueError', none)).toBe(false)
  })

  const raising = (type: string) => `def f(a):\n    if not a:\n        raise ${type}("bad")\n    return a\n`
  const handler = (path: string, caught: string) => py(path, `from app.core import f\n\ndef go(a):\n    try:\n        f(a)\n    except ${caught}:\n        pass\n`)

  it('treats a caller catching a built-in parent class as handled', async () => {
    const files = [py('app/core.py', 'def f(a):\n    return a\n'), handler('app/lookup.py', 'LookupError'), handler('app/index.py', 'IndexError'), handler('app/broad.py', 'Exception')]
    const result = await analyze(files, { 'app/core.py': raising('KeyError') })
    expect(grouped(result)!.details!.callers.map((c) => [c.location.path, c.affected])).toEqual([
      ['app/index.py', true], ['app/broad.py', false], ['app/lookup.py', false],
    ])
  }, 30_000)

  it('reads base classes of exceptions defined in the repository', async () => {
    const files = [
      py('app/exc.py', 'class BadData(Exception):\n    pass\n\nclass BadSignature(BadData):\n    pass\n'),
      py('app/core.py', 'from app.exc import BadSignature\n\ndef f(a):\n    return a\n'),
      handler('app/parent.py', 'BadData'),
      py('app/dotted.py', 'from app import exc\nfrom app.core import f\n\ndef go(a):\n    try:\n        f(a)\n    except exc.BadData:\n        pass\n'),
      handler('app/sibling.py', 'ValueError'),
      handler('app/root.py', 'Exception'),
    ]
    const result = await analyze(files, { 'app/core.py': `from app.exc import BadSignature\n\n${raising('BadSignature')}` })
    expect(grouped(result)).toMatchObject({ severity: 'medium', details: { changeKinds: ['raises'] } })
    expect(grouped(result)!.details!.callers.map((c) => [c.location.path, c.affected])).toEqual([
      ['app/sibling.py', true], ['app/dotted.py', false], ['app/parent.py', false], ['app/root.py', false],
    ])
  }, 30_000)
})
