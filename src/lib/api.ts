import type { SelectionStrategy } from '@/analysis/baselines'
import type { AnalysisResult, SourceFile } from '@/analysis/types'

export type RunStatus = 'queued' | 'fetching' | 'parsing' | 'graphing' | 'ranking' | 'explaining' | 'completed' | 'failed'

export interface AnalysisRun {
  id: number
  repositoryId: number
  repository?: { owner: string; name: string; source: 'github' | 'local' }
  pullRequest: { number: number; title: string | null; author: string | null; baseRef: string | null; headRef: string | null } | null
  baseSha: string
  headSha: string
  mergeBaseSha: string | null
  status: RunStatus
  trigger: 'manual' | 'webhook'
  error: { code: string; message: string; retryable: boolean } | null
  attempts: number
  stageTimings: Record<string, number>
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  versions: { parser: string | null; algorithm: string | null; prompt: string | null; model: string | null }
}

export interface ExplanationItem { ref: string; explanation: string; evidence?: string[] }

export interface StoredExplanation {
  explanation: {
    summary: string
    changed: ExplanationItem[]
    affected: ExplanationItem[]
    tests: ExplanationItem[]
    uncertainty: { explanation: string; refs: string[] }[]
    bundle?: { edges: { ref: string; location: string; revision: string; type: string; resolution: string }[]; unresolved: { ref: string; location: string }[] }
  }
  modelIdentifier: string
  promptVersion: string
  validationStatus: 'valid' | 'repaired' | 'fallback'
  validationIssues: string[]
  latencyMs: number
}

export interface AnalysisReport {
  run: AnalysisRun
  result: AnalysisResult
  files: { base: SourceFile[]; head: SourceFile[] }
  changedFiles: { path: string; status: string; previousPath?: string }[]
  selection: Record<SelectionStrategy, number>
  truncated: { findings: number; tests: number; unresolved: number }
  explanation: StoredExplanation | null
}

export interface ServerConfig {
  githubTokenConfigured: boolean
  webhookConfigured: boolean
  explanationModel: string | null
  localRepositories: string[]
  maxDepth: number
  versions: { parser: string; algorithm: string }
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  } catch {
    throw new ApiError(0, 'server_unreachable', 'The CodeImpact server is not reachable. Start it with `npm run server`.')
  }
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = (body as { error?: { code: string; message: string } } | undefined)?.error
    throw new ApiError(response.status, error?.code ?? 'http_error', error?.message ?? `Request failed with HTTP ${response.status}.`)
  }
  return body as T
}

export const api = {
  config: () => request<ServerConfig>('/api/config'),
  analyses: (limit = 30) => request<AnalysisRun[]>(`/api/analyses?limit=${limit}`),
  analysis: (id: number) => request<AnalysisRun>(`/api/analyses/${id}`),
  report: (id: number) => request<AnalysisReport>(`/api/analyses/${id}/report`),
  retry: (id: number) => request<{ id: number }>(`/api/analyses/${id}/retry`, { method: 'POST' }),
  analyzePullRequest: (pullRequest: string) => request<{ id: number; deduplicated: boolean }>('/api/analyses', { method: 'POST', body: JSON.stringify({ pullRequest }) }),
  analyzeLocal: (repository: string, base: string, head: string) => request<{ id: number; deduplicated: boolean }>('/api/local-analyses', { method: 'POST', body: JSON.stringify({ repository, base, head }) }),
}

export const ACTIVE_STATUSES: RunStatus[] = ['queued', 'fetching', 'parsing', 'graphing', 'ranking', 'explaining']

export const STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  fetching: 'Fetching base and head revisions',
  parsing: 'Parsing both revisions',
  graphing: 'Building the dependency graph',
  ranking: 'Ranking impact and tests',
  explaining: 'Writing the grounded explanation',
  completed: 'Completed',
  failed: 'Failed',
}
