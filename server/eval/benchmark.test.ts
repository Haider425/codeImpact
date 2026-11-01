import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateCase, itsdangerous } from './benchmark'

const root = resolve(import.meta.dirname, '../..')
const repo = process.env.CODEIMPACT_BENCHMARK_REPO ?? join(root, 'data/bench/itsdangerous')
const wasmBasePath = join(root, 'public/wasm')

// Needs a full-history clone; `npm run bench` creates one. Skipped otherwise so CI stays offline.
describe.skipIf(!existsSync(join(repo, '.git')))('pallets/itsdangerous historical benchmark', () => {
  it('finds every labelled test with valid evidence paths', async () => {
    const results = await Promise.all(itsdangerous.cases.map((item) => evaluateCase(repo, itsdangerous, item, wasmBasePath)))
    expect(results).toHaveLength(itsdangerous.cases.length)
    for (const result of results) {
      expect(result.evidenceValid, result.id).toBe(true)
      expect(result.strategies.graph.recall, result.id).toBe(1)
      expect(result.strategies.graph.reduction, result.id).toBeGreaterThan(0)
    }
  }, 120_000)
})
