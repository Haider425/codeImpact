import type { AnalysisResult, EdgeRecord, EvidencePath } from '../src/analysis/types'

export const TEMPLATE_VERSION = 'template/1'

const LIMITS = { changes: 30, findings: 25, tests: 25, unresolved: 15, label: 160 }

/** A bounded, reference-addressable view of the analysis. It never includes source code. */
export interface EvidenceBundle {
  repository: string
  pullRequest: { number: number; title: string }
  changes: { ref: string; symbol: string; kind: string; changeType: string; location: string }[]
  findings: { ref: string; symbol: string; impact: string; distance: number; score: number; location: string; path: string[]; evidence: string[] }[]
  tests: { ref: string; test: string; connection: string; score: number; location: string; path: string[]; evidence: string[] }[]
  edges: { ref: string; type: string; resolution: string; from: string; to: string; location: string; revision: string }[]
  unresolved: { ref: string; expression: string; location: string; reason: string }[]
  omitted: { changes: number; findings: number; tests: number; unresolved: number }
  limitations: string[]
  stats: AnalysisResult['stats']
}

const clip = (value: string) => (value.length > LIMITS.label ? `${value.slice(0, LIMITS.label)}…` : value)

export function buildEvidenceBundle(result: AnalysisResult, meta: { repository: string; number: number; title: string }): EvidenceBundle {
  const symbols = new Map(result.symbols.map((symbol) => [symbol.id, symbol]))
  const edges = new Map(result.edges.map((edge) => [edge.id, edge]))
  const edgeRefs = new Map<string, string>()
  const bundleEdges: EvidenceBundle['edges'] = []
  const name = (id: string) => clip(symbols.get(id)?.qualifiedName ?? id)

  const refEdge = (edge: EdgeRecord) => {
    if (!edgeRefs.has(edge.id)) {
      const ref = `E${edgeRefs.size + 1}`
      edgeRefs.set(edge.id, ref)
      bundleEdges.push({
        ref,
        type: edge.type,
        resolution: edge.resolutionStatus,
        from: name(edge.source),
        to: name(edge.target),
        location: `${edge.evidencePath}:${edge.evidenceLine}`,
        revision: edge.evidenceRevision ?? 'head',
      })
    }
    return edgeRefs.get(edge.id)!
  }
  const pathEvidence = (path: EvidencePath) => path.edgeIds.map((id) => edges.get(id)).filter((edge): edge is EdgeRecord => Boolean(edge)).map(refEdge)

  return {
    repository: meta.repository,
    pullRequest: { number: meta.number, title: clip(meta.title) },
    changes: result.changes.slice(0, LIMITS.changes).map((change, index) => {
      const symbol = (change.head ?? change.base)!
      return { ref: `C${index + 1}`, symbol: clip(symbol.qualifiedName), kind: symbol.kind, changeType: change.changeType, location: `${symbol.path}:${symbol.startLine}` }
    }),
    findings: result.findings.slice(0, LIMITS.findings).map((finding, index) => ({
      ref: `F${index + 1}`,
      symbol: clip(finding.symbol.qualifiedName),
      impact: finding.impactType,
      distance: finding.distance,
      score: finding.score,
      location: `${finding.symbol.path}:${finding.symbol.startLine}`,
      path: finding.path.nodeIds.map(name),
      evidence: pathEvidence(finding.path),
    })),
    tests: result.tests.slice(0, LIMITS.tests).map((test, index) => ({
      ref: `T${index + 1}`,
      test: clip(test.test.qualifiedName),
      connection: test.connection,
      score: test.score,
      location: `${test.test.path}:${test.test.startLine}`,
      path: test.path.nodeIds.map(name),
      evidence: pathEvidence(test.path),
    })),
    edges: bundleEdges,
    unresolved: result.unresolved.slice(0, LIMITS.unresolved).map((item, index) => ({
      ref: `U${index + 1}`, expression: clip(item.expression), location: `${item.path}:${item.line}`, reason: item.reason,
    })),
    omitted: {
      changes: Math.max(0, result.changes.length - LIMITS.changes),
      findings: Math.max(0, result.findings.length - LIMITS.findings),
      tests: Math.max(0, result.tests.length - LIMITS.tests),
      unresolved: Math.max(0, result.unresolved.length - LIMITS.unresolved),
    },
    limitations: result.limitations,
    stats: result.stats,
  }
}

