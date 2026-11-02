import type { Severity } from '../../src/analysis/types'
import { BUG_TYPES } from './inject'
import { MODE_LABELS, MODES } from './review-bench'
import type { BenchmarkResults, InjectedCase, Mode, RealPullRequestCase, StoredGroup } from './review-bench'

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
export const THRESHOLDS: Severity[] = ['high', 'medium', 'low']

const flagged = (group: StoredGroup, threshold: Severity) => RANK[group.severity] <= RANK[threshold]
const oracleKeys = (testCase: InjectedCase) => new Set(testCase.oracle.flatMap((location) => location.keys ?? [location.key]))

/**
 * `lenient` (the default for diff-only modes) also accepts type-checker errors inside the changed file:
 * they sit on the changed lines or on lines that use the changed function, which the call-site oracle
 * does not count. `strict` scores against the oracle alone.
 */
export type Scoring = 'lenient' | 'strict'

function isCorrect(group: StoredGroup, testCase: InjectedCase, oracle: Set<string>, mode?: Mode, scoring: Scoring = 'strict') {
  if (group.locations.some((location) => oracle.has(location))) return true
  if (scoring === 'lenient' && mode?.startsWith('diff') && group.sources.includes('typecheck') && group.affected.path === testCase.target.path) return true
  // A failing-test group with no caller location counts when it is linked to the injected change.
  return group.testFailure && group.locations.length === 0 && group.changedPaths.includes(testCase.target.path)
}

export interface SpotCheckVerdicts {
  reviewedBy: string
  method: string
  verdicts: { pr: string; affected: string; verdict: 'TP' | 'FP' | '?'; note: string }[]
  underRated: { pr: string; note: string }[]
  failurePatterns: { pattern: string; rows: string }[]
}

export interface Metrics {
  cases: number
  detected: number
  caseRecall: number
  breakLocations: number
  locationsFound: number
  locationRecall: number
  insideDiffRecall: number | undefined
  outsideDiffRecall: number | undefined
  flaggedGroups: number
  correctGroups: number
  precision: number | undefined
  falsePositivesPerCase: number
  medianMs: number
  p95Ms: number
}

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export function modeRuntime(timings: InjectedCase['timings'], mode: Mode) {
  const usesTypecheck = mode === 'diff-all' || mode === 'impact-typecheck' || mode === 'impact-all'
  const usesTests = mode === 'diff-all' || mode === 'impact-all'
  return timings.analysisMs + (usesTypecheck ? timings.typecheckMs : 0) + (usesTests ? timings.testsMs : 0)
}

export function injectedMetrics(cases: InjectedCase[], mode: Mode, threshold: Severity, scoring: Scoring = 'lenient'): Metrics {
  let detected = 0
  let breakLocations = 0
  let locationsFound = 0
  let flaggedGroups = 0
  let correctGroups = 0
  let inside = 0
  let insideFound = 0
  let outside = 0
  let outsideFound = 0
  for (const testCase of cases) {
    const oracle = oracleKeys(testCase)
    const groups = testCase.modes[mode].groups.filter((group) => flagged(group, threshold))
    const correct = groups.filter((group) => isCorrect(group, testCase, oracle, mode, scoring))
    const flaggedKeys = new Set(groups.flatMap((group) => group.locations))
    // A break counts as found when any line that identifies it was flagged.
    const covered = new Set(testCase.oracle.filter((location) => (location.keys ?? [location.key]).some((key) => flaggedKeys.has(key))).map((location) => location.key))
    if (correct.length > 0) detected += 1
    breakLocations += testCase.oracle.length
    locationsFound += covered.size
    flaggedGroups += groups.length
    correctGroups += correct.length
    for (const location of testCase.oracle) {
      if (location.inChangedFile) {
        inside += 1
        if (covered.has(location.key)) insideFound += 1
      } else {
        outside += 1
        if (covered.has(location.key)) outsideFound += 1
      }
    }
  }
  const runtimes = cases.map((testCase) => modeRuntime(testCase.timings, mode))
  return {
    cases: cases.length,
    detected,
    caseRecall: cases.length ? detected / cases.length : 0,
    breakLocations,
    locationsFound,
    locationRecall: breakLocations ? locationsFound / breakLocations : 0,
    insideDiffRecall: inside ? insideFound / inside : undefined,
    outsideDiffRecall: outside ? outsideFound / outside : undefined,
    flaggedGroups,
    correctGroups,
    precision: flaggedGroups ? correctGroups / flaggedGroups : undefined,
    falsePositivesPerCase: cases.length ? (flaggedGroups - correctGroups) / cases.length : 0,
    medianMs: percentile(runtimes, 50),
    p95Ms: percentile(runtimes, 95),
  }
}

