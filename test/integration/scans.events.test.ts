import { abortAllDurableObjects, createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { buildContainer } from '../../src/container'
import { advanceScanItemSpec } from '../../src/modules/scans/scans.job-specs'
import { runAs } from '../../src/lib/context'
import { createDb } from '../../src/lib/db'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { jpegPhoto, markedJpeg } from '../../src/modules/scans/scans.photos.fake'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { messageResponse, stubFetch, textBlock } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'
import { parseFrame, sseReader, type SseReader } from './sse'
import { FakeOpsAlertsRepository } from '../../src/modules/ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'

/** An alerting service that goes nowhere: these tests are not about ops alerts. */
const quietOpsAlerts = () =>
  new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: new MemoryJobQueue(), email: new MemoryEmailSender(), recipient: '', environment: 'test' })

// GET /api/v1/scans/products/{scanId}/events through the real Worker: bearer auth, the ownership check, the snapshot, and the live
// frames a scan's background steps cause. The steps are driven the way production drives them, through the Worker's
// queue handler, with only the outbound Anthropic call stubbed at fetch. Scans are created through the service (the
// Worker's own container), so these tests do not depend on the upload route. SSE is read with plain fetch, because the
// typed client reads a stream as a bare Response; the reader is bounded (./sse), so a stream that never speaks fails the
// test instead of hanging it.
const MAIN = 'deepertones-scan-items-development'
const SOURCE_URL = 'https://shop.example/product'
const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
const ORIGIN = 'http://deepertones.test'

const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
const freshBrand = () => `${runSalt}${counter++}x EventsBrand`
// A new client IP per scan keeps the daily per-IP photo quota from coupling tests to each other.
const freshIp = () => `198.51.${Math.floor(counter / 250) % 250}.${(counter++ % 250) + 1}`

const users = new D1UsersRepository(createDb(env.DB))
const tokens = new TokenService({ secret: env.JWT_SECRET })
// Steps are driven by hand below. The real local queue would deliver the service's own follow-on messages a moment
// later, into whichever test is running then (with its fetch stub), so this file's Worker queues into nothing.
const quietQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
const testEnv = { ...env, SCAN_ITEMS_QUEUE: quietQueue }
const container = buildContainer(testEnv)

/** A guest, and the bearer token the app would hold for it. */
const newGuest = async () => {
  const id = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id, createdAt: new Date() }, device: { deviceHash: `scans-events-${id}`, platform: 'ios' }, profile: { id: profileId } })
  const { accessToken } = await tokens.issue({ id, status: 'anonymous', tokenVersion: 0 }, profileId)
  return { userId: id, profileId, token: accessToken }
}
type Guest = Awaited<ReturnType<typeof newGuest>>

/** A scan of the given photos, made through the service for this guest, with its items' ids in photo order. */
const startScan = async (guest: Guest, photos = [jpegPhoto()]) => {
  const scan = await runAs({ kind: 'user', userId: guest.userId, status: 'anonymous', profileId: guest.profileId }, () => container.scans.create({ photos, clientIp: freshIp() }))
  return { scanId: scan.id as string, itemIds: scan.items.map((item: { id: string }) => item.id) as string[] }
}

/** A shelf scan of the given photos, made through the service for this guest, with its placeholder items' ids in photo order. */
const startShelf = async (guest: Guest, photos = [markedJpeg(1)]) => {
  const scan = await runAs({ kind: 'user', userId: guest.userId, status: 'anonymous', profileId: guest.profileId }, () => container.scans.createShelf({ photos, clientIp: freshIp() }))
  return { scanId: scan.id as string, itemIds: scan.items.map((item: { id: string }) => item.id) as string[] }
}

const events = (scanId: string, token?: string) =>
  exports.default.fetch(new Request(`${ORIGIN}/api/v1/scans/products/${scanId}/events`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }))
const getScan = async (scanId: string, token: string) => {
  const res = await exports.default.fetch(new Request(`${ORIGIN}/api/v1/scans/products/${scanId}`, { headers: { Authorization: `Bearer ${token}` } }))
  const body = (await res.json()) as { success: true; data: { id: string; kind: string; photos: { id: string; position: number; state: string; skipped: Record<string, number> }[]; items: { id: string; photoId: string | null; state: string }[] } }
  return body.data
}

