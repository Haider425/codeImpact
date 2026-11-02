import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { loadConfig } from './config'
import { Store } from './db'
import { GitHubClient } from './github'
import { exportShowcase, listCompleted } from './showcase-export'

const dir = mkdtempSync(join(tmpdir(), 'codeimpact-showcase-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const result = { result: { symbols: [], edges: [], review: [] }, files: { base: [], head: [] }, changedFiles: [], selection: {}, truncated: {} }

/** A source database with one completed GitHub run, one completed local run, and one failed run. */
function seed(path: string) {
  const store = new Store(path)
  const github = store.upsertRepository({ source: 'github', owner: 'octo', name: 'demo' })
  const local = store.upsertRepository({ source: 'local', owner: 'local', name: 'private-app', local_key: 'private-app' })
  const payload = { result, timings: {}, mergeBase: 'b'.repeat(40), parserVersion: 'p', algorithmVersion: 'a' }
  const base = { pull_request_title: 't', pull_request_author: 'a', base_ref: 'main', head_ref: 'x', base_sha: 'b'.repeat(40), head_sha: 'c'.repeat(40) }
  const done = store.recordCompleted({ ...base, repository_id: github.id, pull_request_number: 1, dedupe_key: 'k1' }, payload)
  const localDone = store.recordCompleted({ ...base, repository_id: local.id, pull_request_number: null, dedupe_key: 'k2' }, payload)
  const failed = store.enqueue({ ...base, repository_id: github.id, pull_request_number: 2, merge_base_sha: null, trigger: 'manual', dedupe_key: 'k3', parser_version: null, algorithm_version: null }).run.id
  store.fail(store.claim('w')!.id, { code: 'x', message: 'no', retryable: false }, {}, 1)
  store.db.close()
  return { done, localDone, failed }
}

describe('showcase export', () => {
  const from = join(dir, 'source.db')
  const ids = seed(from)

  it('copies only the selected completed analyses into a fresh database', () => {
    const out = join(dir, 'showcase.db')
    expect(exportShowcase({ from, out, ids: [ids.done] })).toEqual([{ id: ids.done, repository: 'octo/demo', source: 'github' }])
    const target = new Store(out)
    expect(target.runs().map((run) => run.id)).toEqual([ids.done])
    expect(target.repositories().map((repository) => repository.name)).toEqual(['demo'])
    expect(target.result(ids.done)).toEqual(result)
    target.db.close()
    expect(listCompleted(from).map((run) => run.id)).toEqual([ids.done, ids.localDone])
  })

  it('refuses incomplete runs, local checkouts without consent, and overwriting', () => {
    const out = join(dir, 'refused.db')
    expect(() => exportShowcase({ from, out, ids: [ids.failed] })).toThrow(/Only completed analyses/)
    expect(() => exportShowcase({ from, out, ids: [ids.localDone] })).toThrow(/--allow-local/)
    expect(existsSync(out)).toBe(false)
    expect(exportShowcase({ from, out, ids: [ids.localDone], allowLocal: true })).toHaveLength(1)
    expect(() => exportShowcase({ from, out, ids: [ids.done] })).toThrow(/--force/)
    expect(exportShowcase({ from, out, ids: [ids.done], force: true })).toHaveLength(1)
  })
})

describe('showcase server', () => {
  it('serves saved reports and rejects every write and GitHub call', async () => {
    const { done } = seed(join(dir, 'serve-source.db'))
    const path = join(dir, 'serve.db')
    exportShowcase({ from: join(dir, 'serve-source.db'), out: path, ids: [done] })
    const store = new Store(path)
    const config = { ...loadConfig({}), showcase: true, dbPath: path, webhookSecret: 'shh' }
    const app = await buildApp({ store, config, github: new GitHubClient(undefined, (() => { throw new Error('no network') }) as typeof fetch) })
    try {
      await checkShowcase(app, done)
    } finally {
      await app.close()
      store.db.close()
    }
  }, 30_000)
})

async function checkShowcase(app: Awaited<ReturnType<typeof buildApp>>, done: number) {
    expect((await app.inject({ url: '/api/config' })).json()).toMatchObject({ showcase: true })
    expect((await app.inject({ url: `/api/analyses/${done}/report` })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/analyses' })).json().map((run: { id: number }) => run.id)).toEqual([done])
    for (const request of [
      { method: 'POST' as const, url: '/api/analyses', payload: { pullRequest: 'octo/demo#1' } },
      { method: 'POST' as const, url: '/api/local-analyses', payload: { repository: 'x', base: 'a', head: 'b' } },
      { method: 'POST' as const, url: `/api/analyses/${done}/retry` },
      { method: 'POST' as const, url: '/api/webhooks/github', payload: '{}', headers: { 'content-type': 'application/json' } },
      { method: 'DELETE' as const, url: '/api/repositories/1/connection' },
      { method: 'GET' as const, url: '/api/github/octo/demo/pull-requests' },
    ]) {
      const response = await app.inject(request)
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403)
      expect(response.json().error.code).toBe('showcase_read_only')
    }
}
