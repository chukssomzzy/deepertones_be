import { requestId } from 'hono/request-id'
import { describe, expect, it } from 'vitest'
import { errorHandler } from '../lib/errors'
import { type AppEnv, factory } from '../lib/factory'
import { signedIn } from './signed-in'

/** An app where `auth` is whatever the test says, then signedIn, then a route that records it ran. */
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
    .use(signedIn())
    .post('/', (c) => {
      reached = true
      return c.json({})
    })
  const res = await app.request('/', { method: 'POST' })
  const body = (await res.json()) as { error?: { code: string } }
  return { status: res.status, code: body.error?.code, reached }
}

describe('signedIn', () => {
  it.each([
    ['a guest', { kind: 'user', userId: 'u_1', status: 'anonymous' } as const],
    ['a verified user', { kind: 'user', userId: 'u_1', status: 'verified' } as const],
  ])('lets %s through', async (_label, actor) => {
    expect(await callWith({ actor })).toEqual({ status: 200, code: undefined, reached: true })
  })

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