const opened: SseReader[] = []
/** Opens the event stream and returns a reader positioned at its first frame. */
const watch = async (scanId: string, token: string) => {
  const res = await events(scanId, token)
  expect(res.status).toBe(200)
  const stream = sseReader(res)
  opened.push(stream)
  return { res, stream }
}

const runQueue = async (body: unknown) => {
  const batch = createMessageBatch(MAIN, [{ id: 'm', timestamp: new Date(), attempts: 1, body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, testEnv, ctx)
  return (await getQueueResult(batch, ctx)).explicitAcks
}
// Each run needs a time of its own: a step is keyed by item, step and `at`, and a repeat of a key is acknowledged and skipped.
let lastAt = 0
const nextAt = () => (lastAt = Math.max(Date.now(), lastAt + 1))
const step = (itemId: string, name: 'recognise' | 'match') => runQueue({ itemId, step: name, at: nextAt() })

/** A product the catalog already holds, researched and analysed, so a scan of it needs no research or analysis call. */
const catalogued = async (brand: string, name: string) => {
  const researcher = new MemoryProductResearcher()
  researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))
  const catalog = new ProductCatalogService({
    repository: new D1CatalogRepository(createDb(env.DB)),
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
}

// The Worker builds its own container per queue message, so the client cannot be handed a fetch here: the SDK picks up the global one when it is built.
const stubAnthropic = (...responders: Parameters<typeof stubFetch>) => {
  const { calls, fetch } = stubFetch(...responders)
  vi.stubGlobal('fetch', fetch)
  return calls
}

const recognised = (answer: Record<string, unknown>) => () => messageResponse({ content: [textBlock(JSON.stringify(answer))] })
const beautyProduct = (brand: string, name: string) =>
  recognised({ classification: 'beauty-product', brand, name, variant: '', form: 'unknown', category: 'skin', confidence: 0.92 })
const face = recognised({ classification: 'face-or-person', brand: '', name: '', variant: '', form: 'unknown', category: 'other', confidence: 0 })
/** What the recognizer answers for a shelf photo: the products it lists, most confident first, and how many it left out. */
const shelfProducts = (products: [brand: string, name: string][], excluded = { otherProducts: 0, unreadable: 0 }) =>
  recognised({
    classification: 'beauty-product',
    products: products.map(([brand, name], i) => ({ brand, name, variant: '', form: 'unknown', category: 'skin', confidence: 0.95 - i * 0.05 })),
    excluded,
  })
const shelfFace = recognised({ classification: 'face-or-person', products: [], excluded: { otherProducts: 0, unreadable: 0 } })
const unreadable = recognised({ classification: 'unreadable', brand: '', name: '', variant: '', form: 'unknown', category: 'other', confidence: 0 })

/** POST .../retake through the Worker's own entrypoint, with its queue replaced by the quiet one (the real queue would deliver the recognise into another test). */
const postRetake = async (guest: Guest, scanId: string, itemId: string) => {
  const form = new FormData()
  form.append('photo', new File([markedJpeg(21).bytes], 'retake.jpg', { type: 'image/jpeg' }))
  return worker.fetch!(
    new Request(`${ORIGIN}/api/v1/scans/products/${scanId}/items/${itemId}/retake`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${guest.token}`, 'cf-connecting-ip': freshIp() } }) as never,
    testEnv,
    createExecutionContext(),
  )
}

/** POST .../no-label through the Worker's own entrypoint, with its queue replaced by the quiet one. */
const postNoLabel = async (guest: Guest, scanId: string, itemId: string, body: Record<string, unknown>) =>
  worker.fetch!(
    new Request(`${ORIGIN}/api/v1/scans/products/${scanId}/items/${itemId}/no-label`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${guest.token}`, 'cf-connecting-ip': freshIp(), 'Content-Type': 'application/json' },
    }) as never,
    testEnv,
    createExecutionContext(),
  )

/** A one-photo scan whose front photo could not be read three times, so its item offers identification. */
const startOfferingIdentification = async (guest: Guest) => {
  const { scanId, itemIds } = await startScan(guest)
  const itemId = itemIds[0]!
  stubAnthropic(unreadable)
  await step(itemId, 'recognise')
  for (let i = 0; i < 2; i++) {
    expect((await postRetake(guest, scanId, itemId)).status).toBe(202)
    await step(itemId, 'recognise')
  }
  vi.unstubAllGlobals()
  expect((await getScan(scanId, guest.token)).items[0]!.state).toBe('needs-identification')
  return { scanId, itemId }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(opened.splice(0).map((stream) => stream.cancel()))
  await abortAllDurableObjects()
})

