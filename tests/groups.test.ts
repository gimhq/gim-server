import type { RegisteredDevice, TestApp } from './helpers'
import { describe, expect, it } from 'bun:test'
import { listEvents } from '../src/events/store'
import { auth, jsonHeaders, makeTestApp, registerDevice } from './helpers'

async function createGroup(app: TestApp, dev: RegisteredDevice, kind: 'direct' | 'group', memberDeviceIds: string[]) {
  return app.request('/v1/groups', {
    method: 'POST',
    headers: jsonHeaders(dev.token),
    body: JSON.stringify({ kind, member_device_ids: memberDeviceIds }),
  })
}

async function setup() {
  let clock = 1_760_000_000_000
  const t = makeTestApp({ now: () => clock++ })
  const alice = await registerDevice(t.app, 'alice')
  const alice2 = await registerDevice(t.app, 'alice')
  const bob = await registerDevice(t.app, 'bob')
  const carol = await registerDevice(t.app, 'carol')
  const outsider = await registerDevice(t.app, 'mallory')
  return { ...t, alice, alice2, bob, carol, outsider }
}

const groupEvents = (db: Parameters<typeof listEvents>[0], deviceId: string) => listEvents(db, deviceId, 0, 1000)

describe('POST /v1/groups', () => {
  it('creates a group with the creator as member and emits member_added to all members', async () => {
    const { app, db, alice, bob, carol, outsider } = await setup()
    const res = await createGroup(app, alice, 'group', [bob.device_id, carol.device_id, alice.device_id, bob.device_id])
    expect(res.status).toBe(201)
    const group = await res.json() as any
    expect(group.group_id).toMatch(/^g_[\w-]{22}$/)
    expect(group).toMatchObject({ kind: 'group', epoch: 0, created_by_device_id: alice.device_id, created_at: expect.any(Number) })
    const expectedMembers = [alice, bob, carol]
      .map(d => ({ device_id: d.device_id, user_id: d.user_id }))
      .sort((a, b) => (a.device_id < b.device_id ? -1 : 1))
    expect(group.members).toEqual(expectedMembers)

    for (const dev of [alice, bob, carol]) {
      const events = groupEvents(db, dev.device_id)
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('group.member_added')
      expect(events[0]!.data).toEqual({ group_id: group.group_id, device_ids: [alice.device_id, bob.device_id, carol.device_id], by_device_id: alice.device_id })
    }
    expect(groupEvents(db, outsider.device_id)).toHaveLength(0)
  })

  it('creates a direct group between two users (multiple devices allowed)', async () => {
    const { app, alice, alice2, bob } = await setup()
    const res = await createGroup(app, alice, 'direct', [alice2.device_id, bob.device_id])
    expect(res.status).toBe(201)
    expect((await res.json() as any).members).toHaveLength(3)
  })

  it.each([
    ['only the caller', (_d: Awaited<ReturnType<typeof setup>>) => [] as string[]],
    ['only own devices', (d: Awaited<ReturnType<typeof setup>>) => [d.alice2.device_id]],
    ['three users', (d: Awaited<ReturnType<typeof setup>>) => [d.bob.device_id, d.carol.device_id]],
  ])('rejects a direct group with %s', async (_name, members) => {
    const d = await setup()
    const res = await createGroup(d.app, d.alice, 'direct', members(d))
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('validation_failed')
  })

  it('rejects unknown devices', async () => {
    const { app, db, alice } = await setup()
    const res = await createGroup(app, alice, 'group', ['d_unknownunknownunknown'])
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('validation_failed')
    expect(groupEvents(db, alice.device_id)).toHaveLength(0)
  })

  it('rejects an invalid body and requires auth', async () => {
    const { app, alice } = await setup()
    const bad = await app.request('/v1/groups', { method: 'POST', headers: jsonHeaders(alice.token), body: JSON.stringify({ kind: 'channel', member_device_ids: [] }) })
    expect(bad.status).toBe(400)
    const unauth = await app.request('/v1/groups', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ kind: 'group', member_device_ids: [] }) })
    expect(unauth.status).toBe(401)
  })
})

describe('GET /v1/groups and /v1/groups/{id}', () => {
  it('lists only groups the caller is a member of', async () => {
    const { app, alice, bob, carol } = await setup()
    const g1 = await (await createGroup(app, alice, 'group', [bob.device_id])).json() as any
    const g2 = await (await createGroup(app, bob, 'group', [carol.device_id])).json() as any

    const list = async (dev: RegisteredDevice) => ((await (await app.request('/v1/groups', { headers: auth(dev.token) })).json()) as any).groups.map((g: any) => g.group_id)
    expect(await list(alice)).toEqual([g1.group_id])
    expect((await list(bob)).sort()).toEqual([g1.group_id, g2.group_id].sort())
    expect(await list(carol)).toEqual([g2.group_id])
    expect((await app.request('/v1/groups')).status).toBe(401)
  })

  it('returns the group to members, 403 to non-members and 404 for unknown groups', async () => {
    const { app, alice, bob, outsider } = await setup()
    const group = await (await createGroup(app, alice, 'group', [bob.device_id])).json() as any

    const ok = await app.request(`/v1/groups/${group.group_id}`, { headers: auth(bob.token) })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual(group)

    const forbidden = await app.request(`/v1/groups/${group.group_id}`, { headers: auth(outsider.token) })
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json() as any).error.code).toBe('not_member')

    const missing = await app.request('/v1/groups/g_doesnotexistdoesnotex', { headers: auth(alice.token) })
    expect(missing.status).toBe(404)
    expect((await missing.json() as any).error.code).toBe('not_found')
  })
})

