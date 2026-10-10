import { exports } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { describe, expect, it } from 'vitest'
import type { AppType } from '../../src/index'

// Integration tests go through the deployed entrypoint (the Worker's default export)
// running in workerd with the bindings from wrangler.jsonc, exactly as a request would in production.
const worker = exports.default
const fetchWorker = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`http://deepertones.test${path}`, init))

// The same typed client the frontend uses, pointed at the real Worker.
const api = hc<AppType>('http://deepertones.test', {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => worker.fetch(new Request(input, init)),
})

describe('GET /health', () => {
  it('reports ok, the environment, and a reachable database', async () => {
    const res = await api.health.$get()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'ok',
      environment: 'development',
      checks: { database: 'ok' },
    })
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })
})

describe('unknown routes', () => {
  it('return the standard 404 error body', async () => {
    const res = await fetchWorker('/nope')

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
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
