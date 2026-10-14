import type { Database } from 'bun:sqlite'

/**
 * Ordered schema migrations. Index i upgrades `PRAGMA user_version` from i to i + 1.
 * Never edit a released entry; append a new one instead.
 */
export const migrations: readonly string[] = [
  /* sql */ `
  CREATE TABLE users (
    id           TEXT PRIMARY KEY,
    handle       TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE devices (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX devices_user_id ON devices(user_id);

  CREATE TABLE key_packages (
    id          INTEGER PRIMARY KEY,
    device_id   TEXT NOT NULL REFERENCES devices(id),
    data        BLOB NOT NULL,
    last_resort INTEGER NOT NULL DEFAULT 0 CHECK (last_resort IN (0, 1)),
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX key_packages_device ON key_packages(device_id, last_resort, id);
  CREATE UNIQUE INDEX key_packages_one_last_resort ON key_packages(device_id) WHERE last_resort = 1;

  CREATE TABLE groups (
    id                   TEXT PRIMARY KEY,
    kind                 TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
    epoch                INTEGER NOT NULL DEFAULT 0,
    next_seq             INTEGER NOT NULL DEFAULT 1,
    created_by_device_id TEXT NOT NULL REFERENCES devices(id),
    created_at           INTEGER NOT NULL
  );

  CREATE TABLE group_members (
    group_id  TEXT NOT NULL REFERENCES groups(id),
    device_id TEXT NOT NULL REFERENCES devices(id),
    added_at  INTEGER NOT NULL,
    PRIMARY KEY (group_id, device_id)
  ) WITHOUT ROWID;
  CREATE INDEX group_members_device ON group_members(device_id, group_id);

  CREATE TABLE messages (
    group_id         TEXT NOT NULL REFERENCES groups(id),
    seq              INTEGER NOT NULL,
    sender_device_id TEXT NOT NULL REFERENCES devices(id),
    client_id        TEXT NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('commit', 'welcome', 'application')),
    epoch            INTEGER NOT NULL,
    payload          BLOB NOT NULL,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (group_id, seq),
    UNIQUE (group_id, sender_device_id, client_id)
  );

  CREATE TABLE message_recipients (
    group_id  TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    device_id TEXT NOT NULL REFERENCES devices(id),
    PRIMARY KEY (group_id, seq, device_id),
    FOREIGN KEY (group_id, seq) REFERENCES messages(group_id, seq)
  ) WITHOUT ROWID;

  CREATE TABLE events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX events_created_at ON events(created_at);

  CREATE TABLE event_recipients (
    event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    PRIMARY KEY (device_id, event_id)
  ) WITHOUT ROWID;
  CREATE INDEX event_recipients_event ON event_recipients(event_id);

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE blobs (
    id                 TEXT PRIMARY KEY,
    uploader_device_id TEXT NOT NULL REFERENCES devices(id),
    size               INTEGER NOT NULL,
    created_at         INTEGER NOT NULL
  );
  `,
]

export function migrate(db: Database): void {
  const current = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
  for (let version = current; version < migrations.length; version++) {
    db.transaction(() => {
      db.run(migrations[version]!)
      db.run(`PRAGMA user_version = ${version + 1}`)
    })()
  }
}
