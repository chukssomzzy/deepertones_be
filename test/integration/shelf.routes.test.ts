import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { hc } from 'hono/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { D1CatalogWorkbookRepository } from '../../src/modules/catalog/catalog.workbook.repository'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { FakeOpsAlertsRepository } from '../../src/modules/ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { markedJpeg } from '../../src/modules/scans/scans.photos.fake'
import { scans } from '../../src/modules/scans/scans.table'
import { profileProducts } from '../../src/modules/shelf/shelf.table'
import { messageResponse, searchCall, searchResults, stubFetch, textBlock } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'
import { BURST_NEEDS_MS, inOneRateWindow, RATE_TEST_TIMEOUT_MS } from './rate-window'

// The shelf routes through the Worker's public surface: the typed client against the real entrypoint and real local D1. Products reach
// the shelf the way they do in life, by a scan item moving to ready (a catalogued product picked for an item) or to unidentified (the
// no-label answers). Only the arrange-only cases (order, an unresolved formulation) put rows into the table directly.

const SCAN_QUEUE = 'deepertones-scan-items-development'
const MINUTE = 60 * 1000
// The one clock for hand-made rows: "now" is the real clock the Worker runs on, fixtures are offsets.
const NOW = Date.now()

const queued: unknown[] = []
// The push jobs the Worker queues are recorded, not delivered (delivering one is push.background.test.ts's concern).
const pushQueued: unknown[] = []
const WORKER_ENV = {
  ...env,
  SCAN_ITEMS_QUEUE: { send: async (body: unknown) => void queued.push(body) } as unknown as Queue,
  PUSH_DELIVERY_QUEUE: { send: async (body: unknown) => void pushQueued.push(body), sendBatch: async () => {} } as unknown as Queue,
}
const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) =>
  worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())
const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })
const v1 = api.api.v1
const scansApi = v1.scans.products

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  queued.length = 0
  pushQueued.length = 0
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshBrand = () => `${runSalt}${next()}x ShelfBrand`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number; headers: Headers }
type NoLabelBody = { source: string; purpose: string; usedFor: string; description?: string; concerns: unknown[]; rulesVersion: number }
type ProductBody = { id: string; kind: string; brand: string; name: string; variant: string | null; form?: string | null; category: string; imageUrl: string | null }
type ItemView = { id: string; state: string; product?: ProductBody; noLabel?: NoLabelBody }
type ScanView = { id: string; kind: string; photos: unknown[]; items: (ItemView & { photoId: string | null; image: unknown })[] }
type EntryBody = {
  id: string
  addedAt: string
  lastScannedAt: string
  source: { scanId: string; itemId: string }
  kind: 'product' | 'no-label'
  product?: ProductBody
  noLabel?: NoLabelBody
}

const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
const errorCodeOf = async (res: Reply) => {
  const body = (await res.json()) as Envelope<unknown>
  if (body.success) throw new Error(`expected an error, got ${res.status}`)
  return body.error.code
}

const newGuest = async () => {
  const ip = freshIp()
  const res = await v1.auth.anonymous.$post({ json: { deviceId: `device-shelf-${runSalt}-${next()}`, platform: 'ios' } }, { headers: { 'cf-connecting-ip': ip } })
  const session = await dataOf<{ tokens: { accessToken: string }; user: { id: string } }>(res)
  const token = session.tokens.accessToken
  return { userId: session.user.id, token, headers: (): Record<string, string> => ({ 'cf-connecting-ip': ip, Authorization: `Bearer ${token}` }) }
}
type Guest = Awaited<ReturnType<typeof newGuest>>

const db = createDb(env.DB)
const profileIdOf = async (guest: Guest) => (await new D1ProfilesRepository(db).defaultFor(guest.userId))!.id

// The typed client's optional-body typing is not what is under test; the casts keep the calls short.
const getShelf = (guest?: Guest) => v1.me.shelf.$get({}, { headers: guest ? guest.headers() : { 'cf-connecting-ip': freshIp() } })
const deleteEntry = (guest: Guest | undefined, entryId: string, body?: Record<string, unknown>) =>
  (v1.me.shelf[':entryId'].$delete as (args: unknown, init: unknown) => Promise<Reply>)(
    { param: { entryId }, ...(body === undefined ? {} : { json: body }) },
    { headers: guest ? guest.headers() : { 'cf-connecting-ip': freshIp() } },
  )
