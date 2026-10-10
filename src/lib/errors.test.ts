import { env } from 'cloudflare:workers'
import { requestId } from 'hono/request-id'
import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
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
import { validate } from './validator'

// A throwaway app exercising the shared error + validation plumbing.
const app = factory
  .createApp()
  .use(requestId())
  .post('/echo', validate('json', z.object({ name: z.string().min(1) })), (c) =>
    c.json({ name: c.req.valid('json').name }),
  )
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

const postJson = (body: unknown) =>
  app.request(
    '/echo',
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    env,
  )

describe('validate()', () => {
  it('passes typed data through on valid input', async () => {
    const res = await postJson({ name: 'deepertones' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'deepertones' })
  })

  it('rejects invalid input with VALIDATION_FAILED and per-field details', async () => {
    const res = await postJson({ name: '' })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: [{ path: 'name' }] },
    })
  })
})

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
