import { describe, expect, it } from 'bun:test'
import { makeTestApp } from './helpers'

const expectedOperations = [
  'get /healthz',
  'post /v1/devices',
  'get /v1/me',
  'get /v1/users',
  'get /v1/users/{user_id}',
  'get /v1/users/{user_id}/devices',
  'post /v1/keypackages',
  'get /v1/keypackages/count',
  'post /v1/keypackages/claim',
  'post /v1/groups',
  'get /v1/groups',
  'get /v1/groups/{group_id}',
  'post /v1/groups/{group_id}/members',
  'delete /v1/groups/{group_id}/members/{device_id}',
  'post /v1/groups/{group_id}/messages',
  'get /v1/groups/{group_id}/messages',
  'get /v1/events',
  'get /v1/stream',
  'post /v1/blobs',
  'get /v1/blobs/{blob_id}',
]

async function servedDocument() {
  const { app } = makeTestApp()
  const res = await app.request('/openapi.json')
  expect(res.status).toBe(200)
  return res.json() as Promise<any>
}

describe('openapi', () => {
  it('matches the committed openapi.json (run `bun run openapi` after schema changes)', async () => {
    const committed = await Bun.file(new URL('../openapi.json', import.meta.url)).json()
    expect(await servedDocument()).toEqual(committed)
  })

  it('documents every M1 operation', async () => {
    const doc = await servedDocument()
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info.title).toBe('gim-server')
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })
    const operations = Object.entries(doc.paths as Record<string, Record<string, unknown>>)
      .flatMap(([path, item]) => Object.keys(item).map(method => `${method} ${path}`))
    expect(operations.sort()).toEqual([...expectedOperations].sort())
  })

  it('declares 401 on every authenticated operation', async () => {
    const doc = await servedDocument()
    for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, any>>)) {
      for (const [method, op] of Object.entries(item)) {
        const isPublic = path === '/healthz' || (method === 'post' && path === '/v1/devices') || path === '/v1/stream'
        if (!isPublic)
          expect(op.responses['401'], `${method} ${path}`).toBeDefined()
      }
    }
  })
})
