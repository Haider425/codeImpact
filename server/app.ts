import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import type { FastifyReply } from 'fastify'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { ALGORITHM_VERSION } from '../src/analysis/engine'
import { PARSER_VERSION } from '../src/analysis/parser'
import { ROOT } from './config'
import type { Config } from './config'
import type { RepositoryRow, RunRow, Store } from './db'
import { AnalysisError } from './errors'
import { resolveCommit } from './git'
import type { GitHubClient } from './github'
import { parsePullRequestRef } from './github'
import type { StoredAnalysis } from './pipeline'
import { ANALYZED_PULL_REQUEST_ACTIONS, verifySignature } from './webhook'

export interface AppDeps {
  store: Store
  config: Config
  github: GitHubClient
  /** Called after a run is queued so an in-process worker can start immediately. */
  onEnqueued?: () => void
}

function dedupeKey(repository: RepositoryRow, pull: number | null, base: string, head: string) {
  return `${repository.source}:${repository.owner}/${repository.name}#${pull ?? '-'}@${base}..${head}/${PARSER_VERSION}/${ALGORITHM_VERSION}`
}

function publicRun(run: RunRow & { owner?: string; name?: string; source?: string }) {
  return {
    id: run.id,
    repositoryId: run.repository_id,
    repository: run.owner ? { owner: run.owner, name: run.name, source: run.source } : undefined,
    pullRequest: run.pull_request_number === null ? null : {
      number: run.pull_request_number, title: run.pull_request_title, author: run.pull_request_author, baseRef: run.base_ref, headRef: run.head_ref,
    },
    baseSha: run.base_sha,
    headSha: run.head_sha,
    mergeBaseSha: run.merge_base_sha,
    status: run.status,
    trigger: run.trigger,
    error: run.error_code ? { code: run.error_code, message: run.error_message, retryable: Boolean(run.retryable) } : null,
    attempts: run.attempts,
    stageTimings: JSON.parse(run.stage_timings) as Record<string, number>,
    createdAt: run.created_at,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    versions: { parser: run.parser_version, algorithm: run.algorithm_version, prompt: run.prompt_version, model: run.model_identifier },
  }
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AnalysisError) {
    const status = error.code === 'not_found' || error.code === 'commit_not_found' ? 404 : error.code === 'github_rate_limited' ? 429 : 502
    return reply.code(status).send({ error: { code: error.code, message: error.message, retryable: error.retryable } })
  }
  throw error
}

const AnalyzeBody = z.union([
  z.object({ pullRequest: z.string().min(3).max(300) }),
  z.object({ owner: z.string().regex(/^[\w.-]+$/), repo: z.string().regex(/^[\w.-]+$/), number: z.number().int().positive() }),
])
const LocalBody = z.object({ repository: z.string().min(1).max(100), base: z.string().min(1).max(200), head: z.string().min(1).max(200) })
const IdParams = z.object({ id: z.coerce.number().int().positive() })

