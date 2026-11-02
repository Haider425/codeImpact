import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type RunStatus = 'queued' | 'fetching' | 'parsing' | 'graphing' | 'ranking' | 'explaining' | 'completed' | 'failed'
export const ACTIVE_STATUSES: RunStatus[] = ['fetching', 'parsing', 'graphing', 'ranking', 'explaining']

export interface RepositoryRow {
  id: number
  source: 'github' | 'local'
  owner: string
  name: string
  github_repository_id: number | null
  default_branch: string | null
  local_key: string | null
  created_at: string
}

export interface RunRow {
  id: number
  repository_id: number
  pull_request_number: number | null
  pull_request_title: string | null
  pull_request_author: string | null
  base_ref: string | null
  head_ref: string | null
  base_sha: string
  head_sha: string
  merge_base_sha: string | null
  status: RunStatus
  trigger: 'manual' | 'webhook'
  dedupe_key: string
  error_code: string | null
  error_message: string | null
  retryable: number
  attempts: number
  available_at: string
  locked_by: string | null
  locked_at: string | null
  stage_timings: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  parser_version: string | null
  algorithm_version: string | null
  prompt_version: string | null
  model_identifier: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('github', 'local')),
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  github_repository_id INTEGER,
  default_branch TEXT,
  local_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source, owner, name)
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pull_request_number INTEGER,
  pull_request_title TEXT,
  pull_request_author TEXT,
  base_ref TEXT,
  head_ref TEXT,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  merge_base_sha TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  trigger TEXT NOT NULL DEFAULT 'manual',
  dedupe_key TEXT NOT NULL UNIQUE,
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  locked_by TEXT,
  locked_at TEXT,
  stage_timings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  parser_version TEXT,
  algorithm_version TEXT,
  prompt_version TEXT,
  model_identifier TEXT
);
CREATE INDEX IF NOT EXISTS analysis_runs_queue ON analysis_runs (status, available_at);
CREATE INDEX IF NOT EXISTS analysis_runs_repository ON analysis_runs (repository_id, created_at);

