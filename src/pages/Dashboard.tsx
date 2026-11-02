import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { AlertTriangle, ArrowRight, Check, Eye, FolderGit2, GitPullRequest, LoaderCircle, Play, X } from 'lucide-react'
import { ACTIVE_STATUSES, api, ApiError, STATUS_LABELS } from '@/lib/api'
import type { AnalysisRun, ServerConfig } from '@/lib/api'

function relativeTime(iso: string) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [serverError, setServerError] = useState('')
  const [runs, setRuns] = useState<AnalysisRun[]>([])
  const [pullRequest, setPullRequest] = useState('')
  const [local, setLocal] = useState({ repository: '', base: 'main', head: 'HEAD' })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const load = async () => {
      try {
        const [nextConfig, nextRuns] = await Promise.all([api.config(), api.analyses()])
        if (cancelled) return
        setConfig(nextConfig)
        setRuns(nextRuns)
        setServerError('')
        setLocal((current) => current.repository ? current : { ...current, repository: nextConfig.localRepositories[0] ?? '' })
        if (nextRuns.some((run) => ACTIVE_STATUSES.includes(run.status))) timer = window.setTimeout(load, 2000)
      } catch (caught) {
        if (!cancelled) setServerError(caught instanceof ApiError ? caught.message : 'The server could not be reached.')
      }
    }
    void load()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  const submit = async (event: FormEvent, action: () => Promise<{ id: number }>) => {
    event.preventDefault()
    setSubmitting(true)
    setFormError('')
    try {
      const { id } = await action()
      navigate(`/analyses/${id}`)
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'The analysis could not be started.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/" aria-label="CodeImpact dashboard">
          <svg viewBox="0 0 30 30" aria-hidden="true"><path d="M5 8h7v7H5zM18 15h7v7h-7zM12 11.5h6M8.5 15v5.5H18" /></svg>
          <span>CodeImpact</span>
          <small>MVP</small>
        </Link>
        <div className="topbar-actions">
          <Link className="button button--secondary" to="/demo"><Play size={15} />Offline demo</Link>
        </div>
      </header>

      <main className="dashboard">
        <span className="section-label">CHANGE IMPACT ANALYSIS</span>
        <h1 className="dashboard-title">Which code and tests does this pull request reach?</h1>
        <p className="dashboard-lede">CodeImpact parses both revisions of a Python or TypeScript pull request, traces callers of every changed symbol, and ranks the tests worth running — with the evidence for each.</p>

        {serverError && (
          <div className="analysis-state analysis-state--error" role="alert">
            <AlertTriangle size={28} />
            <div><strong>Server unavailable</strong><p>{serverError} The <Link to="/demo">offline demo</Link> still works.</p></div>
          </div>
        )}

        {config?.showcase && (
          <p className="showcase-banner"><Eye size={16} />This is a read-only showcase of saved CodeImpact reports. Starting new analyses is disabled here; run CodeImpact yourself with the GitHub Action or the CLI.</p>
        )}

        {config && !config.showcase && (
          <div className="dashboard-grid">
            <form className="panel" onSubmit={(event) => void submit(event, () => api.analyzePullRequest(pullRequest))}>
              <span className="section-label"><GitPullRequest size={13} /> GITHUB PULL REQUEST</span>
              <label htmlFor="pr-input"><span>Pull-request URL or <code>owner/repo#number</code></span></label>
              <div className="input-row">
                <input id="pr-input" value={pullRequest} onChange={(event) => setPullRequest(event.target.value)} placeholder="https://github.com/pallets/itsdangerous/pull/428" required autoComplete="off" spellCheck={false} />
                <button type="submit" className="button button--primary" disabled={submitting || !pullRequest.trim()}>
                  {submitting ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}Analyze
                </button>
              </div>
              <p className="hint">{config.githubTokenConfigured ? 'Using the server’s GitHub token.' : 'Public repositories only — set GITHUB_TOKEN on the server for private ones and higher rate limits.'}</p>
            </form>

            {config.localRepositories.length > 0 && (
              <form className="panel" onSubmit={(event) => void submit(event, () => api.analyzeLocal(local.repository, local.base, local.head))}>
                <span className="section-label"><FolderGit2 size={13} /> LOCAL CHECKOUT</span>
                <div className="field-grid">
                  <label>Repository<select value={local.repository} onChange={(event) => setLocal({ ...local, repository: event.target.value })}>{config.localRepositories.map((name) => <option key={name}>{name}</option>)}</select></label>
                  <label>Base<input value={local.base} onChange={(event) => setLocal({ ...local, base: event.target.value })} spellCheck={false} /></label>
                  <label>Head<input value={local.head} onChange={(event) => setLocal({ ...local, head: event.target.value })} spellCheck={false} /></label>
                </div>
                <button type="submit" className="button button--secondary" disabled={submitting}>Analyze range</button>
              </form>
            )}
          </div>
        )}
        {formError && <p className="form-error" role="alert"><AlertTriangle size={14} />{formError}</p>}

        {config && (
          <section className="status-strip" aria-label="Server capabilities">
            <span>{config.webhookConfigured ? <Check size={13} /> : <X size={13} />}Webhook {config.webhookConfigured ? 'enabled' : 'disabled'}</span>
            <span>Python · TypeScript</span>
            <span>depth ≤ {config.maxDepth}</span>
            <span>{config.versions.parser} · {config.versions.algorithm}</span>
          </section>
        )}

        {config && (
          <section className="history">
            <div className="section-heading"><div><span className="section-label">HISTORY</span><h2>Recent analyses</h2></div></div>
            {runs.length === 0
              ? <p className="empty-note">{config.showcase ? 'No reports have been published to this showcase yet.' : 'No analyses yet. Paste a pull-request URL above to start one.'}</p>
              : (
                <div className="history-list">
                  {runs.map((run) => (
                    <Link key={run.id} to={`/analyses/${run.id}`} className={`history-row history-row--${run.status}`}>
                      <span className="history-status">
                        {run.status === 'completed' ? <Check size={14} /> : run.status === 'failed' ? <AlertTriangle size={14} /> : <LoaderCircle size={14} className="spin" />}
                      </span>
                      <span className="history-main">
                        <strong>{run.repository?.owner}/{run.repository?.name}{run.pullRequest?.number ? ` #${run.pullRequest.number}` : ''}</strong>
                        <small>{run.pullRequest?.title ?? `${run.baseSha.slice(0, 7)} → ${run.headSha.slice(0, 7)}`}</small>
                      </span>
                      <span className="history-meta">
                        <span>{run.status === 'failed' ? run.error?.code.replaceAll('_', ' ') : STATUS_LABELS[run.status]}</span>
                        <small>{relativeTime(run.createdAt)} · {run.trigger}</small>
                      </span>
                      <ArrowRight size={15} />
                    </Link>
                  ))}
                </div>
              )}
          </section>
        )}
      </main>
    </div>
  )
}
