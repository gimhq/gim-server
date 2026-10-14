/**
 * WebSocket glue for Bun. `upgradeWebSocket` is used by the /v1/stream route;
 * `websocket` must be passed to Bun.serve (see src/server.ts).
 */
export { upgradeWebSocket, websocket } from 'hono/bun'
