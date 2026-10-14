import type { Database } from '../../db'
import type { App, AppDeps } from '../../shared/context'
import { appendEvent } from '../../events/store'
import { decodeBase64, encodeBase64 } from '../../shared/base64'
import { claimKeyPackagesRoute, countKeyPackagesRoute, uploadKeyPackagesRoute } from './schemas'

function availableCount(db: Database, deviceId: string): number {
  return db
    .query<{ n: number }, [string]>('SELECT count(*) AS n FROM key_packages WHERE device_id = ? AND last_resort = 0')
    .get(deviceId)!
    .n
}

function counts(db: Database, deviceId: string) {
  const hasLastResort = db
    .query<{ one: number }, [string]>('SELECT 1 AS one FROM key_packages WHERE device_id = ? AND last_resort = 1')
    .get(deviceId) != null
  return { available: availableCount(db, deviceId), has_last_resort: hasLastResort }
}

interface PackageRow {
  id: number
  data: Uint8Array
}

export function register(app: App, { db, bus, config, now }: AppDeps): void {
  app.openapi(uploadKeyPackagesRoute, (c) => {
    const { deviceId } = c.get('auth')
    const { key_packages, last_resort } = c.req.valid('json')
    const result = db.transaction(() => {
      const ts = now()
      const insert = db.query('INSERT INTO key_packages (device_id, data, last_resort, created_at) VALUES (?, ?, ?, ?)')
      for (const kp of key_packages)
        insert.run(deviceId, decodeBase64(kp), 0, ts)
      if (last_resort !== undefined) {
        db.query('DELETE FROM key_packages WHERE device_id = ? AND last_resort = 1').run(deviceId)
        insert.run(deviceId, decodeBase64(last_resort), 1, ts)
      }
      return counts(db, deviceId)
    })()
    return c.json(result, 200)
  })

  app.openapi(countKeyPackagesRoute, c => c.json(counts(db, c.get('auth').deviceId), 200))

  app.openapi(claimKeyPackagesRoute, (c) => {
    const { device_ids } = c.req.valid('json')
    const oldest = db.query<PackageRow, [string]>(
      'SELECT id, data FROM key_packages WHERE device_id = ? AND last_resort = 0 ORDER BY id LIMIT 1',
    )
    const lastResort = db.query<PackageRow, [string]>(
      'SELECT id, data FROM key_packages WHERE device_id = ? AND last_resort = 1',
    )
    const remove = db.query('DELETE FROM key_packages WHERE id = ?')

    const low: string[] = []
    const result = db.transaction(() => {
      const ts = now()
      const key_packages: { device_id: string, key_package: string, last_resort: boolean }[] = []
      const missing: string[] = []
      for (const deviceId of device_ids) {
        const oneTime = oldest.get(deviceId)
        if (oneTime) {
          remove.run(oneTime.id)
          key_packages.push({ device_id: deviceId, key_package: encodeBase64(oneTime.data), last_resort: false })
          const available = availableCount(db, deviceId)
          if (available < config.KEYPACKAGE_LOW_THRESHOLD) {
            appendEvent(db, { type: 'keypackages.low', data: { available }, deviceIds: [deviceId], now: ts })
            low.push(deviceId)
          }
          continue
        }
        const fallback = lastResort.get(deviceId)
        if (fallback)
          key_packages.push({ device_id: deviceId, key_package: encodeBase64(fallback.data), last_resort: true })
        else
          missing.push(deviceId)
      }
      return { key_packages, missing }
    })()
    bus.publish(low)
    return c.json(result, 200)
  })
}
