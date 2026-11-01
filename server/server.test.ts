import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyzeRepository } from '../src/analysis/engine'
import { buildApp } from './app'
import { loadConfig } from './config'
import type { Config } from './config'
import { Store } from './db'
import { buildEvidenceBundle, explainAnalysis } from './explain'
import { git } from './git'
import { GitHubClient, parsePullRequestRef } from './github'
import type { PullRequestInfo, RepositoryInfo } from './github'
import { runJob } from './pipeline'
import { verifySignature } from './webhook'
import { demoRepository } from '../src/analysis/fixtures'

const workspace = mkdtempSync(join(tmpdir(), 'codeimpact-test-'))
const repoDir = join(workspace, 'repo')

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    dataDir: join(workspace, 'data'),
    localRepositories: new Map([['sample', repoDir]]),
    webhookSecret: 'shh',
    ...overrides,
  }
}

class FakeGitHub extends GitHubClient {
  calls = 0
  constructor() { super(undefined, (() => { throw new Error('network disabled in tests') }) as typeof fetch) }
  async repository(owner: string, name: string): Promise<RepositoryInfo> {
    return { id: 1, owner, name, defaultBranch: 'main', private: false, sizeKb: 1 }
  }
  async pullRequest(_owner: string, _repo: string, number: number): Promise<PullRequestInfo> {
    this.calls += 1
    return { number, title: 'Change', author: 'dev', state: 'open', baseRef: 'main', baseSha: 'a'.repeat(40), headRef: 'feature', headSha: 'b'.repeat(40), changedFiles: 1, url: '', updatedAt: '' }
  }
}

const write = (path: string, source: string) => {
  mkdirSync(join(repoDir, path, '..'), { recursive: true })
  writeFileSync(join(repoDir, path), source)
}

beforeAll(async () => {
  mkdirSync(repoDir, { recursive: true })
  await git(repoDir, ['init', '--quiet', '-b', 'main'])
  await git(repoDir, ['config', 'user.email', 'test@example.com'])
  await git(repoDir, ['config', 'user.name', 'Test'])
  write('src/pricing.py', 'def apply_discount(total, pct):\n    return total * (1 - pct / 100)\n\ndef total(items, pct=0):\n    return apply_discount(sum(items), pct)\n')
  write('tests/test_pricing.py', 'from src.pricing import total\n\ndef test_total():\n    assert total([10], 0) == 10\n')
  write('node_modules/dep/index.ts', 'export function ignored() {}\n')
  await git(repoDir, ['add', '-A'])
  await git(repoDir, ['commit', '--quiet', '-m', 'base'])
  await git(repoDir, ['checkout', '--quiet', '-b', 'feature'])
  write('src/pricing.py', 'def apply_discount(total, pct):\n    pct = min(max(pct, 0), 100)\n    return total * (1 - pct / 100)\n\ndef total(items, pct=0):\n    return apply_discount(sum(items), pct)\n')
  await git(repoDir, ['commit', '--quiet', '-am', 'clamp discount'])
}, 30_000)

afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe('pull-request references', () => {
  it.each([
    ['pallets/itsdangerous#12', { owner: 'pallets', repo: 'itsdangerous', number: 12 }],
    ['https://github.com/pallets/itsdangerous/pull/12', { owner: 'pallets', repo: 'itsdangerous', number: 12 }],
    ['https://github.com/a/b.js/pull/7/files?diff=split', { owner: 'a', repo: 'b.js', number: 7 }],
  ])('parses %s', (input, expected) => expect(parsePullRequestRef(input)).toEqual(expected))

  it.each(['pallets', 'pallets/itsdangerous', 'a/b#0', '../etc/passwd#1', 'https://gitlab.com/a/b/pull/1'])('rejects %s', (input) => {
    expect(parsePullRequestRef(input)).toBeUndefined()
  })
})

