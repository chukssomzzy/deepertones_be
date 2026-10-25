import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
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
import { markedJpeg } from '../../src/modules/scans/scans.photos.fake'
import { profileProducts } from '../../src/modules/shelf/shelf.table'
import { json, messageResponse, textBlock } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'
import { applied, code, ruleRow, taperRow, word } from './admin.catalog.support'

// GET /api/v1/me/verdict (spec #171, D2c) through the Worker's public surface: the typed client for the routes that already exist, the real entrypoint and real
// local D1 under it. The shelf verdict is built the way it is in life: the route queues a `build-verdict` message, the queue handler runs it, and only the
// outbound Anthropic call (the fit judge) is stubbed at fetch. The Worker's verdicts producer is a recorder (a real local queue would hand the message to
// whichever test is running by then), so a test sees exactly the messages the route queued and delivers one by hand. Products reach the shelf as rows put
// straight into profile_products (as verdicts.background.test.ts does); the one product with no label comes by the scan routes, since its item has to exist.
// What a verdict is made of (the labels, the fingerprint, the failure ladder) is the service tests' business; this file is the route's: who may ask, the
// envelope, the gate and the shape of what a client reads.
//
// The step-down templates and the ingredient rules are the workbook's, which is one database for the whole file, so the first describes run in order against
// the state the one before left: no template, then the steroid one alone, then both.
//
// THE PUBLIC SHAPE PINNED HERE (the screen shows the verdict; it never shows how the rules reached it):
//   { status: 'pending' }
//   { status: 'ready', fit: 'ready' | 'not-ready',
//     products: { entryId, group, verdict, reason, escalate, sameJobAs?, nudge? }[],      verdict: { kind: 'keep' } | { kind: 'reduce', maxFrequency }
//                                                                                                  | { kind: 'stop', taperCode } | { kind: 'drop' }
//     tapers: { code, kind, schedule: { fromWeek, toWeek, frequency }[], whatToExpect, seeAProfessionalIf }[] }
// Left out on purpose: `facts` (the rules' own working, with ingredient and rule names: the reason is what the user reads), `step` and `sourceUrls` (the routine's
// inputs, said so by their own type), and a template's status and audit columns (an internal workflow).

const VERDICTS_MAIN = 'deepertones-verdicts-development'
const PARSE_QUEUE = 'deepertones-parse-safety-development'
const SCAN_QUEUE = 'deepertones-scan-items-development'
const OTP_QUEUE = 'deepertones-otp-delivery-development'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ZEPTO_URL = 'https://zeptomail.test/v1.1/email'
const SOURCE_URL = 'https://shop.example/product'
const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
// These flows make several calls, so their answers report a small usage: the day's AI spend cap is not what they test.
const CHEAP_USAGE = { input_tokens: 100, output_tokens: 50 }

type Queued = { body: unknown; delaySeconds: number | undefined }
const verdictsQueued: Queued[] = []
const verdictsQueue = { send: async (body: unknown, options?: { delaySeconds?: number }) => void verdictsQueued.push({ body, delaySeconds: options?.delaySeconds }), sendBatch: async () => {} } as unknown as Queue
const quietQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
const parseQueued: unknown[] = []
const parseQueue = { send: async (body: unknown) => void parseQueued.push(body), sendBatch: async () => {} } as unknown as Queue
const otpQueued: unknown[] = []
const WORKER_ENV = {
  ...env,
  OTP_CHANNELS: 'email',
  ZEPTOMAIL_API_URL: ZEPTO_URL,
  ZEPTOMAIL_API_KEY: 'test-key',
  OTP_DELIVERY_QUEUE: { send: async (body: unknown) => void otpQueued.push(body) } as unknown as Queue,
  VERDICTS_QUEUE: verdictsQueue,
  SCAN_ITEMS_QUEUE: quietQueue,
  PARSE_SAFETY_QUEUE: parseQueue,
  PUSH_DELIVERY_QUEUE: quietQueue,
}
const ORIGIN = 'http://deepertones.test'
const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())
const api = hc<AppType>(ORIGIN, { fetch: fetchWorker as typeof fetch })
const v1 = api.api.v1
const scansApi = v1.scans.products

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  verdictsQueued.length = 0
  otpQueued.length = 0
  parseQueued.length = 0
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshEmail = () => `Verdict-${runSalt}-${next()}@Example.com`
const freshBrand = () => `${runSalt}${next()}x VerdictBrand`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number; headers: Headers }
const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}

