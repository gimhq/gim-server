import type { Config } from './config'
import type { Database } from './db'
import type { EventBus } from './events/bus'
import type { App, AppDeps, AppEnv } from './shared/context'
import type { Logger } from './shared/logger'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import { HTTPException } from 'hono/http-exception'
import pkg from '../package.json'
import * as blobs from './modules/blobs/routes'
import * as devices from './modules/devices/routes'
import * as directory from './modules/directory/routes'
import * as events from './modules/events/routes'
import { STREAM_PATH } from './modules/events/schemas'
import * as groups from './modules/groups/routes'
import * as keypackages from './modules/keypackages/routes'
import * as messages from './modules/messages/routes'
import { requireAuth } from './shared/auth'
import { ApiError, errorBody } from './shared/errors'
import { createLogger } from './shared/logger'
import { jsonContent, noSecurity } from './shared/openapi'

export interface CreateAppOptions {
  db: Database
  config: Config
  bus: EventBus
  now?: () => number
  logger?: Logger
}

const modules = [devices, directory, keypackages, groups, messages, events, blobs]

/** Routes under /v1 that skip the bearer middleware. */
function isPublic(method: string, path: string): boolean {
  return (method === 'POST' && path === '/v1/devices') || path === STREAM_PATH
}

const healthRoute = createRoute({
  method: 'get',
  path: '/healthz',
  tags: ['health'],
  summary: 'Liveness probe',
  security: noSecurity,
  responses: {
    200: jsonContent(z.object({ status: z.literal('ok') }).openapi('Health'), 'Service is up'),
  },
})

export function createApp(options: CreateAppOptions): App {
  const deps: AppDeps = {
    db: options.db,
    config: options.config,
    bus: options.bus,
    now: options.now ?? Date.now,
    logger: options.logger ?? createLogger(options.config.LOG_LEVEL),
  }

  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(errorBody('validation_failed', z.prettifyError(result.error)), 400)
    },
  })

  app.onError((err, c) => {
    if (err instanceof ApiError)
      return c.json(err.toBody(), err.status)
    if (err instanceof HTTPException && err.status < 500) {
      const code = err.status === 401 ? 'unauthorized' : err.status === 413 ? 'payload_too_large' : 'validation_failed'
      return c.json(errorBody(code, err.message || 'Bad request'), err.status === 401 || err.status === 413 ? err.status : 400)
    }
    deps.logger.error('unhandled error', { method: c.req.method, path: c.req.path, error: String(err) })
    return c.json(errorBody('internal_error', 'Internal server error'), 500)
  })

  app.notFound(c => c.json(errorBody('not_found', 'Route not found'), 404))

  const auth = requireAuth(deps.db)
  app.use('/v1/*', async (c, next) => (isPublic(c.req.method, c.req.path) ? next() : auth(c, next)))

  app.openapi(healthRoute, c => c.json({ status: 'ok' as const }, 200))

  for (const mod of modules)
    mod.register(app, deps)

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'Device token from POST /v1/devices',
  })
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'gim-server',
      version: pkg.version,
      description:
        'Mock delivery and authentication service for MLS (RFC 9420) end-to-end encrypted IM clients. '
        + 'The server stores and fans out opaque MLS messages and encrypted blobs and never sees plaintext or keys. '
        + 'JSON fields are snake_case, timestamps are integer milliseconds since the Unix epoch, binary values are standard base64. '
        + 'Every non-2xx JSON response has the shape `{"error":{"code","message"}}`.',
    },
    tags: [
      { name: 'health' },
      { name: 'devices' },
      { name: 'directory' },
      { name: 'keypackages' },
      { name: 'groups' },
      { name: 'messages' },
      { name: 'events' },
      { name: 'blobs' },
    ],
  })
  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: 'gim-server API' }))

  return app
}
