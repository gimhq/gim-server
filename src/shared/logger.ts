/* eslint-disable no-console */
import type { Config } from '../config'

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const

export interface Logger {
  debug: (msg: string, fields?: Record<string, unknown>) => void
  info: (msg: string, fields?: Record<string, unknown>) => void
  warn: (msg: string, fields?: Record<string, unknown>) => void
  error: (msg: string, fields?: Record<string, unknown>) => void
}

/** Minimal JSON-line logger. Never pass payload or blob contents to it. */
export function createLogger(level: Config['LOG_LEVEL']): Logger {
  const min = levels[level]
  const make = (lvl: keyof typeof levels, sink: (line: string) => void) =>
    (msg: string, fields?: Record<string, unknown>) => {
      if (levels[lvl] >= min)
        sink(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...fields }))
    }
  return {
    debug: make('debug', console.log),
    info: make('info', console.log),
    warn: make('warn', console.warn),
    error: make('error', console.error),
  }
}
