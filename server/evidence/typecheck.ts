import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import type { AnalysisResult, ChangeRecord, ReviewFinding } from '../../src/analysis/types'
import { runCommand } from './sandbox'

export type Checker = 'tsc' | 'pyright'

export interface Diagnostic { tool: Checker; path: string; line: number; code: string; message: string }

export interface CheckerRun {
  tool: Checker
  status: 'ran' | 'skipped' | 'timeout' | 'error'
  reason?: string
  durationMs: number
  diagnostics: Diagnostic[]
}

const TSC_RUNNER = resolve(import.meta.dirname, 'tsc-check.mjs')

/** Configs to check: the root tsconfig if it owns files, plus each project reference. */
export function tsconfigTargets(dir: string): string[] {
  const root = join(dir, 'tsconfig.json')
  if (!existsSync(root)) return []
  const { config, error } = ts.readConfigFile(root, ts.sys.readFile)
  if (error || !config) return ['tsconfig.json']
  const targets = Array.isArray(config.files) && config.files.length === 0 && !config.include ? [] : ['tsconfig.json']
  for (const reference of (config.references ?? []) as { path: string }[]) {
    let path = join(dir, reference.path)
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'tsconfig.json')
    if (existsSync(path)) targets.push(path.slice(dir.length + 1).replaceAll('\\', '/'))
  }
  return [...new Set(targets)]
}

export async function runTsc(dir: string, timeoutMs: number): Promise<CheckerRun> {
  const targets = tsconfigTargets(dir)
  if (targets.length === 0) return { tool: 'tsc', status: 'skipped', reason: 'no tsconfig.json at the repository root', durationMs: 0, diagnostics: [] }
  const started = performance.now()
  const diagnostics: Diagnostic[] = []
  for (const target of targets) {
    const remaining = timeoutMs - (performance.now() - started)
    if (remaining <= 0) return { tool: 'tsc', status: 'timeout', reason: `stopped after ${Math.round(timeoutMs / 1000)} s`, durationMs: Math.round(performance.now() - started), diagnostics }
    const run = await runCommand(process.execPath, [TSC_RUNNER, join(dir, target), dir], { cwd: dir, timeoutMs: remaining })
    if (run.timedOut) return { tool: 'tsc', status: 'timeout', reason: `stopped after ${Math.round(timeoutMs / 1000)} s`, durationMs: Math.round(performance.now() - started), diagnostics }
    let output: { diagnostics?: Omit<Diagnostic, 'tool'>[]; error?: string }
    try {
      output = JSON.parse(run.stdout)
    } catch {
      return { tool: 'tsc', status: 'error', reason: (run.stderr || run.stdout).trim().split('\n')[0]?.slice(0, 300) || 'type checker produced no output', durationMs: Math.round(performance.now() - started), diagnostics }
    }
    if (output.error) return { tool: 'tsc', status: 'error', reason: output.error, durationMs: Math.round(performance.now() - started), diagnostics }
    diagnostics.push(...(output.diagnostics ?? []).map((d) => ({ ...d, tool: 'tsc' as const })))
  }
  const unique = [...new Map(diagnostics.map((d) => [`${d.path}:${d.line}:${d.code}:${d.message}`, d])).values()]
  return { tool: 'tsc', status: 'ran', durationMs: Math.round(performance.now() - started), diagnostics: unique }
}

/** A Python project counts as set up for type checking when it carries a pyright or mypy configuration. */
export function pythonTypeConfig(dir: string) {
  if (existsSync(join(dir, 'pyrightconfig.json'))) return 'pyrightconfig.json'
  if (existsSync(join(dir, 'mypy.ini'))) return 'mypy.ini'
  const pyproject = join(dir, 'pyproject.toml')
  if (existsSync(pyproject) && /^\[tool\.(pyright|mypy)\]/m.test(readFileSync(pyproject, 'utf8'))) return 'pyproject.toml'
  const setupCfg = join(dir, 'setup.cfg')
  if (existsSync(setupCfg) && /^\[mypy\]/m.test(readFileSync(setupCfg, 'utf8'))) return 'setup.cfg'
  return undefined
}

interface PyrightOutput {
  generalDiagnostics?: { file: string; severity: string; message: string; rule?: string; range?: { start?: { line: number } } }[]
}

