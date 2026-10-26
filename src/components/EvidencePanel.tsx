import { ArrowDown, ArrowUpRight, FileCode2, ShieldCheck } from 'lucide-react'
import type { AnalysisResult } from '@/analysis/types'

interface EvidencePanelProps {
  result: AnalysisResult
  selectedId: string | null
  onSelect: (id: string) => void
  onOpenSource: (path: string, line: number, revision?: 'base' | 'head') => void
}

export function EvidencePanel({ result, selectedId, onSelect, onOpenSource }: EvidencePanelProps) {
  const symbol = result.symbols.find((candidate) => candidate.id === selectedId)
  const finding = result.findings.find((candidate) => candidate.symbol.id === selectedId)
  const test = result.tests.find((candidate) => candidate.test.id === selectedId)
  const change = result.changes.find((candidate) => candidate.symbolId === selectedId)
  const item = finding ?? test
  const path = item?.path

  if (!symbol) {
    return (
      <aside className="evidence-panel evidence-panel--empty">
        <ShieldCheck size={22} />
        <strong>Select a graph node</strong>
        <p>Inspect the ranking, dependency path, and source evidence behind every result.</p>
      </aside>
    )
  }

  return (
    <aside className="evidence-panel" aria-label={`Evidence for ${symbol.name}`}>
      <div className="evidence-heading">
        <span className="section-label">EVIDENCE INSPECTOR</span>
        <div className="evidence-title-row">
          <span className={`symbol-kind symbol-kind--${symbol.kind}`}>{symbol.kind}</span>
          {change && <span className="change-badge">{change.changeType}</span>}
          {test && <span className="not-executed">not executed</span>}
        </div>
        <h2>{symbol.name}</h2>
        <button type="button" className="source-path-link" onClick={() => onOpenSource(symbol.path, symbol.startLine)}>
          <FileCode2 size={14} />{symbol.path}:{symbol.startLine}<ArrowUpRight size={13} />
        </button>
      </div>

      {item && (
        <div className="score-block">
          <div>
            <strong>{item.score}</strong><span>/100</span>
          </div>
          <p>Rank #{item.rank} · heuristic score<br />Not a failure probability</p>
        </div>
      )}

      {change && (
        <div className="evidence-section">
          <h3>What changed</h3>
          <p>The normalized source for this {change.changeType === 'signature' ? 'signature' : 'symbol'} differs between the base and head revisions.</p>
          <div className="revision-actions">
            <button type="button" onClick={() => onOpenSource(symbol.path, change.base?.startLine ?? 1, 'base')}>Base {change.base ? `L${change.base.startLine}` : ''}</button>
            <button type="button" onClick={() => onOpenSource(symbol.path, change.head?.startLine ?? 1, 'head')}>Head {change.head ? `L${change.head.startLine}` : ''}</button>
          </div>
        </div>
      )}

      {item && (
        <div className="evidence-section">
          <h3>Why it appears</h3>
          <ul className="reason-list">
            {item.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
      )}

      {path && (
        <div className="evidence-section evidence-path">
          <h3>Dependency path <span>{path.edgeIds.length} edges</span></h3>
          {path.nodeIds.map((id, index) => {
            const pathSymbol = result.symbols.find((candidate) => candidate.id === id)
            const edge = index < path.edgeIds.length ? result.edges.find((candidate) => candidate.id === path.edgeIds[index]) : undefined
            return (
              <div key={id} className="path-step">
                <button type="button" className={id === selectedId ? 'path-node active' : 'path-node'} onClick={() => onSelect(id)}>
                  <span>{pathSymbol?.name}</span>
                  <small>{pathSymbol?.kind}</small>
                </button>
                {edge && (
                  <button type="button" className="path-edge" onClick={() => onOpenSource(edge.evidencePath, edge.evidenceLine, edge.evidenceRevision ?? 'head')}>
                    <ArrowDown size={13} />
                    <span>{edge.type} · {edge.evidencePath}:{edge.evidenceLine}</span>
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <details className="evidence-accordion">
        <summary>Extraction & resolution</summary>
        <dl>
          <div><dt>Parser</dt><dd>Tree-sitter / {symbol.language}</dd></div>
          <div><dt>Status</dt><dd>{symbol.resolutionStatus}</dd></div>
          <div><dt>Symbol lines</dt><dd>{symbol.startLine}–{symbol.endLine}</dd></div>
          <div><dt>Exported</dt><dd>{symbol.exported ? 'yes' : 'no'}</dd></div>
        </dl>
      </details>
      <details className="evidence-accordion">
        <summary>Recommendation limits</summary>
        <p>{test ? test.limitation : 'Potential impact is derived from static caller paths. Runtime behavior may add or remove relationships.'}</p>
      </details>
    </aside>
  )
}
