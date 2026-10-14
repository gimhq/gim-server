import { createRoute, z } from '@hono/zod-openapi'
import { bearerSecurity, BlobIdSchema, errorResponses, jsonContent } from '../../shared/openapi'

const BinarySchema = z.string().openapi({ format: 'binary', description: 'Raw encrypted bytes' })

export const BlobCreatedSchema = z
  .object({
    blob_id: BlobIdSchema,
    size: z.number().int().min(0).openapi({ description: 'Stored size in bytes' }),
  })
  .openapi('BlobCreated')

export const uploadBlobRoute = createRoute({
  method: 'post',
  path: '/v1/blobs',
  tags: ['blobs'],
  summary: 'Upload an encrypted blob',
  description: 'Stores the request body verbatim. The client encrypts before upload and shares the blob ID and key inside MLS messages. Bodies larger than the server limit (default 104857600 bytes) fail with 413.',
  security: bearerSecurity,
  request: {
    body: { required: true, content: { 'application/octet-stream': { schema: BinarySchema } } },
  },
  responses: {
    201: jsonContent(BlobCreatedSchema, 'Blob stored'),
    ...errorResponses(401, 413),
  },
})

export const downloadBlobRoute = createRoute({
  method: 'get',
  path: '/v1/blobs/{blob_id}',
  tags: ['blobs'],
  summary: 'Download an encrypted blob',
  description: 'Supports a single byte range (`Range: bytes=a-b`, `bytes=a-`, or `bytes=-n`).',
  security: bearerSecurity,
  request: {
    params: z.object({
      blob_id: BlobIdSchema.openapi({ param: { name: 'blob_id', in: 'path' } }),
    }),
    headers: z.object({
      range: z.string().optional().openapi({ description: 'Single byte range', example: 'bytes=0-1023' }),
    }),
  },
  responses: {
    200: {
      description: 'Whole blob',
      headers: {
        'Accept-Ranges': { schema: { type: 'string', example: 'bytes' } },
        'Content-Length': { schema: { type: 'integer' } },
      },
      content: { 'application/octet-stream': { schema: BinarySchema } },
    },
    206: {
      description: 'Requested byte range',
      headers: {
        'Accept-Ranges': { schema: { type: 'string', example: 'bytes' } },
        'Content-Range': { schema: { type: 'string', example: 'bytes 0-1023/4096' } },
        'Content-Length': { schema: { type: 'integer' } },
      },
      content: { 'application/octet-stream': { schema: BinarySchema } },
    },
    ...errorResponses(401, 404, 416),
  },
})
