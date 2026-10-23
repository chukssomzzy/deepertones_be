import { requestId } from 'hono/request-id'
import { describe, expect, it } from 'vitest'
import { errorHandler } from '../lib/errors'
import { type AppEnv, factory } from '../lib/factory'
import { verifiedUser } from './verified-user'

/** An app where `auth` is whatever the test says, then verifiedUser, then a route that records it ran. */
const callWith = async (auth: AppEnv['Variables']['auth']) => {
  let reached = false
  const app = factory
    .createApp()
    .onError(errorHandler)
    .use(requestId())
    .use(async (c, next) => {
      if (auth) c.set('auth', auth)
      await next()
    })
    .use(verifiedUser())
    .post('/', (c) => {
      reached = true
      return c.json({})
    })
  const res = await app.request('/', { method: 'POST' })
  const body = (await res.json()) as { error?: { code: string } }
  return { status: res.status, code: body.error?.code, reached }
}

describe('verifiedUser', () => {
  it('lets a verified user through', async () => {
    const actor = { kind: 'user', userId: 'u_1', status: 'verified', profileId: 'p_1' } as const

    expect(await callWith({ actor })).toEqual({ status: 200, code: undefined, reached: true })
  })

  it('answers 403 VERIFICATION_REQUIRED to a guest and does not reach the route', async () => {
    const actor = { kind: 'user', userId: 'u_1', status: 'anonymous', profileId: 'p_1' } as const

    expect(await callWith({ actor })).toEqual({ status: 403, code: 'VERIFICATION_REQUIRED', reached: false })
  })

  // Not signed in is the same 401, with the same codes, as signedIn: only a signed-in guest is a 403.
  it.each([
    ['no token', { actor: { kind: 'public' }, tokenProblem: 'missing' } as const, 'AUTH_REQUIRED'],
    ['an expired token', { actor: { kind: 'public' }, tokenProblem: 'expired' } as const, 'TOKEN_EXPIRED'],
    ['an unusable token', { actor: { kind: 'public' }, tokenProblem: 'invalid' } as const, 'TOKEN_INVALID'],
    ['a public caller with no recorded problem', { actor: { kind: 'public' } } as const, 'AUTH_REQUIRED'],
    ['a system actor', { actor: { kind: 'system', job: 'x' } } as const, 'AUTH_REQUIRED'],
    ['no auth at all (the auth middleware did not run)', undefined, 'AUTH_REQUIRED'],
  ])('answers 401 %s and does not reach the route', async (_label, auth, code) => {
    expect(await callWith(auth)).toEqual({ status: 401, code, reached: false })
  })
})
