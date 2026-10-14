// Creates demo users, one device each, and two membership-only groups.
// Idempotent: re-running reuses users, devices and groups and rotates the
// device tokens. Prints a JSON summary to stdout.
import type { Database } from '../src/db'
import process from 'node:process'
import { loadConfig } from '../src/config'
import { openDatabase } from '../src/db'
import { appendEvent } from '../src/events/store'
import { hashToken, newId, newToken } from '../src/shared/ids'

const DEMO_USERS = ['alice', 'bob', 'carol', 'dave'] as const

type Handle = (typeof DEMO_USERS)[number]

const DEMO_GROUPS: { name: string, kind: 'group' | 'direct', handles: Handle[] }[] = [
  { name: 'demo', kind: 'group', handles: ['alice', 'bob', 'carol', 'dave'] },
  { name: 'direct', kind: 'direct', handles: ['alice', 'bob'] },
]

export interface SeedSummary {
  users: { handle: string, user_id: string, device_id: string, token: string }[]
  groups: { name: string, group_id: string, kind: 'group' | 'direct', device_ids: string[] }[]
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function seedUser(db: Database, handle: string, ts: number) {
  const userId = db
    .query<{ id: string }, [string, string, string, number]>(
      `INSERT INTO users (id, handle, display_name, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (handle) DO UPDATE SET handle = excluded.handle
       RETURNING id`,
    )
    .get(newId('u'), handle, `${capitalize(handle)} Demo`, ts)!
    .id
  const token = newToken()
  const existing = db
    .query<{ id: string }, [string]>('SELECT id FROM devices WHERE user_id = ? ORDER BY created_at, rowid LIMIT 1')
    .get(userId)
  const deviceId = existing?.id ?? newId('d')
  if (existing)
    db.query('UPDATE devices SET token_hash = ? WHERE id = ?').run(hashToken(token), deviceId)
  else
    db.query('INSERT INTO devices (id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?)').run(deviceId, userId, hashToken(token), ts)
  return { handle, user_id: userId, device_id: deviceId, token }
}

function seedGroup(db: Database, name: string, kind: 'group' | 'direct', deviceIds: string[], ts: number): string {
  const key = `seed_group_${name}`
  const known = db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value
  if (known && db.query('SELECT 1 FROM groups WHERE id = ?').get(known))
    return known

  const groupId = newId('g')
  const creator = deviceIds[0]!
  db.query('INSERT INTO groups (id, kind, created_by_device_id, created_at) VALUES (?, ?, ?, ?)').run(groupId, kind, creator, ts)
  const insertMember = db.query('INSERT INTO group_members (group_id, device_id, added_at) VALUES (?, ?, ?)')
  for (const id of deviceIds)
    insertMember.run(groupId, id, ts)
  appendEvent(db, {
    type: 'group.member_added',
    data: { group_id: groupId, device_ids: deviceIds, by_device_id: creator },
    deviceIds,
    now: ts,
  })
  db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, groupId)
  return groupId
}

export function seed(db: Database, now: number = Date.now()): SeedSummary {
  return db.transaction(() => {
    const users = DEMO_USERS.map(handle => seedUser(db, handle, now))
    const deviceOf = (handle: Handle) => users.find(u => u.handle === handle)!.device_id
    const groups = DEMO_GROUPS.map(({ name, kind, handles }) => {
      const deviceIds = handles.map(deviceOf)
      return { name, group_id: seedGroup(db, name, kind, deviceIds, now), kind, device_ids: deviceIds }
    })
    return { users, groups }
  })()
}

if (import.meta.main) {
  const config = loadConfig()
  const db = openDatabase(config.DATABASE_PATH)
  const summary = seed(db)
  db.close()
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}
