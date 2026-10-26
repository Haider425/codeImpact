import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  LoaderCircle,
  Network,
  Play,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { analyzeRepository } from '@/analysis/engine'
import type { AnalysisStage } from '@/analysis/engine'
import { demoRepository } from '@/analysis/fixtures'
import type { AnalysisResult } from '@/analysis/types'
import { EvidencePanel } from '@/components/EvidencePanel'
import { ImpactGraph } from '@/components/ImpactGraph'
import { SourceDialog } from '@/components/SourceDialog'
import type { SourceSelection } from '@/components/SourceDialog'
import { TestTable } from '@/components/TestTable'

const repository = demoRepository
type View = 'report' | 'map' | 'tests' | 'files' | 'limits'

const stageLabels: Record<AnalysisStage, string> = {
  fetching: 'Loading base/head revisions',
  'parsing-base': 'Parsing base revision',
  'parsing-head': 'Parsing head revision',
  graphing: 'Building dependency graph',
  ranking: 'Ranking impact and tests',
  completed: 'Analysis complete',
}

export default function Home() {
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [stage, setStage] = useState<AnalysisStage | 'idle' | 'error'>('idle')
  const [error, setError] = useState('')
  const [view, setView] = useState<View>('report')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [source, setSource] = useState<SourceSelection | null>(null)
  const [fileQuery, setFileQuery] = useState('')
  const running = useRef(false)

  const runAnalysis = useCallback(async () => {
    if (running.current) return
    running.current = true
    setError('')
    setStage('fetching')
    try {
      const analysis = await analyzeRepository(repository, {
        wasmBasePath: `${import.meta.env.BASE_URL}wasm`,
        onStage: setStage,
      })
      setResult(analysis)
      setSelectedId((current) => current ?? analysis.changes[0]?.symbolId ?? analysis.findings[0]?.symbol.id ?? null)
    } catch (caught) {
      setStage('error')
      setError(caught instanceof Error ? caught.message : 'The local parser could not complete the analysis.')
    } finally {
      running.current = false
    }
  }, [])

  useEffect(() => { void runAnalysis() }, [runAnalysis])

  const openSource = useCallback((path: string, line: number, revision: 'base' | 'head' = 'head') => {
    setSource({ path, line, revision })
  }, [])

  const inspectTest = useCallback((id: string) => {
    setSelectedId(id)
    setView((current) => current === 'report' ? 'map' : current)
  }, [])

  const exportReport = () => {
    if (!result) return
    const payload = {
      product: 'CodeImpact vertical slice',
      repository: `${repository.owner}/${repository.name}`,
      pullRequest: repository.pullRequest,
      baseSha: repository.base.sha,
      headSha: repository.head.sha,
      generatedBy: 'deterministic-local-engine',
      ...result,
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `codeimpact-pr-${repository.pullRequest.number}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const filteredFiles = useMemo(() => repository.head.files.filter((file) => file.path.toLowerCase().includes(fileQuery.toLowerCase())), [fileQuery])
  const runningAnalysis = !['idle', 'completed', 'error'].includes(stage)
  const changedNames = result?.changes
    .map((change) => change.head?.name ?? change.base?.name)
    .filter((name): name is string => Boolean(name))
    .join(' and ')

  const navItems: { id: View; label: string; icon: typeof Code2; count?: number }[] = [
    { id: 'report', label: 'Impact report', icon: Code2 },
    { id: 'map', label: 'Dependency map', icon: Network, count: result?.graphSymbolIds.length },
    { id: 'tests', label: 'Recommended tests', icon: FlaskConical, count: result?.stats.recommendedTests },
    { id: 'files', label: 'Source files', icon: Files, count: result?.stats.parsedFiles },
    { id: 'limits', label: 'Method & limits', icon: Info, count: result?.stats.unresolved },
  ]

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#report" onClick={(event) => { event.preventDefault(); setView('report') }} aria-label="CodeImpact report home">
          <svg viewBox="0 0 30 30" aria-hidden="true"><path d="M5 8h7v7H5zM18 15h7v7h-7zM12 11.5h6M8.5 15v5.5H18" /></svg>
          <span>CodeImpact</span>
          <small>LAB / 01</small>
        </a>
        <div className="repository-crumb">
          <span>{repository.owner}</span><b>/</b><strong>{repository.name}</strong><GitBranch size={13} /><span>{repository.pullRequest.headRef}</span>
        </div>
        <div className="topbar-actions">
          <span className="local-badge"><i />Local engine</span>
          <button type="button" className="button button--secondary export-button" disabled={!result} onClick={exportReport}><Download size={15} />Export</button>
          <button type="button" className="button button--primary" disabled={runningAnalysis} onClick={() => void runAnalysis()}>
            {runningAnalysis ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
            {runningAnalysis ? 'Analyzing' : 'Run analysis'}
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="pr-card">
            <span className="section-label">PULL REQUEST</span>
            <div><GitPullRequest size={16} /><strong>#{repository.pullRequest.number}</strong><span className="pr-open">open</span></div>
            <h2>{repository.pullRequest.title}</h2>
            <p>{repository.pullRequest.author} · {repository.pullRequest.baseRef} ← {repository.pullRequest.headRef}</p>
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
            <p><ShieldCheck size={15} />Source is parsed locally. No repository code is executed.</p>
            <div><span>Python</span><b>supported</b></div>
            <div><span>TypeScript</span><b>supported</b></div>
            <div><span>GitHub App</span><b>not connected</b></div>
          </div>
        </aside>

        <main className="main-content" id="report">
          {runningAnalysis && (
            <div className="analysis-state" role="status">
              <LoaderCircle size={28} className="spin" />
              <div><strong>{stageLabels[stage as AnalysisStage] ?? 'Starting analysis'}</strong><p>Tree-sitter is reading the actual base and head source files.</p></div>
              <span>LOCAL / WASM</span>
            </div>
          )}
          {stage === 'error' && (
            <div className="analysis-state analysis-state--error" role="alert">
              <AlertTriangle size={28} /><div><strong>Analysis could not complete</strong><p>{error}</p></div>
              <button type="button" className="button button--secondary" onClick={() => void runAnalysis()}>Retry</button>
            </div>
          )}

          {result && !runningAnalysis && (
            <>
              <div className="page-heading">
                <div>
                  <span className="section-label">PR #{repository.pullRequest.number} / ANALYSIS RESULT</span>
                  <h1>{view === 'report' ? 'Impact report' : view === 'map' ? 'Dependency map' : view === 'tests' ? 'Recommended tests' : view === 'files' ? 'Source files' : 'Method & limitations'}</h1>
                </div>
                <div className="run-meta"><span><Check size={13} />Completed in {result.stats.durationMs} ms</span><code>{repository.base.sha} → {repository.head.sha}</code></div>
              </div>

              {view === 'report' && (
                <>
                  <section className="summary-block">
                    <div className="summary-copy">
                      <span className="summary-index">01 / CHANGE SUMMARY</span>
                      <h2>{result.stats.changedSymbols} code changes reach {result.stats.impactedSymbols} symbols and {result.stats.recommendedTests} tests.</h2>
                      <p>Changes to <code>{changedNames ?? 'the selected symbols'}</code> propagate through statically resolved caller paths. Start with direct callers, then inspect each recommended test’s evidence.</p>
                    </div>
                    <button type="button" className="summary-action" onClick={() => setView('tests')}>Review ranked tests <ArrowRight size={17} /></button>
                  </section>

                  <section className="metric-strip" aria-label="Analysis metrics">
                    <div><span>Changed files</span><strong>{String(result.stats.changedFiles).padStart(2, '0')}</strong><small>of {result.stats.parsedFiles} parsed</small></div>
                    <div><span>Potential impact</span><strong>{String(result.stats.impactedSymbols).padStart(2, '0')}</strong><small>{result.findings.filter((finding) => finding.impactType === 'direct').length} direct callers</small></div>
                    <div><span>Test attention</span><strong>{String(result.stats.recommendedTests).padStart(2, '0')}</strong><small>recommended, not run</small></div>
                    <div><span>Unresolved</span><strong>{String(result.stats.unresolved).padStart(2, '0')}</strong><small>visible uncertainty</small></div>
                  </section>

                  <div className="report-grid">
                    <ImpactGraph result={result} selectedId={selectedId} onSelect={setSelectedId} />
                    <EvidencePanel result={result} selectedId={selectedId} onSelect={setSelectedId} onOpenSource={openSource} />
                  </div>

                  <section className="tests-section">
                    <div className="section-heading"><div><span className="section-label">RANKED BY DEPENDENCY PROXIMITY</span><h2>Tests that deserve attention</h2></div><button type="button" onClick={() => setView('tests')}>View all evidence <ArrowRight size={14} /></button></div>
                    <TestTable tests={result.tests.slice(0, 3)} onInspect={inspectTest} onOpenSource={openSource} />
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
                  <div className="tests-layout">
                    <TestTable tests={result.tests} onInspect={setSelectedId} onOpenSource={openSource} />
                    <EvidencePanel result={result} selectedId={selectedId} onSelect={setSelectedId} onOpenSource={openSource} />
                  </div>
                </>
              )}

              {view === 'files' && (
                <section className="files-view">
                  <div className="file-search"><Search size={16} /><input value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} placeholder="Filter by file path" aria-label="Filter source files" /><span>{filteredFiles.length} files</span></div>
                  <div className="file-list">
                    {filteredFiles.map((file) => {
                      const changed = repository.base.files.find((candidate) => candidate.path === file.path)?.source !== file.source
                      return (
                        <button type="button" key={file.path} onClick={() => openSource(file.path, 1)}>
                          <FileCode2 size={18} /><span><strong>{file.path}</strong><small>{file.language} · {file.source.split('\n').length} lines</small></span>{changed && <b>modified</b>}<ArrowRight size={15} />
                        </button>
                      )
                    })}
                  </div>
                </section>
              )}

              {view === 'limits' && (
                <div className="method-layout">
                  <section className="method-main">
                    <span className="section-label">DETERMINISTIC PIPELINE</span>
                    <h2>Evidence first. AI is not in the decision path.</h2>
                    <p>This vertical slice uses Tree-sitter extraction, stable symbol keys, caller-to-callee edges, and breadth-first traversal from changed symbols. The explanation above is generated directly from those results.</p>
                    <ol className="pipeline-list">
                      {['Parse base and head revisions', 'Compare normalized symbol source', 'Traverse reverse call edges', 'Rank with transparent features', 'Attach source evidence'].map((step, index) => <li key={step}><span>{index + 1}</span>{step}</li>)}
                    </ol>
                    <div className="formula-block">
                      <span className="section-label">RANKING SCORE</span>
                      <code>55% proximity + 25% direct link + 10% resolution + 10% test link</code>
                      <p>Proximity = 1 / shortest-path distance. Scores order inspection priority; they are not calibrated probabilities.</p>
                    </div>
                  </section>
                  <aside className="limits-panel">
                    <span className="section-label">KNOWN LIMITATIONS</span>
                    <ul>{result.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
                    <div className="unresolved-list">
                      <h3><AlertTriangle size={15} />{result.unresolved.length} unresolved relationships</h3>
                      {result.unresolved.map((item) => <button type="button" key={`${item.path}-${item.line}-${item.expression}`} onClick={() => openSource(item.path, item.line)}><code>{item.path}:{item.line}</code><span>{item.expression}</span><small>{item.reason}</small></button>)}
                    </div>
                  </aside>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      <SourceDialog repository={repository} selection={source} onClose={() => setSource(null)} />
    </div>
  )
}
