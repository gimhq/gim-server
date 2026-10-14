import type { App, AppDeps } from '../../shared/context'
import { notFound } from '../../shared/errors'
import { findUserByHandleRoute, getUserRoute, listUserDevicesRoute } from './schemas'

interface UserRow {
  user_id: string
  handle: string
  display_name: string
}

export function register(app: App, { db }: AppDeps): void {
  const userBy = (column: 'id' | 'handle', value: string) =>
    db
      .query<UserRow, [string]>(`SELECT id AS user_id, handle, display_name FROM users WHERE ${column} = ?`)
      .get(value)

  app.openapi(findUserByHandleRoute, (c) => {
    const user = userBy('handle', c.req.valid('query').handle)
    if (!user)
      throw notFound('User')
    return c.json(user, 200)
  })

  app.openapi(getUserRoute, (c) => {
    const user = userBy('id', c.req.valid('param').user_id)
    if (!user)
      throw notFound('User')
    return c.json(user, 200)
  })

  app.openapi(listUserDevicesRoute, (c) => {
    const { user_id } = c.req.valid('param')
    if (!userBy('id', user_id))
      throw notFound('User')
    const devices = db
      .query<{ device_id: string, created_at: number }, [string]>(
        'SELECT id AS device_id, created_at FROM devices WHERE user_id = ? ORDER BY created_at, rowid',
      )
      .all(user_id)
    return c.json({ devices }, 200)
  })
}
