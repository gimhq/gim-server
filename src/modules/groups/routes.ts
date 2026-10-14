import type { App, AppDeps } from '../../shared/context'
import { notImplemented } from '../../shared/errors'
import { addMembersRoute, createGroupRoute, getGroupRoute, listGroupsRoute, removeMemberRoute } from './schemas'

export function register(app: App, _deps: AppDeps): void {
  app.openapi(createGroupRoute, () => {
    throw notImplemented()
  })

  app.openapi(listGroupsRoute, () => {
    throw notImplemented()
  })

  app.openapi(getGroupRoute, () => {
    throw notImplemented()
  })

  app.openapi(addMembersRoute, () => {
    throw notImplemented()
  })

  app.openapi(removeMemberRoute, () => {
    throw notImplemented()
  })
}