describe('GET /api/v1/scans/products/{scanId}/events: opening the stream', () => {
  it('answers 200 as an event stream that no proxy buffers or rewrites', async () => {
    const guest = await newGuest()
    const { scanId } = await startScan(guest)

    const { res } = await watch(scanId, guest.token)

    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform')
    expect(res.headers.get('X-Accel-Buffering')).toBe('no')
  })

  it('starts with a snapshot of the scan as it is now', async () => {
    const guest = await newGuest()
    const { scanId, itemIds } = await startScan(guest, [markedJpeg(1), markedJpeg(2)])
    const { stream } = await watch(scanId, guest.token)

    const { frames } = await stream.read(1)

    const frame = parseFrame(frames[0]!)
    expect(frame.event).toBe('snapshot')
    expect(frame.data).toMatchObject({
      id: scanId,
      items: [
        { id: itemIds[0], position: 0, state: 'recognising', reason: null },
        { id: itemIds[1], position: 1, state: 'recognising', reason: null },
      ],
    })
  })

  it('makes the snapshot the same scan GET /api/v1/scans/products/{scanId} returns', async () => {
    const guest = await newGuest()
    const { scanId } = await startScan(guest, [markedJpeg(1), markedJpeg(2)])
    const { stream } = await watch(scanId, guest.token)

    const { frames } = await stream.read(1)

    // Each view mints its own signed photo link (its expiry is to the millisecond), so compare everything else.
    const withoutLinks = (scan: { items: { image?: unknown }[] }) => ({ ...scan, items: scan.items.map(({ image: _image, ...item }) => item) })
    expect(withoutLinks(parseFrame(frames[0]!).data as never)).toEqual(withoutLinks((await getScan(scanId, guest.token)) as never))
  })
})

describe('GET /api/v1/scans/products/{scanId}/events: who may watch', () => {
  it('answers 404 SCAN_NOT_FOUND, as a normal error and not a stream, to another user', async () => {
    const owner = await newGuest()
    const stranger = await newGuest()
    const { scanId } = await startScan(owner)

    const res = await events(scanId, stranger.token)

    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ success: false, status: 404, error: { code: 'SCAN_NOT_FOUND' } })
  })

  it('answers 404 SCAN_NOT_FOUND for a scan that does not exist', async () => {
    const guest = await newGuest()

    const res = await events(crypto.randomUUID(), guest.token)

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ success: false, error: { code: 'SCAN_NOT_FOUND' } })
  })

  it('answers 401 AUTH_REQUIRED without a token', async () => {
    const guest = await newGuest()
    const { scanId } = await startScan(guest)

    const res = await events(scanId)

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ success: false, status: 401, error: { code: 'AUTH_REQUIRED' } })
  })
})

