import { describe, expect, it } from 'vitest'
import type { SourceFile } from '../../src/analysis/types'
import { breakLocations, injectBug } from './inject'
import type { InjectionTarget } from './inject'

const pyLib = [
  'import os',
  '',
  '@cache',
  'def load_config(path, strict=False):',
  '    """Read a config file."""',
  '    if strict:',
  '        return parse_strict(path)',
  '    return {"path": path}',
  '',
  'def other():',
  '    return load_config("a")',
  '',
].join('\n')
const pyTarget: InjectionTarget = { path: 'pkg/config.py', name: 'load_config', language: 'python', startLine: 3, endLine: 8 }

const tsLib = [
  "import { x } from './x'",
  '',
  'export function formatUrl<T>(input: string, opts?: T): string {',
  '  if (!input) {',
  "    return ''",
  '  }',
  '  return input.trim()',
  '}',
  '',
].join('\n')
const tsTarget: InjectionTarget = { path: 'src/url.ts', name: 'formatUrl', language: 'typescript', startLine: 3, endLine: 8 }

describe('injectBug', () => {
  it('adds a required leading parameter', () => {
    expect(injectBug(pyLib, pyTarget, 'signature')!.split('\n')[3]).toBe('def load_config(codeimpact_extra, path, strict=False):')
    expect(injectBug(tsLib, tsTarget, 'signature')!.split('\n')[2]).toBe('export function formatUrl<T>(codeimpactExtra: number, input: string, opts?: T): string {')
    const empty = injectBug('def ping():\n    return 1\n', { ...pyTarget, name: 'ping', startLine: 1, endLine: 2 }, 'signature')
    expect(empty!.split('\n')[0]).toBe('def ping(codeimpact_extra):')
  })

  it('renames only the definition and deletes the whole definition with decorators', () => {
    const renamed = injectBug(pyLib, pyTarget, 'rename')!.split('\n')
    expect(renamed[3]).toBe('def load_config_renamed(path, strict=False):')
    expect(renamed[10]).toBe('    return load_config("a")')
    expect(injectBug(pyLib, pyTarget, 'delete')!.split('\n').slice(0, 4)).toEqual(['import os', '', '', 'def other():'])
    expect(injectBug(tsLib, tsTarget, 'rename')!).toContain('export function formatUrlRenamed<T>(')
  })

  it('wraps single-line returns of the target only', () => {
    const lines = injectBug(pyLib, pyTarget, 'return-shape')!.split('\n')
    expect(lines.slice(6, 8)).toEqual(['        return [parse_strict(path)]', '    return [{"path": path}]'])
    expect(lines[10]).toBe('    return load_config("a")')
    expect(injectBug(tsLib, tsTarget, 'return-shape')!.split('\n').slice(4, 7)).toEqual(["    return ['']", '  }', '  return [input.trim()]'])
  })

  it('inserts an unconditional raise at the top of the body', () => {
    expect(injectBug(pyLib, pyTarget, 'raise')!.split('\n')[4]).toBe('    raise RuntimeError("codeimpact injected")')
    expect(injectBug(tsLib, tsTarget, 'raise')!.split('\n')[3]).toBe('  throw new Error("codeimpact injected")')
    expect(injectBug('def f(): return 1\n', { ...pyTarget, name: 'f', startLine: 1, endLine: 1 }, 'raise')).toBeUndefined()
    expect(injectBug('export const f = (a: number) => a + 1\n', { ...tsTarget, name: 'f', startLine: 1, endLine: 1 }, 'raise')).toBeUndefined()
  })
})

describe('breakLocations', () => {
  const py = (path: string, source: string): SourceFile => ({ path, source, language: 'python' })
  const files = [
    py('pkg/config.py', pyLib),
    py('pkg/app.py', [
      'from pkg.config import (',
      '    load_config,',
      ')',
      '',
      'def run():',
      '    cfg = load_config("x")',
      '    load_config("y")',
      '    # load_config("comment")',
      '    try:',
      '        load_config("z")',
      '    except RuntimeError:',
      '        pass',
      '    try:',
      '        load_config("w")',
      '    except KeyError:',
      '        pass',
      '    return cfg',
    ].join('\n')),
  ]
  const at = (locations: ReturnType<typeof breakLocations>) => locations.map((l) => `${l.kind} ${l.path}:${l.line}${l.inChangedFile ? ' (changed file)' : ''}`)

  it('finds every call site for a signature change, skipping the definition and comments', () => {
    expect(at(breakLocations(files, pyTarget, 'signature'))).toEqual([
      'call pkg/config.py:11 (changed file)', 'call pkg/app.py:6', 'call pkg/app.py:7', 'call pkg/app.py:10', 'call pkg/app.py:14',
    ])
  })

  it('adds imports of the name for renames and deletions', () => {
    expect(at(breakLocations(files, pyTarget, 'rename'))).toContain('import pkg/app.py:2')
  })

  it('keeps only value-using calls for a return-shape change', () => {
    expect(at(breakLocations(files, pyTarget, 'return-shape'))).toEqual(['call pkg/config.py:11 (changed file)', 'call pkg/app.py:6'])
  })

  it('drops calls handled by an enclosing try for a new raise', () => {
    expect(at(breakLocations(files, pyTarget, 'raise'))).toEqual([
      'call pkg/config.py:11 (changed file)', 'call pkg/app.py:6', 'call pkg/app.py:7', 'call pkg/app.py:14',
    ])
  })

  it('handles TypeScript imports, re-exports, and try blocks', () => {
    const ts = (path: string, source: string): SourceFile => ({ path, source, language: 'typescript' })
    const tsFiles = [
      ts('src/url.ts', tsLib),
      ts('src/index.ts', "export { formatUrl } from './url'\nexport * from './x'\n"),
      ts('src/use.ts', [
        "import { formatUrl } from './url'",
        'export function a() {',
        "  return formatUrl('a')",
        '}',
        'export function b() {',
        '  try {',
        "    formatUrl('b')",
        '  } catch {',
        '    return 1',
        '  }',
        '}',
      ].join('\n')),
    ]
    expect(at(breakLocations(tsFiles, tsTarget, 'delete'))).toEqual(['import src/index.ts:1', 'import src/use.ts:1', 'call src/use.ts:3', 'call src/use.ts:7'])
    expect(at(breakLocations(tsFiles, tsTarget, 'raise'))).toEqual(['call src/use.ts:3'])
  })

  it('identifies a name inside a multi-line import by its own line and by the statement start', () => {
    const files = [
      { path: 'src/url.ts', language: 'typescript' as const, source: tsLib },
      { path: 'src/app.ts', language: 'typescript' as const, source: "import {\n  other,\n  formatUrl,\n} from './url'\nformatUrl('x')\n" },
    ]
    const imports = breakLocations(files, tsTarget, 'rename').filter((location) => location.kind === 'import')
    expect(imports).toEqual([{ path: 'src/app.ts', line: 3, kind: 'import', inChangedFile: false, aliasLines: [1] }])
  })
})