/** Pick the flagging threshold on the tuning split only, by F1 of case recall and precision for impact-all. */
export function chooseThreshold(tuning: InjectedCase[]) {
  const scored = THRESHOLDS.map((threshold) => {
    const metrics = injectedMetrics(tuning, 'impact-all', threshold)
    const precision = metrics.precision ?? 0
    const f1 = precision + metrics.caseRecall ? (2 * precision * metrics.caseRecall) / (precision + metrics.caseRecall) : 0
    return { threshold, metrics, f1 }
  })
  // Ties go to the stricter threshold.
  const best = [...scored].sort((a, b) => b.f1 - a.f1 || RANK[a.threshold] - RANK[b.threshold])[0]
  return { threshold: best.threshold, scored }
}

export function realMetrics(cases: RealPullRequestCase[], mode: Mode, threshold: Severity) {
  const counts = cases.map((testCase) => testCase.modes[mode].groups.filter((group) => flagged(group, threshold)).length)
  const runtimes = cases.map((testCase) => modeRuntime(testCase.timings, mode))
  return {
    pullRequests: cases.length,
    flagged: counts.reduce((sum, count) => sum + count, 0),
    perPullRequest: cases.length ? counts.reduce((sum, count) => sum + count, 0) / cases.length : 0,
    withAnyFinding: counts.filter((count) => count > 0).length,
    max: Math.max(0, ...counts),
    medianMs: percentile(runtimes, 50),
    p95Ms: percentile(runtimes, 95),
  }
}

/** 95% Wilson score interval for k successes out of n. */
export function wilson(k: number, n: number) {
  if (n === 0) return undefined
  const z = 1.96
  const p = k / n
  const denominator = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)] as const
}

const pct = (value: number | undefined) => (value === undefined ? '—' : `${Math.round(value * 100)}%`)
const ci = (k: number, n: number) => {
  const interval = wilson(k, n)
  return interval ? ` (${Math.round(interval[0] * 100)}–${Math.round(interval[1] * 100)}%)` : ''
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** Seeded shuffle so the spot-check sample is reproducible. */
function seededSample<T>(items: T[], count: number, seed = 42) {
  const copy = [...items]
  let state = seed
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    const swap = state % (index + 1)
    ;[copy[index], copy[swap]] = [copy[swap], copy[index]]
  }
  return copy.slice(0, count)
}

const SPOT_CHECK_SIZE = 20

function spotCheckSample(results: BenchmarkResults, threshold: Severity) {
  const findings = results.repos.flatMap((repo) => repo.real.flatMap((pull) => pull.modes['impact-all'].groups.map((group) => ({ repo, pull, group }))))
  const primary = findings.filter(({ group }) => flagged(group, threshold))
  const extra = findings.filter(({ group }) => !flagged(group, threshold))
  const sample = [...seededSample(primary, SPOT_CHECK_SIZE), ...seededSample(extra, Math.max(0, SPOT_CHECK_SIZE - primary.length))]
  return { findings, primary, sample }
}

/** Look up the human verdict for a sampled finding by pull request and affected location. */
function verdictFor(verdicts: SpotCheckVerdicts | undefined, repo: { owner: string; name: string }, number: number, group: StoredGroup) {
  return verdicts?.verdicts.find((item) => item.pr === `${repo.owner}/${repo.name}#${number}` && item.affected === `${group.affected.path}:${group.affected.line}`)
}

