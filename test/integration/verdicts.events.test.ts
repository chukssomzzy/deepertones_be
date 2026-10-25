import { abortAllDurableObjects, createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { D1CatalogWorkbookRepository } from '../../src/modules/catalog/catalog.workbook.repository'
import { FakeOpsAlertsRepository } from '../../src/modules/ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { profileProducts } from '../../src/modules/shelf/shelf.table'
import { json, messageResponse, textBlock } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'
import { applied, code, ruleRow, taperRow, word } from './admin.catalog.support'
import { parseFrame, sseReader, type SseReader } from './sse'

// GET /api/v1/me/verdict/events (spec #171, D3) through the Worker's public surface: the verdict followed live as server-sent events, on the Durable Object the
// scans use, keyed `verdict:<profileId>`. The verdict is built the way it is in life (the route queues a `build-verdict` message, the queue handler runs it, only
// the fit judge's Anthropic call is stubbed at fetch), and the frames are read from the real stream with plain fetch and the bounded reader in ./sse, so a stream
// that never speaks fails the test instead of hanging it. The gates, the build and the shape of a verdict are verdicts.routes.test.ts's business; this file is
// what the stream adds: when a frame arrives, what it carries, and when the stream ends.
//
// THE STREAM PINNED HERE (the precedent is GET /scans/faces/{id}/events):
//   `snapshot`  first, whose data is the body GET /me/verdict answers now: { status: 'pending' } or the ready verdict. Asking also queues the build, once.
//   `verdict`   each time a build saves, whose data is the ready verdict as GET would answer it (fit 'ready' or 'not-ready').
//   `done`      (data {}) after a `verdict` whose fit is 'ready', or whose fit is 'not-ready' with no retry coming within seconds (the third failed attempt of the day,
//               whose next try is a day on, or the spent 24 hour retry); then the server closes the stream. A `verdict` whose fit is 'not-ready' and which the queue is
//               still to retry (attempts 1 and 2) is followed by no `done`: the stream stays open for that retry's `verdict`. A ready verdict that is already current
//               gets `snapshot` and then `done` on the same rule.
// No frame ever carries `facts`, `step`, `sourceUrls`, or a step-down's status and audit columns: the body is the same public one GET answers.
// The errors before the stream starts (401, 503 VERDICT_UNAVAILABLE, 409 GOAL_REQUIRED) are the usual JSON envelopes, in GET's order.

const VERDICTS_MAIN = 'deepertones-verdicts-development'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const SOURCE_URL = 'https://shop.example/product'
const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
const CHEAP_USAGE = { input_tokens: 100, output_tokens: 50 }
// How long to listen for a frame that must not come.
const QUIET_MS = 300

type Queued = { body: unknown; delaySeconds: number | undefined }
const verdictsQueued: Queued[] = []
const verdictsQueue = { send: async (body: unknown, options?: { delaySeconds?: number }) => void verdictsQueued.push({ body, delaySeconds: options?.delaySeconds }), sendBatch: async () => {} } as unknown as Queue
const quietQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
// The Worker keeps its real SCAN_STREAM binding (from env): the frames are read from the real Durable Object.
const WORKER_ENV = { ...env, VERDICTS_QUEUE: verdictsQueue, SCAN_ITEMS_QUEUE: quietQueue, PARSE_SAFETY_QUEUE: quietQueue, PUSH_DELIVERY_QUEUE: quietQueue }
const ORIGIN = 'http://deepertones.test'
const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())
const api = hc<AppType>(ORIGIN, { fetch: fetchWorker as typeof fetch })
const v1 = api.api.v1

const opened: SseReader[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  verdictsQueued.length = 0
  await Promise.all(opened.splice(0).map((stream) => stream.cancel()))
  await abortAllDurableObjects()
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshBrand = () => `${runSalt}${next()}x VerdictEventsBrand`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number; headers: Headers }
const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}

type PublicProduct = { entryId: string; group: string; verdict: { kind: string; taperCode?: string }; reason: string; escalate: boolean }
type ReadyView = { status: 'ready'; fit: 'ready' | 'not-ready'; products: PublicProduct[]; tapers: { code: string }[] }

// --- people: a guest of one install ---

