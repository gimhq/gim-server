import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrate } from './migrations'

export type { Database } from 'bun:sqlite'

/** Opens (creating if needed) the SQLite database and applies pending migrations. */
export function openDatabase(path: string): Database {
  if (path !== ':memory:')
    mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true, strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  db.run('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}
