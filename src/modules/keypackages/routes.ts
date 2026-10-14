import type { App, AppDeps } from '../../shared/context'
import { notImplemented } from '../../shared/errors'
import { claimKeyPackagesRoute, countKeyPackagesRoute, uploadKeyPackagesRoute } from './schemas'

export function register(app: App, _deps: AppDeps): void {
  app.openapi(uploadKeyPackagesRoute, () => {
    throw notImplemented()
  })

  app.openapi(countKeyPackagesRoute, () => {
    throw notImplemented()
  })

  app.openapi(claimKeyPackagesRoute, () => {
    throw notImplemented()
  })
}
