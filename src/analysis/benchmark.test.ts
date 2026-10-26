/// <reference types="node" />
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evaluateCase, itsdangerousCases, loadHistoricalRepository } from './benchmark'
const repo = process.env.CODEIMPACT_BENCHMARK_REPO ?? `${process.env.TEMP}\\codeimpact-itsdangerous-eval`
const wasmBasePath = fileURLToPath(new URL('../../public/wasm', import.meta.url))
describe('pallets/itsdangerous historical benchmark', () => {
  it('loads pinned parent/head revisions without copying checkout source', () => {
    for (const item of itsdangerousCases) expect(loadHistoricalRepository(repo, item).head.sha).toMatch(/^[0-9a-f]{40}$/)
  }, 30_000)
  it('reports recommendations, direct-call baseline, and valid evidence paths', async () => {
    const results = await Promise.all(itsdangerousCases.map((item) => evaluateCase(repo, item, wasmBasePath)))
    expect(results).toHaveLength(4)
    expect(results.every((result) => result.evidenceValid)).toBe(true)
  }, 120_000)
})
