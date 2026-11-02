import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { analyzeRepository } from '../../src/analysis/engine'
import { groupFindings } from '../../src/analysis/merge'
import { isTestFile, parseRevision } from '../../src/analysis/parser'
import type { ReviewFinding, ReviewLocation, Severity, SourceFile } from '../../src/analysis/types'
import { collectEvidence, DEFAULT_EVIDENCE_OPTIONS } from '../evidence'
import type { RawDiagnostics } from '../evidence'
import { git, loadRepositoryRevisions, loadRevision } from '../git'
import { runCommand } from '../evidence/sandbox'
import { breakLocations, BUG_TYPES, injectBug } from './inject'
import type { BreakLocation, BugType, InjectionTarget } from './inject'

// ---------------------------------------------------------------------------------------------------------
// Benchmark definition
// ---------------------------------------------------------------------------------------------------------

export interface RepoSpec {
  key: string
  owner: string
  name: string
  language: 'python' | 'typescript'
  /** Extra pip packages the test suite needs (Python), installed into a per-repository virtualenv. */
  pythonDeps?: string[]
  targets: number
  realPullRequests: number
}

export const REPOS: RepoSpec[] = [
  { key: 'itsdangerous', owner: 'pallets', name: 'itsdangerous', language: 'python', pythonDeps: ['pytest', 'freezegun'], targets: 6, realPullRequests: 12 },
  { key: 'click', owner: 'pallets', name: 'click', language: 'python', pythonDeps: ['pytest'], targets: 6, realPullRequests: 12 },
  { key: 'ufo', owner: 'unjs', name: 'ufo', language: 'typescript', targets: 6, realPullRequests: 12 },
]

export const MODES = ['diff-rules', 'diff-all', 'impact-rules', 'impact-typecheck', 'impact-all'] as const
export type Mode = (typeof MODES)[number]
export const MODE_LABELS: Record<Mode, string> = {
  'diff-rules': 'Diff-only, rules',
  'diff-all': 'Diff-only, rules + type checker + tests',
  'impact-rules': 'Impact, rules',
  'impact-typecheck': 'Impact, rules + type checker',
  'impact-all': 'Impact, rules + type checker + tests',
}

const EVIDENCE_OPTIONS = { ...DEFAULT_EVIDENCE_OPTIONS, typecheck: true, runTests: true, maxTests: 20, typecheckTimeoutMs: 180_000, testTimeoutMs: 300_000 }

// ---------------------------------------------------------------------------------------------------------
// Stored results (compact enough to commit) and the metrics computed from them
// ---------------------------------------------------------------------------------------------------------

export interface StoredGroup {
  severity: Severity
  sources: ReviewFinding['source'][]
  /** Head-revision locations this group flags: its affected location plus affected callers. */
  locations: string[]
  /** True when the group carries a failing test linked to a change in `linkedPath`. */
  testFailure: boolean
  changedPaths: string[]
  ruleIds: string[]
  message: string
  affected: { path: string; line: number; symbol?: string }
}

export interface ModeResult { groups: StoredGroup[] }

export interface Timings { analysisMs: number; typecheckMs: number; testsMs: number }

export interface InjectedCase {
  id: string
  repo: string
  split: 'tune' | 'holdout'
  type: BugType
  target: { path: string; name: string }
  /** Break locations; `keys` holds every path:line that identifies the same break. */
  oracle: (BreakLocation & { key: string; keys: string[] })[]
  modes: Record<Mode, ModeResult>
  timings: Timings
  evidence: { typecheck: string; tests: string }
}

export interface RealPullRequestCase {
  id: string
  repo: string
  number: number
  subject: string
  baseSha: string
  headSha: string
  changedFiles: number
  modes: Record<Mode, ModeResult>
  timings: Timings
  evidence: { typecheck: string; tests: string }
}

export interface RepoRun {
  key: string
  owner: string
  name: string
  language: string
  headSha: string
  targets: { path: string; name: string; callSites: number; inChangedFile: number }[]
  skipped: { id: string; reason: string }[]
  injected: InjectedCase[]
  real: RealPullRequestCase[]
  durationMs: number
}

export interface BenchmarkResults {
  generatedAt: string
  environment: { platform: string; node: string; python?: string; pyright?: string }
  peakDiskBytes: number
  repos: RepoRun[]
}

const locationKey = (location: { path: string; line: number }) => `${location.path}:${location.line}`