// A DELETE as a client sends it when it always sets the JSON Content-Type, with whatever text it has as the body.
const deleteEntryRaw = (guest: Guest, entryId: string, body?: string) =>
  fetchWorker(`http://deepertones.test/api/v1/me/shelf/${entryId}`, {
    method: 'DELETE',
    headers: { ...guest.headers(), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  })
const entriesOf = async (guest: Guest) => (await dataOf<{ entries: EntryBody[] }>(await getShelf(guest))).entries

// --- driving items to ready and unidentified, by the real routes and steps ---

let lastAt = 0
const runStep = async (itemId: string, step: string) => {
  lastAt = Math.max(Date.now(), lastAt + 1)
  const batch = createMessageBatch(SCAN_QUEUE, [{ id: 'm', timestamp: new Date(), attempts: 1, body: { itemId, step, at: lastAt } }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, WORKER_ENV, ctx)
  expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['m'])
}
const CHEAP_USAGE = { input_tokens: 100, output_tokens: 50 }
const unreadable = () =>
  messageResponse({
    content: [textBlock(JSON.stringify({ classification: 'unreadable', brand: '', name: '', variant: '', category: 'other', confidence: 0 }))],
    usage: CHEAP_USAGE,
  })
const stubAnthropic = (...responders: Parameters<typeof stubFetch>) => {
  const { fetch } = stubFetch(...responders)
  vi.stubGlobal('fetch', fetch)
}
const scanPath = (guest: Guest) => ({ headers: guest.headers() })
const itemNow = async (guest: Guest, scanId: string, itemId: string) =>
  (await dataOf<ScanView>(await scansApi[':scanId'].$get({ param: { scanId } }, scanPath(guest)))).items.find((i) => i.id === itemId)!

/** A one-photo scan whose front photo could not be read three times: the item offers identification (a picked product, a typed name, no label). */
const awaitingIdentification = async (guest: Guest) => {
  const file = (marker: number) => new File([markedJpeg(marker).bytes], `p${marker}.jpg`, { type: 'image/jpeg' })
  const scan = await dataOf<ScanView>(await scansApi.$post({ form: { photos: [file(1)] } }, scanPath(guest)))
  const itemId = scan.items[0]!.id
  stubAnthropic(unreadable)
  await runStep(itemId, 'recognise')
  for (const marker of [22, 23]) {
    const res = await scansApi[':scanId'].items[':itemId'].retake.$post({ param: { scanId: scan.id, itemId }, form: { photo: file(marker) } }, scanPath(guest))
    expect(res.status).toBe(202)
    await runStep(itemId, 'recognise')
  }
  vi.unstubAllGlobals()
  expect((await itemNow(guest, scan.id, itemId)).state).toBe('needs-identification')
  return { scanId: scan.id, itemId }
}

const quietOpsAlerts = () =>
  new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: new MemoryJobQueue(), email: new MemoryEmailSender(), recipient: '', environment: 'test' })
/** A product the catalog already holds, researched and analysed, the way a scan puts it there. */
const cataloguedProduct = async (brand = freshBrand(), name = 'Hydrating Cleanser') => {
  const researcher = new MemoryProductResearcher()
  researcher.respondWith(() => ({ found: true, ingredients: ['Aqua', 'Glycerin', 'Cetearyl Alcohol'], sourceUrl: 'https://shop.example/product' }))
  const catalog = new ProductCatalogService({
    repository: new D1CatalogRepository(db),
    workbook: new D1CatalogWorkbookRepository(db),
    researcher,
    analyst: new MemoryProductAnalyst(),
    images: new MemoryCatalogImageStore(),
    imageKeyPrefix: 'catalog/test',
    opsAlerts: quietOpsAlerts(),
  })
  const resolved = await catalog.resolve({ brand, name, category: 'skin' })
  if (resolved.kind !== 'needs-research') throw new Error(`expected needs-research, got ${resolved.kind}`)
  const found = await catalog.research(resolved.productId)
  if (found.kind !== 'found') throw new Error('expected found')
  await catalog.analyse(found.formulationId)
  return { productId: resolved.productId, formulationId: found.formulationId }
}

/** Scans a product and picks it from the catalog: the item is ready, and so on the shelf. Answers the item as the scan shows it. */
const scanProduct = async (guest: Guest, productId: string) => {
  const { scanId, itemId } = await awaitingIdentification(guest)
  const res = await scansApi[':scanId'].items[':itemId'].identification.$post({ param: { scanId, itemId }, json: { productId } as never }, scanPath(guest))
  expect(res.status).toBe(202)
  const item = await dataOf<ItemView>(res)
  expect(item.state).toBe('ready')
  return { scanId, itemId, item }
}
const NO_LABEL_ANSWERS = { source: 'market-vendor', purpose: 'lighten', usedFor: '6-months-2-years', description: 'A pink tub from the market' }
/** Scans a product with no label and describes it: the item is unidentified, and so on the shelf. */
const scanNoLabel = async (guest: Guest) => {
  const { scanId, itemId } = await awaitingIdentification(guest)
  const res = await scansApi[':scanId'].items[':itemId']['no-label'].$post({ param: { scanId, itemId }, json: NO_LABEL_ANSWERS as never }, scanPath(guest))
  expect(res.status).toBe(202)
  const item = await dataOf<ItemView>(res)
  expect(item.state).toBe('unidentified')
  return { scanId, itemId, item }
}