describe('GET /api/v1/scans/products/{scanId}/events: live updates from the background steps', () => {
  it('sends each item change as an item event in the order it happened, then done, then ends the stream', async () => {
    const brand = freshBrand()
    await catalogued(brand, 'Hydrating Cleanser')
    const guest = await newGuest()
    const { scanId, itemIds } = await startScan(guest, [markedJpeg(1), markedJpeg(2)])
    const [personItem, productItem] = itemIds as [string, string]
    const { stream } = await watch(scanId, guest.token)
    expect(parseFrame((await stream.read(1)).frames[0]!).event).toBe('snapshot')
    // Anthropic answers the first recognise call with a face and the second with the product.
    stubAnthropic(face, beautyProduct(brand, 'Hydrating Cleanser'))

    expect(await step(personItem, 'recognise')).toEqual(['m'])
    expect(await step(productItem, 'recognise')).toEqual(['m'])
    expect(await step(productItem, 'match')).toEqual(['m'])

    const { frames } = await stream.read(4)
    const parsed = frames.map(parseFrame)
    expect(parsed.map((frame) => frame.event)).toEqual(['item', 'item', 'item', 'done'])
    expect(parsed.slice(0, 3).map((frame) => frame.data)).toMatchObject([
      { id: personItem, state: 'rejected', reason: 'face-or-person' },
      { id: productItem, state: 'matching' },
      { id: productItem, state: 'ready' },
    ])
    expect(await stream.read(1)).toEqual({ frames: [], ended: true })
    // A scan carries who the product is and nothing of its ingredients, concerns or reference data.
    const ready = parsed[2]!.data as { product: Record<string, unknown> }
    expect(Object.keys(ready.product).sort()).toEqual(['brand', 'category', 'form', 'id', 'imageUrl', 'kind', 'name', 'variant'])
    expect(ready.product).toMatchObject({ brand })
  })

  it('sends an item exactly as GET /api/v1/scans/products/{scanId} shows it', async () => {
    const guest = await newGuest()
    const { scanId, itemIds } = await startScan(guest)
    const { stream } = await watch(scanId, guest.token)
    await stream.read(1)
    stubAnthropic(face)

    await step(itemIds[0]!, 'recognise')

    const sent = parseFrame((await stream.read(1)).frames[0]!).data
    const shown = (await getScan(scanId, guest.token)).items[0]
    expect(sent).toEqual(shown)
  })

  it('shows a client that connects mid-scan the current state, and carries on from there', async () => {
    const brand = freshBrand()
    await catalogued(brand, 'Hydrating Cleanser')
    const guest = await newGuest()
    const { scanId, itemIds } = await startScan(guest)
    const itemId = itemIds[0]!
    const first = await watch(scanId, guest.token)
    expect(parseFrame((await first.stream.read(1)).frames[0]!).data).toMatchObject({ items: [{ id: itemId, state: 'recognising' }] })
    stubAnthropic(beautyProduct(brand, 'Hydrating Cleanser'))
    await step(itemId, 'recognise')
    expect(parseFrame((await first.stream.read(1)).frames[0]!).data).toMatchObject({ id: itemId, state: 'matching' })
    await first.stream.cancel() // the connection drops

    const second = await watch(scanId, guest.token)
    const snapshot = parseFrame((await second.stream.read(1)).frames[0]!)
    await step(itemId, 'match')

    expect(snapshot.event).toBe('snapshot')
    expect(snapshot.data).toMatchObject({ id: scanId, items: [{ id: itemId, state: 'matching' }] })
    const { frames } = await second.stream.read(2)
    expect(frames.map((frame) => parseFrame(frame).event)).toEqual(['item', 'done'])
    expect(parseFrame(frames[0]!).data).toMatchObject({ id: itemId, state: 'ready' })
  })

  it('shows a ready item\'s product in the snapshot as the product\'s identity only', async () => {
    const brand = freshBrand()
    await catalogued(brand, 'Hydrating Cleanser')
    const guest = await newGuest()
    const { scanId, itemIds } = await startScan(guest)
    const itemId = itemIds[0]!
    stubAnthropic(beautyProduct(brand, 'Hydrating Cleanser'))
    await step(itemId, 'recognise')
    await step(itemId, 'match')

    const { stream } = await watch(scanId, guest.token)
    const snapshot = parseFrame((await stream.read(1)).frames[0]!)

    const item = (snapshot.data as { items: { product: Record<string, unknown> }[] }).items[0]!
    expect(Object.keys(item.product).sort()).toEqual(['brand', 'category', 'form', 'id', 'imageUrl', 'kind', 'name', 'variant'])
    expect(item.product).toMatchObject({ brand })
  })

  it('sends the same events to every client watching the scan', async () => {
    const guest = await newGuest()
    const { scanId, itemIds } = await startScan(guest)
    const phone = await watch(scanId, guest.token)
    const tablet = await watch(scanId, guest.token)
    await phone.stream.read(1)
    await tablet.stream.read(1)
    stubAnthropic(face)

    await step(itemIds[0]!, 'recognise')

    for (const { stream } of [phone, tablet]) {
      // Ask for one more frame than is sent, so the reader runs on to the end of the stream.
      const { frames, ended } = await stream.read(3)
      expect(frames.map((frame) => parseFrame(frame).event)).toEqual(['item', 'done'])
      expect(ended).toBe(true)
    }
  })

  it('does not show one scan\'s events on another scan\'s stream', async () => {
    const guest = await newGuest()
    const watched = await startScan(guest)
    const busy = await startScan(guest)
    const { stream } = await watch(watched.scanId, guest.token)
    await stream.read(1)
    stubAnthropic(face)

    await step(busy.itemIds[0]!, 'recognise')

    expect(await stream.read(1, 300)).toEqual({ frames: [], ended: false })
  })
})

