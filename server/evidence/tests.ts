import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AnalysisResult, ReviewFinding, SymbolRecord, TestRecommendation } from '../../src/analysis/types'
import { runCommand } from './sandbox'

export type TestRunner = 'pytest' | 'vitest' | 'jest'

export interface TestOutcome {
  /** Symbol id of the test in the analysis. */
  testId: string
  status: 'passed' | 'failed' | 'skipped' | 'error'
  message?: string
}

export interface TestRunReport {
  runner?: TestRunner
  status: 'ran' | 'skipped' | 'timeout' | 'error'
  reason?: string
  selected: number
  totalTests: number
  passed: number
  failed: number
  errors: number
  skipped: number
  durationMs: number
  /** Problems collecting or setting up tests (missing dependencies, import errors). Not findings. */
  environmentErrors: string[]
}

/** Pytest node id for a test symbol, e.g. `tests/test_x.py::TestY::test_z`. */
export function pytestNodeId(test: SymbolRecord) {
  return `${test.path}::${test.qualifiedName.split('.').join('::')}`
}

function xmlAttribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`))
  return match?.[1]
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

/** Map a pytest JUnit XML report onto the selected test symbols. Parametrized cases fold into their function. */
export function parseJunit(xml: string, tests: SymbolRecord[]) {
  const byKey = new Map(tests.map((test) => {
    const module = test.path.replace(/\.py$/, '').replaceAll('/', '.')
    const parts = test.qualifiedName.split('.')
    const name = parts.pop()!
    return [`${[module, ...parts].join('.')}::${name}`, test.id]
  }))
  const outcomes = new Map<string, TestOutcome>()
  const environmentErrors: string[] = []
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const tag = match[1]
    const body = match[2] ?? ''
    const classname = xmlAttribute(` ${tag}`, 'classname') ?? ''
    const name = (xmlAttribute(` ${tag}`, 'name') ?? '').replace(/\[.*\]$/, '')
    const failure = body.match(/<failure\b([^>]*)/)
    const error = body.match(/<error\b([^>]*)/)
    const testId = byKey.get(`${classname}::${name}`)
    if (!testId) {
      if (error || failure) environmentErrors.push(`${classname || name}: ${xmlAttribute(` ${(error ?? failure)![1]}`, 'message') ?? 'error'}`.slice(0, 300))
      continue
    }
    const status: TestOutcome['status'] = failure ? 'failed' : error ? 'error' : /<skipped\b/.test(body) ? 'skipped' : 'passed'
    const previous = outcomes.get(testId)
    const rank = { failed: 3, error: 2, passed: 1, skipped: 0 }
    if (!previous || rank[status] > rank[previous.status]) {
      outcomes.set(testId, { testId, status, message: xmlAttribute(` ${(failure ?? error)?.[1] ?? ''}`, 'message')?.split('\n')[0].slice(0, 300) })
    }
  }
  return { outcomes: [...outcomes.values()], environmentErrors }
}

interface JestJson {
  testResults?: { name: string; message?: string; status?: string; assertionResults?: { ancestorTitles: string[]; title: string; status: string; failureMessages?: string[] }[] }[]
}

/** Map a Jest/Vitest JSON report (same shape) onto the selected test symbols by file and `describe > it` title. */
export function parseJestJson(json: string, tests: SymbolRecord[], root: string) {
  const report = JSON.parse(json) as JestJson
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '')
  const byKey = new Map(tests.map((test) => [`${test.path}\0${test.qualifiedName}`, test.id]))
  const outcomes: TestOutcome[] = []
  const environmentErrors: string[] = []
  for (const file of report.testResults ?? []) {
    const path = file.name.replaceAll('\\', '/').replace(`${normalizedRoot}/`, '')
    if ((file.assertionResults ?? []).length === 0 && file.status === 'failed') environmentErrors.push(`${path}: ${(file.message ?? 'failed to run').split('\n')[0].slice(0, 300)}`)
    for (const assertion of file.assertionResults ?? []) {
      const testId = byKey.get(`${path}\0${[...assertion.ancestorTitles, assertion.title].join(' > ')}`)
      if (!testId) continue
      const status = assertion.status === 'passed' ? 'passed' : assertion.status === 'failed' ? 'failed' : 'skipped'
      outcomes.push({ testId, status, message: assertion.failureMessages?.[0]?.split('\n')[0].slice(0, 300) })
    }
  }
  return { outcomes, environmentErrors }
}

export function detectRunner(dir: string, tests: SymbolRecord[]): { runner?: TestRunner; reason?: string } {
  if (tests.length === 0) return { reason: 'no impacted tests to run' }
  if (tests[0].language === 'python') return { runner: 'pytest' }
  const packageJson = join(dir, 'package.json')
  if (!existsSync(packageJson)) return { reason: 'no package.json' }
  const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  const deps = { ...manifest.dependencies, ...manifest.devDependencies }
  if (deps.vitest) return existsSync(join(dir, 'node_modules/vitest/vitest.mjs')) ? { runner: 'vitest' } : { reason: 'vitest is declared but not installed (run your install step first)' }
  if (deps.jest) return existsSync(join(dir, 'node_modules/jest/bin/jest.js')) ? { runner: 'jest' } : { reason: 'jest is declared but not installed (run your install step first)' }
  return { reason: 'no supported TypeScript test runner (vitest or jest) found' }
}

/**
 * Run the given tests in `dir` and return per-test outcomes. Running tests executes repository code, so
 * callers only do this when explicitly asked, in a temporary copy, with a scrubbed environment and a time limit.
 */
export async function runTests(
  dir: string,
  runner: TestRunner,
  tests: SymbolRecord[],
  timeoutMs: number,
  retried = false,
): Promise<{ status: 'ran' | 'skipped' | 'timeout' | 'error'; reason?: string; outcomes: TestOutcome[]; environmentErrors: string[]; durationMs: number }> {
  const reportPath = join(dir, `.codeimpact-${runner}-report.${runner === 'pytest' ? 'xml' : 'json'}`)
  let run
  if (runner === 'pytest') {
    // Keep running the remaining selections when one test module fails to import.
    run = await runCommand('python', ['-m', 'pytest', ...tests.map(pytestNodeId), '-q', '-p', 'no:cacheprovider', '--continue-on-collection-errors', `--junitxml=${reportPath}`, `--rootdir=${dir}`], { cwd: dir, timeoutMs })
  } else {
    const files = [...new Set(tests.map((test) => test.path))]
    const entry = runner === 'vitest' ? 'node_modules/vitest/vitest.mjs' : 'node_modules/jest/bin/jest.js'
    const args = runner === 'vitest'
      ? ['run', ...files, '--reporter=json', `--outputFile=${reportPath}`, '--watch=false']
      : [...files, '--json', `--outputFile=${reportPath}`, '--ci', '--watchAll=false']
    run = await runCommand(process.execPath, [join(dir, entry), ...args], { cwd: dir, timeoutMs })
  }
  if (run.timedOut) return { status: 'timeout' as const, reason: `stopped after ${Math.round(timeoutMs / 1000)} s`, outcomes: [], environmentErrors: [], durationMs: run.durationMs }
  if (run.spawnError) return { status: 'skipped' as const, reason: `${runner} could not be started: ${run.spawnError}`, outcomes: [], environmentErrors: [], durationMs: run.durationMs }
  if (!existsSync(reportPath)) {
    const detail = (run.stderr || run.stdout).trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'no report was produced'
    return { status: 'error' as const, reason: `${runner} exited with ${run.code}: ${detail.slice(0, 300)}`, outcomes: [], environmentErrors: [], durationMs: run.durationMs }
  }
  const text = readFileSync(reportPath, 'utf8')
  const parsed = runner === 'pytest' ? parseJunit(text, tests) : parseJestJson(text, tests, dir)

  // pytest refuses to run anything (exit 4) when an explicitly named module fails to import, even with
  // --continue-on-collection-errors. Retry once without the modules that failed to collect.
  if (runner === 'pytest' && parsed.outcomes.length === 0 && parsed.environmentErrors.length > 0 && !retried) {
    const broken = new Set(parsed.environmentErrors.map((problem) => `${problem.split(':')[0].replaceAll('.', '/')}.py`))
    const remaining = tests.filter((test) => !broken.has(test.path))
    if (remaining.length > 0 && remaining.length < tests.length) {
      const retry = await runTests(dir, runner, remaining, Math.max(1_000, timeoutMs - run.durationMs), true)
      return { ...retry, environmentErrors: [...parsed.environmentErrors, ...retry.environmentErrors], durationMs: run.durationMs + retry.durationMs }
    }
  }
  return { status: 'ran' as const, ...parsed, durationMs: run.durationMs }
}

/** The highest-ranked impacted tests, skipping ones without a stable runner identity. */
export function selectTestsToRun(result: AnalysisResult, limit: number): TestRecommendation[] {
  const language = result.tests[0]?.test.language
  return result.tests
    .filter((test) => test.test.language === language && !test.test.qualifiedName.includes('#'))
    .slice(0, limit)
}

export function failureFindings(
  result: AnalysisResult,
  selected: TestRecommendation[],
  headOutcomes: TestOutcome[],
  baseOutcomes: Map<string, TestOutcome> | undefined,
): ReviewFinding[] {
  const symbols = new Map(result.symbols.map((symbol) => [symbol.id, symbol]))
  const byId = new Map(selected.map((test) => [test.test.id, test]))
  return headOutcomes.filter((outcome) => outcome.status === 'failed').flatMap((outcome) => {
    const recommendation = byId.get(outcome.testId)
    if (!recommendation) return []
    const changed = symbols.get(recommendation.path.nodeIds[0]) ?? recommendation.test
    const onBase = baseOutcomes?.get(outcome.testId)
    const alsoFailsOnBase = onBase?.status === 'failed' || onBase?.status === 'error'
    const note = alsoFailsOnBase
      ? ' It also fails on the base revision, so the PR may not have caused it.'
      : baseOutcomes === undefined ? ' The base revision was not re-run.' : onBase ? ' It passes on the base revision.' : ' The test does not exist on the base revision.'
    const finding: ReviewFinding = {
      id: `tests/failure:${outcome.testId}`,
      ruleId: 'tests/failure',
      severity: alsoFailsOnBase ? 'low' : 'high',
      source: 'test-run',
      confidence: 'confirmed',
      message: `\`${recommendation.test.qualifiedName}\` fails on the PR head${outcome.message ? `: ${outcome.message}` : ''}.${note}`,
      changed: { path: changed.path, line: changed.startLine, revision: 'head', symbolId: changed.id, symbol: changed.qualifiedName },
      affected: { path: recommendation.test.path, line: recommendation.test.startLine, revision: 'head', symbolId: recommendation.test.id, symbol: recommendation.test.qualifiedName },
      evidence: recommendation.path.edgeIds,
    }
    return [finding]
  })
}
