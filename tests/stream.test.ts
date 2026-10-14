import type { Database } from '../src/db'
import type { EventBus } from '../src/events/bus'
import { afterEach, describe, expect, it } from 'bun:test'
import { appendEvent, pruneEvents } from '../src/events/store'
import { websocket } from '../src/shared/ws'
import { makeTestApp, registerDevice } from './helpers'

const servers: ReturnType<typeof Bun.serve>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => s.stop(true)))
})

function emit(db: Database, bus: EventBus, deviceIds: string[], available: number, now = Date.now()) {
  const event = appendEvent(db, { type: 'keypackages.low', data: { available }, deviceIds, now })!
  bus.publish(deviceIds)
  return event
}

async function setup() {
  const t = makeTestApp()
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: t.app.fetch, websocket })
  servers.push(server)
  const a = await registerDevice(t.app, 'alice')
  const b = await registerDevice(t.app, 'bob')
  return { ...t, a, b, url: `ws://127.0.0.1:${server.port}/v1/stream` }
}

/** WebSocket client that records frames and the close event. */
function connect(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, headers ? { headers } : undefined)
  const frames: any[] = []
  const waiters: (() => void)[] = []
  const notify = () => waiters.splice(0).forEach(w => w())
  let closeEvent: CloseEvent | undefined
  ws.onmessage = (e) => {
    frames.push(JSON.parse(String(e.data)))
    notify()
  }
  ws.onclose = (e) => {
    closeEvent = e
    notify()
  }
  const until = async (cond: () => boolean, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs
    while (!cond()) {
      if (Date.now() > deadline)
        throw new Error(`timeout; frames=${JSON.stringify(frames)}`)
      await Promise.race([new Promise<void>(r => waiters.push(r)), Bun.sleep(50)])
    }
  }
  const opened = new Promise<void>((resolve) => {
    ws.onopen = () => resolve()
  })
  return {
    ws,
    frames,
    opened,
    frameCount: (n: number) => until(() => frames.length >= n),
    closed: async () => {
      await until(() => closeEvent !== undefined)
      return closeEvent!
    },
  }
}

const cursors = (frames: any[]) => frames.map(f => f.event.cursor)

describe('WebSocket /v1/stream', () => {
  it('sends the backlog, then live events in order', async () => {
    const { db, bus, a, url } = await setup()
    const backlog = [1, 2, 3].map(n => emit(db, bus, [a.device_id], n))

    const client = connect(`${url}?token=${a.token}`)
    await client.frameCount(3)
    expect(client.frames).toEqual(backlog.map(event => ({ type: 'event', event })))

    const live = [4, 5].map(n => emit(db, bus, [a.device_id], n))
    await client.frameCount(5)
    expect(cursors(client.frames)).toEqual([...backlog, ...live].map(e => e.cursor))
    client.ws.close()
  })

  it('accepts the Authorization header and resumes from a cursor', async () => {
    const { db, bus, a, url } = await setup()
    const events = [1, 2, 3].map(n => emit(db, bus, [a.device_id], n))

    const client = connect(`${url}?cursor=${events[1]!.cursor}`, { Authorization: `Bearer ${a.token}` })
    await client.opened
    const live = emit(db, bus, [a.device_id], 4)
    await client.frameCount(2)
    await Bun.sleep(50)
    expect(cursors(client.frames)).toEqual([events[2]!.cursor, live.cursor])
    client.ws.close()
  })

  it('closes with 4401 on a bad or missing token', async () => {
    const { url } = await setup()
    expect((await connect(`${url}?token=bad`).closed()).code).toBe(4401)
    expect((await connect(url).closed()).code).toBe(4401)
  })

  it('sends an error frame and closes with 4410 on an expired cursor', async () => {
    const { db, bus, a, url } = await setup()
    emit(db, bus, [a.device_id], 1, 100)
    const head = emit(db, bus, [a.device_id], 2, 200)
    pruneEvents(db, 300)

    const client = connect(`${url}?cursor=0&token=${a.token}`)
    const close = await client.closed()
    expect(close.code).toBe(4410)
    expect(client.frames).toEqual([
      { type: 'error', error: { code: 'cursor_expired', message: expect.any(String) }, cursor: head.cursor },
    ])
  })

  it('never delivers another device\'s events', async () => {
    const { db, bus, a, b, url } = await setup()
    emit(db, bus, [a.device_id], 1)
    const shared = emit(db, bus, [a.device_id, b.device_id], 2)

    const client = connect(`${url}?token=${b.token}`)
    await client.frameCount(1)
    emit(db, bus, [a.device_id], 3)
    const mine = emit(db, bus, [b.device_id], 4)
    await client.frameCount(2)
    await Bun.sleep(50)
    expect(cursors(client.frames)).toEqual([shared.cursor, mine.cursor])
    client.ws.close()
  })
})