describe('POST /v1/groups/{id}/members', () => {
  it('adds new devices, ignores existing ones and notifies all members', async () => {
    const { app, db, alice, bob, carol, outsider } = await setup()
    const group = await (await createGroup(app, alice, 'group', [])).json() as any

    const res = await app.request(`/v1/groups/${group.group_id}/members`, {
      method: 'POST',
      headers: jsonHeaders(alice.token),
      body: JSON.stringify({ device_ids: [alice.device_id, bob.device_id, carol.device_id] }),
    })
    expect(res.status).toBe(200)
    const updated = await res.json() as any
    expect(updated.epoch).toBe(0)
    expect(updated.members.map((m: any) => m.device_id)).toEqual([alice.device_id, ...[bob.device_id, carol.device_id].sort()])

    for (const dev of [alice, bob, carol]) {
      const added = groupEvents(db, dev.device_id).filter(e => e.type === 'group.member_added' && (e.data as any).by_device_id === alice.device_id && (e.data as any).device_ids.length === 2)
      expect(added).toHaveLength(1)
      expect(added[0]!.data).toEqual({ group_id: group.group_id, device_ids: [bob.device_id, carol.device_id], by_device_id: alice.device_id })
    }
    expect(groupEvents(db, outsider.device_id)).toHaveLength(0)
  })

  it('emits nothing when every device is already a member', async () => {
    const { app, db, alice, bob } = await setup()
    const group = await (await createGroup(app, alice, 'group', [bob.device_id])).json() as any
    const before = groupEvents(db, alice.device_id).length
    const res = await app.request(`/v1/groups/${group.group_id}/members`, { method: 'POST', headers: jsonHeaders(bob.token), body: JSON.stringify({ device_ids: [alice.device_id] }) })
    expect(res.status).toBe(200)
    expect(groupEvents(db, alice.device_id)).toHaveLength(before)
  })

  it('returns 400 for unknown devices, 403 for non-members and 404 for unknown groups', async () => {
    const { app, alice, bob, outsider } = await setup()
    const group = await (await createGroup(app, alice, 'group', [])).json() as any
    const post = (dev: RegisteredDevice, groupId: string, deviceIds: string[]) =>
      app.request(`/v1/groups/${groupId}/members`, { method: 'POST', headers: jsonHeaders(dev.token), body: JSON.stringify({ device_ids: deviceIds }) })

    expect((await post(alice, group.group_id, ['d_unknownunknownunknown'])).status).toBe(400)
    expect((await post(alice, group.group_id, [])).status).toBe(400)
    const forbidden = await post(outsider, group.group_id, [outsider.device_id])
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json() as any).error.code).toBe('not_member')
    expect((await post(alice, 'g_doesnotexistdoesnotex', [bob.device_id])).status).toBe(404)
  })
})

describe('DELETE /v1/groups/{id}/members/{device_id}', () => {
  it('removes a member and notifies remaining members and the removed device', async () => {
    const { app, db, alice, bob, carol, outsider } = await setup()
    const group = await (await createGroup(app, alice, 'group', [bob.device_id, carol.device_id])).json() as any

    const res = await app.request(`/v1/groups/${group.group_id}/members/${bob.device_id}`, { method: 'DELETE', headers: auth(alice.token) })
    expect(res.status).toBe(200)
    expect((await res.json() as any).members.map((m: any) => m.device_id)).not.toContain(bob.device_id)

    for (const dev of [alice, bob, carol]) {
      const removed = groupEvents(db, dev.device_id).filter(e => e.type === 'group.member_removed')
      expect(removed).toHaveLength(1)
      expect(removed[0]!.data).toEqual({ group_id: group.group_id, device_ids: [bob.device_id], by_device_id: alice.device_id })
    }
    expect(groupEvents(db, outsider.device_id)).toHaveLength(0)

    const after = await app.request(`/v1/groups/${group.group_id}`, { headers: auth(bob.token) })
    expect(after.status).toBe(403)
  })

  it('lets a device leave by removing itself', async () => {
    const { app, db, alice, bob } = await setup()
    const group = await (await createGroup(app, alice, 'group', [bob.device_id])).json() as any
    const res = await app.request(`/v1/groups/${group.group_id}/members/${bob.device_id}`, { method: 'DELETE', headers: auth(bob.token) })
    expect(res.status).toBe(200)
    const removed = groupEvents(db, alice.device_id).find(e => e.type === 'group.member_removed')
    expect(removed?.data).toEqual({ group_id: group.group_id, device_ids: [bob.device_id], by_device_id: bob.device_id })
    const list = await (await app.request('/v1/groups', { headers: auth(bob.token) })).json() as any
    expect(list.groups).toEqual([])
  })

  it('returns 404 for non-member targets and unknown groups, 403 for non-member callers', async () => {
    const { app, alice, bob, outsider } = await setup()
    const group = await (await createGroup(app, alice, 'group', [bob.device_id])).json() as any
    const del = (dev: RegisteredDevice, groupId: string, target: string) =>
      app.request(`/v1/groups/${groupId}/members/${target}`, { method: 'DELETE', headers: auth(dev.token) })

    expect((await del(alice, group.group_id, outsider.device_id)).status).toBe(404)
    expect((await del(alice, 'g_doesnotexistdoesnotex', bob.device_id)).status).toBe(404)
    expect((await del(outsider, group.group_id, bob.device_id)).status).toBe(403)
    expect((await del(outsider, group.group_id, outsider.device_id)).status).toBe(403)
  })
})
