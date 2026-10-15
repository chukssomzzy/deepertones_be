import { env } from 'cloudflare:workers'
import { requestId } from 'hono/request-id'
import { describe, expect, it } from 'vitest'
import type { Container } from '../container'
import { currentContext } from '../lib/context'
import { factory } from '../lib/factory'
import { TokenService } from '../modules/auth/tokens.service'
import { auth } from './auth'
import { requestContext } from './request-context'

// The one clock every test hangs off; fixtures are offsets from it.
const ISSUED = new Date('2030-01-01T00:00:00Z')
const after = (seconds: number) => new Date(ISSUED.getTime() + seconds * 1000)
const SECRET = 'middleware-test-secret'

/** A small app: services, then auth, then requestContext, then a route that echoes the context. */
const appAt = (now: Date) =>
  factory
    .createApp()
    .use(requestId(), async (c, next) => {
      c.set('services', { tokens: new TokenService({ secret: SECRET, now: () => now }) } as unknown as Container)
      await next()
    })
    .use(auth, requestContext)
    .get('/ctx', (c) => {
      const { actor, tokenProblem } = currentContext()
      return c.json({ actor, tokenProblem: tokenProblem ?? null })
    })

const issue = () => new TokenService({ secret: SECRET, now: () => ISSUED }).issue({ id: 'u_1', status: 'verified', tokenVersion: 1 })

const call = async (authorization?: string, now = after(1)) => {
  const res = await appAt(now).request('/ctx', { headers: authorization ? { Authorization: authorization } : {} }, env)
  return { status: res.status, body: (await res.json()) as { actor: unknown; tokenProblem: string | null } }
}

describe('auth middleware', () => {
  it('runs a request with no Authorization header as public with tokenProblem missing', async () => {
    expect(await call()).toEqual({ status: 200, body: { actor: { kind: 'public' }, tokenProblem: 'missing' } })
  })

  it('turns a valid bearer access token into a user actor', async () => {
    const { accessToken } = await issue()

    const { status, body } = await call(`Bearer ${accessToken}`)

    expect(status).toBe(200)
    expect(body.actor).toEqual({ kind: 'user', userId: 'u_1', status: 'verified' })
    expect(body.tokenProblem).toBeNull()
  })

  it('treats an expired access token as public with tokenProblem expired, and still runs the route', async () => {
    const { accessToken } = await issue()

    expect(await call(`Bearer ${accessToken}`, after(901))).toEqual({
      status: 200,
      body: { actor: { kind: 'public' }, tokenProblem: 'expired' },
    })
  })

  it('treats a token one second before expiry as still valid', async () => {
    const { accessToken } = await issue()

    expect((await call(`Bearer ${accessToken}`, after(899))).body.actor).toMatchObject({ kind: 'user' })
  })

  it('treats a garbage bearer token as public with tokenProblem invalid', async () => {
    expect(await call('Bearer not.a.jwt')).toEqual({ status: 200, body: { actor: { kind: 'public' }, tokenProblem: 'invalid' } })
  })

  it('treats a non-Bearer scheme as invalid, even with a valid token inside', async () => {
    const { accessToken } = await issue()

    expect(await call(`Basic ${accessToken}`)).toEqual({ status: 200, body: { actor: { kind: 'public' }, tokenProblem: 'invalid' } })
  })

  it('matches the Bearer scheme case-insensitively', async () => {
    const { accessToken } = await issue()

    expect((await call(`bearer ${accessToken}`)).body.actor).toEqual({ kind: 'user', userId: 'u_1', status: 'verified' })
  })

  it('treats two spaces after Bearer as invalid', async () => {
    const { accessToken } = await issue()

    expect((await call(`Bearer  ${accessToken}`)).body).toEqual({ actor: { kind: 'public' }, tokenProblem: 'invalid' })
  })

  it('treats a refresh token presented as a bearer as invalid', async () => {
    const { refreshToken } = await issue()

    expect(await call(`Bearer ${refreshToken}`)).toEqual({ status: 200, body: { actor: { kind: 'public' }, tokenProblem: 'invalid' } })
  })
})

describe('requestContext without the auth middleware', () => {
  it('falls back to public with tokenProblem missing', async () => {
    const app = factory
      .createApp()
      .use(requestId(), requestContext)
      .get('/ctx', (c) => c.json({ actor: currentContext().actor, tokenProblem: currentContext().tokenProblem ?? null }))

    const res = await app.request('/ctx', { headers: { Authorization: 'Bearer anything' } }, env)

    expect(await res.json()).toEqual({ actor: { kind: 'public' }, tokenProblem: 'missing' })
  })
})