/** A row put straight into the table, for the cases that only need a shelf in a given state. */
const putRow = async (guest: Guest, over: Partial<typeof profileProducts.$inferInsert> & { productId: string; formulationId: string | null }) => {
  const id = crypto.randomUUID()
  await db.insert(profileProducts).values({
    id,
    profileId: await profileIdOf(guest),
    kind: 'product',
    scanId: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
    addedAt: new Date(NOW),
    lastScannedAt: new Date(NOW),
    ...over,
  })
  return id
}

describe('GET /api/v1/me/shelf', () => {
  it('answers 200 with no entries for a profile that has scanned nothing', async () => {
    const guest = await newGuest()

    const res = await getShelf(guest)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ entries: [] })
  })

  it('shows a scanned product with the same flat summary its scan item shows, and the scan and item it came from', async () => {
    const guest = await newGuest()
    const { productId } = await cataloguedProduct()
    const { scanId, itemId, item } = await scanProduct(guest, productId)

    const entries = await entriesOf(guest)

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: expect.any(String),
      kind: 'product',
      source: { scanId, itemId },
      product: item.product,
    })
    expect(entries[0]!.product).toMatchObject({ id: productId, kind: 'named', imageUrl: null })
    expect(entries[0]).not.toHaveProperty('noLabel')
    expect(Math.abs(new Date(entries[0]!.lastScannedAt).getTime() - NOW)).toBeLessThan(5 * MINUTE)
    expect(entries[0]!.addedAt).toBe(entries[0]!.lastScannedAt)
  })

  it('shows a product with no label with exactly the noLabel view its scan item shows, and no product', async () => {
    const guest = await newGuest()
    const { scanId, itemId, item } = await scanNoLabel(guest)

    const entries = await entriesOf(guest)

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'no-label', source: { scanId, itemId } })
    expect(entries[0]!.noLabel).toEqual(item.noLabel)
    expect(entries[0]!.noLabel).toMatchObject({ source: 'market-vendor', purpose: 'lighten', usedFor: '6-months-2-years', description: 'A pink tub from the market', rulesVersion: 1 })
    expect(entries[0]).not.toHaveProperty('product')
  })

  it('lists a product scanned again once, pointing at the newer scan and keeping the first added time', async () => {
    const guest = await newGuest()
    const { productId } = await cataloguedProduct()
    await scanProduct(guest, productId)
    const [first] = await entriesOf(guest)
    const second = await scanProduct(guest, productId)

    const entries = await entriesOf(guest)

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: first!.id, addedAt: first!.addedAt, source: { scanId: second.scanId, itemId: second.itemId } })
    expect(new Date(entries[0]!.lastScannedAt).getTime()).toBeGreaterThanOrEqual(new Date(first!.lastScannedAt).getTime())
  })

  it('lists the product scanned most recently first', async () => {
    const guest = await newGuest()
    const oldest = await cataloguedProduct()
    const middle = await cataloguedProduct()
    const newest = await cataloguedProduct()
    // Put out of order, with clear gaps: the order is the scan time, not the order they were added in.
    await putRow(guest, { productId: middle.productId, formulationId: middle.formulationId, lastScannedAt: new Date(NOW - 2 * MINUTE) })
    await putRow(guest, { productId: newest.productId, formulationId: newest.formulationId, lastScannedAt: new Date(NOW - MINUTE) })
    await putRow(guest, { productId: oldest.productId, formulationId: oldest.formulationId, lastScannedAt: new Date(NOW - 3 * MINUTE) })

    const entries = await entriesOf(guest)

    expect(entries.map((e) => e.product!.id)).toEqual([newest.productId, middle.productId, oldest.productId])
  })

  it('leaves out an entry whose formulation does not resolve, keeps the rest, and logs only its id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const guest = await newGuest()
    const kept = await cataloguedProduct()
    await putRow(guest, { productId: kept.productId, formulationId: kept.formulationId, lastScannedAt: new Date(NOW - MINUTE) })
    const lostId = await putRow(guest, { productId: crypto.randomUUID(), formulationId: crypto.randomUUID() })

    const res = await getShelf(guest)

    expect(res.status).toBe(200)
    const entries = (await dataOf<{ entries: EntryBody[] }>(res)).entries
    expect(entries.map((e) => e.product!.id)).toEqual([kept.productId])
    expect(error).toHaveBeenCalledWith({ outcome: 'shelf-entry-unresolved', entryId: lostId })
  })

  it('shows a profile only its own entries', async () => {
    const amara = await newGuest()
    const tolu = await newGuest()
    const { productId } = await cataloguedProduct()
    await scanProduct(amara, productId)
    await scanNoLabel(amara)

    expect(await entriesOf(amara)).toHaveLength(2)
    expect(await entriesOf(tolu)).toEqual([])
  })

  it('answers 401 AUTH_REQUIRED without a token', async () => {
    const res = await getShelf()

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })
})