export async function buildApp({ store, config, github, onEnqueued }: AppDeps) {
  const app = Fastify({ logger: false, bodyLimit: 5_000_000 })

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'invalid_request', message: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } })
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: { code: 'invalid_request', message: error.message } })
    console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', msg: 'request failed', url: request.url, error: error.stack }))
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Unexpected server error.' } })
  })

  if (config.showcase) {
    // Read-only showcase: saved reports only. No new analyses, retries, webhooks, deletions, or GitHub calls.
    app.addHook('onRequest', async (request, reply) => {
      const readOnly = request.method === 'GET' || request.method === 'HEAD'
      if (request.url.startsWith('/api/') && (!readOnly || request.url.startsWith('/api/github/'))) {
        return reply.code(403).send({ error: { code: 'showcase_read_only', message: 'This is a read-only showcase of saved reports. New analyses are disabled.' } })
      }
    })
  }

  app.get('/api/health', async () => ({ ok: true }))

  app.get('/api/config', async () => ({
    showcase: config.showcase,
    githubTokenConfigured: Boolean(config.githubToken),
    webhookConfigured: Boolean(config.webhookSecret),
    localRepositories: [...config.localRepositories.keys()],
    maxDepth: config.maxDepth,
    versions: { parser: PARSER_VERSION, algorithm: ALGORITHM_VERSION },
    supportedLanguages: ['python', 'typescript'],
  }))

  app.get('/api/repositories', async () => store.repositories().map((repository) => ({
    id: repository.id,
    source: repository.source,
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.default_branch,
    analysisCount: repository.analysis_count,
    lastAnalysisAt: repository.last_analysis_at,
  })))

  app.get('/api/repositories/:id', async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    const repository = store.repository(id)
    if (!repository) return reply.code(404).send({ error: { code: 'not_found', message: 'Repository not found.' } })
    return { ...repository, analyses: store.runs({ repositoryId: id }).map(publicRun) }
  })

  app.delete('/api/repositories/:id/connection', async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    return store.deleteRepository(id) ? reply.code(204).send() : reply.code(404).send({ error: { code: 'not_found', message: 'Repository not found.' } })
  })

  app.get('/api/github/:owner/:repo/pull-requests', async (request, reply) => {
    const { owner, repo } = z.object({ owner: z.string().regex(/^[\w.-]+$/), repo: z.string().regex(/^[\w.-]+$/) }).parse(request.params)
    try {
      return await github.pullRequests(owner, repo)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  const enqueueGitHub = async (owner: string, repo: string, number: number, trigger: 'manual' | 'webhook') => {
    const [info, pull] = await Promise.all([github.repository(owner, repo), github.pullRequest(owner, repo, number)])
    const repository = store.upsertRepository({ source: 'github', owner: info.owner, name: info.name, github_repository_id: info.id, default_branch: info.defaultBranch })
    const queued = store.enqueue({
      repository_id: repository.id,
      pull_request_number: pull.number,
      pull_request_title: pull.title,
      pull_request_author: pull.author,
      base_ref: pull.baseRef,
      head_ref: pull.headRef,
      base_sha: pull.baseSha,
      head_sha: pull.headSha,
      merge_base_sha: null,
      trigger,
      dedupe_key: dedupeKey(repository, pull.number, pull.baseSha, pull.headSha),
      parser_version: PARSER_VERSION,
      algorithm_version: ALGORITHM_VERSION,
    })
    if (!queued.deduplicated) onEnqueued?.()
    return queued
  }

  app.post('/api/analyses', async (request, reply) => {
    const body = AnalyzeBody.parse(request.body)
    const ref = 'pullRequest' in body ? parsePullRequestRef(body.pullRequest) : { owner: body.owner, repo: body.repo, number: body.number }
    if (!ref) return reply.code(400).send({ error: { code: 'invalid_pull_request', message: 'Use owner/repo#123 or a github.com pull-request URL.' } })
    try {
      const { run, deduplicated } = await enqueueGitHub(ref.owner, ref.repo, ref.number, 'manual')
      return reply.code(deduplicated ? 200 : 202).send({ id: run.id, status: run.status, deduplicated })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  // Spec-style alias: POST /api/repositories/:id/pull-requests/:number/analyze
  app.post('/api/repositories/:id/pull-requests/:number/analyze', async (request, reply) => {
    const { id, number } = z.object({ id: z.coerce.number().int().positive(), number: z.coerce.number().int().positive() }).parse(request.params)
    const repository = store.repository(id)
    if (!repository || repository.source !== 'github') return reply.code(404).send({ error: { code: 'not_found', message: 'GitHub repository not found.' } })
    try {
      const { run, deduplicated } = await enqueueGitHub(repository.owner, repository.name, number, 'manual')
      return reply.code(deduplicated ? 200 : 202).send({ id: run.id, status: run.status, deduplicated })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/api/local-analyses', async (request, reply) => {
    const body = LocalBody.parse(request.body)
    const path = config.localRepositories.get(body.repository)
    if (!path) return reply.code(404).send({ error: { code: 'not_found', message: `Local repository "${body.repository}" is not configured in CODEIMPACT_LOCAL_REPOS.` } })
    try {
      const [base, head] = await Promise.all([resolveCommit(path, body.base), resolveCommit(path, body.head)])
      const repository = store.upsertRepository({ source: 'local', owner: 'local', name: body.repository, local_key: body.repository })
      const { run, deduplicated } = store.enqueue({
        repository_id: repository.id,
        pull_request_number: null,
        pull_request_title: `${body.base}…${body.head}`,
        pull_request_author: null,
        base_ref: body.base,
        head_ref: body.head,
        base_sha: base,
        head_sha: head,
        merge_base_sha: null,
        trigger: 'manual',
        dedupe_key: dedupeKey(repository, null, base, head),
        parser_version: PARSER_VERSION,
        algorithm_version: ALGORITHM_VERSION,
      })
      if (!deduplicated) onEnqueued?.()
      return reply.code(deduplicated ? 200 : 202).send({ id: run.id, status: run.status, deduplicated })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/api/analyses', async (request) => {
    const query = z.object({ repositoryId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query)
    return store.runs(query).map(publicRun)
  })

  const runOr404 = (id: number, reply: FastifyReply) => {
    const run = store.runDetail(id)
    if (!run) reply.code(404).send({ error: { code: 'not_found', message: 'Analysis not found.' } })
    return run
  }
  const completedOr409 = (id: number, reply: FastifyReply) => {
    const stored = store.result(id) as StoredAnalysis | undefined
    if (!stored) reply.code(409).send({ error: { code: 'not_ready', message: 'The analysis has not completed.' } })
    return stored
  }

  app.get('/api/analyses/:id', async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    const run = runOr404(id, reply)
    return run && publicRun(run)
  })

  app.post('/api/analyses/:id/retry', async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    const run = runOr404(id, reply)
    if (!run) return
    if (run.status !== 'failed') return reply.code(409).send({ error: { code: 'not_failed', message: 'Only failed analyses can be retried.' } })
    const { run: requeued } = store.enqueue({ ...run, trigger: 'manual' })
    onEnqueued?.()
    return reply.code(202).send({ id: requeued.id, status: requeued.status })
  })

  app.get('/api/analyses/:id/report', async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    const run = runOr404(id, reply)
    if (!run) return
    const stored = completedOr409(id, reply)
    if (!stored) return
    return { run: publicRun(run), ...stored, explanation: store.explanation(id) ?? null }
  })

  app.get('/api/analyses/:id/findings', async (request, reply) => {
    const stored = completedOr409(IdParams.parse(request.params).id, reply)
    return stored && stored.result.findings
  })

  app.get('/api/analyses/:id/tests', async (request, reply) => {
    const stored = completedOr409(IdParams.parse(request.params).id, reply)
    return stored && stored.result.tests
  })

  app.get('/api/analyses/:id/graph', async (request, reply) => {
    const stored = completedOr409(IdParams.parse(request.params).id, reply)
    if (!stored) return
    const nodes = new Set(stored.result.graphSymbolIds)
    return {
      nodes: stored.result.symbols.filter((symbol) => nodes.has(symbol.id)),
      edges: stored.result.edges.filter((edge) => nodes.has(edge.source) && nodes.has(edge.target)),
    }
  })

  // The webhook needs the exact raw bytes to verify the HMAC, so it gets its own JSON parser.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
    scope.post('/api/webhooks/github', async (request, reply) => {
      if (!config.webhookSecret) return reply.code(503).send({ error: { code: 'webhook_disabled', message: 'GITHUB_WEBHOOK_SECRET is not configured.' } })
      const raw = request.body as Buffer
      if (!verifySignature(config.webhookSecret, raw, request.headers['x-hub-signature-256'] as string | undefined)) {
        return reply.code(401).send({ error: { code: 'invalid_signature', message: 'Webhook signature verification failed.' } })
      }
      const event = String(request.headers['x-github-event'] ?? '')
      const delivery = String(request.headers['x-github-delivery'] ?? '')
      if (!delivery) return reply.code(400).send({ error: { code: 'missing_delivery', message: 'X-GitHub-Delivery header is required.' } })
      if (!store.recordDelivery(delivery, event)) return reply.code(200).send({ status: 'duplicate_delivery' })
      if (event === 'ping') return { status: 'pong' }
      if (event !== 'pull_request') return { status: 'ignored', reason: `event ${event} is not handled` }

      const payload = JSON.parse(raw.toString('utf8')) as { action?: string; number?: number; repository?: { name?: string; owner?: { login?: string } } }
      if (!ANALYZED_PULL_REQUEST_ACTIONS.has(payload.action ?? '')) return { status: 'ignored', reason: `action ${payload.action} is not analyzed` }
      const owner = payload.repository?.owner?.login
      const repo = payload.repository?.name
      if (!owner || !repo || !payload.number) return reply.code(400).send({ error: { code: 'invalid_payload', message: 'Pull-request payload is missing repository or number.' } })
      try {
        const { run, deduplicated } = await enqueueGitHub(owner, repo, payload.number, 'webhook')
        store.linkDelivery(delivery, run.id)
        return reply.code(202).send({ status: deduplicated ? 'already_analyzed' : 'queued', analysisId: run.id })
      } catch (error) {
        return sendError(reply, error)
      }
    })
  })

  const dist = join(ROOT, 'dist')
  if (existsSync(join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, wildcard: false })
    app.setNotFoundHandler((request, reply) => (
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: { code: 'not_found', message: 'Route not found.' } })
        : reply.sendFile('index.html')
    ))
  }

  return app
}
