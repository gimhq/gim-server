import { describe, expect, it } from 'bun:test'
import { makeTestApp } from './helpers'

describe('health', () => {
  it('GET /healthz returns ok without auth', async () => {
    const { app } = makeTestApp()
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('unknown routes return a JSON 404', async () => {
    const { app } = makeTestApp()
    const res = await app.request('/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } })
  })

  it('serves Scalar at /docs', async () => {
    const { app } = makeTestApp()
    const res = await app.request('/docs')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('/openapi.json')
  })
})