describe('DELETE /api/v1/me/shelf/{entryId}', () => {
  it('answers 204 for a removal with no body, and the entry is gone from the list', async () => {
    const guest = await newGuest()
    const { productId } = await cataloguedProduct()
    await scanProduct(guest, productId)
    const [entry] = await entriesOf(guest)

    const res = await deleteEntry(guest, entry!.id)

    expect(res.status).toBe(204)
    expect(await entriesOf(guest)).toEqual([])
  })

  it('answers 204 for an empty body and keeps no reason', async () => {
    const guest = await newGuest()
    await scanNoLabel(guest)
    const [entry] = await entriesOf(guest)

    expect((await deleteEntry(guest, entry!.id, {})).status).toBe(204)

    expect(await entriesOf(guest)).toEqual([])
    // The reason is not on any read, so the table is the one place to see it.
    const [row] = await db.select().from(profileProducts).where(eq(profileProducts.id, entry!.id))
    expect(row).toMatchObject({ removedReason: null })
    expect(row!.removedAt).toBeInstanceOf(Date)
  })

  it.each([undefined, '', '  \n'])('answers 204 for the JSON Content-Type with an empty body (%j), and keeps no reason', async (body) => {
    const guest = await newGuest()
    await scanNoLabel(guest)
    const [entry] = await entriesOf(guest)

    expect((await deleteEntryRaw(guest, entry!.id, body)).status).toBe(204)

    expect(await entriesOf(guest)).toEqual([])
    const [row] = await db.select().from(profileProducts).where(eq(profileProducts.id, entry!.id))
    expect(row).toMatchObject({ removedReason: null })
    expect(row!.removedAt).toBeInstanceOf(Date)
  })

  it.each(['{"reason":"because"}', '{"reson":"finished"}', '{"reason":"finished","extra":1}', '{not json', '"finished"', 'null'])(
    'answers 400 VALIDATION_FAILED for the JSON body %s, and removes nothing',
    async (body) => {
      const guest = await newGuest()
      await scanNoLabel(guest)
      const [entry] = await entriesOf(guest)

      const res = await deleteEntryRaw(guest, entry!.id, body)

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
      expect(await entriesOf(guest)).toHaveLength(1)
    },
  )

  it.each(['finished', 'stopped', 'not-mine'] as const)('answers 204 for the reason %s, which is kept with the removed entry', async (reason) => {
    const guest = await newGuest()
    await scanNoLabel(guest)
    const [entry] = await entriesOf(guest)

    expect((await deleteEntry(guest, entry!.id, { reason })).status).toBe(204)

    expect(await entriesOf(guest)).toEqual([])
    const [row] = await db.select().from(profileProducts).where(eq(profileProducts.id, entry!.id))
    expect(row).toMatchObject({ removedReason: reason })
  })

  it('removes only the entry asked for', async () => {
    const guest = await newGuest()
    const { productId } = await cataloguedProduct()
    await scanProduct(guest, productId)
    await scanNoLabel(guest)
    const before = await entriesOf(guest)
    const target = before.find((e) => e.kind === 'product')!

    await deleteEntry(guest, target.id)

    expect((await entriesOf(guest)).map((e) => e.kind)).toEqual(['no-label'])
  })

  it('answers 204 again for an entry removed already, and keeps the first reason', async () => {
    const guest = await newGuest()
    await scanNoLabel(guest)
    const [entry] = await entriesOf(guest)
    expect((await deleteEntry(guest, entry!.id, { reason: 'finished' })).status).toBe(204)

    expect((await deleteEntry(guest, entry!.id, { reason: 'stopped' })).status).toBe(204)

    const [row] = await db.select().from(profileProducts).where(eq(profileProducts.id, entry!.id))
    expect(row).toMatchObject({ removedReason: 'finished' })
  })

  it('brings a removed product back when it is scanned again', async () => {
    const guest = await newGuest()
    const { productId } = await cataloguedProduct()
    await scanProduct(guest, productId)
    const [entry] = await entriesOf(guest)
    await deleteEntry(guest, entry!.id, { reason: 'finished' })

    await scanProduct(guest, productId)

    expect((await entriesOf(guest)).map((e) => e.id)).toEqual([entry!.id])
  })

  it('answers 404 SHELF_ENTRY_NOT_FOUND for another profile\'s entry, and it stays on its owner\'s shelf', async () => {
    const owner = await newGuest()
    const intruder = await newGuest()
    await scanNoLabel(owner)
    const [entry] = await entriesOf(owner)

    const res = await deleteEntry(intruder, entry!.id, { reason: 'not-mine' })

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('SHELF_ENTRY_NOT_FOUND')
    expect((await entriesOf(owner)).map((e) => e.id)).toEqual([entry!.id])
  })

  it('answers 404 SHELF_ENTRY_NOT_FOUND for an id nobody has', async () => {
    const guest = await newGuest()

    const res = await deleteEntry(guest, crypto.randomUUID())

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('SHELF_ENTRY_NOT_FOUND')
  })

  it('answers 400 VALIDATION_FAILED for an id that is not a UUID', async () => {
    const guest = await newGuest()

    const res = await deleteEntry(guest, 'not-an-entry')

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
  })

  it('answers 400 VALIDATION_FAILED for a reason outside the three, and removes nothing', async () => {
    const guest = await newGuest()
    await scanNoLabel(guest)
    const [entry] = await entriesOf(guest)

    const res = await deleteEntry(guest, entry!.id, { reason: 'because' })

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    expect(await entriesOf(guest)).toHaveLength(1)
  })

  it('answers 401 AUTH_REQUIRED without a token', async () => {
    const res = await deleteEntry(undefined, crypto.randomUUID())

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })
})

