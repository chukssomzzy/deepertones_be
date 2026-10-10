import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import app from '../../src/index'

const fetchWorker = (path: string) => exports.default.fetch(new Request(`http://deepertones.test${path}`))

// The top-level wrangler.jsonc (local development) has DOCS_ENABLED "true", like staging.
describe('API docs, where DOCS_ENABLED is "true"', () => {
  it('serve the spec generated from the routes', async () => {
    const res = await fetchWorker('/openapi.json')

    expect(res.status).toBe(200)
    const spec = await res.json<{ openapi: string; paths: Record<string, unknown> }>()
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.paths).toHaveProperty('/health')
  })

  it('serve Swagger UI pointing at the spec', async () => {
    const res = await fetchWorker('/docs')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('/openapi.json')
  })
})

// Production sets DOCS_ENABLED "false". Same app, with that one var changed.
describe('API docs, where DOCS_ENABLED is not "true"', () => {
  it.each(['/openapi.json', '/docs'])('%s is the standard 404', async (path) => {
    const res = await app.request(path, {}, { ...env, DOCS_ENABLED: 'false' })

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })
})
