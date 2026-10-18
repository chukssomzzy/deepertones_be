import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { hc } from 'hono/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { FakeOpsAlertsRepository } from '../../src/modules/ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { markedJpeg } from '../../src/modules/scans/scans.photos.fake'
import { profileProducts } from '../../src/modules/shelf/shelf.table'
import { messageResponse, stubFetch, textBlock } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'

// The shelf routes through the Worker's public surface: the typed client against the real entrypoint and real local D1. Products reach
// the shelf the way they do in life, by a scan item moving to ready (a catalogued product picked for an item) or to unidentified (the
// no-label answers). Only the arrange-only cases (order, an unresolved formulation) put rows into the table directly.

const SCAN_QUEUE = 'deepertones-scan-items-development'
const MINUTE = 60 * 1000
// The one clock for hand-made rows: "now" is the real clock the Worker runs on, fixtures are offsets.
const NOW = Date.now()

const queued: unknown[] = []
const WORKER_ENV = {
  ...env,
  SCAN_ITEMS_QUEUE: { send: async (body: unknown) => void queued.push(body) } as unknown as Queue,
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
type Reply = { json(): Promise<unknown>; status: number }
type NoLabelBody = { source: string; purpose: string; usedFor: string; description?: string; concerns: unknown[]; rulesVersion: number }
type ProductBody = { id: string; kind: string; brand: string; name: string; variant: string | null; form?: string | null; category: string; imageUrl: string | null }
type ItemView = { id: string; state: string; product?: ProductBody; noLabel?: NoLabelBody }
type ScanView = { id: string; items: ItemView[] }
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
