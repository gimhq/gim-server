import type { RegisteredDevice, TestApp } from './helpers'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headCursor, pruneEvents } from '../src/events/store'
import { websocket } from '../src/shared/ws'
import { auth, jsonHeaders, makeTestApp, registerDevice } from './helpers'

const DAY_MS = 24 * 60 * 60 * 1000
const b64 = (s: string) => Buffer.from(s).toString('base64')

let clock = 1_760_000_000_000
let dataDir: string
let app: TestApp
let db: ReturnType<typeof makeTestApp>['db']

let alice: RegisteredDevice
let alice2: RegisteredDevice
let bob: RegisteredDevice
let carol: RegisteredDevice
let mallory: RegisteredDevice
let groupId: string

/** Last processed event cursor per device, advanced by `drain`. */
const cursors = new Map<string, number>()

function request(token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: jsonHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function ok(res: Response, status = 200): Promise<any> {
  const text = await res.text()
  expect(res.status, text).toBe(status)
  return JSON.parse(text)
}

async function send(device: RegisteredDevice, body: { client_id: string, kind: string, epoch: number, payload: string, recipients?: string[] }) {
  return request(device.token, 'POST', `/v1/groups/${groupId}/messages`, body)
}

/** Fetches every pending event for `device` page by page, following next_cursor. */
async function drain(device: RegisteredDevice, limit = 2): Promise<any[]> {
  const all: any[] = []
  let cursor = cursors.get(device.device_id) ?? device.cursor
  for (;;) {
    const page = await ok(await request(device.token, 'GET', `/v1/events?cursor=${cursor}&limit=${limit}`))
    all.push(...page.events)
    expect(page.next_cursor).toBe(page.events.at(-1)?.cursor ?? cursor)
    cursor = page.next_cursor
    if (page.events.length < limit)
      break
  }
  cursors.set(device.device_id, cursor)
  return all
}

/** Compact event description: type plus message kind/seq or membership change. */
function describeEvent(e: any): string {
  if (e.type === 'message')
    return `message:${e.data.kind}:${e.data.seq}`
  if (e.type === 'keypackages.low')
    return `keypackages.low:${e.data.available}`
  return `${e.type}:${e.data.device_ids.join(',')}`
}

async function expectMalloryEmpty() {
  expect(await drain(mallory)).toEqual([])
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gim-e2e-'))
  ;({ app, db } = makeTestApp({ now: () => clock, env: { DATA_DIR: dataDir } }))
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('e2e: two-party group, membership changes, resync, blobs', () => {
  it('registers users and devices', async () => {
    alice = await registerDevice(app, 'alice', 'Alice')
    alice2 = await registerDevice(app, 'alice', 'Alice')
    bob = await registerDevice(app, 'bob', 'Bob')
    carol = await registerDevice(app, 'carol', 'Carol')
    mallory = await registerDevice(app, 'mallory', 'Mallory')

    expect(alice2.user_id).toBe(alice.user_id)
    expect(alice2.device_id).not.toBe(alice.device_id)
    const devices = await ok(await request(bob.token, 'GET', `/v1/users/${alice.user_id}/devices`))
    expect(devices.devices.map((d: any) => d.device_id)).toEqual([alice.device_id, alice2.device_id])
    const found = await ok(await request(alice.token, 'GET', '/v1/users?handle=bob'))
    expect(found.user_id).toBe(bob.user_id)
    await expectMalloryEmpty()
  })

  it('uploads and claims key packages', async () => {
    for (const d of [alice, alice2, bob, carol, mallory]) {
      const counts = await ok(await request(d.token, 'POST', '/v1/keypackages', {
        key_packages: [1, 2, 3].map(n => b64(`kp-${d.device_id}-${n}`)),
        last_resort: b64(`kp-${d.device_id}-last`),
      }))
      expect(counts).toEqual({ available: 3, has_last_resort: true })
    }

    const claimed = await ok(await request(alice.token, 'POST', '/v1/keypackages/claim', { device_ids: [bob.device_id] }))
    expect(claimed).toEqual({
      key_packages: [{ device_id: bob.device_id, key_package: b64(`kp-${bob.device_id}-1`), last_resort: false }],
      missing: [],
    })
    expect(await ok(await request(bob.token, 'GET', '/v1/keypackages/count'))).toEqual({ available: 2, has_last_resort: true })
  })

  it('creates a group and delivers commit, welcome and application messages', async () => {
    const group = await ok(await request(alice.token, 'POST', '/v1/groups', {
      kind: 'group',
      member_device_ids: [alice2.device_id, bob.device_id],
    }), 201)
    groupId = group.group_id
    expect(group.epoch).toBe(0)
    expect(group.members.map((m: any) => m.device_id).sort()).toEqual([alice.device_id, alice2.device_id, bob.device_id].sort())

    const commit = await ok(await send(alice, { client_id: 'c-1', kind: 'commit', epoch: 0, payload: b64('commit-0') }), 201)
    expect(commit).toMatchObject({ seq: 1, epoch: 0, kind: 'commit', sender_device_id: alice.device_id, sender_user_id: alice.user_id })
    const welcome = await ok(await send(alice, { client_id: 'w-1', kind: 'welcome', epoch: 1, payload: b64('welcome-bob'), recipients: [bob.device_id] }), 201)
    expect(welcome).toMatchObject({ seq: 2, recipients: [bob.device_id] })
    await ok(await send(alice, { client_id: 'a-1', kind: 'application', epoch: 1, payload: b64('hello bob') }), 201)
    await ok(await send(bob, { client_id: 'a-1', kind: 'application', epoch: 1, payload: b64('hi alice') }), 201)

    const after = await ok(await request(bob.token, 'GET', `/v1/groups/${groupId}`))
    expect(after.epoch).toBe(1)
    await expectMalloryEmpty()
  })

  it('fans events out per device and resumes from next_cursor', async () => {
    const bobEvents = await drain(bob)
    expect(bobEvents.map(describeEvent)).toEqual([
      'keypackages.low:2',
      `group.member_added:${[alice.device_id, alice2.device_id, bob.device_id].join(',')}`,
      'message:commit:1',
      'message:welcome:2',
      'message:application:3',
    ])
    expect(bobEvents[3].data.payload).toBe(b64('welcome-bob'))
    // Cursors are global: strictly increasing but not necessarily contiguous per device.
    const bobCursors = bobEvents.map(e => e.cursor)
    expect(bobCursors).toEqual([...bobCursors].sort((a, b) => a - b))
    expect(await drain(bob)).toEqual([])

    // alice2 sees the commit and both application messages, but not bob's welcome.
    expect((await drain(alice2)).map(describeEvent)).toEqual([
      `group.member_added:${[alice.device_id, alice2.device_id, bob.device_id].join(',')}`,
      'message:commit:1',
      'message:application:3',
      'message:application:4',
    ])
    // The sender never receives its own messages.
    expect((await drain(alice)).map(describeEvent)).toEqual([
      `group.member_added:${[alice.device_id, alice2.device_id, bob.device_id].join(',')}`,
      'message:application:4',
    ])

    // History hides the welcome from non-recipients.
    const history = await ok(await request(alice2.token, 'GET', `/v1/groups/${groupId}/messages`))
    expect(history.messages.map((m: any) => m.seq)).toEqual([1, 3, 4])
    await expectMalloryEmpty()
  })

  it('denies outsiders access to the group', async () => {
    for (const path of [`/v1/groups/${groupId}`, `/v1/groups/${groupId}/messages`]) {
      const res = await request(mallory.token, 'GET', path)
      expect(res.status).toBe(403)
      expect((await res.json() as any).error.code).toBe('not_member')
    }
    const res = await send(mallory, { client_id: 'x', kind: 'application', epoch: 1, payload: b64('spam') })
    expect(res.status).toBe(403)
    expect((await ok(await request(mallory.token, 'GET', '/v1/groups'))).groups).toEqual([])
    await expectMalloryEmpty()
  })

  it('rejects stale commits and deduplicates by client_id', async () => {
    const stale = await send(alice2, { client_id: 'c-stale', kind: 'commit', epoch: 0, payload: b64('stale') })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'stale_epoch' }, current_epoch: 1 })

    const replay = await ok(await send(alice, { client_id: 'a-1', kind: 'application', epoch: 1, payload: b64('different body') }), 200)
    expect(replay).toMatchObject({ seq: 3, payload: b64('hello bob') })
    expect(await drain(bob)).toEqual([])
    expect(await drain(alice2)).toEqual([])
  })

  it('adds carol and removes bob', async () => {
    const claimed = await ok(await request(alice.token, 'POST', '/v1/keypackages/claim', { device_ids: [carol.device_id] }))
    expect(claimed.key_packages[0].device_id).toBe(carol.device_id)

    await ok(await send(alice, { client_id: 'c-2', kind: 'commit', epoch: 1, payload: b64('commit-1 add carol') }), 201)
    await ok(await send(alice, { client_id: 'w-2', kind: 'welcome', epoch: 2, payload: b64('welcome-carol'), recipients: [carol.device_id] }), 201)
    const added = await ok(await request(alice.token, 'POST', `/v1/groups/${groupId}/members`, { device_ids: [carol.device_id] }))
    expect(added.members.map((m: any) => m.device_id)).toContain(carol.device_id)

    await ok(await send(alice, { client_id: 'c-3', kind: 'commit', epoch: 2, payload: b64('commit-2 remove bob') }), 201)
    const removed = await ok(await request(alice.token, 'DELETE', `/v1/groups/${groupId}/members/${bob.device_id}`))
    expect(removed.members.map((m: any) => m.device_id)).not.toContain(bob.device_id)
    expect(removed.epoch).toBe(3)

    await ok(await send(alice, { client_id: 'a-2', kind: 'application', epoch: 3, payload: b64('without bob') }), 201)
    await ok(await send(carol, { client_id: 'a-1', kind: 'application', epoch: 3, payload: b64('hi from carol') }), 201)

    expect((await drain(bob)).map(describeEvent)).toEqual([
      'message:commit:5',
      `group.member_added:${carol.device_id}`,
      'message:commit:7',
      `group.member_removed:${bob.device_id}`,
    ])
    expect((await drain(carol)).map(describeEvent)).toEqual([
      'keypackages.low:2',
      'message:welcome:6',
      `group.member_added:${carol.device_id}`,
      'message:commit:7',
      `group.member_removed:${bob.device_id}`,
      'message:application:8',
    ])
    expect((await drain(alice2)).map(describeEvent)).toEqual([
      'message:commit:5',
      `group.member_added:${carol.device_id}`,
      'message:commit:7',
      `group.member_removed:${bob.device_id}`,
      'message:application:8',
      'message:application:9',
    ])

    // Nothing reaches bob after his removal, and he loses access.
    await ok(await send(alice2, { client_id: 'a-1', kind: 'application', epoch: 3, payload: b64('still without bob') }), 201)
    expect(await drain(bob)).toEqual([])
    expect((await request(bob.token, 'GET', `/v1/groups/${groupId}/messages`)).status).toBe(403)
    await expectMalloryEmpty()
  })

  it('returns 410 with the head cursor after pruning, then backfills by seq', async () => {
    const carolCursor = cursors.get(carol.device_id)!
    clock += 8 * DAY_MS
    await ok(await send(alice, { client_id: 'a-3', kind: 'application', epoch: 3, payload: b64('after a week') }), 201)
    expect(pruneEvents(db, clock - 7 * DAY_MS)).toBeGreaterThan(0)

    const expired = await request(carol.token, 'GET', `/v1/events?cursor=${carolCursor}`)
    expect(expired.status).toBe(410)
    const body = await expired.json() as any
    expect(body).toMatchObject({ error: { code: 'cursor_expired' }, cursor: headCursor(db) })

    // Resync: backfill message history after the last seq carol processed (8), then continue from the head cursor.
    const backfill = await ok(await request(carol.token, 'GET', `/v1/groups/${groupId}/messages?after_seq=8`))
    expect(backfill.messages.map((m: any) => [m.seq, Buffer.from(m.payload, 'base64').toString()])).toEqual([
      [9, 'hi from carol'],
      [10, 'still without bob'],
      [11, 'after a week'],
    ])
    expect(backfill.has_more).toBe(false)
    const resumed = await ok(await request(carol.token, 'GET', `/v1/events?cursor=${body.cursor}`))
    expect(resumed).toEqual({ events: [], next_cursor: body.cursor })

    // Every device behind the pruned range gets 410, including outsiders.
    expect((await request(mallory.token, 'GET', `/v1/events?cursor=${cursors.get(mallory.device_id)}`)).status).toBe(410)
    cursors.set(mallory.device_id, body.cursor)
    await expectMalloryEmpty()
  })

  it('uploads a blob and downloads a byte range', async () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xFF)
    const created = await ok(await app.request('/v1/blobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...auth(alice.token) },
      body: bytes,
    }), 201)
    expect(created.size).toBe(1000)

    const ranged = await app.request(`/v1/blobs/${created.blob_id}`, { headers: { ...auth(carol.token), Range: 'bytes=100-199' } })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(100, 200))

    const full = await app.request(`/v1/blobs/${created.blob_id}`, { headers: auth(carol.token) })
    expect(full.status).toBe(200)
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes)
  })
})

