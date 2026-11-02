import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Code2,
  Download,
  FileCode2,
  Files,
  FlaskConical,
  GitBranch,
  GitPullRequest,
  Info,
  Network,
  Search,
  ShieldCheck,
} from 'lucide-react'
import type { SelectionStrategy } from '@/analysis/baselines'
import { RANKING_WEIGHTS } from '@/analysis/engine'
import { groupFindings } from '@/analysis/merge'
import type { AnalysisResult, DemoRepository } from '@/analysis/types'
import { BaselineTable } from '@/components/BaselineTable'
import { EvidencePanel } from '@/components/EvidencePanel'
import { ExplanationPanel } from '@/components/ExplanationPanel'
import { FindingsPanel } from '@/components/FindingsPanel'
import { ImpactGraph } from '@/components/ImpactGraph'
import { SourceDialog } from '@/components/SourceDialog'
import type { SourceSelection } from '@/components/SourceDialog'
import { TestTable } from '@/components/TestTable'
import type { StoredExplanation } from '@/lib/api'

type View = 'report' | 'map' | 'tests' | 'files' | 'limits'

export interface ReportViewProps {
  repository: DemoRepository
  result: AnalysisResult
  mode: 'demo' | 'github' | 'local'
  explanation?: StoredExplanation | null
  selection?: Record<SelectionStrategy, number>
  changedFiles?: { path: string; status: string }[]
  actions?: ReactNode
  /** Extra provenance shown under the completion time, e.g. run id and merge base. */
  provenance?: ReactNode
}

const MODE_LABELS = { demo: 'Bundled demo · runs in your browser', github: 'GitHub pull request', local: 'Local git checkout' }

