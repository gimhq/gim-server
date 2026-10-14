# gim-server

Mock delivery and authentication service for native IM clients whose content is
end-to-end encrypted with MLS ([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420)).

The server stores and fans out **opaque** MLS messages (commits, welcomes,
application messages), MLS KeyPackages and encrypted blobs. It never needs or
sees plaintext, keys or digests: group state, encryption and verification live
entirely in the clients.

Stack: Bun, Hono, `@hono/zod-openapi`, `bun:sqlite`. One process, one SQLite
file, one data directory.

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `0.0.0.0` | HTTP listen address |
| `DATABASE_PATH` | `./data/gim.db` | SQLite database file; `:memory:` for an ephemeral database |
| `DATA_DIR` | `./data` | Data root; encrypted blobs are stored in `$DATA_DIR/blobs` |
| `EVENT_RETENTION_DAYS` | `7` | Events older than this are pruned (hourly); clients behind the pruned cursor get 410 |
| `KEYPACKAGE_LOW_THRESHOLD` | `10` | Emit `keypackages.low` when a device's one-time KeyPackage count drops below this |
| `MAX_MESSAGE_BYTES` | `262144` | Maximum decoded message payload size |
| `MAX_BLOB_BYTES` | `104857600` | Maximum blob size |
| `LONGPOLL_MAX_WAIT_SECONDS` | `30` | Upper bound for `wait` on `GET /v1/events` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

## Run locally

```bash
bun install
cp .env.example .env   # optional; defaults work
bun run dev            # watch mode
bun run start          # plain
```

API reference: <http://localhost:8080/docs> (Scalar UI over `/openapi.json`).

## Run with Docker

```bash
docker build -t gim-server .
docker run -d --name gim-server -p 8080:8080 -v gim-data:/data gim-server
```

The image runs as a non-root user, listens on 8080, keeps the database and
blobs in the `/data` volume (`DATABASE_PATH=/data/gim.db`, `DATA_DIR=/data`)
and has a built-in health check against `/healthz`. Override any variable
from the table above with `-e`.

## Demo data

```bash
bun run seed
docker exec gim-server bun run seed   # inside the container
```

Creates users `alice`, `bob`, `carol`, `dave` ("Alice Demo", ...), one device
each, a `group` named `demo` with all four devices and a `direct` group
alice<->bob. The groups only carry membership; MLS state is established by the
clients, so they have no messages. Re-running reuses users, devices and groups
and issues fresh device tokens (old tokens stop working). Output:

```json
{
  "users": [{ "handle": "alice", "user_id": "u_...", "device_id": "d_...", "token": "..." }],
  "groups": [{ "name": "demo", "group_id": "g_...", "kind": "group", "device_ids": ["d_..."] }]
}
```

## API contract

`openapi.json` at the repository root is the client contract. It is generated
from the route schemas with `bun run openapi` and committed; clients generate
their bindings from it. Any schema change must regenerate and commit it in the
same change — `tests/openapi.test.ts` fails on drift.

Conventions: snake_case JSON fields, timestamps in integer milliseconds since
the Unix epoch, binary values as standard base64, opaque IDs (`u_`, `d_`,
`g_`, `b_` prefixes). Every route except `/healthz`, `/docs` and
`/openapi.json` requires `Authorization: Bearer <token>`. Errors are
`{"error":{"code":"<snake_case>","message":"..."}}`.

## API overview

| Routes | Purpose |
| --- | --- |
| `GET /healthz` | Liveness probe |
| `POST /v1/devices`, `GET /v1/me` | Register a device (creates the user by handle if new) and get its token; whoami |
| `GET /v1/users?handle=`, `GET /v1/users/{id}`, `GET /v1/users/{id}/devices` | Directory lookup |
| `POST /v1/keypackages`, `GET /v1/keypackages/count`, `POST /v1/keypackages/claim` | Upload, count and claim MLS KeyPackages (one-time plus last resort) |
| `POST/GET /v1/groups`, `GET /v1/groups/{id}`, `POST /v1/groups/{id}/members`, `DELETE /v1/groups/{id}/members/{device_id}` | Group membership (`group` or `direct`) |
| `POST/GET /v1/groups/{id}/messages` | Send opaque MLS messages; history by `after_seq` |
| `GET /v1/events`, `GET /v1/stream` | Per-device event stream: long-poll or WebSocket |
| `POST /v1/blobs`, `GET /v1/blobs/{id}` | Encrypted blob upload; download with single `Range` support |

## Event stream

- Every event has a **global cursor** (monotonic across the server, not
  contiguous per device). Events are addressed **per device**: a device only
  ever sees events for itself.
- `GET /v1/events?cursor=&limit=&wait=` returns events after `cursor` and a
  `next_cursor` to pass next time. With `wait > 0` and nothing pending, the
  request is held (long-poll) up to `wait` seconds (capped by
  `LONGPOLL_MAX_WAIT_SECONDS`).
- `GET /v1/stream?cursor=` upgrades to a WebSocket (token via the
  `Authorization` header or `?token=`). The server replays the backlog after
  `cursor`, then pushes live events as `{"type":"event","event":{...}}` text
  frames. Close code `4401`: missing or invalid token. Close code `4410`:
  cursor expired, preceded by a `{"type":"error","error":{"code":"cursor_expired",...},"cursor":<head>}` frame.
- Event types: `message`, `group.member_added`, `group.member_removed`
  (also delivered to the removed device, which then receives nothing more
  from the group), `keypackages.low`.
- When events after the client's cursor were pruned, `GET /v1/events` returns
  **410** `cursor_expired` with the current head `cursor`. The client resyncs
  (`GET /v1/groups`, then `GET /v1/groups/{id}/messages?after_seq=<last seen
  seq>` per group) and continues from the returned cursor.

## Message rules

- **Ordering**: every message gets a per-group `seq` starting at 1.
- **Commit epoch**: a `commit` must carry the group's current epoch, otherwise
  409 `stale_epoch` with `current_epoch`; an accepted commit advances the
  group epoch by one. Other kinds are not epoch-checked.
- **Welcome recipients**: a `welcome` requires `recipients` (device IDs) and
  is delivered and visible in history only to them and the sender. Other
  kinds reject `recipients` and fan out to every member device except the
  sender.
- **Idempotency**: resending the same `client_id` from the same device in the
  same group returns the stored message (200, same `seq`) and emits nothing.

## Checks

```bash
bun install --frozen-lockfile && bun run lint && bun run typecheck && bun test
```