const db = createDb(env.DB)
const newGuest = async () => {
  const deviceId = `device-verdict-events-${runSalt}-${next()}`
  const ip = freshIp()
  const res = await v1.auth.anonymous.$post({ json: { deviceId, platform: 'ios' } }, { headers: { 'cf-connecting-ip': ip } })
  const session = await dataOf<{ tokens: { accessToken: string }; user: { id: string } }>(res)
  const profileId = (await new D1ProfilesRepository(db).defaultFor(session.user.id))!.id
  return { userId: session.user.id, profileId, headers: () => ({ 'cf-connecting-ip': ip, Authorization: `Bearer ${session.tokens.accessToken}` }) }
}
type Guest = Awaited<ReturnType<typeof newGuest>>

const putGoal = async (guest: Guest, goal = 'fade-dark-marks') => expect((await v1.me.goal.$put({ json: { goal } as never }, { headers: guest.headers() })).status).toBe(200)
const putSafety = async (guest: Guest, body: Record<string, unknown>) => expect((await v1.me.safety.$put({ json: body as never }, { headers: guest.headers() })).status).toBe(200)
/** A guest with a goal and no safety trouble, ready to have a shelf. */
const readyGuest = async () => {
  const guest = await newGuest()
  await putGoal(guest)
  await putSafety(guest, { choices: ['none'] })
  return guest
}

const getVerdict = (guest: Guest) => v1.me.verdict.$get({}, { headers: guest.headers() })
const queuedFor = (guest: Guest) => verdictsQueued.filter((message) => (message.body as { profileId: string }).profileId === guest.profileId)

/** The events route, called with plain fetch (the typed client reads a stream as a bare Response); no session when no guest is given. */
const eventsOf = (guest?: Guest) =>
  fetchWorker(`${ORIGIN}/api/v1/me/verdict/events`, { headers: guest ? guest.headers() : { 'cf-connecting-ip': freshIp() } })
const watch = async (guest: Guest) => {
  const res = await eventsOf(guest)
  expect(res.status).toBe(200)
  const stream = sseReader(res)
  opened.push(stream)
  return { res, stream }
}

// --- the shelf ---

const quietOpsAlerts = () =>
  new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: new MemoryJobQueue(), email: new MemoryEmailSender(), recipient: '', environment: 'test' })
/** A product the catalog holds, researched and analysed, and put on the guest's shelf. Answers the shelf entry's id. */
const onShelf = async (guest: Guest, ingredients: string[] = CLEAN): Promise<string> => {
  const researcher = new MemoryProductResearcher()
  researcher.respondWith(() => ({ found: true, ingredients, sourceUrl: SOURCE_URL }))
  const analyst = new MemoryProductAnalyst()
  analyst.analyseWith((input) =>
    input.flaggedFacts.map((fact) => ({ kind: fact.kind, severity: 'high', ingredients: [fact.ingredient], why: 'Flagged by the rules.', whoShouldTakeCare: 'Everyone.', traits: [], sources: fact.source === null ? [] : [fact.source] })),
  )
  const catalog = new ProductCatalogService({
    repository: new D1CatalogRepository(db),
    workbook: new D1CatalogWorkbookRepository(db),
    researcher,
    analyst,
    images: new MemoryCatalogImageStore(),
    imageKeyPrefix: 'catalog/test',
    opsAlerts: quietOpsAlerts(),
  })
  const brand = freshBrand()
  const resolved = await catalog.resolve({ brand, name: brand, category: 'skin' })
  if (resolved.kind !== 'needs-research') throw new Error(`expected needs-research, got ${resolved.kind}`)
  const found = await catalog.research(resolved.productId)
  if (found.kind !== 'found') throw new Error('expected found')
  await catalog.analyse(found.formulationId)
  const id = crypto.randomUUID()
  const now = new Date()
  await db.insert(profileProducts).values({
    id,
    profileId: guest.profileId,
    kind: 'product',
    productId: resolved.productId,
    formulationId: found.formulationId,
    scanId: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
    addedAt: now,
    lastScannedAt: now,
  })
  return id
}

// --- the fit judge, stubbed at fetch ---

