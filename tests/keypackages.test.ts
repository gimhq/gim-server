import type { TestApp } from './helpers'
import { describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import { listEvents } from '../src/events/store'
import { auth, jsonHeaders, makeTestApp, registerDevice } from './helpers'

const kp = (s: string) => Buffer.from(s).toString('base64')

async function upload(app: TestApp, token: string, body: unknown) {
  return app.request('/v1/keypackages', { method: 'POST', headers: jsonHeaders(token), body: JSON.stringify(body) })
}

async function claim(app: TestApp, token: string, deviceIds: string[]) {
  const res = await app.request('/v1/keypackages/claim', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ device_ids: deviceIds }),
  })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ key_packages: { device_id: string, key_package: string, last_resort: boolean }[], missing: string[] }>
}

async function count(app: TestApp, token: string) {
  const res = await app.request('/v1/keypackages/count', { headers: auth(token) })
  expect(res.status).toBe(200)
  return res.json()
}

describe('POST /v1/keypackages', () => {
  it('uploads packages and reports counts', async () => {
    const { app } = makeTestApp()
    const alice = await registerDevice(app, 'alice')
    expect(await count(app, alice.token)).toEqual({ available: 0, has_last_resort: false })

    const res = await upload(app, alice.token, { key_packages: [kp('a1'), kp('a2')] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: 2, has_last_resort: false })

    const res2 = await upload(app, alice.token, { key_packages: [kp('a3')], last_resort: kp('lr') })
    expect(await res2.json()).toEqual({ available: 3, has_last_resort: true })
    expect(await count(app, alice.token)).toEqual({ available: 3, has_last_resort: true })
  })

  it('replaces the previous last-resort package', async () => {
    const { app } = makeTestApp()
    const alice = await registerDevice(app, 'alice')
    const bob = await registerDevice(app, 'bob')
    await upload(app, alice.token, { key_packages: [], last_resort: kp('old') })
    const res = await upload(app, alice.token, { key_packages: [], last_resort: kp('new') })
    expect(await res.json()).toEqual({ available: 0, has_last_resort: true })
    const claimed = await claim(app, bob.token, [alice.device_id])
    expect(claimed.key_packages).toEqual([{ device_id: alice.device_id, key_package: kp('new'), last_resort: true }])
  })

  it('counts are per device', async () => {
    const { app } = makeTestApp()
    const a1 = await registerDevice(app, 'alice')
    const a2 = await registerDevice(app, 'alice')
    await upload(app, a1.token, { key_packages: [kp('x')] })
    expect(await count(app, a2.token)).toEqual({ available: 0, has_last_resort: false })
  })

  it.each([
    [{ key_packages: ['not base64!'] }],
    [{ key_packages: [], last_resort: '@@@' }],
    [{ key_packages: [''] }],
    [{ key_packages: Array.from({ length: 101 }, () => kp('x')) }],
    [{}],
  ])('rejects invalid body %#', async (body) => {
    const { app } = makeTestApp()
    const alice = await registerDevice(app, 'alice')
    const res = await upload(app, alice.token, body)
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('validation_failed')
    expect(await count(app, alice.token)).toEqual({ available: 0, has_last_resort: false })
  })

  it('requires a bearer token', async () => {
    const { app } = makeTestApp()
    expect((await upload(app, '', { key_packages: [] })).status).toBe(401)
    expect((await app.request('/v1/keypackages/count')).status).toBe(401)
    const res = await app.request('/v1/keypackages/claim', { method: 'POST', headers: jsonHeaders(), body: '{"device_ids":["d_x"]}' })
    expect(res.status).toBe(401)
  })
})

