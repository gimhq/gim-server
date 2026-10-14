import type { App, AppDeps } from '../../shared/context'
import { notImplemented } from '../../shared/errors'
import { createListEventsRoute, STREAM_PATH, streamPathDoc } from './schemas'

export function register(app: App, { config }: AppDeps): void {
  app.openapi(createListEventsRoute(config.LONGPOLL_MAX_WAIT_SECONDS), () => {
    throw notImplemented()
  })

  // WebSocket route: not covered by the bearer middleware; it authenticates
  // the Authorization header or `?token=` itself with `resolveToken` and
  // upgrades via `upgradeWebSocket` from src/shared/ws.ts.
  app.openAPIRegistry.registerPath(streamPathDoc)
  app.get(STREAM_PATH, () => {
    throw notImplemented()
  })
}
