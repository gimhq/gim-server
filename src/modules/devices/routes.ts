import type { App, AppDeps } from '../../shared/context'
import { headCursor } from '../../events/store'
import { notFound } from '../../shared/errors'
import { hashToken, newId, newToken } from '../../shared/ids'
import { meRoute, registerDeviceRoute } from './schemas'

export function register(app: App, { db, now }: AppDeps): void {
  app.openapi(registerDeviceRoute, (c) => {
    const { handle, display_name } = c.req.valid('json')
    const token = newToken()
    const result = db.transaction(() => {
      const ts = now()
      const userId = db
        .query<{ id: string }, [string, string, string, number]>(
          `INSERT INTO users (id, handle, display_name, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (handle) DO UPDATE SET handle = excluded.handle
           RETURNING id`,
        )
        .get(newId('u'), handle, display_name, ts)!
        .id
      const deviceId = newId('d')
      db.query('INSERT INTO devices (id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(deviceId, userId, hashToken(token), ts)
      return { user_id: userId, device_id: deviceId, token, cursor: headCursor(db) }
    })()
    return c.json(result, 201)
  })

  app.openapi(meRoute, (c) => {
    const { userId, deviceId } = c.get('auth')
    const user = db
      .query<{ handle: string, display_name: string }, [string]>('SELECT handle, display_name FROM users WHERE id = ?')
      .get(userId)
    if (!user)
      throw notFound('User')
    return c.json({ user_id: userId, device_id: deviceId, ...user }, 200)
  })
}
