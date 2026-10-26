import { ArrowRight, FlaskConical } from 'lucide-react'
import type { TestRecommendation } from '@/analysis/types'

interface TestTableProps {
  tests: TestRecommendation[]
  onInspect: (id: string) => void
  onOpenSource: (path: string, line: number) => void
}

export function TestTable({ tests, onInspect, onOpenSource }: TestTableProps) {
  return (
    <div className="test-table-wrap">
      <table className="test-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Recommended test</th>
            <th>Connection</th>
            <th>Score</th>
            <th>Status</th>
            <th><span className="sr-only">Inspect</span></th>
          </tr>
        </thead>
        <tbody>
          {tests.map((recommendation) => (
            <tr key={recommendation.test.id}>
              <td><span className="rank-number">{String(recommendation.rank).padStart(2, '0')}</span></td>
              <td>
                <button type="button" className="test-name" onClick={() => onInspect(recommendation.test.id)}>
                  <FlaskConical size={14} />{recommendation.test.name}
                </button>
                <button type="button" className="test-path" onClick={() => onOpenSource(recommendation.test.path, recommendation.test.startLine)}>
                  {recommendation.test.path}:{recommendation.test.startLine}
                </button>
              </td>
              <td>{recommendation.path.edgeIds.length === 1 ? 'Direct call' : `${recommendation.path.edgeIds.length} edges`}</td>
              <td><strong className="table-score">{recommendation.score}</strong><span className="score-denominator">/100</span></td>
              <td><span className="recommendation-status">Recommended</span></td>
              <td><button type="button" className="icon-action" aria-label={`Inspect evidence for ${recommendation.test.name}`} onClick={() => onInspect(recommendation.test.id)}><ArrowRight size={16} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
