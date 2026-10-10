import { env, exports } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { describe, expect, it, vi } from 'vitest'
import app, { type AppType } from '../../src/index'

// Integration tests go through the deployed entrypoint (the Worker's default export)
// running in workerd with the bindings from wrangler.jsonc, exactly as a request would in production.
const worker = exports.default
const fetchWorker = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`http://deepertones.test${path}`, init))

// The same typed client the frontend uses, pointed at the real Worker.
const api = hc<AppType>('http://deepertones.test', {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => worker.fetch(new Request(input, init)),
})

// Compile-time only: the typed client must expose the error envelope, and force a `success` check.
export const neverCalled = async () => {
  const body = await (await api.health.$get()).json()
  // @ts-expect-error data only exists once `success` is narrowed to true
  void body.data
  if (!body.success) {
    const code: string = body.error.code
    const status: number = body.status
    void [code, status]
  }
}

describe('GET /health', () => {
  it('reports ok, the environment, and a reachable database', async () => {
    const res = await api.health.$get()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      success: true,
      status: 200,
      message: 'Health check complete',
      data: { status: 'ok', environment: 'development', checks: { database: 'ok' } },
    })
    if (!body.success) throw new Error('expected success')
    expect(body.data.checks.database).toBe('ok')
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it('answers 503 in the error envelope, with the report as details, when the database is down', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const brokenDb = {
      prepare: () => {
        throw new Error('db down')
      },
    } as unknown as D1Database

    const res = await app.request('/health', {}, { ...env, DB: brokenDb })

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      success: false,
      status: 503,
      message: 'A dependency is down',
      error: {
        code: 'SERVICE_DEGRADED',
        details: { status: 'degraded', environment: 'development', checks: { database: 'down' } },
        requestId: expect.stringMatching(/.+/),
      },
    })
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})

describe('unknown routes', () => {
  it('return the standard 404 error body', async () => {
    const res = await fetchWorker('/nope')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      success: false,
      status: 404,
      message: 'GET /nope not found',
      error: { code: 'NOT_FOUND', requestId: expect.stringMatching(/.+/) },
    })
  })
})

describe('CORS', () => {
  it('allows origins listed in CORS_ORIGINS', async () => {
    const res = await fetchWorker('/health', { headers: { Origin: 'http://localhost:3000' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
  })

  it('ignores origins not in the list', async () => {
    const res = await fetchWorker('/health', { headers: { Origin: 'https://evil.example' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})
