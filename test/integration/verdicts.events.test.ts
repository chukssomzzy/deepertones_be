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
// Each product of a `snapshot` or `verdict` frame carries the shelf entry's own `kind` and `product` (or `noLabel`), as GET /me/shelf shows it: a client following the stream
// reads the verdict without a second call.
// No frame ever carries `facts`, `step`, `sourceUrls`, or a step-down's status and audit columns: the body is the same public one GET answers.
// The errors before the stream starts (401, 503 VERDICT_UNAVAILABLE, 409 GOAL_REQUIRED) are the usual JSON envelopes, in GET's order.
//
// A GUEST never receives the full verdict (owner decision, spec #171), on the stream any more than on GET: a guest follows a stream of the locked preview only, whose
// `snapshot` and every `verdict` frame carry the guest's body `{ status: 'ready', locked: true, fit, groups, total, counts, escalates }` (or `{ status: 'pending' }`), never a
// product, entry id, name, reason or step-down. A verified user's stream carries the full verdict, with `locked: false`. One build publishes to both (`verdict:<profileId>`
// and `verdict-preview:<profileId>`, which the service tests pin; here it is told by what each client reads), and `done` goes to both. The tests that follow the full
// verdict are therefore a verified user's (`readyMember`); the guest's are in the last describe.

const VERDICTS_MAIN = 'deepertones-verdicts-development'
const OTP_QUEUE = 'deepertones-otp-delivery-development'
const ZEPTO_URL = 'https://zeptomail.test/v1.1/email'
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
const otpQueued: unknown[] = []
const WORKER_ENV = {
  ...env,
  OTP_CHANNELS: 'email',
  ZEPTOMAIL_API_URL: ZEPTO_URL,
  ZEPTOMAIL_API_KEY: 'test-key',
  OTP_DELIVERY_QUEUE: { send: async (body: unknown) => void otpQueued.push(body) } as unknown as Queue,
  VERDICTS_QUEUE: verdictsQueue,
  SCAN_ITEMS_QUEUE: quietQueue,
  PARSE_SAFETY_QUEUE: quietQueue,
  PUSH_DELIVERY_QUEUE: quietQueue,
}
const ORIGIN = 'http://deepertones.test'
const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())
const api = hc<AppType>(ORIGIN, { fetch: fetchWorker as typeof fetch })
const v1 = api.api.v1

const opened: SseReader[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  verdictsQueued.length = 0
  otpQueued.length = 0
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
const freshEmail = () => `Verdict-events-${runSalt}-${next()}@Example.com`
const freshBrand = () => `${runSalt}${next()}x VerdictEventsBrand`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number; headers: Headers }
const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}

type PublicProduct = { entryId: string; kind: 'product' | 'no-label'; product?: Record<string, unknown>; noLabel?: Record<string, unknown>; group: string; verdict: { kind: string; taperCode?: string }; reason: string; escalate: boolean }
type ReadyView = { status: 'ready'; locked: false; fit: 'ready' | 'not-ready'; products: PublicProduct[]; tapers: { code: string }[] }
type Groups = { helping: number; redundant: number; blocking: number; conflicting: number; 'likely-the-problem': number; 'cant-tell': number; prescribed: number; undecided: number }
const NO_GROUPS: Groups = { helping: 0, redundant: 0, blocking: 0, conflicting: 0, 'likely-the-problem': 0, 'cant-tell': 0, prescribed: 0, undecided: 0 }

// --- people: a guest of one install ---

