import { fileSymbolId, parseRevision, PARSER_VERSION } from './parser'
import type {
  AnalysisResult,
  ChangeRecord,
  DemoRepository,
  EdgeRecord,
  EvidencePath,
  ImpactFinding,
  ParserOptions,
  SourceFile,
  SymbolRecord,
  TestRecommendation,
} from './types'

export const ALGORITHM_VERSION = 'impact-bfs/2'
export const DEFAULT_MAX_DEPTH = 8

/** Weights for the documented ranking heuristic. They order inspection priority; they are not probabilities. */
export const RANKING_WEIGHTS = {
  proximity: 0.45,
  directChangeLink: 0.2,
  resolution: 0.1,
  testLink: 0.1,
  fanIn: 0.1,
  exportedApi: 0.05,
} as const

/** Tests linked only by a file-level import of a changed module rank below every call-path result. */
export const FILE_IMPORT_TEST_SCORE = 15
const CHANGED_TEST_SCORE = 100
const FAN_IN_SATURATION = 3
const FAN_IN_SEED_LIMIT = 300

export type AnalysisStage = 'fetching' | 'parsing-base' | 'parsing-head' | 'graphing' | 'ranking' | 'completed'

export interface AnalyzeOptions extends ParserOptions {
  onStage?: (stage: AnalysisStage) => void | Promise<void>
  maxDepth?: number
  /** Extra limitations contributed by the caller (ingestion limits, skipped files, ...). */
  limitations?: string[]
}

function normalized(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim()
}

/** Classes are compared without their member bodies so that editing one method does not flag the whole class. */
function fingerprint(symbol: SymbolRecord, all: SymbolRecord[]) {
  if (symbol.kind !== 'class') return normalized(symbol.source)
  let source = symbol.source
  for (const member of all) {
    if (member.path === symbol.path && member.qualifiedName.startsWith(`${symbol.qualifiedName}.`)) {
      source = source.replace(member.source, '')
    }
  }
  return normalized(source)
}

function moduleRemainder(file: SourceFile | undefined, symbols: SymbolRecord[]) {
  if (!file) return undefined
  let source = file.source
  for (const symbol of symbols) {
    if (symbol.path === file.path && symbol.kind !== 'file' && symbol.qualifiedName === symbol.name) {
      source = source.replace(symbol.source, '')
    }
  }
  return normalized(source)
}

function renameKey(symbol: SymbolRecord) {
  return `${symbol.path}\u0000${symbol.kind}\u0000${normalized(symbol.source.replace(symbol.name, '\u0001'))}`
}

