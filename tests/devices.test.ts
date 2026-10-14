import { describe, expect, it } from 'bun:test'
import { appendEvent } from '../src/events/store'
import { auth, jsonHeaders, makeTestApp, registerDevice } from './helpers'

const ID = /^[udgb]_[\w-]{22}$/

describe('POST /v1/devices', () => {
  it('registers a new user and device', async () => {
    const { app } = makeTestApp()
    const dev = await registerDevice(app, 'alice', 'Alice')
    expect(dev.user_id).toMatch(ID)
    expect(dev.user_id.startsWith('u_')).toBe(true)
    expect(dev.device_id.startsWith('d_')).toBe(true)
    expect(dev.device_id).toMatch(ID)
    expect(dev.token).toMatch(/^[\w-]{43}$/)
    expect(dev.cursor).toBe(0)
  })

  it('adds a second device to an existing handle and keeps its display name', async () => {
    const { app } = makeTestApp()
    const first = await registerDevice(app, 'alice', 'Alice')
    const second = await registerDevice(app, 'alice', 'Someone Else')
    expect(second.user_id).toBe(first.user_id)
    expect(second.device_id).not.toBe(first.device_id)
    expect(second.token).not.toBe(first.token)

    const me = await app.request('/v1/me', { headers: auth(second.token) })
    expect(await me.json()).toMatchObject({ display_name: 'Alice', device_id: second.device_id })
  })

  it('returns the current head cursor', async () => {
    const { app, db } = makeTestApp()
    const alice = await registerDevice(app, 'alice')
    appendEvent(db, { type: 'keypackages.low', data: { available: 0 }, deviceIds: [alice.device_id], now: 1 })
    appendEvent(db, { type: 'keypackages.low', data: { available: 0 }, deviceIds: [alice.device_id], now: 2 })
    const bob = await registerDevice(app, 'bob')
    expect(bob.cursor).toBe(2)
  })

  it.each([
    [{ handle: 'ab', display_name: 'x' }],
    [{ handle: 'Alice', display_name: 'x' }],
    [{ handle: 'a'.repeat(33), display_name: 'x' }],
    [{ handle: 'alice-1', display_name: 'x' }],
    [{ handle: 'alice', display_name: '' }],
    [{ handle: 'alice', display_name: 'x'.repeat(65) }],
    [{ handle: 'alice' }],
  ])('rejects invalid body %j with 400', async (body) => {
    const { app } = makeTestApp()
    const res = await app.request('/v1/devices', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: { code: 'validation_failed', message: expect.any(String) } })
  })

  it('rejects malformed JSON with 400', async () => {
    const { app } = makeTestApp()
    const res = await app.request('/v1/devices', { method: 'POST', headers: jsonHeaders(), body: '{' })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('validation_failed')
  })
})

describe('GET /v1/me', () => {
  it('returns the caller identity', async () => {
    const { app } = makeTestApp()
    const dev = await registerDevice(app, 'alice', 'Alice')
    const res = await app.request('/v1/me', { headers: auth(dev.token) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user_id: dev.user_id, device_id: dev.device_id, handle: 'alice', display_name: 'Alice' })
  })

  it('returns 401 without a token', async () => {
    const { app } = makeTestApp()
    const res = await app.request('/v1/me')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } })
  })

  it('returns 401 with a bad token', async () => {
    const { app } = makeTestApp()
    await registerDevice(app, 'alice')
    const res = await app.request('/v1/me', { headers: auth('not-a-real-token') })
    expect(res.status).toBe(401)
    expect((await res.json() as any).error.code).toBe('unauthorized')
  })
})

describe('stubs', () => {
  // Tolerant on purpose: sibling subtasks replace stubs, so only assert the
  // shape whenever a route still answers 501.
  it('unimplemented routes return 501 in the shared error shape', async () => {
    const { app } = makeTestApp()
    const dev = await registerDevice(app, 'alice')
    for (const path of ['/v1/groups', '/v1/keypackages/count', '/v1/users/u_x', '/v1/events', '/v1/blobs/b_x']) {
      const res = await app.request(path, { headers: auth(dev.token) })
      expect(res.status).not.toBe(500)
      if (res.status === 501)
        expect(await res.json()).toEqual({ error: { code: 'not_implemented', message: expect.any(String) } })
    }
  })
})
