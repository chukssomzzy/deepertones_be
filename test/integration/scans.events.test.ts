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

// GET /scans/{scanId}/events through the real Worker: bearer auth, the ownership check, the snapshot, and the live
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
const freshBrand = () => `EventsBrand${runSalt}x${counter++}`
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
  await users.createGuestForDevice({ user: { id, createdAt: new Date() }, device: { deviceHash: `scans-events-${id}`, platform: 'ios' } })
  const { accessToken } = await tokens.issue({ id, status: 'anonymous', tokenVersion: 0 })
  return { userId: id, token: accessToken }
}
type Guest = Awaited<ReturnType<typeof newGuest>>

/** A scan of the given photos, made through the service for this guest, with its items' ids in photo order. */
const startScan = async (guest: Guest, photos = [jpegPhoto()]) => {
  const scan = await runAs({ kind: 'user', userId: guest.userId, status: 'anonymous' }, () => container.scans.create({ photos, clientIp: freshIp() }))
  return { scanId: scan.id as string, itemIds: scan.items.map((item: { id: string }) => item.id) as string[] }
}

const events = (scanId: string, token?: string) =>
  exports.default.fetch(new Request(`${ORIGIN}/scans/${scanId}/events`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }))
const getScan = async (scanId: string, token: string) => {
  const res = await exports.default.fetch(new Request(`${ORIGIN}/scans/${scanId}`, { headers: { Authorization: `Bearer ${token}` } }))
  const body = (await res.json()) as { success: true; data: { id: string; items: { id: string; state: string }[] } }
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
const step = (itemId: string, name: 'recognise' | 'match') => runQueue({ itemId, step: name, at: Date.now() })

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
  recognised({ classification: 'beauty-product', brand, name, variant: '', category: 'skin', confidence: 0.92 })
const face = recognised({ classification: 'face-or-person', brand: '', name: '', variant: '', category: 'other', confidence: 0 })

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(opened.splice(0).map((stream) => stream.cancel()))
  await abortAllDurableObjects()
})

describe('GET /scans/{scanId}/events: opening the stream', () => {
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

  it('makes the snapshot the same scan GET /scans/{scanId} returns', async () => {
    const guest = await newGuest()
    const { scanId } = await startScan(guest, [markedJpeg(1), markedJpeg(2)])
    const { stream } = await watch(scanId, guest.token)

    const { frames } = await stream.read(1)

    // Each view mints its own signed photo link (its expiry is to the millisecond), so compare everything else.
    const withoutLinks = (scan: { items: { image?: unknown }[] }) => ({ ...scan, items: scan.items.map(({ image: _image, ...item }) => item) })
    expect(withoutLinks(parseFrame(frames[0]!).data as never)).toEqual(withoutLinks((await getScan(scanId, guest.token)) as never))
  })
})

describe('GET /scans/{scanId}/events: who may watch', () => {
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

describe('GET /scans/{scanId}/events: live updates from the background steps', () => {
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
  })

  it('sends an item exactly as GET /scans/{scanId} shows it', async () => {
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

describe('GET /scans/{scanId}/events: a scan that is already finished', () => {
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