describe('GET /api/v1/scans/products/{scanId}/events: a photo that has to be taken again', () => {
  it('sends the item as needs-retake, exactly as GET shows it, then as recognising when it is retaken, and no done in between', async () => {
    const guest = await newGuest()
    const { scanId, itemIds } = await startScan(guest)
    const itemId = itemIds[0]!
    const { stream } = await watch(scanId, guest.token)
    expect(parseFrame((await stream.read(1)).frames[0]!).event).toBe('snapshot')
    stubAnthropic(unreadable)

    await step(itemId, 'recognise')

    const asking = parseFrame((await stream.read(1)).frames[0]!)
    expect(asking.event).toBe('item')
    expect(asking.data).toMatchObject({ id: itemId, state: 'needs-retake', reason: 'unreadable', retakesLeft: 2 })
    expect(asking.data).toEqual((await getScan(scanId, guest.token)).items[0])

    const res = await postRetake(guest, scanId, itemId)

    expect(res.status).toBe(202)
    const again = parseFrame((await stream.read(1)).frames[0]!)
    expect(again.event).toBe('item')
    expect(again.data).toMatchObject({ id: itemId, state: 'recognising', reason: null })
    expect(again.data).not.toHaveProperty('retakesLeft')
    expect(await stream.read(1, 300)).toEqual({ frames: [], ended: false })
  })

  it('shows a client that connects while the item asks for a retake the item as needs-retake in the snapshot, and no done', async () => {
    const guest = await newGuest()
    const { scanId, itemIds } = await startScan(guest)
    stubAnthropic(unreadable)
    await step(itemIds[0]!, 'recognise')

    const { stream } = await watch(scanId, guest.token)

    const first = parseFrame((await stream.read(1)).frames[0]!)
    expect(first.event).toBe('snapshot')
    expect(first.data).toMatchObject({ id: scanId, items: [{ id: itemIds[0], state: 'needs-retake', reason: 'unreadable', retakesLeft: 2 }] })
    expect(await stream.read(1, 300)).toEqual({ frames: [], ended: false })
  })
})

describe('GET /api/v1/scans/products/{scanId}/events: an item with no label', () => {
  it('sends the item as unidentified with its noLabel block, exactly as GET shows it, then done, then ends the stream', async () => {
    const guest = await newGuest()
    const { scanId, itemId } = await startOfferingIdentification(guest)
    const { stream } = await watch(scanId, guest.token)
    const snapshot = parseFrame((await stream.read(1)).frames[0]!)
    expect(snapshot.event).toBe('snapshot')
    expect(snapshot.data).toMatchObject({ items: [{ id: itemId, state: 'needs-identification' }] })

    const res = await postNoLabel(guest, scanId, itemId, { source: 'market-vendor', purpose: 'lighten', usedFor: 'over-2-years', description: 'A pink tub' })

    expect(res.status).toBe(202)
    const { frames } = await stream.read(2)
    const parsed = frames.map(parseFrame)
    expect(parsed.map((frame) => frame.event)).toEqual(['item', 'done'])
    expect(parsed[0]!.data).toMatchObject({
      id: itemId,
      state: 'unidentified',
      reason: null,
      image: null,
      noLabel: { source: 'market-vendor', purpose: 'lighten', usedFor: 'over-2-years', description: 'A pink tub', rulesVersion: 1 },
    })
    expect(parsed[0]!.data).toEqual((await getScan(scanId, guest.token)).items[0])
    expect(await stream.read(1)).toEqual({ frames: [], ended: true })
  })

  it('shows a client that connects after it the item as unidentified in the snapshot, then done, and ends the stream at once', async () => {
    const guest = await newGuest()
    const { scanId, itemId } = await startOfferingIdentification(guest)
    expect((await postNoLabel(guest, scanId, itemId, { source: 'gift', purpose: 'moisturise', usedFor: 'under-1-month' })).status).toBe(202)

    const { stream } = await watch(scanId, guest.token)

    const { frames, ended } = await stream.read(3)
    const parsed = frames.map(parseFrame)
    expect(parsed.map((frame) => frame.event)).toEqual(['snapshot', 'done'])
    expect(parsed[0]!.data).toMatchObject({ id: scanId, items: [{ id: itemId, state: 'unidentified', noLabel: { source: 'gift', purpose: 'moisturise', usedFor: 'under-1-month' } }] })
    expect(ended).toBe(true)
  })
})

