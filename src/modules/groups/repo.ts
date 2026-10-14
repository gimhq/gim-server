import type { z } from '@hono/zod-openapi'
import type { Database } from '../../db'
import type { GroupSchema } from './schemas'
import { notFound, notMember } from '../../shared/errors'

export type Group = z.infer<typeof GroupSchema>

export interface GroupRow {
  id: string
  kind: Group['kind']
  epoch: number
  next_seq: number
  created_by_device_id: string
  created_at: number
}

export function getGroupRow(db: Database, groupId: string): GroupRow | null {
  return db
    .query<GroupRow, [string]>('SELECT id, kind, epoch, next_seq, created_by_device_id, created_at FROM groups WHERE id = ?')
    .get(groupId)
}

/** Loads a group the caller belongs to: 404 if it does not exist, 403 if the caller is not a member. */
export function requireMemberGroup(db: Database, groupId: string, deviceId: string): GroupRow {
  const row = getGroupRow(db, groupId)
  if (!row)
    throw notFound('Group')
  if (!isMember(db, groupId, deviceId))
    throw notMember()
  return row
}

export function isMember(db: Database, groupId: string, deviceId: string): boolean {
  return db.query('SELECT 1 FROM group_members WHERE group_id = ? AND device_id = ?').get(groupId, deviceId) !== null
}

/** Member device IDs ordered by (added_at, device_id). */
export function memberDeviceIds(db: Database, groupId: string): string[] {
  return db
    .query<{ device_id: string }, [string]>('SELECT device_id FROM group_members WHERE group_id = ? ORDER BY added_at, device_id')
    .all(groupId)
    .map(r => r.device_id)
}

/** Looks up devices by ID; the map only contains the ones that exist. */
export function findDevices(db: Database, deviceIds: string[]): Map<string, string> {
  const rows = db
    .query<{ id: string, user_id: string }, [string]>('SELECT id, user_id FROM devices WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(deviceIds))
  return new Map(rows.map(r => [r.id, r.user_id]))
}

export function toGroup(db: Database, row: GroupRow): Group {
  const members = db
    .query<{ device_id: string, user_id: string }, [string]>(
      `SELECT m.device_id, d.user_id
         FROM group_members m JOIN devices d ON d.id = m.device_id
        WHERE m.group_id = ?
        ORDER BY m.added_at, m.device_id`,
    )
    .all(row.id)
  return {
    group_id: row.id,
    kind: row.kind,
    epoch: row.epoch,
    created_by_device_id: row.created_by_device_id,
    created_at: row.created_at,
    members,
  }
}
