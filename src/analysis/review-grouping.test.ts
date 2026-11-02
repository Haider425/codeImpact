/// <reference types="node" />
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyzeRepository } from './engine'
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

const grouped = (result: AnalysisResult) => result.review.filter((finding) => finding.ruleId === RULES.unupdatedCaller)
const callerStates = (result: AnalysisResult) => (grouped(result)[0]?.details?.callers ?? []).map((caller) => [caller.location.path, caller.affected])

describe('grouped unupdated-caller findings', () => {
  it('groups every untouched caller of one function into a single finding', async () => {
    const files = [
      py('app/core.py', 'def load(path):\n    return open(path).read()\n'),
      py('app/a.py', 'from app.core import load\n\ndef first():\n    return load("a")\n'),
      py('app/b.py', 'from app.core import load\n\ndef second():\n    load("b")\n'),
    ]
    const result = await analyze(files, { 'app/core.py': 'def load(path):\n    return open(path).read().strip()\n' })
    expect(grouped(result)).toHaveLength(1)
    expect(grouped(result)[0]).toMatchObject({ severity: 'medium', details: { changeKinds: ['return-value'] }, affected: { symbol: 'first' } })
    expect(callerStates(result)).toEqual([['app/a.py', true], ['app/b.py', false]])
    expect(grouped(result)[0].message).toContain('`first` uses the return value')
    expect(grouped(result)[0].evidence).toHaveLength(2)
  }, 30_000)

  it('keeps internals-only changes at low severity even when callers use the result', async () => {
    const files = [
      py('app/core.py', 'def load(path):\n    data = open(path).read()\n    return data\n'),
      py('app/a.py', 'from app.core import load\n\ndef first():\n    return load("a")\n'),
    ]
    const result = await analyze(files, { 'app/core.py': 'def load(path):\n    with open(path) as handle:\n        data = handle.read()\n    return data\n' })
    expect(grouped(result)).toMatchObject([{ severity: 'low', details: { changeKinds: ['internals'] } }])
    expect(grouped(result)[0].message).toContain('internally only')
  }, 30_000)

  it('stays low when a return change only reaches callers that ignore the result', async () => {
    const files = [
      py('app/core.py', 'def save(item):\n    return True\n'),
      py('app/a.py', 'from app.core import save\n\ndef store(x):\n    save(x)\n    return x\n'),
    ]
    const result = await analyze(files, { 'app/core.py': 'def save(item):\n    return item.id\n' })
    expect(grouped(result)).toMatchObject([{ severity: 'low', details: { changeKinds: ['return-value'] } }])
    expect(grouped(result)[0].message).toContain('none of its 1 caller')
  }, 30_000)

  it('escalates a newly raised exception only for callers that do not catch it', async () => {
    const files = [
      py('app/core.py', 'def parse(text):\n    return int(text)\n'),
      py('app/bare.py', 'from app.core import parse\n\ndef go(t):\n    parse(t)\n'),
      py('app/guarded.py', 'from app.core import parse\n\ndef go(t):\n    try:\n        parse(t)\n    except ValueError:\n        pass\n'),
      py('app/broad.py', 'from app.core import parse\n\ndef go(t):\n    try:\n        parse(t)\n    except Exception:\n        pass\n'),
      py('app/other.py', 'from app.core import parse\n\ndef go(t):\n    try:\n        parse(t)\n    except KeyError:\n        pass\n'),
    ]
    const result = await analyze(files, { 'app/core.py': 'def parse(text):\n    if not text:\n        raise ValueError("empty")\n    return int(text)\n' })
    expect(grouped(result)).toMatchObject([{ severity: 'medium', details: { changeKinds: ['raises'] } }])
    expect(callerStates(result)).toEqual([['app/bare.py', true], ['app/other.py', true], ['app/broad.py', false], ['app/guarded.py', false]])
    const other = grouped(result)[0].details!.callers.find((caller) => caller.location.path === 'app/other.py')
    expect(other?.reasons[0]).toContain('has a try block that does not catch `ValueError`')
  }, 30_000)

  it('treats any TypeScript catch as handling a new throw', async () => {
    const files = [
      ts('src/core.ts', 'export function parse(t: string) {\n  return Number(t)\n}\n'),
      ts('src/use.ts', 'import { parse } from "./core"\n\nexport function go(t: string) {\n  try {\n    parse(t)\n  } catch {\n    return 0\n  }\n}\n'),
    ]
    const result = await analyze(files, { 'src/core.ts': 'export function parse(t: string) {\n  if (!t) throw new RangeError("empty")\n  return Number(t)\n}\n' })
    expect(grouped(result)).toMatchObject([{ severity: 'low', details: { changeKinds: ['raises'] } }])
  }, 30_000)

  it('escalates changed defaults only for callers that rely on them', async () => {
    const files = [
      py('app/core.py', 'def fetch(url, timeout=10):\n    return url\n'),
      py('app/relies.py', 'from app.core import fetch\n\ndef go():\n    fetch("u")\n'),
      py('app/explicit.py', 'from app.core import fetch\n\ndef go():\n    fetch("u", timeout=3)\n'),
    ]
    const result = await analyze(files, { 'app/core.py': 'def fetch(url, timeout=1):\n    return url\n' })
    expect(grouped(result)[0]).toMatchObject({ severity: 'medium', details: { changeKinds: ['defaults'] } })
    expect(callerStates(result)).toEqual([['app/relies.py', true], ['app/explicit.py', false]])
    expect(grouped(result)[0].details!.callers[0].reasons[0]).toBe('relies on the default of `timeout` (10 → 1)')
  }, 30_000)

  it('escalates parameter type changes for callers that pass that argument', async () => {
    const files = [
      ts('src/core.ts', 'export function scale(n: number, by?: number) {\n  return n * (by ?? 1)\n}\n'),
      ts('src/a.ts', 'import { scale } from "./core"\n\nexport function a() {\n  return scale(1, 2)\n}\n'),
      ts('src/b.ts', 'import { scale } from "./core"\n\nexport function b() {\n  scale(1)\n}\n'),
    ]
    const result = await analyze(files, { 'src/core.ts': 'export function scale(n: number, by?: bigint) {\n  return n * Number(by ?? 1)\n}\n' })
    expect(grouped(result)[0]).toMatchObject({ severity: 'medium', details: { changeKinds: ['return-value', 'param-types'] } })
    expect(callerStates(result)).toEqual([['src/a.ts', true], ['src/b.ts', false]])
  }, 30_000)

  it('does not escalate when the only affected caller is linked by an inferred edge', async () => {
    const files = [
      py('app/svc.py', 'class Service:\n    def run(self, job):\n        return job\n'),
      py('app/main.py', 'from app.svc import Service\n\ndef main(service):\n    return service.run("a")\n'),
    ]
    const result = await analyze(files, { 'app/svc.py': 'class Service:\n    def run(self, job):\n        return [job]\n' })
    expect(grouped(result)).toMatchObject([{ severity: 'low', confidence: 'inferred' }])
    expect(grouped(result)[0].details!.callers[0]).toMatchObject({ affected: true, confirmed: false })
  }, 30_000)
})