export function renderSpotCheck(results: BenchmarkResults, threshold: Severity, verdicts?: SpotCheckVerdicts) {
  const { findings, primary, sample } = spotCheckSample(results, threshold)
  const pullRequests = results.repos.reduce((sum, repo) => sum + repo.real.length, 0)
  const scope = findings.length <= SPOT_CHECK_SIZE
    ? `All ${findings.length} findings that the impact + type checker + tests mode produced on ${pullRequests} real merged pull requests. Only ${findings.length} existed, so nothing was sampled. ${primary.length === 0 ? `None reached the chosen threshold (\`${threshold}\`); all are ${[...new Set(findings.map(({ group }) => group.severity))].join(' or ')} severity.` : `${primary.length} are at or above the chosen threshold (\`${threshold}\`).`}`
    : `${sample.length} of ${findings.length} findings, sampled with seed 42 from the impact + type checker + tests mode on ${pullRequests} real merged pull requests. Findings at or above the chosen threshold (\`${threshold}\`) are sampled first.`
  const labelled = sample.map((item) => verdictFor(verdicts, item.repo, item.pull.number, item.group)).filter((item) => item !== undefined)
  const lines = ['# Spot-check: CodeImpact findings on real merged pull requests', '', scope, '']
  if (verdicts && labelled.length > 0) {
    const tp = labelled.filter((item) => item.verdict === 'TP').length
    const fp = labelled.filter((item) => item.verdict === 'FP').length
    const unsure = labelled.filter((item) => item.verdict === '?').length
    lines.push(`**Verdicts** (reviewed by ${verdicts.reviewedBy}): ${tp} TP, ${fp} FP, ${unsure} unsure, for a precision of ${tp}/${tp + fp} (${pct(tp / Math.max(1, tp + fp))}) on these findings. ${verdicts.method}`, '')
  } else {
    lines.push('For each row, open both links and mark the verdict: **TP** (the PR really changed behaviour this caller depends on, or broke it), **FP** (no real risk), or **?** (cannot tell). Add a note when useful.', '')
  }
  lines.push('| # | PR | Severity | Evidence | Finding | Affected | Changed | Verdict | Note |', '|---|---|---|---|---|---|---|---|---|')
  sample.forEach(({ repo, pull, group }, index) => {
    const blob = (sha: string, path: string, line?: number) => `https://github.com/${repo.owner}/${repo.name}/blob/${sha}/${path}${line ? `#L${line}` : ''}`
    const message = group.message.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 260)
    const changed = group.changedPaths.map((path) => `[${path}](${blob(pull.headSha, path)})`).join(', ')
    const verdict = verdictFor(verdicts, repo, pull.number, group)
    lines.push(`| ${index + 1} | [${repo.owner}/${repo.name}#${pull.number}](https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}) | ${group.severity} | ${group.sources.join(', ')} | ${message} | [${group.affected.path}:${group.affected.line}](${blob(pull.headSha, group.affected.path, group.affected.line)}) | ${changed} | ${verdict?.verdict ?? ''} | ${verdict?.note.replace(/\|/g, '\\|') ?? ''} |`)
  })
  if (verdicts?.failurePatterns.length) {
    lines.push('', '## Failure patterns', '', 'In order of how many rows they cost:', '')
    verdicts.failurePatterns.forEach((item, index) => lines.push(`${index + 1}. ${item.pattern} (${/[,\s]/.test(item.rows) ? 'rows' : 'row'} ${item.rows})`))
  }
  lines.push('')
  return lines.join('\n')
}

