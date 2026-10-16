import { describe, expect, it } from 'vitest'
import { PHOTO_LINK_TTL_SECONDS, signPhotoLink, verifyPhotoLink } from './photo-link'

// The one clock every test hangs off; fixtures are offsets from it.
const NOW = new Date('2030-01-01T00:00:00Z')
const at = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000)
const MAX_TOKEN_LENGTH = 2048

const SECRET = 'photo-secret-0123456789'
const OTHER_SECRET = 'photo-secret-9876543210'
const KEY = 'photos/test/user-1/scan-1/item-1.jpg'
const USER = 'user-1'
const EXPIRES = at(PHOTO_LINK_TTL_SECONDS)

// Independent codecs, so tampered and forged tokens do not lean on the code under test.
const encoder = new TextEncoder()
const toB64url = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** The token is base64url of "payload.signature"; the payload can itself contain dots, so split at the last one. */
const open = (token: string) => {
  const text = new TextDecoder().decode(fromB64url(token))
  const dot = text.lastIndexOf('.')
  return { payload: text.slice(0, dot), signature: text.slice(dot + 1) }
}
const seal = (payload: string, signature: string) => toB64url(encoder.encode(`${payload}.${signature}`))

const sign = (overrides: Partial<{ key: string; userId: string; expiresAt: Date }> = {}, secret = SECRET) =>
  signPhotoLink({ key: KEY, userId: USER, expiresAt: EXPIRES, ...overrides }, secret)

/** HMAC-SHA-256 under a key HKDF-derived from the secret with the given info (empty salt, 256 bits): a near miss the real key must not match. */
const hmacWithHkdf = async (secret: string, info: string, data: string) => {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) }, material, 256)
  const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)))
}
const hmacWithRawSecret = async (secret: string, data: string) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)))
}

describe('PHOTO_LINK_TTL_SECONDS', () => {
  it('is 5 minutes', () => {
    expect(PHOTO_LINK_TTL_SECONDS).toBe(300)
  })
})

