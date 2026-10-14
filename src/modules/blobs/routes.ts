import type { App, AppDeps } from '../../shared/context'
import { notImplemented } from '../../shared/errors'
import { downloadBlobRoute, uploadBlobRoute } from './schemas'

export function register(app: App, _deps: AppDeps): void {
  app.openapi(uploadBlobRoute, () => {
    throw notImplemented()
  })

  app.openapi(downloadBlobRoute, () => {
    throw notImplemented()
  })
}
