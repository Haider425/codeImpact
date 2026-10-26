import { execFileSync } from 'node:child_process'
import type { DemoRepository, Revision, SourceFile } from './types'
import { analyzeRepository } from './engine'

export interface BenchmarkCase {
  id: string; base: string; head: string; expectedTests: string[]
}

export const itsdangerousCases: BenchmarkCase[] = [
  { id: '177196d-oserror', base: '37f09970fa32a330a6660ded3abdb264086531b5', head: '177196d3a5c7ad37b8ccbd0f88445aced07f1ca0', expectedTests: ['test_malformed_future_timestamp'] },
  { id: '7f4dcf8-lazy-sha1', base: '93ae366874bbd4f69d90495c45b2cd336387496c', head: '7f4dcf83a07bb3d53f4e0e65ef1b43327b4cca90', expectedTests: ['test_iter_unsigners'] },
  { id: '37f0997-valueerror', base: '85b1e3b76e0e37473dc286450ada725cd02981b4', head: '37f09970fa32a330a6660ded3abdb264086531b5', expectedTests: ['test_malformed_future_timestamp'] },
  { id: '3edfbbb-overflowerror', base: 'faa28bccc85ee47a8274536dd3649a0b67d0a75b', head: '3edfbbbc615be5090d452bbf8a13dfdd68436659', expectedTests: ['test_malformed_future_timestamp'] },
]

function git(repo: string, args: string[]) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }) }
function revision(repo: string, sha: string): Revision {
  const files: SourceFile[] = git(repo, ['ls-tree', '-r', '--name-only', sha]).split('\n').filter((p) => p.endsWith('.py')).map((path) => ({
    path, language: 'python' as const, source: git(repo, ['show', `${sha}:${path}`]),
  }))
  return { sha, files }
}
export function loadHistoricalRepository(repo: string, item: BenchmarkCase): DemoRepository {
  const baseSha = git(repo, ['rev-parse', `${item.base}^{commit}`]).trim()
  const headSha = git(repo, ['rev-parse', `${item.head}^{commit}`]).trim()
  if (git(repo, ['rev-parse', `${headSha}^`]).trim() !== baseSha) throw new Error(`${item.id}: base is not head's parent`)
  return { owner: 'pallets', name: 'itsdangerous', pullRequest: { number: 0, title: item.id, author: 'historical', baseRef: baseSha, headRef: headSha }, base: revision(repo, baseSha), head: revision(repo, headSha) }
}
export async function evaluateCase(repo: string, item: BenchmarkCase, wasmBasePath: string) {
  const result = await analyzeRepository(loadHistoricalRepository(repo, item), { wasmBasePath })
  const recommended = result.tests.map((test) => test.test.name)
  const directBaseline = result.tests.filter((test) => test.path.edgeIds.length === 1).map((test) => test.test.name)
  const score = (selected: string[]) => ({ found: selected.filter((x) => item.expectedTests.includes(x)), falsePositives: selected.filter((x) => !item.expectedTests.includes(x)), missed: item.expectedTests.filter((x) => !selected.includes(x)) })
  return { id: item.id, base: result.changes.length ? result.changes[0].base?.path : undefined, expectedTests: item.expectedTests, recommended, baseline: directBaseline, codeImpact: score(recommended), baselineMetrics: score(directBaseline), evidenceValid: result.tests.every((test) => test.path.edgeIds.every((id, index) => { const edge = result.edges.find((e) => e.id === id); return edge?.source === test.path.nodeIds[index + 1] && edge.target === test.path.nodeIds[index] })) }
}