export interface ExplanationItem { ref: string; explanation: string; evidence?: string[] }

export interface Explanation {
  summary: string
  changed: ExplanationItem[]
  affected: ExplanationItem[]
  tests: ExplanationItem[]
  uncertainty: { explanation: string; refs: string[] }[]
}

export interface GeneratedExplanation {
  explanation: Explanation
  status: 'template'
  issues: string[]
  modelIdentifier: 'deterministic-template'
  promptVersion: string
  latencyMs: number
}

function templateSummary(bundle: EvidenceBundle) {
  const { stats } = bundle
  const changed = bundle.changes.slice(0, 3).map((c) => `\`${c.symbol}\``).join(', ')
  const direct = bundle.findings.filter((f) => f.impact === 'direct').length
  return [
    `${stats.changedSymbols} changed symbol${stats.changedSymbols === 1 ? '' : 's'}${changed ? ` (${changed}${bundle.changes.length > 3 ? ', …' : ''})` : ''} reach ${stats.impactedSymbols} other symbol${stats.impactedSymbols === 1 ? '' : 's'} through static caller paths, ${direct} of them directly.`,
    `${stats.recommendedTests} test${stats.recommendedTests === 1 ? ' is' : 's are'} recommended for attention; none were executed.`,
    stats.unresolved > 0 ? `${stats.unresolved} call or import relationships could not be resolved and may hide additional impact.` : '',
  ].filter(Boolean).join(' ')
}

/** Deterministic explanation built directly from the bundle. Used when no model is configured or a model response is unusable. */
export function templateExplanation(bundle: EvidenceBundle): Explanation {
  const verb: Record<string, string> = {
    added: 'was added', modified: 'has a modified body', deleted: 'was deleted', signature: 'has a changed signature',
    renamed: 'was renamed', module: 'has module-level edits outside any declaration',
  }
  return {
    summary: templateSummary(bundle),
    changed: bundle.changes.map((c) => ({ ref: c.ref, explanation: `${c.symbol} ${verb[c.changeType] ?? 'changed'} (${c.location}).` })),
    affected: bundle.findings.slice(0, 10).map((f) => ({
      ref: f.ref,
      explanation: f.distance === 1 ? `${f.symbol} calls ${f.path[0]} directly.` : `${f.symbol} reaches ${f.path[0]} via ${f.path.slice(1, -1).join(' → ')}.`,
      evidence: f.evidence,
    })),
    tests: bundle.tests.slice(0, 10).map((t) => ({
      ref: t.ref,
      explanation: t.connection === 'changed'
        ? `${t.test} itself changed in this pull request.`
        : t.connection === 'file-import'
          ? `${t.test} lives in a file that imports ${t.path[0]}; no call path was resolved.`
          : `${t.test} reaches ${t.path[0]} in ${t.evidence.length} call edge${t.evidence.length === 1 ? '' : 's'}.`,
      evidence: t.evidence,
    })),
    uncertainty: [
      ...bundle.edges.some((e) => e.resolution === 'inferred')
        ? [{ explanation: 'Some edges are inferred from method names because the receiver type is unknown.', refs: bundle.edges.filter((e) => e.resolution === 'inferred').slice(0, 5).map((e) => e.ref) }]
        : [],
      ...bundle.unresolved.length
        ? [{ explanation: 'Unresolved relationships may hide further callers or tests.', refs: bundle.unresolved.slice(0, 5).map((u) => u.ref) }]
        : [],
    ],
  }
}

/** Explanations are generated deterministically from the evidence bundle. No model is called. */
export function explainAnalysis(bundle: EvidenceBundle): GeneratedExplanation {
  const started = performance.now()
  return {
    explanation: templateExplanation(bundle),
    status: 'template',
    issues: [],
    modelIdentifier: 'deterministic-template',
    promptVersion: TEMPLATE_VERSION,
    latencyMs: Math.round(performance.now() - started),
  }
}
