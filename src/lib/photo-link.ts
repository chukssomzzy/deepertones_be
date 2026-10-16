const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** How long a signed photo link works. */
export const PHOTO_LINK_TTL_SECONDS = 300

// Far above any real link (a key, a user id and an expiry); anything longer is not ours and is not worth decoding.
const MAX_TOKEN_LENGTH = 2048

// Names this use of the secret. A different info derives an unrelated key, so the secret that signs JWTs (the container
// passes JWT_SECRET) cannot be used to forge a photo link, and a photo link signature is no use against a JWT.
const HKDF_INFO = 'deepertones/photo-link/v1'

export type PhotoLink = { key: string; userId: string }

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Throws on anything that is not base64url, so callers treat a throw as "invalid". */
const fromBase64Url = (text: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url')
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
}

/** HMAC-SHA-256 key from HKDF-SHA-256(secret, empty salt, info): 256 bits. */
const hmacKey = async (secret: string, usage: 'sign' | 'verify') => {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(HKDF_INFO) },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    [usage],
  )
}

/**
 * Makes a token that lets whoever holds it read one private photo until `expiresAt`. The token is base64url of
 * "payload.signature": the payload is JSON of the key, the user and the expiry (epoch milliseconds), the signature is
 * base64url of the HMAC of that JSON. It is opaque and carries nothing secret.
 */
export const signPhotoLink = async (link: PhotoLink & { expiresAt: Date }, secret: string): Promise<string> => {
  const payload = JSON.stringify({ key: link.key, userId: link.userId, exp: link.expiresAt.getTime() })
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(payload))
  return toBase64Url(encoder.encode(`${payload}.${toBase64Url(new Uint8Array(signature))}`))
}

/**
 * The key and user a token was signed for, or null for anything else: malformed, over 2048 characters, signed with another
 * secret, tampered with or expired. The reasons are not told apart, so a caller cannot probe them. The signature is checked
 * with crypto.subtle.verify, which compares in constant time, and before the payload is read.
 */
export const verifyPhotoLink = async (token: string, secret: string, now: Date): Promise<PhotoLink | null> => {
  if (token.length > MAX_TOKEN_LENGTH) return null
  try {
    const text = decoder.decode(fromBase64Url(token))
    const dot = text.lastIndexOf('.')
    if (dot < 0) return null
    const payload = text.slice(0, dot)

    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), fromBase64Url(text.slice(dot + 1)), encoder.encode(payload))
    if (!valid) return null

    const claims: unknown = JSON.parse(payload)
    if (typeof claims !== 'object' || claims === null) return null
    const { key, userId, exp } = claims as Record<string, unknown>
    if (typeof key !== 'string' || typeof userId !== 'string' || typeof exp !== 'number') return null
    if (now.getTime() >= exp) return null
    return { key, userId }
  } catch {
    return null
  }
}
