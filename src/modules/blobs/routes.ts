import type { App, AppDeps } from '../../shared/context'
import { ApiError, notFound, payloadTooLarge } from '../../shared/errors'
import { newId } from '../../shared/ids'
import { downloadBlobRoute, uploadBlobRoute } from './schemas'
import { blobPath, parseRange, writeBlob } from './storage'

export function register(app: App, { db, config, now }: AppDeps): void {
  app.openapi(uploadBlobRoute, async (c) => {
    const { deviceId } = c.get('auth')
    const declared = c.req.header('content-length')
    if (declared !== undefined && Number(declared) > config.MAX_BLOB_BYTES)
      throw payloadTooLarge(config.MAX_BLOB_BYTES)

    const blobId = newId('b')
    const size = await writeBlob(config.DATA_DIR, blobId, c.req.raw.body, config.MAX_BLOB_BYTES)
    db.query('INSERT INTO blobs (id, uploader_device_id, size, created_at) VALUES (?, ?, ?, ?)')
      .run(blobId, deviceId, size, now())
    return c.json({ blob_id: blobId, size }, 201)
  })

  app.openapi(downloadBlobRoute, async (c) => {
    const { blob_id } = c.req.valid('param')
    const row = db.query<{ size: number }, [string]>('SELECT size FROM blobs WHERE id = ?').get(blob_id)
    const file = Bun.file(blobPath(config.DATA_DIR, blob_id))
    if (!row || !(await file.exists()))
      throw notFound('Blob')

    const size = file.size
    const range = parseRange(c.req.header('range'), size)
    if (range === 'unsatisfiable') {
      const err = new ApiError(416, 'range_not_satisfiable', `Range not satisfiable for ${size} bytes`)
      return new Response(JSON.stringify(err.toBody()), {
        status: 416,
        headers: { 'Content-Type': 'application/json', 'Content-Range': `bytes */${size}` },
      })
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' }
    if (!range) {
      headers['Content-Length'] = String(size)
      return new Response(file, { status: 200, headers })
    }
    headers['Content-Length'] = String(range.end - range.start + 1)
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
    return new Response(file.slice(range.start, range.end + 1), { status: 206, headers })
  })
}
