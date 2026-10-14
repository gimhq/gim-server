import type { Config } from '../src/config'
import { createApp } from '../src/app'
import { loadConfig } from '../src/config'
import { openDatabase } from '../src/db'
import { createEventBus } from '../src/events/bus'

export interface TestAppOptions {
  /** Clock override; defaults to Date.now. */
  now?: () => number
  /** Extra env vars passed to loadConfig (DATABASE_PATH is always ":memory:"). */
  env?: Record<string, string>
}

export function makeTestApp(options: TestAppOptions = {}) {
  const config: Config = loadConfig({ LOG_LEVEL: 'error', ...options.env, DATABASE_PATH: ':memory:' })
  const db = openDatabase(':memory:')
  const bus = createEventBus()
  const app = createApp({ db, config, bus, now: options.now })
  return { app, db, bus, config }
}

export type TestApp = ReturnType<typeof makeTestApp>['app']

export function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

export function jsonHeaders(token?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(token ? auth(token) : {}) }
}

export interface RegisteredDevice {
  token: string
  user_id: string
  device_id: string
  cursor: number
}

export async function registerDevice(app: TestApp, handle: string, displayName = handle): Promise<RegisteredDevice> {
  const res = await app.request('/v1/devices', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ handle, display_name: displayName }),
  })
  if (res.status !== 201)
    throw new Error(`registerDevice(${handle}) failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<RegisteredDevice>
}
