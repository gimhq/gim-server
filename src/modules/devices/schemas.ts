import { createRoute, z } from '@hono/zod-openapi'
import { bearerSecurity, CursorSchema, DeviceIdSchema, errorResponses, jsonBody, jsonContent, noSecurity, UserIdSchema } from '../../shared/openapi'

export const HandleSchema = z
  .string()
  .regex(/^[a-z0-9_]{3,32}$/)
  .openapi({ description: 'Unique user handle: 3-32 chars of a-z, 0-9, _', example: 'alice' })

export const DisplayNameSchema = z.string().min(1).max(64).openapi({ description: 'Display name (1-64 chars)', example: 'Alice' })

export const RegisterDeviceRequestSchema = z
  .object({
    handle: HandleSchema,
    display_name: DisplayNameSchema,
  })
  .openapi('RegisterDeviceRequest')

export const RegisterDeviceResponseSchema = z
  .object({
    user_id: UserIdSchema,
    device_id: DeviceIdSchema,
    token: z.string().openapi({ description: 'Bearer token for this device. Returned once; store it securely.' }),
    cursor: CursorSchema.openapi({ description: 'Current head cursor; start the event stream from here' }),
  })
  .openapi('RegisterDeviceResponse')

export const MeSchema = z
  .object({
    user_id: UserIdSchema,
    device_id: DeviceIdSchema,
    handle: HandleSchema,
    display_name: DisplayNameSchema,
  })
  .openapi('Me')

export const registerDeviceRoute = createRoute({
  method: 'post',
  path: '/v1/devices',
  tags: ['devices'],
  summary: 'Register a device (mock sign-in)',
  description:
    'Creates a device and its bearer token. If the handle does not exist a new user is created; otherwise the device '
    + 'is added to the existing user and `display_name` is ignored. No credentials are checked (mock authentication).',
  security: noSecurity,
  request: { body: jsonBody(RegisterDeviceRequestSchema) },
  responses: {
    201: jsonContent(RegisterDeviceResponseSchema, 'Device registered'),
    ...errorResponses(400),
  },
})

export const meRoute = createRoute({
  method: 'get',
  path: '/v1/me',
  tags: ['devices'],
  summary: 'Get the calling user and device',
  security: bearerSecurity,
  responses: {
    200: jsonContent(MeSchema, 'Caller identity'),
    ...errorResponses(401),
  },
})