/** Deterministic split: FNV-1a over the case id, so the same cases always land in the same split. */
export function splitFor(id: string): 'tune' | 'holdout' {
  let hash = 0x811c9dc5
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0
  return hash % 2 === 0 ? 'tune' : 'holdout'
}

/** Restrict findings to what a reviewer who only reads the changed files could report. */
export function restrictToChangedFiles(findings: ReviewFinding[], changedPaths: Set<string>): ReviewFinding[] {
  return findings.flatMap((finding) => {
    if (finding.details) {
      const callers = finding.details.callers.filter((caller) => changedPaths.has(caller.location.path))
      if (callers.length === 0) return []
      return [{ ...finding, affected: callers[0].location, details: { ...finding.details, callers } }]
    }
    return changedPaths.has(finding.affected.path) ? [finding] : []
  })
}

/** Type errors that are new on head and sit in changed files: what a diff-scoped type check reports. */
export function changedFileTypeErrors(raw: RawDiagnostics[], changedPaths: Set<string>, changed: ReviewLocation): ReviewFinding[] {
  return raw.flatMap((run) => {
    const before = new Set((run.base ?? []).map((d) => `${d.path}\0${d.code}\0${d.message}`))
    return run.head
      .filter((d) => changedPaths.has(d.path) && !before.has(`${d.path}\0${d.code}\0${d.message}`))
      .map((d): ReviewFinding => ({
        id: `diff-typecheck:${d.path}:${d.line}:${d.code}`,
        ruleId: `typecheck/${d.tool}`,
        severity: 'high',
        source: 'typecheck',
        confidence: 'confirmed',
        message: `${d.tool} ${d.code}: ${d.message}`,
        changed,
        affected: { path: d.path, line: d.line, revision: 'head' },
        evidence: [],
      }))
  })
}

function storeGroups(findings: ReviewFinding[], edges: Parameters<typeof groupFindings>[1]): ModeResult {
  return {
    groups: groupFindings(findings, edges).map((group) => {
      const callerLocations = group.findings.flatMap((finding) => finding.details?.callers.filter((caller) => caller.affected).map((caller) => caller.location) ?? [])
      const locations = [group.affected, ...callerLocations]
        .filter((location) => location.revision === 'head' && !group.findings.every((finding) => finding.source === 'test-run'))
        .map(locationKey)
      return {
        severity: group.severity,
        sources: group.sources,
        locations: [...new Set(locations)],
        testFailure: group.findings.some((finding) => finding.source === 'test-run'),
        changedPaths: [...new Set(group.changed.map((location) => location.path))],
        ruleIds: [...new Set(group.findings.map((finding) => finding.ruleId))],
        message: group.findings[0].message.slice(0, 400),
        affected: { path: group.affected.path, line: group.affected.line, symbol: group.affected.symbol },
      }
    }),
  }
}

// ---------------------------------------------------------------------------------------------------------
// Running one analysis with every evidence source, then deriving each mode from it
// ---------------------------------------------------------------------------------------------------------

async function analyzeAllModes(repoDir: string, baseSha: string, headSha: string, meta: { owner: string; name: string; number: number; title: string }) {
  const started = performance.now()
  const loaded = await loadRepositoryRevisions(repoDir, {
    owner: meta.owner, name: meta.name,
    pullRequest: { number: meta.number, title: meta.title, author: '', baseRef: baseSha.slice(0, 7), headRef: headSha.slice(0, 7) },
  }, baseSha, headSha)
  const result = await analyzeRepository(loaded.repository, { wasmBasePath: WASM })
  const analysisMs = Math.round(performance.now() - started)
  const changedPaths = new Set(loaded.changed.map((file) => file.path))
  const evidence = await collectEvidence({ repoDir, baseSha, headSha, result, changedPaths, options: EVIDENCE_OPTIONS })

  const rules = result.review
  const typecheck = evidence.findings.filter((finding) => finding.source === 'typecheck')
  const tests = evidence.findings.filter((finding) => finding.source === 'test-run')
  const anyChange = result.changes.find((change) => change.head ?? change.base)
  const changedSymbol = (anyChange?.head ?? anyChange?.base)
  const changedLocation: ReviewLocation = changedSymbol
    ? { path: changedSymbol.path, line: changedSymbol.startLine, revision: anyChange?.head ? 'head' : 'base', symbolId: changedSymbol.id, symbol: changedSymbol.qualifiedName }
    : { path: [...changedPaths][0] ?? '', line: 1, revision: 'head' }
  const diffRules = restrictToChangedFiles(rules, changedPaths)
  const modes: Record<Mode, ModeResult> = {
    'diff-rules': storeGroups(diffRules, result.edges),
    'diff-all': storeGroups([...diffRules, ...changedFileTypeErrors(evidence.raw, changedPaths, changedLocation), ...tests.filter((t) => changedPaths.has(t.affected.path))], result.edges),
    'impact-rules': storeGroups(rules, result.edges),
    'impact-typecheck': storeGroups([...rules, ...typecheck], result.edges),
    'impact-all': storeGroups([...rules, ...typecheck, ...tests], result.edges),
  }
  const typecheckMs = (evidence.report.typecheck ?? []).reduce((sum, run) => sum + run.head.durationMs + (run.base?.durationMs ?? 0), 0)
  const testsMs = evidence.report.tests?.durationMs ?? 0
  const describe = {
    typecheck: (evidence.report.typecheck ?? []).map((run) => `${run.head.tool}: ${run.head.status}${run.head.reason ? ` (${run.head.reason})` : ''}`).join('; ') || 'not run',
    tests: evidence.report.tests
      ? `${evidence.report.tests.runner ?? 'none'}: ${evidence.report.tests.status}, ${evidence.report.tests.selected} selected, ${evidence.report.tests.passed + evidence.report.tests.failed + evidence.report.tests.errors + evidence.report.tests.skipped} ran, ${evidence.report.tests.failed} failed${evidence.report.tests.reason ? ` (${evidence.report.tests.reason})` : ''}`
      : 'not run',
  }
  return { modes, timings: { analysisMs, typecheckMs, testsMs }, evidence: describe, changedFiles: changedPaths.size, headFiles: loaded.repository.head.files }
}

