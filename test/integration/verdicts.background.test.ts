import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { buildContainer } from '../../src/container'
import { D1JobRunsRepository } from '../../src/jobs/job-runs.repository'
import { jobs } from '../../src/jobs/registry'
import { runAs } from '../../src/lib/context'
import { createDb } from '../../src/lib/db'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { D1CatalogWorkbookRepository } from '../../src/modules/catalog/catalog.workbook.repository'
import { FakeOpsAlertsRepository } from '../../src/modules/ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { profileProducts } from '../../src/modules/shelf/shelf.table'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { buildVerdictSpec } from '../../src/modules/verdicts/verdicts.job-specs'
import { D1VerdictsRepository } from '../../src/modules/verdicts/verdicts.repository'
import { json, messageResponse, textBlock } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'
import { applied, taperRow } from './admin.catalog.support'

/** An alerting service that goes nowhere: these tests are not about ops alerts. */
const quietOpsAlerts = () =>
  new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: new MemoryJobQueue(), email: new MemoryEmailSender(), recipient: '', environment: 'test' })

// The build of a shelf verdict (spec #171, D2b), driven through the Worker's real queue handler against local D1, with only the outbound Anthropic call stubbed at
// fetch (the fit judge). The logic of a build (the labels, the fingerprint, the failure ladder) is the service tests' business; this file is the queue's: that the
// message the service queued runs once, retries after a failed fit, waits for a shelf that is still settling, lands in the dead-letter hook, and is a no-op when the
// verdict was already built. A verdict is asked for through the real service, so the message each test runs is the one the service queued: the Worker's verdicts
// producer is a recorder (a real local queue would hand the message to whichever test is running by then), and the same message is delivered by hand, as many
// times and to as many queues (main or dead-letter) as the test needs. The shelf rows are put straight into profile_products, as shelf.routes.test.ts does for
// the cases that only need a shelf in a given state; the step-down templates arrive the way the team's do, through the admin import.
const MAIN = 'deepertones-verdicts-development'
const DEAD_LETTER = 'deepertones-verdicts-dlq-development'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const SOURCE_URL = 'https://shop.example/product'
const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
// These flows make several calls, so their answers report a small usage: the day's AI spend cap (a dollar here) is not what they test.
const CHEAP_USAGE = { input_tokens: 100, output_tokens: 50 }
const DAY = 24 * 60 * 60 * 1000
// The most times a build waits for a shelf that is still settling before it builds anyway.
const MAX_WAITS = 15

type Queued = { body: unknown; delaySeconds: number | undefined }
const verdictsQueued: Queued[] = []
const verdictsQueue = { send: async (body: unknown, options?: { delaySeconds?: number }) => void verdictsQueued.push({ body, delaySeconds: options?.delaySeconds }), sendBatch: async () => {} } as unknown as Queue
// Nothing else the Worker queues is under test here.
const quietQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
const testEnv = { ...env, VERDICTS_QUEUE: verdictsQueue, PARSE_SAFETY_QUEUE: quietQueue, SCAN_ITEMS_QUEUE: quietQueue, PUSH_DELIVERY_QUEUE: quietQueue }
const container = buildContainer(testEnv)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  verdictsQueued.length = 0
})

// The database is shared by the whole file, so every product gets a name no other test has.
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
const freshBrand = () => `${runSalt}${counter++}x Brand`

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const verdictRows = new D1VerdictsRepository(db)
const asUser = <T>(userId: string, fn: () => Promise<T>) => runAs({ kind: 'user', userId, status: 'verified', profileId: `profile-${userId}` }, fn)

// A build refuses to run without an approved step-down template for each kind (a shelf may need either), so the two are put in the way the team does.
beforeAll(async () => {
  await applied((workbook) => {
    workbook.tapers.rows.push(taperRow({ kind: 'steroid' }), taperRow({ kind: 'lightening-agent' }))
  })
})

