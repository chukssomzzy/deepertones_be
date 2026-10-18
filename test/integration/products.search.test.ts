import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'
import { inOneRateWindow, RATE_TEST_TIMEOUT_MS, SEARCH_BURST_NEEDS_MS } from './rate-window'
import type { ProductForm } from '../../src/providers/product-research/product-researcher.provider'
import { FakeOpsAlertsRepository } from '../../src/modules/ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'

/** An alerting service that goes nowhere: these tests are not about ops alerts. */
const quietOpsAlerts = () =>
  new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: new MemoryJobQueue(), email: new MemoryEmailSender(), recipient: '', environment: 'test' })

// GET /api/v1/products/search through the Worker's real entrypoint, with the frontend's typed client and real local D1. Products are put
// into the catalog the way a scan puts them there (the catalog service over the real repository), so what search finds is what the product made.

const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, env, createExecutionContext())
const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })
// One place that reaches into the products routes: until they are mounted in AppType this is the one line that fails to compile.
const productsApi = api.api.v1.products

afterEach(() => vi.unstubAllGlobals())

// The database is shared by the whole file (and by an earlier run), so every product gets a name no other test has.
// The "z" ends each word, so one word is never inside another.
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
const next = () => counter++
const word = () => `Srch${runSalt}n${next()}z`
// A new IP per caller keeps the per-address rate limit from coupling tests to each other.
const freshIp = () => {
  const n = next()
  return `10.${(Number(runSalt) + 3) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}

type Envelope<T> = { success: true; status: number; message: string; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number; headers: Headers }
type Hit = { id: string; brand: string; name: string; variant: string | null; form: string | null; category: string; imageUrl: string | null }

const read = async <T>(res: Reply) => (await res.json()) as Envelope<T>
const errorCodeOf = async (res: Reply) => {
  const body = await read<unknown>(res)
  if (body.success) throw new Error(`expected an error, got ${res.status}`)
  return body.error.code
}
const hitsOf = async (res: Reply): Promise<Hit[]> => {
  const body = await read<{ products: Hit[] }>(res)
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data.products
}
const retryAfterOf = (res: Reply) => Number(res.headers.get('Retry-After'))

/** A guest signed in from its own address. */
const newGuest = async () => {
  const ip = freshIp()
  const res = await api.api.v1.auth.anonymous.$post({ json: { deviceId: `device-search-${runSalt}-${next()}`, platform: 'ios' } }, { headers: { 'cf-connecting-ip': ip } })
  const body = await read<{ tokens: { accessToken: string }; user: { id: string } }>(res)
  if (!body.success) throw new Error(`could not sign in: ${res.status}`)
  const token = body.data.tokens.accessToken
  return { token, ip, headers: (from: string = ip): Record<string, string> => ({ 'cf-connecting-ip': from, Authorization: `Bearer ${token}` }) }
}
type Guest = Awaited<ReturnType<typeof newGuest>>

const search = (guest: Guest, q: string, from?: string) => productsApi.search.$get({ query: { q } }, { headers: guest.headers(from) })

// --- products, made the way a scan makes them ---

const analyst = new MemoryProductAnalyst()
const catalog = new ProductCatalogService({
  repository: new D1CatalogRepository(createDb(env.DB)),
  researcher: new MemoryProductResearcher(),
  analyst,
  images: new MemoryCatalogImageStore(),
  imageKeyPrefix: 'catalog/test',
  opsAlerts: quietOpsAlerts(),
})
const resolved = async (brand: string, name: string, over: { variant?: string; form?: ProductForm; category?: 'skin' | 'hair' | 'body' | 'makeup' | 'other' } = {}) =>
  (await catalog.resolve({ brand, name, category: over.category ?? 'skin', ...(over.variant ? { variant: over.variant } : {}), ...(over.form ? { form: over.form } : {}) })).productId

describe('GET /api/v1/products/search', () => {
  it('finds products by a fragment of their brand, name and variant, as { id, brand, name, variant, form, category, imageUrl }, in a list under `products`', async () => {
    const guest = await newGuest()
    const brand = word()
    const id = await resolved(brand, 'Hydrating Cleanser', { variant: 'Night', category: 'body' })

    const res = await search(guest, `${brand} hydrating`)

    expect(res.status).toBe(200)
    expect(await read<unknown>(res)).toMatchObject({ success: true, status: 200 })
    expect(await hitsOf(await search(guest, `${brand} hydrating`))).toEqual([{ id, brand, name: 'Hydrating Cleanser', variant: 'Night', form: null, category: 'body', imageUrl: null }])
  })

  it('shows each product\'s form, so two products that differ only by form are both listed and told apart', async () => {
    const guest = await newGuest()
    const brand = word()
    const spray = await resolved(brand, 'Dry Impact', { category: 'body', form: 'spray' })
    const rollOn = await resolved(brand, 'Dry Impact', { category: 'body', form: 'roll-on' })
    const plain = await resolved(brand, 'Dry Impact', { category: 'body' })

    const hits = await hitsOf(await search(guest, `${brand} dry impact`))

    expect(new Set([spray, rollOn, plain]).size).toBe(3)
    expect(hits).toHaveLength(3)
    expect(Object.fromEntries(hits.map((h) => [h.id, h.form]))).toEqual({ [spray]: 'spray', [rollOn]: 'roll-on', [plain]: null })
  })

  it('normalises the query like the search text: case, accents, punctuation and surrounding spaces do not matter', async () => {
    const guest = await newGuest()
    const brand = word()
    const id = await resolved(`${brand} Crème`, "L'Oréal Revitalift")

    for (const q of [`${brand.toUpperCase()} CREME loreal`, `  ${brand} crème   l'oréal!  `]) {
      expect((await hitsOf(await search(guest, q))).map((h) => h.id), q).toEqual([id])
    }
  })

  it('answers 200 with an empty list for text no product contains', async () => {
    const guest = await newGuest()

    const res = await search(guest, `${word()} nothing`)

    expect(res.status).toBe(200)
    expect(await hitsOf(res)).toEqual([])
  })

  it('answers 200 with an empty list for a query that is under 2 characters once normalised, though it is 2 characters long', async () => {
    const guest = await newGuest()
    await resolved(word(), 'Hydrating Cleanser')

    const res = await search(guest, 'a!')

    expect(res.status).toBe(200)
    expect(await hitsOf(res)).toEqual([])
  })

  it('answers 200 with an empty list, not every product, for a query that is only punctuation', async () => {
    const guest = await newGuest()
    await resolved(word(), 'Hydrating Cleanser')

    const res = await search(guest, '!!')

    expect(res.status).toBe(200)
    expect(await hitsOf(res)).toEqual([])
  })

  it('puts a product whose name starts with the query before one that only contains it, then by name', async () => {
    const guest = await newGuest()
    const w = word().toLowerCase()
    const contains = await resolved('Acme', `Glow ${w} Wash`)
    const prefixB = await resolved(w, 'Body Butter')
    const prefixA = await resolved(w, 'Aloe Gel')

    expect((await hitsOf(await search(guest, w))).map((h) => h.id)).toEqual([prefixA, prefixB, contains])
  })

  it('returns at most 10 products', async () => {
    const guest = await newGuest()
    const w = word()
    for (const letter of 'ABCDEFGHIJK') await resolved(w, `Glow Serum ${letter}`)

    const hits = await hitsOf(await search(guest, w))

    expect(hits).toHaveLength(10)
    expect(hits.map((h) => h.name)).toEqual('ABCDEFGHIJ'.split('').map((letter) => `Glow Serum ${letter}`))
  })

  it('never returns an unnamed product, though its identity key holds the words of its list', async () => {
    const guest = await newGuest()
    const w = word()
    await catalog.fromLabel({ ingredients: ['Aqua', 'Glycerin', w] })

    expect(await hitsOf(await search(guest, w))).toEqual([])
  })

  it('finds a product through an alias it was given, once', async () => {
    const guest = await newGuest()
    const brand = word()
    const id = await resolved(brand, 'Hydrating Facial Cleanser')
    // A spelling the model confirms as the same product is remembered as an alias.
    analyst.sameProductWith(() => true)
    expect(await resolved(brand, 'Hydrating Cleanser')).toBe(id)
    analyst.sameProductWith(() => false)

    expect((await hitsOf(await search(guest, 'hydrating cleanser'))).filter((h) => h.id === id)).toHaveLength(1)
    expect((await hitsOf(await search(guest, brand))).map((h) => h.id)).toEqual([id])
  })

  it('costs no model call: nothing leaves the Worker', async () => {
    const guest = await newGuest()
    await resolved(word(), 'Hydrating Cleanser')
    const outbound = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', outbound)

    const res = await search(guest, 'hydrating')

    expect(res.status).toBe(200)
    expect(outbound).not.toHaveBeenCalled()
  })

  it('works for a guest: no verified account is needed', async () => {
    const guest = await newGuest()

    expect((await search(guest, 'serum')).status).toBe(200)
  })

  describe('the query', () => {
    // 2 to 80 characters once trimmed; the bounds are the ones a user types around.
    it.each([
      ['2 characters', 'ab'],
      ['2 characters between spaces', '   ab   '],
      ['80 characters', 'a'.repeat(80)],
      ['80 characters between spaces', `  ${'a'.repeat(80)}  `],
    ])('accepts %s', async (_label, q) => {
      const res = await search(await newGuest(), q)

      expect(res.status).toBe(200)
    })

    it.each([
      ['1 character', 'a'],
      ['1 character between spaces', '   a   '],
      ['nothing', ''],
      ['only spaces', '      '],
      ['81 characters', 'a'.repeat(81)],
      ['81 characters between spaces', `  ${'a'.repeat(81)}  `],
    ])('refuses %s with 400 VALIDATION_FAILED', async (_label, q) => {
      const res = await search(await newGuest(), q)

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    })

    it('refuses a request with no query with 400 VALIDATION_FAILED', async () => {
      const guest = await newGuest()

      const res = await fetchWorker('http://deepertones.test/api/v1/products/search', { headers: guest.headers() })

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    })
  })

  describe('signing in', () => {
    it('answers 401 AUTH_REQUIRED without a token', async () => {
      const res = await productsApi.search.$get({ query: { q: 'serum' } }, { headers: { 'cf-connecting-ip': freshIp() } })

      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    })

    it('answers 401 AUTH_REQUIRED, not 400, to a query that does not validate, without a token', async () => {
      const res = await productsApi.search.$get({ query: { q: 'a' } }, { headers: { 'cf-connecting-ip': freshIp() } })

      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    })
  })

  describe('rate limits', () => {
    it('answers 429 RATE_LIMITED to the 61st search of one user in a minute, from any address', async () => {
      const { statuses, limited } = await inOneRateWindow(async () => {
        const guest = await newGuest()
        const statuses: number[] = []
        let limited: Awaited<ReturnType<typeof search>> | undefined
        for (let i = 0; i < 61; i++) {
          const res = await search(guest, 'serum', freshIp())
          statuses.push(res.status)
          if (res.status === 429) limited = res
        }
        return { statuses, limited }
      }, { needMs: SEARCH_BURST_NEEDS_MS })

      expect(statuses.slice(0, 60)).not.toContain(429)
      expect(statuses[60]).toBe(429)
      expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
      expect(retryAfterOf(limited!)).toBeGreaterThan(0)
    }, RATE_TEST_TIMEOUT_MS)

    it('answers 429 RATE_LIMITED to the 121st search from one address in a minute, whoever sends it', async () => {
      const { statuses, limited } = await inOneRateWindow(async () => {
        const shared = freshIp()
        const statuses: number[] = []
        let limited: Awaited<ReturnType<typeof search>> | undefined
        // Each user stays well under its own limit; only the shared address adds up.
        let guest = await newGuest()
        for (let i = 0; i < 121; i++) {
          if (i % 40 === 0) guest = await newGuest()
          const res = await search(guest, 'serum', shared)
          statuses.push(res.status)
          if (res.status === 429) limited = res
        }
        return { statuses, limited }
      }, { needMs: SEARCH_BURST_NEEDS_MS })

      expect(statuses.slice(0, 120)).not.toContain(429)
      expect(statuses[120]).toBe(429)
      expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
      expect(retryAfterOf(limited!)).toBeGreaterThan(0)
    }, RATE_TEST_TIMEOUT_MS)
  })
})

