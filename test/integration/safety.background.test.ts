import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { buildContainer } from '../../src/container'
import { D1JobRunsRepository } from '../../src/jobs/job-runs.repository'
import { jobs } from '../../src/jobs/registry'
import { runAs } from '../../src/lib/context'
import { createDb } from '../../src/lib/db'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { D1SafetyRepository } from '../../src/modules/safety/safety.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { json, messageResponse, searchCall, searchResults, textBlock } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'

// The parse of the reaction and prescription words, driven through the Worker's real queue handler against local D1, with only the
// outbound Anthropic call stubbed at fetch (the mention reader, and the researcher's web search). Answers are saved through the real
// service, so the message each test runs is the one the service queued: the Worker's parse-safety producer is a recorder, since a real
// local queue would hand a message to whichever test is running by then. The same message is then delivered by hand, as many times and
// to as many queues (main or dead-letter) as the test needs.
const MAIN = 'deepertones-parse-safety-development'
const DEAD_LETTER = 'deepertones-parse-safety-dlq-development'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const SOURCE_URL = 'https://shop.example/product'
const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
// These flows make several calls, so their answers report a small usage and no web search: the day's AI spend cap (a dollar here) is not what they test.
const CHEAP_USAGE = { input_tokens: 100, output_tokens: 50 }
const SECRET = 'QZ7'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  parseQueued.length = 0
})

// The database is shared by the whole file, so every product gets a name no other test has.
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
const freshBrand = () => `${runSalt}${counter++}x Brand`

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const safetyRows = new D1SafetyRepository(db)
const guest = async () => {
  const id = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id, createdAt: new Date() }, device: { deviceHash: `safety-bg-${id}`, platform: 'ios' }, profile: { id: `profile-${id}` } })
  return id
}

const parseQueued: { body: unknown; delaySeconds: number | undefined }[] = []
const parseQueue = { send: async (body: unknown, options?: { delaySeconds?: number }) => void parseQueued.push({ body, delaySeconds: options?.delaySeconds }), sendBatch: async () => {} } as unknown as Queue
// Nothing else the Worker queues is under test here.
const quietQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
const testEnv = { ...env, PARSE_SAFETY_QUEUE: parseQueue, SCAN_ITEMS_QUEUE: quietQueue, PUSH_DELIVERY_QUEUE: quietQueue }
const container = buildContainer(testEnv)
const asUser = <T>(userId: string, fn: () => Promise<T>) => runAs({ kind: 'user', userId, status: 'anonymous', profileId: `profile-${userId}` }, fn)

type Saved = { userId: string; safetyId: string }
/** Saves the words through the real service and answers the id of the row, from the message the service queued. */
const save = async (input: Parameters<typeof container.safety.set>[0], userId?: string): Promise<Saved> => {
  const id = userId ?? (await guest())
  const before = parseQueued.length
  await asUser(id, () => container.safety.set(input))
  const message = parseQueued[before]
  if (!message) throw new Error('the answer queued no parse')
  return { userId: id, safetyId: (message.body as { safetyId: string }).safetyId }
}
const reaction = (text: string, userId?: string) => save({ choices: ['reaction'], reactionText: text }, userId)
const mentionsOf = ({ userId }: Saved) => asUser(userId, () => container.safety.currentMentions())
const stateOf = async ({ safetyId }: Saved) => (await safetyRows.find(safetyId))!.parseState

/** A product the catalog already holds, researched and analysed, so resolving it needs no research or analysis call. */
const catalogued = async (brand: string) => {
  const researcher = new MemoryProductResearcher()
  researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))
  const catalog = new ProductCatalogService({
    repository: new D1CatalogRepository(db),
    researcher,
    analyst: new MemoryProductAnalyst(),
    images: new MemoryCatalogImageStore(),
    imageKeyPrefix: 'catalog/test',
  })
  const resolved = await catalog.resolve({ brand, name: brand, category: 'skin' })
  if (resolved.kind !== 'needs-research') throw new Error(`expected needs-research, got ${resolved.kind}`)
  const found = await catalog.research(resolved.productId)
  if (found.kind !== 'found') throw new Error('expected found')
  await catalog.analyse(found.formulationId)
  return resolved.productId
}