// --- adding a named product from search ---

const DAY_SECONDS = 24 * 60 * 60
const retryAfterOf = (res: Reply) => Number(res.headers.get('Retry-After'))
const CLEAN_LIST = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
const CHEAP = { input_tokens: 100, output_tokens: 50 }
// What Claude answers in the background steps: the research searches and finds a list (the researcher only believes a source the search
// returned); the analysis finds nothing to warn about.
const SOURCE_URL = 'https://shop.example/product'
const researchFinds = () =>
  messageResponse({
    content: [searchCall('srvtoolu_01', 'ingredients'), searchResults('srvtoolu_01', [SOURCE_URL]), textBlock(JSON.stringify({ found: true, ingredients: CLEAN_LIST, sourceUrl: SOURCE_URL, imageUrl: null }))],
    usage: CHEAP,
  })
const analysedWithNoConcerns = () => messageResponse({ content: [textBlock(JSON.stringify({ concerns: [] }))], usage: CHEAP })

/** The catalog as the Worker's background steps use it, for arranging products in the states a scan finds them in. */
const catalogFor = (researcher = new MemoryProductResearcher()) =>
  new ProductCatalogService({
    repository: new D1CatalogRepository(db),
    workbook: new D1CatalogWorkbookRepository(db),
    researcher,
    analyst: new MemoryProductAnalyst(),
    images: new MemoryCatalogImageStore(),
    imageKeyPrefix: 'catalog/test',
    opsAlerts: quietOpsAlerts(),
  })
/** A named product with a list that is not analysed yet: adding it needs the analysis. */
const productNeedingAnalysis = async () => {
  const researcher = new MemoryProductResearcher()
  researcher.respondWith(() => ({ found: true, ingredients: CLEAN_LIST, sourceUrl: 'https://shop.example/product' }))
  const catalog = catalogFor(researcher)
  const resolved = await catalog.resolve({ brand: freshBrand(), name: 'Hydrating Cleanser', category: 'skin' })
  if (resolved.kind !== 'needs-research') throw new Error(`expected needs-research, got ${resolved.kind}`)
  const found = await catalog.research(resolved.productId)
  if (found.kind !== 'found') throw new Error('expected found')
  return resolved.productId
}
/** A named product nobody has the ingredients for: adding it needs the research, then the analysis. */
const productNeedingResearch = async () => {
  const resolved = await catalogFor().resolve({ brand: freshBrand(), name: 'Hydrating Cleanser', category: 'skin' })
  if (resolved.kind !== 'needs-research') throw new Error(`expected needs-research, got ${resolved.kind}`)
  return resolved.productId
}
/** A product made from a list nobody named: the catalog never offers it from search. */
const unnamedProduct = async () => (await catalogFor().fromLabel({ ingredients: [...CLEAN_LIST, `Parfum ${runSalt}x${next()}`] })).productId

const addProduct = (guest: Guest | undefined, body: unknown, ip?: string) =>
  (v1.me.shelf.$post as (args: unknown, init: unknown) => Promise<Reply>)(
    { json: body },
    { headers: guest ? { ...guest.headers(), ...(ip ? { 'cf-connecting-ip': ip } : {}) } : { 'cf-connecting-ip': freshIp() } },
  )
const started = async (res: Reply) => {
  expect(res.status).toBe(202)
  return dataOf<{ scanId: string; itemId: string }>(res)
}
/** Scans the user has made, read from the table: no route lists them, and "no scan was made" is a thing only the table can show. */
const scanCountOf = async (guest: Guest) => (await db.select({ id: scans.id }).from(scans).where(eq(scans.userId, guest.userId))).length
const scanOf = async (guest: Guest, scanId: string) => dataOf<ScanView>(await scansApi[':scanId'].$get({ param: { scanId } }, scanPath(guest)))
/** `count` photos taken as product scans of up to 10, each from an address of its own so only the user's allowance is tested. */
const takePhotos = async (guest: Guest, count: number) => {
  for (let taken = 0; taken < count; ) {
    const batch = Math.min(10, count - taken)
    const photos = Array.from({ length: batch }, (_, i) => new File([markedJpeg(taken + i).bytes], `p${taken + i}.jpg`, { type: 'image/jpeg' }))
    const res = await scansApi.$post({ form: { photos } }, { headers: { ...guest.headers(), 'cf-connecting-ip': freshIp() } })
    expect(res.status).toBe(202)
    taken += batch
  }
}
const photoResponse = (guest: Guest) =>
  scansApi.$post({ form: { photos: [new File([markedJpeg(250).bytes], 'one-more.jpg', { type: 'image/jpeg' })] } }, { headers: { ...guest.headers(), 'cf-connecting-ip': freshIp() } })