describe('buildContainer scan events', () => {
  // The container is what the Worker and its queue handler are built from. Subscribing to the scan's Durable Object
  // directly (no route) and advancing an item through buildContainer(env).scans shows the service publishes through
  // the Durable Object and not through a no-op.
  it('pushes an item change made by the container\'s scan service to a stream open on the scan', async () => {
    const guest = await newGuest()
    const { scanId, itemIds } = await startScan(guest)
    const itemId = itemIds[0]!
    const res = await env.SCAN_STREAM.get(env.SCAN_STREAM.idFromName(scanId)).fetch(
      new Request('https://scan-stream/subscribe', { method: 'POST', body: JSON.stringify({ id: scanId }) }),
    )
    const stream = sseReader(res)
    opened.push(stream)
    await stream.read(1)
    stubAnthropic(face)

    await runAs({ kind: 'system', job: advanceScanItemSpec.name }, () => buildContainer(env).scans.advance(itemId, 'recognise'))

    const { frames } = await stream.read(2)
    expect(frames.map(parseFrame)).toMatchObject([{ event: 'item', data: { id: itemId, state: 'rejected' } }, { event: 'done' }])
  })
})

describe('GET /api/v1/scans/products/{scanId}/events: a scan that is already finished', () => {
  it('sends the snapshot, then done, and ends the stream at once', async () => {
    const guest = await newGuest()
    const { scanId, itemIds } = await startScan(guest)
    stubAnthropic(face)
    await runAs({ kind: 'system', job: advanceScanItemSpec.name }, () => buildContainer(testEnv).scans.advance(itemIds[0]!, 'recognise'))
    const { stream } = await watch(scanId, guest.token)

    const { frames, ended } = await stream.read(3)

    const parsed = frames.map(parseFrame)
    expect(parsed.map((frame) => frame.event)).toEqual(['snapshot', 'done'])
    expect(parsed[0]!.data).toMatchObject({ id: scanId, items: [{ id: itemIds[0], state: 'rejected', reason: 'face-or-person' }] })
    expect(parsed[1]!.data).toEqual({})
    expect(ended).toBe(true)
  })
})