export function detectChanges(
  headSymbols: SymbolRecord[],
  baseSymbols: SymbolRecord[],
  baseFiles: SourceFile[] = [],
  headFiles: SourceFile[] = [],
) {
  const head = new Map(headSymbols.filter((s) => s.kind !== 'file').map((s) => [s.id, s]))
  const base = new Map(baseSymbols.filter((s) => s.kind !== 'file').map((s) => [s.id, s]))
  const ids = [...new Set([...head.keys(), ...base.keys()])].sort()
  const added: ChangeRecord[] = []
  const deleted: ChangeRecord[] = []
  const changes: ChangeRecord[] = []

  ids.forEach((id) => {
    const before = base.get(id)
    const after = head.get(id)
    if (!before && after) added.push({ symbolId: id, changeType: 'added', head: after })
    else if (before && !after) deleted.push({ symbolId: id, changeType: 'deleted', base: before })
    else if (before && after && fingerprint(before, baseSymbols) !== fingerprint(after, headSymbols)) {
      changes.push({
        symbolId: id,
        changeType: normalized(before.signature) !== normalized(after.signature) ? 'signature' : 'modified',
        base: before,
        head: after,
      })
    }
  })

  // Deterministic rename matching: same file, same kind, identical body apart from the name.
  const deletedByKey = new Map<string, ChangeRecord[]>()
  deleted.forEach((change) => {
    const key = renameKey(change.base!)
    deletedByKey.set(key, [...(deletedByKey.get(key) ?? []), change])
  })
  const renamedBase = new Set<string>()
  added.forEach((change) => {
    const candidates = (deletedByKey.get(renameKey(change.head!)) ?? []).filter((c) => !renamedBase.has(c.symbolId))
    if (candidates.length === 1) {
      renamedBase.add(candidates[0].symbolId)
      changes.push({ symbolId: change.symbolId, changeType: 'renamed', previousId: candidates[0].symbolId, base: candidates[0].base, head: change.head })
    } else {
      changes.push(change)
    }
  })
  changes.push(...deleted.filter((change) => !renamedBase.has(change.symbolId)))

  // File-level edits outside any declaration (constants, module setup, decorators at module scope).
  const baseByPath = new Map(baseFiles.map((file) => [file.path, file]))
  const headByPath = new Map(headFiles.map((file) => [file.path, file]))
  for (const path of [...new Set([...baseByPath.keys(), ...headByPath.keys()])].sort()) {
    const before = moduleRemainder(baseByPath.get(path), baseSymbols)
    const after = moduleRemainder(headByPath.get(path), headSymbols)
    if (before !== undefined && after !== undefined && before !== after) {
      changes.push({
        symbolId: fileSymbolId(path),
        changeType: 'module',
        base: baseSymbols.find((symbol) => symbol.id === fileSymbolId(path)),
        head: headSymbols.find((symbol) => symbol.id === fileSymbolId(path)),
      })
    }
  }

  return changes.sort((a, b) => a.symbolId.localeCompare(b.symbolId))
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

interface ScoreFeatures {
  distance: number
  resolved: boolean
  isTest: boolean
  fanIn: number
  exported: boolean
}

export function scoreFor({ distance, resolved, isTest, fanIn, exported }: ScoreFeatures) {
  const w = RANKING_WEIGHTS
  const proximity = 1 / Math.max(1, distance)
  const directChangeLink = distance === 1 ? 1 : 0
  const resolution = resolved ? 1 : 0.5
  const testLink = isTest ? (distance === 1 ? 1 : 0.45) : 0
  const fanInScore = Math.min(1, fanIn / FAN_IN_SATURATION)
  const exportedApi = !isTest && exported ? 1 : 0
  return Math.round(100 * (
    w.proximity * proximity + w.directChangeLink * directChangeLink + w.resolution * resolution
    + w.testLink * testLink + w.fanIn * fanInScore + w.exportedApi * exportedApi
  ))
}

function reasonsFor(distance: number, changedName: string, isTest: boolean, resolved: boolean, fanIn: number) {
  const reasons = distance === 1
    ? [`Directly calls changed symbol ${changedName}.`]
    : [`Connected to ${changedName} through ${distance} dependency edges.`]
  if (isTest && distance === 1) reasons.push('Directly references the changed implementation.')
  if (fanIn > 1) reasons.push(`Reachable from ${fanIn} changed symbols.`)
  if (!resolved) reasons.push('At least one edge on this path is inferred from a method name, not confirmed by an import.')
  if (isTest && distance > 1) reasons.push('Transitive caller path is statically resolved; relevance is heuristic, not a failure probability.')
  return reasons
}

function reverseAdjacency(edges: EdgeRecord[]) {
  const reverse = new Map<string, EdgeRecord[]>()
  edges.filter((edge) => edge.type === 'calls').forEach((edge) => {
    const list = reverse.get(edge.target) ?? []
    list.push(edge)
    reverse.set(edge.target, list)
  })
  // Prefer confirmed edges when two paths have equal length, then sort for reproducibility.
  reverse.forEach((list) => list.sort((a, b) => (
    Number(a.resolutionStatus !== 'resolved') - Number(b.resolutionStatus !== 'resolved') || a.id.localeCompare(b.id)
  )))
  return reverse
}

function fanInCounts(seeds: string[], reverse: Map<string, EdgeRecord[]>, maxDepth: number) {
  const counts = new Map<string, number>()
  if (seeds.length > FAN_IN_SEED_LIMIT) return counts
  for (const seed of seeds) {
    const depth = new Map([[seed, 0]])
    const queue = [seed]
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]
      if (depth.get(current)! >= maxDepth) continue
      for (const edge of reverse.get(current) ?? []) {
        if (depth.has(edge.source)) continue
        depth.set(edge.source, depth.get(current)! + 1)
        queue.push(edge.source)
      }
    }
    depth.forEach((_, id) => { if (id !== seed) counts.set(id, (counts.get(id) ?? 0) + 1) })
  }
  return counts
}

