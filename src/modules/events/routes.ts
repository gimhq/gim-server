import type { z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { StoredEvent } from '../../events/store'
import type { App, AppDeps, AppEnv } from '../../shared/context'
import type { EventListSchema } from './schemas'
import { headCursor, isCursorExpired, listEvents } from '../../events/store'
import { bearerToken, resolveToken } from '../../shared/auth'
import { ApiError, errorBody } from '../../shared/errors'
import { upgradeWebSocket } from '../../shared/ws'
import { createListEventsRoute, STREAM_PATH, StreamCloseCode, streamPathDoc } from './schemas'

/** Page size used when replaying the backlog over the WebSocket. */
const STREAM_BATCH = 500

const cursorExpiredMessage = 'Events after this cursor have been pruned; resync and continue from the returned cursor'

function cursorExpired(cursor: number) {
  return new ApiError(410, 'cursor_expired', cursorExpiredMessage, { cursor })
}

/** Resolves on the first `bus` notification for `deviceId`, after `ms`, or on abort. */
function waitForEvent(bus: AppDeps['bus'], deviceId: string, ms: number, signal: AbortSignal, check: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = () => {}
    const finish = () => {
      if (done)
        return
      done = true
      clearTimeout(timer)
      unsubscribe()
      signal.removeEventListener('abort', finish)
      resolve()
    }
    // Subscribe before re-checking so an event committed in between is not missed.
    unsubscribe = bus.subscribe(deviceId, finish)
    if (signal.aborted || check())
      return finish()
    timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish)
  })
}

export function register(app: App, { db, bus, config }: AppDeps): void {
  app.openapi(createListEventsRoute(config.LONGPOLL_MAX_WAIT_SECONDS), async (c) => {
    const { deviceId } = c.get('auth')
    const { cursor, wait, limit } = c.req.valid('query')
    if (isCursorExpired(db, cursor))
      throw cursorExpired(headCursor(db))

    let events = listEvents(db, deviceId, cursor, limit)
    if (events.length === 0 && wait > 0) {
      const ms = Math.min(wait, config.LONGPOLL_MAX_WAIT_SECONDS) * 1000
      await waitForEvent(bus, deviceId, ms, c.req.raw.signal, () => listEvents(db, deviceId, cursor, 1).length > 0)
      events = listEvents(db, deviceId, cursor, limit)
    }
    const body = { events, next_cursor: events.at(-1)?.cursor ?? cursor }
    return c.json(body as z.infer<typeof EventListSchema>, 200)
  })

  // WebSocket route: not covered by the bearer middleware; it authenticates
  // the Authorization header or `?token=` itself.
  app.openAPIRegistry.registerPath(streamPathDoc)
  app.get(STREAM_PATH, async (c: Context<AppEnv>, next) => {
    const query = streamPathDoc.request.query.safeParse(c.req.query())
    if (!query.success)
      return c.json(errorBody('validation_failed', query.error.message), 400)
    const { cursor, token } = query.data
    const auth = resolveToken(db, bearerToken(c.req.header('authorization')) ?? token)

    let lastCursor = cursor
    let closed = false
    let unsubscribe = () => {}

    return upgradeWebSocket(() => ({
      onOpen(_evt, ws) {
        if (!auth)
          return ws.close(StreamCloseCode.Unauthorized, 'unauthorized')
        if (isCursorExpired(db, cursor)) {
          ws.send(JSON.stringify({ type: 'error', ...errorBody('cursor_expired', cursorExpiredMessage), cursor: headCursor(db) }))
          return ws.close(StreamCloseCode.CursorExpired, 'cursor_expired')
        }
        // Everything is synchronous (bun:sqlite + in-process bus), so a drain
        // never interleaves with another: subscribing first and then draining
        // from `lastCursor` yields the backlog followed by live events with
        // no gaps and no duplicates.
        const drain = () => {
          let batch: StoredEvent[]
          do {
            if (closed)
              return
            batch = listEvents(db, auth.deviceId, lastCursor, STREAM_BATCH)
            for (const event of batch) {
              ws.send(JSON.stringify({ type: 'event', event }))
              lastCursor = event.cursor
            }
          } while (batch.length === STREAM_BATCH)
        }
        unsubscribe = bus.subscribe(auth.deviceId, drain)
        drain()
      },
      onClose() {
        closed = true
        unsubscribe()
      },
    }))(c, next)
  })
}
