import type { RegisteredDevice, TestApp } from './helpers'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auth, makeTestApp, registerDevice } from './helpers'

const MAX = 64

let dataDir: string
let app: TestApp
let db: ReturnType<typeof makeTestApp>['db']
let alice: RegisteredDevice

const payload = Uint8Array.from({ length: 40 }, (_, i) => (i * 37 + 255) & 0xFF)

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gim-blobs-'))
  ;({ app, db } = makeTestApp({ env: { DATA_DIR: dataDir, MAX_BLOB_BYTES: String(MAX) } }))
  alice = await registerDevice(app, 'alice')
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function upload(body: Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return app.request('/v1/blobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...auth(alice.token), ...headers },
    body,
  })
}

async function uploadPayload(): Promise<string> {
  const res = await upload(payload)
  expect(res.status).toBe(201)
  return ((await res.json()) as { blob_id: string }).blob_id
}

function download(blobId: string, range?: string) {
  return app.request(`/v1/blobs/${blobId}`, { headers: { ...auth(alice.token), ...(range ? { Range: range } : {}) } })
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(chunk)
      controller.close()
    },
  })
}

function blobFiles(): string[] {
  try {
    return readdirSync(join(dataDir, 'blobs'))
  }
  catch {
    return []
  }
}

describe('blobs', () => {
  it('requires a bearer token', async () => {
    const up = await app.request('/v1/blobs', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: payload })
    expect(up.status).toBe(401)
    expect(((await up.json()) as { error: { code: string } }).error.code).toBe('unauthorized')
    const down = await app.request('/v1/blobs/b_AAAAAAAAAAAAAAAAAAAAAA')
    expect(down.status).toBe(401)
  })

  it('round-trips binary bytes exactly and records the uploader', async () => {
    const res = await upload(payload)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { blob_id: string, size: number }
    expect(body.blob_id).toMatch(/^b_[\w-]{22}$/)
    expect(body.size).toBe(payload.length)
    expect(blobFiles()).toEqual([body.blob_id])

    const row = db.query<{ uploader_device_id: string, size: number }, [string]>('SELECT uploader_device_id, size FROM blobs WHERE id = ?').get(body.blob_id)
    expect(row).toEqual({ uploader_device_id: alice.device_id, size: payload.length })

    const bob = await registerDevice(app, 'bob')
    const down = await app.request(`/v1/blobs/${body.blob_id}`, { headers: auth(bob.token) })
    expect(down.status).toBe(200)
    expect(down.headers.get('content-type')).toBe('application/octet-stream')
    expect(down.headers.get('content-length')).toBe(String(payload.length))
    expect(down.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await down.arrayBuffer())).toEqual(payload)
  })

  it('accepts a body of exactly the limit', async () => {
    const res = await upload(new Uint8Array(MAX).fill(7))
    expect(res.status).toBe(201)
  })

  it('rejects a declared Content-Length over the limit with 413', async () => {
    const res = await upload(new Uint8Array(MAX + 1))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('payload_too_large')
    expect(blobFiles()).toEqual([])
  })

  it('enforces the limit while streaming and deletes the partial file', async () => {
    const res = await upload(streamOf(new Uint8Array(40), new Uint8Array(40)))
    expect(res.status).toBe(413)
    expect(blobFiles()).toEqual([])
    expect(db.query('SELECT COUNT(*) AS n FROM blobs').get()).toEqual({ n: 0 })
  })

  it('rejects an empty body with 400', async () => {
    const res = await upload(new Uint8Array(0))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_failed')
    expect(blobFiles()).toEqual([])
  })

  it('returns 404 for an unknown blob', async () => {
    const res = await download('b_AAAAAAAAAAAAAAAAAAAAAA')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })

  describe('range requests', () => {
    let blobId: string
    beforeEach(async () => {
      blobId = await uploadPayload()
    })

    async function expectPartial(range: string, start: number, end: number) {
      const res = await download(blobId, range)
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/${payload.length}`)
      expect(res.headers.get('content-length')).toBe(String(end - start + 1))
      expect(res.headers.get('accept-ranges')).toBe('bytes')
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload.slice(start, end + 1))
    }

    it('serves bytes=a-b', () => expectPartial('bytes=5-14', 5, 14))
    it('serves bytes=a-', () => expectPartial('bytes=30-', 30, 39))
    it('serves bytes=-n', () => expectPartial('bytes=-8', 32, 39))
    it('clamps an end past the size', () => expectPartial('bytes=35-1000', 35, 39))
    it('clamps a suffix longer than the size', () => expectPartial('bytes=-1000', 0, 39))

    it('returns 416 when the start is at or past the size', async () => {
      const res = await download(blobId, `bytes=${payload.length}-`)
      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toBe(`bytes */${payload.length}`)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('range_not_satisfiable')
    })

    it('returns 416 for bytes=-0', async () => {
      const res = await download(blobId, 'bytes=-0')
      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toBe(`bytes */${payload.length}`)
    })

    for (const range of ['bytes=0-1,5-6', 'bytes=abc', 'items=0-5', 'bytes=10-2', 'bytes=-']) {
      it(`ignores ${range} and returns the whole blob`, async () => {
        const res = await download(blobId, range)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-range')).toBeNull()
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload)
      })
    }
  })
})
