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
  signPhotoLink({ key: KEY, userId: USER, expiresAt: EXPIRES, ...overrides }, secret, NOW)

/** A token with a valid signature over any claims, made with WebCrypto here: a link the real signer would refuse to mint. */
const forge = async (claims: Record<string, unknown>, secret = SECRET) => {
  const payload = JSON.stringify(claims)
  return seal(payload, toB64url(await hmacWithHkdf(secret, 'deepertones/photo-link/v1', payload)))
}

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

describe('the link lifetime cap', () => {
  const MS = PHOTO_LINK_TTL_SECONDS * 1000

  it('signs a link that ends exactly one TTL from now, and it verifies right up to its end', async () => {
    const token = await sign({ expiresAt: new Date(NOW.getTime() + MS) })

    await expect(verifyPhotoLink(token, SECRET, NOW)).resolves.toStrictEqual({ key: KEY, userId: USER })
  })

  it.each([
    ['1 millisecond over', MS + 1],
    ['an hour', 3_600_000],
    ['a year', 365 * 24 * 3_600_000],
  ])('refuses to sign a link that ends %s after now', async (_label, ahead) => {
    await expect(sign({ expiresAt: new Date(NOW.getTime() + ahead) })).rejects.toThrow(/longer than 300 seconds/)
  })

  it('refuses to sign an expiry that is not a time', async () => {
    await expect(sign({ expiresAt: new Date(Number.NaN) })).rejects.toThrow(/expiry/i)
  })

  it('measures the cap from the clock it is given, not from the real one', async () => {
    const later = new Date(NOW.getTime() + 10 * MS)

    await expect(signPhotoLink({ key: KEY, userId: USER, expiresAt: new Date(later.getTime() + MS) }, SECRET, later)).resolves.toEqual(expect.any(String))
    await expect(signPhotoLink({ key: KEY, userId: USER, expiresAt: new Date(later.getTime() + MS + 1) }, SECRET, later)).rejects.toThrow()
  })

  it('verifies a forged link that ends exactly one TTL from now', async () => {
    const token = await forge({ key: KEY, userId: USER, exp: NOW.getTime() + MS })

    await expect(verifyPhotoLink(token, SECRET, NOW)).resolves.toStrictEqual({ key: KEY, userId: USER })
  })

  it.each([
    ['1 millisecond over', MS + 1],
    ['an hour', 3_600_000],
    ['a year', 365 * 24 * 3_600_000],
    ['the far future', 8.64e15],
  ])('returns null for a validly signed link that ends %s after now', async (_label, ahead) => {
    const token = await forge({ key: KEY, userId: USER, exp: NOW.getTime() + ahead })

    await expect(verifyPhotoLink(token, SECRET, NOW)).resolves.toBeNull()
  })
})

describe('signPhotoLink user binding', () => {
  it.each([
    ['another user', 'photos/test/user-2/scan-1/item-1.jpg'],
    ['no user segment', 'photos/test'],
    ['an empty user segment', 'photos/test//scan-1/item-1.jpg'],
    ['a key outside photos/', 'catalog/test/user-1/scan-1/item-1.jpg'],
    ['the user id as a prefix of the segment', 'photos/test/user-10/scan-1/item-1.jpg'],
    ['the user id in the wrong segment', 'photos/user-1/test/scan-1/item-1.jpg'],
  ])('refuses to sign a key with %s', async (_label, key) => {
    await expect(sign({ key })).rejects.toThrow(/belong to the user/)
  })

  it('refuses an empty user id', async () => {
    await expect(sign({ userId: '', key: 'photos/test//scan-1/item-1.jpg' })).rejects.toThrow(/belong to the user/)
  })

  it('signs the back photo of the same user', async () => {
    const key = 'photos/test/user-1/scan-1/item-1-back.webp'

    await expect(verifyPhotoLink(await sign({ key }), SECRET, NOW)).resolves.toStrictEqual({ key, userId: USER })
  })
})