export function ReportView({ repository, result, mode, explanation, selection, changedFiles, actions, provenance }: ReportViewProps) {
  const [view, setView] = useState<View>('report')
  const [selectedId, setSelectedId] = useState<string | null>(() => result.changes.find((change) => change.head)?.symbolId ?? result.findings[0]?.symbol.id ?? null)
  const [source, setSource] = useState<SourceSelection | null>(null)
  const [fileQuery, setFileQuery] = useState('')

  const openSource = useCallback((path: string, line: number, revision: 'base' | 'head' = 'head') => {
    setSource({ path, line, revision })
  }, [])

  const inspectTest = useCallback((id: string) => {
    setSelectedId(id)
    setView((current) => current === 'report' ? 'map' : current)
  }, [])

  const exportReport = () => {
    const payload = {
      product: 'CodeImpact',
      repository: `${repository.owner}/${repository.name}`,
      pullRequest: repository.pullRequest,
      baseSha: repository.base.sha,
      headSha: repository.head.sha,
      generatedBy: 'deterministic-engine',
      explanation: explanation ?? undefined,
      ...result,
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `codeimpact-${repository.name}-${repository.pullRequest.number || repository.head.sha.slice(0, 7)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  // Stored reports from before the review rules existed have no `review` field.
  const findingGroups = useMemo(() => groupFindings(result.review ?? [], result.edges), [result])
  const changedPaths = useMemo(() => new Set(changedFiles?.map((file) => file.path)
    ?? repository.head.files.filter((file) => repository.base.files.find((candidate) => candidate.path === file.path)?.source !== file.source).map((file) => file.path)), [changedFiles, repository])
  const filteredFiles = useMemo(() => repository.head.files.filter((file) => file.path.toLowerCase().includes(fileQuery.toLowerCase())), [fileQuery, repository])
  const changedNames = result.changes
    .slice(0, 4)
    .map((change) => change.head?.name ?? change.base?.name)
    .filter((name): name is string => Boolean(name))
    .join(', ')
  const short = (sha: string) => sha.slice(0, 7)

  const navItems: { id: View; label: string; icon: typeof Code2; count?: number }[] = [
    { id: 'report', label: 'Impact report', icon: Code2, count: findingGroups.length || undefined },
    { id: 'map', label: 'Dependency map', icon: Network, count: result.graphSymbolIds.length },
    { id: 'tests', label: 'Recommended tests', icon: FlaskConical, count: result.stats.recommendedTests },
    { id: 'files', label: mode === 'demo' ? 'Source files' : 'Evidence files', icon: Files, count: repository.head.files.length },
    { id: 'limits', label: 'Method & limits', icon: Info, count: result.stats.unresolved },
  ]
  const weights = Object.entries(RANKING_WEIGHTS).map(([name, weight]) => `${Math.round(weight * 100)}% ${name.replace(/([A-Z])/g, ' $1').toLowerCase()}`).join(' + ')

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/" aria-label="CodeImpact dashboard">
          <svg viewBox="0 0 30 30" aria-hidden="true"><path d="M5 8h7v7H5zM18 15h7v7h-7zM12 11.5h6M8.5 15v5.5H18" /></svg>
          <span>CodeImpact</span>
          <small>{mode === 'demo' ? 'DEMO' : 'REPORT'}</small>
        </Link>
        <div className="repository-crumb">
          <span>{repository.owner}</span><b>/</b><strong>{repository.name}</strong><GitBranch size={13} /><span>{repository.pullRequest.headRef}</span>
        </div>
        <div className="topbar-actions">
          <span className="local-badge"><i />{mode === 'demo' ? 'Local engine' : 'Server analysis'}</span>
          <button type="button" className="button button--secondary export-button" onClick={exportReport}><Download size={15} />Export</button>
          {actions}
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="pr-card">
            <span className="section-label">{repository.pullRequest.number ? 'PULL REQUEST' : 'COMMIT RANGE'}</span>
            <div><GitPullRequest size={16} /><strong>{repository.pullRequest.number ? `#${repository.pullRequest.number}` : short(repository.head.sha)}</strong><span className="pr-open">{mode}</span></div>
            <h2>{repository.pullRequest.title || `${short(repository.base.sha)} → ${short(repository.head.sha)}`}</h2>
            <p>{repository.pullRequest.author ? `${repository.pullRequest.author} · ` : ''}{repository.pullRequest.baseRef} ← {repository.pullRequest.headRef}</p>
          </div>
          <nav className="main-nav" aria-label="Analysis sections">
            {navItems.map((item) => {
              const Icon = item.icon
              return (
                <button key={item.id} type="button" className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}>
                  <Icon size={16} /><span>{item.label}</span>{item.count !== undefined && <small>{item.count}</small>}
                </button>
              )
            })}
          </nav>
          <div className="engine-note">
            <span className="section-label">ANALYSIS BOUNDARY</span>
            <p><ShieldCheck size={15} />Source is parsed, never executed. {MODE_LABELS[mode]}.</p>
            <div><span>Parser</span><b>{result.settings.parserVersion}</b></div>
            <div><span>Algorithm</span><b>{result.settings.algorithmVersion}</b></div>
            <div><span>Depth limit</span><b>{result.settings.maxDepth}{result.settings.depthLimited ? ' (reached)' : ''}</b></div>
          </div>
        </aside>

        <main className="main-content" id="report">
          <div className="page-heading">
            <div>
              <span className="section-label">{repository.pullRequest.number ? `PR #${repository.pullRequest.number}` : 'RANGE'} / ANALYSIS RESULT</span>
              <h1>{view === 'report' ? 'Impact report' : view === 'map' ? 'Dependency map' : view === 'tests' ? 'Recommended tests' : view === 'files' ? (mode === 'demo' ? 'Source files' : 'Evidence files') : 'Method & limitations'}</h1>
            </div>
            <div className="run-meta">
              <span><Check size={13} />Analyzed in {result.stats.durationMs} ms</span>
              <code>{short(repository.base.sha)} → {short(repository.head.sha)}</code>
              {provenance}
            </div>
          </div>

          {view === 'report' && (
            <>
              <section className="summary-block">
                <div className="summary-copy">
                  <span className="summary-index">01 / CHANGE SUMMARY</span>
                  <h2>{result.stats.changedSymbols} code change{result.stats.changedSymbols === 1 ? '' : 's'} reach {result.stats.impactedSymbols} symbol{result.stats.impactedSymbols === 1 ? '' : 's'} and {result.stats.recommendedTests} test{result.stats.recommendedTests === 1 ? '' : 's'}.</h2>
                  <p>
                    {result.stats.changedSymbols === 0
                      ? 'No changed symbols were found in supported Python or TypeScript files. That is not evidence the change is safe.'
                      : <>Changes to <code>{changedNames}{result.changes.length > 4 ? ', …' : ''}</code> propagate through statically resolved caller paths. Start with direct callers, then inspect each recommended test’s evidence.</>}
                  </p>
                </div>
                <button type="button" className="summary-action" onClick={() => setView('tests')}>Review ranked tests <ArrowRight size={17} /></button>
              </section>

              <section className="metric-strip" aria-label="Analysis metrics">
                <div><span>Changed files</span><strong>{String(result.stats.changedFiles).padStart(2, '0')}</strong><small>of {result.stats.parsedFiles} parsed</small></div>
                <div><span>Potential impact</span><strong>{String(result.stats.impactedSymbols).padStart(2, '0')}</strong><small>{result.findings.filter((finding) => finding.impactType === 'direct').length} direct callers</small></div>
                <div><span>Test attention</span><strong>{String(result.stats.recommendedTests).padStart(2, '0')}</strong><small>of {result.stats.totalTests} · not run</small></div>
                <div><span>Unresolved</span><strong>{String(result.stats.unresolved).padStart(2, '0')}</strong><small>{result.stats.inferredCallEdges} inferred edges</small></div>
              </section>

              <FindingsPanel groups={findingGroups} onOpenSource={openSource} onSelect={setSelectedId} />

              {explanation && <ExplanationPanel explanation={explanation} result={result} onSelect={setSelectedId} onOpenSource={openSource} />}

              <div className="report-grid">
                <ImpactGraph result={result} selectedId={selectedId} onSelect={setSelectedId} />
                <EvidencePanel result={result} selectedId={selectedId} onSelect={setSelectedId} onOpenSource={openSource} />
              </div>

              <section className="tests-section">
                <div className="section-heading"><div><span className="section-label">RANKED BY DEPENDENCY PROXIMITY</span><h2>Tests that deserve attention</h2></div><button type="button" onClick={() => setView('tests')}>View all evidence <ArrowRight size={14} /></button></div>
                {result.tests.length > 0
                  ? <TestTable tests={result.tests.slice(0, 5)} onInspect={inspectTest} onOpenSource={openSource} />
                  : <p className="empty-note">No test is connected to the changed code by a resolved call or import. Check the unresolved relationships before relying on this.</p>}
              </section>
            </>
          )}

          {view === 'map' && (
            <div className="report-grid report-grid--expanded">
              <ImpactGraph result={result} selectedId={selectedId} onSelect={setSelectedId} expanded />
              <EvidencePanel result={result} selectedId={selectedId} onSelect={setSelectedId} onOpenSource={openSource} />
            </div>
          )}

          {view === 'tests' && (
            <>
              <div className="view-intro"><FlaskConical size={20} /><p>Ranked from static dependency proximity. These tests have <strong>not been executed</strong>; use your normal runner or CI workflow.</p></div>
              {selection && <BaselineTable selection={selection} />}
              <div className="tests-layout">
                <TestTable tests={result.tests} onInspect={setSelectedId} onOpenSource={openSource} />
                <EvidencePanel result={result} selectedId={selectedId} onSelect={setSelectedId} onOpenSource={openSource} />
              </div>
            </>
          )}

          {view === 'files' && (
            <section className="files-view">
              <div className="file-search"><Search size={16} /><input value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} placeholder="Filter by file path" aria-label="Filter source files" /><span>{filteredFiles.length} files</span></div>
              {mode !== 'demo' && <p className="empty-note">Only files referenced by the evidence are stored with the report; the rest of the repository is not retained.</p>}
              <div className="file-list">
                {filteredFiles.map((file) => (
                  <button type="button" key={file.path} onClick={() => openSource(file.path, 1)}>
                    <FileCode2 size={18} /><span><strong>{file.path}</strong><small>{file.language} · {file.source.split('\n').length} lines</small></span>{changedPaths.has(file.path) && <b>modified</b>}<ArrowRight size={15} />
                  </button>
                ))}
              </div>
            </section>
          )}

          {view === 'limits' && (
            <div className="method-layout">
              <section className="method-main">
                <span className="section-label">DETERMINISTIC PIPELINE</span>
                <h2>Evidence first. AI is not in the decision path.</h2>
                <p>Tree-sitter extracts symbols from both revisions, imports and calls are resolved to declarations, and breadth-first search walks reverse call edges from each changed symbol. Any explanation text is generated afterwards from those results and validated against them.</p>
                <ol className="pipeline-list">
                  {['Parse merge-base and head revisions', 'Compare normalized symbol source', 'Traverse reverse call edges', 'Rank with transparent features', 'Attach source evidence'].map((step, index) => <li key={step}><span>{index + 1}</span>{step}</li>)}
                </ol>
                <div className="formula-block">
                  <span className="section-label">RANKING SCORE</span>
                  <code>{weights}</code>
                  <p>Proximity = 1 / shortest-path distance; fan-in counts how many changed symbols reach a node. Inferred edges halve the resolution term. Changed tests score 100; file-import-only tests score 15. Scores order inspection priority; they are not calibrated probabilities.</p>
                </div>
              </section>
              <aside className="limits-panel">
                <span className="section-label">KNOWN LIMITATIONS</span>
                <ul>{result.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
                <div className="unresolved-list">
                  <h3><AlertTriangle size={15} />{result.stats.unresolved} unresolved relationships</h3>
                  {result.unresolved.map((item) => <button type="button" key={`${item.path}-${item.line}-${item.expression}`} onClick={() => openSource(item.path, item.line)}><code>{item.path}:{item.line}</code><span>{item.expression}</span><small>{item.reason}</small></button>)}
                  {result.unresolved.length < result.stats.unresolved && <p className="empty-note">Showing the first {result.unresolved.length}.</p>}
                </div>
              </aside>
            </div>
          )}
        </main>
      </div>
      <SourceDialog repository={repository} selection={source} onClose={() => setSource(null)} />
    </div>
  )
}