type Call = { body: any }
const requestOf = (call: Call): { shelf: { id: string; floor: { status: string } }[] } => JSON.parse(String(call.body.messages[0].content[0].text).split('\n').slice(1).join('\n'))
/** The judge calls every open product helping, with the reason `Reason: helping.`. */
const stubFit = () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== ANTHROPIC_URL) return new Response('not found', { status: 404 })
    const products = requestOf({ body: JSON.parse(init!.body as string) })
      .shelf.filter((p) => p.floor.status === 'open')
      .map((p) => ({ id: p.id, label: 'helping', reason: 'Reason: helping.', sameJobAs: null }))
    return messageResponse({ content: [textBlock(JSON.stringify({ products, clashes: [] }))], usage: CHEAP_USAGE })
  })
}
const deliver = async (guest: Guest) => {
  const message = queuedFor(guest).at(-1)
  if (!message) throw new Error('the route queued no build')
  const batch = createMessageBatch(VERDICTS_MAIN, [{ id: 'm', timestamp: new Date(), attempts: 1, body: message.body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, WORKER_ENV, ctx)
  return getQueueResult(batch, ctx)
}
/** Delivers the build message the route queued for this guest; the judge answers. */
const buildQueued = async (guest: Guest) => {
  stubFit()
  expect((await deliver(guest)).explicitAcks).toEqual(['m'])
  vi.unstubAllGlobals()
}
/** The judge failing the way the model's own overload does: the build saves the floor alone and throws for the queue to retry. */
const buildWithFitFailing = async (guest: Guest) => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
    String(input) === ANTHROPIC_URL ? json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 529) : new Response('not found', { status: 404 }),
  )
  expect((await deliver(guest)).retryMessages).toEqual([{ msgId: 'm' }])
  vi.unstubAllGlobals()
}

/** The judge failing all three attempts of the day: the first two are retried by the queue, the third is acknowledged and the next try is a day on. */
const buildWithFitFailingForTheDay = async (guest: Guest) => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
    String(input) === ANTHROPIC_URL ? json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 529) : new Response('not found', { status: 404 }),
  )
  expect((await deliver(guest)).retryMessages).toEqual([{ msgId: 'm' }])
  expect((await deliver(guest)).retryMessages).toEqual([{ msgId: 'm' }])
  expect((await deliver(guest)).explicitAcks).toEqual(['m'])
  vi.unstubAllGlobals()
}

const STEROID_TAPER = code('TPR-STEROID')
const LIGHTENING_TAPER = code('TPR-LIGHTENING')
const STEROID_INGREDIENT = `${word('zq')} corticoidum`
const helpingBody = (entryId: string, fit: 'ready' | 'not-ready' = 'ready') => ({
  status: 'ready',
  fit,
  products: [
    fit === 'ready'
      ? { entryId, group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false }
      : { entryId, group: 'undecided', verdict: { kind: 'keep' }, reason: expect.any(String), escalate: false },
  ],
  tapers: [],
})

describe('GET /api/v1/me/verdict/events: who may follow, and before the templates are approved', () => {
  it('answers 401 AUTH_REQUIRED as a JSON envelope, not a stream, without a session', async () => {
    const res = await eventsOf()

    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ success: false, status: 401, error: { code: 'AUTH_REQUIRED' } })
  })

  it('answers 503 VERDICT_UNAVAILABLE as a JSON envelope while no template is approved, even for a profile with no goal, and queues nothing', async () => {
    const guest = await newGuest()

    const res = await eventsOf(guest)

    expect(res.status).toBe(503)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ success: false, status: 503, error: { code: 'VERDICT_UNAVAILABLE' } })
    expect(queuedFor(guest)).toEqual([])
  })
})

