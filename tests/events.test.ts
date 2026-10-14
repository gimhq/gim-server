import type { Database } from '../src/db'
import type { EventBus } from '../src/events/bus'
import { describe, expect, it } from 'bun:test'
import { appendEvent, pruneEvents } from '../src/events/store'
import { auth, makeTestApp, registerDevice } from './helpers'

function emit(db: Database, bus: EventBus, deviceIds: string[], available: number, now = Date.now()) {
  const event = appendEvent(db, { type: 'keypackages.low', data: { available }, deviceIds, now })!
  bus.publish(deviceIds)
  return event
}

async function setup() {
  const t = makeTestApp()
  const a = await registerDevice(t.app, 'alice')
  const b = await registerDevice(t.app, 'bob')
  const get = async (token: string, query = '', init: RequestInit = {}) =>
    t.app.request(`/v1/events${query}`, { ...init, headers: auth(token) })
  return { ...t, a, b, get }
}

describe('GET /v1/events', () => {
  it('requires a bearer token', async () => {
    const { app } = makeTestApp()
    expect((await app.request('/v1/events')).status).toBe(401)
    const res = await app.request('/v1/events', { headers: auth('nope') })
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error.code).toBe('unauthorized')
  })

  it('returns an empty list with the input cursor', async () => {
    const { a, get } = await setup()
    const res = await get(a.token, '?cursor=0')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ events: [], next_cursor: 0 })
  })

  it('filters events per device', async () => {
    const { db, bus, a, b, get } = await setup()
    const e1 = emit(db, bus, [a.device_id], 1)
    const e2 = emit(db, bus, [a.device_id, b.device_id], 2)

    const resA = await (await get(a.token)).json() as any
    expect(resA.events.map((e: { cursor: number }) => e.cursor)).toEqual([e1.cursor, e2.cursor])
    expect(resA.events[0]).toEqual(e1)

    const resB = await (await get(b.token)).json() as any
    expect(resB).toEqual({ events: [e2], next_cursor: e2.cursor })
  })

  it('pages with limit and resumes from next_cursor', async () => {
    const { db, bus, a, get } = await setup()
    const events = [1, 2, 3].map(n => emit(db, bus, [a.device_id], n))

    const page1 = await (await get(a.token, '?limit=2')).json() as any
    expect(page1).toEqual({ events: events.slice(0, 2), next_cursor: events[1]!.cursor })

    const page2 = await (await get(a.token, `?limit=2&cursor=${page1.next_cursor}`)).json() as any
    expect(page2).toEqual({ events: [events[2]], next_cursor: events[2]!.cursor })

    const page3 = await (await get(a.token, `?cursor=${page2.next_cursor}`)).json() as any
    expect(page3).toEqual({ events: [], next_cursor: page2.next_cursor })

    const late = emit(db, bus, [a.device_id], 4)
    const page4 = await (await get(a.token, `?cursor=${page2.next_cursor}`)).json() as any
    expect(page4).toEqual({ events: [late], next_cursor: late.cursor })
  })

  it('rejects invalid query parameters', async () => {
    const { a, get, config } = await setup()
    expect((await get(a.token, '?limit=0')).status).toBe(400)
    expect((await get(a.token, `?wait=${config.LONGPOLL_MAX_WAIT_SECONDS + 1}`)).status).toBe(400)
  })

  it('responds 410 with the head cursor once the cursor is pruned', async () => {
    const { db, bus, a, get } = await setup()
    emit(db, bus, [a.device_id], 1, 100)
    emit(db, bus, [a.device_id], 2, 200)
    const head = emit(db, bus, [a.device_id], 3, 300)
    pruneEvents(db, 250)

    const res = await get(a.token, '?cursor=0')
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({
      error: { code: 'cursor_expired', message: expect.any(String) },
      cursor: head.cursor,
    })

    const ok = await (await get(a.token, `?cursor=${head.cursor - 1}`)).json() as any
    expect(ok).toEqual({ events: [head], next_cursor: head.cursor })
  })

  it('long-polls until an event for the device arrives', async () => {
    const { db, bus, a, b, get } = await setup()
    const started = Date.now()
    const pending = get(a.token, '?wait=1')
    await Bun.sleep(50)
    emit(db, bus, [b.device_id], 1) // other device: must not wake the poll
    await Bun.sleep(50)
    const event = emit(db, bus, [a.device_id], 2)

    const res = await pending
    expect(await res.json()).toEqual({ events: [event], next_cursor: event.cursor })
    expect(Date.now() - started).toBeLessThan(900)
  })

  it('long-poll returns empty after the timeout', async () => {
    const { a, get } = await setup()
    const started = Date.now()
    const res = await get(a.token, '?cursor=0&wait=1')
    expect(await res.json()).toEqual({ events: [], next_cursor: 0 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(950)
  })

  it('stops waiting when the client aborts', async () => {
    const { a, get } = await setup()
    const controller = new AbortController()
    const started = Date.now()
    const pending = get(a.token, '?wait=1', { signal: controller.signal })
    await Bun.sleep(50)
    controller.abort()
    await pending.catch(() => {})
    expect(Date.now() - started).toBeLessThan(900)
  })
})
