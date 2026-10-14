import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Config } from '../config'
import type { Database } from '../db'
import type { EventBus } from '../events/bus'
import type { Logger } from './logger'

/** Identity of the authenticated caller, set by the bearer middleware. */
export interface AuthContext {
  userId: string
  deviceId: string
}

export interface AppEnv {
  Variables: {
    auth: AuthContext
  }
}

export type App = OpenAPIHono<AppEnv>

/** Dependencies handed to every module's `register(app, deps)`. */
export interface AppDeps {
  db: Database
  config: Config
  bus: EventBus
  logger: Logger
  /** Current time in ms since the Unix epoch; injectable for tests. */
  now: () => number
}