type PublicProduct = {
  entryId: string
  group: string
  verdict: { kind: string; maxFrequency?: string; taperCode?: string }
  reason: string
  escalate: boolean
  sameJobAs?: string
  nudge?: string
}
type PublicTaper = { code: string; kind: string; schedule: { fromWeek: number; toWeek: number; frequency: string }[]; whatToExpect: string; seeAProfessionalIf: string }
type ReadyView = { status: 'ready'; fit: 'ready' | 'not-ready'; products: PublicProduct[]; tapers: PublicTaper[] }
type VerdictBody = { status: 'pending' } | ReadyView

// --- people: a guest of one install, and the sign-in that makes the guest an account ---

const db = createDb(env.DB)
const device = () => {
  const deviceId = `device-verdict-${runSalt}-${next()}`
  const ip = freshIp()
  const headers = (bearer?: string): Record<string, string> => ({ 'cf-connecting-ip': ip, ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }) })
  return { deviceId, headers }
}
const newGuest = async () => {
  const d = device()
  const res = await v1.auth.anonymous.$post({ json: { deviceId: d.deviceId, platform: 'ios' } }, { headers: d.headers() })
  const session = await dataOf<{ tokens: { accessToken: string }; user: { id: string } }>(res)
  let token = session.tokens.accessToken
  const profileId = (await new D1ProfilesRepository(db).defaultFor(session.user.id))!.id
  return {
    userId: session.user.id,
    profileId,
    headers: () => d.headers(token),
    /** Signs the guest up by email, the way a person does; the guest's token is replaced by the verified account's. */
    async signUp() {
      const address = freshEmail()
      expect((await v1.auth.otp.send.$post({ json: { channel: 'email', address } }, { headers: d.headers(token) })).status).toBe(200)
      const verified = await v1.auth.otp.verify.$post({ json: { channel: 'email', address, code: await codeFor() } }, { headers: d.headers(token) })
      expect(verified.status).toBe(200)
      const after = await dataOf<{ tokens: { accessToken: string }; user: { id: string; status: string } }>(verified)
      expect(after.user).toMatchObject({ id: session.user.id, status: 'verified' })
      token = after.tokens.accessToken
    },
  }
}
type Guest = Awaited<ReturnType<typeof newGuest>>

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

const putGoal = async (guest: Guest, goal = 'fade-dark-marks') => expect((await v1.me.goal.$put({ json: { goal } as never }, { headers: guest.headers() })).status).toBe(200)
const putSafety = async (guest: Guest, json: Record<string, unknown>) => expect((await v1.me.safety.$put({ json: json as never }, { headers: guest.headers() })).status).toBe(200)

const getVerdict = (guest?: Guest) => v1.me.verdict.$get({}, { headers: guest ? guest.headers() : { 'cf-connecting-ip': freshIp() } })
const queuedFor = (guest: Guest) => verdictsQueued.filter((message) => (message.body as { profileId: string }).profileId === guest.profileId)

// --- the shelf ---

const quietOpsAlerts = () =>
  new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: new MemoryJobQueue(), email: new MemoryEmailSender(), recipient: '', environment: 'test' })
