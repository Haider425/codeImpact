import { ALGORITHM_VERSION, analyzeRepository } from '../../src/analysis/engine'
import { PARSER_VERSION } from '../../src/analysis/parser'
import { selectionMetrics, selectTests, STRATEGY_LABELS } from '../../src/analysis/baselines'
import type { SelectionMetrics, SelectionStrategy } from '../../src/analysis/baselines'
import type { AnalysisResult } from '../../src/analysis/types'
import { git, loadRepositoryRevisions, resolveCommit } from '../git'

export interface BenchmarkCase {
  id: string
  base: string
  head: string
  /** Hand-labelled relevant test function names, derived from inspecting the diff. */
  expectedTests: string[]
  /** `tune` cases may inform weight changes; `holdout` cases must not. */
  split: 'tune' | 'holdout'
  note?: string
}

export interface BenchmarkRepository {
  owner: string
  name: string
  url: string
  cases: BenchmarkCase[]
}

export const itsdangerous: BenchmarkRepository = {
  owner: 'pallets',
  name: 'itsdangerous',
  url: 'https://github.com/pallets/itsdangerous',
  cases: [
    { id: '177196d-oserror', base: '37f09970fa32a330a6660ded3abdb264086531b5', head: '177196d3a5c7ad37b8ccbd0f88445aced07f1ca0', expectedTests: ['test_malformed_future_timestamp'], split: 'tune', note: 'Commit also edits the labelled test file.' },
    { id: '7f4dcf8-lazy-sha1', base: '93ae366874bbd4f69d90495c45b2cd336387496c', head: '7f4dcf83a07bb3d53f4e0e65ef1b43327b4cca90', expectedTests: ['test_iter_unsigners'], split: 'tune' },
    { id: '37f0997-valueerror', base: '85b1e3b76e0e37473dc286450ada725cd02981b4', head: '37f09970fa32a330a6660ded3abdb264086531b5', expectedTests: ['test_malformed_future_timestamp'], split: 'holdout' },
    { id: '3edfbbb-overflowerror', base: 'faa28bccc85ee47a8274536dd3649a0b67d0a75b', head: '3edfbbbc615be5090d452bbf8a13dfdd68436659', expectedTests: ['test_malformed_future_timestamp'], split: 'holdout' },
  ],
}

export interface CaseResult {
  id: string
  split: BenchmarkCase['split']
  baseSha: string
  headSha: string
  changedSymbols: string[]
  expectedTests: string[]
  graphRecommendations: { name: string; score: number; connection: string }[]
  strategies: Record<SelectionStrategy, SelectionMetrics>
  evidenceValid: boolean
  latencyMs: number
  parsedFiles: number
  unresolved: number
  note?: string
}

/** Every evidence edge must exist, connect consecutive path nodes, and point at a real line. */
export function evidenceIsValid(result: AnalysisResult, lineCounts: Map<string, number>) {
  const edges = new Map(result.edges.map((edge) => [edge.id, edge]))
  return [...result.tests.map((t) => t.path), ...result.findings.map((f) => f.path)].every((path) => (
    path.edgeIds.length === path.nodeIds.length - 1 && path.edgeIds.every((id, index) => {
      const edge = edges.get(id)
      const lines = lineCounts.get(`${edge?.evidenceRevision ?? 'head'}:${edge?.evidencePath}`)
      return edge !== undefined
        && edge.source === path.nodeIds[index + 1]
        && edge.target === path.nodeIds[index]
        && lines !== undefined && edge.evidenceLine >= 1 && edge.evidenceLine <= lines
    })
  ))
}

export async function evaluateCase(repoDir: string, repo: BenchmarkRepository, item: BenchmarkCase, wasmBasePath: string): Promise<CaseResult> {
  const baseSha = await resolveCommit(repoDir, item.base)
  const headSha = await resolveCommit(repoDir, item.head)
  const parent = (await git(repoDir, ['rev-parse', `${headSha}^`])).toString('utf8').trim()
  if (parent !== baseSha) throw new Error(`${item.id}: base is not head's parent`)

  const started = performance.now()
  const loaded = await loadRepositoryRevisions(repoDir, {
    owner: repo.owner,
    name: repo.name,
    pullRequest: { number: 0, title: item.id, author: 'historical', baseRef: baseSha, headRef: headSha },
  }, baseSha, headSha)
  const result = await analyzeRepository(loaded.repository, { wasmBasePath })
  const latencyMs = Math.round(performance.now() - started)

  const lineCounts = new Map<string, number>()
  for (const side of ['base', 'head'] as const) {
    loaded.repository[side].files.forEach((file) => lineCounts.set(`${side}:${file.path}`, file.source.split('\n').length))
  }
  const selections = selectTests(result)
  const allTests = selections['all-tests']
  const testNameById = new Map(result.symbols.filter((s) => s.kind === 'test').map((s) => [s.id, s.name]))
  const relevant = allTests.filter((id) => item.expectedTests.includes(testNameById.get(id) ?? ''))
  const strategies = Object.fromEntries(Object.entries(selections).map(([strategy, selected]) => (
    [strategy, selectionMetrics(selected, relevant, allTests.length)]
  ))) as Record<SelectionStrategy, SelectionMetrics>

  return {
    id: item.id,
    split: item.split,
    baseSha,
    headSha,
    changedSymbols: result.changes.map((change) => `${change.changeType}:${(change.head ?? change.base)?.qualifiedName}`),
    expectedTests: item.expectedTests,
    graphRecommendations: result.tests.map((test) => ({ name: test.test.qualifiedName, score: test.score, connection: test.connection })),
    strategies,
    evidenceValid: evidenceIsValid(result, lineCounts),
    latencyMs,
    parsedFiles: result.stats.parsedFiles,
    unresolved: result.stats.unresolved,
    note: item.note,
  }
}