export function parsePyright(stdout: string, dir: string): Omit<Diagnostic, 'tool'>[] | undefined {
  let output: PyrightOutput
  try {
    output = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const root = resolve(dir).replaceAll('\\', '/').toLowerCase()
  return (output.generalDiagnostics ?? [])
    .filter((d) => d.severity === 'error')
    .map((d) => {
      const file = resolve(d.file).replaceAll('\\', '/')
      return {
        path: file.toLowerCase().startsWith(`${root}/`) ? file.slice(root.length + 1) : file,
        line: (d.range?.start?.line ?? 0) + 1,
        code: d.rule ?? 'pyright',
        message: d.message.split('\n')[0],
      }
    })
}

export async function runPyright(dir: string, timeoutMs: number): Promise<CheckerRun> {
  const config = pythonTypeConfig(dir)
  if (!config) return { tool: 'pyright', status: 'skipped', reason: 'no pyright or mypy configuration found', durationMs: 0, diagnostics: [] }
  // pyright must come from PATH (e.g. installed by the workflow), never from the analyzed repository.
  const command = process.platform === 'win32' ? 'pyright.cmd' : 'pyright'
  const probe = await runCommand(command, ['--version'], { cwd: dir, timeoutMs: 20_000, shell: process.platform === 'win32' })
  if (probe.spawnError || probe.code !== 0) return { tool: 'pyright', status: 'skipped', reason: 'pyright is not installed on PATH', durationMs: 0, diagnostics: [] }
  const run = await runCommand(command, ['--outputjson'], { cwd: dir, timeoutMs, shell: process.platform === 'win32' })
  if (run.timedOut) return { tool: 'pyright', status: 'timeout', reason: `stopped after ${Math.round(timeoutMs / 1000)} s`, durationMs: run.durationMs, diagnostics: [] }
  const parsed = parsePyright(run.stdout, dir)
  if (!parsed) return { tool: 'pyright', status: 'error', reason: (run.stderr || 'pyright output was not JSON').trim().split('\n')[0].slice(0, 300), durationMs: run.durationMs, diagnostics: [] }
  return { tool: 'pyright', status: 'ran', durationMs: run.durationMs, diagnostics: parsed.map((d) => ({ ...d, tool: 'pyright' })) }
}

function changedSymbolOf(change: ChangeRecord) {
  return change.head ?? change.base
}

export interface DiagnosticContext {
  result: AnalysisResult
  changedPaths: Set<string>
  /** Text of a head-revision line, for matching symbol names in code the checker points at. */
  lineText: (path: string, line: number) => string | undefined
}

/**
 * Keep only errors the PR introduced (absent from base) in files it did not touch that refer to a
 * changed symbol, either by name or by sitting on a resolved call to one.
 */
export function diagnosticFindings(head: Diagnostic[], base: Diagnostic[] | undefined, context: DiagnosticContext): ReviewFinding[] {
  const key = (d: Diagnostic) => `${d.tool}\0${d.path}\0${d.code}\0${d.message}`
  const baseKeys = new Set((base ?? []).map(key))
  const changes = context.result.changes.filter((change) => ['function', 'method', 'class'].includes(changedSymbolOf(change)?.kind ?? ''))
  const changesById = new Map(changes.flatMap((change) => [[change.symbolId, change], ...(change.previousId ? [[change.previousId, change] as const] : [])]))
  const callSites = new Map<string, { change: ChangeRecord; edgeId: string }>()
  for (const edge of context.result.edges) {
    const change = edge.type === 'calls' && edge.evidenceRevision !== 'base' ? changesById.get(edge.target) : undefined
    if (change) callSites.set(`${edge.evidencePath}:${edge.evidenceLine}`, { change, edgeId: edge.id })
  }
  const names = changes.flatMap((change) => [change.head?.name, change.base?.name].filter((name): name is string => Boolean(name)).map((name) => ({ name, change })))
  const mentions = (text: string | undefined, name: string) => Boolean(text && new RegExp(`(?<![\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(text))

  const findings: ReviewFinding[] = []
  for (const diagnostic of head) {
    if (context.changedPaths.has(diagnostic.path) || baseKeys.has(key(diagnostic))) continue
    const site = callSites.get(`${diagnostic.path}:${diagnostic.line}`)
    const named = site ? undefined : names.find(({ name }) => mentions(diagnostic.message, name) || mentions(context.lineText(diagnostic.path, diagnostic.line), name))
    const change = site?.change ?? named?.change
    if (!change) continue
    const symbol = changedSymbolOf(change)!
    findings.push({
      id: `typecheck/${diagnostic.tool}:${diagnostic.path}:${diagnostic.line}:${diagnostic.code}`,
      ruleId: `typecheck/${diagnostic.tool}`,
      severity: 'high',
      source: 'typecheck',
      confidence: 'confirmed',
      message: `${diagnostic.tool} ${diagnostic.code}: ${diagnostic.message}${base ? '' : ' (the base revision could not be checked, so this error may predate the PR)'}`,
      changed: { path: symbol.path, line: symbol.startLine, revision: change.head ? 'head' : 'base', symbolId: symbol.id, symbol: symbol.qualifiedName },
      affected: { path: diagnostic.path, line: diagnostic.line, revision: 'head' },
      evidence: site ? [site.edgeId] : [],
    })
  }
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()]
}
