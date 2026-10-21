import { requestId } from 'hono/request-id'
import { describe, expect, it } from 'vitest'
import { errorHandler } from '../lib/errors'
import { factory } from '../lib/factory'
import { adminToken } from './admin-token'

// adminToken() guards /api/v1/admin/*: the request must carry `X-Admin-Token`, equal to the ADMIN_API_TOKEN secret. Nothing a user holds can
// stand in for it, so these tests give the middleware an app where the caller's auth is whatever a test says, then the guard, then a route
// that records it ran. The comparison is constant time (HMAC both sides with a random key, then compare the digests), which a test cannot
// time; what it can pin is that every kind of near miss is refused, and that a secret that is not set refuses everyone.

const SECRET = 'a3f9c2d17b6e40855c1d9e7f2b4a8603'

/** `secret` null leaves the binding out altogether, as a Worker that was never given the secret sees it. */
type Call = { secret?: string | null; headers?: Record<string, string> }

const callWith = async ({ secret = SECRET, headers = {} }: Call = {}) => {
  let reached = false
  const app = factory
    .createApp()
    .onError(errorHandler)
    .use(requestId())
    .use(adminToken())
    .get('/', (c) => {
      reached = true
      return c.json({ success: true })
    })
  const res = await app.request('/', { headers }, secret === null ? {} : { ADMIN_API_TOKEN: secret })
  const body = (await res.json()) as { success: boolean; status?: number; error?: { code: string } }
  return { status: res.status, code: body.error?.code, reached }
}

const refused = { status: 401, code: 'ADMIN_TOKEN_INVALID', reached: false }

describe('adminToken', () => {
  it('lets a request through that carries exactly the secret in X-Admin-Token', async () => {
    expect(await callWith({ headers: { 'X-Admin-Token': SECRET } })).toEqual({ status: 200, code: undefined, reached: true })
  })

  it('reads the header whatever its case, as every HTTP header is', async () => {
    expect(await callWith({ headers: { 'x-admin-token': SECRET } })).toEqual({ status: 200, code: undefined, reached: true })
  })

  it('answers 401 ADMIN_TOKEN_INVALID, and does not reach the route, when the header is missing', async () => {
    expect(await callWith()).toEqual(refused)
  })

  it.each([
    ['one character different (same length)', `${SECRET.slice(0, -1)}4`],
    ['the first character different (same length)', `b${SECRET.slice(1)}`],
    ['only the case different', SECRET.toUpperCase()],
    ['a prefix of the secret', SECRET.slice(0, -1)],
    ['the secret and one more character', `${SECRET}0`],
    // No row for leading or trailing whitespace: the platform trims a header's value before any code sees it, so "the secret and a space" arrives as the secret.
    ['a different token of a different length', 'short'],
    ['an empty value', ''],
  ])('answers 401 ADMIN_TOKEN_INVALID for a token that is %s', async (_, token) => {
    expect(await callWith({ headers: { 'X-Admin-Token': token } })).toEqual(refused)
  })

  it('does not take the secret from an Authorization bearer header: a user token position never passes', async () => {
    expect(await callWith({ headers: { Authorization: `Bearer ${SECRET}` } })).toEqual(refused)
  })

  it('answers 401 for a user access token (a bearer JWT) sent without the admin header', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEiLCJzdGF0dXMiOiJ2ZXJpZmllZCJ9.c2lnbmF0dXJl'

    expect(await callWith({ headers: { Authorization: `Bearer ${jwt}` } })).toEqual(refused)
  })

  it('answers 401 for a user token next to a wrong admin token', async () => {
    expect(await callWith({ headers: { Authorization: 'Bearer anything', 'X-Admin-Token': 'wrong' } })).toEqual(refused)
  })

  // A secret nobody set must lock the door, not leave it open for the caller who also sets nothing.
  it.each([
    ['an empty secret and an empty header', '', { 'X-Admin-Token': '' }],
    ['an empty secret and no header', '', {}],
    ['an empty secret and some token', '', { 'X-Admin-Token': 'anything' }],
    ['no secret at all and an empty header', null, { 'X-Admin-Token': '' }],
    ['no secret at all and no header', null, {}],
    ['no secret at all and some token', null, { 'X-Admin-Token': 'undefined' }],
  ])('refuses everything when the secret is not set: %s', async (_, secret, headers) => {
    expect(await callWith({ secret, headers })).toEqual(refused)
  })
})
