import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { AlertTriangle, ArrowLeft, Check, Circle, LoaderCircle, RotateCcw } from 'lucide-react'
import type { DemoRepository } from '@/analysis/types'
import { ACTIVE_STATUSES, api, ApiError, STATUS_LABELS } from '@/lib/api'
import type { AnalysisReport, AnalysisRun, RunStatus } from '@/lib/api'
import { ReportView } from './Report'

const PIPELINE: RunStatus[] = ['queued', 'fetching', 'parsing', 'graphing', 'ranking', 'explaining']

function toRepository(report: AnalysisReport): DemoRepository {
  const { run } = report
  return {
    owner: run.repository?.owner ?? 'unknown',
    name: run.repository?.name ?? 'repository',
    pullRequest: {
      number: run.pullRequest?.number ?? 0,
      title: run.pullRequest?.title ?? '',
      author: run.pullRequest?.author ?? '',
      baseRef: run.pullRequest?.baseRef ?? (run.mergeBaseSha ?? run.baseSha).slice(0, 7),
      headRef: run.pullRequest?.headRef ?? run.headSha.slice(0, 7),
    },
    base: { sha: run.mergeBaseSha ?? run.baseSha, files: report.files.base },
    head: { sha: run.headSha, files: report.files.head },
  }
}

export default function Analysis() {
  const id = Number(useParams().id)
  const navigate = useNavigate()
  const [run, setRun] = useState<AnalysisRun | null>(null)
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const [error, setError] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const next = await api.analysis(id)
        if (cancelled) return
        setRun(next)
        if (next.status === 'completed') setReport(await api.report(id))
        else if (ACTIVE_STATUSES.includes(next.status)) timer = window.setTimeout(poll, 1000)
      } catch (caught) {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : 'Could not load the analysis.')
      }
    }
    void poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [id])

  const retry = async () => {
    const { id: retried } = await api.retry(id)
    setRun(null)
    setReport(null)
    navigate(`/analyses/${retried}`, { replace: true })
    window.location.reload()
  }

  if (report) {
    const mode = report.run.repository?.source === 'local' ? 'local' : 'github'
    return (
      <ReportView
        repository={toRepository(report)}
        result={report.result}
        mode={mode}
        explanation={report.explanation}
        selection={report.selection}
        changedFiles={report.changedFiles}
        actions={<Link className="button button--primary" to="/"><ArrowLeft size={15} />Dashboard</Link>}
        provenance={<small>run #{report.run.id} · {report.run.trigger}{report.run.mergeBaseSha && report.run.mergeBaseSha !== report.run.baseSha ? ' · diffed against merge base' : ''}</small>}
      />
    )
  }

  const title = run ? `${run.repository?.owner}/${run.repository?.name}${run.pullRequest ? ` #${run.pullRequest.number}` : ''}` : `Analysis #${id}`
  const currentIndex = run ? PIPELINE.indexOf(run.status) : -1

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/" aria-label="CodeImpact dashboard">
          <svg viewBox="0 0 30 30" aria-hidden="true"><path d="M5 8h7v7H5zM18 15h7v7h-7zM12 11.5h6M8.5 15v5.5H18" /></svg>
          <span>CodeImpact</span>
        </Link>
        <div className="topbar-actions"><Link className="button button--secondary" to="/"><ArrowLeft size={15} />Dashboard</Link></div>
      </header>
      <main className="dashboard">
        <span className="section-label">ANALYSIS #{id}</span>
        <h1 className="dashboard-title">{title}</h1>
        {run?.pullRequest?.title && <p className="dashboard-lede">{run.pullRequest.title}</p>}

        {error && <div className="analysis-state analysis-state--error" role="alert"><AlertTriangle size={28} /><div><strong>Could not load this analysis</strong><p>{error}</p></div></div>}

        {run?.status === 'failed' && run.error && (
          <div className="analysis-state analysis-state--error" role="alert">
            <AlertTriangle size={28} />
            <div><strong>Analysis failed: {run.error.code.replaceAll('_', ' ')}</strong><p>{run.error.message}</p></div>
            <button type="button" className="button button--secondary" onClick={() => void retry()}><RotateCcw size={15} />Retry</button>
          </div>
        )}

        {run && run.status !== 'failed' && (
          <ol className="stage-list" aria-label="Analysis progress">
            {PIPELINE.map((stage, index) => {
              const done = index < currentIndex
              const active = index === currentIndex
              return (
                <li key={stage} className={done ? 'is-done' : active ? 'is-active' : ''}>
                  {done ? <Check size={15} /> : active ? <LoaderCircle size={15} className="spin" /> : <Circle size={15} />}
                  <span>{STATUS_LABELS[stage]}</span>
                  {run.stageTimings[stage] !== undefined && <small>{run.stageTimings[stage]} ms</small>}
                </li>
              )
            })}
          </ol>
        )}
        {run?.error && run.status !== 'failed' && <p className="empty-note">Attempt {run.attempts} hit a transient error ({run.error.message}); it will be retried automatically.</p>}
      </main>
    </div>
  )
}