/** A product the catalog holds, researched and analysed, and put on the guest's shelf. Answers the shelf entry's id. */
const onShelf = async (guest: Guest, ingredients: string[] = CLEAN, brand = freshBrand()): Promise<string> => {
  const researcher = new MemoryProductResearcher()
  researcher.respondWith(() => ({ found: true, ingredients, sourceUrl: SOURCE_URL }))
  // The analysis has to cover every flagged fact (a steroid and a mercury compound are), as the model's does.
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

type Item = { id: string; state: string }
type Scan = { id: string; items: Item[] }
let lastAt = 0
const runScanStep = async (itemId: string, step: string) => {
  lastAt = Math.max(Date.now(), lastAt + 1)
  const batch = createMessageBatch(SCAN_QUEUE, [{ id: 'm', timestamp: new Date(), attempts: 1, body: { itemId, step, at: lastAt } }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, WORKER_ENV, ctx)
  expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['m'])
}
const unreadable = () =>
  messageResponse({ content: [textBlock(JSON.stringify({ classification: 'unreadable', brand: '', name: '', variant: '', category: 'other', confidence: 0 }))], usage: CHEAP_USAGE })

/** A product with no label, as the scan routes put one on the shelf: a photo nothing can read three times, then the user describes the product. Answers the entry's id. */
const noLabelOnShelf = async (guest: Guest, purpose: string): Promise<string> => {
  const file = (marker: number) => new File([markedJpeg(marker).bytes], `p${marker}.jpg`, { type: 'image/jpeg' })
  const headers = { headers: guest.headers() }
  const scan = await dataOf<Scan>(await scansApi.$post({ form: { photos: [file(1)] } }, headers))
  const itemId = scan.items[0]!.id
  vi.stubGlobal('fetch', async () => unreadable())
  await runScanStep(itemId, 'recognise')
  for (const marker of [22, 23]) {
    const retake = await scansApi[':scanId'].items[':itemId'].retake.$post({ param: { scanId: scan.id, itemId }, form: { photo: file(marker) } }, headers)
    expect(retake.status).toBe(202)
    await runScanStep(itemId, 'recognise')
  }
  vi.unstubAllGlobals()
  const answered = await scansApi[':scanId'].items[':itemId']['no-label'].$post(
    { param: { scanId: scan.id, itemId }, json: { source: 'market-vendor', purpose, usedFor: '6-months-2-years', description: 'A tub from the market' } as never },
    headers,
  )
  expect(answered.status).toBe(202)
  const shelf = await dataOf<{ entries: { id: string; source: { itemId: string } }[] }>(await v1.me.shelf.$get({}, headers))
  const entry = shelf.entries.find((e) => e.source.itemId === itemId)
  if (!entry) throw new Error('the no-label product is not on the shelf')
  return entry.id
}

// --- the fit judge, stubbed at fetch ---

type Call = { body: any }
/** The fit request the Worker sent, read back out of the prompt. */
const requestOf = (call: Call): { shelf: { id: string; floor: { status: string } }[] } => JSON.parse(String(call.body.messages[0].content[0].text).split('\n').slice(1).join('\n'))
type Say = { label: 'helping' | 'redundant' | 'blocking'; sameJobAs?: string }
/** The judge answers for each open product as `says` has it (anything not named helps), with the reason `Reason: <label>.`. */
const stubFit = (says: Record<string, Say> = {}) => {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== ANTHROPIC_URL) return new Response('not found', { status: 404 })
    const call = { body: JSON.parse(init!.body as string) }
    calls.push(call)
    const products = requestOf(call)
      .shelf.filter((p) => p.floor.status === 'open')
      .map((p) => {
        const say = says[p.id] ?? { label: 'helping' }
        return { id: p.id, label: say.label, reason: `Reason: ${say.label}.`, sameJobAs: say.sameJobAs ?? null }
      })
    return messageResponse({ content: [textBlock(JSON.stringify({ products, clashes: [] }))], usage: CHEAP_USAGE })
  })
  return calls
}

/** Delivers the build message the route queued for this guest to the Worker's queue handler. */
const buildQueued = async (guest: Guest, says?: Record<string, Say>) => {
  const message = queuedFor(guest).at(-1)
  if (!message) throw new Error('the route queued no build')
  const calls = stubFit(says)
  const batch = createMessageBatch(VERDICTS_MAIN, [{ id: 'm', timestamp: new Date(), attempts: 1, body: message.body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, WORKER_ENV, ctx)
  expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['m'])
  vi.unstubAllGlobals()
  return calls
}

// --- the workbook: step-down templates and the rules the floor reads, put in the way the team does, through the admin import ---

const STEROID_TAPER = code('TPR-STEROID')
const LIGHTENING_TAPER = code('TPR-LIGHTENING')
const STEROID_INGREDIENT = `${word('zq')} corticoidum`
const MERCURY_INGREDIENT = `${word('zq')} hydrargyrum`
const WHAT_TO_EXPECT = 'Skin may flare or look redder for a few days after each step down. This is expected and passes.'
const SEE_A_PROFESSIONAL_IF = 'The redness spreads, the skin weeps or blisters, or you feel unwell.'

describe('GET /api/v1/me/verdict: who may ask', () => {
  it('answers 401 AUTH_REQUIRED without a session', async () => {
    const res = await getVerdict()

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ success: false, status: 401, error: { code: 'AUTH_REQUIRED' } })
  })
})

