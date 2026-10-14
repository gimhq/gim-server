import type { z } from '@hono/zod-openapi'
import type { Database } from '../../db'
import type { App, AppDeps } from '../../shared/context'
import type { GroupRow } from '../groups/repo'
import type { MessageSchema } from './schemas'
import { appendEvent } from '../../events/store'
import { decodeBase64, encodeBase64 } from '../../shared/base64'
import { ApiError, payloadTooLarge, validationFailed } from '../../shared/errors'
import { findDevices, memberDeviceIds, requireMemberGroup } from '../groups/repo'
import { listMessagesRoute, sendMessageRoute } from './schemas'

type Message = z.infer<typeof MessageSchema>

interface MessageRow {
  group_id: string
  seq: number
  sender_device_id: string
  sender_user_id: string
  client_id: string
  kind: Message['kind']
  epoch: number
  payload: Uint8Array
  created_at: number
}

const SELECT_MESSAGE = `
  SELECT m.group_id, m.seq, m.sender_device_id, d.user_id AS sender_user_id, m.client_id, m.kind, m.epoch, m.payload, m.created_at
    FROM messages m JOIN devices d ON d.id = m.sender_device_id`

function toMessage(db: Database, row: MessageRow): Message {
  const message: Message = {
    group_id: row.group_id,
    seq: row.seq,
    sender_device_id: row.sender_device_id,
    sender_user_id: row.sender_user_id,
    client_id: row.client_id,
    kind: row.kind,
    epoch: row.epoch,
    payload: encodeBase64(row.payload),
    created_at: row.created_at,
  }
  if (row.kind === 'welcome') {
    message.recipients = db
      .query<{ device_id: string }, [string, number]>('SELECT device_id FROM message_recipients WHERE group_id = ? AND seq = ? ORDER BY device_id')
      .all(row.group_id, row.seq)
      .map(r => r.device_id)
  }
  return message
}

function findByClientId(db: Database, groupId: string, senderDeviceId: string, clientId: string): Message | null {
  const row = db
    .query<MessageRow, [string, string, string]>(`${SELECT_MESSAGE} WHERE m.group_id = ? AND m.sender_device_id = ? AND m.client_id = ?`)
    .get(groupId, senderDeviceId, clientId)
  return row ? toMessage(db, row) : null
}

export function register(app: App, { db, bus, config, now }: AppDeps): void {
  app.openapi(sendMessageRoute, (c) => {
    const { deviceId } = c.get('auth')
    const { group_id } = c.req.valid('param')
    const body = c.req.valid('json')
    requireMemberGroup(db, group_id, deviceId)

    // Idempotent replay wins over every other check, whatever the body says.
    const replay = findByClientId(db, group_id, deviceId, body.client_id)
    if (replay)
      return c.json(replay, 200)

    let recipients: string[] = []
    if (body.kind === 'welcome') {
      if (!body.recipients)
        throw validationFailed('`recipients` is required for welcome messages')
      recipients = [...new Set(body.recipients)]
      const devices = findDevices(db, recipients)
      const unknown = recipients.filter(id => !devices.has(id))
      if (unknown.length > 0)
        throw validationFailed(`Unknown device IDs: ${unknown.join(', ')}`)
    }
    else if (body.recipients) {
      throw validationFailed('`recipients` is only allowed for welcome messages')
    }

    const payload = decodeBase64(body.payload)
    if (payload.byteLength > config.MAX_MESSAGE_BYTES)
      throw payloadTooLarge(config.MAX_MESSAGE_BYTES)

    const result = db.transaction(() => {
      // Re-check inside the write transaction so concurrent identical requests
      // resolve to the first stored message; the UNIQUE constraint backs this up.
      const existing = findByClientId(db, group_id, deviceId, body.client_id)
      if (existing)
        return { message: existing, created: false, fanOut: [] }

      const group = db.query<Pick<GroupRow, 'epoch' | 'next_seq'>, [string]>('SELECT epoch, next_seq FROM groups WHERE id = ?').get(group_id)!
      if (body.kind === 'commit' && body.epoch !== group.epoch)
        throw new ApiError(409, 'stale_epoch', `Commit epoch ${body.epoch} does not match group epoch ${group.epoch}`, { current_epoch: group.epoch })

      const seq = group.next_seq
      const ts = now()
      db.query('INSERT INTO messages (group_id, seq, sender_device_id, client_id, kind, epoch, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(group_id, seq, deviceId, body.client_id, body.kind, body.epoch, payload, ts)
      db.query('UPDATE groups SET next_seq = next_seq + 1, epoch = ? WHERE id = ?')
        .run(body.kind === 'commit' ? group.epoch + 1 : group.epoch, group_id)
      const insertRecipient = db.query('INSERT INTO message_recipients (group_id, seq, device_id) VALUES (?, ?, ?)')
      for (const id of recipients)
        insertRecipient.run(group_id, seq, id)

      const message = findByClientId(db, group_id, deviceId, body.client_id)!
      const fanOut = body.kind === 'welcome' ? recipients : memberDeviceIds(db, group_id).filter(id => id !== deviceId)
      appendEvent(db, { type: 'message', data: message, deviceIds: fanOut, now: ts })
      return { message, created: true, fanOut }
    }).immediate()

    if (!result.created)
      return c.json(result.message, 200)
    bus.publish(result.fanOut)
    return c.json(result.message, 201)
  })

  app.openapi(listMessagesRoute, (c) => {
    const { deviceId } = c.get('auth')
    const { group_id } = c.req.valid('param')
    const { after_seq, limit } = c.req.valid('query')
    requireMemberGroup(db, group_id, deviceId)

    const rows = db
      .query<MessageRow, [string, number, string, string, number]>(
        `${SELECT_MESSAGE}
          WHERE m.group_id = ? AND m.seq > ?
            AND (m.kind != 'welcome' OR m.sender_device_id = ?
                 OR EXISTS (SELECT 1 FROM message_recipients r WHERE r.group_id = m.group_id AND r.seq = m.seq AND r.device_id = ?))
          ORDER BY m.seq
          LIMIT ?`,
      )
      .all(group_id, after_seq, deviceId, deviceId, limit + 1)
    const has_more = rows.length > limit
    return c.json({ messages: rows.slice(0, limit).map(row => toMessage(db, row)), has_more }, 200)
  })
}
