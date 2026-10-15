const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type JwtFailure = { ok: false; reason: 'expired' | 'invalid' }
export type JwtResult = { ok: true; claims: Record<string, unknown> } | JwtFailure

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Throws on anything that is not base64url, so callers treat a throw as "invalid". */
const fromBase64Url = (text: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url')
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const encodeJson = (value: unknown): string => toBase64Url(encoder.encode(JSON.stringify(value)))

const decodeObject = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(decoder.decode(fromBase64Url(text)))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
  return value as Record<string, unknown>
}

const hmacKey = (secret: string, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])

// A deployment has one or two secrets, so this stays tiny; it saves a digest per sign and verify.
const keyIds = new Map<string, Promise<string>>()

/**
 * Names a secret without revealing it: the first 16 hex characters of its SHA-256. It goes in the
 * token header (`kid`) so verification knows which secret to try, which is what lets a rotated-out
 * secret keep verifying while it is still configured.
 */
export const keyId = (secret: string): Promise<string> => {
  let id = keyIds.get(secret)
  if (!id) {
    id = crypto.subtle.digest('SHA-256', encoder.encode(secret)).then((digest) =>
      Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    )
    keyIds.set(secret, id)
  }
  return id
}

/** Signs `claims` plus `iat` and `exp` (seconds) as a compact HS256 JWS. */
export const signJwt = async (
  claims: Record<string, unknown>,
  options: { secret: string; expiresInSeconds: number; now: Date },
): Promise<string> => {
  const iat = Math.floor(options.now.getTime() / 1000)
  const header = { alg: 'HS256', typ: 'JWT', kid: await keyId(options.secret) }
  const signing = `${encodeJson(header)}.${encodeJson({ ...claims, iat, exp: iat + options.expiresInSeconds })}`
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(options.secret, 'sign'), encoder.encode(signing))
  return `${signing}.${toBase64Url(new Uint8Array(signature))}`
}

const invalid: JwtFailure = { ok: false, reason: 'invalid' }

/**
 * Verifies an HS256 token against whichever of `secrets` its `kid` names.
 *
 * - The algorithm is checked strictly against HS256 and never taken from the token, which closes
 *   `alg: none` and algorithm-confusion attacks.
 * - The signature is checked with crypto.subtle.verify, which compares in constant time.
 * - `expired` is reported only after the signature is valid: an attacker who cannot sign must not
 *   be able to tell an expired token from a forged one, and a client must only be told to refresh
 *   for a token we actually issued.
 */
export const verifyJwt = async (token: string, options: { secrets: string[]; now: Date }): Promise<JwtResult> => {
  const parts = token.split('.')
  if (parts.length !== 3) return invalid
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  try {
    const header = decodeObject(headerPart)
    if (header.alg !== 'HS256' || typeof header.kid !== 'string') return invalid

    let secret: string | undefined
    for (const candidate of options.secrets) {
      if ((await keyId(candidate)) === header.kid) {
        secret = candidate
        break
      }
    }
    if (secret === undefined) return invalid

    const signature = fromBase64Url(signaturePart)
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), signature, encoder.encode(`${headerPart}.${payloadPart}`))
    if (!valid) return invalid

    const claims = decodeObject(payloadPart)
    if (typeof claims.exp !== 'number') return invalid
    if (options.now.getTime() >= claims.exp * 1000) return { ok: false, reason: 'expired' }
    return { ok: true, claims }
  } catch {
    return invalid
  }
}
