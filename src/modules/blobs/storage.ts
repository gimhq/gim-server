import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { payloadTooLarge, validationFailed } from '../../shared/errors'

export function blobDir(dataDir: string): string {
  return join(dataDir, 'blobs')
}

export function blobPath(dataDir: string, blobId: string): string {
  return join(blobDir(dataDir), blobId)
}

/**
 * Streams `body` to `<DATA_DIR>/blobs/<blobId>` via a temp file and rename.
 * Throws 413 once more than `maxBytes` arrive and 400 for an empty body; the
 * partial file is removed on any failure. Returns the stored size.
 */
export async function writeBlob(dataDir: string, blobId: string, body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<number> {
  if (!body)
    throw validationFailed('Request body is empty')
  await mkdir(blobDir(dataDir), { recursive: true })
  const finalPath = blobPath(dataDir, blobId)
  const tmpPath = `${finalPath}.tmp`
  const sink = Bun.file(tmpPath).writer()
  let size = 0
  try {
    for await (const chunk of body) {
      size += chunk.byteLength
      if (size > maxBytes)
        throw payloadTooLarge(maxBytes)
      sink.write(chunk)
    }
    await sink.end()
    if (size === 0)
      throw validationFailed('Request body is empty')
    await rename(tmpPath, finalPath)
    return size
  }
  catch (err) {
    await Promise.resolve(sink.end()).catch(() => {})
    await rm(tmpPath, { force: true })
    throw err
  }
}

export type ByteRange = { start: number, end: number } | 'unsatisfiable' | null

/**
 * Parses a single `bytes=` range against `size` (RFC 9110 §14.1.2). Returns
 * null when the header should be ignored (absent, malformed, multi-range).
 */
export function parseRange(header: string | undefined, size: number): ByteRange {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/)
  if (!match)
    return null
  const [, first, last] = match as unknown as [string, string, string]
  if (first === '') {
    if (last === '')
      return null
    const suffix = Number(last)
    if (suffix === 0 || size === 0)
      return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (last !== '' && Number(last) < start)
    return null
  if (start >= size)
    return 'unsatisfiable'
  return { start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) }
}
