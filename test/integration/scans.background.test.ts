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
// The retakes come from an address of their own, so they are counted apart from the scans' in the per-address daily quota.
const RETAKE_IP = '203.0.113.51'
// The back photos too.
const BACK_IP = '203.0.113.52'
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
  await users.createGuestForDevice({ user: { id, createdAt: new Date() }, device: { deviceHash: `scans-bg-${id}`, platform: 'ios' }, profile: { id: `profile-${id}` } })
  return id
}

// Steps are driven by hand below. The real local queue would deliver the service's own follow-on messages a moment
// later, into whichever test is running then (with its fetch stub), so this file's Worker queues into nothing.
const quietQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
const testEnv = { ...env, SCAN_ITEMS_QUEUE: quietQueue }
const container = buildContainer(testEnv)
const asUser = <T>(userId: string, fn: () => Promise<T>) => runAs({ kind: 'user', userId, status: 'anonymous', profileId: `profile-${userId}` }, fn)

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
const unreadable = recognised({ classification: 'unreadable', brand: '', name: '', variant: '', category: 'other', confidence: 0 })
const labelNotVisible = recognised({ classification: 'label-not-visible', brand: '', name: '', variant: '', category: 'other', confidence: 0 })

const runQueue = async (queue: string, body: unknown, attempts = 1) => {
  const batch = createMessageBatch(queue, [{ id: 'm', timestamp: new Date(), attempts, body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, testEnv, ctx)
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

  it('asks for a retake of a photo the model refuses to look at, as unreadable, and deletes it, acking the message', async () => {
    const { userId, scanId, itemId, key } = await startScan()
    stubAnthropic(() => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' }))

    const result = await runQueue(MAIN, { itemId, step: 'recognise', at: AT })

    expect(result.explicitAcks).toEqual(['m'])
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'needs-retake', reason: 'unreadable', retakesLeft: 2, image: null })
    expect(await env.PRIVATE_PHOTOS.get(key)).toBeNull()
  })

  it.each([
    ['unreadable', unreadable],
    ['label-not-visible', labelNotVisible],
  ])('asks for a retake of a photo the model classes as %s, deleting it at once and acking the message', async (reason, answer) => {
    const { userId, scanId, itemId, key } = await startScan()
    expect(await env.PRIVATE_PHOTOS.get(key)).not.toBeNull()
    stubAnthropic(answer)

    const result = await runQueue(MAIN, { itemId, step: 'recognise', at: AT })

    expect(result.explicitAcks).toEqual(['m'])
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'needs-retake', reason, retakesLeft: 2, image: null })
    expect(await env.PRIVATE_PHOTOS.get(key)).toBeNull()
  })

  it('takes an item through three unreadable photos, counted in D1, to needs-identification: the retaken photo is stored, read and deleted each time', async () => {
    const { userId, scanId, itemId, key } = await startScan()
    stubAnthropic(unreadable, labelNotVisible, unreadable)
    await runQueue(MAIN, { itemId, step: 'recognise', at: AT })
    expect(await itemOf(userId, scanId, itemId)).toMatchObject({ state: 'needs-retake', reason: 'unreadable', retakesLeft: 2 })

    for (const [n, expected] of [
      [1, { state: 'needs-retake', reason: 'label-not-visible', retakesLeft: 1 }],
      [2, { state: 'needs-identification', reason: 'unreadable' }],
    ] as const) {
      const retaken = await asUser(userId, () => container.scans.retake(scanId, itemId, jpegPhoto(), RETAKE_IP))
      expect(retaken).toMatchObject({ state: 'recognising', reason: null })
      expect(await env.PRIVATE_PHOTOS.get(key)).not.toBeNull()

      await runQueue(MAIN, { itemId, step: 'recognise', at: AT + n })

      expect(await itemOf(userId, scanId, itemId)).toMatchObject({ ...expected, image: null })
      expect(await env.PRIVATE_PHOTOS.get(key)).toBeNull()
    }
    expect(await itemOf(userId, scanId, itemId)).not.toHaveProperty('retakesLeft')
  })

  it('leaves an item asking for a retake or for identification as it was when a dead letter arrives for it', async () => {
    const asking = await startScan()
    stubAnthropic(unreadable)
    await runQueue(MAIN, { itemId: asking.itemId, step: 'recognise', at: AT })

    const dead = await runQueue(DEAD_LETTER, { itemId: asking.itemId, step: 'recognise', at: AT }, 5)

    expect(dead.explicitAcks).toEqual(['m'])
    expect(await itemOf(asking.userId, asking.scanId, asking.itemId)).toMatchObject({ state: 'needs-retake', reason: 'unreadable' })

    const identifying = await startScan()
    stubAnthropic(unreadable)
    await runQueue(MAIN, { itemId: identifying.itemId, step: 'recognise', at: AT })
    for (const n of [1, 2]) {
      await asUser(identifying.userId, () => container.scans.retake(identifying.scanId, identifying.itemId, jpegPhoto(), RETAKE_IP))
      await runQueue(MAIN, { itemId: identifying.itemId, step: 'recognise', at: AT + n })
    }
    const deadAgain = await runQueue(DEAD_LETTER, { itemId: identifying.itemId, step: 'recognise', at: AT + 2 }, 5)

    expect(deadAgain.explicitAcks).toEqual(['m'])
    expect(await itemOf(identifying.userId, identifying.scanId, identifying.itemId)).toMatchObject({ state: 'needs-identification', reason: 'unreadable' })
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

// --- a back photo that identifies the product ---

// These flows make many calls, so their answers report a small usage and no web search: the day's AI spend cap (a dollar here) is not what they test.
const CHEAP_USAGE = { input_tokens: 100, output_tokens: 50 }
const readLabel = (answer: Record<string, unknown>) => () => messageResponse({ content: [textBlock(JSON.stringify(answer))], usage: CHEAP_USAGE })
const cheapUnreadable = readLabel({ classification: 'unreadable', brand: '', name: '', variant: '', category: 'other', confidence: 0 })
const noConcerns = readLabel({ concerns: [] })
const unreadableBack = readLabel({ readable: false, ingredients: [] })
/** A list no other test uses: the unnamed product for a list is shared by everyone, so a reused list would meet an earlier test's product. */
const freshList = () => ['Aqua', 'Glycerin', `Cetearyl Alcohol ${runSalt}x${counter++}`]
/** What a request to Claude is for, from the shape of the answer it asks for (or the web search it carries). */
const jobOf = (call: { body: any }) => {
  if ((call.body.tools ?? []).some((tool: { name: string }) => tool.name === 'web_search')) return 'research'
  const properties = Object.keys(call.body.output_config?.format?.schema?.properties ?? {})
  if (properties.includes('classification')) return 'recognize'
  if (properties.includes('readable')) return 'read-label'
  if (properties.includes('concerns')) return 'analysis'
  if (properties.includes('same')) return 'same-product'
  return 'other'
}
const hasWebSearch = (calls: { body: any }[]) => calls.some((call) => (call.body.tools ?? []).some((tool: { name: string }) => tool.name === 'web_search'))

/** A one-photo scan whose front photo was unreadable three times, through the queue handler: the item offers identification. */
const identifying = async () => {
  const taken = await startScan()
  stubAnthropic(cheapUnreadable)
  await runQueue(MAIN, { itemId: taken.itemId, step: 'recognise', at: AT })
  for (const n of [1, 2]) {
    await asUser(taken.userId, () => container.scans.retake(taken.scanId, taken.itemId, jpegPhoto(), RETAKE_IP))
    await runQueue(MAIN, { itemId: taken.itemId, step: 'recognise', at: AT + n })
  }
  vi.unstubAllGlobals()
  expect(await itemOf(taken.userId, taken.scanId, taken.itemId)).toMatchObject({ state: 'needs-identification' })
  return { ...taken, backKey: `photos/${env.ENVIRONMENT}/${taken.userId}/${taken.scanId}/${taken.itemId}-back.jpg` }
}
type Identifying = Awaited<ReturnType<typeof identifying>>
const sendBackPhoto = (taken: Identifying, photo = jpegPhoto()) => asUser(taken.userId, () => container.scans.addBackPhoto(taken.scanId, taken.itemId, photo, BACK_IP))
const readBack = (taken: Identifying) => runQueue(MAIN, { itemId: taken.itemId, step: 'read-label', at: AT + 10 })
const analyseItem = (taken: Identifying) => runQueue(MAIN, { itemId: taken.itemId, step: 'analyse', at: AT + 11 })

describe('scan items identified by their back photo, through the Worker queue handler', () => {
  it('takes a back photo that names a product the catalog holds to ready with one label read and no research, analysis or web search', async () => {
    const brand = freshBrand()
    const formulationId = await catalogued(brand, 'Hydrating Cleanser')
    const taken = await identifying()
    const back = jpegPhoto()
    await sendBackPhoto(taken, back)
    const calls = stubAnthropic(readLabel({ readable: true, ingredients: CLEAN, brand, name: 'Hydrating Cleanser', variant: '', category: 'skin' }))

    const result = await readBack(taken)

    expect(result.explicitAcks).toEqual(['m'])
    expect(await itemOf(taken.userId, taken.scanId, taken.itemId)).toMatchObject({
      state: 'ready',
      reason: null,
      recognised: { brand, name: 'Hydrating Cleanser', category: 'skin' },
      product: { formulation: { id: formulationId }, product: { kind: 'named', brand, name: 'Hydrating Cleanser' } },
    })
    expect(calls.map(jobOf)).toEqual(['read-label'])
    expect(calls[0]!.body.messages[0].content[0].source.data).toBe(base64Of(back.bytes))
    expect(hasWebSearch(calls)).toBe(false)
    expect(await env.PRIVATE_PHOTOS.get(taken.backKey)).toBeNull()
  })

  it('creates the product a back photo names when the catalog does not hold it, analyses its label list once, and makes no web search', async () => {
    const brand = freshBrand()
    const list = freshList()
    const taken = await identifying()
    await sendBackPhoto(taken)
    const calls = stubAnthropic(readLabel({ readable: true, ingredients: list, brand, name: 'Bright Tone Serum', variant: 'Night', category: 'skin' }), noConcerns)

    const read = await readBack(taken)

    expect(read.explicitAcks).toEqual(['m'])
    expect(await itemOf(taken.userId, taken.scanId, taken.itemId)).toMatchObject({
      state: 'analysing',
      recognised: { brand, name: 'Bright Tone Serum', variant: 'Night', category: 'skin' },
    })
    const analysed = await analyseItem(taken)

    expect(analysed.explicitAcks).toEqual(['m'])
    expect(await itemOf(taken.userId, taken.scanId, taken.itemId)).toMatchObject({
      state: 'ready',
      product: { product: { kind: 'named', brand, name: 'Bright Tone Serum', variant: 'Night' }, formulation: { ingredients: list, source: { kind: 'label', url: null } } },
    })
    expect(calls.map(jobOf)).toEqual(['read-label', 'analysis'])
    expect(hasWebSearch(calls)).toBe(false)
  })

  it('keeps a list with no name as an unnamed product, and answers a second item with the same list from the first one\'s analysis: one analysis call for both', async () => {
    const list = freshList()
    const first = await identifying()
    await sendBackPhoto(first)
    const firstCalls = stubAnthropic(readLabel({ readable: true, ingredients: list }), noConcerns)
    await readBack(first)
    await analyseItem(first)
    const second = await identifying()
    await sendBackPhoto(second)
    const secondCalls = stubAnthropic(readLabel({ readable: true, ingredients: list }), noConcerns)

    const result = await readBack(second)

    expect(result.explicitAcks).toEqual(['m'])
    const [a, b] = [await itemOf(first.userId, first.scanId, first.itemId), await itemOf(second.userId, second.scanId, second.itemId)]
    expect(a).toMatchObject({ state: 'ready', product: { product: { kind: 'unnamed', brand: '', name: '' } } })
    expect(b).toMatchObject({ state: 'ready', product: { product: { kind: 'unnamed', brand: '', name: '' } } })
    expect(b.product!.formulation.id).toBe(a.product!.formulation.id)
    expect(a).not.toHaveProperty('recognised')
    expect(firstCalls.map(jobOf)).toEqual(['read-label', 'analysis'])
    expect(secondCalls.map(jobOf)).toEqual(['read-label'])
    expect(hasWebSearch([...firstCalls, ...secondCalls])).toBe(false)
  })

  it('moves an item already shown as an unnamed product onto the product a later back photo names, without analysing again', async () => {
    const brand = freshBrand()
    const list = freshList()
    const first = await identifying()
    await sendBackPhoto(first)
    const firstCalls = stubAnthropic(readLabel({ readable: true, ingredients: list }), noConcerns)
    await readBack(first)
    await analyseItem(first)
    const second = await identifying()
    await sendBackPhoto(second)
    const secondCalls = stubAnthropic(readLabel({ readable: true, ingredients: list, brand, name: 'Bright Tone Serum', variant: '', category: 'skin' }), noConcerns)

    await readBack(second)

    const [a, b] = [await itemOf(first.userId, first.scanId, first.itemId), await itemOf(second.userId, second.scanId, second.itemId)]
    expect(b).toMatchObject({ state: 'ready', product: { product: { kind: 'named', brand, name: 'Bright Tone Serum' } } })
    expect(a).toMatchObject({ state: 'ready', product: { product: { kind: 'named', brand, id: b.product!.product.id } } })
    expect(a.product!.formulation.id).toBe(b.product!.formulation.id)
    expect(secondCalls.map(jobOf)).toEqual(['read-label'])
    expect(hasWebSearch([...firstCalls, ...secondCalls])).toBe(false)
  })

  it('asks for identification again, as label-unreadable, deleting the back photo, until the 3rd unreadable back photo ends the item as failed', async () => {
    const taken = await identifying()

    for (const n of [1, 2, 3]) {
      await sendBackPhoto(taken)
      expect(await env.PRIVATE_PHOTOS.get(taken.backKey)).not.toBeNull()
      const calls = stubAnthropic(unreadableBack)

      const result = await runQueue(MAIN, { itemId: taken.itemId, step: 'read-label', at: AT + 20 + n })

      expect(result.explicitAcks).toEqual(['m'])
      expect(calls.map(jobOf)).toEqual(['read-label'])
      expect(await itemOf(taken.userId, taken.scanId, taken.itemId)).toMatchObject(
        n < 3 ? { state: 'needs-identification', reason: 'label-unreadable' } : { state: 'failed', reason: 'label-unreadable' },
      )
      expect(await env.PRIVATE_PHOTOS.get(taken.backKey)).toBeNull()
      vi.unstubAllGlobals()
    }
  })

  it('acks a repeated delivery of the read without calling Anthropic again', async () => {
    const taken = await identifying()
    await sendBackPhoto(taken)
    const calls = stubAnthropic(readLabel({ readable: true, ingredients: freshList() }), noConcerns)
    await readBack(taken)

    const again = await readBack(taken)

    expect(again.explicitAcks).toEqual(['m'])
    expect(calls.map(jobOf)).toEqual(['read-label'])
  })
})