describe('signPhotoLink and verifyPhotoLink', () => {
  it('gives back the key and user a link was signed for, and nothing else', async () => {
    const token = await sign()

    await expect(verifyPhotoLink(token, SECRET, NOW)).resolves.toStrictEqual({ key: KEY, userId: USER })
  })

  it('makes a token of base64url characters only, which does not show the secret', async () => {
    const token = await sign()

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token).not.toContain(SECRET)
    expect(new TextDecoder().decode(fromB64url(token))).not.toContain(SECRET)
  })

  it('carries the key and the user and an end to the signature as "payload.signature"', async () => {
    const { payload, signature } = open(await sign())

    expect(payload).not.toBe('')
    expect(signature).not.toBe('')
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  // Known answer: the signature is HMAC-SHA-256 under HKDF-SHA-256(secret, empty salt, info = 'deepertones/photo-link/v1'),
  // 256 bits. Computed here with WebCrypto, not with the code under test, so a changed info string or parameter fails.
  it('signs with the key HKDF-derived from the secret under the info "deepertones/photo-link/v1"', async () => {
    const { payload, signature } = open(await sign())

    const expected = await hmacWithHkdf(SECRET, 'deepertones/photo-link/v1', payload)

    expect(signature).toBe(toB64url(expected))
  })

  it('does not accept a signature made with the secret as a plain HMAC key, as a JWT would be', async () => {
    const { payload } = open(await sign())
    const forged = await hmacWithRawSecret(SECRET, payload)

    for (const signature of [toB64url(forged), hex(forged)]) {
      await expect(verifyPhotoLink(seal(payload, signature), SECRET, NOW)).resolves.toBeNull()
    }
  })

  it('does not accept a signature made with a key derived under a different info', async () => {
    const { payload } = open(await sign())
    const forged = await hmacWithHkdf(SECRET, 'deepertones/other/v1', payload)

    for (const signature of [toB64url(forged), hex(forged)]) {
      await expect(verifyPhotoLink(seal(payload, signature), SECRET, NOW)).resolves.toBeNull()
    }
  })
})

describe('verifyPhotoLink expiry', () => {
  it('accepts a link up to the last moment before it expires', async () => {
    const token = await sign()

    await expect(verifyPhotoLink(token, SECRET, new Date(EXPIRES.getTime() - 1))).resolves.toStrictEqual({ key: KEY, userId: USER })
  })

  it('refuses a link at the instant it expires', async () => {
    const token = await sign()

    await expect(verifyPhotoLink(token, SECRET, EXPIRES)).resolves.toBeNull()
  })

  it('refuses a link after it expired', async () => {
    const token = await sign()

    await expect(verifyPhotoLink(token, SECRET, new Date(EXPIRES.getTime() + 1))).resolves.toBeNull()
    await expect(verifyPhotoLink(token, SECRET, at(PHOTO_LINK_TTL_SECONDS * 100))).resolves.toBeNull()
  })

  it('refuses a link that was already expired when it was signed', async () => {
    const token = await sign({ expiresAt: at(-60) })

    await expect(verifyPhotoLink(token, SECRET, NOW)).resolves.toBeNull()
  })
})

describe('verifyPhotoLink forgery', () => {
  it('refuses a link signed with a different secret', async () => {
    const token = await sign({}, OTHER_SECRET)

    await expect(verifyPhotoLink(token, SECRET, NOW)).resolves.toBeNull()
  })

  it('refuses a payload edited in place, however small the edit', async () => {
    const { payload, signature } = open(await sign())
    const edited = payload.slice(0, -1) + (payload.endsWith('a') ? 'b' : 'a')

    await expect(verifyPhotoLink(seal(edited, signature), SECRET, NOW)).resolves.toBeNull()
  })

  it('refuses a signature edited in place', async () => {
    const { payload, signature } = open(await sign())
    const edited = (signature.startsWith('A') ? 'B' : 'A') + signature.slice(1)

    await expect(verifyPhotoLink(seal(payload, edited), SECRET, NOW)).resolves.toBeNull()
  })

  it.each([
    ['cut short', (s: string) => s.slice(0, -4)],
    ['empty', () => ''],
    ['longer', (s: string) => `${s}AAAA`],
  ])('refuses a signature that is %s', async (_label, change) => {
    const { payload, signature } = open(await sign())

    await expect(verifyPhotoLink(seal(payload, change(signature)), SECRET, NOW)).resolves.toBeNull()
  })

  // Each field is covered by the signature: another link's payload under this link's signature is refused.
  it.each([
    ['key', { key: 'photos/test/user-1/scan-1/item-9.jpg' }],
    ['user', { userId: 'user-2' }],
    ['expiry', { expiresAt: at(PHOTO_LINK_TTL_SECONDS * 12) }],
  ])('refuses a link whose %s was swapped for another link\'s', async (_field, other) => {
    const original = open(await sign())
    const swapped = open(await sign(other))
    expect(swapped.payload).not.toBe(original.payload)

    await expect(verifyPhotoLink(seal(swapped.payload, original.signature), SECRET, NOW)).resolves.toBeNull()
    // Control: that other link is fine under its own signature.
    await expect(verifyPhotoLink(seal(swapped.payload, swapped.signature), SECRET, NOW)).resolves.not.toBeNull()
  })

  it('refuses a token with any one character changed', async () => {
    const token = await sign()
    const middle = Math.floor(token.length / 2)
    const changed = token.slice(0, middle) + (token[middle] === 'A' ? 'B' : 'A') + token.slice(middle + 1)

    await expect(verifyPhotoLink(changed, SECRET, NOW)).resolves.toBeNull()
  })

  it('refuses a token with characters cut from or added to the end', async () => {
    const token = await sign()

    await expect(verifyPhotoLink(token.slice(0, -2), SECRET, NOW)).resolves.toBeNull()
    await expect(verifyPhotoLink(`${token}AA`, SECRET, NOW)).resolves.toBeNull()
  })
})

describe('verifyPhotoLink malformed input', () => {
  const dot = (text: string) => toB64url(encoder.encode(text))

  it.each([
    ['empty', ''],
    ['a word', 'photo'],
    ['not base64url', '!!!not base64url!!!'],
    ['standard base64 with + / and padding', 'ab+/cd=='],
    ['with spaces', 'abcd efgh'],
    ['a dot-separated JWT shape', 'aaa.bbb.ccc'],
    ['base64url of text with no dot', dot('nodotsatall')],
    ['base64url of only a dot', dot('.')],
    ['base64url of a dot-separated pair of nonsense', dot('payload.signature')],
    ['base64url of two empty halves around a dot', dot('x.')],
    ['base64url of JSON with no signature', dot('{"key":"a","userId":"b","exp":9999999999}')],
    ['base64url of null bytes', toB64url(new Uint8Array(40))],
  ])('returns null for a token that is %s, without throwing', async (_label, token) => {
    await expect(verifyPhotoLink(token, SECRET, NOW)).resolves.toBeNull()
  })

  it('returns null for 2049 characters of base64url', async () => {
    await expect(verifyPhotoLink('A'.repeat(MAX_TOKEN_LENGTH + 1), SECRET, NOW)).resolves.toBeNull()
  })

  it('returns null, not an error, for 100000 characters', async () => {
    await expect(verifyPhotoLink('A'.repeat(100_000), SECRET, NOW)).resolves.toBeNull()
  })
})

describe('verifyPhotoLink token length', () => {
  // A longer user id makes a longer token, so a correctly signed token can be put either side of 2048 characters.
  const tokenFor = (idLength: number) => sign({ userId: 'u'.repeat(idLength) })

  it('accepts the longest signed token that fits in 2048 characters and refuses the next one up', async () => {
    // Token length never shrinks as the id grows, so bisect for the longest id whose token still fits.
    let fits = 1
    let over = MAX_TOKEN_LENGTH + 1
    while (over - fits > 1) {
      const middle = Math.floor((fits + over) / 2)
      if ((await tokenFor(middle)).length <= MAX_TOKEN_LENGTH) fits = middle
      else over = middle
    }
    const longest = await tokenFor(fits)
    const tooLong = await tokenFor(over)

    expect(longest.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH)
    expect(longest.length).toBeGreaterThan(MAX_TOKEN_LENGTH - 8)
    expect(tooLong.length).toBeGreaterThan(MAX_TOKEN_LENGTH)
    await expect(verifyPhotoLink(longest, SECRET, NOW)).resolves.toStrictEqual({ key: KEY, userId: 'u'.repeat(fits) })
    await expect(verifyPhotoLink(tooLong, SECRET, NOW)).resolves.toBeNull()
  })
})