// What a request to Claude is for, from the shape of the answer it asks for or the web search it carries.
type Call = { body: any }
const jobOf = (call: Call) => {
  if ((call.body.tools ?? []).some((tool: { name: string }) => tool.name === 'web_search')) return 'research'
  if (Object.keys(call.body.output_config?.format?.schema?.properties ?? {}).includes('mentions')) return 'read-mentions'
  return 'other'
}
const countOf = (calls: Call[], job: string) => calls.filter((call) => jobOf(call) === job).length

type Answers = { 'read-mentions'?: () => Response; research?: () => Response }
/** The Worker builds its own container per queue message, so the SDK picks up the global fetch. Anything but the Anthropic API gets a 404 (a stock image lookup, say). */
const stubAnthropic = (answers: Answers) => {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== ANTHROPIC_URL) return new Response('not found', { status: 404 })
    const call = { body: JSON.parse(init!.body as string) }
    calls.push(call)
    const job = jobOf(call) as keyof Answers
    const answer = answers[job]
    if (!answer) throw new Error(`unexpected ${job} request`)
    return answer()
  })
  return calls
}

const mentionsReply = (...mentions: Record<string, unknown>[]) => () => messageResponse({ content: [textBlock(JSON.stringify({ mentions }))], usage: CHEAP_USAGE })
const productMention = (brand: string, over: Record<string, unknown> = {}) => ({ kind: 'product', brand, name: brand, variant: '', category: 'skin', ...over })
const ingredientMention = (name: string) => ({ kind: 'ingredient', brand: '', name, variant: '', category: 'none' })

const researchSaying = (answer: Record<string, unknown>) => () =>
  messageResponse({ content: [searchCall('srvtoolu_01', 'ingredients'), searchResults('srvtoolu_01', [SOURCE_URL]), textBlock(JSON.stringify(answer))], usage: CHEAP_USAGE })
const researchFinds = researchSaying({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL })
const researchFindsNothing = researchSaying({ found: false, ingredients: [] })
const overloaded = () => json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 529)
const refusal = () => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' })