// ---------------------------------------------------------------------------------------------------------
// Repository setup, injected commits, real pull requests, cleanup
// ---------------------------------------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, '../..')
const WASM = join(ROOT, 'public/wasm')
export const BENCH_DIR = join(ROOT, 'data/bench/review')

function log(message: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`)
}

/** Bytes on disk under `path`, without following symlinks or junctions. */
export function diskUsage(path: string): number {
  if (!existsSync(path)) return 0
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return 0
  if (!stat.isDirectory()) return stat.size
  return readdirSync(path).reduce((sum, entry) => sum + diskUsage(join(path, entry)), 0)
}

function tempWorkspaces() {
  return readdirSync(tmpdir()).filter((name) => /^codeimpact-(head|base)-/.test(name)).map((name) => join(tmpdir(), name))
}

class DiskMonitor {
  peak = 0
  private timer?: NodeJS.Timeout
  sample() {
    const total = diskUsage(BENCH_DIR) + tempWorkspaces().reduce((sum, dir) => sum + diskUsage(dir), 0)
    this.peak = Math.max(this.peak, total)
    return total
  }
  start() { this.timer = setInterval(() => this.sample(), 15_000) }
  stop() { if (this.timer) clearInterval(this.timer) }
}

async function run(command: string, args: string[], cwd: string, timeoutMs = 900_000, env?: NodeJS.ProcessEnv) {
  const result = await runCommand(command, args, { cwd, timeoutMs, env: env ?? { ...process.env }, shell: process.platform === 'win32' })
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.code}): ${(result.stderr || result.stdout).slice(-800)}`)
  return result.stdout
}

const COMMIT_ENV = { GIT_AUTHOR_NAME: 'codeimpact-bench', GIT_AUTHOR_EMAIL: 'bench@codeimpact.invalid', GIT_COMMITTER_NAME: 'codeimpact-bench', GIT_COMMITTER_EMAIL: 'bench@codeimpact.invalid' }

/** Commit `source` at `path` on top of `parent` with plumbing only; the working tree is untouched. */
async function commitFile(repoDir: string, parent: string, path: string, source: string, message: string) {
  const index = join(BENCH_DIR, `.index-${process.pid}`)
  const env = { ...process.env, ...COMMIT_ENV, GIT_INDEX_FILE: index }
  try {
    const blob = (await git(repoDir, ['hash-object', '-w', '--stdin'], source)).toString().trim()
    await git(repoDir, ['read-tree', parent], undefined, env)
    await git(repoDir, ['update-index', '--cacheinfo', `100644,${blob},${path}`], undefined, env)
    const tree = (await git(repoDir, ['write-tree'], undefined, env)).toString().trim()
    return (await git(repoDir, ['commit-tree', tree, '-p', parent, '-m', message], undefined, env)).toString().trim()
  } finally {
    rmSync(index, { force: true })
  }
}