describe('GET /api/v1/me/verdict: before both step-down templates are approved', () => {
  it('answers 503 VERDICT_UNAVAILABLE with the failure envelope while no template is approved, even for a profile with no goal, and queues nothing', async () => {
    const guest = await newGuest()

    const res = await getVerdict(guest)

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ success: false, status: 503, error: { code: 'VERDICT_UNAVAILABLE' } })
    expect(queuedFor(guest)).toEqual([])
  })

  it('still answers 503 VERDICT_UNAVAILABLE with only the steroid template approved, for a profile with a goal and a shelf, and queues nothing', async () => {
    await applied((workbook) => {
      workbook.tapers.rows.push(taperRow({ code: STEROID_TAPER, kind: 'steroid' }))
    })
    const guest = await newGuest()
    await putGoal(guest)
    await onShelf(guest)

    const res = await getVerdict(guest)

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ success: false, status: 503, error: { code: 'VERDICT_UNAVAILABLE' } })
    expect(queuedFor(guest)).toEqual([])
  })
})

describe('GET /api/v1/me/verdict: with both step-down templates approved', () => {
  beforeAll(async () => {
    await applied((workbook) => {
      workbook.tapers.rows.push(taperRow({ code: LIGHTENING_TAPER, kind: 'lightening-agent' }))
      workbook.ingredients.rows.push(
        ruleRow({ name: STEROID_INGREDIENT, kind: 'banned-substance', group: 'steroid', statement: 'A topical steroid.' }),
        ruleRow({ name: MERCURY_INGREDIENT, kind: 'banned-substance', group: 'mercury', statement: 'A mercury compound.' }),
      )
    })
  })

  it('answers 409 GOAL_REQUIRED with the failure envelope for a profile with no goal, and queues nothing', async () => {
    const guest = await newGuest()
    await onShelf(guest)

    const res = await getVerdict(guest)

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, status: 409, error: { code: 'GOAL_REQUIRED' } })
    expect(queuedFor(guest)).toEqual([])
  })

  it('answers 200 pending in the success envelope on the first ask with a goal and a shelf, queues exactly one build for the profile, and queues no second on the next ask', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    await onShelf(guest)

    const first = await getVerdict(guest)

    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ success: true, status: 200, message: expect.any(String), data: { status: 'pending' } })
    expect(queuedFor(guest)).toHaveLength(1)
    expect(queuedFor(guest)[0]!.body).toMatchObject({ profileId: guest.profileId, waits: 0 })

    const second = await getVerdict(guest)

    expect(second.status).toBe(200)
    expect(await dataOf(second)).toEqual({ status: 'pending' })
    expect(queuedFor(guest)).toHaveLength(1)
  })

  it('answers 200 ready once the queued build has run, with the fit judge called once for the shelf, and keeps answering the same without a new build', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const entryId = await onShelf(guest)
    await getVerdict(guest)

    const calls = await buildQueued(guest)

    expect(calls).toHaveLength(1)
    const res = await getVerdict(guest)
    expect(res.status).toBe(200)
    const view = await dataOf<VerdictBody>(res)
    expect(view).toEqual({
      status: 'ready',
      fit: 'ready',
      products: [{ entryId, group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false }],
      tapers: [],
    })
    expect(await dataOf(await getVerdict(guest))).toEqual(view)
    expect(queuedFor(guest)).toHaveLength(1)
  })

  it('shows each product by its entry id, group, verdict, reason and escalation, and the step-down it uses by its code, schedule, what to expect and when to see a professional', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const steroid = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    const mercury = await onShelf(guest, [...CLEAN, MERCURY_INGREDIENT])
    const helping = await onShelf(guest)
    const twin = await onShelf(guest)
    const unlabelled = await noLabelOnShelf(guest, 'moisturise')
    await getVerdict(guest)

    await buildQueued(guest, { [twin]: { label: 'redundant', sameJobAs: helping } })

    const view = await dataOf<ReadyView>(await getVerdict(guest))
    expect(Object.keys(view).sort()).toEqual(['fit', 'products', 'status', 'tapers'])
    expect(view).toMatchObject({ status: 'ready', fit: 'ready' })
    const byId = new Map(view.products.map((product) => [product.entryId, product]))
    expect([...byId.keys()].sort()).toEqual([steroid, mercury, helping, twin, unlabelled].sort())

    // A steroid stops with its kind's step-down, named by the template's code, with no escalation.
    expect(byId.get(steroid)).toEqual({ entryId: steroid, group: 'likely-the-problem', verdict: { kind: 'stop', taperCode: STEROID_TAPER }, reason: expect.any(String), escalate: false })
    // Mercury stops at once, with no step-down, and routes to a professional.
    expect(byId.get(mercury)).toEqual({ entryId: mercury, group: 'likely-the-problem', verdict: { kind: 'drop' }, reason: expect.any(String), escalate: true })
    // The judge's words are the reason as given, and a redundant product names the product that stays and does its job.
    expect(byId.get(helping)).toEqual({ entryId: helping, group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false })
    expect(byId.get(twin)).toEqual({ entryId: twin, group: 'redundant', verdict: { kind: 'drop' }, reason: 'Reason: redundant.', escalate: false, sameJobAs: helping })
    // A product nothing could be read from is set aside with the nudge to photograph the back label.
    expect(byId.get(unlabelled)).toEqual({ entryId: unlabelled, group: 'cant-tell', verdict: { kind: 'drop' }, reason: expect.any(String), escalate: false, nudge: 'photograph-back-label' })
    for (const product of view.products) expect(product.reason.length).toBeGreaterThan(0)

    // Only the template a stopped product uses comes with it (taperRow's schedule is '1-2: alternate-days; 3-4: weekly; 5: stop').
    expect(view.tapers).toEqual([
      {
        code: STEROID_TAPER,
        kind: 'steroid',
        schedule: [
          { fromWeek: 1, toWeek: 2, frequency: 'alternate-days' },
          { fromWeek: 3, toWeek: 4, frequency: 'weekly' },
          { fromWeek: 5, toWeek: 5, frequency: 'stop' },
        ],
        whatToExpect: WHAT_TO_EXPECT,
        seeAProfessionalIf: SEE_A_PROFESSIONAL_IF,
      },
    ])
  })

  it('does not show how the rules reached a verdict: no facts, routine step or rule source on a product, and no status or audit column on a step-down', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const steroid = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    await onShelf(guest)
    await getVerdict(guest)
    await buildQueued(guest)

    const view = await dataOf<ReadyView>(await getVerdict(guest))

    expect(view.products).toHaveLength(2)
    for (const product of view.products) {
      for (const internal of ['facts', 'step', 'sourceUrls']) expect(product).not.toHaveProperty(internal)
    }
    expect(view.tapers).toHaveLength(1)
    for (const internal of ['status', 'approvedBy', 'approvedOn', 'auditedBy', 'auditedOn']) expect(view.tapers[0]).not.toHaveProperty(internal)
    // The reason is what the user reads, and it names the ingredient that made the product a problem (that is wanted), however the words are cased.
    expect(view.products.find((product) => product.entryId === steroid)!.reason.toLowerCase()).toContain(STEROID_INGREDIENT.toLowerCase())
  })
})