describe('the secret', () => {
  it('refuses to sign with an empty secret', async () => {
    await expect(sign({}, '')).rejects.toThrow(/empty secret/)
  })

  it('verifies nothing with an empty secret, not even a link forged under it', async () => {
    const token = await forge({ key: KEY, userId: USER, exp: EXPIRES.getTime() }, '')

    await expect(verifyPhotoLink(token, '', NOW)).resolves.toBeNull()
    await expect(verifyPhotoLink(await sign(), '', NOW)).resolves.toBeNull()
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
    ['user', { userId: 'user-2', key: 'photos/test/user-2/scan-1/item-1.jpg' }],
    ['expiry', { expiresAt: at(PHOTO_LINK_TTL_SECONDS / 2) }],
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
  const tokenFor = (idLength: number) => sign({ userId: 'u'.repeat(idLength), key: `photos/test/${'u'.repeat(idLength)}/scan-1/item-1.jpg` })

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
    await expect(verifyPhotoLink(longest, SECRET, NOW)).resolves.toStrictEqual({ key: `photos/test/${'u'.repeat(fits)}/scan-1/item-1.jpg`, userId: 'u'.repeat(fits) })
    await expect(verifyPhotoLink(tooLong, SECRET, NOW)).resolves.toBeNull()
  })
})

// A face photo link names the PROFILE as well as the user: the account's other profiles must not open it. The key
// (faces/<environment>/<user id>/<profile id>/<scan id>/<name>) carries the profile, and the token carries the profile the link was made for.
// The signer refuses a link whose profile is not the key's, and the verifier gives nothing for a validly signed token whose profile is not
// the key's (made here with `forge`, which the real signer would refuse), so no token opens a photo of a profile it was not made for.
describe('face photo links', () => {
  const FACE_KEY = 'faces/test/user-1/profile-1/scan-1/front.jpg'
  const PROFILE = 'profile-1'
  const signFace = (overrides: Partial<{ key: string; userId: string; profileId: string; expiresAt: Date }> = {}) =>
    signPhotoLink({ key: FACE_KEY, userId: USER, profileId: PROFILE, expiresAt: EXPIRES, ...overrides } as Parameters<typeof signPhotoLink>[0], SECRET, NOW)

  it('gives back the key, the user and the profile a face link was signed for', async () => {
    const token = await signFace()

    await expect(verifyPhotoLink(token, SECRET, NOW)).resolves.toStrictEqual({ key: FACE_KEY, userId: USER, profileId: PROFILE })
  })

  it('carries the profile in the signed payload', async () => {
    const { payload } = open(await signFace())

    expect(JSON.parse(payload)).toMatchObject({ key: FACE_KEY, userId: USER, profileId: PROFILE })
  })

  it('still gives a product link back as the key and the user only', async () => {
    await expect(verifyPhotoLink(await sign(), SECRET, NOW)).resolves.toStrictEqual({ key: KEY, userId: USER })
  })

  it.each([
    ['the key of another profile', { profileId: 'profile-2' }],
    ['the profile id as a prefix of the segment', { profileId: 'profile' }],
    ['an empty profile', { profileId: '' }],
    ['the key of another user', { key: 'faces/test/user-2/profile-1/scan-1/front.jpg' }],
    ['a key with no profile segment', { key: 'faces/test/user-1/scan-1/front.jpg' }],
    ['a product key', { key: KEY }],
  ])('refuses to sign a face link with %s', async (_label, overrides) => {
    await expect(signFace(overrides)).rejects.toThrow()
  })

  it('refuses to sign a face key with no profile at all', async () => {
    await expect(signPhotoLink({ key: FACE_KEY, userId: USER, expiresAt: EXPIRES }, SECRET, NOW)).rejects.toThrow()
  })

  it('refuses to sign a face link that would live longer than the TTL, as a product link is', async () => {
    await expect(signFace({ expiresAt: at(PHOTO_LINK_TTL_SECONDS + 1) })).rejects.toThrow(/longer than/)
  })

  it.each([
    ['another profile than the key\'s', { key: FACE_KEY, userId: USER, profileId: 'profile-2' }],
    ['no profile', { key: FACE_KEY, userId: USER }],
    ['a profile that is not text', { key: FACE_KEY, userId: USER, profileId: 7 }],
    ['an empty profile', { key: FACE_KEY, userId: USER, profileId: '' }],
  ])('returns null for a face key whose validly signed token names %s', async (_label, claims) => {
    const token = await forge({ ...claims, exp: EXPIRES.getTime() })

    await expect(verifyPhotoLink(token, SECRET, NOW)).resolves.toBeNull()
  })

  it('returns the profile for a forged token that is right, so the null above is about the profile and nothing else', async () => {
    const token = await forge({ key: FACE_KEY, userId: USER, profileId: PROFILE, exp: EXPIRES.getTime() })

    await expect(verifyPhotoLink(token, SECRET, NOW)).resolves.toStrictEqual({ key: FACE_KEY, userId: USER, profileId: PROFILE })
  })

  it('returns null at the moment a face link expires and for another secret, as for a product link', async () => {
    const token = await signFace()

    await expect(verifyPhotoLink(token, SECRET, at(PHOTO_LINK_TTL_SECONDS - 1))).resolves.not.toBeNull()
    await expect(verifyPhotoLink(token, SECRET, at(PHOTO_LINK_TTL_SECONDS))).resolves.toBeNull()
    await expect(verifyPhotoLink(token, OTHER_SECRET, NOW)).resolves.toBeNull()
  })
})

