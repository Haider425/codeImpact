import { STRATEGY_LABELS } from '@/analysis/baselines'
import type { SelectionStrategy } from '@/analysis/baselines'

interface BaselineTableProps {
  selection: Record<SelectionStrategy, number>
}

/** How large a test subset each simple strategy would pick for this change. Size alone says nothing about safety. */
export function BaselineTable({ selection }: BaselineTableProps) {
  const total = selection['all-tests']
  return (
    <section className="baseline-block" aria-label="Test selection baselines">
      <span className="section-label">SELECTION SIZE VS. SIMPLE BASELINES</span>
      <table className="baseline-table">
        <tbody>
          {(Object.keys(STRATEGY_LABELS) as SelectionStrategy[]).map((strategy) => {
            const count = selection[strategy] ?? 0
            const share = total ? count / total : 0
            return (
              <tr key={strategy} className={strategy === 'graph' ? 'is-current' : ''}>
                <th scope="row">{STRATEGY_LABELS[strategy]}</th>
                <td><span className="baseline-bar"><i style={{ width: `${Math.round(share * 100)}%` }} /></span></td>
                <td className="baseline-count">{count}<small>/{total}</small></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p>A smaller subset is cheaper to run but may miss failures. Recall is measured offline in the benchmark, not per pull request.</p>
    </section>
  )
}
