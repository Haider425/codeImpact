import Database from 'better-sqlite3'
import { existsSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { loadConfig } from './config'
import { Store } from './db'

export interface ExportOptions {
  from: string
  out: string
  ids: number[]
  force?: boolean
  /** Local-checkout analyses store source files from your machine; they are only exported when allowed. */
  allowLocal?: boolean
}

interface SourceRun { id: number; repository_id: number; status: string; source: string; owner: string; name: string }

/** Copy selected completed analyses into a fresh database that the read-only showcase serves. */
export function exportShowcase(options: ExportOptions) {
  if (options.ids.length === 0) throw new Error('Choose at least one analysis id to export (--ids 3,7).')
  if (!existsSync(options.from)) throw new Error(`Source database not found: ${options.from}`)
  if (existsSync(options.out)) {
    if (!options.force) throw new Error(`${options.out} already exists. Pass --force to replace it.`)
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${options.out}${suffix}`, { force: true })
  }

  const source = new Database(options.from, { readonly: true, fileMustExist: true })
  try {
    const runs = source.prepare(`
      SELECT a.id, a.repository_id, a.status, r.source, r.owner, r.name
      FROM analysis_runs a JOIN repositories r ON r.id = a.repository_id
      WHERE a.id IN (${options.ids.map(() => '?').join(',')})
    `).all(...options.ids) as SourceRun[]
    const missing = options.ids.filter((id) => !runs.some((run) => run.id === id))
    if (missing.length > 0) throw new Error(`No analysis with id ${missing.join(', ')}.`)
    const incomplete = runs.filter((run) => run.status !== 'completed')
    if (incomplete.length > 0) throw new Error(`Only completed analyses can be exported; ${incomplete.map((run) => `#${run.id} is ${run.status}`).join(', ')}.`)
    const local = runs.filter((run) => run.source === 'local')
    if (local.length > 0 && !options.allowLocal) {
      throw new Error(`Analyses ${local.map((run) => `#${run.id}`).join(', ')} come from local checkouts and include their source files. Pass --allow-local to publish them.`)
    }

    const target = new Store(options.out)
    const copy = target.db.transaction(() => {
      for (const repositoryId of new Set(runs.map((run) => run.repository_id))) {
        const repository = source.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId) as Record<string, unknown>
        target.db.prepare(`INSERT INTO repositories (id, source, owner, name, github_repository_id, default_branch, local_key, created_at)
          VALUES (@id, @source, @owner, @name, @github_repository_id, @default_branch, NULL, @created_at)`).run(repository)
      }
      for (const run of runs) {
        const row = source.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(run.id) as Record<string, unknown>
        target.db.prepare(`INSERT INTO analysis_runs (id, repository_id, pull_request_number, pull_request_title, pull_request_author, base_ref, head_ref,
            base_sha, head_sha, merge_base_sha, status, trigger, dedupe_key, attempts, available_at, stage_timings, created_at, started_at, completed_at,
            parser_version, algorithm_version, prompt_version, model_identifier)
          VALUES (@id, @repository_id, @pull_request_number, @pull_request_title, @pull_request_author, @base_ref, @head_ref,
            @base_sha, @head_sha, @merge_base_sha, 'completed', @trigger, @dedupe_key, @attempts, @available_at, @stage_timings, @created_at, @started_at, @completed_at,
            @parser_version, @algorithm_version, @prompt_version, @model_identifier)`).run(row)
        const result = source.prepare('SELECT * FROM analysis_results WHERE analysis_run_id = ?').get(run.id)
        if (result) target.db.prepare('INSERT INTO analysis_results (analysis_run_id, result_json, created_at) VALUES (@analysis_run_id, @result_json, @created_at)').run(result)
        const explanation = source.prepare('SELECT * FROM explanation_reports WHERE analysis_run_id = ?').get(run.id)
        if (explanation) {
          target.db.prepare(`INSERT INTO explanation_reports (analysis_run_id, structured_output, model_identifier, prompt_version, validation_status, validation_issues, latency_ms, created_at)
            VALUES (@analysis_run_id, @structured_output, @model_identifier, @prompt_version, @validation_status, @validation_issues, @latency_ms, @created_at)`).run(explanation)
        }
      }
    })
    copy()
    target.db.close()
    return runs.map((run) => ({ id: run.id, repository: `${run.owner}/${run.name}`, source: run.source }))
  } finally {
    source.close()
  }
}

export function listCompleted(from: string) {
  const source = new Database(from, { readonly: true, fileMustExist: true })
  try {
    return source.prepare(`
      SELECT a.id, r.source, r.owner, r.name, a.pull_request_number AS number, a.pull_request_title AS title, a.completed_at
      FROM analysis_runs a JOIN repositories r ON r.id = a.repository_id
      WHERE a.status = 'completed' ORDER BY a.id
    `).all() as { id: number; source: string; owner: string; name: string; number: number | null; title: string | null; completed_at: string }[]
  } finally {
    source.close()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig({ ...process.env, CODEIMPACT_SHOWCASE: undefined })
  const { values } = parseArgs({
    options: {
      ids: { type: 'string' },
      list: { type: 'boolean', default: false },
      from: { type: 'string', default: config.dbPath },
      out: { type: 'string', default: join(config.dataDir, 'showcase.db') },
      force: { type: 'boolean', default: false },
      'allow-local': { type: 'boolean', default: false },
    },
  })
  try {
    if (values.list || !values.ids) {
      console.log(`Completed analyses in ${values.from}:`)
      for (const run of listCompleted(values.from!)) {
        console.log(`  #${run.id}  ${run.source === 'local' ? 'local ' : ''}${run.owner}/${run.name}${run.number ? `#${run.number}` : ''}  ${run.title ?? ''}`)
      }
      if (!values.ids) console.log('\nExport with: npm run showcase:export -- --ids 3,7 [--out data/showcase.db] [--force] [--allow-local]')
    } else {
      const ids = values.ids.split(',').map((id) => Number(id.trim())).filter((id) => Number.isInteger(id) && id > 0)
      const exported = exportShowcase({ from: values.from!, out: values.out!, ids, force: values.force, allowLocal: values['allow-local'] })
      console.log(`Exported ${exported.length} analyses to ${values.out}:`)
      for (const run of exported) console.log(`  #${run.id}  ${run.repository}${run.source === 'local' ? ' (local checkout)' : ''}`)
      console.log('\nServe it read-only with: CODEIMPACT_SHOWCASE=1 npm run server')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
