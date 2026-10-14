import type { App, AppDeps } from '../../shared/context'
import { notImplemented } from '../../shared/errors'
import { listMessagesRoute, sendMessageRoute } from './schemas'

export function register(app: App, _deps: AppDeps): void {
  app.openapi(sendMessageRoute, () => {
    throw notImplemented()
  })

  app.openapi(listMessagesRoute, () => {
    throw notImplemented()
  })
}
