import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { git } from '../git'
import { evaluateCase, itsdangerous, renderReport } from './benchmark'
import type { CaseResult } from './benchmark'
import { runReviewBenchmark } from './review-bench'
import type { BenchmarkResults } from './review-bench'
import { renderReviewReport, renderSpotCheck } from './review-report'
import type { SpotCheckVerdicts } from './review-report'

/**
 * npm run bench                 both benchmarks (the review benchmark takes about an hour)
 * npm run bench -- --only review --repos ufo
 * npm run bench -- --report-only  rebuild benchmark/REPORT.md from the saved JSON results
 */
const { values } = parseArgs({
  options: {
    only: { type: 'string' },
    repos: { type: 'string' },
    'report-only': { type: 'boolean', default: false },
  },
})

const root = resolve(import.meta.dirname, '../..')
const wasmBasePath = join(root, 'public/wasm')
const out = join(root, 'benchmark')
const reviewPath = join(out, 'review-results.json')
const historicalPath = join(out, 'results.json')
mkdirSync(out, { recursive: true })

async function ensureClone(url: string, directory: string) {
  if (existsSync(join(directory, '.git'))) return
  mkdirSync(directory, { recursive: true })
  console.log(`Cloning ${url} into ${directory}`)
  await git(directory, ['clone', '--quiet', url, '.'])
}

async function runHistorical() {
  // This clone is kept: the test suite's historical benchmark test reads it.
  const repoDir = process.env.CODEIMPACT_BENCHMARK_REPO ?? join(root, 'data/bench/itsdangerous')
  await ensureClone(itsdangerous.url, repoDir)
  const results: CaseResult[] = []
  for (const item of itsdangerous.cases) {
    const result = await evaluateCase(repoDir, itsdangerous, item, wasmBasePath)
    const graph = result.strategies.graph
    console.log(`${item.id.padEnd(24)} graph ${graph.found}/${graph.relevant} found, ${graph.selected}/${graph.totalTests} selected, ${result.latencyMs} ms`)
    results.push(result)
  }
  writeFileSync(historicalPath, `${JSON.stringify(results, null, 2)}\n`)
}

if (!values['report-only']) {
  if (!values.only || values.only === 'historical') await runHistorical()
  if (!values.only || values.only === 'review') {
    const results = await runReviewBenchmark(values.repos?.split(',').map((key) => key.trim()))
    writeFileSync(reviewPath, `${JSON.stringify(results, null, 2)}\n`)
  }
}

const sections: string[] = []
if (existsSync(reviewPath)) {
  const results = JSON.parse(readFileSync(reviewPath, 'utf8')) as BenchmarkResults
  // Human verdicts for the spot-check live in their own file so regenerating the report keeps them.
  const verdictsPath = join(out, 'spot-check-verdicts.json')
  const verdicts = existsSync(verdictsPath) ? JSON.parse(readFileSync(verdictsPath, 'utf8')) as SpotCheckVerdicts : undefined
  const { markdown, threshold } = renderReviewReport(results, verdicts)
  sections.push(markdown)
  writeFileSync(join(out, 'spot-check.md'), renderSpotCheck(results, threshold, verdicts))
}
if (existsSync(historicalPath)) {
  const historical = JSON.parse(readFileSync(historicalPath, 'utf8')) as CaseResult[]
  sections.push(renderReport(itsdangerous, historical)
    .replace(/^# Benchmark report — .*$/m, '## Appendix: historical test-selection benchmark (pallets/itsdangerous)')
    .replace(/^## /gm, '### ')
    .replace(/^### Appendix/m, '## Appendix'))
}
writeFileSync(join(out, 'REPORT.md'), `${sections.join('\n\n---\n\n')}\n`)
console.log('Wrote benchmark/REPORT.md, benchmark/spot-check.md, and the JSON results')