describe('GET /api/v1/products/search in the OpenAPI document', () => {
  type Operation = {
    operationId?: string
    tags?: string[]
    security?: Record<string, unknown>[]
    parameters?: { name: string; in: string; required?: boolean; schema?: { minLength?: number; maxLength?: number } }[]
    responses: Record<string, unknown>
  }
  const operationOf = async () => {
    const res = await fetchWorker('http://deepertones.test/openapi.json')
    const document = (await res.json()) as { paths: Record<string, Record<string, Operation>> }
    return document.paths['/api/v1/products/search']?.get
  }

  it('is named searchProducts, tagged "Products", and needs the bearer token', async () => {
    const operation = await operationOf()

    expect(operation?.operationId).toBe('searchProducts')
    expect(operation?.tags).toEqual(['Products'])
    expect((operation?.security ?? []).some((requirement) => 'bearerAuth' in requirement)).toBe(true)
  })

  it('documents the product summary\'s form as one of the twelve forms or null, and always present', async () => {
    const res = await fetchWorker('http://deepertones.test/openapi.json')
    const document = (await res.json()) as { components: { schemas: Record<string, { properties?: Record<string, { items?: { required?: string[]; properties?: Record<string, { type?: unknown; enum?: unknown[] }> } }> }> } }
    const summary = document.components.schemas.ProductSearch?.properties?.products?.items

    expect(summary?.properties?.form?.type).toEqual(['string', 'null'])
    expect(summary?.properties?.form?.enum).toEqual(['spray', 'roll-on', 'stick', 'cream', 'lotion', 'gel', 'oil', 'serum', 'liquid', 'bar', 'powder', 'balm', null])
    expect(summary?.required).toContain('form')
  })

  it('documents a required query parameter q', async () => {
    const operation = await operationOf()

    expect(operation?.parameters).toContainEqual(expect.objectContaining({ name: 'q', in: 'query', required: true }))
  })

  it('lists the statuses it can answer with', async () => {
    const operation = await operationOf()

    expect(Object.keys(operation?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '401', '429']))
  })
})
