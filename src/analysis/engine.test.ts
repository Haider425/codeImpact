/// <reference types="node" />
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyzeRepository } from './engine'
import { demoRepository } from './fixtures'
import type { DemoRepository, SourceFile } from './types'

const wasmBasePath = fileURLToPath(new URL('../../public/wasm', import.meta.url))

const py = (path: string, source: string): SourceFile => ({ path, source, language: 'python' })

function repository(baseFiles: SourceFile[], headFiles: SourceFile[]): DemoRepository {
  return {
    owner: 'test',
    name: 'repository',
    pullRequest: { number: 1, title: 'test change', author: 'test', baseRef: 'main', headRef: 'change' },
    base: { sha: 'base', files: baseFiles },
    head: { sha: 'head', files: headFiles },
  }
}

describe('CodeImpact deterministic analysis', () => {
  it('parses both languages and finds the modified symbols', async () => {
    const result = await analyzeRepository(demoRepository, { wasmBasePath })
    expect(result.stats.parsedFiles).toBe(11)
    expect(result.changes.map((change) => change.head?.name).sort()).toEqual(['apply_discount', 'formatMoney'])
    expect(result.changes.every((change) => change.changeType === 'modified')).toBe(true)
  }, 30_000)

  it('discovers direct and transitive callers with evidence paths', async () => {
    const result = await analyzeRepository(demoRepository, { wasmBasePath })
    expect(result.findings.map((finding) => finding.symbol.name).sort()).toEqual([
      'buildReceipt', 'calculate_total', 'checkout', 'create_invoice', 'renderTotal',
    ])
    expect(result.findings.find((finding) => finding.symbol.name === 'checkout')?.impactType).toBe('transitive')
    expect(result.findings.find((finding) => finding.symbol.name === 'calculate_total')?.reasons[0]).toContain('apply_discount')
    result.findings.forEach((finding) => {
      expect(finding.path.nodeIds.length).toBe(finding.distance + 1)
      expect(finding.path.edgeIds.length).toBe(finding.distance)
      finding.path.edgeIds.forEach((edgeId, index) => {
        const edge = result.edges.find((candidate) => candidate.id === edgeId)
        expect(edge).toMatchObject({
          source: finding.path.nodeIds[index + 1],
          target: finding.path.nodeIds[index],
        })
      })
    })
  }, 30_000)

  it('ranks all five relevant tests without executing them', async () => {
    const result = await analyzeRepository(demoRepository, { wasmBasePath })
    expect(result.tests).toHaveLength(5)
    expect(result.tests[0].rank).toBe(1)
    expect(result.tests.every((test) => test.limitation.includes('not executed'))).toBe(true)
    expect(result.unresolved.some((item) => item.expression.includes('getattr'))).toBe(true)
  }, 30_000)

  it('produces reproducible rankings for fixed revisions', async () => {
    const first = await analyzeRepository(demoRepository, { wasmBasePath })
    const second = await analyzeRepository(demoRepository, { wasmBasePath })
    expect(first.findings.map((finding) => [finding.symbol.id, finding.score])).toEqual(
      second.findings.map((finding) => [finding.symbol.id, finding.score]),
    )
    expect(first.tests.map((test) => [test.test.id, test.score])).toEqual(
      second.tests.map((test) => [test.test.id, test.score]),
    )
  }, 30_000)

  it('keeps concurrent analyses isolated', async () => {
    const [first, second] = await Promise.all([
      analyzeRepository(demoRepository, { wasmBasePath }),
      analyzeRepository(demoRepository, { wasmBasePath }),
    ])
    expect(first.findings.map((finding) => finding.symbol.id)).toEqual(second.findings.map((finding) => finding.symbol.id))
    expect(first.tests.map((test) => test.test.id)).toEqual(second.tests.map((test) => test.test.id))
  }, 30_000)

  it('does not create call edges to same-named symbols outside the caller scope', async () => {
    const result = await analyzeRepository(repository(
      [
        py('src/shared.py', 'def target():\n    return 1\n\ndef unrelated():\n    return 0\n'),
        py('src/worker.py', 'from src.shared import unrelated\n\ndef caller():\n    return target()\n'),
      ],
      [
        py('src/shared.py', 'def target():\n    return 2\n\ndef unrelated():\n    return 0\n'),
        py('src/worker.py', 'from src.shared import unrelated\n\ndef caller():\n    return target()\n'),
      ],
    ), { wasmBasePath })

    expect(result.findings).toHaveLength(0)
    expect(result.edges.some((edge) => edge.type === 'calls' && edge.evidencePath === 'src/worker.py')).toBe(false)
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      path: 'src/worker.py',
      expression: 'target',
      reason: expect.stringContaining('not declared locally or imported by name'),
    }))
  }, 30_000)

  it('resolves a uniquely named callee when its module is statically imported', async () => {
    const result = await analyzeRepository(repository(
      [
        py('src/shared.py', 'def target():\n    return 1\n'),
        py('src/worker.py', 'from src.shared import target\n\ndef caller():\n    return target()\n'),
      ],
      [
        py('src/shared.py', 'def target():\n    return 2\n'),
        py('src/worker.py', 'from src.shared import target\n\ndef caller():\n    return target()\n'),
      ],
    ), { wasmBasePath })

    const caller = result.findings.find((finding) => finding.symbol.name === 'caller')
    expect(caller?.impactType).toBe('direct')
    expect(caller?.path.edgeIds).toHaveLength(1)
  }, 30_000)

  it('prefers a local declaration over an imported name with the same spelling', async () => {
    const result = await analyzeRepository(repository(
      [
        py('src/shared.py', 'def target():\n    return 1\n'),
        py('src/worker.py', 'from src.shared import target\n\ndef target():\n    return 10\n\ndef caller():\n    return target()\n'),
      ],
      [
        py('src/shared.py', 'def target():\n    return 2\n'),
        py('src/worker.py', 'from src.shared import target\n\ndef target():\n    return 10\n\ndef caller():\n    return target()\n'),
      ],
    ), { wasmBasePath })

    expect(result.findings).toHaveLength(0)
    expect(result.unresolved.some((item) => item.expression === 'target')).toBe(false)
  }, 30_000)

  it('traverses surviving callers of a deleted symbol using base-revision evidence', async () => {
    const baseFiles = [
      py('src/legacy.py', 'def legacy():\n    return "old"\n'),
      py('src/consumer.py', 'from src.legacy import legacy\n\ndef consume():\n    return legacy()\n'),
      py('tests/test_consumer.py', 'from src.consumer import consume\n\ndef test_consume():\n    assert consume() == "old"\n'),
    ]
    const headFiles = baseFiles.filter((file) => file.path !== 'src/legacy.py')
    const result = await analyzeRepository(repository(baseFiles, headFiles), { wasmBasePath })

    expect(result.changes).toContainEqual(expect.objectContaining({ changeType: 'deleted', base: expect.objectContaining({ name: 'legacy' }) }))
    expect(result.findings.find((finding) => finding.symbol.name === 'consume')).toMatchObject({ impactType: 'direct', distance: 1 })
    const test = result.tests.find((recommendation) => recommendation.test.name === 'test_consume')
    expect(test?.path.nodeIds).toHaveLength(3)
    expect(test?.path.edgeIds).toHaveLength(2)
    expect(test?.path.edgeIds.map((id) => result.edges.find((edge) => edge.id === id)?.evidenceRevision)).toEqual(['base', 'head'])
    expect(result.stats.changedFiles).toBe(1)
    expect(result.unresolved).toContainEqual(expect.objectContaining({ path: 'src/consumer.py', expression: 'legacy' }))
  }, 30_000)
})
