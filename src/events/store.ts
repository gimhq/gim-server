import type { Database } from '../db'

export type EventType = 'message' | 'group.member_added' | 'group.member_removed' | 'keypackages.low'

export interface StoredEvent<T = unknown> {
  cursor: number
  type: EventType
  created_at: number
  data: T
}

export interface AppendEventInput {
  type: EventType
  data: unknown
  deviceIds: Iterable<string>
  now: number
}

interface EventRow {
  id: number
  type: EventType
  data: string
  created_at: number
}

const PRUNED_THROUGH_KEY = 'events_pruned_through'

function toEvent(row: EventRow): StoredEvent {
  return { cursor: row.id, type: row.type, created_at: row.created_at, data: JSON.parse(row.data) }
}

/**
 * Appends one event addressed to `deviceIds` in a single transaction (nested
 * inside the caller's transaction if one is open). Returns null without
 * writing anything when the recipient set is empty. Callers must
 * `bus.publish(deviceIds)` after their transaction commits.
 */
export function appendEvent(db: Database, input: AppendEventInput): StoredEvent | null {
  const deviceIds = [...new Set(input.deviceIds)]
  if (deviceIds.length === 0)
    return null
  return db.transaction(() => {
    const row = db
      .query<EventRow, [string, string, number]>(
        'INSERT INTO events (type, data, created_at) VALUES (?, ?, ?) RETURNING id, type, data, created_at',
      )
      .get(input.type, JSON.stringify(input.data), input.now)!
    const insertRecipient = db.query('INSERT INTO event_recipients (event_id, device_id) VALUES (?, ?)')
    for (const deviceId of deviceIds)
      insertRecipient.run(row.id, deviceId)
    return toEvent(row)
  })()
}

/** Events addressed to `deviceId` with cursor > `afterCursor`, ascending, at most `limit`. */
export function listEvents(db: Database, deviceId: string, afterCursor: number, limit: number): StoredEvent[] {
  return db
    .query<EventRow, [string, number, number]>(
      `SELECT e.id, e.type, e.data, e.created_at
         FROM event_recipients r JOIN events e ON e.id = r.event_id
        WHERE r.device_id = ? AND r.event_id > ?
        ORDER BY r.event_id
        LIMIT ?`,
    )
    .all(deviceId, afterCursor, limit)
    .map(toEvent)
}

/**
 * Highest cursor ever assigned (0 if none). Read from the AUTOINCREMENT
 * sequence so it never moves backwards, even after every event was pruned.
 */
export function headCursor(db: Database): number {
  const row = db.query<{ seq: number }, []>('SELECT seq FROM sqlite_sequence WHERE name = \'events\'').get()
  return row?.seq ?? 0
}

/** Highest cursor that has been pruned (0 if nothing was pruned yet). */
export function prunedThrough(db: Database): number {
  const row = db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(PRUNED_THROUGH_KEY)
  return row ? Number(row.value) : 0
}

/**
 * Deletes events (and their recipients) created before `olderThanMs` and
 * advances `events_pruned_through` to the highest deleted cursor.
 * Returns the number of deleted events.
 */
export function pruneEvents(db: Database, olderThanMs: number): number {
  return db.transaction(() => {
    const maxId = db
      .query<{ maxId: number | null }, [number]>('SELECT max(id) AS maxId FROM events WHERE created_at < ?')
      .get(olderThanMs)
      ?.maxId
    if (maxId == null)
      return 0
    db.query('DELETE FROM event_recipients WHERE event_id IN (SELECT id FROM events WHERE created_at < ?)').run(olderThanMs)
    const { changes } = db.query('DELETE FROM events WHERE created_at < ?').run(olderThanMs)
    db.query(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = max(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))`,
    ).run(PRUNED_THROUGH_KEY, String(maxId))
    return changes
  })()
}

/** True if events after `cursor` may have been pruned; the client must resync. */
export function isCursorExpired(db: Database, cursor: number): boolean {
  return cursor < prunedThrough(db)
}
