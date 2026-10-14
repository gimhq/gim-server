import { createRoute, z } from '@hono/zod-openapi'
import { bearerSecurity, CursorExpiredErrorSchema, CursorSchema, DeviceIdSchema, errorResponses, GroupIdSchema, intQuery, jsonContent, TimestampSchema } from '../../shared/openapi'
import { MessageSchema } from '../messages/schemas'

const eventBase = {
  cursor: CursorSchema,
  created_at: TimestampSchema,
}

export const MembershipChangeSchema = z
  .object({
    group_id: GroupIdSchema,
    device_ids: z.array(DeviceIdSchema),
    by_device_id: DeviceIdSchema,
  })
  .openapi('MembershipChange')

export const MessageEventSchema = z
  .object({ ...eventBase, type: z.literal('message'), data: MessageSchema })
  .openapi('MessageEvent')

export const MemberAddedEventSchema = z
  .object({ ...eventBase, type: z.literal('group.member_added'), data: MembershipChangeSchema })
  .openapi('MemberAddedEvent')

export const MemberRemovedEventSchema = z
  .object({ ...eventBase, type: z.literal('group.member_removed'), data: MembershipChangeSchema })
  .openapi('MemberRemovedEvent')

export const KeyPackagesLowEventSchema = z
  .object({
    ...eventBase,
    type: z.literal('keypackages.low'),
    data: z.object({
      available: z.number().int().min(0).openapi({ description: 'Remaining one-time key packages of the receiving device' }),
    }),
  })
  .openapi('KeyPackagesLowEvent')

export const EventSchema = z
  .discriminatedUnion('type', [MessageEventSchema, MemberAddedEventSchema, MemberRemovedEventSchema, KeyPackagesLowEventSchema])
  .openapi('Event', { description: 'An entry of the calling device\'s event stream, ordered by `cursor`' })

export const EventListSchema = z
  .object({
    events: z.array(EventSchema),
    next_cursor: CursorSchema.openapi({ description: 'Pass as `cursor` in the next request (unchanged if no events were returned)' }),
  })
  .openapi('EventList')

export function createListEventsRoute(maxWaitSeconds: number) {
  return createRoute({
    method: 'get',
    path: '/v1/events',
    tags: ['events'],
    summary: 'Fetch events (optionally long-polling)',
    description: [
      'Returns events addressed to the calling device with `cursor` greater than the given one, ascending. ',
      'With `wait > 0` and no pending events the request is held open up to `wait` seconds until an event arrives.\n\n',
      'If events after `cursor` have been pruned the server responds 410 `cursor_expired` with the current head `cursor`; ',
      'the client must resync its groups (GET /v1/groups, message history) and continue from that cursor.',
    ].join(''),
    security: bearerSecurity,
    request: {
      query: z.object({
        cursor: intQuery('cursor', 0, undefined, 0, 'Last cursor the client has processed'),
        wait: intQuery('wait', 0, maxWaitSeconds, 0, `Long-poll timeout in seconds (0-${maxWaitSeconds})`),
        limit: intQuery('limit', 1, 500, 100, 'Maximum number of events (1-500)'),
      }),
    },
    responses: {
      200: jsonContent(EventListSchema, 'Events'),
      ...errorResponses(400, 401),
      410: jsonContent(CursorExpiredErrorSchema, 'Cursor is older than the retention window (`cursor_expired`)'),
    },
  })
}

export const STREAM_PATH = '/v1/stream'

/** WebSocket close codes used by /v1/stream. */
export const StreamCloseCode = {
  Unauthorized: 4401,
  CursorExpired: 4410,
} as const

/** OpenAPI-only description of the WebSocket upgrade (registered with registerPath). */
export const streamPathDoc = {
  method: 'get' as const,
  path: STREAM_PATH,
  tags: ['events'],
  summary: 'Event stream (WebSocket)',
  description: [
    'WebSocket upgrade delivering the same events as GET /v1/events in real time. ',
    'Authenticate with `Authorization: Bearer <token>` or, where headers cannot be set, `?token=`.\n\n',
    'After the upgrade the server first replays every event after `cursor`, then pushes new ones. ',
    'Server-to-client frames are JSON text frames:\n\n',
    '- `{"type":"event","event":Event}` — one per event, ascending `cursor`.\n',
    '- `{"type":"error","error":{"code":"cursor_expired","message":"..."},"cursor":<head cursor>}` — sent when `cursor` ',
    'is older than the retention window, followed by close code 4410. Resync, then reconnect with the given cursor.\n\n',
    'An invalid or missing token closes the connection with code 4401. Client-to-server frames are ignored.',
  ].join(''),
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      cursor: intQuery('cursor', 0, undefined, 0, 'Last cursor the client has processed'),
      token: z.string().optional().openapi({ param: { name: 'token', in: 'query' }, description: 'Bearer token (alternative to the Authorization header)' }),
    }),
  },
  responses: {
    101: { description: 'Switching Protocols; frames as described above' },
    ...errorResponses(400),
  },
}