const runQueue = async (queue: string, body: unknown, attempts = 1) => {
  const batch = createMessageBatch(queue, [{ id: 'm', timestamp: new Date(), attempts, body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, testEnv, ctx)
  return getQueueResult(batch, ctx)
}
const parseNow = (saved: Saved, attempts = 1) => runQueue(MAIN, { safetyId: saved.safetyId }, attempts)

describe('the job registry the Worker runs', () => {
  it('includes the job that parses the safety words', () => {
    expect(jobs.map((job) => job.name)).toContain('parse-safety')
  })
})

describe('the safety parse through the Worker queue handler', () => {
  it('reads "Caro White and fragrance", stores the product and the ingredient in order, resolves the product to the one in the catalog, and finishes', async () => {
    const brand = freshBrand()
    const productId = await catalogued(brand)
    const words = `${brand} and fragrance`
    const saved = await reaction(words)
    expect(await stateOf(saved)).toBe('pending')
    const calls = stubAnthropic({ 'read-mentions': mentionsReply(productMention(brand), ingredientMention('fragrance')) })

    const result = await parseNow(saved)

    expect(result.explicitAcks).toEqual(['m'])
    expect(await mentionsOf(saved)).toMatchObject([
      { source: 'reaction', kind: 'product', brand, name: brand, category: 'skin', productId, resolution: 'resolved' },
      { source: 'reaction', kind: 'ingredient', name: 'fragrance', productId: null, resolution: null },
    ])
    expect(await stateOf(saved)).toBe('done')
    // One read of the words and nothing more: the product was already in the catalog.
    expect(calls.map(jobOf)).toEqual(['read-mentions'])
    const sent = calls[0]!.body.messages
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent[0].content)).toContain(words)
    expect(await new D1JobRunsRepository(db).get('parse-safety', `parse-safety:${saved.safetyId}`)).toMatchObject({ status: 'done' })
  })

  it('researches a product the catalog has never held, with the same web search a typed name gets, and resolves it to the new catalog product', async () => {
    const brand = freshBrand()
    const saved = await reaction(`${brand} cream burned me`)
    const calls = stubAnthropic({ 'read-mentions': mentionsReply(productMention(brand)), research: researchFinds })

    const result = await parseNow(saved)

    expect(result.explicitAcks).toEqual(['m'])
    expect(calls.map(jobOf)).toEqual(['read-mentions', 'research'])
    const [mention] = await mentionsOf(saved)
    expect(mention).toMatchObject({ kind: 'product', resolution: 'resolved', productId: expect.any(String) })
    // The ingredients are now in the catalog under that product, waiting to be analysed.
    expect(await container.catalog.choose(mention!.productId!)).toMatchObject({ kind: 'needs-analysis' })
    expect(await stateOf(saved)).toBe('done')
  })

  it('leaves a product unresolved, keeping the catalog\'s product, when the research finds no ingredient list, and still finishes', async () => {
    const brand = freshBrand()
    const saved = await reaction(`${brand} cream burned me`)
    stubAnthropic({ 'read-mentions': mentionsReply(productMention(brand)), research: researchFindsNothing })

    const result = await parseNow(saved)

    expect(result.explicitAcks).toEqual(['m'])
    const [mention] = await mentionsOf(saved)
    expect(mention).toMatchObject({ resolution: 'unresolved', productId: expect.any(String) })
    expect(await container.catalog.choose(mention!.productId!)).toMatchObject({ kind: 'needs-research' })
    expect(await stateOf(saved)).toBe('done')
  })

  it('resolves three of four named products and leaves the fourth unresolved, without researching any of them', async () => {
    const brands = [freshBrand(), freshBrand(), freshBrand(), freshBrand()]
    for (const brand of brands) await catalogued(brand)
    const saved = await reaction(brands.join(', '))
    const calls = stubAnthropic({ 'read-mentions': mentionsReply(...brands.map((brand) => productMention(brand))) })

    await parseNow(saved)

    expect((await mentionsOf(saved)).map((m) => m.resolution)).toEqual(['resolved', 'resolved', 'resolved', 'unresolved'])
    expect((await mentionsOf(saved))[3]!.productId).toBeNull()
    expect(calls.map(jobOf)).toEqual(['read-mentions'])
  })

  it('stores a product the reader gave no brand for as unresolved, and never asks the catalog about it', async () => {
    const saved = await reaction('the white tub from the market')
    stubAnthropic({ 'read-mentions': mentionsReply(productMention('', { name: 'white tub', category: 'skin' })) })

    await parseNow(saved)

    expect(await mentionsOf(saved)).toMatchObject([{ kind: 'product', brand: null, name: 'white tub', resolution: 'unresolved', productId: null }])
    expect(await stateOf(saved)).toBe('done')
  })

  it('reads both texts, reaction first, and keeps the order across them', async () => {
    const brand = freshBrand()
    const saved = await save({ choices: ['reaction', 'prescription'], reactionText: 'I react to lanolin', prescriptionText: `${brand} from my dermatologist` })
    const replies = [mentionsReply(ingredientMention('lanolin')), mentionsReply(productMention(brand))]
    const calls = stubAnthropic({ 'read-mentions': () => replies.shift()!(), research: researchFindsNothing })

    await parseNow(saved)

    expect(countOf(calls, 'read-mentions')).toBe(2)
    expect((await mentionsOf(saved)).map((m) => [m.source, m.name])).toEqual([
      ['reaction', 'lanolin'],
      ['prescription', brand],
    ])
  })
})

describe('the safety parse when something is not ready', () => {
  it('retries, with the product left pending, when the research hits a retryable error, and then reads nothing again', async () => {
    const brand = freshBrand()
    const saved = await reaction(`${brand} cream burned me`)
    const first = stubAnthropic({ 'read-mentions': mentionsReply(productMention(brand)), research: overloaded })

    const failed = await parseNow(saved)

    expect(failed.retryMessages).toEqual([{ msgId: 'm' }])
    expect(failed.explicitAcks).toEqual([])
    expect(countOf(first, 'read-mentions')).toBe(1)
    expect(await mentionsOf(saved)).toMatchObject([{ kind: 'product', resolution: 'pending' }])
    expect(await stateOf(saved)).toBe('pending')

    const second = stubAnthropic({ research: researchFinds })
    const retried = await parseNow(saved, 2)

    expect(retried.explicitAcks).toEqual(['m'])
    expect(countOf(second, 'read-mentions')).toBe(0)
    expect(countOf(second, 'research')).toBe(1)
    expect(await mentionsOf(saved)).toMatchObject([{ resolution: 'resolved', productId: expect.any(String) }])
    expect(await stateOf(saved)).toBe('done')
  })

  it('retries, with nothing stored, when Claude is unavailable for the read, and reads on the retry', async () => {
    const saved = await reaction('I react to lanolin and fragrance')
    stubAnthropic({ 'read-mentions': overloaded })

    const failed = await parseNow(saved)

    expect(failed.retryMessages).toEqual([{ msgId: 'm' }])
    expect(await mentionsOf(saved)).toEqual([])
    expect(await stateOf(saved)).toBe('pending')

    stubAnthropic({ 'read-mentions': mentionsReply(ingredientMention('lanolin'), ingredientMention('fragrance')) })
    const retried = await parseNow(saved, 2)

    expect(retried.explicitAcks).toEqual(['m'])
    expect((await mentionsOf(saved)).map((m) => m.name)).toEqual(['lanolin', 'fragrance'])
    expect(await stateOf(saved)).toBe('done')
  })

  it('finishes with no mentions, and acks, when the model refuses to read the words: the words and the tick still count', async () => {
    const saved = await reaction('Caro White and fragrance')
    stubAnthropic({ 'read-mentions': refusal })

    const result = await parseNow(saved)

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await mentionsOf(saved)).toEqual([])
    expect(await stateOf(saved)).toBe('done')
  })

  it('acks a repeated delivery of a finished parse without calling Anthropic again', async () => {
    const brand = freshBrand()
    await catalogued(brand)
    const saved = await reaction(brand)
    stubAnthropic({ 'read-mentions': mentionsReply(productMention(brand)) })
    await parseNow(saved)

    const calls = stubAnthropic({})
    const again = await parseNow(saved, 2)

    expect(again.explicitAcks).toEqual(['m'])
    expect(calls).toEqual([])
    expect(await stateOf(saved)).toBe('done')
  })
})

