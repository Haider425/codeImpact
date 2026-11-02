import { buildApp } from './app'
import { loadConfig } from './config'
import { Store } from './db'
import { log } from './log'
import { defaultDeps } from './pipeline'
import { startWorker } from './worker'

const config = loadConfig()
const store = new Store(config.dbPath)
const deps = defaultDeps(config)
// A showcase only serves saved reports, so it never runs analyses.
const worker = config.inlineWorker && !config.showcase ? startWorker(store, config, deps) : undefined
const app = await buildApp({ store, config, github: deps.github, onEnqueued: worker?.nudge })

await app.listen({ port: config.port, host: config.host })
log('info', 'server listening', {
  url: `http://${config.host}:${config.port}`,
  mode: config.showcase ? 'showcase (read-only)' : 'analysis',
  database: config.dbPath,
  worker: worker ? 'inline' : 'external',
  githubToken: Boolean(config.githubToken),
  localRepositories: [...config.localRepositories.keys()],
})

const shutdown = async () => {
  await app.close()
  await worker?.stop()
  store.db.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
