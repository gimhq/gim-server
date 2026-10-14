import { Buffer } from 'node:buffer'

export type IdPrefix = 'u' | 'd' | 'g' | 'b'

function randomBase64Url(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')
}

/** Opaque ID: `<prefix>_` + 22 chars base64url of 16 random bytes. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBase64Url(16)}`
}

/** Bearer token: 32 random bytes, base64url. Only its hash is stored. */
export function newToken(): string {
  return randomBase64Url(32)
}

/** Hex SHA-256 of a bearer token, as stored in `devices.token_hash`. */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex')
}