describe('GET /api/v1/me/verdict/events: with both step-down templates approved', () => {
  beforeAll(async () => {
    await applied((workbook) => {
      workbook.tapers.rows.push(taperRow({ code: STEROID_TAPER, kind: 'steroid' }), taperRow({ code: LIGHTENING_TAPER, kind: 'lightening-agent' }))
      workbook.ingredients.rows.push(ruleRow({ name: STEROID_INGREDIENT, kind: 'banned-substance', group: 'steroid', statement: 'A topical steroid.' }))
    })
  })

  it('answers 409 GOAL_REQUIRED as a JSON envelope for a profile with no goal, and queues nothing', async () => {
    const guest = await newGuest()
    await onShelf(guest)

    const res = await eventsOf(guest)

    expect(res.status).toBe(409)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ success: false, status: 409, error: { code: 'GOAL_REQUIRED' } })
    expect(queuedFor(guest)).toEqual([])
  })

  it('opens an event stream that no proxy buffers or rewrites, starting with a pending snapshot, and queues exactly one build for the profile', async () => {
    const guest = await readyGuest()
    await onShelf(guest)

    const { res, stream } = await watch(guest)

    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform')
    expect(res.headers.get('X-Accel-Buffering')).toBe('no')
    expect(parseFrame((await stream.read(1)).frames[0]!)).toEqual({ event: 'snapshot', data: { status: 'pending' }, comment: null })
    expect(queuedFor(guest)).toHaveLength(1)
    expect(queuedFor(guest)[0]!.body).toMatchObject({ profileId: guest.profileId, waits: 0 })
  })

  it('queues one build, not one per ask, however the verdict is followed or read', async () => {
    const guest = await readyGuest()
    await onShelf(guest)

    await Promise.all([watch(guest), watch(guest)])
    expect(await dataOf(await getVerdict(guest))).toEqual({ status: 'pending' })
    await watch(guest)

    expect(queuedFor(guest)).toHaveLength(1)
  })

  it('sends the verdict, the same body GET answers, when the queued build saves, and then done and closes the stream', async () => {
    const guest = await readyGuest()
    const entryId = await onShelf(guest)
    const { stream } = await watch(guest)
    expect(parseFrame((await stream.read(1)).frames[0]!).data).toEqual({ status: 'pending' })

    await buildQueued(guest)

    const { frames, ended } = await stream.read(3)
    const [verdict, done] = frames.map(parseFrame)
    expect(verdict).toEqual({ event: 'verdict', data: helpingBody(entryId), comment: null })
    expect(done!.event).toBe('done')
    expect(frames).toHaveLength(2)
    expect(ended).toBe(true)
    // The frame is what a client that read GET would hold.
    expect(verdict!.data).toEqual(await dataOf(await getVerdict(guest)))
  })

  it('carries in its frames what a screen shows and nothing of how the rules reached it: the step-down by its code, and no facts, routine step, rule source or audit column', async () => {
    const guest = await readyGuest()
    const steroid = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    await onShelf(guest)
    const { stream } = await watch(guest)
    await stream.read(1)

    await buildQueued(guest)

    const [verdict] = (await stream.read(2)).frames.map(parseFrame)
    expect(verdict!.event).toBe('verdict')
    const view = verdict!.data as ReadyView
    expect(Object.keys(view).sort()).toEqual(['fit', 'products', 'status', 'tapers'])
    expect(view.products.find((product) => product.entryId === steroid)).toEqual({
      entryId: steroid,
      group: 'likely-the-problem',
      verdict: { kind: 'stop', taperCode: STEROID_TAPER },
      reason: expect.any(String),
      escalate: false,
    })
    for (const product of view.products) for (const internal of ['facts', 'step', 'sourceUrls', 'taperTemplateId']) expect(product).not.toHaveProperty(internal)
    expect(view.tapers.map((taper) => taper.code)).toEqual([STEROID_TAPER])
    expect(Object.keys(view.tapers[0]!).sort()).toEqual(['code', 'kind', 'schedule', 'seeAProfessionalIf', 'whatToExpect'])
  })

  describe('when the fit judge fails', () => {
    it('sends the verdict from the rules alone with the fit not ready, leaves the stream open, then sends the retry\'s verdict with the fit ready, then done', async () => {
      const guest = await readyGuest()
      const entryId = await onShelf(guest)
      const { stream } = await watch(guest)
      await stream.read(1)

      await buildWithFitFailing(guest)

      const first = await stream.read(2, QUIET_MS)
      expect(first.frames.map(parseFrame)).toEqual([{ event: 'verdict', data: helpingBody(entryId, 'not-ready'), comment: null }])
      expect(first.ended).toBe(false)

      // The queue hands the same message to the build again, and this time the judge answers.
      await buildQueued(guest)

      const { frames, ended } = await stream.read(3)
      expect(frames.map(parseFrame)).toEqual([
        { event: 'verdict', data: helpingBody(entryId), comment: null },
        { event: 'done', data: {}, comment: null },
      ])
      expect(ended).toBe(true)
    })

    it('sends done after the verdict of the third failed attempt of the day, since the next try is a day away, and closes the stream', async () => {
      const guest = await readyGuest()
      const entryId = await onShelf(guest)
      const { stream } = await watch(guest)
      await stream.read(1)

      await buildWithFitFailingForTheDay(guest)

      const { frames, ended } = await stream.read(5)
      expect(frames.map(parseFrame)).toEqual([
        { event: 'verdict', data: helpingBody(entryId, 'not-ready'), comment: null },
        { event: 'verdict', data: helpingBody(entryId, 'not-ready'), comment: null },
        { event: 'verdict', data: helpingBody(entryId, 'not-ready'), comment: null },
        { event: 'done', data: {}, comment: null },
      ])
      expect(ended).toBe(true)
    })
  })

  describe('following a verdict that is already built', () => {
    it('sends the ready verdict as the snapshot, then done at once and no second copy of the verdict, and queues nothing more', async () => {
      const guest = await readyGuest()
      const entryId = await onShelf(guest)
      await getVerdict(guest)
      await buildQueued(guest)

      const { stream } = await watch(guest)

      const { frames, ended } = await stream.read(3)
      expect(frames.map(parseFrame)).toEqual([
        { event: 'snapshot', data: helpingBody(entryId), comment: null },
        { event: 'done', data: {}, comment: null },
      ])
      expect(ended).toBe(true)
      expect(queuedFor(guest)).toHaveLength(1)
    })

    it('sends the snapshot and then done, and closes the stream, when the fit is not ready and the day\'s attempts are spent, since nothing is coming soon', async () => {
      const guest = await readyGuest()
      const entryId = await onShelf(guest)
      await getVerdict(guest)
      await buildWithFitFailingForTheDay(guest)

      const { stream } = await watch(guest)

      const { frames, ended } = await stream.read(3)
      expect(frames.map(parseFrame)).toEqual([
        { event: 'snapshot', data: helpingBody(entryId, 'not-ready'), comment: null },
        { event: 'done', data: {}, comment: null },
      ])
      expect(ended).toBe(true)
    })

    it('sends the snapshot and keeps the stream open when the fit is not ready and the queue is still to retry it (the first attempt failed)', async () => {
      const guest = await readyGuest()
      const entryId = await onShelf(guest)
      await getVerdict(guest)
      await buildWithFitFailing(guest)

      const { stream } = await watch(guest)

      const { frames, ended } = await stream.read(2, QUIET_MS)
      expect(frames.map(parseFrame)).toEqual([{ event: 'snapshot', data: helpingBody(entryId, 'not-ready'), comment: null }])
      expect(ended).toBe(false)
    })

    it('starts with a pending snapshot, and queues a new build, once the shelf has changed under a ready verdict', async () => {
      const guest = await readyGuest()
      await onShelf(guest)
      await getVerdict(guest)
      await buildQueued(guest)
      await onShelf(guest)

      const { stream } = await watch(guest)

      expect(parseFrame((await stream.read(1)).frames[0]!)).toEqual({ event: 'snapshot', data: { status: 'pending' }, comment: null })
      expect(queuedFor(guest)).toHaveLength(2)
    })
  })

  it('sends one profile\'s verdict to that profile\'s stream only', async () => {
    const amara = await readyGuest()
    const tolu = await readyGuest()
    await onShelf(amara)
    await onShelf(tolu)
    const watchingAmara = await watch(amara)
    const watchingTolu = await watch(tolu)
    await watchingAmara.stream.read(1)
    await watchingTolu.stream.read(1)

    await buildQueued(amara)

    const hers = await watchingAmara.stream.read(3)
    expect(hers.frames.map((frame) => parseFrame(frame).event)).toEqual(['verdict', 'done'])
    const his = await watchingTolu.stream.read(1, QUIET_MS)
    expect(his.frames).toEqual([])
    expect(his.ended).toBe(false)
    // His own build, when it runs, reaches his stream.
    await buildQueued(tolu)
    expect((await watchingTolu.stream.read(3)).frames.map((frame) => parseFrame(frame).event)).toEqual(['verdict', 'done'])
  })
})
