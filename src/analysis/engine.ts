import { parseRevision } from './parser'
import type {
  AnalysisResult,
  ChangeRecord,
  DemoRepository,
  EdgeRecord,
  EvidencePath,
  ImpactFinding,
  ParserOptions,
  SymbolRecord,
  TestRecommendation,
} from './types'

export type AnalysisStage = 'fetching' | 'parsing-base' | 'parsing-head' | 'graphing' | 'ranking' | 'completed'

interface AnalyzeOptions extends ParserOptions {
  onStage?: (stage: AnalysisStage) => void
}

function normalized(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
}

function detectChanges(headSymbols: SymbolRecord[], baseSymbols: SymbolRecord[]) {
  const head = new Map(headSymbols.filter((s) => s.kind !== 'file').map((s) => [s.id, s]))
  const base = new Map(baseSymbols.filter((s) => s.kind !== 'file').map((s) => [s.id, s]))
  const ids = [...new Set([...head.keys(), ...base.keys()])].sort()
  const changes: ChangeRecord[] = []

  ids.forEach((id) => {
    const before = base.get(id)
    const after = head.get(id)
    if (!before && after) changes.push({ symbolId: id, changeType: 'added', head: after })
    else if (before && !after) changes.push({ symbolId: id, changeType: 'deleted', base: before })
    else if (before && after && normalized(before.source) !== normalized(after.source)) {
      changes.push({
        symbolId: id,
        changeType: normalized(before.signature) !== normalized(after.signature) ? 'signature' : 'modified',
        base: before,
        head: after,
      })
    }
  })
  return changes
}

function pathFromPredecessors(
  id: string,
  previous: Map<string, { from: string; edge: EdgeRecord } | null>,
): EvidencePath {
  const nodeIds = [id]
  const edgeIds: string[] = []
  let current = id
  while (previous.get(current)) {
    const step = previous.get(current)!
    nodeIds.push(step.from)
    edgeIds.push(step.edge.id)
    current = step.from
  }
  return { nodeIds: nodeIds.reverse(), edgeIds: edgeIds.reverse() }
}

function scoreFor(distance: number, directTestLink: boolean, resolved: boolean, isTest: boolean) {
  const proximity = 1 / Math.max(1, distance)
  const directChangeLink = distance === 1 ? 1 : 0
  const dependencyResolution = resolved ? 1 : 0.5
  const testLinkStrength = isTest ? (directTestLink ? 1 : 0.45) : 0
  return Math.round(100 * (0.55 * proximity + 0.25 * directChangeLink + 0.1 * dependencyResolution + 0.1 * testLinkStrength))
}

function reasonsFor(distance: number, changedName: string, directTestLink: boolean, isTest: boolean) {
  const reasons = distance === 1
    ? [`Directly calls changed symbol ${changedName}.`]
    : [`Connected to ${changedName} through ${distance} dependency edges.`]
  if (directTestLink) reasons.push('Directly references the changed implementation.')
  if (isTest && distance > 1) reasons.push('Transitive caller path is statically resolved; relevance is heuristic, not a failure probability.')
  return reasons
}