export function renderReviewReport(results: BenchmarkResults, verdicts?: SpotCheckVerdicts) {
  const injected = results.repos.flatMap((repo) => repo.injected)
  const tuning = injected.filter((testCase) => testCase.split === 'tune')
  const holdout = injected.filter((testCase) => testCase.split === 'holdout')
  const real = results.repos.flatMap((repo) => repo.real)
  const { threshold, scored } = chooseThreshold(tuning)
  const lines: string[] = []
  const push = (...items: string[]) => lines.push(...items)

  push('# Benchmark report', '')
  push(`Generated ${results.generatedAt} · ${results.environment.platform} · Node ${results.environment.node} · ${results.environment.python ?? ''}${results.environment.pyright ? ` · pyright ${results.environment.pyright}` : ''}`, '')
  push('## What this measures', '')
  push('CodeImpact is run on commits that inject a known breaking change into a real repository, and on real merged pull requests from the same repositories. Five modes are compared. All five come from the same analysis run, so they see the same evidence:', '')
  for (const mode of MODES) push(`- **${MODE_LABELS[mode]}**${mode.startsWith('diff') ? ': only findings whose location is in a file the commit changed.' : ''}`)
  push('')
  push('> **The diff-only modes are an ablation of CodeImpact itself, not a comparison with CodeRabbit or any other product.** They apply the same rules and evidence, restricted to what is visible in the changed files. No third-party reviewer was run.', '')
  push(`**Sample size.** ${injected.length} injected cases over ${results.repos.length} repositories (${tuning.length} tuning, ${holdout.length} held-out), plus ${real.length} real pull requests. Every cell below is small; read the 95% intervals, not the point estimates.`, '')

  push('## Method', '')
  push('- **Repositories** (cloned at the commit shown, deleted afterwards):')
  for (const repo of results.repos) push(`  - [${repo.owner}/${repo.name}](https://github.com/${repo.owner}/${repo.name}) @ \`${repo.headSha.slice(0, 10)}\` (${repo.language}): ${repo.targets.length} target functions, ${repo.injected.length} injected cases, ${repo.real.length} real PRs, ${seconds(repo.durationMs)} total.`)
  const targets = results.repos.flatMap((repo) => repo.targets.map((target) => ({ repo, target })))
  const linkedTests = targets.map(({ repo, target }) => Math.max(0, ...repo.injected
    .filter((testCase) => testCase.target.name === target.name)
    .map((testCase) => Number(testCase.evidence.tests.match(/(\d+) selected/)?.[1] ?? 0))))
  const withTests = linkedTests.filter((count) => count > 0).length
  const outsideCallers = targets.filter(({ target }) => target.callSites > target.inChangedFile).length
  push('- **Target selection.** For each repository, every function in the head revision was a candidate when it:')
  push('  - is a top-level function (not a method or nested function) in a file under `src/` that is not a test file;')
  push('  - has a name of at least 5 characters that does not start with `__` and is unique among all symbols in the repository, so the textual oracle cannot confuse it with another definition;')
  push('  - has between 1 and 25 textual call sites, counted by the same oracle used for scoring.')
  push('  Candidates were ordered by an FNV-1a hash of `repository:name`, and the first 6 were taken. No one picked or excluded functions by hand.')
  push(`  The selection **does favour called functions**: it requires at least one call site, because a break with no caller cannot be measured. It **does not look at tests**. As a result, ${withTests} of ${targets.length} targets had at least one impacted test linked to them, and ${outsideCallers} of ${targets.length} had callers outside their own file. Targets and call-site counts: ${targets.map(({ repo, target }, index) => `\`${repo.key}:${target.name}\` (${plural(target.callSites, 'call site')}, ${target.inChangedFile} in its own file, ${plural(linkedTests[index], 'linked test')})`).join(', ')}.`)
  push('- **Injected break types:**')
  push('  - `signature`: a new required first parameter.')
  push('  - `rename`: the definition is renamed.')
  push('  - `delete`: the definition is removed.')
  push('  - `return-shape`: every single-line `return X` becomes `return [X]`.')
  push('  - `raise`: an unconditional `raise RuntimeError` / `throw new Error` at the top of the body.')
  push('  Each break is one commit on top of the repository head, built with git plumbing.')
  push('- **Ground truth.** It comes from a text-based oracle (`server/eval/inject.ts`) that is independent of CodeImpact\'s parser:')
  push('  - Every textual call of the name counts, outside comments and the definition itself.')
  push('  - For `rename` and `delete`, import and re-export lines of the name count too.')
  push('  - For `return-shape`, only calls whose value is used count.')
  push('  - For `raise`, calls inside a `try` that catches the exception are excluded.')
  push('  - Test files count, because a broken test call is a real break.')
  push('  The oracle can be wrong; see Limitations.')
  push('- **Matching.** A finding is correct when its affected location, or one of its affected callers, is an oracle location (same file and line). A failing-test finding with no caller location also counts when it is linked to the changed file. For the diff-only modes, type-checker errors inside the changed file also count. They sit on the lines the commit changed or on lines that use the changed function, which the call-site oracle does not cover. Each of the 21 such errors on the held-out set was reviewed from its message and location in the saved results; each is a return-type error on a changed line, a type error on a line that uses the value of the changed function, or an undefined-name error where the deleted function is referenced. The strict numbers, without that allowance, are in the footnote under the headline table.')
  push('- **Metrics:**')
  push('  - Case recall: cases with at least one correct flagged finding.')
  push('  - Location recall: oracle locations covered.')
  push('  - Precision: correct flagged findings over all flagged findings, pooled.')
  push('  - False positives per case.')
  push('  - Runtime: analysis, plus the type checker and tests for the modes that use them.')
  push(`- **Threshold.** The only tuned parameter is the minimum severity that counts as flagged. It was chosen on the tuning split alone, by F1 of case recall and precision for the impact + type checker + tests mode: **\`${threshold}\`**.`)
  push(`- **Evidence settings.** Type checker: tsc for TypeScript, pyright for Python, ${Math.round(180)} s limit per run. Tests: up to 20 top-ranked impacted tests, 300 s limit, failures re-run on the base revision.`, '')

  push(`## Headline: held-out injected cases (n = ${holdout.length}, threshold \`${threshold}\`)`, '')
  push('| Mode | Cases detected | Case recall (95% CI) | Location recall | Inside the diff | Outside the diff | Precision (95% CI) | False positives per case | Median runtime | p95 runtime |', '|---|---|---|---|---|---|---|---|---|---|')
  for (const mode of MODES) {
    const m = injectedMetrics(holdout, mode, threshold)
    push(`| ${MODE_LABELS[mode]} | ${m.detected}/${m.cases} | ${pct(m.caseRecall)}${ci(m.detected, m.cases)} | ${pct(m.locationRecall)} (${m.locationsFound}/${m.breakLocations}) | ${pct(m.insideDiffRecall)} | ${pct(m.outsideDiffRecall)} | ${pct(m.precision)}${ci(m.correctGroups, m.flaggedGroups)} | ${m.falsePositivesPerCase.toFixed(2)} | ${seconds(m.medianMs)} | ${seconds(m.p95Ms)} |`)
  }
  push('')
  const strict = (['diff-rules', 'diff-all'] as Mode[]).map((mode) => ({ mode, m: injectedMetrics(holdout, mode, threshold, 'strict') }))
  push(`<sub>Strict scoring for the diff-only modes, counting only oracle locations: ${strict.map(({ mode, m }) => `${MODE_LABELS[mode]}: ${m.detected}/${m.cases} cases detected, precision ${pct(m.precision)}${ci(m.correctGroups, m.flaggedGroups)}, ${m.falsePositivesPerCase.toFixed(2)} false positives per case`).join('; ')}. The impact modes are unaffected; their type checker skips changed files.</sub>`, '')
  const holdoutBreaks = holdout.flatMap((testCase) => testCase.oracle)
  push(`Of the ${holdoutBreaks.length} held-out break locations, ${holdoutBreaks.filter((location) => location.inChangedFile).length} are in the changed file and ${holdoutBreaks.filter((location) => !location.inChangedFile).length} are elsewhere.`, '')
  const strictDiffMisses = holdout.flatMap((testCase) => {
    const oracle = oracleKeys(testCase)
    return testCase.modes['diff-all'].groups.filter((group) => flagged(group, threshold) && !isCorrect(group, testCase, oracle, 'diff-all', 'strict')).map((group) => ({ testCase, group }))
  })
  const inChangedFileTypeErrors = strictDiffMisses.filter(({ testCase, group }) => group.sources.includes('typecheck') && group.affected.path === testCase.target.path)
  if (inChangedFileTypeErrors.length > 0) {
    push(`**What the diff-only type checker finds.** It reports ${inChangedFileTypeErrors.length} errors inside the changed file at lines that are not call sites. Most are the changed function's own \`return\` statements after a return-shape change. The rest are lines that use the changed function's value, or references to a deleted function that are not calls. They are counted as correct above and as wrong in the strict footnote. Either way, the diff-only modes cannot see the ${holdoutBreaks.filter((location) => !location.inChangedFile).length} breaks outside the changed file.`, '')
  }

  push('## Held-out results by bug type (case recall / precision)', '')
  push(`| Mode | ${BUG_TYPES.map((type) => `${type} (n=${holdout.filter((testCase) => testCase.type === type).length})`).join(' | ')} |`, `|---|${BUG_TYPES.map(() => '---').join('|')}|`)
  for (const mode of MODES) {
    const cells = BUG_TYPES.map((type) => {
      const m = injectedMetrics(holdout.filter((testCase) => testCase.type === type), mode, threshold)
      return m.cases ? `${pct(m.caseRecall)} / ${pct(m.precision)}` : '—'
    })
    push(`| ${MODE_LABELS[mode]} | ${cells.join(' | ')} |`)
  }
  push('')

  push('## Real merged pull requests: false positives', '')
  push(`${real.length} merged pull requests: ${results.repos.map((repo) => `${repo.real.length} from ${repo.name}`).join(', ')}. Each was analysed against its first parent. Any finding on an already-merged pull request is a candidate false positive, so the [spot-check](spot-check.md) below decides which ones were real.`, '')
  push('| Mode | Flagged findings per PR | PRs with any flagged finding | Most on one PR | Median runtime | p95 runtime |', '|---|---|---|---|---|---|')
  for (const mode of MODES) {
    const m = realMetrics(real, mode, threshold)
    push(`| ${MODE_LABELS[mode]} | ${m.perPullRequest.toFixed(2)} | ${m.withAnyFinding}/${m.pullRequests} | ${m.max} | ${seconds(m.medianMs)} | ${seconds(m.p95Ms)} |`)
  }
  const severities = THRESHOLDS.map((severity) => `${severity}: ${real.reduce((sum, pull) => sum + pull.modes['impact-all'].groups.filter((group) => group.severity === severity).length, 0)}`)
  push('', `All findings on real PRs in the impact + type checker + tests mode, by severity: ${severities.join(', ')}.`, '')
  const ruleCounts = new Map<string, number>()
  real.forEach((pull) => pull.modes['impact-all'].groups.filter((group) => flagged(group, threshold)).forEach((group) => group.ruleIds.forEach((rule) => ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1))))
  if (ruleCounts.size) push(`Flagged findings on real PRs by rule: ${[...ruleCounts].sort((a, b) => b[1] - a[1]).map(([rule, count]) => `\`${rule}\` ${count}`).join(', ')}.`, '')

  const { findings: realFindings, sample: spotSample } = spotCheckSample(results, threshold)
  const labelled = spotSample.map((item) => ({ item, verdict: verdictFor(verdicts, item.repo, item.pull.number, item.group) })).filter((entry) => entry.verdict)
  if (verdicts && labelled.length > 0) {
    const tp = labelled.filter(({ verdict }) => verdict!.verdict === 'TP').length
    const fp = labelled.filter(({ verdict }) => verdict!.verdict === 'FP').length
    const unsure = labelled.filter(({ verdict }) => verdict!.verdict === '?').length
    const lowOnly = realFindings.every(({ group }) => group.severity === 'low')
    push('### Spot-check of real-PR findings', '')
    push(`All ${realFindings.length} findings on the real pull requests${realFindings.length > labelled.length ? ` (${labelled.length} of them)` : ''} were reviewed by ${verdicts.reviewedBy} against each pull request's full diff on GitHub, not only the lines each finding cites. Verdicts and notes are in [spot-check.md](spot-check.md).`, '')
    push(`- **Precision on these findings: ${tp}/${tp + fp} (${pct(tp / Math.max(1, tp + fp))})**${lowOnly ? ' on low-severity findings' : ''}. That is ${tp} true positive${tp === 1 ? '' : 's'}, ${fp} false positive${fp === 1 ? '' : 's'}, and ${unsure} unsure.`)
    push(`- **No real-PR finding reached ${threshold} severity**, so with the default threshold none of them would be flagged, and none would appear in the PR comment, which now hides low severity by default.`)
    for (const item of verdicts.underRated) push(`- **Under-rated real change (${item.pr}):** ${item.note} The tool rated it low and called the change internal, so with the default threshold it would not have been surfaced.`)
    push('')
  }

  push('## Where it fails (held-out, impact + type checker + tests)', '')
  const misses = holdout.filter((testCase) => {
    const oracle = oracleKeys(testCase)
    return !testCase.modes['impact-all'].groups.some((group) => flagged(group, threshold) && isCorrect(group, testCase, oracle))
  })
  if (misses.length === 0) push('No held-out case was missed.', '')
  else {
    push('| Case | Break locations | What was reported | Type checker | Tests |', '|---|---|---|---|---|')
    for (const testCase of misses) {
      const reported = testCase.modes['impact-all'].groups.map((group) => `${group.severity} ${group.ruleIds.join('+')} @ ${group.affected.path}:${group.affected.line}`).join('; ') || 'nothing'
      push(`| \`${testCase.id}\` | ${testCase.oracle.map((location) => location.key).join(', ')} | ${reported.replace(/\|/g, '\\|')} | ${testCase.evidence.typecheck.replace(/\|/g, '\\|')} | ${testCase.evidence.tests.replace(/\|/g, '\\|')} |`)
    }
    push('')
  }
  const falsePositives = holdout.flatMap((testCase) => {
    const oracle = oracleKeys(testCase)
    return testCase.modes['impact-all'].groups.filter((group) => flagged(group, threshold) && !isCorrect(group, testCase, oracle)).map((group) => ({ testCase, group }))
  })
  push(`False positives on held-out injected cases (impact + type checker + tests): ${falsePositives.length}.`, '')
  if (falsePositives.length) {
    push('| Case | Finding | Location |', '|---|---|---|')
    for (const { testCase, group } of falsePositives.slice(0, 15)) push(`| \`${testCase.id}\` | ${group.severity} ${group.ruleIds.join('+')}: ${group.message.replace(/\|/g, '\\|').slice(0, 160)} | ${group.affected.path}:${group.affected.line} |`)
    push('')
  }

  if (verdicts?.failurePatterns.length) {
    push('## Next planned fixes', '')
    push('These come from the real-PR spot-check, ordered by how many rows each pattern cost. They are deliberately **not fixed yet**: changing the rules now would tune them against cases that have already been seen, and the held-out set would no longer be held out. They will be fixed together and then measured on new cases.', '')
    verdicts.failurePatterns.forEach((item, index) => push(`${index + 1}. ${item.pattern} (spot-check ${/[,\s]/.test(item.rows) ? 'rows' : 'row'} ${item.rows})`))
    push('', 'Weaknesses the injected cases exposed, also deferred for the same reason:', '')
    push('- `impact/unupdated-caller` only considers callers in files the PR did not touch, so an unchanged caller in the same file is not escalated.')
    push('- An inserted parameter is not detected by arity checks when a default or rest parameter absorbs the arguments; only the type checker or tests catch it.')
    push('- When a rename or delete breaks test collection itself (an ImportError in every test module), the test run reports it as an environment problem rather than as a finding. The broken-import rule still catches these cases.', '')
  }

  push(`## Tuning split (n = ${tuning.length})`, '')
  push('Threshold selection, impact + type checker + tests mode:', '')
  push('| Threshold | Case recall | Precision | F1 |', '|---|---|---|---|')
  for (const row of scored) push(`| \`${row.threshold}\`${row.threshold === threshold ? ' (chosen)' : ''} | ${pct(row.metrics.caseRecall)} | ${pct(row.metrics.precision)} | ${row.f1.toFixed(2)} |`)
  push('', 'All modes on the tuning split, at the chosen threshold:', '')
  push('| Mode | Case recall | Location recall | Precision | False positives per case |', '|---|---|---|---|---|')
  for (const mode of MODES) {
    const m = injectedMetrics(tuning, mode, threshold)
    push(`| ${MODE_LABELS[mode]} | ${pct(m.caseRecall)} (${m.detected}/${m.cases}) | ${pct(m.locationRecall)} | ${pct(m.precision)} | ${m.falsePositivesPerCase.toFixed(2)} |`)
  }
  push('')

  const skipped = results.repos.flatMap((repo) => repo.skipped)
  push('## Skipped cases', '')
  push(`${plural(skipped.length, 'candidate case')} ${skipped.length === 1 ? 'was' : 'were'} not run, because the break type does not apply to that function or no call site would break.`, '')
  const reasons = new Map<string, number>()
  skipped.forEach((item) => reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1))
  for (const [reason, count] of reasons) push(`- ${count}× ${reason}`)
  push('')

  push('## Resources', '')
  push(`Peak disk use: **${(results.peakDiskBytes / 1e6).toFixed(0)} MB**. That figure covers the benchmark folder (one clone, its virtualenv or \`node_modules\`, and pyright) plus temporary revision copies, sampled every 15 s and after each case. Each repository's clone and dependencies were deleted before the next one started, and pyright was removed at the end.`, '')

  push('## Limitations', '')
  push('- **Small samples.** A held-out cell often has 5–10 cases, so one case moves a percentage by 10–20 points.')
  push('- **The oracle is textual:**')
  push('  - It can count a same-named call on another object.')
  push('  - It misses dynamic calls (`getattr`, callbacks passed by reference) and multi-line call expressions whose name is on an earlier line.')
  push('  - For `raise`, it approximates `try` nesting from indentation or braces.')
  push('- **Injected breaks are synthetic and blunt.** Real regressions are subtler, so real-PR noise and the spot-check matter as much as recall.')
  push('- **Tests are judged by their own outcome.** A test that fails on head and passes on base is counted for the case even if it fails for an unrelated reason; base re-runs reduce this risk.')
  push('- **Only three repositories, all small.** Results may not transfer to large or heavily dynamic codebases.')
  push('- **No other review tool was run**, so these numbers say nothing about how CodeImpact compares with CodeRabbit or similar products.', '')
  return { markdown: lines.join('\n'), threshold }
}