export async function analyzeRepository(repository: DemoRepository, options: AnalyzeOptions): Promise<AnalysisResult> {
  const started = performance.now()
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  await options.onStage?.('fetching')
  await options.onStage?.('parsing-base')
  const base = await parseRevision(repository.base, options)
  await options.onStage?.('parsing-head')
  const head = await parseRevision(repository.head, options)

  await options.onStage?.('graphing')
  const changes = detectChanges(head.symbols, base.symbols, repository.base.files, repository.head.files)
  const headSymbolIds = new Set(head.symbols.map((symbol) => symbol.id))
  const goneIds = new Set(changes.flatMap((change) => (
    change.changeType === 'deleted' ? [change.symbolId] : change.changeType === 'renamed' && change.previousId ? [change.previousId] : []
  )))
  const symbols = [...head.symbols, ...base.symbols.filter((symbol) => !headSymbolIds.has(symbol.id))]
  // Callers that still exist but pointed at a removed or renamed symbol only have base-revision evidence.
  const baseDeletionEdges = base.edges
    .filter((edge) => edge.type === 'calls' && goneIds.has(edge.target) && headSymbolIds.has(edge.source))
    .map((edge) => ({ ...edge, evidenceRevision: 'base' as const }))
  const edges = [...head.edges.map((edge) => ({ ...edge, evidenceRevision: 'head' as const })), ...baseDeletionEdges]
  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]))
  const edgesById = new Map(edges.map((edge) => [edge.id, edge]))
  const seeds = [...new Set(changes.flatMap((change) => [change.symbolId, ...(change.previousId ? [change.previousId] : [])]))].sort()
  const changedIds = new Set(seeds)

  const reverseCalls = reverseAdjacency(edges)
  const distance = new Map<string, number>()
  const previous = new Map<string, { from: string; edge: EdgeRecord } | null>()
  const queue: string[] = []
  seeds.forEach((id) => {
    distance.set(id, 0)
    previous.set(id, null)
    queue.push(id)
  })

  let depthLimited = false
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    const currentDistance = distance.get(current) ?? 0
    for (const edge of reverseCalls.get(current) ?? []) {
      if (distance.has(edge.source)) continue
      if (currentDistance >= maxDepth) {
        depthLimited = true
        continue
      }
      distance.set(edge.source, currentDistance + 1)
      previous.set(edge.source, { from: current, edge })
      queue.push(edge.source)
    }
  }
  const fanIn = fanInCounts(seeds, reverseCalls, maxDepth)

  await options.onStage?.('ranking')
  const findings: ImpactFinding[] = []
  const tests: TestRecommendation[] = []

  changes.forEach((change) => {
    if (change.head?.kind !== 'test' || change.changeType === 'deleted') return
    tests.push({
      test: change.head,
      score: CHANGED_TEST_SCORE,
      rank: 0,
      path: { nodeIds: [change.symbolId], edgeIds: [] },
      reasons: [`This test was ${change.changeType === 'added' ? 'added' : 'changed'} in the pull request.`],
      limitation: 'Recommended only — this test was not executed by CodeImpact.',
      connection: 'changed',
    })
  })

  distance.forEach((dist, id) => {
    if (dist === 0) return
    const symbol = symbolsById.get(id)
    if (!symbol || !headSymbolIds.has(id) || symbol.kind === 'file') return
    const path = pathFromPredecessors(id, previous)
    const changed = symbolsById.get(path.nodeIds[0])
    const changedName = changed?.name ?? 'changed code'
    const pathEdges = path.edgeIds.map((edgeId) => edgesById.get(edgeId)!).filter(Boolean)
    const resolved = pathEdges.every((edge) => edge.resolutionStatus === 'resolved')
    const isTest = symbol.kind === 'test'
    const reach = Math.max(1, fanIn.get(id) ?? 1)
    const score = scoreFor({ distance: dist, resolved, isTest, fanIn: reach, exported: symbol.exported })
    const reasons = reasonsFor(dist, changedName, isTest, resolved, reach)

    if (isTest) {
      tests.push({
        test: symbol,
        score,
        rank: 0,
        path,
        reasons,
        limitation: 'Recommended only — this test was not executed by CodeImpact.',
        connection: 'call-path',
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

  // Weaker evidence: a test file imports a changed module but no call path was resolved.
  const recommended = new Set(tests.map((test) => test.test.id))
  const changedPaths = new Set(changes.map((change) => (change.head ?? change.base)!.path))
  const importEdgesByFile = new Map<string, EdgeRecord[]>()
  edges.filter((edge) => edge.type === 'imports' && edge.evidenceRevision === 'head').forEach((edge) => {
    importEdgesByFile.set(edge.source, [...(importEdgesByFile.get(edge.source) ?? []), edge])
  })
  head.symbols.filter((symbol) => symbol.kind === 'test' && !recommended.has(symbol.id)).forEach((test) => {
    const importEdge = (importEdgesByFile.get(fileSymbolId(test.path)) ?? [])
      .find((edge) => changedPaths.has(symbolsById.get(edge.target)?.path ?? ''))
    if (!importEdge) return
    const changedFile = symbolsById.get(importEdge.target)!
    tests.push({
      test,
      score: FILE_IMPORT_TEST_SCORE,
      rank: 0,
      path: { nodeIds: [importEdge.target, importEdge.source], edgeIds: [importEdge.id] },
      reasons: [
        `Test file imports changed module ${changedFile.path}.`,
        'No call path from this test to a changed symbol was resolved; this is file-level evidence only.',
      ],
      limitation: 'Recommended only — this test was not executed by CodeImpact. Weak evidence: file import without a resolved call.',
      connection: 'file-import',
    })
  })

  findings.sort((a, b) => b.score - a.score || a.distance - b.distance || a.symbol.id.localeCompare(b.symbol.id))
  findings.forEach((finding, index) => { finding.rank = index + 1 })
  tests.sort((a, b) => b.score - a.score || a.test.id.localeCompare(b.test.id))
  tests.forEach((test, index) => { test.rank = index + 1 })

  const graphSymbolIds = [...new Set([
    ...seeds.filter((id) => symbolsById.get(id)?.kind !== 'file'),
    ...findings.map((f) => f.symbol.id),
    ...tests.filter((t) => t.connection !== 'file-import').map((t) => t.test.id),
  ])].filter((id) => symbolsById.has(id))
  const baseFiles = new Map(repository.base.files.map((file) => [file.path, file]))
  const headFiles = new Map(repository.head.files.map((file) => [file.path, file]))
  const changedFiles = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].filter((path) => {
    const before = baseFiles.get(path)
    const after = headFiles.get(path)
    return !before || !after || normalized(before.source) !== normalized(after.source)
  }).length
  const callEdges = head.edges.filter((edge) => edge.type === 'calls')

  await options.onStage?.('completed')
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
      totalTests: head.symbols.filter((symbol) => symbol.kind === 'test').length,
      callEdges: callEdges.length,
      inferredCallEdges: callEdges.filter((edge) => edge.resolutionStatus === 'inferred').length,
    },
    settings: {
      maxDepth,
      depthLimited,
      algorithmVersion: ALGORITHM_VERSION,
      parserVersion: PARSER_VERSION,
    },
    limitations: [
      'Static analysis can miss reflection, dynamic dispatch, and runtime-only relationships.',
      'Scores are transparent ranking heuristics, not calibrated probabilities of failure.',
      'Tests are recommended, not executed. No claim is made that this subset is sufficient.',
      `Traversal stops after ${maxDepth} caller edges${depthLimited ? ' — the limit was reached, so deeper callers are omitted' : ''}.`,
      'pytest fixtures, test parametrization, and inherited methods are not linked to tests yet.',
      ...changedIds.size === 0 ? ['No changed symbols were found in supported Python or TypeScript files.'] : [],
      ...(options.limitations ?? []),
    ],
  }
}
