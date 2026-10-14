export type ErrorCode
  = | 'validation_failed'
    | 'unauthorized'
    | 'not_member'
    | 'not_found'
    | 'stale_epoch'
    | 'cursor_expired'
    | 'payload_too_large'
    | 'range_not_satisfiable'
    | 'internal_error'
    | 'not_implemented'

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 416 | 500 | 501

export interface ErrorBody {
  error: { code: ErrorCode, message: string }
  [extra: string]: unknown
}

/**
 * Throw from any handler to produce `{"error":{"code","message"}, ...extra}`
 * with the given status. `extra` holds spec-defined top-level fields such as
 * `current_epoch` (stale_epoch) or `cursor` (cursor_expired).
 */
export class ApiError extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message }, ...this.extra }
  }
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } }
}

export const notImplemented = () => new ApiError(501, 'not_implemented', 'Not implemented yet')
export const notFound = (what = 'Resource') => new ApiError(404, 'not_found', `${what} not found`)
export const notMember = () => new ApiError(403, 'not_member', 'Caller is not a member of this group')
export const unauthorized = () => new ApiError(401, 'unauthorized', 'Missing or invalid bearer token')
export const validationFailed = (message: string) => new ApiError(400, 'validation_failed', message)
export const payloadTooLarge = (limit: number) => new ApiError(413, 'payload_too_large', `Payload exceeds ${limit} bytes`)