describe('e2e: real server and WebSocket stream', () => {
  it('pushes messages sent over HTTP to a connected device', async () => {
    const t = makeTestApp()
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: t.app.fetch, websocket })
    try {
      const base = `http://127.0.0.1:${server.port}`
      const register = async (handle: string) => {
        const res = await fetch(`${base}/v1/devices`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ handle, display_name: handle }) })
        return ok(res, 201) as Promise<RegisteredDevice>
      }
      const a = await register('alice')
      const b = await register('bob')
      expect((await fetch(`${base}/healthz`)).status).toBe(200)

      const group = await ok(await fetch(`${base}/v1/groups`, {
        method: 'POST',
        headers: jsonHeaders(a.token),
        body: JSON.stringify({ kind: 'direct', member_device_ids: [b.device_id] }),
      }), 201)

      const frames: any[] = []
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/stream?cursor=${b.cursor}&token=${b.token}`)
      const received = (n: number) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout; frames=${JSON.stringify(frames)}`)), 3000)
        const check = () => {
          if (frames.length >= n) {
            clearTimeout(timer)
            resolve()
          }
        }
        ws.onmessage = (e) => {
          frames.push(JSON.parse(String(e.data)))
          check()
        }
        check()
      })
      await received(1)
      expect(frames[0]).toMatchObject({ type: 'event', event: { type: 'group.member_added' } })

      await ok(await fetch(`${base}/v1/groups/${group.group_id}/messages`, {
        method: 'POST',
        headers: jsonHeaders(a.token),
        body: JSON.stringify({ client_id: 'c-1', kind: 'commit', epoch: 0, payload: b64('commit-0') }),
      }), 201)
      await received(2)
      expect(frames[1]).toMatchObject({ type: 'event', event: { type: 'message', data: { group_id: group.group_id, seq: 1, kind: 'commit' } } })
      ws.close()
    }
    finally {
      await server.stop(true)
    }
  })
})
