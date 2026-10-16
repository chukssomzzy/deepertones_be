import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { buildContainer } from '../../src/container'
import { jobs } from '../../src/jobs/registry'
import { runAs } from '../../src/lib/context'
import { createDb } from '../../src/lib/db'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { jpegPhoto } from '../../src/modules/scans/scans.photos.fake'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { json, messageResponse, stubFetch, textBlock } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'

// The scan's background steps, driven through the Worker's real queue handler against local D1 and R2, with only the
// outbound Anthropic call stubbed at fetch. Each queue message is built by hand ({ itemId, step, at }): the producer is the
// real queue binding, whose messages a test cannot read back.
const MAIN = 'deepertones-scan-items-development'
const DEAD_LETTER = 'deepertones-scan-items-dlq-development'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const SOURCE_URL = 'https://shop.example/product'
const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
const SCAN_IP = '203.0.113.50'
// Every message carries the time the item entered the state its step works on, which keys the run; a hand-built one needs
// only to be the same for the same delivery (the real value is the item's updatedAt, as ScanService stamps it).
const AT = 1_900_000_000_000

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// The database is shared by the whole file, so every product and user gets a name no other test has.
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
const freshBrand = () => `Brand${runSalt}x${counter++}`

const users = new D1UsersRepository(createDb(env.DB))
const guest = async () => {
  const id = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id, createdAt: new Date() }, device: { deviceHash: `scans-bg-${id}`, platform: 'ios' } })
  return id
}

const container = buildContainer(env)
const asUser = <T>(userId: string, fn: () => Promise<T>) => runAs({ kind: 'user', userId, status: 'anonymous' }, fn)

/** A one-photo scan, made through the real service (so the photo is in the real bucket and the rows are in D1). */
const startScan = async () => {
  const userId = await guest()
  const photo = jpegPhoto()
  const scan = await asUser(userId, () => container.scans.create({ photos: [photo], clientIp: SCAN_IP }))
  const itemId = scan.items[0]!.id
  return { userId, photo, scanId: scan.id, itemId, key: `photos/${env.ENVIRONMENT}/${userId}/${scan.id}/${itemId}.jpg` }
}
const itemOf = async (userId: string, scanId: string, itemId: string) => {
  const scan = await asUser(userId, () => container.scans.getScan(scanId))
  return scan.items.find((i) => i.id === itemId)!
}

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
  return found.formulationId
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