async function chooseTargets(files: SourceFile[], spec: RepoSpec) {
  const parsed = await parseRevision({ sha: 'head', files }, { wasmBasePath: WASM })
  const nameCounts = new Map<string, number>()
  parsed.symbols.forEach((symbol) => nameCounts.set(symbol.name, (nameCounts.get(symbol.name) ?? 0) + 1))
  const candidates = parsed.symbols
    .filter((symbol) => symbol.kind === 'function' && symbol.qualifiedName === symbol.name && symbol.path.startsWith('src/'))
    .filter((symbol) => !isTestFile(symbol) && symbol.name.length >= 5 && !symbol.name.startsWith('__') && nameCounts.get(symbol.name) === 1)
    .map((symbol) => {
      const target: InjectionTarget = { path: symbol.path, name: symbol.name, language: symbol.language, startLine: symbol.startLine, endLine: symbol.endLine }
      const sites = breakLocations(files, target, 'signature')
      return { target, callSites: sites.length, inChangedFile: sites.filter((site) => site.inChangedFile).length }
    })
    .filter((candidate) => candidate.callSites >= 1 && candidate.callSites <= 25)
    .sort((a, b) => (splitHash(`${spec.key}:${a.target.name}`) - splitHash(`${spec.key}:${b.target.name}`)) || a.target.name.localeCompare(b.target.name))
  return candidates.slice(0, spec.targets)
}

function splitHash(value: string) {
  let hash = 0x811c9dc5
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0
  return hash
}