const db = createDb(env.DB)
const newGuest = async () => {
  const deviceId = `device-verdict-events-${runSalt}-${next()}`
  const ip = freshIp()
  const res = await v1.auth.anonymous.$post({ json: { deviceId, platform: 'ios' } }, { headers: { 'cf-connecting-ip': ip } })
  const session = await dataOf<{ tokens: { accessToken: string }; user: { id: string } }>(res)
  let token = session.tokens.accessToken
  const profileId = (await new D1ProfilesRepository(db).defaultFor(session.user.id))!.id
  return {
    userId: session.user.id,
    profileId,
    headers: () => ({ 'cf-connecting-ip': ip, Authorization: `Bearer ${token}` }),
    /** Signs the guest up by email, the way a person does; the guest's token is replaced by the verified account's, on the same profile. */
    async signUp() {
      const address = freshEmail()
      const headers = (bearer: string) => ({ 'cf-connecting-ip': ip, Authorization: `Bearer ${bearer}` })
      expect((await v1.auth.otp.send.$post({ json: { channel: 'email', address } }, { headers: headers(token) })).status).toBe(200)
      const verified = await v1.auth.otp.verify.$post({ json: { channel: 'email', address, code: await codeFor() } }, { headers: headers(token) })
      expect(verified.status).toBe(200)
      const after = await dataOf<{ tokens: { accessToken: string }; user: { id: string; status: string } }>(verified)
      expect(after.user).toMatchObject({ id: session.user.id, status: 'verified' })
      token = after.tokens.accessToken
    },
  }
}