describe('GET /api/v1/me/verdict: a guest who signs up', () => {
  it('gets the verdict the guest had, as it was, with no new build: promotion keeps the profile', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    await onShelf(guest)
    await getVerdict(guest)
    await buildQueued(guest)
    const asGuest = await dataOf<ReadyView>(await getVerdict(guest))
    expect(asGuest.status).toBe('ready')
    const queuedBefore = queuedFor(guest).length

    await guest.signUp()

    const res = await getVerdict(guest)
    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual(asGuest)
    expect(queuedFor(guest)).toHaveLength(queuedBefore)
  })
})

// --- the other shapes a client can read ---

/** The fit judge failing the way the model's own overload does: the build saves the floor alone and throws for the queue to retry. */
const buildWithFitFailing = async (guest: Guest) => {
  const message = queuedFor(guest).at(-1)
  if (!message) throw new Error('the route queued no build')
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
    String(input) === ANTHROPIC_URL ? json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 529) : new Response('not found', { status: 404 }),
  )
  const batch = createMessageBatch(VERDICTS_MAIN, [{ id: 'm', timestamp: new Date(), attempts: 1, body: message.body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, WORKER_ENV, ctx)
  expect((await getQueueResult(batch, ctx)).retryMessages).toEqual([{ msgId: 'm' }])
  vi.unstubAllGlobals()
}

/** Runs the queued parse of the guest's safety words, the reader finding the one product (by brand) the words name. The catalog resolves it to the product on the shelf. */
const parseNamedProduct = async (brand: string) => {
  const body = parseQueued.at(-1)
  if (!body) throw new Error('the safety answer queued no parse')
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== ANTHROPIC_URL) return new Response('not found', { status: 404 })
    const properties = Object.keys(JSON.parse(init!.body as string).output_config?.format?.schema?.properties ?? {})
    const answer = properties.includes('mentions')
      ? { mentions: [{ kind: 'product', brand, name: brand, variant: '', category: 'skin' }] }
      : properties.includes('same')
        ? { same: false }
        : null
    if (answer === null) throw new Error('unexpected request while parsing the safety words')
    return messageResponse({ content: [textBlock(JSON.stringify(answer))], usage: CHEAP_USAGE })
  })
  const batch = createMessageBatch(PARSE_QUEUE, [{ id: 'm', timestamp: new Date(), attempts: 1, body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, WORKER_ENV, ctx)
  expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['m'])
  vi.unstubAllGlobals()
}