async function realPullRequests(repoDir: string, spec: RepoSpec) {
  const extension = spec.language === 'python' ? '.py' : '.ts'
  const output = (await git(repoDir, ['log', '--first-parent', '--format=%H%x09%P%x09%s', '-n', '600', 'HEAD'])).toString()
  const picked: { sha: string; parent: string; number: number; subject: string }[] = []
  for (const line of output.split('\n')) {
    if (picked.length >= spec.realPullRequests) break
    const [sha, parents, subject] = line.split('\t')
    const number = Number(subject?.match(/\(#(\d+)\)|Merge pull request #(\d+)/)?.slice(1).find(Boolean))
    if (!sha || !number || !parents) continue
    const parent = parents.split(' ')[0]
    const changed = (await git(repoDir, ['diff', '--name-only', parent, sha])).toString().split('\n')
    if (!changed.some((path) => path.startsWith('src/') && path.endsWith(extension))) continue
    picked.push({ sha, parent, number, subject })
  }
  return picked
}

export async function benchmarkRepository(spec: RepoSpec, disk: DiskMonitor, tools: { pyrightBin?: string }): Promise<RepoRun> {
  const started = performance.now()
  const repoDir = join(BENCH_DIR, 'repos', spec.key)
  const venv = join(BENCH_DIR, `venv-${spec.key}`)
  const originalPath = process.env.PATH
  try {
    log(`${spec.key}: cloning`)
    rmSync(repoDir, { recursive: true, force: true })
    mkdirSync(join(BENCH_DIR, 'repos'), { recursive: true })
    await git(join(BENCH_DIR, 'repos'), ['clone', '--quiet', `https://github.com/${spec.owner}/${spec.name}.git`, spec.key])
    const headSha = (await git(repoDir, ['rev-parse', 'HEAD'])).toString().trim()

    log(`${spec.key}: installing dependencies`)
    const pathEntries = [tools.pyrightBin]
    if (spec.language === 'python') {
      await run('python', ['-m', 'venv', venv], BENCH_DIR)
      const scripts = join(venv, process.platform === 'win32' ? 'Scripts' : 'bin')
      await run(join(scripts, 'python'), ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', ...(spec.pythonDeps ?? [])], repoDir)
      pathEntries.unshift(scripts)
      process.env.VIRTUAL_ENV = venv
    } else {
      await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', '--no-package-lock', '--legacy-peer-deps'], repoDir)
    }
    process.env.PATH = [...pathEntries.filter(Boolean), originalPath].join(delimiter)
    log(`${spec.key}: disk now ${(disk.sample() / 1e6).toFixed(0)} MB`)

    const { revision } = await loadRevision(repoDir, headSha)
    const targets = await chooseTargets(revision.files, spec)
    log(`${spec.key}: ${targets.length} targets: ${targets.map((t) => t.target.name).join(', ')}`)

    const injected: InjectedCase[] = []
    const skipped: RepoRun['skipped'] = []
    for (const { target } of targets) {
      const file = revision.files.find((candidate) => candidate.path === target.path)!
      for (const type of BUG_TYPES) {
        const id = `${spec.key}:${target.name}:${type}`
        const mutated = injectBug(file.source, target, type)
        if (!mutated) {
          skipped.push({ id, reason: `${type} does not apply to this function` })
          continue
        }
        const headFiles = revision.files.map((candidate) => (candidate.path === target.path ? { ...candidate, source: mutated } : candidate))
        const oracle = breakLocations(headFiles, target, type).map((location) => ({
          ...location,
          key: locationKey(location),
          keys: [location.line, ...(location.aliasLines ?? [])].map((line) => locationKey({ path: location.path, line })),
        }))
        if (oracle.length === 0) {
          skipped.push({ id, reason: 'the change breaks no call site (all callers discard the value or handle the exception)' })
          continue
        }
        const commit = await commitFile(repoDir, headSha, target.path, mutated, `codeimpact-bench: ${type} ${target.name}`)
        const analysis = await analyzeAllModes(repoDir, headSha, commit, { owner: spec.owner, name: spec.name, number: 0, title: id })
        injected.push({
          id, repo: spec.key, split: splitFor(id), type, target: { path: target.path, name: target.name },
          oracle, modes: analysis.modes, timings: analysis.timings, evidence: analysis.evidence,
        })
        log(`${id}: ${oracle.length} break locations · impact-all ${analysis.modes['impact-all'].groups.length} groups · ${analysis.timings.analysisMs}+${analysis.timings.typecheckMs}+${analysis.timings.testsMs} ms`)
        disk.sample()
      }
    }

    const real: RealPullRequestCase[] = []
    for (const pull of await realPullRequests(repoDir, spec)) {
      const analysis = await analyzeAllModes(repoDir, pull.parent, pull.sha, { owner: spec.owner, name: spec.name, number: pull.number, title: pull.subject })
      real.push({
        id: `${spec.key}#${pull.number}`, repo: spec.key, number: pull.number, subject: pull.subject, baseSha: pull.parent, headSha: pull.sha,
        changedFiles: analysis.changedFiles, modes: analysis.modes, timings: analysis.timings, evidence: analysis.evidence,
      })
      log(`${spec.key}#${pull.number}: impact-all ${analysis.modes['impact-all'].groups.map((g) => g.severity).join(',') || 'no findings'}`)
      disk.sample()
    }

    return {
      key: spec.key, owner: spec.owner, name: spec.name, language: spec.language, headSha,
      targets: targets.map((t) => ({ path: t.target.path, name: t.target.name, callSites: t.callSites, inChangedFile: t.inChangedFile })),
      skipped, injected, real, durationMs: Math.round(performance.now() - started),
    }
  } finally {
    process.env.PATH = originalPath
    delete process.env.VIRTUAL_ENV
    disk.sample()
    log(`${spec.key}: removing clone and installed dependencies`)
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(venv, { recursive: true, force: true })
  }
}

export async function runReviewBenchmark(only?: string[]): Promise<BenchmarkResults> {
  mkdirSync(BENCH_DIR, { recursive: true })
  const disk = new DiskMonitor()
  disk.start()
  const toolsDir = join(BENCH_DIR, 'tools')
  const repos: RepoRun[] = []
  try {
    const specs = REPOS.filter((spec) => !only || only.includes(spec.key))
    let pyrightBin: string | undefined
    let pyrightVersion: string | undefined
    if (specs.some((spec) => spec.language === 'python')) {
      log('installing pyright for the Python repositories')
      await run('npm', ['install', '--prefix', toolsDir, '--no-audit', '--no-fund', '--loglevel=error', 'pyright@1.1.414'], ROOT)
      pyrightBin = join(toolsDir, 'node_modules', '.bin')
      pyrightVersion = '1.1.414'
    }
    for (const spec of specs) {
      const repoRun = await benchmarkRepository(spec, disk, { pyrightBin })
      repos.push(repoRun)
      mkdirSync(join(BENCH_DIR, 'partial'), { recursive: true })
      writeFileSync(join(BENCH_DIR, 'partial', `${spec.key}.json`), JSON.stringify(repoRun))
    }
    const python = (await runCommand('python', ['--version'], { cwd: ROOT, timeoutMs: 20_000 })).stdout.trim()
    return {
      generatedAt: new Date().toISOString(),
      environment: { platform: `${process.platform} ${process.arch}`, node: process.version, python, pyright: pyrightVersion },
      peakDiskBytes: Math.max(disk.peak, disk.sample()),
      repos,
    }
  } finally {
    disk.stop()
    rmSync(toolsDir, { recursive: true, force: true })
  }
}