describe('GET /api/v1/scans/products/{scanId}/events: a shelf scan', () => {
  it('starts with a snapshot of kind shelf, with its photos and the photo of each item, exactly as GET shows the scan', async () => {
    const guest = await newGuest()
    const { scanId } = await startShelf(guest, [markedJpeg(1), markedJpeg(2)])
    const { stream } = await watch(scanId, guest.token)

    const frame = parseFrame((await stream.read(1)).frames[0]!)

    const shown = await getScan(scanId, guest.token)
    expect(frame.event).toBe('snapshot')
    expect(shown.kind).toBe('shelf')
    expect(shown.photos.map((p) => [p.position, p.state])).toEqual([[0, 'recognising'], [1, 'recognising']])
    // Each view mints its own signed photo link, so the links are left out of the comparison.
    const withoutLinks = (scan: { items: { image?: unknown }[] }) => ({ ...scan, items: scan.items.map(({ image: _image, ...item }) => item) })
    expect(withoutLinks(frame.data as never)).toEqual(withoutLinks(shown as never))
  })

  it('sends the photo, then the items read from it, then the later steps and done, each under its own event name', async () => {
    const [brand, other] = [freshBrand(), freshBrand()]
    await catalogued(brand, 'Hydrating Cleanser')
    await catalogued(other, 'Bright Serum')
    const guest = await newGuest()
    const { scanId, itemIds } = await startShelf(guest)
    const { stream } = await watch(scanId, guest.token)
    expect(parseFrame((await stream.read(1)).frames[0]!).event).toBe('snapshot')
    stubAnthropic(shelfProducts([[brand, 'Hydrating Cleanser'], [other, 'Bright Serum']], { otherProducts: 1, unreadable: 0 }))

    expect(await step(itemIds[0]!, 'recognise')).toEqual(['m'])
    const shown = await getScan(scanId, guest.token)
    expect(shown.items).toHaveLength(2)
    for (const item of shown.items) expect(await step(item.id, 'match')).toEqual(['m'])

    const { frames } = await stream.read(7)
    const parsed = frames.map(parseFrame)
    expect(parsed.map((frame) => frame.event)).toEqual(['photo', 'item', 'item', 'item', 'item', 'done'])
    const photo = shown.photos[0]!
    expect(parsed[0]!.data).toEqual({ id: photo.id, position: 0, state: 'recognised', skipped: { notBeauty: 1, unreadable: 0, overLimit: 0, dailyLimit: 0 } })
    expect(parsed.slice(1, 3).map((frame) => (frame.data as { photoId: string }).photoId)).toEqual([photo.id, photo.id])
    expect(parsed.slice(1, 5).map((frame) => (frame.data as { state: string }).state)).toEqual(['matching', 'matching', 'ready', 'ready'])
    expect(await stream.read(1)).toEqual({ frames: [], ended: true })
  })

  it('sends the photo exactly as GET /api/v1/scans/products/{scanId} shows it, and each item with its photoId as GET shows it', async () => {
    const guest = await newGuest()
    const { scanId, itemIds } = await startShelf(guest)
    const { stream } = await watch(scanId, guest.token)
    await stream.read(1)
    stubAnthropic(shelfProducts([[freshBrand(), 'Plain Soap']]))

    await step(itemIds[0]!, 'recognise')

    const parsed = (await stream.read(2)).frames.map(parseFrame)
    const shown = await getScan(scanId, guest.token)
    expect(parsed.map((frame) => frame.event)).toEqual(['photo', 'item'])
    expect(parsed[0]!.data).toEqual(shown.photos[0])
    expect(parsed[1]!.data).toEqual(shown.items[0])
  })

  it('sends a shelf photo with nothing readable as a rejected photo, then its item, then done', async () => {
    const guest = await newGuest()
    const { scanId, itemIds } = await startShelf(guest)
    const { stream } = await watch(scanId, guest.token)
    await stream.read(1)
    stubAnthropic(shelfFace)

    await step(itemIds[0]!, 'recognise')

    const { frames } = await stream.read(3)
    const parsed = frames.map(parseFrame)
    expect(parsed.map((frame) => frame.event)).toEqual(['photo', 'item', 'done'])
    expect(parsed[0]!.data).toMatchObject({ position: 0, state: 'rejected' })
    expect(parsed[1]!.data).toMatchObject({ id: itemIds[0], state: 'rejected', reason: 'face-or-person' })
    expect(await stream.read(1)).toEqual({ frames: [], ended: true })
  })

  it('shows a client that connects after the photo was read the recognised photo in the snapshot, with no photo frame to follow', async () => {
    const brand = freshBrand()
    await catalogued(brand, 'Hydrating Cleanser')
    const guest = await newGuest()
    const { scanId, itemIds } = await startShelf(guest)
    stubAnthropic(shelfProducts([[brand, 'Hydrating Cleanser']]))
    await step(itemIds[0]!, 'recognise')
    const { stream } = await watch(scanId, guest.token)
    const snapshot = parseFrame((await stream.read(1)).frames[0]!)
    expect(snapshot.data).toMatchObject({ kind: 'shelf', photos: [{ position: 0, state: 'recognised' }], items: [{ id: itemIds[0], state: 'matching' }] })

    await step(itemIds[0]!, 'match')

    expect((await stream.read(2)).frames.map((frame) => parseFrame(frame).event)).toEqual(['item', 'done'])
  })
})

describe('GET /api/v1/scans/products/{scanId}/events: a product scan and its photos', () => {
  it('starts with kind product and one photo per item, and sends no photo frame as the items are read', async () => {
    const brand = freshBrand()
    await catalogued(brand, 'Hydrating Cleanser')
    const guest = await newGuest()
    const { scanId, itemIds } = await startScan(guest)
    const { stream } = await watch(scanId, guest.token)
    const snapshot = parseFrame((await stream.read(1)).frames[0]!)
    stubAnthropic(beautyProduct(brand, 'Hydrating Cleanser'))

    await step(itemIds[0]!, 'recognise')
    await step(itemIds[0]!, 'match')

    const shown = await getScan(scanId, guest.token)
    expect(snapshot.data).toEqual(expect.objectContaining({ kind: 'product', photos: [expect.objectContaining({ position: 0 })] }))
    expect(shown.items[0]!.photoId).toBe(shown.photos[0]!.id)
    expect((await stream.read(3)).frames.map((frame) => parseFrame(frame).event)).toEqual(['item', 'item', 'done'])
  })
})
