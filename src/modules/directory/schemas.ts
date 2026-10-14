import { createRoute, z } from '@hono/zod-openapi'
import { bearerSecurity, DeviceIdSchema, errorResponses, jsonContent, TimestampSchema, UserIdSchema } from '../../shared/openapi'
import { DisplayNameSchema, HandleSchema } from '../devices/schemas'

export const UserSchema = z
  .object({
    user_id: UserIdSchema,
    handle: HandleSchema,
    display_name: DisplayNameSchema,
  })
  .openapi('User')

export const DeviceSchema = z
  .object({
    device_id: DeviceIdSchema,
    created_at: TimestampSchema,
  })
  .openapi('Device')

export const UserDevicesSchema = z
  .object({
    devices: z.array(DeviceSchema),
  })
  .openapi('UserDevices')

const UserIdParams = z.object({
  user_id: UserIdSchema.openapi({ param: { name: 'user_id', in: 'path' } }),
})

export const findUserByHandleRoute = createRoute({
  method: 'get',
  path: '/v1/users',
  tags: ['directory'],
  summary: 'Look up a user by handle',
  security: bearerSecurity,
  request: {
    query: z.object({
      handle: HandleSchema.openapi({ param: { name: 'handle', in: 'query' } }),
    }),
  },
  responses: {
    200: jsonContent(UserSchema, 'The user'),
    ...errorResponses(400, 401, 404),
  },
})

export const getUserRoute = createRoute({
  method: 'get',
  path: '/v1/users/{user_id}',
  tags: ['directory'],
  summary: 'Get a user',
  security: bearerSecurity,
  request: { params: UserIdParams },
  responses: {
    200: jsonContent(UserSchema, 'The user'),
    ...errorResponses(401, 404),
  },
})

export const listUserDevicesRoute = createRoute({
  method: 'get',
  path: '/v1/users/{user_id}/devices',
  tags: ['directory'],
  summary: 'List a user\'s devices',
  description: 'Every device of the user, ordered by `created_at`. Each device is an MLS group member in its own right.',
  security: bearerSecurity,
  request: { params: UserIdParams },
  responses: {
    200: jsonContent(UserDevicesSchema, 'The user\'s devices'),
    ...errorResponses(401, 404),
  },
})