describe('POST /api/v1/me/shelf', () => {
  describe('a product the catalog has analysed', () => {
    it('answers 202 with the scan and item, and the item is ready at once in a typed scan with no photo', async () => {
      const guest = await newGuest()
      const { productId } = await cataloguedProduct()

      const { scanId, itemId } = await started(await addProduct(guest, { productId }))

      const scan = await scanOf(guest, scanId)
      expect(scan).toMatchObject({ id: scanId, kind: 'typed', photos: [] })
      expect(scan.items).toHaveLength(1)
      expect(scan.items[0]).toMatchObject({ id: itemId, state: 'ready', photoId: null, image: null, product: { id: productId, kind: 'named' } })
    })

    it('puts the product on the shelf at once, pointing at the typed scan, in the view the scan item shows', async () => {
      const guest = await newGuest()
      const { productId } = await cataloguedProduct()

      const { scanId, itemId } = await started(await addProduct(guest, { productId }))

      const entries = await entriesOf(guest)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ kind: 'product', source: { scanId, itemId } })
      expect(entries[0]!.product).toEqual((await scanOf(guest, scanId)).items[0]!.product)
      expect(Math.abs(new Date(entries[0]!.lastScannedAt).getTime() - NOW)).toBeLessThan(5 * MINUTE)
    })

    it('queues no background step and no push', async () => {
      const guest = await newGuest()
      const { productId } = await cataloguedProduct()
      queued.length = 0
      pushQueued.length = 0

      await started(await addProduct(guest, { productId }))

      expect(queued).toEqual([])
      expect(pushQueued).toEqual([])
    })

    it('does not use up any of the day\'s photos: the user can still take 30', async () => {
      const guest = await newGuest()
      const { productId } = await cataloguedProduct()
      await started(await addProduct(guest, { productId }))

      await takePhotos(guest, 30)

      expect((await photoResponse(guest)).status).toBe(429)
    })

    it('still adds it past the daily allowance, when the user has taken 30 photos', async () => {
      const guest = await newGuest()
      const { productId } = await cataloguedProduct()
      await takePhotos(guest, 30)

      const { scanId, itemId } = await started(await addProduct(guest, { productId }))

      expect((await entriesOf(guest)).map((e) => e.source)).toEqual([{ scanId, itemId }])
    })

    it('puts a product that was removed back on the shelf as the same entry, from the new typed scan', async () => {
      const guest = await newGuest()
      const { productId } = await cataloguedProduct()
      await scanProduct(guest, productId)
      const [entry] = await entriesOf(guest)
      expect((await deleteEntry(guest, entry!.id, { reason: 'finished' })).status).toBe(204)
      expect(await entriesOf(guest)).toEqual([])

      const { scanId, itemId } = await started(await addProduct(guest, { productId }))

      const entries = await entriesOf(guest)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ id: entry!.id, addedAt: entry!.addedAt, source: { scanId, itemId } })
      const [row] = await db.select().from(profileProducts).where(eq(profileProducts.id, entry!.id))
      expect(row).toMatchObject({ removedAt: null, removedReason: null })
    })

    it('puts the product on the shelf of the caller\'s profile only', async () => {
      const amara = await newGuest()
      const tolu = await newGuest()
      const { productId } = await cataloguedProduct()

      await started(await addProduct(amara, { productId }))

      expect(await entriesOf(amara)).toHaveLength(1)
      expect(await entriesOf(tolu)).toEqual([])
    })
  })

  describe('a product already on the profile\'s shelf', () => {
    it('answers 200 with that entry, as the shelf shows it, and makes no scan, queues nothing and sends no push', async () => {
      const guest = await newGuest()
      const { productId } = await cataloguedProduct()
      await scanProduct(guest, productId)
      const [entry] = await entriesOf(guest)
      const scansBefore = await scanCountOf(guest)
      queued.length = 0
      pushQueued.length = 0

      const res = await addProduct(guest, { productId })

      expect(res.status).toBe(200)
      expect(await dataOf<EntryBody>(res)).toEqual(entry)
      expect(await scanCountOf(guest)).toBe(scansBefore)
      expect(await entriesOf(guest)).toEqual([entry])
      expect(queued).toEqual([])
      expect(pushQueued).toEqual([])
    })

    it('answers 200 even when the daily allowance is used up', async () => {
      const guest = await newGuest()
      const { productId } = await cataloguedProduct()
      await scanProduct(guest, productId)
      // The scan above took 3 photos (the first and two retakes): 27 more is the day's 30.
      await takePhotos(guest, 27)
      expect((await photoResponse(guest)).status).toBe(429)

      expect((await addProduct(guest, { productId })).status).toBe(200)
    })

    it('does not take another profile\'s entry for it: the product is added', async () => {
      const amara = await newGuest()
      const tolu = await newGuest()
      const { productId } = await cataloguedProduct()
      await scanProduct(amara, productId)

      const res = await addProduct(tolu, { productId })

      expect(res.status).toBe(202)
      expect(await entriesOf(tolu)).toHaveLength(1)
    })
  })

  describe('a product whose ingredients are not analysed yet', () => {
    it('answers 202 and the item is analysing, with the analysis queued, nothing on the shelf and no push yet', async () => {
      const guest = await newGuest()
      const productId = await productNeedingAnalysis()
      queued.length = 0
      pushQueued.length = 0

      const { scanId, itemId } = await started(await addProduct(guest, { productId }))

      expect((await scanOf(guest, scanId)).items[0]).toMatchObject({ id: itemId, state: 'analysing' })
      expect(queued).toEqual([{ itemId, step: 'analyse', at: expect.any(Number) }])
      expect(await entriesOf(guest)).toEqual([])
      expect(pushQueued).toEqual([])
    })

    it('puts the product on the shelf and queues the finished push for the profile once the analysis has run', async () => {
      const guest = await newGuest()
      const productId = await productNeedingAnalysis()
      const { scanId, itemId } = await started(await addProduct(guest, { productId }))
      pushQueued.length = 0

      stubAnthropic(analysedWithNoConcerns)
      await runStep(itemId, 'analyse')
      vi.unstubAllGlobals()

      expect((await scanOf(guest, scanId)).items[0]).toMatchObject({ state: 'ready', product: { id: productId } })
      expect((await entriesOf(guest)).map((e) => e.source)).toEqual([{ scanId, itemId }])
      expect(pushQueued).toEqual([{ kind: 'scan-finished', userId: guest.userId, profileId: await profileIdOf(guest), scanId, readyCount: 1 }])
    })

    it('counts as one of the day\'s photos: after 29 photos it is accepted, and the next photo is refused', async () => {
      const guest = await newGuest()
      const productId = await productNeedingAnalysis()
      await takePhotos(guest, 29)

      await started(await addProduct(guest, { productId }))

      const refused = await photoResponse(guest)
      expect(refused.status).toBe(429)
      expect(await errorCodeOf(refused)).toBe('SCAN_DAILY_LIMIT')
    })

    it('answers 429 SCAN_DAILY_LIMIT with Retry-After after 30 photos, and makes no scan, queues nothing and puts nothing on the shelf', async () => {
      const guest = await newGuest()
      const productId = await productNeedingAnalysis()
      await takePhotos(guest, 30)
      const scansBefore = await scanCountOf(guest)
      queued.length = 0

      const res = await addProduct(guest, { productId })

      expect(res.status).toBe(429)
      expect(await errorCodeOf(res)).toBe('SCAN_DAILY_LIMIT')
      expect(retryAfterOf(res)).toBeGreaterThan(0)
      expect(retryAfterOf(res)).toBeLessThanOrEqual(DAY_SECONDS + 1)
      expect(await scanCountOf(guest)).toBe(scansBefore)
      expect(queued).toEqual([])
      expect(await entriesOf(guest)).toEqual([])
    })
  })

  describe('a product nobody has the ingredients for', () => {
    it('answers 202 and the item is researching, with the research queued, nothing on the shelf and no push yet', async () => {
      const guest = await newGuest()
      const productId = await productNeedingResearch()
      queued.length = 0
      pushQueued.length = 0

      const { scanId, itemId } = await started(await addProduct(guest, { productId }))

      expect((await scanOf(guest, scanId)).items[0]).toMatchObject({ id: itemId, state: 'researching' })
      expect(queued).toEqual([{ itemId, step: 'research', at: expect.any(Number) }])
      expect(await entriesOf(guest)).toEqual([])
      expect(pushQueued).toEqual([])
    })

    it('puts the product on the shelf and queues the finished push once the research and analysis have run', async () => {
      const guest = await newGuest()
      const productId = await productNeedingResearch()
      const { scanId, itemId } = await started(await addProduct(guest, { productId }))
      pushQueued.length = 0

      stubAnthropic(researchFinds)
      await runStep(itemId, 'research')
      vi.unstubAllGlobals()
      expect((await scanOf(guest, scanId)).items[0]).toMatchObject({ state: 'analysing' })
      stubAnthropic(analysedWithNoConcerns)
      await runStep(itemId, 'analyse')
      vi.unstubAllGlobals()

      expect((await entriesOf(guest)).map((e) => e.source)).toEqual([{ scanId, itemId }])
      expect(pushQueued).toEqual([{ kind: 'scan-finished', userId: guest.userId, profileId: await profileIdOf(guest), scanId, readyCount: 1 }])
    })

    it('counts as one of the day\'s photos, and is refused with SCAN_DAILY_LIMIT after 30', async () => {
      const guest = await newGuest()
      const productId = await productNeedingResearch()
      await takePhotos(guest, 30)

      const res = await addProduct(guest, { productId })

      expect(res.status).toBe(429)
      expect(await errorCodeOf(res)).toBe('SCAN_DAILY_LIMIT')
    })
  })

  describe('the address', () => {
    it('counts the day\'s photos per address from cf-connecting-ip: refused at an address that has taken 100, accepted from another', async () => {
      const shared = freshIp()
      for (let i = 0; i < 10; i++) {
        const other = await newGuest()
        const photos = Array.from({ length: 10 }, (_, p) => new File([markedJpeg(i * 10 + p).bytes], `p${p}.jpg`, { type: 'image/jpeg' }))
        const res = await scansApi.$post({ form: { photos } }, { headers: { ...other.headers(), 'cf-connecting-ip': shared } })
        expect(res.status).toBe(202)
      }
      const guest = await newGuest()
      const productId = await productNeedingAnalysis()

      const refused = await addProduct(guest, { productId }, shared)
      const elsewhere = await addProduct(guest, { productId }, freshIp())

      expect(refused.status).toBe(429)
      expect(await errorCodeOf(refused)).toBe('SCAN_DAILY_LIMIT')
      expect(retryAfterOf(refused)).toBeGreaterThan(0)
      expect(elsewhere.status).toBe(202)
    })
  })

  describe('a product the catalog does not offer', () => {
    it('answers 404 PRODUCT_NOT_FOUND for an id the catalog does not hold, and makes no scan', async () => {
      const guest = await newGuest()

      const res = await addProduct(guest, { productId: crypto.randomUUID() })

      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('PRODUCT_NOT_FOUND')
      expect(await scanCountOf(guest)).toBe(0)
      expect(queued).toEqual([])
    })

    it('answers 404 PRODUCT_NOT_FOUND for an unnamed product, and makes no scan', async () => {
      const guest = await newGuest()

      const res = await addProduct(guest, { productId: await unnamedProduct() })

      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('PRODUCT_NOT_FOUND')
      expect(await scanCountOf(guest)).toBe(0)
    })

    it('answers 404 rather than 429 when the allowance is used up: the product is looked at first', async () => {
      const guest = await newGuest()
      await takePhotos(guest, 30)

      const res = await addProduct(guest, { productId: crypto.randomUUID() })

      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('PRODUCT_NOT_FOUND')
    })
  })

  describe('the body', () => {
    it.each([['no productId', {}], ['an empty productId', { productId: '' }], ['a productId that is not text', { productId: 5 }], ['a null body', null]])(
      'answers 400 VALIDATION_FAILED for %s, and makes no scan',
      async (_label, body) => {
        const guest = await newGuest()

        const res = await addProduct(guest, body)

        expect(res.status).toBe(400)
        expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
        expect(await scanCountOf(guest)).toBe(0)
      },
    )

    it('answers 400 VALIDATION_FAILED for a body that is not JSON', async () => {
      const guest = await newGuest()

      const res = await fetchWorker('http://deepertones.test/api/v1/me/shelf', {
        method: 'POST',
        headers: { ...guest.headers(), 'content-type': 'application/json' },
        body: '{not json',
      })

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    })
  })

  it('answers 401 AUTH_REQUIRED without a token', async () => {
    const res = await addProduct(undefined, { productId: crypto.randomUUID() })

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  describe('rate limits', () => {
    it('answers 429 RATE_LIMITED with Retry-After to the 11th add of one user in a minute, from any address', async () => {
      const { statuses, limited } = await inOneRateWindow(async () => {
        const guest = await newGuest()
        const statuses: number[] = []
        let limited: Reply | undefined
        for (let i = 0; i < 11; i++) {
          // A product nobody holds: the limit is counted before the route looks at it.
          const res = await addProduct(guest, { productId: crypto.randomUUID() }, freshIp())
          statuses.push(res.status)
          if (res.status === 429) limited = res
        }
        return { statuses, limited }
      }, { needMs: BURST_NEEDS_MS })

      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404))
      expect(statuses[10]).toBe(429)
      expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
      expect(retryAfterOf(limited!)).toBeGreaterThan(0)
    }, RATE_TEST_TIMEOUT_MS)

    it('answers 429 RATE_LIMITED with Retry-After to the 21st add from one address in a minute, whoever sends it', async () => {
      const { statuses, limited } = await inOneRateWindow(async () => {
        const shared = freshIp()
        const statuses: number[] = []
        let limited: Reply | undefined
        for (let i = 0; i < 21; i++) {
          const res = await addProduct(await newGuest(), { productId: crypto.randomUUID() }, shared)
          statuses.push(res.status)
          if (res.status === 429) limited = res
        }
        return { statuses, limited }
      }, { needMs: BURST_NEEDS_MS })

      expect(statuses.slice(0, 20)).toEqual(Array(20).fill(404))
      expect(statuses[20]).toBe(429)
      expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
      expect(retryAfterOf(limited!)).toBeGreaterThan(0)
    }, RATE_TEST_TIMEOUT_MS)
  })
})