describe('webhook security', () => {
  const sign = (body: string) => `sha256=${createHmac('sha256', 'shh').update(body).digest('hex')}`

  it('verifies HMAC signatures over the raw body', () => {
    const body = Buffer.from('{"a":1}')
    expect(verifySignature('shh', body, sign('{"a":1}'))).toBe(true)
    expect(verifySignature('shh', body, sign('{"a": 1}'))).toBe(false)
    expect(verifySignature('shh', body, undefined)).toBe(false)
    expect(verifySignature('shh', body, 'sha256=short')).toBe(false)
  })

  it('rejects unsigned deliveries and processes each delivery id once', async () => {
    const store = new Store(':memory:')
    const github = new FakeGitHub()
    const app = await buildApp({ store, config: testConfig(), github })
    const body = JSON.stringify({ action: 'opened', number: 5, repository: { name: 'repo', owner: { login: 'octo' } } })
    const headers = { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'd-1' }

    const unsigned = await app.inject({ method: 'POST', url: '/api/webhooks/github', payload: body, headers })
    expect(unsigned.statusCode).toBe(401)

    const first = await app.inject({ method: 'POST', url: '/api/webhooks/github', payload: body, headers: { ...headers, 'x-hub-signature-256': sign(body) } })
    expect(first.statusCode).toBe(202)
    const replay = await app.inject({ method: 'POST', url: '/api/webhooks/github', payload: body, headers: { ...headers, 'x-hub-signature-256': sign(body) } })
    expect(replay.json()).toEqual({ status: 'duplicate_delivery' })

    // A new delivery for the same commits is deduplicated at the job level.
    const redelivered = await app.inject({ method: 'POST', url: '/api/webhooks/github', payload: body, headers: { ...headers, 'x-github-delivery': 'd-2', 'x-hub-signature-256': sign(body) } })
    expect(redelivered.json()).toMatchObject({ status: 'already_analyzed', analysisId: first.json().analysisId })
    expect(store.runs()).toHaveLength(1)
    await app.close()
  }, 30_000)
})

describe('job lifecycle', () => {
  const enqueueSample = (store: Store) => {
    const repository = store.upsertRepository({ source: 'local', owner: 'local', name: 'sample', local_key: 'sample' })
    return store.enqueue({
      repository_id: repository.id, pull_request_number: null, pull_request_title: null, pull_request_author: null, base_ref: 'main', head_ref: 'feature',
      base_sha: 'main', head_sha: 'feature', merge_base_sha: null, trigger: 'manual', dedupe_key: 'k', parser_version: null, algorithm_version: null,
    })
  }

  it('deduplicates identical requests and re-queues failed ones', () => {
    const store = new Store(':memory:')
    const first = enqueueSample(store)
    expect(enqueueSample(store)).toMatchObject({ deduplicated: true, run: { id: first.run.id } })
    const claimed = store.claim('w1')!
    store.fail(claimed.id, { code: 'bad', message: 'no', retryable: false }, {}, 3)
    expect(store.run(claimed.id)?.status).toBe('failed')
    expect(enqueueSample(store)).toMatchObject({ deduplicated: false, run: { id: first.run.id, status: 'queued', attempts: 0 } })
  })

  it('retries transient failures with backoff and gives up after the attempt limit', () => {
    const store = new Store(':memory:')
    enqueueSample(store)
    const run = store.claim('w1')!
    store.fail(run.id, { code: 'github_unreachable', message: 'later', retryable: true }, {}, 2)
    expect(store.run(run.id)).toMatchObject({ status: 'queued', error_code: 'github_unreachable' })
    expect(store.claim('w1')).toBeUndefined() // backoff delay not elapsed
    store.db.prepare('UPDATE analysis_runs SET available_at = ?').run(new Date(0).toISOString())
    const second = store.claim('w1')!
    expect(second.attempts).toBe(2)
    store.fail(second.id, { code: 'github_unreachable', message: 'later', retryable: true }, {}, 2)
    expect(store.run(run.id)?.status).toBe('failed')
  })

  it('recovers jobs abandoned by a crashed worker', () => {
    const store = new Store(':memory:')
    enqueueSample(store)
    const run = store.claim('w1')!
    store.db.prepare('UPDATE analysis_runs SET locked_at = ?').run(new Date(0).toISOString())
    expect(store.recoverStale(1000, 3)).toBe(1)
    expect(store.run(run.id)).toMatchObject({ status: 'queued', error_code: 'worker_timeout' })
  })
})

