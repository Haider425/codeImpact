import { selectTests } from '../src/analysis/baselines'
import type { SelectionStrategy } from '../src/analysis/baselines'
import { ALGORITHM_VERSION, analyzeRepository } from '../src/analysis/engine'
import type { AnalysisStage } from '../src/analysis/engine'
import { PARSER_VERSION } from '../src/analysis/parser'
import type { AnalysisResult, SourceFile, SymbolRecord } from '../src/analysis/types'
import type { Config } from './config'
import type { RunRow, RunStatus, Store } from './db'
import { AnalysisError, toAnalysisError } from './errors'
import { buildEvidenceBundle, explainAnalysis } from './explain'
import { loadRepositoryRevisions, mergeBase as localMergeBase, resolveCommit } from './git'
import type { ChangedFile } from './git'
import { GitHubClient } from './github'
import { log } from './log'

const STORED_FINDINGS = 300
const STORED_TESTS = 300
const STORED_UNRESOLVED = 300

export interface StoredAnalysis {
  result: AnalysisResult
  files: { base: SourceFile[]; head: SourceFile[] }
  changedFiles: ChangedFile[]
  /** How many tests each baseline strategy would select, computed before the result is trimmed. */
  selection: Record<SelectionStrategy, number>
  truncated: { findings: number; tests: number; unresolved: number }
}

/**
 * Keep what the report needs and drop the rest: symbols on evidence paths, edges among graph nodes,
 * and only the source files those reference. Full repository contents are not persisted.
 */
export function compactResult(result: AnalysisResult, base: SourceFile[], head: SourceFile[], changedFiles: ChangedFile[]): StoredAnalysis {
  const findings = result.findings.slice(0, STORED_FINDINGS)
  const tests = result.tests.slice(0, STORED_TESTS)
  const unresolved = result.unresolved.slice(0, STORED_UNRESOLVED)
  const graphIds = new Set(result.graphSymbolIds.filter((id) => (
    result.changes.some((c) => c.symbolId === id) || findings.some((f) => f.symbol.id === id) || tests.some((t) => t.test.id === id)
  )))
  const keepSymbols = new Set([
    ...graphIds,
    ...result.changes.flatMap((c) => [c.symbolId, ...(c.previousId ? [c.previousId] : [])]),
    ...findings.flatMap((f) => f.path.nodeIds),
    ...tests.flatMap((t) => t.path.nodeIds),
  ])
  const pathEdges = new Set([...findings, ...tests].flatMap((item) => item.path.edgeIds))
  const edges = result.edges.filter((edge) => pathEdges.has(edge.id) || (edge.type === 'calls' && graphIds.has(edge.source) && graphIds.has(edge.target)))
  const strip = (symbol: SymbolRecord): SymbolRecord => ({ ...symbol, source: '' })
  const symbols = result.symbols.filter((symbol) => keepSymbols.has(symbol.id)).map(strip)

  const paths = new Set([
    ...symbols.map((s) => s.path),
    ...edges.map((e) => e.evidencePath),
    ...unresolved.map((u) => u.path),
    ...result.changes.map((c) => (c.head ?? c.base)!.path),
    ...result.review.flatMap((finding) => [finding.changed.path, finding.affected.path]),
  ])
  return {
    result: {
      ...result,
      symbols,
      edges,
      findings: findings.map((f) => ({ ...f, symbol: strip(f.symbol) })),
      tests: tests.map((t) => ({ ...t, test: strip(t.test) })),
      unresolved,
      graphSymbolIds: [...graphIds],
    },
    files: { base: base.filter((f) => paths.has(f.path)), head: head.filter((f) => paths.has(f.path)) },
    changedFiles,
    selection: Object.fromEntries(Object.entries(selectTests(result)).map(([strategy, ids]) => [strategy, ids.length])) as Record<SelectionStrategy, number>,
    truncated: {
      findings: result.findings.length - findings.length,
      tests: result.tests.length - tests.length,
      unresolved: result.unresolved.length - unresolved.length,
    },
  }
}