// base64 has more bits in its last character than the bytes need when the length is not a multiple of 4: 4 unused bits at length 2 (mod 4) and 2 at
// length 3. Decoders ignore them, so a token with them changed decodes to the same bytes, passes the signature check, and is a second spelling of a
// link that was only ever issued one way. Only the spelling the signer wrote opens a photo.
describe('the one spelling of a link', () => {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const FACE_PROFILE = 'profile-1'

  /** A real signed token whose length leaves the given remainder when divided by 4, found by lengthening the user id. */
  const tokenWithRemainder = async (remainder: 2 | 3, kind: 'product' | 'face') => {
    for (let length = 1; length <= 12; length++) {
      const userId = 'u'.repeat(length)
      const token =
        kind === 'product'
          ? await signPhotoLink({ key: `photos/test/${userId}/scan-1/item-1.jpg`, userId, expiresAt: EXPIRES }, SECRET, NOW)
          : await signPhotoLink({ key: `faces/test/${userId}/${FACE_PROFILE}/scan-1/front.jpg`, userId, profileId: FACE_PROFILE, expiresAt: EXPIRES } as Parameters<typeof signPhotoLink>[0], SECRET, NOW)
      if (token.length % 4 === remainder) return token
    }
    throw new Error(`no token of length ${remainder} mod 4 found`)
  }
  /** The last character with some of its unused low bits (4 of them at remainder 2, 2 at remainder 3) set. */
  const withUnusedBits = (token: string, bits: number) => token.slice(0, -1) + ALPHABET[ALPHABET.indexOf(token.at(-1)!) | bits]

  const cases = [
    ['a product link', 'product', 2, [1, 2, 4, 8, 15]],
    ['a product link', 'product', 3, [1, 2, 3]],
    ['a face link', 'face', 2, [1, 2, 4, 8, 15]],
    ['a face link', 'face', 3, [1, 2, 3]],
  ] as const

  it.each(cases.flatMap(([label, kind, remainder, bits]) => bits.map((b) => [label, kind, remainder, b] as const)))(
    'returns null for %s of length %i mod 4 (kind %s) when the unused bits of the last character are set to %i, though the bytes are the same',
    async (_label, kind, remainder, bits) => {
      const token = await tokenWithRemainder(remainder, kind)
      const respelled = withUnusedBits(token, bits)

      // The respelling really is the same bytes (decoded here with the test's own codec), so only the unused bits differ.
      expect(respelled).not.toBe(token)
      expect(fromB64url(respelled)).toEqual(fromB64url(token))
      await expect(verifyPhotoLink(token, SECRET, NOW)).resolves.not.toBeNull()
      await expect(verifyPhotoLink(respelled, SECRET, NOW)).resolves.toBeNull()
    },
  )

  it.each(['product', 'face'] as const)('still opens a %s link whose length is a multiple of 4, which has no unused bits to change', async (kind) => {
    for (let length = 1; length <= 12; length++) {
      const userId = 'u'.repeat(length)
      const token =
        kind === 'product'
          ? await signPhotoLink({ key: `photos/test/${userId}/scan-1/item-1.jpg`, userId, expiresAt: EXPIRES }, SECRET, NOW)
          : await signPhotoLink({ key: `faces/test/${userId}/${FACE_PROFILE}/scan-1/front.jpg`, userId, profileId: FACE_PROFILE, expiresAt: EXPIRES } as Parameters<typeof signPhotoLink>[0], SECRET, NOW)
      if (token.length % 4 !== 0) continue
      await expect(verifyPhotoLink(token, SECRET, NOW)).resolves.not.toBeNull()
      return
    }
    throw new Error('no token whose length is a multiple of 4 found')
  })
})
