import { env } from 'cloudflare:workers'
import { requestId } from 'hono/request-id'
import { describe, expect, it, vi } from 'vitest'
import {
  ConflictError,
  DomainError,
  errorHandler,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from './errors'
import { factory } from './factory'

// A throwaway app exercising the shared error plumbing.
const app = factory
  .createApp()
  .use(requestId())
  .get('/throw/:kind', (c) => {
    const kinds = {
      validation: ValidationError,
      unauthorized: UnauthorizedError,
      forbidden: ForbiddenError,
      'not-found': NotFoundError,
      conflict: ConflictError,
      bare: DomainError,
    }
    const Kind = kinds[c.req.param('kind') as keyof typeof kinds]
    throw new Kind('SOME_CODE', 'some message', { extra: true })
  })
  .get('/boom', () => {
    throw new Error('database password is hunter2')
  })

app.onError(errorHandler)

describe('errorHandler', () => {
  it.each([
    ['validation', 400],
    ['unauthorized', 401],
    ['forbidden', 403],
    ['not-found', 404],
    ['conflict', 409],
  ])('maps a %s error to %i with its code, message and details', async (kind, status) => {
    const res = await app.request(`/throw/${kind}`, {}, env)

    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({
      error: { code: 'SOME_CODE', message: 'some message', details: { extra: true } },
    })
  })

  it('treats an unmapped DomainError as a 500 but keeps its code', async () => {
    const res = await app.request('/throw/bare', {}, env)

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: { code: 'SOME_CODE' } })
  })

  it('hides unexpected errors behind a generic 500', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request('/boom', {}, env)

    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toContain('INTERNAL_ERROR')
    expect(text).not.toContain('hunter2')
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})
