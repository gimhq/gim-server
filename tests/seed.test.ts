import { describe, expect, it } from 'bun:test'
import { seed } from '../scripts/seed'
import { auth, makeTestApp } from './helpers'

describe('seed', () => {
  it('creates demo users, devices and groups usable over HTTP', async () => {
    const { app, db } = makeTestApp()
    const summary = seed(db)

    expect(summary.users.map(u => u.handle)).toEqual(['alice', 'bob', 'carol', 'dave'])
    const [alice, bob] = summary.users
    const me = await app.request('/v1/me', { headers: auth(alice!.token) })
    expect(await me.json()).toEqual({ user_id: alice!.user_id, device_id: alice!.device_id, handle: 'alice', display_name: 'Alice Demo' })

    const res = await app.request('/v1/groups', { headers: auth(bob!.token) })
    const { groups } = await res.json() as any
    const byId = (a: { group_id: string }, b: { group_id: string }) => a.group_id.localeCompare(b.group_id)
    expect(groups.sort(byId).map((g: any) => [g.group_id, g.kind, g.epoch, g.members.map((m: any) => m.device_id).sort()])).toEqual(
      [...summary.groups].sort(byId).map(g => [g.group_id, g.kind, 0, [...g.device_ids].sort()]),
    )
    expect(summary.groups.map(g => [g.name, g.device_ids.length])).toEqual([['demo', 4], ['direct', 2]])

    const messages = await app.request(`/v1/groups/${summary.groups[0]!.group_id}/messages`, { headers: auth(bob!.token) })
    expect((await messages.json() as any).messages).toEqual([])
  })

  it('is idempotent and rotates device tokens', async () => {
    const { app, db } = makeTestApp()
    const first = seed(db)
    const second = seed(db)

    expect(second.users.map(u => [u.user_id, u.device_id])).toEqual(first.users.map(u => [u.user_id, u.device_id]))
    expect(second.groups).toEqual(first.groups)
    expect(db.query('SELECT count(*) AS n FROM devices').get()).toEqual({ n: 4 })
    expect(db.query('SELECT count(*) AS n FROM groups').get()).toEqual({ n: 2 })

    const stale = await app.request('/v1/me', { headers: auth(first.users[0]!.token) })
    expect(stale.status).toBe(401)
    const fresh = await app.request('/v1/me', { headers: auth(second.users[0]!.token) })
    expect(fresh.status).toBe(200)
  })
})