// These run after the describes above, which left both step-down templates approved in the shared workbook; their clashing rules have names of their own.
const RETINOID_INGREDIENT = `${word('zq')} retinoidum`
const ACID_INGREDIENT = `${word('zq')} acidum`

describe('GET /api/v1/me/verdict: the other shapes of a ready verdict', () => {
  beforeAll(async () => {
    await applied((workbook) => {
      workbook.ingredients.rows.push(
        ruleRow({ name: RETINOID_INGREDIENT, kind: 'irritation', group: 'retinoid', clashes_with: 'exfoliating-acid' }),
        ruleRow({ name: ACID_INGREDIENT, kind: 'irritation', group: 'exfoliating-acid', clashes_with: 'retinoid' }),
      )
    })
  })

  it('answers ready with the fit not ready and the open product undecided and kept, once the judge has failed and the verdict was saved from the rules alone', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const entryId = await onShelf(guest)
    await getVerdict(guest)

    await buildWithFitFailing(guest)

    const res = await getVerdict(guest)
    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({
      status: 'ready',
      fit: 'not-ready',
      products: [{ entryId, group: 'undecided', verdict: { kind: 'keep' }, reason: expect.any(String), escalate: false }],
      tapers: [],
    })
  })

  it('shows one product of a clashing pair as conflicting, reduced to alternate days, and the other as the judge left it', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const retinoid = await onShelf(guest, [...CLEAN, RETINOID_INGREDIENT])
    const acid = await onShelf(guest, [...CLEAN, ACID_INGREDIENT])
    await getVerdict(guest)

    await buildQueued(guest)

    const view = await dataOf<ReadyView>(await getVerdict(guest))
    expect(view).toMatchObject({ status: 'ready', fit: 'ready', tapers: [] })
    const byId = new Map(view.products.map((product) => [product.entryId, product]))
    // The judge named no pick, so the floor's tie-break reduces the add-on (the acid) before the treatment.
    expect(byId.get(acid)).toEqual({ entryId: acid, group: 'conflicting', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' }, reason: expect.any(String), escalate: false })
    expect(byId.get(acid)!.reason.length).toBeGreaterThan(0)
    expect(byId.get(retinoid)).toEqual({ entryId: retinoid, group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false })
  })

  it('shows a product the user said a doctor prescribed as prescribed and kept, whatever the rules would say of its ingredients', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    const brand = freshBrand()
    const entryId = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT], brand)
    await putSafety(guest, { choices: ['prescription'], prescriptionText: `${brand} from my dermatologist` })
    await parseNamedProduct(brand)
    await getVerdict(guest)

    await buildQueued(guest)

    const view = await dataOf<ReadyView>(await getVerdict(guest))
    expect(view).toEqual({
      status: 'ready',
      fit: 'ready',
      products: [{ entryId, group: 'prescribed', verdict: { kind: 'keep' }, reason: expect.any(String), escalate: false }],
      tapers: [],
    })
  })

  it('answers pending again, and queues a new build, once the shelf has changed under a ready verdict', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    await onShelf(guest)
    await getVerdict(guest)
    await buildQueued(guest)
    expect(await dataOf(await getVerdict(guest))).toMatchObject({ status: 'ready' })
    expect(queuedFor(guest)).toHaveLength(1)

    await onShelf(guest)

    const res = await getVerdict(guest)
    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ status: 'pending' })
    expect(queuedFor(guest)).toHaveLength(2)
  })
})
