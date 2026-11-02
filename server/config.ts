import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_MAX_DEPTH } from '../src/analysis/engine'

export const ROOT = resolve(import.meta.dirname, '..')

/** Minimal .env loader: real environment variables always win. */
function loadDotEnv() {
  const path = join(ROOT, '.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!match || line.trimStart().startsWith('#') || process.env[match[1]] !== undefined) continue
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

loadDotEnv()

/** `name=path;other=path` — local checkouts that may be analyzed. Nothing else on disk is reachable. */
function parseLocalRepositories(value: string | undefined) {
  const repositories = new Map<string, string>()
  for (const entry of (value ?? '').split(';')) {
    const [name, ...rest] = entry.split('=')
    if (name?.trim() && rest.length) repositories.set(name.trim(), resolve(rest.join('=').trim()))
  }
  return repositories
}

export interface Config {
  port: number
  host: string
  dataDir: string
  /** SQLite file for analyses. Showcase mode reads an exported, separate database. */
  dbPath: string
  /** Read-only mode: serve saved reports, refuse new analyses and every other write. */
  showcase: boolean
  wasmBasePath: string
  githubToken?: string
  webhookSecret?: string
  localRepositories: Map<string, string>
  maxDepth: number
  inlineWorker: boolean
  maxAttempts: number
  jobTimeoutMs: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    dataDir: resolve(env.CODEIMPACT_DATA_DIR ?? join(ROOT, 'data')),
    dbPath: resolve(env.CODEIMPACT_DB ?? join(env.CODEIMPACT_DATA_DIR ?? join(ROOT, 'data'), env.CODEIMPACT_SHOWCASE === '1' ? 'showcase.db' : 'codeimpact.db')),
    showcase: env.CODEIMPACT_SHOWCASE === '1',
    wasmBasePath: join(ROOT, 'public/wasm'),
    githubToken: env.GITHUB_TOKEN || undefined,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET || undefined,
    localRepositories: parseLocalRepositories(env.CODEIMPACT_LOCAL_REPOS),
    maxDepth: Number(env.CODEIMPACT_MAX_DEPTH ?? DEFAULT_MAX_DEPTH),
    inlineWorker: env.CODEIMPACT_WORKER !== 'external',
    maxAttempts: Number(env.CODEIMPACT_MAX_ATTEMPTS ?? 3),
    jobTimeoutMs: Number(env.CODEIMPACT_JOB_TIMEOUT_MS ?? 10 * 60_000),
  }
}
