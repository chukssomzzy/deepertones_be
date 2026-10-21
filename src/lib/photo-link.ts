import { fromBase64Url, toBase64Url } from './base64'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** How long a signed photo link works. */
export const PHOTO_LINK_TTL_SECONDS = 300
const MAX_LIFETIME_MS = PHOTO_LINK_TTL_SECONDS * 1000

// Far above any real link (a key, a user id and an expiry); anything longer is not ours and is not worth decoding.
const MAX_TOKEN_LENGTH = 2048

// Names this use of the secret. A different info derives an unrelated key, so the secret that signs JWTs (the container
// passes JWT_SECRET) cannot be used to forge a photo link, and a photo link signature is no use against a JWT.
const HKDF_INFO = 'deepertones/photo-link/v1'

/**
 * What a link opens. A product photo (photos/...) is the user's; a face photo (faces/<environment>/<user>/<profile>/...) is the
 * profile's, so its link also names the profile and `verifyPhotoLink` gives it back.
 */
export type PhotoLink = { key: string; userId: string; profileId?: string }

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
 *
 * Throws on a link that is minted wrong, so the mistake shows up where it is made: an empty secret, an expiry that is not a
 * time or is more than PHOTO_LINK_TTL_SECONDS after `now`, a key that is not under photos/<environment>/<userId>/ (or, for a face
 * photo, faces/<environment>/<userId>/<profileId>/ with that profile in `profileId`), or a profile on a product link.
 */
export const signPhotoLink = async (link: PhotoLink & { expiresAt: Date }, secret: string, now: Date): Promise<string> => {
  if (secret === '') throw new Error('Cannot sign a photo link with an empty secret')
  const exp = link.expiresAt.getTime()
  if (!Number.isFinite(exp)) throw new Error('Photo link expiry is not a valid time')
  if (exp - now.getTime() > MAX_LIFETIME_MS) throw new Error(`Photo link would live longer than ${PHOTO_LINK_TTL_SECONDS} seconds`)
  // photos/<environment>/<user id>/...: the link must be for the photo of the user it names.
  // faces/<environment>/<user id>/<profile id>/...: and of the profile it names, which a product link never has.
  const [root, , owner, profile] = link.key.split('/')
  const isFace = root === 'faces'
  if ((root !== 'photos' && !isFace) || link.userId === '' || owner !== link.userId) throw new Error('Photo link key does not belong to the user')
  if (isFace ? link.profileId === undefined || link.profileId === '' || profile !== link.profileId : link.profileId !== undefined) {
    throw new Error('Photo link key does not belong to the profile')
  }

  const payload = JSON.stringify({ key: link.key, userId: link.userId, ...(isFace ? { profileId: link.profileId } : {}), exp })
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(payload))
  return toBase64Url(encoder.encode(`${payload}.${toBase64Url(new Uint8Array(signature))}`))
}

/**
 * The key, user and (for a face photo) profile a token was signed for, or null for anything else: malformed, over 2048 characters, signed with another
 * secret, tampered with, expired, or valid for longer than PHOTO_LINK_TTL_SECONDS from `now` (a link can never outlive
 * the TTL, even if it was minted wrong), or a face photo whose token does not name the profile in its key. The reasons are not told apart, so a caller cannot probe them. The signature is checked
 * with crypto.subtle.verify, which compares in constant time, and before the payload is read.
 */
export const verifyPhotoLink = async (token: string, secret: string, now: Date): Promise<PhotoLink | null> => {
  if (secret === '' || token.length > MAX_TOKEN_LENGTH) return null
  try {
    const raw = fromBase64Url(token)
    // atob ignores the unused bits of the last character, so a changed last character can decode to the same bytes and open the same photo: only the one spelling the signer wrote counts.
    if (toBase64Url(raw) !== token) return null
    const text = decoder.decode(raw)
    const dot = text.lastIndexOf('.')
    if (dot < 0) return null
    const payload = text.slice(0, dot)

    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), fromBase64Url(text.slice(dot + 1)), encoder.encode(payload))
    if (!valid) return null

    const claims: unknown = JSON.parse(payload)
    if (typeof claims !== 'object' || claims === null) return null
    const { key, userId, profileId, exp } = claims as Record<string, unknown>
    if (typeof key !== 'string' || typeof userId !== 'string' || typeof exp !== 'number') return null
    if (now.getTime() >= exp || exp - now.getTime() > MAX_LIFETIME_MS) return null
    if (key.startsWith('faces/')) {
      // A face photo belongs to one profile: the token must name the one in the key.
      if (typeof profileId !== 'string' || profileId === '' || key.split('/')[3] !== profileId) return null
      return { key, userId, profileId }
    }
    return { key, userId }
  } catch {
    return null
  }
}