/** Delivers the queued code email through the Worker's queue handler and reads the code from it. */
const codeFor = async (): Promise<string> => {
  const body = otpQueued.pop()
  if (!body) throw new Error('no OTP delivery was queued')
  const sent: { textbody: string }[] = []
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) !== ZEPTO_URL) throw new Error(`unexpected outbound request to ${String(url)}`)
    sent.push(JSON.parse(init!.body as string))
    return Response.json({ data: [{ code: 'EM_104', message: 'ok' }], message: 'OK', request_id: 'r' })
  })
  const batch = createMessageBatch(OTP_QUEUE, [{ id: 'm', timestamp: new Date(), attempts: 1, body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, WORKER_ENV, ctx)
  expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['m'])
  vi.unstubAllGlobals()
  const found = /\b(\d{6})\b/.exec(sent[0]!.textbody)?.[1]
  if (!found) throw new Error('no code in the email')
  return found
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
/** The same, signed up: a verified account on the guest's profile, whose stream carries the full verdict. */
const readyMember = async () => {
  const guest = await readyGuest()
  await guest.signUp()
  return guest
}

/** What GET /me/shelf shows of each entry: the independent source for what a verdict product must carry. Read after the shelf is made, by entry id. */
const shelfShows = async (guest: Guest) => {
  const { entries } = await dataOf<{ entries: { id: string; kind: 'product' | 'no-label'; product?: object; noLabel?: object }[] }>(await v1.me.shelf.$get({}, { headers: guest.headers() }))
  return (entryId: string) => {
    const entry = entries.find((candidate) => candidate.id === entryId)
    if (!entry) throw new Error(`entry ${entryId} is not on the shelf`)
    return { kind: entry.kind, ...(entry.product ? { product: entry.product } : {}), ...(entry.noLabel ? { noLabel: entry.noLabel } : {}) }
  }
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
// #259 A2: every ready body also carries `groups` (the fixed headings with counts) and each full product `suggest`; their words are pinned in verdicts.view.test.ts.
const GROUPS = { groups: expect.any(Array) }
// #259 A3: each full product also carries its `basis`, and the full body `professional`; both are pinned in verdicts.routes.test.ts.
const SUGGEST = { suggest: expect.any(Array), basis: expect.any(Array) }
const PROFESSIONAL = { professional: expect.any(Object) }
const helpingBody = (entryId: string, shown: object, fit: 'ready' | 'not-ready' = 'ready') => ({
  status: 'ready',
  locked: false,
  fit,
  ...GROUPS,
  products: [
    fit === 'ready'
      ? { entryId, ...shown, group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false, ...SUGGEST }
      : { entryId, ...shown, group: 'undecided', verdict: { kind: 'keep' }, reason: expect.any(String), escalate: false, ...SUGGEST },
  ],
  tapers: [],
  ...PROFESSIONAL,
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
    const guest = await readyMember()
    const entryId = await onShelf(guest)
    const shows = await shelfShows(guest)
    const { stream } = await watch(guest)
    expect(parseFrame((await stream.read(1)).frames[0]!).data).toEqual({ status: 'pending' })

    await buildQueued(guest)

    const { frames, ended } = await stream.read(3)
    const [verdict, done] = frames.map(parseFrame)
    expect(verdict).toEqual({ event: 'verdict', data: helpingBody(entryId, shows(entryId)), comment: null })
    expect(done!.event).toBe('done')
    expect(frames).toHaveLength(2)
    expect(ended).toBe(true)
    // The frame is what a client that read GET would hold.
    expect(verdict!.data).toEqual(await dataOf(await getVerdict(guest)))
  })

  it('carries in its frames what a screen shows and nothing of how the rules reached it: the step-down by its code, and no facts, routine step, rule source or audit column', async () => {
    const guest = await readyMember()
    const steroid = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    await onShelf(guest)
    const shows = await shelfShows(guest)
    const { stream } = await watch(guest)
    await stream.read(1)

    await buildQueued(guest)

    const [verdict] = (await stream.read(2)).frames.map(parseFrame)
    expect(verdict!.event).toBe('verdict')
    const view = verdict!.data as ReadyView
    expect(Object.keys(view).sort()).toEqual(['fit', 'groups', 'locked', 'products', 'professional', 'status', 'tapers'])
    expect(view.products.find((product) => product.entryId === steroid)).toEqual({
      entryId: steroid,
      ...shows(steroid),
      group: 'likely-the-problem',
      verdict: { kind: 'stop', taperCode: STEROID_TAPER },
      reason: expect.any(String),
      escalate: false,
      ...SUGGEST,
    })
    for (const product of view.products) for (const internal of ['facts', 'step', 'sourceUrls', 'taperTemplateId']) expect(product).not.toHaveProperty(internal)
    expect(view.tapers.map((taper) => taper.code)).toEqual([STEROID_TAPER])
    expect(Object.keys(view.tapers[0]!).sort()).toEqual(['code', 'kind', 'schedule', 'seeAProfessionalIf', 'whatToExpect'])
  })

  describe('when the fit judge fails', () => {
    it('sends the verdict from the rules alone with the fit not ready, leaves the stream open, then sends the retry\'s verdict with the fit ready, then done', async () => {
      const guest = await readyMember()
      const entryId = await onShelf(guest)
      const shows = await shelfShows(guest)
      const { stream } = await watch(guest)
      await stream.read(1)

      await buildWithFitFailing(guest)

      const first = await stream.read(2, QUIET_MS)
      expect(first.frames.map(parseFrame)).toEqual([{ event: 'verdict', data: helpingBody(entryId, shows(entryId), 'not-ready'), comment: null }])
      expect(first.ended).toBe(false)

      // The queue hands the same message to the build again, and this time the judge answers.
      await buildQueued(guest)

      const { frames, ended } = await stream.read(3)
      expect(frames.map(parseFrame)).toEqual([
        { event: 'verdict', data: helpingBody(entryId, shows(entryId)), comment: null },
        { event: 'done', data: {}, comment: null },
      ])
      expect(ended).toBe(true)
    })

    it('sends done after the verdict of the third failed attempt of the day, since the next try is a day away, and closes the stream', async () => {
      const guest = await readyMember()
      const entryId = await onShelf(guest)
      const shows = await shelfShows(guest)
      const { stream } = await watch(guest)
      await stream.read(1)

      await buildWithFitFailingForTheDay(guest)

      const { frames, ended } = await stream.read(5)
      expect(frames.map(parseFrame)).toEqual([
        { event: 'verdict', data: helpingBody(entryId, shows(entryId), 'not-ready'), comment: null },
        { event: 'verdict', data: helpingBody(entryId, shows(entryId), 'not-ready'), comment: null },
        { event: 'verdict', data: helpingBody(entryId, shows(entryId), 'not-ready'), comment: null },
        { event: 'done', data: {}, comment: null },
      ])
      expect(ended).toBe(true)
    })
  })

  describe('following a verdict that is already built', () => {
    it('sends the ready verdict as the snapshot, then done at once and no second copy of the verdict, and queues nothing more', async () => {
      const guest = await readyMember()
      const entryId = await onShelf(guest)
      const shows = await shelfShows(guest)
      await getVerdict(guest)
      await buildQueued(guest)

      const { stream } = await watch(guest)

      const { frames, ended } = await stream.read(3)
      expect(frames.map(parseFrame)).toEqual([
        { event: 'snapshot', data: helpingBody(entryId, shows(entryId)), comment: null },
        { event: 'done', data: {}, comment: null },
      ])
      expect(ended).toBe(true)
      expect(queuedFor(guest)).toHaveLength(1)
    })

    it('sends the snapshot and then done, and closes the stream, when the fit is not ready and the day\'s attempts are spent, since nothing is coming soon', async () => {
      const guest = await readyMember()
      const entryId = await onShelf(guest)
      const shows = await shelfShows(guest)
      await getVerdict(guest)
      await buildWithFitFailingForTheDay(guest)

      const { stream } = await watch(guest)

      const { frames, ended } = await stream.read(3)
      expect(frames.map(parseFrame)).toEqual([
        { event: 'snapshot', data: helpingBody(entryId, shows(entryId), 'not-ready'), comment: null },
        { event: 'done', data: {}, comment: null },
      ])
      expect(ended).toBe(true)
    })

    it('sends the snapshot and keeps the stream open when the fit is not ready and the queue is still to retry it (the first attempt failed)', async () => {
      const guest = await readyMember()
      const entryId = await onShelf(guest)
      const shows = await shelfShows(guest)
      await getVerdict(guest)
      await buildWithFitFailing(guest)

      const { stream } = await watch(guest)

      const { frames, ended } = await stream.read(2, QUIET_MS)
      expect(frames.map(parseFrame)).toEqual([{ event: 'snapshot', data: helpingBody(entryId, shows(entryId), 'not-ready'), comment: null }])
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
    const amara = await readyMember()
    const tolu = await readyMember()
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

describe('GET /api/v1/me/verdict/events: a guest follows the locked preview, never the full verdict', () => {
  /** Everything a member of the same profile would be shown, which a guest's stream must not carry a word of. */
  const hiddenFrom = (full: ReadyView, shows: (entryId: string) => { product?: object }): string[] =>
    [
      ...full.products.flatMap((product) => {
        const shown = shows(product.entryId).product as { brand: string; name: string }
        return [product.entryId, product.reason, shown.brand, shown.name, ...(product.verdict.taperCode ? [product.verdict.taperCode] : [])]
      }),
      ...full.tapers.map((taper) => taper.code),
      STEROID_INGREDIENT,
      'VerdictEventsBrand',
    ].filter((text) => text.length > 0)

  it('sends the preview as the verdict frame when the queued build saves, then done and closes the stream, and not a product, id, name, reason or step-down in any of the raw text', async () => {
    const guest = await readyGuest()
    const steroid = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    const serum = await onShelf(guest)
    const shows = await shelfShows(guest)
    const { stream } = await watch(guest)
    expect(parseFrame((await stream.read(1)).frames[0]!)).toEqual({ event: 'snapshot', data: { status: 'pending' }, comment: null })

    await buildQueued(guest)

    const { frames, ended } = await stream.read(3)
    expect(frames.map(parseFrame)).toEqual([
      {
        event: 'verdict',
        data: { status: 'ready', locked: true, fit: 'ready', ...GROUPS, total: 2, counts: { ...NO_GROUPS, helping: 1, 'likely-the-problem': 1 }, escalates: 0 },
        comment: null,
      },
      { event: 'done', data: {}, comment: null },
    ])
    expect(ended).toBe(true)
    // The independent source for what the frames must not say: the full verdict a member of this profile is shown.
    const raw = frames.join('\n\n')
    await guest.signUp()
    const full = await dataOf<ReadyView>(await getVerdict(guest))
    expect(full.products.map((product) => product.entryId).sort()).toEqual([steroid, serum].sort())
    for (const text of hiddenFrom(full, shows)) expect(raw).not.toContain(text)
    for (const field of ['products', 'tapers', 'entryId', 'reason']) expect(raw).not.toContain(`"${field}"`)
  })

  it('opens with the preview as the snapshot of a verdict that is already built, then done at once, and not a word of any product', async () => {
    const guest = await readyGuest()
    await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    await onShelf(guest)
    const shows = await shelfShows(guest)
    await getVerdict(guest)
    await buildQueued(guest)

    const { stream } = await watch(guest)

    const { frames, ended } = await stream.read(3)
    expect(frames.map(parseFrame)).toEqual([
      {
        event: 'snapshot',
        data: { status: 'ready', locked: true, fit: 'ready', ...GROUPS, total: 2, counts: { ...NO_GROUPS, helping: 1, 'likely-the-problem': 1 }, escalates: 0 },
        comment: null,
      },
      { event: 'done', data: {}, comment: null },
    ])
    expect(ended).toBe(true)
    const raw = frames.join('\n\n')
    await guest.signUp()
    for (const text of hiddenFrom(await dataOf<ReadyView>(await getVerdict(guest)), shows)) expect(raw).not.toContain(text)
  })

  it('sends the preview with the fit not ready and the undecided product counted, leaves the stream open, then the retry\'s preview with the fit ready, then done', async () => {
    const guest = await readyGuest()
    await onShelf(guest)
    const { stream } = await watch(guest)
    await stream.read(1)

    await buildWithFitFailing(guest)

    const first = await stream.read(2, QUIET_MS)
    expect(first.frames.map(parseFrame)).toEqual([
      { event: 'verdict', data: { status: 'ready', locked: true, fit: 'not-ready', ...GROUPS, total: 1, counts: { ...NO_GROUPS, undecided: 1 }, escalates: 0 }, comment: null },
    ])
    expect(first.ended).toBe(false)

    await buildQueued(guest)

    const { frames, ended } = await stream.read(3)
    expect(frames.map(parseFrame)).toEqual([
      { event: 'verdict', data: { status: 'ready', locked: true, fit: 'ready', ...GROUPS, total: 1, counts: { ...NO_GROUPS, helping: 1 }, escalates: 0 }, comment: null },
      { event: 'done', data: {}, comment: null },
    ])
    expect(ended).toBe(true)
  })

  it('is sent the preview while the account it becomes is sent the full verdict, from the same build: one build publishes to both streams', async () => {
    const guest = await readyGuest()
    const entryId = await onShelf(guest)
    const shows = await shelfShows(guest)
    const asGuest = await watch(guest)
    await asGuest.stream.read(1)
    await guest.signUp()
    const asMember = await watch(guest)
    expect(parseFrame((await asMember.stream.read(1)).frames[0]!)).toEqual({ event: 'snapshot', data: { status: 'pending' }, comment: null })

    await buildQueued(guest)

    const members = await asMember.stream.read(3)
    expect(members.frames.map(parseFrame)).toEqual([
      { event: 'verdict', data: helpingBody(entryId, shows(entryId)), comment: null },
      { event: 'done', data: {}, comment: null },
    ])
    const guests = await asGuest.stream.read(3)
    expect(guests.frames.map(parseFrame)).toEqual([
      { event: 'verdict', data: { status: 'ready', locked: true, fit: 'ready', ...GROUPS, total: 1, counts: { ...NO_GROUPS, helping: 1 }, escalates: 0 }, comment: null },
      { event: 'done', data: {}, comment: null },
    ])
    expect(guests.frames.join('\n\n')).not.toContain(entryId)
    expect(queuedFor(guest)).toHaveLength(1)
  })

  it('opens with the full verdict for the same profile once the guest has signed up, with no new build', async () => {
    const guest = await readyGuest()
    const entryId = await onShelf(guest)
    const shows = await shelfShows(guest)
    await getVerdict(guest)
    await buildQueued(guest)
    await guest.signUp()

    const { stream } = await watch(guest)

    const { frames } = await stream.read(3)
    expect(frames.map(parseFrame)).toEqual([
      { event: 'snapshot', data: helpingBody(entryId, shows(entryId)), comment: null },
      { event: 'done', data: {}, comment: null },
    ])
    expect(queuedFor(guest)).toHaveLength(1)
  })
})
