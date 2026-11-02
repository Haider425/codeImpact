import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AnalysisResult, ReviewFinding } from '../../src/analysis/types'
import { log } from '../log'
import { materialize } from './sandbox'
import type { Workspace } from './sandbox'
import { detectRunner, failureFindings, runTests, selectTestsToRun } from './tests'
import type { TestOutcome, TestRunReport } from './tests'
import { diagnosticFindings, runPyright, runTsc } from './typecheck'
import type { CheckerRun, Diagnostic } from './typecheck'

export interface EvidenceOptions {
  typecheck: boolean
  runTests: boolean
  /** Upper bound on impacted tests to run. */
  maxTests: number
  /** Time limit for each type-checker run (head and base). */
  typecheckTimeoutMs: number
  /** Time limit for each test run (head, then the base re-run of failures). */
  testTimeoutMs: number
}

export const DEFAULT_EVIDENCE_OPTIONS: EvidenceOptions = {
  typecheck: false,
  runTests: false,
  maxTests: 20,
  typecheckTimeoutMs: 180_000,
  testTimeoutMs: 300_000,
}

/** Unfiltered type-checker output, for callers (the benchmark) that apply their own scope. */
export interface RawDiagnostics { tool: CheckerRun['tool']; head: Diagnostic[]; base?: Diagnostic[] }

export interface EvidenceReport {
  typecheck?: { head: Omit<CheckerRun, 'diagnostics'> & { errors: number }; base?: Omit<CheckerRun, 'diagnostics'> & { errors: number }; reported: number }[]
  tests?: TestRunReport
}

export interface EvidenceInput {
  repoDir: string
  baseSha: string
  headSha: string
  result: AnalysisResult
  changedPaths: Set<string>
  options: EvidenceOptions
}

const summarize = (run: CheckerRun) => ({ tool: run.tool, status: run.status, reason: run.reason, durationMs: run.durationMs, errors: run.diagnostics.length })

/**
 * Optional, slower evidence: the project's type checker and its impacted tests, each run in a temporary
 * copy of the revision with no credentials in the environment and a hard time limit.
 */
export async function collectEvidence(input: EvidenceInput): Promise<{ findings: ReviewFinding[]; report: EvidenceReport; raw: RawDiagnostics[] }> {
  const { options, result } = input
  const findings: ReviewFinding[] = []
  const report: EvidenceReport = {}
  const raw: RawDiagnostics[] = []
  if (!options.typecheck && !options.runTests) return { findings, report, raw }

  let head: Workspace | undefined
  let base: Workspace | undefined
  const baseWorkspace = async () => (base ??= await materialize(input.repoDir, input.baseSha, 'base'))
  try {
    head = await materialize(input.repoDir, input.headSha, 'head')

    if (options.typecheck) {
      report.typecheck = []
      const languages = new Set(result.symbols.filter((symbol) => symbol.kind !== 'file').map((symbol) => symbol.language))
      const checkers = [...(languages.has('typescript') ? [runTsc] : []), ...(languages.has('python') ? [runPyright] : [])]
      const lines = new Map<string, string[]>()
      const lineText = (path: string, line: number) => {
        if (!lines.has(path)) {
          const file = join(head!.dir, path)
          lines.set(path, existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [])
        }
        return lines.get(path)![line - 1]
      }
      for (const check of checkers) {
        const headRun = await check(head.dir, options.typecheckTimeoutMs)
        if (headRun.status !== 'ran') {
          report.typecheck.push({ head: summarize(headRun), reported: 0 })
          continue
        }
        const baseRun = await check((await baseWorkspace()).dir, options.typecheckTimeoutMs)
        raw.push({ tool: headRun.tool, head: headRun.diagnostics, base: baseRun.status === 'ran' ? baseRun.diagnostics : undefined })
        const reported = diagnosticFindings(headRun.diagnostics, baseRun.status === 'ran' ? baseRun.diagnostics : undefined, { result, changedPaths: input.changedPaths, lineText })
        findings.push(...reported)
        report.typecheck.push({ head: summarize(headRun), base: summarize(baseRun), reported: reported.length })
      }
    }

    if (options.runTests) {
      const selected = selectTestsToRun(result, options.maxTests)
      const { runner, reason } = detectRunner(head.dir, selected.map((test) => test.test))
      const tests: TestRunReport = {
        runner, status: 'skipped', reason, selected: 0, totalTests: result.stats.totalTests,
        passed: 0, failed: 0, errors: 0, skipped: 0, durationMs: 0, environmentErrors: [],
      }
      report.tests = tests
      if (runner) {
        const headRun = await runTests(head.dir, runner, selected.map((test) => test.test), options.testTimeoutMs)
        Object.assign(tests, { status: headRun.status, reason: headRun.reason, durationMs: headRun.durationMs, environmentErrors: headRun.environmentErrors, selected: selected.length })
        const count = (status: TestOutcome['status']) => headRun.outcomes.filter((outcome) => outcome.status === status).length
        Object.assign(tests, { passed: count('passed'), failed: count('failed'), errors: count('error'), skipped: count('skipped') })
        if (headRun.status === 'ran' && headRun.outcomes.length === 0) {
          Object.assign(tests, { status: 'error', reason: headRun.environmentErrors.length ? 'none of the selected tests could run; see the environment errors' : 'the runner reported none of the selected tests' })
        }

        const failedIds = new Set(headRun.outcomes.filter((outcome) => outcome.status === 'failed').map((outcome) => outcome.testId))
        let baseOutcomes: Map<string, TestOutcome> | undefined
        if (failedIds.size > 0) {
          // Re-run only the failures on base, to separate regressions from tests that were already broken.
          const addedInPr = new Set(result.changes.filter((change) => change.changeType === 'added').map((change) => change.symbolId))
          const toRerun = selected.filter((test) => failedIds.has(test.test.id) && !addedInPr.has(test.test.id)).map((test) => test.test)
          if (toRerun.length === 0) baseOutcomes = new Map()
          else {
            const baseRun = await runTests((await baseWorkspace()).dir, runner, toRerun, options.testTimeoutMs)
            if (baseRun.status === 'ran') baseOutcomes = new Map(baseRun.outcomes.map((outcome) => [outcome.testId, outcome]))
          }
        }
        findings.push(...failureFindings(result, selected, headRun.outcomes, baseOutcomes))
      }
    }
  } catch (error) {
    log('warn', 'evidence collection failed', { error: error instanceof Error ? error.message : String(error) })
  } finally {
    head?.cleanup()
    base?.cleanup()
  }
  return { findings, report, raw }
}
