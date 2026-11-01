import { AlertTriangle, FileText } from 'lucide-react'
import type { AnalysisResult } from '@/analysis/types'
import type { StoredExplanation } from '@/lib/api'

interface ExplanationPanelProps {
  explanation: StoredExplanation
  result: AnalysisResult
  onSelect: (symbolId: string) => void
  onOpenSource: (path: string, line: number, revision?: 'base' | 'head') => void
}

/** Bundle refs are positional: C1 is the first change, F1 the top-ranked finding, T1 the top-ranked test. */
function symbolForRef(ref: string, result: AnalysisResult) {
  const index = Number(ref.slice(1)) - 1
  if (ref.startsWith('C')) return result.changes[index]?.symbolId
  if (ref.startsWith('F')) return result.findings[index]?.symbol.id
  if (ref.startsWith('T')) return result.tests[index]?.test.id
  return undefined
}

export function ExplanationPanel({ explanation, result, onSelect, onOpenSource }: ExplanationPanelProps) {
  const { summary, affected, tests, uncertainty, bundle } = explanation.explanation
  const locations = new Map([...(bundle?.edges ?? []), ...(bundle?.unresolved ?? [])].map((item) => [item.ref, item]))

  const refButton = (refId: string) => {
    const symbolId = symbolForRef(refId, result)
    const location = locations.get(refId)
    if (symbolId) return <button key={refId} type="button" className="ref-chip" onClick={() => onSelect(symbolId)}>{refId}</button>
    if (location) {
      const [path, line] = [location.location.slice(0, location.location.lastIndexOf(':')), Number(location.location.split(':').pop())]
      const revision = 'revision' in location && location.revision === 'base' ? 'base' : 'head'
      return <button key={refId} type="button" className="ref-chip" title={location.location} onClick={() => onOpenSource(path, line, revision)}>{refId}</button>
    }
    return <span key={refId} className="ref-chip ref-chip--muted">{refId}</span>
  }

  const items = [...affected.slice(0, 5).map((item) => ({ ...item, kind: 'affected' })), ...tests.slice(0, 5).map((item) => ({ ...item, kind: 'test' }))]

  return (
    <section className="explanation-block" aria-label="Impact explanation">
      <div className="explanation-heading">
        <span className="section-label">02 / EXPLANATION</span>
        <span className="validation-badge"><FileText size={13} />deterministic</span>
      </div>
      <p className="explanation-summary">{summary.split('`').map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part))}</p>
      {items.length > 0 && (
        <ul className="explanation-items">
          {items.map((item) => (
            <li key={`${item.kind}-${item.ref}`}>
              {refButton(item.ref)}
              <span>{item.explanation}</span>
              {item.evidence && item.evidence.length > 0 && <span className="evidence-refs">{item.evidence.map(refButton)}</span>}
            </li>
          ))}
        </ul>
      )}
      {uncertainty.length > 0 && (
        <div className="explanation-uncertainty">
          {uncertainty.map((note) => (
            <p key={note.explanation}><AlertTriangle size={13} />{note.explanation} {note.refs.map(refButton)}</p>
          ))}
        </div>
      )}
      <footer className="explanation-footer">
        <FileText size={13} />
        <span>Generated from the analysis results by a fixed template ({explanation.promptVersion}); no language model is involved.</span>
      </footer>
    </section>
  )
}