function mean(values: (number | undefined)[]) {
  const defined = values.filter((value): value is number => value !== undefined)
  return defined.length ? defined.reduce((sum, value) => sum + value, 0) / defined.length : undefined
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export function aggregate(results: CaseResult[]) {
  const strategies = Object.keys(STRATEGY_LABELS) as SelectionStrategy[]
  return Object.fromEntries(strategies.map((strategy) => {
    const metrics = results.map((result) => result.strategies[strategy])
    return [strategy, {
      cases: results.length,
      meanRecall: mean(metrics.map((m) => m.recall)),
      meanReduction: mean(metrics.map((m) => m.reduction)),
      meanPrecisionAtK: mean(metrics.map((m) => m.precisionAtK)),
      meanSelected: mean(metrics.map((m) => m.selected)),
    }]
  })) as Record<SelectionStrategy, { cases: number; meanRecall?: number; meanReduction?: number; meanPrecisionAtK?: number; meanSelected?: number }>
}

const pct = (value: number | undefined) => (value === undefined ? '—' : `${Math.round(value * 100)}%`)

export function renderReport(repo: BenchmarkRepository, results: CaseResult[]) {
  const lines: string[] = []
  const latencies = results.map((result) => result.latencyMs)
  lines.push(`# Benchmark report — ${repo.owner}/${repo.name}`, '')
  lines.push(`Generated ${new Date().toISOString()} · parser \`${PARSER_VERSION}\` · algorithm \`${ALGORITHM_VERSION}\``, '')
  lines.push(`**Sample size: ${results.length} historical commits, ${results.reduce((sum, r) => sum + r.strategies['all-tests'].relevant, 0)} labelled relevant tests.** This is far too small to support accuracy claims; treat it as a regression harness and a worked example of the method.`, '')
  for (const split of ['tune', 'holdout'] as const) {
    const subset = results.filter((result) => result.split === split)
    if (subset.length === 0) continue
    lines.push(`## ${split === 'tune' ? 'Tuning' : 'Held-out'} cases (n = ${subset.length})`, '')
    lines.push('| Strategy | Mean recall | Mean suite reduction | Mean precision@5 | Mean tests selected |', '|---|---|---|---|---|')
    const summary = aggregate(subset)
    for (const [strategy, label] of Object.entries(STRATEGY_LABELS) as [SelectionStrategy, string][]) {
      const row = summary[strategy]
      lines.push(`| ${label} | ${pct(row.meanRecall)} | ${pct(row.meanReduction)} | ${pct(row.meanPrecisionAtK)} | ${row.meanSelected?.toFixed(1) ?? '—'} |`)
    }
    lines.push('')
  }
  lines.push('## Per-case detail', '')
  lines.push('| Case | Split | Changed symbols | Labelled | Graph found | Graph selected / suite | Evidence valid | Latency |', '|---|---|---|---|---|---|---|---|')
  for (const result of results) {
    const graph = result.strategies.graph
    lines.push(`| ${result.id} | ${result.split} | ${result.changedSymbols.join('<br>') || '—'} | ${result.expectedTests.join(', ')} | ${graph.found}/${graph.relevant} | ${graph.selected}/${graph.totalTests} | ${result.evidenceValid ? 'yes' : '**no**'} | ${result.latencyMs} ms |`)
  }
  lines.push('')
  lines.push(`Latency (load + parse both revisions + analyze): median ${percentile(latencies, 50)} ms, p95 ${percentile(latencies, 95)} ms.`, '')
  lines.push('## Method', '')
  lines.push('- Each case is a single upstream commit; base is its first parent. Revisions are read straight from git objects; no repository code is executed.')
  lines.push('- Labels are tests a reviewer identified as exercising the changed behaviour after reading the diff. They are not exhaustive; unlabelled recommendations are not necessarily wrong.')
  lines.push('- Recall = labelled tests selected ÷ labelled tests. Reduction = 1 − selected ÷ all tests. Precision@5 uses the labels as the only positives, so it is a lower bound.')
  lines.push('- Weights in `src/analysis/engine.ts` (`RANKING_WEIGHTS`) may only be tuned against `tune` cases.')
  const notes = results.filter((result) => result.note)
  if (notes.length) {
    lines.push('', '## Case notes', '')
    notes.forEach((result) => lines.push(`- **${result.id}**: ${result.note}`))
  }
  lines.push('')
  return lines.join('\n')
}
