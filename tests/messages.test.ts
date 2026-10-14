import type { RegisteredDevice, TestApp } from './helpers'
import { describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import { listEvents } from '../src/events/store'
import { auth, jsonHeaders, makeTestApp, registerDevice } from './helpers'

const b64 = (s: string) => Buffer.from(s).toString('base64')

async function setup(env?: Record<string, string>) {
  const t = makeTestApp({ env })
  const alice = await registerDevice(t.app, 'alice')
  const bob = await registerDevice(t.app, 'bob')
  const carol = await registerDevice(t.app, 'carol')
  const outsider = await registerDevice(t.app, 'mallory')
  const res = await t.app.request('/v1/groups', {
    method: 'POST',
    headers: jsonHeaders(alice.token),
    body: JSON.stringify({ kind: 'group', member_device_ids: [bob.device_id, carol.device_id] }),
  })
  const groupId = (await res.json() as any).group_id as string
  const send = (dev: RegisteredDevice, body: Record<string, unknown>, gid = groupId) =>
    t.app.request(`/v1/groups/${gid}/messages`, {
      method: 'POST',
      headers: jsonHeaders(dev.token),
      body: JSON.stringify({ epoch: 0, kind: 'application', payload: b64('x'), ...body }),
    })
  const history = async (dev: RegisteredDevice, query = '') => {
    const res = await t.app.request(`/v1/groups/${groupId}/messages${query}`, { headers: auth(dev.token) })
    return { status: res.status, body: await res.json() as any }
  }
  return { ...t, alice, bob, carol, outsider, groupId, send, history }
}

function messageEvents(db: Parameters<typeof listEvents>[0], deviceId: string) {
  return listEvents(db, deviceId, 0, 1000).filter(e => e.type === 'message').map(e => e.data as any)
}

async function epochOf(app: TestApp, dev: RegisteredDevice, groupId: string): Promise<number> {
  return ((await (await app.request(`/v1/groups/${groupId}`, { headers: auth(dev.token) })).json()) as any).epoch
}

describe('POST /v1/groups/{id}/messages', () => {
  it('stores an application message and fans it out to members except the sender', async () => {
    const { db, alice, bob, carol, outsider, groupId, send } = await setup()
    const res = await send(alice, { client_id: 'c1', payload: b64('hello') })
    expect(res.status).toBe(201)
    const msg = await res.json() as any
    expect(msg).toEqual({
      group_id: groupId,
      seq: 1,
      sender_device_id: alice.device_id,
      sender_user_id: alice.user_id,
      client_id: 'c1',
      kind: 'application',
      epoch: 0,
      payload: b64('hello'),
      created_at: expect.any(Number),
    })
    expect(messageEvents(db, bob.device_id)).toEqual([msg])
    expect(messageEvents(db, carol.device_id)).toEqual([msg])
    expect(messageEvents(db, alice.device_id)).toEqual([])
    expect(listEvents(db, outsider.device_id, 0, 1000)).toEqual([])
  })

  it('assigns gap-free, strictly increasing seq numbers', async () => {
    const { alice, bob, send } = await setup()
    const seqs: number[] = []
    for (let i = 0; i < 5; i++) {
      const res = await send(i % 2 ? bob : alice, { client_id: `c${i}` })
      seqs.push((await res.json() as any).seq)
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5])
  })

  it('replays an idempotent request with 200, the original message and no new event', async () => {
    const { db, alice, bob, send } = await setup()
    const first = await (await send(alice, { client_id: 'same', payload: b64('one') })).json() as any
    const replay = await send(alice, { client_id: 'same', payload: b64('two'), kind: 'commit' })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(first)
    expect(messageEvents(db, bob.device_id)).toHaveLength(1)

    // Same client_id from another device is a different message.
    const other = await send(bob, { client_id: 'same' })
    expect(other.status).toBe(201)
    expect((await other.json() as any).seq).toBe(2)
  })

  it('handles concurrent identical requests as one message', async () => {
    const { db, alice, bob, send } = await setup()
    const results = await Promise.all(Array.from({ length: 5 }, () => send(alice, { client_id: 'dup' })))
    const statuses = results.map(r => r.status).sort()
    expect(statuses).toEqual([200, 200, 200, 200, 201])
    const seqs = await Promise.all(results.map(async r => (await r.json() as any).seq))
    expect(new Set(seqs)).toEqual(new Set([1]))
    expect(messageEvents(db, bob.device_id)).toHaveLength(1)
  })

  it('orders commits by epoch and rejects stale commits with 409', async () => {
    const { app, alice, bob, groupId, send } = await setup()
    const first = await send(alice, { client_id: 'k1', kind: 'commit', epoch: 0 })
    expect(first.status).toBe(201)
    expect(await epochOf(app, alice, groupId)).toBe(1)

    const stale = await send(bob, { client_id: 'k2', kind: 'commit', epoch: 0 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: { code: 'stale_epoch', message: expect.any(String) }, current_epoch: 1 })

    const next = await send(bob, { client_id: 'k3', kind: 'commit', epoch: 1 })
    expect(next.status).toBe(201)
    expect((await next.json() as any).seq).toBe(2)
    expect(await epochOf(app, alice, groupId)).toBe(2)

    // Application messages and welcomes are not epoch-checked.
    expect((await send(alice, { client_id: 'a1', epoch: 0 })).status).toBe(201)
    expect(await epochOf(app, alice, groupId)).toBe(2)
  })

  it('delivers a welcome only to its recipients, members or not', async () => {
    const { db, alice, bob, carol, outsider, send } = await setup()
    const res = await send(alice, { client_id: 'w1', kind: 'welcome', epoch: 5, recipients: [outsider.device_id, outsider.device_id] })
    expect(res.status).toBe(201)
    const msg = await res.json() as any
    expect(msg.recipients).toEqual([outsider.device_id])
    expect(messageEvents(db, outsider.device_id)).toEqual([msg])
    expect(messageEvents(db, bob.device_id)).toEqual([])
    expect(messageEvents(db, carol.device_id)).toEqual([])
    expect(messageEvents(db, alice.device_id)).toEqual([])
  })

  it('validates recipients', async () => {
    const { alice, bob, send } = await setup()
    expect((await send(alice, { client_id: 'w', kind: 'welcome' })).status).toBe(400)
    expect((await send(alice, { client_id: 'w', kind: 'welcome', recipients: [] })).status).toBe(400)
    expect((await send(alice, { client_id: 'w', kind: 'welcome', recipients: ['d_unknownunknownunknown'] })).status).toBe(400)
    for (const kind of ['application', 'commit']) {
      const res = await send(alice, { client_id: `r-${kind}`, kind, recipients: [bob.device_id] })
      expect(res.status).toBe(400)
      expect((await res.json() as any).error.code).toBe('validation_failed')
    }
  })

  it('rejects invalid base64 with 400 and oversized payloads with 413', async () => {
    const { alice, send } = await setup({ MAX_MESSAGE_BYTES: '8' })
    const invalid = await send(alice, { client_id: 'b', payload: 'not base64!' })
    expect(invalid.status).toBe(400)
    expect((await invalid.json() as any).error.code).toBe('validation_failed')

    expect((await send(alice, { client_id: 'ok', payload: b64('12345678') })).status).toBe(201)
    const big = await send(alice, { client_id: 'big', payload: b64('123456789') })
    expect(big.status).toBe(413)
    expect((await big.json() as any).error.code).toBe('payload_too_large')
  })

  it('returns 403 for non-members, 404 for unknown groups and 401 without auth', async () => {
    const { app, alice, outsider, groupId, send } = await setup()
    const forbidden = await send(outsider, { client_id: 'x' })
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json() as any).error.code).toBe('not_member')
    expect((await send(alice, { client_id: 'x' }, 'g_doesnotexistdoesnotex')).status).toBe(404)
    const unauth = await app.request(`/v1/groups/${groupId}/messages`, { method: 'POST', headers: jsonHeaders(), body: '{}' })
    expect(unauth.status).toBe(401)
  })

  it('stops delivering to a removed device', async () => {
    const { app, db, alice, bob, carol, groupId, send } = await setup()
    await send(alice, { client_id: 'before' })
    await app.request(`/v1/groups/${groupId}/members/${bob.device_id}`, { method: 'DELETE', headers: auth(alice.token) })
    await send(alice, { client_id: 'after' })
    await send(carol, { client_id: 'commit', kind: 'commit' })

    expect(messageEvents(db, bob.device_id).map(m => m.client_id)).toEqual(['before'])
    expect(messageEvents(db, carol.device_id).map(m => m.client_id)).toEqual(['before', 'after'])
    expect((await send(bob, { client_id: 'late' })).status).toBe(403)
  })
})

