import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { app } from '../../src/index'

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

  it('keep the never-list on the face scan result, and make only the result field nullable', async () => {
    const res = await fetchWorker('/openapi.json')
    const spec = await res.json<{ components: { schemas: Record<string, { type?: unknown; description?: string; properties?: Record<string, unknown> }> } }>()
    const { FaceScanResult, FaceScanResponse } = spec.components.schemas

    expect(FaceScanResult?.type).toBe('object')
    expect(FaceScanResult?.description).toMatch(/never holds a score or any number but the skin age in years/)
    expect(FaceScanResult?.description).toMatch(/never a condition name/)
    expect(FaceScanResult?.description).toMatch(/never a Perfect Corp name/)
    expect(FaceScanResult?.description).toMatch(/never a Fitzpatrick type/)
    expect(FaceScanResult?.description).toMatch(/never a word about lightness/)

    const result = JSON.stringify(FaceScanResponse?.properties?.result)
    expect(result).toContain('#/components/schemas/FaceScanResult')
    expect(result).toContain('"null"')
    expect(result).toContain('filled when `state` is `ready`, null otherwise')
  })

  it('describe the shelf verdict as a union of pending, the guest\'s locked preview (counts only, no products) and the full verdict marked locked false', async () => {
    const res = await fetchWorker('/openapi.json')
    type Schema = { oneOf?: Schema[]; anyOf?: Schema[]; properties?: Record<string, Schema & { enum?: unknown[]; const?: unknown }>; required?: string[] }
    const spec = await res.json<{ components: { schemas: Record<string, Schema> } }>()
    // However the union is nested, its leaves are the shapes a client can read.
    const leavesOf = (schema: Schema): Schema[] => {
      const inner = schema.oneOf ?? schema.anyOf
      return inner ? inner.flatMap(leavesOf) : [schema]
    }
    const variants = leavesOf(spec.components.schemas.ShelfVerdict!)
    const lockedOf = (variant: Schema) => variant.properties?.locked?.enum ?? (variant.properties?.locked && 'const' in variant.properties.locked ? [variant.properties.locked.const] : undefined)

    expect(variants).toHaveLength(3)
    const [pending] = variants.filter((variant) => variant.properties?.locked === undefined)
    expect(Object.keys(pending!.properties!)).toEqual(['status'])

    const preview = variants.find((variant) => JSON.stringify(lockedOf(variant)) === '[true]')!
    expect(Object.keys(preview.properties!).sort()).toEqual(['counts', 'escalates', 'fit', 'groups', 'locked', 'status', 'total'])
    expect([...preview.required!].sort()).toEqual(['counts', 'escalates', 'fit', 'groups', 'locked', 'status', 'total'])
    const groups = ['blocking', 'cant-tell', 'conflicting', 'helping', 'likely-the-problem', 'prescribed', 'redundant', 'undecided']
    expect(Object.keys(preview.properties!.counts!.properties!).sort()).toEqual(groups)
    expect([...preview.properties!.counts!.required!].sort()).toEqual(groups)
    for (const never of ['products', 'tapers']) expect(preview.properties).not.toHaveProperty(never)

    const full = variants.find((variant) => JSON.stringify(lockedOf(variant)) === '[false]')!
    expect(Object.keys(full.properties!).sort()).toEqual(['fit', 'groups', 'locked', 'products', 'status', 'tapers'])
    expect([...full.required!].sort()).toEqual(['fit', 'groups', 'locked', 'products', 'status', 'tapers'])
  })

  it('list the origin they are served from first, so "Try it out" never targets production by accident', async () => {
    const serversAt = async (origin: string) => {
      const res = await exports.default.fetch(new Request(`${origin}/openapi.json`))
      const spec = await res.json<{ servers: { url: string; description: string }[] }>()
      return spec.servers
    }

    expect(await serversAt('https://api.staging.deepertones.com')).toEqual([
      { url: 'https://api.staging.deepertones.com', description: 'Staging' },
      { url: 'https://api.deepertones.com', description: 'Production' },
    ])
    expect((await serversAt('http://localhost:8787')).map((server) => server.url)).toEqual([
      'http://localhost:8787',
      'https://api.deepertones.com',
      'https://api.staging.deepertones.com',
    ])
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
    expect(await res.json()).toMatchObject({ success: false, status: 404, error: { code: 'NOT_FOUND' } })
  })
})
