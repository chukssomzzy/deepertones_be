import { env } from 'cloudflare:workers'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { HTTPException } from 'hono/http-exception'
import { requestId } from 'hono/request-id'
import { describe, expect, it, vi } from 'vitest'
import {
  ConflictError,
  DomainError,
  errorHandler,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  UnavailableError,
  ValidationError,
} from './errors'
import { factory } from './factory'

const PARAM_SECRET = 'ip-hash-param-5c1e'

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
      unavailable: UnavailableError,
      'rate-limited': RateLimitedError,
      bare: DomainError,
    }
    const Kind = kinds[c.req.param('kind') as keyof typeof kinds]
    throw new Kind('SOME_CODE', 'some message', { extra: true })
  })
  .get('/rate-limited/:seconds', (c) => {
    const seconds = c.req.param('seconds')
    throw new RateLimitedError(
      'SLOW_DOWN',
      'slow down',
      seconds === 'none' ? { extra: true } : { retryAfterSeconds: Number(seconds) },
    )
  })
  .get('/http-plain', () => {
    throw new HTTPException(418, { message: 'teapot' })
  })
  .get('/http-prepared', () => {
    throw new HTTPException(401, {
      res: new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }),
    })
  })
  .get('/http-bodyless/:status', (c) => {
    throw new HTTPException(401, { res: new Response(null, { status: Number(c.req.param('status')) }) })
  })
  .get('/http-no-message', () => {
    throw new HTTPException(418)
  })
  .get('/http-prepared-no-message', () => {
    throw new HTTPException(401, { res: new Response('x', { status: 401 }) })
  })
  .get('/http-repeated-headers', () => {
    const headers = new Headers({ 'X-Custom': 'y', 'Content-Length': '1' })
    headers.append('Set-Cookie', 'a=1')
    headers.append('Set-Cookie', 'b=2')
    throw new HTTPException(401, { res: new Response('x', { status: 401, headers }) })
  })
  .get('/boom', () => {
    throw new Error('database password is hunter2')
  })
  .get('/query-failed', () => {
    throw new DrizzleQueryError('insert into scans (ip_hash) values (?)', [PARAM_SECRET], new Error(`constraint failed: ${PARAM_SECRET}`))
  })

app.onError(errorHandler)

describe('errorHandler', () => {
  it.each([
    ['validation', 400],
    ['unauthorized', 401],
    ['forbidden', 403],
    ['not-found', 404],
    ['conflict', 409],
    ['unavailable', 503],
  ])('maps a %s error to %i in the error envelope', async (kind, status) => {
    const res = await app.request(`/throw/${kind}`, {}, env)

    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({
      success: false,
      status,
      message: 'some message',
      error: { code: 'SOME_CODE', details: { extra: true }, requestId: expect.stringMatching(/.+/) },
    })
  })

  it('maps a rate-limited error to 429 in the error envelope', async () => {
    const res = await app.request('/throw/rate-limited', {}, env)

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({
      success: false,
      status: 429,
      message: 'some message',
      error: { code: 'SOME_CODE', details: { extra: true }, requestId: expect.stringMatching(/.+/) },
    })
  })

  it('sets Retry-After from details.retryAfterSeconds on a rate-limited error', async () => {
    const res = await app.request('/rate-limited/45', {}, env)

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('45')
    expect(await res.json()).toEqual({
      success: false,
      status: 429,
      message: 'slow down',
      error: { code: 'SLOW_DOWN', details: { retryAfterSeconds: 45 }, requestId: expect.stringMatching(/.+/) },
    })
  })

  it('sends no Retry-After when a rate-limited error has no retryAfterSeconds', async () => {
    const res = await app.request('/rate-limited/none', {}, env)

    expect(res.status).toBe(429)
    expect(res.headers.has('Retry-After')).toBe(false)
  })

  it('treats an unmapped DomainError as a 500 but keeps its code and message', async () => {
    const res = await app.request('/throw/bare', {}, env)

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({
      success: false,
      status: 500,
      message: 'some message',
      error: { code: 'SOME_CODE' },
    })
  })

  it('hides unexpected errors behind a generic 500 envelope', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request('/boom', {}, env)

    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({
      success: false,
      status: 500,
      message: 'Something went wrong',
      error: { code: 'INTERNAL_ERROR', requestId: expect.stringMatching(/.+/) },
    })
    expect(text).not.toContain('hunter2')
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('logs an unexpected error by name and request id, never its message: a failed query carries its SQL parameters', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request('/query-failed', {}, env)

    expect(res.status).toBe(500)
    const { error } = (await res.json()) as { error: { requestId: string } }
    expect(log).toHaveBeenCalledWith({ requestId: error.requestId, error: 'DrizzleQueryError (cause: Error)' })
    expect(JSON.stringify(log.mock.calls)).not.toContain(PARAM_SECRET)
    log.mockRestore()
  })

  it('renders an HTTPException without a prepared response as an envelope', async () => {
    const res = await app.request('/http-plain', {}, env)

    expect(res.status).toBe(418)
    expect(await res.json()).toMatchObject({
      success: false,
      status: 418,
      message: 'teapot',
      error: { code: 'HTTP_418', requestId: expect.stringMatching(/.+/) },
    })
  })

  it('renders an HTTPException with a prepared response as an envelope, keeping its headers', async () => {
    const res = await app.request('/http-prepared', {}, env)

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(await res.json()).toMatchObject({
      success: false,
      status: 401,
      error: { code: 'HTTP_401', requestId: expect.stringMatching(/.+/) },
    })
  })

  it.each([204, 304])(
    'falls back to the exception status when the prepared response is a bodyless %i',
    async (prepared) => {
      const res = await app.request(`/http-bodyless/${prepared}`, {}, env)

      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ success: false, status: 401, error: { code: 'HTTP_401' } })
    },
  )

  it('falls back to a descriptive message when an HTTPException has none', async () => {
    const plain = await app.request('/http-no-message', {}, env)
    const prepared = await app.request('/http-prepared-no-message', {}, env)

    expect(await plain.json()).toMatchObject({ message: 'Request failed with status 418' })
    expect(await prepared.json()).toMatchObject({ message: 'Request failed with status 401' })
  })

  it('keeps every repeated header of a prepared response, but not its content-length', async () => {
    const res = await app.request('/http-repeated-headers', {}, env)

    expect(res.status).toBe(401)
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    expect(res.headers.get('X-Custom')).toBe('y')
    const text = await res.text()
    const length = res.headers.get('Content-Length')
    if (length !== null) expect(Number(length)).toBe(new TextEncoder().encode(text).length)
    expect(JSON.parse(text)).toMatchObject({ status: 401 })
  })
})
