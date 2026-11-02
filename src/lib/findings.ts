import type { ReviewFinding } from '@/analysis/types'

// Kept in step with RULE_TITLES in actions/comment/comment.mjs, which cannot import from here.
export const RULE_TITLES: Record<string, string> = {
  'signature/missing-argument': 'Caller misses a required argument',
  'signature/too-many-arguments': 'Caller passes too many arguments',
  'signature/unknown-keyword': 'Caller passes a removed keyword',
  'signature/reordered-parameters': 'Parameters were reordered',
  'reference/removed-symbol': 'Removed symbol is still called',
  'reference/renamed-symbol': 'Renamed symbol is still called by its old name',
  'reference/broken-import': 'Import no longer resolves',
  'impact/unupdated-caller': 'Callers outside the PR may be affected',
  'typecheck/tsc': 'Type error in untouched code',
  'typecheck/pyright': 'Type error in untouched code',
  'tests/failure': 'Impacted test fails',
}

export const SOURCE_LABELS: Record<ReviewFinding['source'], string> = {
  rule: 'Rule',
  typecheck: 'Type checker',
  'test-run': 'Test run',
}
