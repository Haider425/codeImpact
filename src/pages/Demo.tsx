import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, LoaderCircle, Play } from 'lucide-react'
import { analyzeRepository } from '@/analysis/engine'
import type { AnalysisStage } from '@/analysis/engine'
import { demoRepository } from '@/analysis/fixtures'
import type { AnalysisResult } from '@/analysis/types'
import { ReportView } from './Report'

const stageLabels: Record<AnalysisStage, string> = {
  fetching: 'Loading base/head revisions',
  'parsing-base': 'Parsing base revision',
  'parsing-head': 'Parsing head revision',
  graphing: 'Building dependency graph',
  ranking: 'Ranking impact and tests',
  completed: 'Analysis complete',
}

/** The bundled fixture analyzed entirely in the browser — works without the server. */
export default function Demo() {
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [stage, setStage] = useState<AnalysisStage | 'idle' | 'error'>('idle')
  const [error, setError] = useState('')
  const running = useRef(false)

  const runAnalysis = useCallback(async () => {
    if (running.current) return
    running.current = true
    setError('')
    setStage('fetching')
    try {
      setResult(await analyzeRepository(demoRepository, {
        wasmBasePath: `${import.meta.env.BASE_URL}wasm`,
        onStage: setStage,
        limitations: ['This is a bundled demo repository analyzed in your browser; connect the server to analyze real pull requests.'],
      }))
    } catch (caught) {
      setStage('error')
      setError(caught instanceof Error ? caught.message : 'The local parser could not complete the analysis.')
    } finally {
      running.current = false
    }
  }, [])

  useEffect(() => { void runAnalysis() }, [runAnalysis])

  const busy = !['idle', 'completed', 'error'].includes(stage)
  if (!result || busy || stage === 'error') {
    return (
      <div className="app-shell centered-state">
        {stage === 'error'
          ? <div className="analysis-state analysis-state--error" role="alert"><AlertTriangle size={28} /><div><strong>Analysis could not complete</strong><p>{error}</p></div><button type="button" className="button button--secondary" onClick={() => void runAnalysis()}>Retry</button></div>
          : <div className="analysis-state" role="status"><LoaderCircle size={28} className="spin" /><div><strong>{stageLabels[stage as AnalysisStage] ?? 'Starting analysis'}</strong><p>Tree-sitter is reading the actual base and head source files.</p></div><span>LOCAL / WASM</span></div>}
      </div>
    )
  }

  return (
    <ReportView
      repository={demoRepository}
      result={result}
      mode="demo"
      actions={<button type="button" className="button button--primary" onClick={() => void runAnalysis()}><Play size={15} />Run again</button>}
    />
  )
}
