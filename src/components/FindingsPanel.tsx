import { AlertTriangle, ArrowRight, FileCode2, FlaskConical, ScanSearch, ShieldCheck, SpellCheck } from 'lucide-react'
import type { FindingGroup } from '@/analysis/merge'
import type { ReviewLocation, Severity } from '@/analysis/types'
import { RULE_TITLES, SOURCE_LABELS } from '@/lib/findings'

interface FindingsPanelProps {
  groups: FindingGroup[]
  onOpenSource: (path: string, line: number, revision?: 'base' | 'head') => void
  onSelect: (symbolId: string) => void
}

const SEVERITIES: { severity: Severity; label: string }[] = [
  { severity: 'high', label: 'High' },
  { severity: 'medium', label: 'Medium' },
  { severity: 'low', label: 'Low' },
]

const SOURCE_ICONS = { rule: ScanSearch, typecheck: SpellCheck, 'test-run': FlaskConical }

/** Backtick spans in finding messages render as code. Messages are plain text, never HTML. */
function Message({ text }: { text: string }) {
  return <>{text.split('`').map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part))}</>
}

function LocationButton({ location, label, onOpenSource }: { location: ReviewLocation; label: string; onOpenSource: FindingsPanelProps['onOpenSource'] }) {
  return (
    <button type="button" className="finding-location" onClick={() => onOpenSource(location.path, location.line, location.revision)}>
      <span>{label}</span>
      <FileCode2 size={13} />
      {location.path}:{location.line}{location.revision === 'base' ? ' (base)' : ''}
    </button>
  )
}

function FindingCard({ group, onOpenSource, onSelect }: { group: FindingGroup } & Omit<FindingsPanelProps, 'groups'>) {
  const lead = group.findings[0]
  return (
    <article className={`finding-card finding-card--${group.severity}`}>
      <header>
        <h3>{RULE_TITLES[lead.ruleId] ?? lead.ruleId}</h3>
        {group.affected.symbol && (
          group.affected.symbolId
            ? <button type="button" className="finding-symbol" onClick={() => onSelect(group.affected.symbolId!)}>{group.affected.symbol}<ArrowRight size={12} /></button>
            : <code className="finding-symbol">{group.affected.symbol}</code>
        )}
        <span className="finding-sources" aria-label="Evidence sources">
          {group.sources.map((source) => {
            const Icon = SOURCE_ICONS[source]
            return <span key={source} className={`source-badge source-badge--${source}`}><Icon size={12} />{SOURCE_LABELS[source]}</span>
          })}
        </span>
      </header>
      <div className="finding-locations">
        <LocationButton location={group.affected} label="Affected" onOpenSource={onOpenSource} />
        {group.changed.map((location) => (
          <LocationButton key={`${location.revision}:${location.path}:${location.line}`} location={location} label="Changed" onOpenSource={onOpenSource} />
        ))}
      </div>
      <ul className="finding-evidence">
        {group.findings.map((finding) => (
          <li key={finding.id}>
            <span className={`source-badge source-badge--${finding.source}`}>{SOURCE_LABELS[finding.source]}</span>
            <code className="finding-rule">{finding.ruleId}</code>
            {finding.confidence === 'inferred' && <span className="finding-inferred">inferred link</span>}
            <p><Message text={finding.message} /></p>
            {finding.source === 'test-run' && <LocationButton location={finding.affected} label="Test" onOpenSource={onOpenSource} />}
            {finding.details && finding.details.callers.length > 1 && (
              <ul className="finding-callers">
                {finding.details.callers.map((caller) => (
                  <li key={caller.edgeId}>
                    <button type="button" onClick={() => onOpenSource(caller.location.path, caller.location.line, caller.location.revision)}>
                      {caller.location.symbol ?? `${caller.location.path}:${caller.location.line}`}
                    </button>
                    <span className={caller.affected ? 'caller-affected' : 'caller-unaffected'}>{caller.affected ? caller.reasons.join('; ') || 'affected' : 'not affected'}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </article>
  )
}

export function FindingsPanel({ groups, onOpenSource, onSelect }: FindingsPanelProps) {
  const evidenceCount = groups.reduce((sum, group) => sum + group.findings.length, 0)
  return (
    <section className="findings-block" aria-label="Review findings">
      <div className="findings-heading">
        <div>
          <span className="section-label">02 / REVIEW FINDINGS</span>
          <h2>{groups.length === 0 ? 'No findings' : `${groups.length} finding${groups.length === 1 ? '' : 's'}`}</h2>
        </div>
        {evidenceCount > groups.length && <p>{evidenceCount} pieces of evidence merged by affected location</p>}
      </div>
      {groups.length === 0 && (
        <p className="empty-note"><ShieldCheck size={13} /> No rule, type-checker, or test evidence points at code outside this change. Static analysis can still miss dynamic calls.</p>
      )}
      {SEVERITIES.map(({ severity, label }) => {
        const items = groups.filter((group) => group.severity === severity)
        if (items.length === 0) return null
        const cards = items.map((group) => <FindingCard key={group.id} group={group} onOpenSource={onOpenSource} onSelect={onSelect} />)
        return severity === 'low'
          ? (
            <details key={severity} className={`finding-severity finding-severity--${severity}`}>
              <summary><AlertTriangle size={14} />{label} <small>{items.length}</small></summary>
              {cards}
            </details>
          )
          : (
            <div key={severity} className={`finding-severity finding-severity--${severity}`}>
              <h3 className="finding-severity-heading"><AlertTriangle size={14} />{label} <small>{items.length}</small></h3>
              {cards}
            </div>
          )
      })}
    </section>
  )
}