const runQueue = async (queue: string, body: unknown, attempts = 1) => {
  const batch = createMessageBatch(queue, [{ id: 'm', timestamp: new Date(), attempts, body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, env, ctx)
  return getQueueResult(batch, ctx)
}

const base64Of = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

describe('the job registry the Worker runs', () => {
  it('includes the job that advances scan items', () => {
    expect(jobs.map((job) => job.name)).toContain('advance-scan-item')
  })
})

describe('scan items advanced through the Worker queue handler', () => {
  it('takes a photo of a product the catalog already holds to ready, with one vision call on the stored photo and nothing else', async () => {
    const brand = freshBrand()
    const formulationId = await catalogued(brand, 'Hydrating Cleanser')
    const { userId, photo, scanId, itemId } = await startScan()
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'recognising' })
    const calls = stubAnthropic(beautyProduct(brand, 'Hydrating Cleanser'))

    const recognise = await runQueue(MAIN, { itemId, step: 'recognise', at: AT })

    expect(recognise.explicitAcks).toEqual(['m'])
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'matching' })
    const match = await runQueue(MAIN, { itemId, step: 'match', at: AT })

    expect(match.explicitAcks).toEqual(['m'])
    const item = await itemOf(userId, scanId, itemId)
    expect(item).toMatchObject({ state: 'ready', reason: null, image: { kind: 'user' }, product: { formulation: { id: formulationId }, product: { brand } } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(ANTHROPIC_URL)
    expect(calls[0]!.body.messages[0].content[0].source.data).toBe(base64Of(photo.bytes))
  })

  it('acks a repeated delivery of a finished step without calling Anthropic again', async () => {
    const brand = freshBrand()
    await catalogued(brand, 'Hydrating Cleanser')
    const { userId, scanId, itemId } = await startScan()
    const calls = stubAnthropic(beautyProduct(brand, 'Hydrating Cleanser'))
    await runQueue(MAIN, { itemId, step: 'recognise', at: AT })

    const again = await runQueue(MAIN, { itemId, step: 'recognise', at: AT }, 2)

    expect(again.explicitAcks).toEqual(['m'])
    expect(calls).toHaveLength(1)
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'matching' })
  })

  it('rejects a photo of a person and deletes it from the private bucket at once', async () => {
    const { userId, scanId, itemId, key } = await startScan()
    expect(await env.PRIVATE_PHOTOS.get(key)).not.toBeNull()
    stubAnthropic(face)

    const result = await runQueue(MAIN, { itemId, step: 'recognise', at: AT })

    expect(result.explicitAcks).toEqual(['m'])
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'rejected', reason: 'face-or-person', image: null })
    expect(await env.PRIVATE_PHOTOS.get(key)).toBeNull()
  })

  it('marks the item failed as unavailable when its message reaches the dead-letter queue, without calling Anthropic', async () => {
    const { userId, scanId, itemId } = await startScan()
    const calls = stubAnthropic(face)

    const result = await runQueue(DEAD_LETTER, { itemId, step: 'recognise', at: AT }, 5)

    expect(result.explicitAcks).toEqual(['m'])
    expect(calls).toHaveLength(0)
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'failed', reason: 'unavailable' })
  })

  it('keeps a finished item as it was when a dead letter arrives for it', async () => {
    const { userId, scanId, itemId } = await startScan()
    stubAnthropic(face)
    await runQueue(MAIN, { itemId, step: 'recognise', at: AT })

    const result = await runQueue(DEAD_LETTER, { itemId, step: 'recognise', at: AT }, 5)

    expect(result.explicitAcks).toEqual(['m'])
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'rejected', reason: 'face-or-person' })
  })

  it('retries, leaving the item recognising, when Anthropic is unavailable', async () => {
    const { userId, scanId, itemId } = await startScan()
    stubAnthropic(() => json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 529))

    const result = await runQueue(MAIN, { itemId, step: 'recognise', at: AT })

    expect(result.retryMessages).toEqual([{ msgId: 'm' }])
    expect(result.explicitAcks).toEqual([])
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'recognising' })
  })

  it('rejects a photo the model refuses as unreadable and deletes it, acking the message', async () => {
    const { userId, scanId, itemId, key } = await startScan()
    stubAnthropic(() => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' }))

    const result = await runQueue(MAIN, { itemId, step: 'recognise', at: AT })

    expect(result.explicitAcks).toEqual(['m'])
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'rejected', reason: 'unreadable', image: null })
    expect(await env.PRIVATE_PHOTOS.get(key)).toBeNull()
  })

  it('fails the item as unavailable and acks without a retry when the model\'s answer cannot be used, so the photo is not paid for again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { userId, scanId, itemId } = await startScan()
    const calls = stubAnthropic(() => messageResponse({ content: [textBlock('this is not JSON')] }))

    const result = await runQueue(MAIN, { itemId, step: 'recognise', at: AT })

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(calls).toHaveLength(1)
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'failed', reason: 'unavailable' })
  })

  it('acks the reaper\'s re-send of a step that already ran, because it carries the same key, and calls nothing', async () => {
    const { userId, scanId, itemId } = await startScan()
    const calls = stubAnthropic(face)
    await runQueue(MAIN, { itemId, step: 'recognise', at: AT })

    const resent = await runQueue(MAIN, { itemId, step: 'recognise', at: AT })

    expect(resent.explicitAcks).toEqual(['m'])
    expect(calls).toHaveLength(1)
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'rejected' })
  })
})
