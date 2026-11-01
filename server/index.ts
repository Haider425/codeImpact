import { join } from 'node:path'
import { buildApp } from './app'
import { loadConfig } from './config'
import { Store } from './db'
import { log } from './log'
import { defaultDeps } from './pipeline'
import { startWorker } from './worker'

const config = loadConfig()
const store = new Store(join(config.dataDir, 'codeimpact.db'))
const deps = defaultDeps(config)
const worker = config.inlineWorker ? startWorker(store, config, deps) : undefined
const app = await buildApp({ store, config, github: deps.github, onEnqueued: worker?.nudge })

await app.listen({ port: config.port, host: config.host })
log('info', 'server listening', {
  url: `http://${config.host}:${config.port}`,
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
