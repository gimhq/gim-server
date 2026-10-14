import type { App, AppDeps } from '../../shared/context'
import type { GroupRow } from './repo'
import { appendEvent } from '../../events/store'
import { notFound, validationFailed } from '../../shared/errors'
import { newId } from '../../shared/ids'
import { findDevices, getGroupRow, memberDeviceIds, requireMemberGroup, toGroup } from './repo'
import { addMembersRoute, createGroupRoute, getGroupRoute, listGroupsRoute, removeMemberRoute } from './schemas'

function requireKnownDevices(devices: Map<string, string>, deviceIds: string[]): void {
  const unknown = deviceIds.filter(id => !devices.has(id))
  if (unknown.length > 0)
    throw validationFailed(`Unknown device IDs: ${unknown.join(', ')}`)
}

export function register(app: App, { db, bus, now }: AppDeps): void {
  app.openapi(createGroupRoute, (c) => {
    const { deviceId, userId } = c.get('auth')
    const { kind, member_device_ids } = c.req.valid('json')
    const deviceIds = [...new Set([deviceId, ...member_device_ids])]
    const devices = findDevices(db, deviceIds)
    requireKnownDevices(devices, deviceIds)
    if (kind === 'direct') {
      const users = new Set(devices.values())
      if (users.size !== 2 || !users.has(userId))
        throw validationFailed('A direct group must contain devices of exactly two users, including the caller')
    }

    const row = db.transaction(() => {
      const ts = now()
      const row = db
        .query<GroupRow, [string, string, string, number]>(
          `INSERT INTO groups (id, kind, created_by_device_id, created_at) VALUES (?, ?, ?, ?)
           RETURNING id, kind, epoch, next_seq, created_by_device_id, created_at`,
        )
        .get(newId('g'), kind, deviceId, ts)!
      const insertMember = db.query('INSERT INTO group_members (group_id, device_id, added_at) VALUES (?, ?, ?)')
      for (const id of deviceIds)
        insertMember.run(row.id, id, ts)
      appendEvent(db, {
        type: 'group.member_added',
        data: { group_id: row.id, device_ids: deviceIds, by_device_id: deviceId },
        deviceIds,
        now: ts,
      })
      return row
    })()
    bus.publish(deviceIds)
    return c.json(toGroup(db, row), 201)
  })

  app.openapi(listGroupsRoute, (c) => {
    const { deviceId } = c.get('auth')
    const rows = db
      .query<GroupRow, [string]>(
        `SELECT g.id, g.kind, g.epoch, g.next_seq, g.created_by_device_id, g.created_at
           FROM groups g JOIN group_members m ON m.group_id = g.id
          WHERE m.device_id = ?
          ORDER BY g.created_at, g.id`,
      )
      .all(deviceId)
    return c.json({ groups: rows.map(row => toGroup(db, row)) }, 200)
  })

  app.openapi(getGroupRoute, (c) => {
    const { group_id } = c.req.valid('param')
    const row = requireMemberGroup(db, group_id, c.get('auth').deviceId)
    return c.json(toGroup(db, row), 200)
  })

  app.openapi(addMembersRoute, (c) => {
    const { deviceId } = c.get('auth')
    const { group_id } = c.req.valid('param')
    const deviceIds = [...new Set(c.req.valid('json').device_ids)]
    requireMemberGroup(db, group_id, deviceId)
    requireKnownDevices(findDevices(db, deviceIds), deviceIds)

    const recipients = db.transaction(() => {
      const ts = now()
      const insertMember = db.query('INSERT OR IGNORE INTO group_members (group_id, device_id, added_at) VALUES (?, ?, ?)')
      const added = deviceIds.filter(id => insertMember.run(group_id, id, ts).changes > 0)
      if (added.length === 0)
        return []
      const members = memberDeviceIds(db, group_id)
      appendEvent(db, {
        type: 'group.member_added',
        data: { group_id, device_ids: added, by_device_id: deviceId },
        deviceIds: members,
        now: ts,
      })
      return members
    })()
    bus.publish(recipients)
    return c.json(toGroup(db, getGroupRow(db, group_id)!), 200)
  })

  app.openapi(removeMemberRoute, (c) => {
    const { deviceId } = c.get('auth')
    const { group_id, device_id: target } = c.req.valid('param')
    requireMemberGroup(db, group_id, deviceId)

    const recipients = db.transaction(() => {
      const { changes } = db.query('DELETE FROM group_members WHERE group_id = ? AND device_id = ?').run(group_id, target)
      if (changes === 0)
        throw notFound('Member')
      const recipients = [...memberDeviceIds(db, group_id), target]
      appendEvent(db, {
        type: 'group.member_removed',
        data: { group_id, device_ids: [target], by_device_id: deviceId },
        deviceIds: recipients,
        now: now(),
      })
      return recipients
    })()
    bus.publish(recipients)
    return c.json(toGroup(db, getGroupRow(db, group_id)!), 200)
  })
}