describe('the safety parse and a newer answer', () => {
  it('parses nothing for an answer a newer one has replaced, and parses the newer one', async () => {
    const first = await reaction('I react to lanolin')
    const second = await reaction('I react to fragrance', first.userId)
    const calls = stubAnthropic({ 'read-mentions': mentionsReply(ingredientMention('fragrance')) })

    const stale = await parseNow(first)

    expect(stale.explicitAcks).toEqual(['m'])
    expect(calls).toEqual([])
    expect(await stateOf(first)).toBe('done')

    await parseNow(second)

    expect(calls.map(jobOf)).toEqual(['read-mentions'])
    expect((await mentionsOf(second)).map((m) => m.name)).toEqual(['fragrance'])
  })

  it('holds the second answer\'s parse back for the rest of the hour, so one profile parses at most once an hour', async () => {
    const first = await reaction('I react to lanolin')
    await reaction('I react to fragrance', first.userId)

    const [now, held] = parseQueued.map((message) => message.delaySeconds ?? 0)
    expect(now).toBe(0)
    expect(held).toBeGreaterThan(3590)
    expect(held).toBeLessThanOrEqual(3600)
  })
})

describe('the safety parse reaching the dead-letter queue', () => {
  it('marks the answer\'s parse failed, calling nobody, and keeps the words', async () => {
    const saved = await reaction('Caro White and fragrance')
    const calls = stubAnthropic({})

    const result = await runQueue(DEAD_LETTER, { safetyId: saved.safetyId }, 5)

    expect(result.explicitAcks).toEqual(['m'])
    expect(calls).toEqual([])
    expect(await stateOf(saved)).toBe('failed')
    expect(await safetyRows.find(saved.safetyId)).toMatchObject({ reactionText: 'Caro White and fragrance', choices: ['reaction'] })
  })

  it('keeps a finished parse as it was when a dead letter arrives for it', async () => {
    const saved = await reaction('I react to lanolin')
    stubAnthropic({ 'read-mentions': mentionsReply(ingredientMention('lanolin')) })
    await parseNow(saved)

    const result = await runQueue(DEAD_LETTER, { safetyId: saved.safetyId }, 5)

    expect(result.explicitAcks).toEqual(['m'])
    expect(await stateOf(saved)).toBe('done')
  })
})

describe('the safety parse and what it logs', () => {
  it('logs neither the words, a brand nor a name through a retry and its finish', async () => {
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    const brand = `${freshBrand()} ${SECRET}`
    const saved = await reaction(`${brand} cream burned me, and ${SECRET} fragrance`)
    stubAnthropic({ 'read-mentions': mentionsReply(productMention(brand), ingredientMention(`${SECRET} fragrance`)), research: overloaded })
    await parseNow(saved)
    stubAnthropic({ research: researchFindsNothing })
    await parseNow(saved, 2)
    await runQueue(DEAD_LETTER, { safetyId: saved.safetyId }, 5)

    for (const line of spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call)))) expect(line).not.toContain(SECRET)
  })
})