-- Findings, tests, the trimmed graph, and the evidence files are stored as one JSON document per run.
CREATE TABLE IF NOT EXISTS analysis_results (
  analysis_run_id INTEGER PRIMARY KEY REFERENCES analysis_runs(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS explanation_reports (
  analysis_run_id INTEGER PRIMARY KEY REFERENCES analysis_runs(id) ON DELETE CASCADE,
  structured_output TEXT NOT NULL,
  model_identifier TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  validation_issues TEXT NOT NULL DEFAULT '[]',
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  analysis_run_id INTEGER,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`

const now = () => new Date().toISOString()

export class Store {
  readonly db: Database.Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  upsertRepository(input: Pick<RepositoryRow, 'source' | 'owner' | 'name'> & Partial<Pick<RepositoryRow, 'github_repository_id' | 'default_branch' | 'local_key'>>): RepositoryRow {
    this.db.prepare(`
      INSERT INTO repositories (source, owner, name, github_repository_id, default_branch, local_key)
      VALUES (@source, @owner, @name, @github_repository_id, @default_branch, @local_key)
      ON CONFLICT (source, owner, name) DO UPDATE SET
        github_repository_id = COALESCE(excluded.github_repository_id, github_repository_id),
        default_branch = COALESCE(excluded.default_branch, default_branch),
        local_key = COALESCE(excluded.local_key, local_key)
    `).run({ github_repository_id: null, default_branch: null, local_key: null, ...input })
    return this.db.prepare('SELECT * FROM repositories WHERE source = ? AND owner = ? AND name = ?').get(input.source, input.owner, input.name) as RepositoryRow
  }

  repository(id: number) {
    return this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as RepositoryRow | undefined
  }

  repositories() {
    return this.db.prepare(`
      SELECT r.*, COUNT(a.id) AS analysis_count, MAX(a.created_at) AS last_analysis_at
      FROM repositories r LEFT JOIN analysis_runs a ON a.repository_id = r.id
      GROUP BY r.id ORDER BY last_analysis_at DESC NULLS LAST, r.id DESC
    `).all() as (RepositoryRow & { analysis_count: number; last_analysis_at: string | null })[]
  }

  /**
   * Create a run unless an equivalent one exists. Identical (repository, PR, commits, algorithm) requests
   * return the existing run, so duplicate webhook deliveries and double clicks never duplicate work.
   * A failed run is re-queued instead.
   */
  enqueue(input: Omit<RunRow, 'id' | 'status' | 'error_code' | 'error_message' | 'retryable' | 'attempts' | 'available_at' | 'locked_by' | 'locked_at' | 'stage_timings' | 'created_at' | 'started_at' | 'completed_at' | 'prompt_version' | 'model_identifier'>) {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM analysis_runs WHERE dedupe_key = ?').get(input.dedupe_key) as RunRow | undefined
      if (existing && existing.status !== 'failed') return { run: existing, deduplicated: true }
      if (existing) {
        this.db.prepare(`
          UPDATE analysis_runs SET status = 'queued', error_code = NULL, error_message = NULL, retryable = 0,
            attempts = 0, available_at = ?, locked_by = NULL, locked_at = NULL, stage_timings = '{}',
            started_at = NULL, completed_at = NULL
          WHERE id = ?
        `).run(now(), existing.id)
        return { run: this.run(existing.id)!, deduplicated: false }
      }
      const info = this.db.prepare(`
        INSERT INTO analysis_runs (repository_id, pull_request_number, pull_request_title, pull_request_author, base_ref, head_ref,
          base_sha, head_sha, merge_base_sha, trigger, dedupe_key, parser_version, algorithm_version, available_at, created_at)
        VALUES (@repository_id, @pull_request_number, @pull_request_title, @pull_request_author, @base_ref, @head_ref,
          @base_sha, @head_sha, @merge_base_sha, @trigger, @dedupe_key, @parser_version, @algorithm_version, @now, @now)
      `).run({ ...input, now: now() }) // JS clock everywhere: claim() compares against the same source.
      return { run: this.run(Number(info.lastInsertRowid))!, deduplicated: false }
    })()
  }

  /**
   * Record an analysis that already ran elsewhere (the CLI) as a completed run, so it can be viewed and
   * exported. Re-recording the same commits and options replaces the stored result.
   */
  recordCompleted(
    input: Pick<RunRow, 'repository_id' | 'pull_request_number' | 'pull_request_title' | 'pull_request_author' | 'base_ref' | 'head_ref' | 'base_sha' | 'head_sha' | 'dedupe_key'>,
    payload: { result: unknown; timings: Record<string, number>; mergeBase: string; parserVersion: string; algorithmVersion: string },
  ) {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM analysis_runs WHERE dedupe_key = ?').get(input.dedupe_key) as { id: number } | undefined
      const id = existing?.id ?? Number(this.db.prepare(`
        INSERT INTO analysis_runs (repository_id, pull_request_number, pull_request_title, pull_request_author, base_ref, head_ref,
          base_sha, head_sha, status, trigger, dedupe_key, available_at, created_at, started_at)
        VALUES (@repository_id, @pull_request_number, @pull_request_title, @pull_request_author, @base_ref, @head_ref,
          @base_sha, @head_sha, 'completed', 'manual', @dedupe_key, @now, @now, @now)
      `).run({ ...input, now: now() }).lastInsertRowid)
      this.complete(id, payload)
      return id
    })()
  }

  run(id: number) {
    return this.db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(id) as RunRow | undefined
  }

  runDetail(id: number) {
    return this.db.prepare('SELECT a.*, r.owner, r.name, r.source FROM analysis_runs a JOIN repositories r ON r.id = a.repository_id WHERE a.id = ?')
      .get(id) as (RunRow & { owner: string; name: string; source: string }) | undefined
  }

  runs(filter: { repositoryId?: number; limit?: number } = {}) {
    return this.db.prepare(`
      SELECT a.*, r.owner, r.name, r.source FROM analysis_runs a JOIN repositories r ON r.id = a.repository_id
      WHERE (@repositoryId IS NULL OR a.repository_id = @repositoryId)
      ORDER BY a.created_at DESC, a.id DESC LIMIT @limit
    `).all({ repositoryId: filter.repositoryId ?? null, limit: Math.min(filter.limit ?? 50, 200) }) as (RunRow & { owner: string; name: string; source: string })[]
  }

  /** Atomically claim the oldest runnable job for one worker. */
  claim(workerId: string): RunRow | undefined {
    return this.db.prepare(`
      UPDATE analysis_runs SET status = 'fetching', locked_by = @workerId, locked_at = @now, attempts = attempts + 1,
        started_at = COALESCE(started_at, @now)
      WHERE id = (SELECT id FROM analysis_runs WHERE status = 'queued' AND available_at <= @now ORDER BY available_at, id LIMIT 1)
      RETURNING *
    `).get({ workerId, now: now() }) as RunRow | undefined
  }

  setStage(id: number, status: RunStatus, timings: Record<string, number>) {
    this.db.prepare('UPDATE analysis_runs SET status = ?, stage_timings = ?, locked_at = ? WHERE id = ?').run(status, JSON.stringify(timings), now(), id)
  }

  complete(id: number, payload: { result: unknown; timings: Record<string, number>; mergeBase: string; parserVersion: string; algorithmVersion: string }) {
    this.db.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO analysis_results (analysis_run_id, result_json) VALUES (?, ?)').run(id, JSON.stringify(payload.result))
      this.db.prepare(`
        UPDATE analysis_runs SET status = 'completed', completed_at = ?, stage_timings = ?, merge_base_sha = ?, locked_by = NULL,
          locked_at = NULL, parser_version = ?, algorithm_version = ?, error_code = NULL, error_message = NULL
        WHERE id = ?
      `).run(now(), JSON.stringify(payload.timings), payload.mergeBase, payload.parserVersion, payload.algorithmVersion, id)
    })()
  }

  saveExplanation(id: number, report: { structuredOutput: unknown; modelIdentifier: string; promptVersion: string; status: string; issues: string[]; latencyMs: number }) {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO explanation_reports (analysis_run_id, structured_output, model_identifier, prompt_version, validation_status, validation_issues, latency_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, JSON.stringify(report.structuredOutput), report.modelIdentifier, report.promptVersion, report.status, JSON.stringify(report.issues), report.latencyMs)
      this.db.prepare('UPDATE analysis_runs SET prompt_version = ?, model_identifier = ? WHERE id = ?').run(report.promptVersion, report.modelIdentifier, id)
    })()
  }

  /** Record a failure; retryable failures go back on the queue with exponential backoff until attempts run out. */
  fail(id: number, error: { code: string; message: string; retryable: boolean }, timings: Record<string, number>, maxAttempts: number) {
    const run = this.run(id)
    if (!run) return
    const retry = error.retryable && run.attempts < maxAttempts
    const delayMs = 2 ** run.attempts * 5_000
    this.db.prepare(`
      UPDATE analysis_runs SET status = ?, error_code = ?, error_message = ?, retryable = ?, available_at = ?, locked_by = NULL,
        locked_at = NULL, stage_timings = ?, completed_at = ?
      WHERE id = ?
    `).run(
      retry ? 'queued' : 'failed', error.code, error.message, error.retryable ? 1 : 0,
      new Date(Date.now() + (retry ? delayMs : 0)).toISOString(), JSON.stringify(timings), retry ? null : now(), id,
    )
  }

  /** Jobs whose worker died mid-run are re-queued (or failed once out of attempts). */
  recoverStale(timeoutMs: number, maxAttempts: number) {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString()
    const stale = this.db.prepare(`SELECT * FROM analysis_runs WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) AND locked_at < ?`)
      .all(...ACTIVE_STATUSES, cutoff) as RunRow[]
    for (const run of stale) {
      this.fail(run.id, { code: 'worker_timeout', message: 'The analysis worker stopped responding.', retryable: true }, JSON.parse(run.stage_timings), maxAttempts)
    }
    return stale.length
  }

  result(id: number) {
    const row = this.db.prepare('SELECT result_json FROM analysis_results WHERE analysis_run_id = ?').get(id) as { result_json: string } | undefined
    return row ? JSON.parse(row.result_json) : undefined
  }

  explanation(id: number) {
    const row = this.db.prepare('SELECT * FROM explanation_reports WHERE analysis_run_id = ?').get(id) as
      { structured_output: string; model_identifier: string; prompt_version: string; validation_status: string; validation_issues: string; latency_ms: number; created_at: string } | undefined
    if (!row) return undefined
    return {
      explanation: JSON.parse(row.structured_output),
      modelIdentifier: row.model_identifier,
      promptVersion: row.prompt_version,
      validationStatus: row.validation_status,
      validationIssues: JSON.parse(row.validation_issues) as string[],
      latencyMs: row.latency_ms,
      createdAt: row.created_at,
    }
  }

  /** Returns false when this delivery id was already processed. */
  recordDelivery(deliveryId: string, event: string) {
    const info = this.db.prepare('INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event) VALUES (?, ?)').run(deliveryId, event)
    return info.changes === 1
  }

  linkDelivery(deliveryId: string, runId: number) {
    this.db.prepare('UPDATE webhook_deliveries SET analysis_run_id = ? WHERE delivery_id = ?').run(runId, deliveryId)
  }

  deleteRepository(id: number) {
    return this.db.prepare('DELETE FROM repositories WHERE id = ?').run(id).changes > 0
  }
}
