import { createRoute, z } from '@hono/zod-openapi'
import { bearerSecurity, DeviceIdSchema, errorResponses, GroupIdSchema, jsonBody, jsonContent, TimestampSchema, UserIdSchema } from '../../shared/openapi'

export const GroupKindSchema = z.enum(['direct', 'group']).openapi('GroupKind')

export const GroupMemberSchema = z
  .object({
    device_id: DeviceIdSchema,
    user_id: UserIdSchema,
  })
  .openapi('GroupMember')

export const GroupSchema = z
  .object({
    group_id: GroupIdSchema,
    kind: GroupKindSchema,
    epoch: z.number().int().min(0).openapi({ description: 'Current MLS epoch as tracked by the delivery service (advanced by accepted commits)' }),
    created_by_device_id: DeviceIdSchema,
    created_at: TimestampSchema,
    members: z.array(GroupMemberSchema).openapi({ description: 'Member devices (delivery-service view of the roster)' }),
  })
  .openapi('Group')

export const GroupListSchema = z
  .object({
    groups: z.array(GroupSchema),
  })
  .openapi('GroupList')

export const CreateGroupRequestSchema = z
  .object({
    kind: GroupKindSchema,
    member_device_ids: z
      .array(DeviceIdSchema)
      .max(500)
      .openapi({ description: 'Other devices to add (0-500). The calling device is always a member. Unknown devices fail with 400.' }),
  })
  .openapi('CreateGroupRequest')

export const AddMembersRequestSchema = z
  .object({
    device_ids: z.array(DeviceIdSchema).min(1).max(500).openapi({ description: 'Devices to add (1-500). Unknown devices fail with 400.' }),
  })
  .openapi('AddMembersRequest')

export const GroupIdParams = z.object({
  group_id: GroupIdSchema.openapi({ param: { name: 'group_id', in: 'path' } }),
})

export const createGroupRoute = createRoute({
  method: 'post',
  path: '/v1/groups',
  tags: ['groups'],
  summary: 'Create a group',
  description: 'Creates a group at epoch 0 with the calling device as creator and member.',
  security: bearerSecurity,
  request: { body: jsonBody(CreateGroupRequestSchema) },
  responses: {
    201: jsonContent(GroupSchema, 'Group created'),
    ...errorResponses(400, 401),
  },
})

export const listGroupsRoute = createRoute({
  method: 'get',
  path: '/v1/groups',
  tags: ['groups'],
  summary: 'List groups the calling device is a member of',
  security: bearerSecurity,
  responses: {
    200: jsonContent(GroupListSchema, 'Groups'),
    ...errorResponses(401),
  },
})

export const getGroupRoute = createRoute({
  method: 'get',
  path: '/v1/groups/{group_id}',
  tags: ['groups'],
  summary: 'Get a group',
  security: bearerSecurity,
  request: { params: GroupIdParams },
  responses: {
    200: jsonContent(GroupSchema, 'The group'),
    ...errorResponses(401, 403, 404),
  },
})

export const addMembersRoute = createRoute({
  method: 'post',
  path: '/v1/groups/{group_id}/members',
  tags: ['groups'],
  summary: 'Add member devices',
  description: 'Adds devices to the roster (already-present devices are ignored) and emits `group.member_added` to all members.',
  security: bearerSecurity,
  request: { params: GroupIdParams, body: jsonBody(AddMembersRequestSchema) },
  responses: {
    200: jsonContent(GroupSchema, 'Updated group'),
    ...errorResponses(400, 401, 403, 404),
  },
})

export const removeMemberRoute = createRoute({
  method: 'delete',
  path: '/v1/groups/{group_id}/members/{device_id}',
  tags: ['groups'],
  summary: 'Remove a member device',
  description: 'Removes a device from the roster (a device may remove itself to leave) and emits `group.member_removed` to the previous members.',
  security: bearerSecurity,
  request: {
    params: GroupIdParams.extend({
      device_id: DeviceIdSchema.openapi({ param: { name: 'device_id', in: 'path' } }),
    }),
  },
  responses: {
    200: jsonContent(GroupSchema, 'Updated group'),
    ...errorResponses(401, 403, 404),
  },
})