describe('POST /v1/keypackages/claim', () => {
  it('consumes one-time packages oldest first', async () => {
    const { app } = makeTestApp({ env: { KEYPACKAGE_LOW_THRESHOLD: '0' } })
    const alice = await registerDevice(app, 'alice')
    const bob = await registerDevice(app, 'bob')
    await upload(app, alice.token, { key_packages: [kp('k1'), kp('k2')] })
    await upload(app, alice.token, { key_packages: [kp('k3')] })
    for (const expected of ['k1', 'k2', 'k3']) {
      const res = await claim(app, bob.token, [alice.device_id])
      expect(res).toEqual({ key_packages: [{ device_id: alice.device_id, key_package: kp(expected), last_resort: false }], missing: [] })
    }
    expect(await count(app, alice.token)).toEqual({ available: 0, has_last_resort: false })
    expect(await claim(app, bob.token, [alice.device_id])).toEqual({ key_packages: [], missing: [alice.device_id] })
  })

  it('falls back to the last-resort package without consuming it', async () => {
    const { app } = makeTestApp()
    const alice = await registerDevice(app, 'alice')
    const bob = await registerDevice(app, 'bob')
    await upload(app, alice.token, { key_packages: [kp('one')], last_resort: kp('lr') })
    const first = await claim(app, bob.token, [alice.device_id])
    expect(first.key_packages).toEqual([{ device_id: alice.device_id, key_package: kp('one'), last_resort: false }])
    for (let i = 0; i < 2; i++) {
      const res = await claim(app, bob.token, [alice.device_id])
      expect(res).toEqual({ key_packages: [{ device_id: alice.device_id, key_package: kp('lr'), last_resort: true }], missing: [] })
    }
    expect(await count(app, alice.token)).toEqual({ available: 0, has_last_resort: true })
  })

  it('handles a mixed batch with missing and unknown devices', async () => {
    const { app } = makeTestApp()
    const a1 = await registerDevice(app, 'alice')
    const a2 = await registerDevice(app, 'alice')
    const a3 = await registerDevice(app, 'alice')
    const bob = await registerDevice(app, 'bob')
    await upload(app, a1.token, { key_packages: [kp('a1')] })
    await upload(app, a2.token, { key_packages: [], last_resort: kp('a2lr') })
    const res = await claim(app, bob.token, [a1.device_id, a2.device_id, a3.device_id, 'd_unknown'])
    expect(res).toEqual({
      key_packages: [
        { device_id: a1.device_id, key_package: kp('a1'), last_resort: false },
        { device_id: a2.device_id, key_package: kp('a2lr'), last_resort: true },
      ],
      missing: [a3.device_id, 'd_unknown'],
    })
  })

  it('lets a device claim its own packages', async () => {
    const { app } = makeTestApp()
    const alice = await registerDevice(app, 'alice')
    await upload(app, alice.token, { key_packages: [kp('self')] })
    const res = await claim(app, alice.token, [alice.device_id])
    expect(res.key_packages).toEqual([{ device_id: alice.device_id, key_package: kp('self'), last_resort: false }])
  })

  it('emits keypackages.low only to the owning device when below the threshold', async () => {
    const { app, db, bus } = makeTestApp({ env: { KEYPACKAGE_LOW_THRESHOLD: '2' } })
    const alice = await registerDevice(app, 'alice')
    const bob = await registerDevice(app, 'bob')
    await upload(app, alice.token, { key_packages: [kp('1'), kp('2'), kp('3')] })
    let woken = 0
    bus.subscribe(alice.device_id, () => woken++)

    // 3 -> 2 remaining: not below the threshold.
    await claim(app, bob.token, [alice.device_id])
    expect(listEvents(db, alice.device_id, 0, 100)).toEqual([])
    expect(woken).toBe(0)

    // 2 -> 1 remaining: below the threshold.
    await claim(app, bob.token, [alice.device_id])
    expect(listEvents(db, alice.device_id, 0, 100)).toEqual([
      { cursor: expect.any(Number), type: 'keypackages.low', created_at: expect.any(Number), data: { available: 1 } },
    ])
    expect(listEvents(db, bob.device_id, 0, 100)).toEqual([])
    expect(woken).toBe(1)
  })

  it('does not emit keypackages.low when serving the last-resort package', async () => {
    const { app, db } = makeTestApp({ env: { KEYPACKAGE_LOW_THRESHOLD: '5' } })
    const alice = await registerDevice(app, 'alice')
    const bob = await registerDevice(app, 'bob')
    await upload(app, alice.token, { key_packages: [], last_resort: kp('lr') })
    await claim(app, bob.token, [alice.device_id])
    expect(listEvents(db, alice.device_id, 0, 100)).toEqual([])
  })

  it.each([
    [{ device_ids: [] }],
    [{ device_ids: ['d_a', 'd_a'] }],
    [{ device_ids: Array.from({ length: 101 }, (_, i) => `d_${i}`) }],
  ])('rejects invalid body %#', async (body) => {
    const { app } = makeTestApp()
    const alice = await registerDevice(app, 'alice')
    const res = await app.request('/v1/keypackages/claim', { method: 'POST', headers: jsonHeaders(alice.token), body: JSON.stringify(body) })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('validation_failed')
  })
})
