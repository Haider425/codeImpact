import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config'
import type { Config } from './config'
import { Store } from './db'
import { log } from './log'
import { defaultDeps, runJob } from './pipeline'
import type { PipelineDeps } from './pipeline'

/** Poll the SQLite queue and run one analysis at a time. Several workers may share one database. */
export function startWorker(store: Store, config: Config, deps: PipelineDeps = defaultDeps(config), pollMs = 1000) {
  const workerId = `worker-${randomUUID().slice(0, 8)}`
  let stopped = false
  let wake: (() => void) | undefined

  const loop = async () => {
    log('info', 'worker started', { workerId })
    while (!stopped) {
      store.recoverStale(config.jobTimeoutMs, config.maxAttempts)
      const run = store.claim(workerId)
      if (run) {
        log('info', 'analysis claimed', { workerId, runId: run.id, attempt: run.attempts })
        await runJob(store, run, config, deps)
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, pollMs)
      })
    }
  }
  const done = loop()

  return {
    workerId,
    /** Skip the poll delay after enqueueing from the same process. */
    nudge: () => wake?.(),
    stop: async () => {
      stopped = true
      wake?.()
      await done
    },
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig()
  if (config.showcase) {
    console.error('Showcase mode is read-only; there is nothing for a worker to do.')
    process.exit(1)
  }
  const worker = startWorker(new Store(config.dbPath), config)
  const shutdown = () => void worker.stop().then(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
