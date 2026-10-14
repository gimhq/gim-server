import { describe, expect, it } from 'bun:test'
import { auth, makeTestApp, registerDevice } from './helpers'

describe('directory', () => {
  it('looks up a user by handle', async () => {
    const { app } = makeTestApp()
    const alice = await registerDevice(app, 'alice', 'Alice')
    const bob = await registerDevice(app, 'bob')
    const res = await app.request('/v1/users?handle=alice', { headers: auth(bob.token) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user_id: alice.user_id, handle: 'alice', display_name: 'Alice' })
  })

  it('returns 404 for an unknown handle', async () => {
    const { app } = makeTestApp()
    const bob = await registerDevice(app, 'bob')
    const res = await app.request('/v1/users?handle=nobody', { headers: auth(bob.token) })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } })
  })

  it('rejects an invalid handle with 400', async () => {
    const { app } = makeTestApp()
    const bob = await registerDevice(app, 'bob')
    const res = await app.request('/v1/users?handle=No', { headers: auth(bob.token) })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('validation_failed')
  })

  it('gets a user by id', async () => {
    const { app } = makeTestApp()
    const alice = await registerDevice(app, 'alice', 'Alice')
    const res = await app.request(`/v1/users/${alice.user_id}`, { headers: auth(alice.token) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user_id: alice.user_id, handle: 'alice', display_name: 'Alice' })

    const missing = await app.request('/v1/users/u_unknown', { headers: auth(alice.token) })
    expect(missing.status).toBe(404)
    expect((await missing.json() as any).error.code).toBe('not_found')
  })

  it('lists every device of a multi-device user ordered by created_at', async () => {
    let t = 1000
    const { app } = makeTestApp({ now: () => t++ })
    const first = await registerDevice(app, 'alice')
    const second = await registerDevice(app, 'alice')
    const third = await registerDevice(app, 'alice')
    await registerDevice(app, 'bob')
    const res = await app.request(`/v1/users/${first.user_id}/devices`, { headers: auth(second.token) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      devices: [
        { device_id: first.device_id, created_at: 1000 },
        { device_id: second.device_id, created_at: 1001 },
        { device_id: third.device_id, created_at: 1002 },
      ],
    })
  })

  it('returns 404 listing devices of an unknown user', async () => {
    const { app } = makeTestApp()
    const alice = await registerDevice(app, 'alice')
    const res = await app.request('/v1/users/u_unknown/devices', { headers: auth(alice.token) })
    expect(res.status).toBe(404)
    expect((await res.json() as any).error.code).toBe('not_found')
  })

  it('requires a bearer token', async () => {
    const { app } = makeTestApp()
    const alice = await registerDevice(app, 'alice')
    for (const path of ['/v1/users?handle=alice', `/v1/users/${alice.user_id}`, `/v1/users/${alice.user_id}/devices`]) {
      const res = await app.request(path)
      expect(res.status).toBe(401)
      expect((await res.json() as any).error.code).toBe('unauthorized')
    }
  })
})
