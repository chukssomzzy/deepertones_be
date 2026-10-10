import { env } from 'cloudflare:workers'
import { requestId } from 'hono/request-id'
import { describe, expect, it } from 'vitest'
import { requestContext } from '../middleware/request-context'
import { currentActor, currentContext, requireUser, runAs } from './context'
import { errorHandler } from './errors'
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

app.onError(errorHandler)

describe('requestContext middleware', () => {
  it('makes the actor and requestId readable across awaits', async () => {
    const res = await app.request('/whoami', { headers: { 'X-Request-Id': 'req-123' } }, env)

    expect(await res.json()).toEqual({ actor: { kind: 'anonymous' }, requestId: 'req-123' })
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

describe('requireUser', () => {
  it('rejects an anonymous request with 401 AUTH_REQUIRED', async () => {
    const res = await app.request('/needs-user', {}, env)

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } })
  })

  it('returns the user when one is acting', () => {
    const user = runAs({ kind: 'user', userId: 'u_1' }, requireUser)
    expect(user).toEqual({ kind: 'user', userId: 'u_1' })
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