describe('GET /v1/groups/{id}/messages', () => {
  it('paginates in ascending seq order with has_more', async () => {
    const { alice, bob, send, history } = await setup()
    for (let i = 1; i <= 5; i++)
      await send(alice, { client_id: `m${i}` })

    const page1 = await history(bob, '?limit=2')
    expect(page1.status).toBe(200)
    expect(page1.body.messages.map((m: any) => m.seq)).toEqual([1, 2])
    expect(page1.body.has_more).toBe(true)

    const page2 = await history(bob, '?after_seq=2&limit=2')
    expect(page2.body.messages.map((m: any) => m.seq)).toEqual([3, 4])
    expect(page2.body.has_more).toBe(true)

    const page3 = await history(bob, '?after_seq=4&limit=2')
    expect(page3.body.messages.map((m: any) => m.seq)).toEqual([5])
    expect(page3.body.has_more).toBe(false)

    const all = await history(alice)
    expect(all.body.messages).toHaveLength(5)
    expect(all.body.messages[0].payload).toBe(b64('x'))
    expect(all.body.has_more).toBe(false)
  })

  it('shows welcome messages only to their sender and recipients', async () => {
    const { app, alice, bob, carol, send, history, groupId } = await setup()
    await send(alice, { client_id: 'a' })
    await send(alice, { client_id: 'w', kind: 'welcome', recipients: [bob.device_id] })
    await send(alice, { client_id: 'b' })

    expect((await history(alice)).body.messages.map((m: any) => m.client_id)).toEqual(['a', 'w', 'b'])
    const forBob = (await history(bob)).body.messages
    expect(forBob.map((m: any) => m.client_id)).toEqual(['a', 'w', 'b'])
    expect(forBob[1].recipients).toEqual([bob.device_id])
    expect(forBob[0].recipients).toBeUndefined()
    expect((await history(carol)).body.messages.map((m: any) => m.client_id)).toEqual(['a', 'b'])

    // Pagination is over the visible messages.
    const page = await app.request(`/v1/groups/${groupId}/messages?limit=1&after_seq=1`, { headers: auth(carol.token) })
    expect(((await page.json()) as any).messages.map((m: any) => m.seq)).toEqual([3])
  })

  it('returns 403 for non-members, 404 for unknown groups and 400 for bad queries', async () => {
    const { app, alice, outsider, history } = await setup()
    const forbidden = await history(outsider)
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.error.code).toBe('not_member')
    const missing = await app.request('/v1/groups/g_doesnotexistdoesnotex/messages', { headers: auth(alice.token) })
    expect(missing.status).toBe(404)
    expect((await history(alice, '?limit=0')).status).toBe(400)
    expect((await history(alice, '?limit=501')).status).toBe(400)
    expect((await history(alice, '?after_seq=-1')).status).toBe(400)
  })
})
