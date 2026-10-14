import { createRoute, z } from '@hono/zod-openapi'
import { Base64Schema, bearerSecurity, DeviceIdSchema, errorResponses, jsonBody, jsonContent } from '../../shared/openapi'

const KeyPackageSchema = Base64Schema.min(1).openapi({ description: 'Serialized MLS KeyPackage (TLS encoding), base64' })

export const UploadKeyPackagesRequestSchema = z
  .object({
    key_packages: z.array(KeyPackageSchema).max(100).openapi({ description: 'One-time key packages to add (0-100)' }),
    last_resort: KeyPackageSchema.optional().openapi({
      description: 'Last-resort key package; replaces the device\'s previous one. Handed out only when no one-time package remains, and never consumed.',
    }),
  })
  .openapi('UploadKeyPackagesRequest')

export const KeyPackageCountSchema = z
  .object({
    available: z.number().int().min(0).openapi({ description: 'Unclaimed one-time key packages of the calling device' }),
    has_last_resort: z.boolean().openapi({ description: 'Whether the calling device has a last-resort key package' }),
  })
  .openapi('KeyPackageCount')

export const ClaimKeyPackagesRequestSchema = z
  .object({
    device_ids: z
      .array(DeviceIdSchema)
      .min(1)
      .max(100)
      .refine(ids => new Set(ids).size === ids.length, { message: 'device_ids must be unique' })
      .openapi({ uniqueItems: true, description: 'Devices to claim one key package each for (1-100, unique)' }),
  })
  .openapi('ClaimKeyPackagesRequest')

export const ClaimedKeyPackageSchema = z
  .object({
    device_id: DeviceIdSchema,
    key_package: KeyPackageSchema,
    last_resort: z.boolean().openapi({ description: 'True if this is the device\'s (reusable) last-resort package' }),
  })
  .openapi('ClaimedKeyPackage')

export const ClaimKeyPackagesResponseSchema = z
  .object({
    key_packages: z.array(ClaimedKeyPackageSchema),
    missing: z.array(DeviceIdSchema).openapi({ description: 'Requested devices that are unknown or have no key package at all' }),
  })
  .openapi('ClaimKeyPackagesResponse')

export const uploadKeyPackagesRoute = createRoute({
  method: 'post',
  path: '/v1/keypackages',
  tags: ['keypackages'],
  summary: 'Upload key packages for the calling device',
  security: bearerSecurity,
  request: { body: jsonBody(UploadKeyPackagesRequestSchema) },
  responses: {
    200: jsonContent(KeyPackageCountSchema, 'Key package counts after the upload'),
    ...errorResponses(400, 401),
  },
})

export const countKeyPackagesRoute = createRoute({
  method: 'get',
  path: '/v1/keypackages/count',
  tags: ['keypackages'],
  summary: 'Count the calling device\'s key packages',
  security: bearerSecurity,
  responses: {
    200: jsonContent(KeyPackageCountSchema, 'Key package counts'),
    ...errorResponses(401),
  },
})

export const claimKeyPackagesRoute = createRoute({
  method: 'post',
  path: '/v1/keypackages/claim',
  tags: ['keypackages'],
  summary: 'Claim one key package per device',
  description:
    'Atomically removes and returns one one-time key package per requested device, falling back to the device\'s '
    + 'last-resort package (not removed). Emits `keypackages.low` to a device whose one-time count drops below the threshold.',
  security: bearerSecurity,
  request: { body: jsonBody(ClaimKeyPackagesRequestSchema) },
  responses: {
    200: jsonContent(ClaimKeyPackagesResponseSchema, 'Claimed key packages'),
    ...errorResponses(400, 401),
  },
})
