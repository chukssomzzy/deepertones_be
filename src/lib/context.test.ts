import { env } from 'cloudflare:workers'
import { requestId } from 'hono/request-id'
import { describe, expect, it } from 'vitest'
import { requestContext } from '../middleware/request-context'
import { type Actor, currentActor, currentContext, requireUser, requireVerified, runAs, runWithContext } from './context'
import { ForbiddenError, UnauthorizedError, errorHandler } from './errors'
import { factory } from './factory'

// Stands in for a service: reads the context after an await, the way real code does.
const whoAmI = async () => {
  await Promise.resolve()
  return { actor: currentActor(), requestId: currentContext().requestId }
}

const app = factory
  .createApp()
  .use(requestId(), requestContext)
  .get('/whoami', async (c) => c.json(await whoAmI()))
  .get('/needs-user', (c) => c.json(requireUser()))
  .get('/token-problem', (c) => c.json({ problem: currentContext().tokenProblem ?? null }))

app.onError(errorHandler)

describe('requestContext middleware', () => {
  it('makes the actor and requestId readable across awaits', async () => {
    const res = await app.request('/whoami', { headers: { 'X-Request-Id': 'req-123' } }, env)

    expect(await res.json()).toEqual({ actor: { kind: 'public' }, requestId: 'req-123' })
  })

  it('keeps concurrent requests apart', async () => {
    const ids = ['a', 'b', 'c', 'd']
    const bodies = await Promise.all(
      ids.map(async (id) => {
        const res = await app.request('/whoami', { headers: { 'X-Request-Id': id } }, env)
        return (await res.json()) as { requestId: string }
      }),
    )

    expect(bodies.map((b) => b.requestId)).toEqual(ids)
  })
})

const PUBLIC: Actor = { kind: 'public' }
const GUEST: Actor = { kind: 'user', userId: 'u_1', status: 'anonymous', profileId: 'p_1' }
const VERIFIED: Actor = { kind: 'user', userId: 'u_2', status: 'verified', profileId: 'p_2' }
const SYSTEM: Actor = { kind: 'system', job: 'nightly' }

const withProblem = <T>(actor: Actor, tokenProblem: 'missing' | 'expired' | 'invalid' | undefined, fn: () => T) =>
  runWithContext({ actor, requestId: 'r', tokenProblem }, fn)

describe('requestContext middleware identity', () => {
  it('runs every request as the public actor with tokenProblem missing', async () => {
    const res = await app.request('/token-problem', {}, env)

    expect(await res.json()).toEqual({ problem: 'missing' })
  })
})

describe('requireUser', () => {
  it('rejects a public request with 401 AUTH_REQUIRED', async () => {
    const res = await app.request('/needs-user', {}, env)

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } })
  })

  it.each([
    ['expired', 'TOKEN_EXPIRED'],
    ['invalid', 'TOKEN_INVALID'],
    ['missing', 'AUTH_REQUIRED'],
    [undefined, 'AUTH_REQUIRED'],
  ] as const)('rejects a public actor with tokenProblem %s as %s', (problem, code) => {
    expect.assertions(2)
    try {
      withProblem(PUBLIC, problem, requireUser)
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedError)
      expect((error as UnauthorizedError).code).toBe(code)
    }
  })

  it('rejects a system actor with AUTH_REQUIRED', () => {
    expect(() => runAs(SYSTEM, requireUser)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
  })

  it('returns a guest user', () => {
    expect(runAs(GUEST, requireUser)).toEqual(GUEST)
  })

  it('returns a verified user', () => {
    expect(runAs(VERIFIED, requireUser)).toEqual(VERIFIED)
  })
})

describe('requireVerified', () => {
  it('returns a verified user', () => {
    expect(runAs(VERIFIED, requireVerified)).toEqual(VERIFIED)
  })

  it('rejects a guest with 403-class VERIFICATION_REQUIRED', () => {
    expect.assertions(2)
    try {
      runAs(GUEST, requireVerified)
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError)
      expect((error as ForbiddenError).code).toBe('VERIFICATION_REQUIRED')
    }
  })

  it.each([
    ['expired', 'TOKEN_EXPIRED'],
    ['invalid', 'TOKEN_INVALID'],
    ['missing', 'AUTH_REQUIRED'],
  ] as const)('rejects a public actor with tokenProblem %s as %s', (problem, code) => {
    expect.assertions(2)
    try {
      withProblem(PUBLIC, problem, requireVerified)
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedError)
      expect((error as UnauthorizedError).code).toBe(code)
    }
  })

  it('rejects a system actor with AUTH_REQUIRED', () => {
    expect(() => runAs(SYSTEM, requireVerified)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
  })
})

describe('outside any context', () => {
  it('currentActor throws instead of guessing', () => {
    expect(() => currentActor()).toThrow(/No request context/)
  })

  it('runAs provides one for queue/cron work', async () => {
    const actor = await runAs({ kind: 'system', job: 'nightly' }, async () => {
      await Promise.resolve()
      return currentActor()
    })
    expect(actor).toEqual({ kind: 'system', job: 'nightly' })
  })
})