const stageStatus: Partial<Record<AnalysisStage, RunStatus>> = {
  'parsing-base': 'parsing',
  graphing: 'graphing',
  ranking: 'ranking',
}

export interface PipelineDeps {
  github: GitHubClient
}

export function defaultDeps(config: Config): PipelineDeps {
  return {
    github: new GitHubClient(config.githubToken),
  }
}

export async function runJob(store: Store, run: RunRow, config: Config, deps: PipelineDeps) {
  const repository = store.repository(run.repository_id)
  const timings: Record<string, number> = {}
  let stageStarted = performance.now()
  let current: RunStatus = 'fetching'
  const enter = (status: RunStatus) => {
    if (status === current) return
    timings[current] = Math.round(performance.now() - stageStarted)
    stageStarted = performance.now()
    current = status
    store.setStage(run.id, status, timings)
  }

  try {
    if (!repository) throw new AnalysisError('repository_missing', 'The repository connection was removed.', false)

    let cwd: string
    let base: string
    if (repository.source === 'github') {
      if (run.pull_request_number === null) throw new AnalysisError('invalid_run', 'GitHub analyses require a pull-request number.', false)
      base = run.merge_base_sha ?? await deps.github.mergeBase(repository.owner, repository.name, run.base_sha, run.head_sha)
      cwd = await deps.github.fetchCommits(config.dataDir, repository.owner, repository.name, run.pull_request_number, [base, run.head_sha])
    } else {
      const path = repository.local_key ? config.localRepositories.get(repository.local_key) : undefined
      if (!path) throw new AnalysisError('repository_unavailable', 'This local repository is no longer configured on the server.', false)
      cwd = path
      base = await localMergeBase(cwd, await resolveCommit(cwd, run.base_sha), await resolveCommit(cwd, run.head_sha))
    }

    const loaded = await loadRepositoryRevisions(cwd, {
      owner: repository.owner,
      name: repository.name,
      pullRequest: {
        number: run.pull_request_number ?? 0,
        title: run.pull_request_title ?? '',
        author: run.pull_request_author ?? '',
        baseRef: run.base_ref ?? base.slice(0, 7),
        headRef: run.head_ref ?? run.head_sha.slice(0, 7),
      },
    }, base, run.head_sha)

    const result = await analyzeRepository(loaded.repository, {
      wasmBasePath: config.wasmBasePath,
      maxDepth: config.maxDepth,
      limitations: loaded.limitations,
      onStage: (stage) => {
        const status = stageStatus[stage]
        if (status) enter(status)
      },
    })

    enter('explaining')
    const bundle = buildEvidenceBundle(result, {
      repository: `${repository.owner}/${repository.name}`,
      number: run.pull_request_number ?? 0,
      title: run.pull_request_title ?? '',
    })
    const explanation = explainAnalysis(bundle)
    store.saveExplanation(run.id, {
      structuredOutput: { ...explanation.explanation, bundle },
      modelIdentifier: explanation.modelIdentifier,
      promptVersion: explanation.promptVersion,
      status: explanation.status,
      issues: explanation.issues,
      latencyMs: explanation.latencyMs,
    })

    timings[current] = Math.round(performance.now() - stageStarted)
    store.complete(run.id, {
      result: compactResult(result, loaded.repository.base.files, loaded.repository.head.files, loaded.changed),
      timings,
      mergeBase: base,
      parserVersion: PARSER_VERSION,
      algorithmVersion: ALGORITHM_VERSION,
    })
    log('info', 'analysis completed', { runId: run.id, timings, changed: result.stats.changedSymbols, tests: result.stats.recommendedTests, explanation: explanation.status })
  } catch (error) {
    const failure = toAnalysisError(error)
    timings[current] = Math.round(performance.now() - stageStarted)
    log(failure.code === 'internal_error' ? 'error' : 'warn', 'analysis failed', {
      runId: run.id, stage: current, code: failure.code, attempt: run.attempts,
      ...(failure.code === 'internal_error' ? { error: error instanceof Error ? error.stack : String(error) } : {}),
    })
    store.fail(run.id, { code: failure.code, message: failure.message, retryable: failure.retryable }, timings, config.maxAttempts)
  }
}