export async function analyzeRepository(repository: DemoRepository, options: AnalyzeOptions): Promise<AnalysisResult> {
  const started = performance.now()
  options.onStage?.('fetching')
  options.onStage?.('parsing-base')
  const base = await parseRevision(repository.base, options)
  options.onStage?.('parsing-head')
  const head = await parseRevision(repository.head, options)

  const changes = detectChanges(head.symbols, base.symbols)
  const deletedIds = new Set(changes.filter((change) => change.changeType === 'deleted').map((change) => change.symbolId))
  const headSymbolIds = new Set(head.symbols.map((symbol) => symbol.id))
  const symbols = [...head.symbols, ...base.symbols.filter((symbol) => !headSymbolIds.has(symbol.id))]
  const baseDeletionEdges = base.edges
    .filter((edge) => edge.type === 'calls' && deletedIds.has(edge.target) && headSymbolIds.has(edge.source))
    .map((edge) => ({ ...edge, evidenceRevision: 'base' as const }))
  const edges = [...head.edges.map((edge) => ({ ...edge, evidenceRevision: 'head' as const })), ...baseDeletionEdges]
  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]))
  const edgesById = new Map(edges.map((edge) => [edge.id, edge]))
  const seeds = changes.map((change) => change.symbolId).sort()

  options.onStage?.('graphing')
  const reverseCalls = new Map<string, EdgeRecord[]>()
  edges.filter((edge) => edge.type === 'calls').forEach((edge) => {
    const list = reverseCalls.get(edge.target) ?? []
    list.push(edge)
    reverseCalls.set(edge.target, list)
  })
  reverseCalls.forEach((list) => list.sort((a, b) => a.id.localeCompare(b.id)))

  const distance = new Map<string, number>()
  const previous = new Map<string, { from: string; edge: EdgeRecord } | null>()
  const queue: string[] = []
  seeds.forEach((id) => {
    distance.set(id, 0)
    previous.set(id, null)
    queue.push(id)
  })

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    for (const edge of reverseCalls.get(current) ?? []) {
      if (distance.has(edge.source)) continue
      distance.set(edge.source, (distance.get(current) ?? 0) + 1)
      previous.set(edge.source, { from: current, edge })
      queue.push(edge.source)
    }
  }

  options.onStage?.('ranking')
  const findings: ImpactFinding[] = []
  const tests: TestRecommendation[] = []

  distance.forEach((dist, id) => {
    if (dist === 0) return
    const symbol = symbolsById.get(id)
    if (!symbol || !headSymbolIds.has(id) || symbol.kind === 'file') return
    const path = pathFromPredecessors(id, previous)
    const changed = symbolsById.get(path.nodeIds[0])
    const changedName = changed?.name ?? 'changed code'
    const pathEdges = path.edgeIds.map((edgeId) => edgesById.get(edgeId)!).filter(Boolean)
    const resolved = pathEdges.every((edge) => edge.resolutionStatus === 'resolved')
    const directTestLink = symbol.kind === 'test' && dist === 1
    const score = scoreFor(dist, directTestLink, resolved, symbol.kind === 'test')
    const reasons = reasonsFor(dist, changedName, directTestLink, symbol.kind === 'test')

    if (symbol.kind === 'test') {
      tests.push({
        test: symbol,
        score,
        rank: 0,
        path,
        reasons,
        limitation: 'Recommended only — this test was not executed by CodeImpact.',
      })
    } else {
      findings.push({
        symbol,
        impactType: dist === 1 ? 'direct' : 'transitive',
        distance: dist,
        score,
        rank: 0,
        path,
        reasons,
      })
    }
  })

  findings.sort((a, b) => b.score - a.score || a.distance - b.distance || a.symbol.id.localeCompare(b.symbol.id))
  findings.forEach((finding, index) => { finding.rank = index + 1 })
  tests.sort((a, b) => b.score - a.score || a.test.id.localeCompare(b.test.id))
  tests.forEach((test, index) => { test.rank = index + 1 })

  const graphSymbolIds = [...new Set([...seeds, ...findings.map((f) => f.symbol.id), ...tests.map((t) => t.test.id)])]
  const baseFiles = new Map(repository.base.files.map((file) => [file.path, file]))
  const headFiles = new Map(repository.head.files.map((file) => [file.path, file]))
  const changedFiles = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].filter((path) => {
    const before = baseFiles.get(path)
    const after = headFiles.get(path)
    return !before || !after || normalized(before.source) !== normalized(after.source)
  }).length

  options.onStage?.('completed')
  return {
    symbols,
    edges,
    changes,
    findings,
    tests,
    unresolved: head.unresolved,
    graphSymbolIds,
    stats: {
      parsedFiles: repository.head.files.length,
      changedFiles,
      changedSymbols: changes.length,
      impactedSymbols: findings.length,
      recommendedTests: tests.length,
      unresolved: head.unresolved.length,
      durationMs: Math.round(performance.now() - started),
    },
    limitations: [
      'Static analysis can miss reflection, dynamic dispatch, and runtime-only relationships.',
      'Scores are transparent ranking heuristics, not calibrated probabilities of failure.',
      'Tests are recommended, not executed. No claim is made that this subset is sufficient.',
      'This vertical slice analyzes the included base/head revisions; GitHub ingestion is not connected yet.',
    ],
  }
}
