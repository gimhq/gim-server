import type { MiddlewareHandler } from 'hono'
import type { Database } from '../db'
import type { AppEnv, AuthContext } from './context'
import { unauthorized } from './errors'
import { hashToken } from './ids'

/** Resolves a raw bearer token to its device, or null. Also used by the WebSocket route (`?token=`). */
export function resolveToken(db: Database, token: string | undefined | null): AuthContext | null {
  if (!token)
    return null
  const row = db
    .query<{ deviceId: string, userId: string }, [string]>(
      'SELECT id AS deviceId, user_id AS userId FROM devices WHERE token_hash = ?',
    )
    .get(hashToken(token))
  return row ?? null
}

export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  return match?.[1] ?? null
}

/** Requires `Authorization: Bearer <token>`; sets `c.var.auth` or responds 401. */
export function requireAuth(db: Database): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = resolveToken(db, bearerToken(c.req.header('authorization')))
    if (!auth)
      throw unauthorized()
    c.set('auth', auth)
    await next()
  }
}
