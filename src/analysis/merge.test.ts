import { describe, expect, it } from 'vitest'
import { groupFindings } from './merge'
import type { EdgeRecord, ReviewFinding } from './types'

const changed = { path: 'src/pricing.ts', line: 2, revision: 'head' as const, symbolId: 'pricing', symbol: 'applyDiscount' }
const caller = { path: 'src/cart.ts', line: 13, revision: 'head' as const, symbolId: 'checkout', symbol: 'checkout' }

const finding = (overrides: Partial<ReviewFinding>): ReviewFinding => ({
  id: overrides.ruleId ?? 'x', ruleId: 'signature/missing-argument', severity: 'high', source: 'rule', confidence: 'confirmed',
  message: 'm', changed, affected: caller, evidence: [], ...overrides,
})

const edges: Pick<EdgeRecord, 'id' | 'source' | 'target' | 'evidencePath' | 'evidenceLine'>[] = [
  { id: 'e-call', source: 'checkout', target: 'pricing', evidencePath: 'src/cart.ts', evidenceLine: 13 },
  { id: 'e-test', source: 'test-coupon', target: 'checkout', evidencePath: 'src/cart.test.ts', evidenceLine: 6 },
  { id: 'e-other', source: 'test-other', target: 'invoice', evidencePath: 'src/invoice.test.ts', evidenceLine: 3 },
]

describe('groupFindings', () => {
  it('merges rule, type-checker, and failing-test evidence for one affected location', () => {
    const groups = groupFindings([
      finding({ id: 'rule', evidence: ['e-call'] }),
      finding({ id: 'tsc', ruleId: 'typecheck/tsc', source: 'typecheck', affected: { path: 'src/cart.ts', line: 13, revision: 'head' } }),
      finding({ id: 'test', ruleId: 'tests/failure', source: 'test-run', affected: { path: 'src/cart.test.ts', line: 5, revision: 'head', symbolId: 'test-coupon' }, evidence: ['e-test', 'e-call'] }),
    ], edges)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ severity: 'high', affected: { path: 'src/cart.ts', line: 13, symbolId: 'checkout' }, sources: ['rule', 'typecheck', 'test-run'] })
    expect(groups[0].findings.map((f) => f.id)).toEqual(['rule', 'tsc', 'test'])
    expect(groups[0].changed).toEqual([changed])
  })

  it('takes the strongest severity across merged evidence', () => {
    const groups = groupFindings([
      finding({ id: 'low-rule', ruleId: 'impact/unupdated-caller', severity: 'low' }),
      finding({ id: 'tsc', ruleId: 'typecheck/tsc', source: 'typecheck', severity: 'high', affected: { path: 'src/cart.ts', line: 13, revision: 'head' } }),
    ])
    expect(groups).toMatchObject([{ severity: 'high', sources: ['rule', 'typecheck'] }])
    expect(groups[0].findings.map((f) => f.id)).toEqual(['tsc', 'low-rule'])
  })

  it('keeps unrelated locations and unconnected test failures separate', () => {
    const groups = groupFindings([
      finding({ id: 'a' }),
      finding({ id: 'b', severity: 'medium', affected: { path: 'src/invoice.ts', line: 4, revision: 'head', symbolId: 'invoice' } }),
      finding({ id: 'orphan', ruleId: 'tests/failure', source: 'test-run', affected: { path: 'src/misc.test.ts', line: 1, revision: 'head' }, evidence: [] }),
    ], edges)
    expect(groups.map((group) => [group.severity, group.affected.path])).toEqual([
      ['high', 'src/cart.ts'], ['high', 'src/misc.test.ts'], ['medium', 'src/invoice.ts'],
    ])
  })

  it('attaches a failing test to the group whose caller lies on the test path even without a symbol id', () => {
    const groups = groupFindings([
      finding({ id: 'tsc', ruleId: 'typecheck/tsc', source: 'typecheck', affected: { path: 'src/cart.ts', line: 13, revision: 'head' } }),
      finding({ id: 'test', ruleId: 'tests/failure', source: 'test-run', affected: { path: 'src/cart.test.ts', line: 5, revision: 'head' }, evidence: ['e-test', 'e-call'] }),
    ], edges)
    expect(groups).toHaveLength(1)
    expect(groups[0].sources).toEqual(['typecheck', 'test-run'])
  })
})
