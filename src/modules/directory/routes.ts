import type { App, AppDeps } from '../../shared/context'
import { notImplemented } from '../../shared/errors'
import { findUserByHandleRoute, getUserRoute, listUserDevicesRoute } from './schemas'

export function register(app: App, _deps: AppDeps): void {
  app.openapi(findUserByHandleRoute, () => {
    throw notImplemented()
  })

  app.openapi(getUserRoute, () => {
    throw notImplemented()
  })

  app.openapi(listUserDevicesRoute, () => {
    throw notImplemented()
  })
}
