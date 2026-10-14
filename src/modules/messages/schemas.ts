import { createRoute, z } from '@hono/zod-openapi'
import { Base64Schema, bearerSecurity, DeviceIdSchema, errorResponses, GroupIdSchema, intQuery, jsonBody, jsonContent, StaleEpochErrorSchema, TimestampSchema, UserIdSchema } from '../../shared/openapi'
import { GroupIdParams } from '../groups/schemas'

export const MessageKindSchema = z.enum(['commit', 'welcome', 'application']).openapi('MessageKind')

const ClientIdSchema = z.string().min(1).max(64).openapi({ description: 'Sender-chosen idempotency key, unique per sending device and group (1-64 chars)', example: '9f1c2a7e-0b44-4d0e-9a51-3c8f1e2d6b70' })
const EpochSchema = z.number().int().min(0).openapi({ description: 'MLS epoch the message belongs to' })
const PayloadSchema = Base64Schema.openapi({ description: 'Opaque MLS message bytes (MLSMessage / Welcome), base64. Never inspected by the server.' })
const RecipientsSchema = z
  .array(DeviceIdSchema)
  .min(1)
  .max(500)
  .openapi({ description: 'Welcome only: the devices the welcome is addressed to (1-500)' })

export const MessageSchema = z
  .object({
    group_id: GroupIdSchema,
    seq: z.number().int().min(1).openapi({ description: 'Per-group sequence number assigned by the server, starting at 1' }),
    sender_device_id: DeviceIdSchema,
    sender_user_id: UserIdSchema,
    client_id: ClientIdSchema,
    kind: MessageKindSchema,
    epoch: EpochSchema,
    payload: PayloadSchema,
    recipients: RecipientsSchema.optional(),
    created_at: TimestampSchema,
  })
  .openapi('Message')

export const SendMessageRequestSchema = z
  .object({
    client_id: ClientIdSchema,
    epoch: EpochSchema,
    kind: MessageKindSchema,
    payload: PayloadSchema,
    recipients: RecipientsSchema.optional().openapi({ description: 'Required for `welcome`, rejected (400) for other kinds' }),
  })
  .openapi('SendMessageRequest')

export const MessageListSchema = z
  .object({
    messages: z.array(MessageSchema),
    has_more: z.boolean().openapi({ description: 'True if more messages exist after the last returned one' }),
  })
  .openapi('MessageList')

export const sendMessageRoute = createRoute({
  method: 'post',
  path: '/v1/groups/{group_id}/messages',
  tags: ['messages'],
  summary: 'Send a message to a group',
  description: [
    'Stores the opaque MLS message, assigns the next `seq`, and emits a `message` event: `welcome` messages to their `recipients`, ',
    'other kinds to every member device except the sender.\n\n',
    'A `commit` must carry the group\'s current epoch, otherwise 409 `stale_epoch` (with `current_epoch`); an accepted commit ',
    'advances the group epoch to `epoch + 1`.\n\n',
    'Resending the same `client_id` from the same device returns the stored message with 200 and emits nothing. ',
    'A decoded payload larger than the server limit (default 262144 bytes) fails with 413.',
  ].join(''),
  security: bearerSecurity,
  request: { params: GroupIdParams, body: jsonBody(SendMessageRequestSchema) },
  responses: {
    201: jsonContent(MessageSchema, 'Message stored'),
    200: jsonContent(MessageSchema, 'Idempotent replay: the message stored earlier for this client_id'),
    ...errorResponses(400, 401, 403, 404),
    409: jsonContent(StaleEpochErrorSchema, 'Commit epoch does not match the group epoch (`stale_epoch`)'),
    ...errorResponses(413),
  },
})

export const listMessagesRoute = createRoute({
  method: 'get',
  path: '/v1/groups/{group_id}/messages',
  tags: ['messages'],
  summary: 'List group messages',
  description: 'Messages with `seq > after_seq`, ascending. Welcome messages are only visible to their sender and recipients.',
  security: bearerSecurity,
  request: {
    params: GroupIdParams,
    query: z.object({
      after_seq: intQuery('after_seq', 0, undefined, 0, 'Return messages after this seq'),
      limit: intQuery('limit', 1, 500, 100, 'Maximum number of messages (1-500)'),
    }),
  },
  responses: {
    200: jsonContent(MessageListSchema, 'Messages'),
    ...errorResponses(400, 401, 403, 404),
  },
})
