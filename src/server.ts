import type { Config } from './config'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { createApp } from './app'
import { openDatabase } from './db'
import { createEventBus } from './events/bus'
import { pruneEvents } from './events/store'
import { createLogger } from './shared/logger'
import { websocket } from './shared/ws'

const DAY_MS = 24 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

export function startServer(config: Config) {
  const logger = createLogger(config.LOG_LEVEL)
  mkdirSync(join(config.DATA_DIR, 'blobs'), { recursive: true })
  const db = openDatabase(config.DATABASE_PATH)
  const bus = createEventBus()
  const app = createApp({ db, config, bus, logger })

  const prune = () => {
    const deleted = pruneEvents(db, Date.now() - config.EVENT_RETENTION_DAYS * DAY_MS)
    if (deleted > 0)
      logger.info('pruned events', { deleted })
  }
  prune()
  const pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS)

  const server = Bun.serve({
    port: config.PORT,
    hostname: config.HOST,
    // Blob uploads are the largest bodies; the blobs route enforces the exact limit.
    maxRequestBodySize: config.MAX_BLOB_BYTES + 1024 * 1024,
    // Long-poll requests may be held for up to LONGPOLL_MAX_WAIT_SECONDS.
    idleTimeout: Math.min(255, config.LONGPOLL_MAX_WAIT_SECONDS + 10),
    fetch: app.fetch,
    websocket,
  })
  logger.info('listening', { url: server.url.toString() })

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping)
      return
    stopping = true
    logger.info('shutting down', { signal })
    clearInterval(pruneTimer)
    await server.stop(true)
    db.close()
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  return { server, db, shutdown }
}