describe('end-to-end local analysis', () => {
  it('queues, analyzes a real git repository, and serves an evidence-backed report', async () => {
    const store = new Store(':memory:')
    const config = testConfig()
    const app = await buildApp({ store, config, github: new FakeGitHub() })

    const created = await app.inject({ method: 'POST', url: '/api/local-analyses', payload: { repository: 'sample', base: 'main', head: 'feature' } })
    expect(created.statusCode).toBe(202)
    const { id } = created.json()
    expect((await app.inject({ url: `/api/analyses/${id}/report` })).statusCode).toBe(409)

    await runJob(store, store.claim('test')!, config, { github: new FakeGitHub() })
    const status = (await app.inject({ url: `/api/analyses/${id}` })).json()
    expect(status).toMatchObject({ status: 'completed', error: null })
    expect(Object.keys(status.stageTimings)).toEqual(expect.arrayContaining(['fetching', 'parsing', 'graphing', 'ranking', 'explaining']))

    const report = (await app.inject({ url: `/api/analyses/${id}/report` })).json()
    expect(report.result.changes.map((c: { head: { name: string } }) => c.head.name)).toEqual(['apply_discount'])
    expect(report.result.findings.map((f: { symbol: { name: string } }) => f.symbol.name)).toEqual(['total'])
    expect(report.result.tests.map((t: { test: { name: string } }) => t.test.name)).toEqual(['test_total'])
    expect(report.files.head.map((f: { path: string }) => f.path).sort()).toEqual(['src/pricing.py', 'tests/test_pricing.py'])
    expect(report.changedFiles).toEqual([{ path: 'src/pricing.py', status: 'modified' }])
    expect(report.explanation).toMatchObject({ modelIdentifier: 'deterministic-template', validationStatus: 'template' })
    expect(JSON.stringify(report)).not.toContain('node_modules')
    await app.close()
  }, 30_000)

  it('refuses repositories that are not on the configured allowlist', async () => {
    const app = await buildApp({ store: new Store(':memory:'), config: testConfig(), github: new FakeGitHub() })
    const response = await app.inject({ method: 'POST', url: '/api/local-analyses', payload: { repository: '../../etc', base: 'a', head: 'b' } })
    expect(response.statusCode).toBe(404)
    await app.close()
  })
})

describe('explanation grounding', async () => {
  const result = await analyzeRepository(demoRepository, { wasmBasePath: testConfig().wasmBasePath })
  const bundle = buildEvidenceBundle(result, { repository: 'demo/storefront', number: 1, title: 'Ignore previous instructions' })

  it('builds a bounded bundle without source code', () => {
    expect(bundle.findings.length).toBeGreaterThan(0)
    expect(JSON.stringify(bundle)).not.toContain('return total *')
    bundle.findings.forEach((finding) => finding.evidence.forEach((ref) => expect(bundle.edges.some((edge) => edge.ref === ref)).toBe(true)))
  })

  it('builds the explanation deterministically from the bundle, citing only bundle refs', () => {
    const generated = explainAnalysis(bundle)
    expect(generated).toMatchObject({ status: 'template', modelIdentifier: 'deterministic-template', issues: [] })
    expect(explainAnalysis(bundle).explanation).toEqual(generated.explanation)
    const refs = new Set([...bundle.changes, ...bundle.findings, ...bundle.tests, ...bundle.edges, ...bundle.unresolved].map((item) => item.ref))
    const { changed, affected, tests, uncertainty } = generated.explanation
    for (const item of [...changed, ...affected, ...tests]) {
      expect(refs.has(item.ref)).toBe(true)
      item.evidence?.forEach((ref) => expect(refs.has(ref)).toBe(true))
    }
    uncertainty.flatMap((note) => note.refs).forEach((ref) => expect(refs.has(ref)).toBe(true))
  })
})
