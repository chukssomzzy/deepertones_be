import { describe, expect, it } from 'vitest'
import { keyId, signJwt, verifyJwt } from './jwt'

// The one clock every test hangs off; fixtures are offsets from it.
const NOW = new Date('2030-01-01T00:00:00Z')
const at = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000)
const TTL = 900

// Independent encoders so crafted tokens do not depend on the code under test.
const enc = new TextEncoder()
const b64url = (bytes: Uint8Array) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64url = (s: string) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')))
const json = (v: unknown) => b64url(enc.encode(JSON.stringify(v)))
const hmac = async (secret: string, data: string) => {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))))
}
/** A correctly signed token with an arbitrary header and claims. */
const craft = async (secret: string, header: Record<string, unknown>, claims: Record<string, unknown>) => {
  const signing = `${json(header)}.${json(claims)}`
  return `${signing}.${await hmac(secret, signing)}`
}

const A = 'secret-a-0123456789'
const B = 'secret-b-0123456789'

describe('keyId', () => {
  it('is the first 16 hex characters of SHA-256 of the secret', async () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(await keyId('abc')).toBe('ba7816bf8f01cfea')
  })

  it('differs per secret and never contains the secret', async () => {
    expect(await keyId(A)).not.toBe(await keyId(B))
    expect(await keyId(A)).not.toContain(A)
  })
})

describe('signJwt', () => {
  it('produces a compact HS256 JWS whose header carries the key id', async () => {
    const token = await signJwt({ sub: 'u_1' }, { secret: A, expiresInSeconds: TTL, now: NOW })

    const parts = token.split('.')
    expect(parts).toHaveLength(3)
    expect(fromB64url(parts[0]!)).toEqual({ alg: 'HS256', typ: 'JWT', kid: await keyId(A) })
  })

  it('adds iat and exp in seconds to the claims', async () => {
    const token = await signJwt({ sub: 'u_1' }, { secret: A, expiresInSeconds: TTL, now: NOW })

    const iat = NOW.getTime() / 1000
    expect(fromB64url(token.split('.')[1]!)).toEqual({ sub: 'u_1', iat, exp: iat + TTL })
  })

  it('signs with HMAC-SHA256 over header.payload', async () => {
    const token = await signJwt({ sub: 'u_1' }, { secret: A, expiresInSeconds: TTL, now: NOW })
    const [h, p, s] = token.split('.')

    expect(s).toBe(await hmac(A, `${h}.${p}`))
  })
})

describe('verifyJwt', () => {
  const sign = (claims: Record<string, unknown> = { sub: 'u_1' }, secret = A) =>
    signJwt(claims, { secret, expiresInSeconds: TTL, now: NOW })

  it('returns the claims of a valid token', async () => {
    const result = await verifyJwt(await sign({ sub: 'u_1', st: 'anonymous' }), { secrets: [A], now: at(1) })

    expect(result).toEqual({
      ok: true,
      claims: { sub: 'u_1', st: 'anonymous', iat: NOW.getTime() / 1000, exp: NOW.getTime() / 1000 + TTL },
    })
  })

  it('accepts a token one second before exp and calls it expired at exactly exp', async () => {
    const token = await sign()

    expect(await verifyJwt(token, { secrets: [A], now: at(TTL - 1) })).toMatchObject({ ok: true })
    expect(await verifyJwt(token, { secrets: [A], now: at(TTL) })).toEqual({ ok: false, reason: 'expired' })
    expect(await verifyJwt(token, { secrets: [A], now: at(TTL + 1) })).toEqual({ ok: false, reason: 'expired' })
  })

  it('verifies a token signed with an older secret while that secret is still listed (rotation)', async () => {
    const token = await sign({ sub: 'u_1' }, A)

    expect(await verifyJwt(token, { secrets: [B, A], now: at(1) })).toMatchObject({ ok: true })
  })

  it('rejects a token whose key id matches none of the secrets', async () => {
    const token = await sign({ sub: 'u_1' }, A)

    expect(await verifyJwt(token, { secrets: [B], now: at(1) })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a tampered payload', async () => {
    const [h, , s] = (await sign({ sub: 'u_1' })).split('.')
    const forged = `${h}.${json({ sub: 'u_admin', iat: 0, exp: NOW.getTime() / 1000 + TTL })}.${s}`

    expect(await verifyJwt(forged, { secrets: [A], now: at(1) })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a bad signature even when the token is also expired (forged expired is invalid, not expired)', async () => {
    const kid = await keyId(A)
    const claims = { sub: 'u_1', iat: 0, exp: NOW.getTime() / 1000 - 10 }
    const forged = await craft(B, { alg: 'HS256', typ: 'JWT', kid }, claims)

    expect(await verifyJwt(forged, { secrets: [A], now: NOW })).toEqual({ ok: false, reason: 'invalid' })
  })

  it.each(['none', 'HS512', 'RS256'])('rejects alg %s', async (alg) => {
    const kid = await keyId(A)
    const claims = { sub: 'u_1', exp: NOW.getTime() / 1000 + TTL }
    const token = alg === 'none' ? `${json({ alg, typ: 'JWT', kid })}.${json(claims)}.` : await craft(A, { alg, typ: 'JWT', kid }, claims)

    expect(await verifyJwt(token, { secrets: [A], now: at(1) })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a correctly signed token that has no exp', async () => {
    const token = await craft(A, { alg: 'HS256', typ: 'JWT', kid: await keyId(A) }, { sub: 'u_1' })

    expect(await verifyJwt(token, { secrets: [A], now: NOW })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a correctly signed token whose exp is a string', async () => {
    const token = await craft(A, { alg: 'HS256', typ: 'JWT', kid: await keyId(A) }, { sub: 'u_1', exp: String(NOW.getTime() / 1000 + TTL) })

    expect(await verifyJwt(token, { secrets: [A], now: NOW })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects base64url with padding, even though the bytes decode to the same signature', async () => {
    const token = await sign()

    expect(await verifyJwt(`${token}=`, { secrets: [A], now: at(1) })).toEqual({ ok: false, reason: 'invalid' })
  })

  it.each([
    ['empty string', ''],
    ['one part', 'abc'],
    ['two parts', 'abc.def'],
    ['four parts', 'a.b.c.d'],
    ['non-base64url header', '!!!.e30.sig'],
    ['non-JSON header', `${b64url(enc.encode('not json'))}.e30.sig`],
  ])('rejects a malformed token: %s', async (_name, token) => {
    expect(await verifyJwt(token, { secrets: [A], now: NOW })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a signed token whose payload is not JSON', async () => {
    const signing = `${json({ alg: 'HS256', typ: 'JWT', kid: await keyId(A) })}.${b64url(enc.encode('nope'))}`
    const token = `${signing}.${await hmac(A, signing)}`

    expect(await verifyJwt(token, { secrets: [A], now: NOW })).toEqual({ ok: false, reason: 'invalid' })
  })
})
