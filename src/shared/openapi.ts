import type { ZodType } from 'zod'
import type { ErrorStatus } from './errors'
import { z } from '@hono/zod-openapi'

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ description: 'Machine-readable snake_case error code', example: 'not_found' }),
      message: z.string().openapi({ description: 'Human-readable description' }),
    }),
  })
  .openapi('Error')

export const StaleEpochErrorSchema = ErrorSchema.extend({
  current_epoch: z.number().int().min(0).openapi({ description: 'The group\'s current epoch' }),
}).openapi('StaleEpochError')

export const CursorExpiredErrorSchema = ErrorSchema.extend({
  cursor: z.number().int().min(0).openapi({ description: 'Current head cursor; resync state, then continue from here' }),
}).openapi('CursorExpiredError')

const errorDescriptions: Record<ErrorStatus, string> = {
  400: 'Validation failed (`validation_failed`)',
  401: 'Missing or invalid bearer token (`unauthorized`)',
  403: 'Caller is not a member of the group (`not_member`)',
  404: 'Not found (`not_found`)',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload too large (`payload_too_large`)',
  416: 'Range not satisfiable (`range_not_satisfiable`)',
  500: 'Internal error (`internal_error`)',
  501: 'Not implemented (`not_implemented`)',
}

/** Builds the error part of a route's `responses` map using the shared Error schema. */
export function errorResponses<S extends ErrorStatus>(...statuses: S[]) {
  return Object.fromEntries(
    statuses.map(s => [s, { description: errorDescriptions[s], content: { 'application/json': { schema: ErrorSchema } } }]),
  ) as Record<S, { description: string, content: { 'application/json': { schema: typeof ErrorSchema } } }>
}

export function jsonContent<T extends ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } }
}

export function jsonBody<T extends ZodType>(schema: T) {
  return { required: true, content: { 'application/json': { schema } } }
}

/** Route-level security requirement for authenticated routes. */
export const bearerSecurity = [{ bearerAuth: [] }]
/** Route-level security override for public routes. */
export const noSecurity = []

export const UserIdSchema = z.string().openapi({ description: 'Opaque user ID', example: 'u_3q2-7wZpQkSx5n1bX0yJ4A' })
export const DeviceIdSchema = z.string().openapi({ description: 'Opaque device ID', example: 'd_V1c9sG0kq4m2T8xYbR7wLg' })
export const GroupIdSchema = z.string().openapi({ description: 'Opaque group ID', example: 'g_Zp8nA2vQe5rK1yW6tH3uJw' })
export const BlobIdSchema = z.string().openapi({ description: 'Opaque blob ID', example: 'b_Hk4dN7sL2pX9cV0mB5qT1g' })
export const TimestampSchema = z.number().int().openapi({ description: 'Milliseconds since the Unix epoch', example: 1760479200000 })
// Non-literal so the OAS 3.1 `contentEncoding` keyword passes the metadata type.
const base64Meta = { contentEncoding: 'base64', description: 'Standard base64 (RFC 4648 §4) of opaque bytes' }
export const Base64Schema = z.base64().openapi(base64Meta)
/**
 * Integer query parameter. The explicit schema stops the generator from
 * advertising `null` (which z.coerce would turn into 0); overriding `type`
 * drops the inferred bounds, so they are restated here.
 */
export function intQuery(name: string, min: number, max: number | undefined, def: number, description: string) {
  const base = z.coerce.number().int().min(min)
  return (max === undefined ? base : base.max(max)).default(def).openapi({
    type: 'integer',
    minimum: min,
    ...(max === undefined ? {} : { maximum: max }),
    default: def,
    param: { name, in: 'query' },
    description,
  })
}

export const CursorSchema = z.number().int().min(0).openapi({ description: 'Global event cursor (event ID)' })