/** A product the catalog already holds, researched and analysed, so a shelf row can point at its formulation. */
const catalogued = async (brand: string) => {
  const researcher = new MemoryProductResearcher()
  researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))
  const catalog = new ProductCatalogService({
    repository: new D1CatalogRepository(db),
    workbook: new D1CatalogWorkbookRepository(db),
    researcher,
    analyst: new MemoryProductAnalyst(),
    images: new MemoryCatalogImageStore(),
    imageKeyPrefix: 'catalog/test',
    opsAlerts: quietOpsAlerts(),
  })
  const resolved = await catalog.resolve({ brand, name: brand, category: 'skin' })
  if (resolved.kind !== 'needs-research') throw new Error(`expected needs-research, got ${resolved.kind}`)
  const found = await catalog.research(resolved.productId)
  if (found.kind !== 'found') throw new Error('expected found')
  await catalog.analyse(found.formulationId)
  return { productId: resolved.productId, formulationId: found.formulationId }
}

type Shelf = { userId: string; profileId: string; entryId: string }
/** A guest with a goal, a safety answer with no words (nothing to parse) and one product the rules say nothing against, so the fit judge decides it. */
const shelfWithOneProduct = async (): Promise<Shelf> => {
  const userId = crypto.randomUUID()
  const profileId = `profile-${userId}`
  await users.createGuestForDevice({ user: { id: userId, createdAt: new Date() }, device: { deviceHash: `verdicts-bg-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  await asUser(userId, () => container.goals.set({ goal: 'fade-dark-marks' }))
  await asUser(userId, () => container.safety.set({ choices: ['none'] }))
  const { productId, formulationId } = await catalogued(freshBrand())
  const entryId = crypto.randomUUID()
  const now = new Date()
  await db.insert(profileProducts).values({ id: entryId, profileId, kind: 'product', productId, formulationId, scanId: crypto.randomUUID(), itemId: crypto.randomUUID(), addedAt: now, lastScannedAt: now })
  return { userId, profileId, entryId }
}

// What a request to Claude is for: the fit judge's answer is the only one with both `products` and `clashes`.
type Call = { body: any }
const jobOf = (call: Call) => {
  const properties = Object.keys(call.body.output_config?.format?.schema?.properties ?? {})
  return properties.includes('products') && properties.includes('clashes') ? 'fit-verdict' : 'other'
}
/** The fit request the Worker sent, read back out of the prompt. */
const requestOf = (call: Call): { shelf: { id: string; floor: { status: string } }[] } => JSON.parse(String(call.body.messages[0].content[0].text).split('\n').slice(1).join('\n'))

type Answer = (call: Call) => Response
/** The Worker builds its own container per queue message, so the SDK picks up the global fetch. Anything but the Anthropic API gets a 404. */
const stubAnthropic = (answer: Answer) => {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== ANTHROPIC_URL) return new Response('not found', { status: 404 })
    const call = { body: JSON.parse(init!.body as string) }
    calls.push(call)
    if (jobOf(call) !== 'fit-verdict') throw new Error('unexpected request that is not the fit judge')
    return answer(call)
  })
  return calls
}
/** A valid answer: every open product on the shelf helps the goal. */
const fitHelping: Answer = (call) =>
  messageResponse({
    content: [
      textBlock(
        JSON.stringify({
          products: requestOf(call).shelf.filter((p) => p.floor.status === 'open').map((p) => ({ id: p.id, label: 'helping', reason: 'Suits the goal.', sameJobAs: null })),
          clashes: [],
        }),
      ),
    ],
    usage: CHEAP_USAGE,
  })
const overloaded: Answer = () => json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 529)

const runQueue = async (queue: string, body: unknown, attempts = 1) => {
  const batch = createMessageBatch(queue, [{ id: 'm', timestamp: new Date(), attempts, body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, testEnv, ctx)
  return getQueueResult(batch, ctx)
}

type Body = { profileId: string; fingerprint: string; requestedAt: number; waits: number; retry?: boolean }
/** Asks for the verdict through the real service and answers the message it queued. The database is shared by the whole file, so a test reads only its own profile's. */
const ask = async ({ userId, profileId }: Shelf): Promise<Body> => {
  const before = messagesFor(profileId).length
  expect(await asUser(userId, () => container.verdicts.current())).toEqual({ status: 'pending' })
  const message = messagesFor(profileId)[before]
  if (!message) throw new Error('the ask queued no build')
  return message.body as Body
}
const messagesFor = (profileId: string) => verdictsQueued.filter((message) => (message.body as Body).profileId === profileId)
const viewOf = ({ userId }: Shelf) => asUser(userId, () => container.verdicts.current())
const rowOf = ({ profileId }: Shelf) => verdictRows.find(profileId)

describe('the job registry the Worker runs', () => {
  it('includes the job that builds the shelf verdict', () => {
    expect(jobs.map((job) => job.name)).toContain('build-verdict')
  })
})

describe('the verdict build through the Worker queue handler', () => {
  it('builds the verdict the service asked for: one fit call for the open product, a ready verdict, and the run recorded as done', async () => {
    const shelf = await shelfWithOneProduct()
    const body = await ask(shelf)
    const calls = stubAnthropic(fitHelping)

    const result = await runQueue(MAIN, body)

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(calls.map(jobOf)).toEqual(['fit-verdict'])
    expect(requestOf(calls[0]!).shelf.map((p) => [p.id, p.floor.status])).toEqual([[shelf.entryId, 'open']])
    expect(await viewOf(shelf)).toMatchObject({ status: 'ready', fit: 'ready', products: [{ entryId: shelf.entryId, group: 'helping', verdict: { kind: 'keep' } }] })
    expect(await new D1JobRunsRepository(db).get('build-verdict', buildVerdictSpec.key(body))).toMatchObject({ status: 'done' })
  })

  it('runs a message delivered twice once: the repeat is acked without calling Anthropic again', async () => {
    const shelf = await shelfWithOneProduct()
    const body = await ask(shelf)
    stubAnthropic(fitHelping)
    await runQueue(MAIN, body)

    const calls = stubAnthropic(fitHelping)
    const again = await runQueue(MAIN, body, 2)

    expect(again.explicitAcks).toEqual(['m'])
    expect(calls).toEqual([])
    expect(await viewOf(shelf)).toMatchObject({ status: 'ready', fit: 'ready' })
  })

  it('acks a message for a verdict that is already built, with a key of its own, without a second fit call', async () => {
    const shelf = await shelfWithOneProduct()
    const body = await ask(shelf)
    stubAnthropic(fitHelping)
    await runQueue(MAIN, body)
    const built = await rowOf(shelf)

    const calls = stubAnthropic(fitHelping)
    // The ask taken over after it was built, say: same profile and fingerprint, another request time, so another key.
    const late = await runQueue(MAIN, { ...body, requestedAt: body.requestedAt + 1 })

    expect(late.explicitAcks).toEqual(['m'])
    expect(late.retryMessages).toEqual([])
    expect(calls).toEqual([])
    expect(await rowOf(shelf)).toEqual(built)
  })
})

describe('the verdict build when the fit judge cannot answer', () => {
  it('retries the message after a failed fit, shows the user the verdict without its fit in the meantime, and finishes it on the retry', async () => {
    const shelf = await shelfWithOneProduct()
    const body = await ask(shelf)
    const failing = stubAnthropic(overloaded)

    const failed = await runQueue(MAIN, body)

    expect(failed.retryMessages).toEqual([{ msgId: 'm' }])
    expect(failed.explicitAcks).toEqual([])
    expect(failing.map(jobOf)).toEqual(['fit-verdict'])
    expect(await viewOf(shelf)).toMatchObject({ status: 'ready', fit: 'not-ready', products: [{ entryId: shelf.entryId, group: 'undecided' }] })
    expect(messagesFor(shelf.profileId)).toHaveLength(1)

    const answering = stubAnthropic(fitHelping)
    const retried = await runQueue(MAIN, body, 2)

    expect(retried.explicitAcks).toEqual(['m'])
    expect(answering.map(jobOf)).toEqual(['fit-verdict'])
    expect(await viewOf(shelf)).toMatchObject({ status: 'ready', fit: 'ready', products: [{ entryId: shelf.entryId, group: 'helping' }] })
  })

  it('gives the fit one more try tomorrow when its dead letter arrives: due in 24 hours, nothing queued, and Anthropic not called', async () => {
    const shelf = await shelfWithOneProduct()
    const body = await ask(shelf)
    const calls = stubAnthropic(fitHelping)
    const queuedBefore = verdictsQueued.length
    const before = Date.now()

    const result = await runQueue(DEAD_LETTER, body, 5)
    const after = Date.now()

    expect(result.explicitAcks).toEqual(['m'])
    expect(calls).toEqual([])
    expect(verdictsQueued).toHaveLength(queuedBefore)
    const row = await rowOf(shelf)
    expect(row).toMatchObject({ fitRetried: true })
    expect(row!.fitRetryDueAt!.getTime()).toBeGreaterThanOrEqual(before + DAY)
    expect(row!.fitRetryDueAt!.getTime()).toBeLessThanOrEqual(after + DAY)
  })

  it('runs that second try for real: the sweep queues the retry when it is due, and the Worker builds the verdict from it', async () => {
    const shelf = await shelfWithOneProduct()
    const body = await ask(shelf)
    await runQueue(DEAD_LETTER, body, 5)
    const due = (await rowOf(shelf))!.fitRetryDueAt!
    const queuedBefore = messagesFor(shelf.profileId).length

    await runAs({ kind: 'system', job: 'verdict-fit-requeue' }, () => container.verdicts.requeueDueFits(due))

    expect(messagesFor(shelf.profileId)).toHaveLength(queuedBefore + 1)
    const retry = messagesFor(shelf.profileId)[queuedBefore]!
    expect(retry.delaySeconds ?? 0).toBe(0)
    expect(retry.body).toMatchObject({ profileId: shelf.profileId, fingerprint: body.fingerprint, waits: 0, retry: true })
    const calls = stubAnthropic(fitHelping)

    // The message as the sweep queued it. (A message with the key of the first one would be acked as the finished, failed run it replaces.)
    const result = await runQueue(MAIN, retry.body)

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(calls.map(jobOf)).toEqual(['fit-verdict'])
    expect(await viewOf(shelf)).toMatchObject({ status: 'ready', fit: 'ready' })
    expect(await rowOf(shelf)).toMatchObject({ fitRetryDueAt: null })
  })

  it('does not queue the retry before it is due', async () => {
    const shelf = await shelfWithOneProduct()
    const body = await ask(shelf)
    await runQueue(DEAD_LETTER, body, 5)
    const due = (await rowOf(shelf))!.fitRetryDueAt!
    const queuedBefore = messagesFor(shelf.profileId).length

    await runAs({ kind: 'system', job: 'verdict-fit-requeue' }, () => container.verdicts.requeueDueFits(new Date(due.getTime() - 1)))

    expect(messagesFor(shelf.profileId)).toHaveLength(queuedBefore)
  })

  it('leaves a verdict that was built as it was when a dead letter arrives for its message', async () => {
    const shelf = await shelfWithOneProduct()
    const body = await ask(shelf)
    stubAnthropic(fitHelping)
    await runQueue(MAIN, body)
    const built = await rowOf(shelf)

    const result = await runQueue(DEAD_LETTER, body, 5)

    expect(result.explicitAcks).toEqual(['m'])
    expect(await rowOf(shelf)).toEqual(built)
  })
})

describe('the verdict build while the shelf is still settling', () => {
  it('queues itself again a minute on, one wait further, each time safety words are still being parsed, and builds after the 15th wait', async () => {
    const shelf = await shelfWithOneProduct()
    // Words to parse make the row pending; the parse itself is never run here, so it stays pending for the whole test.
    await asUser(shelf.userId, () => container.safety.set({ choices: ['reaction'], reactionText: 'I react to lanolin' }))
    const first = await ask(shelf)
    const calls = stubAnthropic(fitHelping)

    let message: Body = first
    for (let waits = 0; waits < MAX_WAITS; waits++) {
      const queuedBefore = messagesFor(shelf.profileId).length
      const result = await runQueue(MAIN, message)

      expect(result.explicitAcks).toEqual(['m'])
      expect(calls).toEqual([])
      expect(await rowOf(shelf)).toMatchObject({ status: 'pending', fit: null })
      expect(messagesFor(shelf.profileId)).toHaveLength(queuedBefore + 1)
      const next = messagesFor(shelf.profileId)[queuedBefore]!
      expect(next.delaySeconds).toBe(60)
      expect(next.body).toEqual({ ...message, waits: waits + 1 })
      message = next.body as Body
    }

    // Past the last wait it builds with the words unparsed, as the floor reads what it has.
    expect(message.waits).toBe(MAX_WAITS)
    const queuedBefore = messagesFor(shelf.profileId).length
    const built = await runQueue(MAIN, message)

    expect(built.explicitAcks).toEqual(['m'])
    expect(messagesFor(shelf.profileId)).toHaveLength(queuedBefore)
    expect(calls.map(jobOf)).toEqual(['fit-verdict'])
    expect(await viewOf(shelf)).toMatchObject({ status: 'ready', fit: 'ready' })
  })
})
