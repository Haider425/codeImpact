import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { git } from '../git'
import { evaluateCase, itsdangerous, renderReport } from './benchmark'

const root = resolve(import.meta.dirname, '../..')
const wasmBasePath = join(root, 'public/wasm')

async function ensureClone(url: string, directory: string) {
  if (existsSync(join(directory, '.git'))) return
  mkdirSync(directory, { recursive: true })
  console.log(`Cloning ${url} into ${directory}`)
  await git(directory, ['clone', '--quiet', url, '.'])
}

const repoDir = process.env.CODEIMPACT_BENCHMARK_REPO ?? join(root, 'data/bench/itsdangerous')
await ensureClone(itsdangerous.url, repoDir)

const results = []
for (const item of itsdangerous.cases) {
  const result = await evaluateCase(repoDir, itsdangerous, item, wasmBasePath)
  const graph = result.strategies.graph
  console.log(`${item.id.padEnd(24)} graph ${graph.found}/${graph.relevant} found, ${graph.selected}/${graph.totalTests} selected, ${result.latencyMs} ms`)
  results.push(result)
}

mkdirSync(join(root, 'benchmark'), { recursive: true })
writeFileSync(join(root, 'benchmark/results.json'), `${JSON.stringify(results, null, 2)}\n`)
writeFileSync(join(root, 'benchmark/REPORT.md'), renderReport(itsdangerous, results))
console.log('Wrote benchmark/REPORT.md and benchmark/results.json')
