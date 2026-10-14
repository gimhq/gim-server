// Writes openapi.json from the app's route definitions using default config,
// so the output is deterministic regardless of the local environment.
import { createApp } from '../src/app'
import { loadConfig } from '../src/config'
import { openDatabase } from '../src/db'
import { createEventBus } from '../src/events/bus'

const db = openDatabase(':memory:')
const app = createApp({ db, config: loadConfig({ DATABASE_PATH: ':memory:' }), bus: createEventBus() })
const res = await app.request('/openapi.json')
if (res.status !== 200)
  throw new Error(`openapi generation failed: ${res.status} ${await res.text()}`)
const doc = await res.json()
const target = new URL('../openapi.json', import.meta.url)
await Bun.write(target, `${JSON.stringify(doc, null, 2)}\n`)
db.close()
console.warn(`wrote ${target.pathname}`)
