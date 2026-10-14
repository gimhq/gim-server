import { z } from 'zod'

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def)

const ConfigSchema = z.object({
  PORT: int(8080, 1).pipe(z.number().max(65535)),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_PATH: z.string().min(1).default('./data/gim.db'),
  DATA_DIR: z.string().min(1).default('./data'),
  EVENT_RETENTION_DAYS: int(7, 1),
  KEYPACKAGE_LOW_THRESHOLD: int(10),
  MAX_MESSAGE_BYTES: int(262144, 1),
  MAX_BLOB_BYTES: int(104857600, 1),
  LONGPOLL_MAX_WAIT_SECONDS: int(30),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type Config = z.infer<typeof ConfigSchema>

/** Parses and validates the environment. Throws a readable error on invalid input. */
export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  // Treat empty strings as unset so `FOO=` falls back to the default.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''))
  const result = ConfigSchema.safeParse(cleaned)
  if (!result.success)
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`)
  return result.data
}
