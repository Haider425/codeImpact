import { fileSymbolId } from './parser'
import type { AnalysisResult } from './types'

export type SelectionStrategy = 'all-tests' | 'changed-files' | 'changed-plus-imports' | 'direct-callers' | 'graph'

export const STRATEGY_LABELS: Record<SelectionStrategy, string> = {
  'all-tests': 'All tests',
  'changed-files': 'Tests in changed files',
  'changed-plus-imports': 'Changed files + direct importers',
  'direct-callers': 'Tests one call edge from a change',
  graph: 'CodeImpact graph ranking',
}

/** Test symbol ids each strategy would select, in rank order where the strategy has one. */
export function selectTests(result: AnalysisResult): Record<SelectionStrategy, string[]> {
  const baseOnly = new Set(result.changes.flatMap((change) => (
    change.changeType === 'deleted' ? [change.symbolId] : change.previousId ? [change.previousId] : []
  )))
  const headTests = result.symbols
    .filter((symbol) => symbol.kind === 'test' && !baseOnly.has(symbol.id))
    .sort((a, b) => a.id.localeCompare(b.id))
  const changedPaths = new Set(result.changes.map((change) => (change.head ?? change.base)!.path))
  const importers = new Set(result.edges
    .filter((edge) => edge.type === 'imports' && edge.evidenceRevision !== 'base' && [...changedPaths].some((path) => edge.target === fileSymbolId(path)))
    .map((edge) => edge.evidencePath))

  return {
    'all-tests': headTests.map((test) => test.id),
    'changed-files': headTests.filter((test) => changedPaths.has(test.path)).map((test) => test.id),
    'changed-plus-imports': headTests.filter((test) => changedPaths.has(test.path) || importers.has(test.path)).map((test) => test.id),
    'direct-callers': result.tests.filter((test) => test.connection === 'changed' || (test.connection === 'call-path' && test.path.edgeIds.length === 1)).map((test) => test.test.id),
    graph: result.tests.map((test) => test.test.id),
  }
}

export interface SelectionMetrics {
  selected: number
  totalTests: number
  relevant: number
  found: number
  /** Fraction of relevant tests selected. Undefined when there are no labels. */
  recall?: number
  /** Fraction of the full suite excluded. */
  reduction: number
  precisionAtK?: number
  k: number
  missed: string[]
}

export function selectionMetrics(selected: string[], relevant: string[], totalTests: number, k = 5): SelectionMetrics {
  const relevantSet = new Set(relevant)
  const found = selected.filter((id) => relevantSet.has(id))
  const top = selected.slice(0, k)
  return {
    selected: selected.length,
    totalTests,
    relevant: relevant.length,
    found: found.length,
    recall: relevant.length ? found.length / relevant.length : undefined,
    reduction: totalTests ? 1 - selected.length / totalTests : 0,
    precisionAtK: top.length ? top.filter((id) => relevantSet.has(id)).length / top.length : undefined,
    k,
    missed: relevant.filter((id) => !selected.includes(id)),
  }
}
