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
import { FORBIDDEN_WORDING } from '../../src/modules/routines/routines.wording'
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
// A GUEST (status 'anonymous') never receives the full verdict (owner decision): it is given the locked preview, the counts the app's "Your result" screen needs and
// a prompt to save the result. A VERIFIED user gets the full verdict, with `locked: false`. It is one build and one saved row read two ways: signing up (the guest
// verifies by the OTP flow, which keeps the profile) shows the full verdict at once, with no new build. The tests that read the full verdict therefore sign the guest up
// first (`newMember`); the gates and `pending` are the same for both, and are tested with a guest.
//
// THE PUBLIC SHAPE PINNED HERE (the screen shows the verdict; it never shows how the rules reached it):
//   { status: 'pending' }
//   guest:    { status: 'ready', locked: true, fit, total, counts: { helping, redundant, blocking, conflicting, 'likely-the-problem', 'cant-tell', prescribed, undecided }, escalates }
//             (counts has every group, 0 where none; total is how many skin products; escalates is how many carry `escalate`; no products, tapers, ids, names or reasons)
//   verified: { status: 'ready', locked: false, fit: 'ready' | 'not-ready',
//     products: { entryId, kind, product? | noLabel?, group, verdict, reason, escalate, sameJobAs?, nudge? }[],      verdict: { kind: 'keep' } | { kind: 'reduce', maxFrequency }
//                                                                                                  | { kind: 'stop', taperCode } | { kind: 'drop' }
//     tapers: { code, kind, schedule: { fromWeek, toWeek, frequency }[], whatToExpect, seeAProfessionalIf }[] }
// `kind` and `product` (a `product` entry) or `noLabel` (a `no-label` one) are the shelf entry's own, exactly as GET /me/shelf and GET /me/shelf/{entryId} show it, so the
// verdict reads without a second call. They are joined when the verdict is read; the saved verdict and its fingerprint do not hold them.
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
const emailQueued: unknown[] = []
const WORKER_ENV = {
  ...env,
  OTP_CHANNELS: 'email',
  ZEPTOMAIL_API_URL: ZEPTO_URL,
  ZEPTOMAIL_API_KEY: 'test-key',
  OTP_DELIVERY_QUEUE: { send: async (body: unknown) => void otpQueued.push(body) } as unknown as Queue,
  VERDICTS_QUEUE: verdictsQueue,
  SCAN_ITEMS_QUEUE: quietQueue,
  PARSE_SAFETY_QUEUE: parseQueue,
  EMAIL_QUEUE: { send: async (body: unknown) => void emailQueued.push(body), sendBatch: async () => {} } as unknown as Queue,
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
  emailQueued.length = 0
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
  kind: 'product' | 'no-label'
  product?: Record<string, unknown>
  noLabel?: Record<string, unknown>
  group: string
  verdict: { kind: string; maxFrequency?: string; taperCode?: string }
  reason: string
  escalate: boolean
  sameJobAs?: string
  nudge?: string
  suggest: string[]
}
type PublicTaper = { code: string; kind: string; schedule: { fromWeek: number; toWeek: number; frequency: string }[]; whatToExpect: string; seeAProfessionalIf: string }
type ReadyView = { status: 'ready'; locked: false; fit: 'ready' | 'not-ready'; groups: GroupEntry[]; products: PublicProduct[]; tapers: PublicTaper[] }
type Groups = { helping: number; redundant: number; blocking: number; conflicting: number; 'likely-the-problem': number; 'cant-tell': number; prescribed: number; undecided: number }
type LockedView = { status: 'ready'; locked: true; fit: 'ready' | 'not-ready'; groups: GroupEntry[]; total: number; counts: Groups; escalates: number }
type VerdictBody = { status: 'pending' } | ReadyView | LockedView
const NO_GROUPS: Groups = { helping: 0, redundant: 0, blocking: 0, conflicting: 0, 'likely-the-problem': 0, 'cant-tell': 0, prescribed: 0, undecided: 0 }
// #259 A2: every ready verdict also carries `groups` (the screen's headings, fixed copy) and every product `suggest` (what to do, fixed lines). The tests below that
// compare a whole body say only that they are there; what they hold is pinned by the tests of their own further down and by verdicts.view.test.ts.
const GROUP_ORDER = ['likely-the-problem', 'conflicting', 'cant-tell', 'blocking', 'redundant', 'helping', 'prescribed', 'undecided'] as const
const SUGGEST = { suggest: expect.any(Array) }
const GROUPS = { groups: expect.any(Array) }
type GroupEntry = { group: string; title: string; subtitle: string; intro: string; count: number }
const gateTrips = (text: string) => FORBIDDEN_WORDING.filter(({ pattern }) => pattern.test(text)).map(({ code: reason }) => reason)
const countsByGroup = (groups: GroupEntry[]) => Object.fromEntries(groups.map(({ group, count }) => [group, count]))

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
/** A guest who has already signed up: a verified account, on the same profile the guest had. The full verdict is read by these. */
const newMember = async (): Promise<Guest> => {
  const guest = await newGuest()
  await guest.signUp()
  return guest
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

const putGoal = async (guest: Guest, goal = 'fade-dark-marks') => expect((await v1.me.goal.$put({ json: { goal } as never }, { headers: guest.headers() })).status).toBe(200)
const putSafety = async (guest: Guest, json: Record<string, unknown>) => expect((await v1.me.safety.$put({ json: json as never }, { headers: guest.headers() })).status).toBe(200)

/** What GET /me/shelf shows of each entry: the independent source for what a verdict product must carry. Read after the shelf is made, by entry id. */
const shelfShows = async (guest: Guest) => {
  const { entries } = await dataOf<{ entries: { id: string; kind: 'product' | 'no-label'; product?: object; noLabel?: object }[] }>(await v1.me.shelf.$get({}, { headers: guest.headers() }))
  return (entryId: string) => {
    const entry = entries.find((candidate) => candidate.id === entryId)
    if (!entry) throw new Error(`entry ${entryId} is not on the shelf`)
    return { kind: entry.kind, ...(entry.product ? { product: entry.product } : {}), ...(entry.noLabel ? { noLabel: entry.noLabel } : {}) }
  }
}
/** The route this change adds, read with plain fetch: the typed client has no call for it until it exists. */
const getEntry = (guest: Guest, entryId: string) => fetchWorker(`${ORIGIN}/api/v1/me/shelf/${entryId}`, { headers: guest.headers() })

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
    const guest = await newMember()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const entryId = await onShelf(guest)
    const shows = await shelfShows(guest)
    await getVerdict(guest)

    const calls = await buildQueued(guest)

    expect(calls).toHaveLength(1)
    const res = await getVerdict(guest)
    expect(res.status).toBe(200)
    const view = await dataOf<VerdictBody>(res)
    expect(view).toEqual({
      status: 'ready',
      locked: false,
      fit: 'ready',
      ...GROUPS,
      products: [{ entryId, ...shows(entryId), group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false, ...SUGGEST }],
      tapers: [],
    })
    expect(await dataOf(await getVerdict(guest))).toEqual(view)
    expect(queuedFor(guest)).toHaveLength(1)
  })

  it('shows each product by its entry id, group, verdict, reason and escalation, and the step-down it uses by its code, schedule, what to expect and when to see a professional', async () => {
    const guest = await newMember()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const steroid = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    const mercury = await onShelf(guest, [...CLEAN, MERCURY_INGREDIENT])
    const helping = await onShelf(guest)
    const twin = await onShelf(guest)
    const unlabelled = await noLabelOnShelf(guest, 'moisturise')
    const shows = await shelfShows(guest)
    await getVerdict(guest)

    await buildQueued(guest, { [twin]: { label: 'redundant', sameJobAs: helping } })

    const view = await dataOf<ReadyView>(await getVerdict(guest))
    expect(Object.keys(view).sort()).toEqual(['fit', 'groups', 'locked', 'products', 'status', 'tapers'])
    expect(view).toMatchObject({ status: 'ready', locked: false, fit: 'ready' })
    const byId = new Map(view.products.map((product) => [product.entryId, product]))
    expect([...byId.keys()].sort()).toEqual([steroid, mercury, helping, twin, unlabelled].sort())

    // A steroid stops with its kind's step-down, named by the template's code, with no escalation.
    expect(byId.get(steroid)).toEqual({ entryId: steroid, ...shows(steroid), group: 'likely-the-problem', verdict: { kind: 'stop', taperCode: STEROID_TAPER }, reason: expect.any(String), escalate: false, ...SUGGEST })
    // Mercury stops at once, with no step-down, and routes to a professional.
    expect(byId.get(mercury)).toEqual({ entryId: mercury, ...shows(mercury), group: 'likely-the-problem', verdict: { kind: 'drop' }, reason: expect.any(String), escalate: true, ...SUGGEST })
    // The judge's words are the reason as given, and a redundant product names the product that stays and does its job.
    expect(byId.get(helping)).toEqual({ entryId: helping, ...shows(helping), group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false, ...SUGGEST })
    expect(byId.get(twin)).toEqual({ entryId: twin, ...shows(twin), group: 'redundant', verdict: { kind: 'drop' }, reason: 'Reason: redundant.', escalate: false, sameJobAs: helping, ...SUGGEST })
    // A product nothing could be read from is set aside with the nudge to photograph the back label.
    expect(byId.get(unlabelled)).toEqual({ entryId: unlabelled, ...shows(unlabelled), group: 'cant-tell', verdict: { kind: 'drop' }, reason: expect.any(String), escalate: false, nudge: 'photograph-back-label', ...SUGGEST })
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
    const guest = await newMember()
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

describe('GET /api/v1/me/verdict: the groups and the suggested lines of the full verdict (#259 A2)', () => {
  /** A member whose shelf holds a steroid cream, a mercury cream, a serum, its twin and a tub with no label, and whose verdict has been built. Answers the entry ids. */
  const builtMemberShelf = async () => {
    const guest = await newMember()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const steroid = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    const mercury = await onShelf(guest, [...CLEAN, MERCURY_INGREDIENT])
    const helping = await onShelf(guest)
    const twin = await onShelf(guest)
    const unlabelled = await noLabelOnShelf(guest, 'moisturise')
    await getVerdict(guest)
    await buildQueued(guest, { [twin]: { label: 'redundant', sameJobAs: helping } })
    return { guest, steroid, mercury, helping, twin, unlabelled }
  }

  it('lists all eight groups in the owner\'s order with the number of products in each, the empty ones at 0', async () => {
    const { guest } = await builtMemberShelf()

    const view = await dataOf<ReadyView>(await getVerdict(guest))

    expect(view.groups.map(({ group }) => group)).toEqual([...GROUP_ORDER])
    // steroid cream and mercury cream (likely-the-problem), the serum (helping), its twin (redundant), the tub nothing could be read from (cant-tell).
    expect(countsByGroup(view.groups)).toEqual({ ...NO_GROUPS, 'likely-the-problem': 2, helping: 1, redundant: 1, 'cant-tell': 1 })
    expect(countsByGroup(view.groups)).toEqual(Object.fromEntries(GROUP_ORDER.map((group) => [group, view.products.filter((product) => product.group === group).length])))
  })

  it('gives each group its title, subtitle and intro as fixed words, the same on every ask, with titles and subtitles as the owner\'s screen has them', async () => {
    const { guest } = await builtMemberShelf()

    const view = await dataOf<ReadyView>(await getVerdict(guest))

    for (const entry of view.groups) {
      expect(Object.keys(entry).sort(), entry.group).toEqual(['count', 'group', 'intro', 'subtitle', 'title'])
      for (const text of [entry.title, entry.subtitle, entry.intro]) expect(text.trim().length, entry.group).toBeGreaterThan(0)
      for (const text of [entry.title, entry.subtitle, entry.intro]) expect(gateTrips(text), `${entry.group}: "${text}"`).toEqual([])
    }
    const byGroup = new Map(view.groups.map((entry) => [entry.group, entry]))
    expect(byGroup.get('helping')).toMatchObject({ title: 'Helping', subtitle: 'Working toward your goal' })
    expect(byGroup.get('redundant')).toMatchObject({ title: 'Redundant', subtitle: 'Doing the same job as another' })
    expect(byGroup.get('blocking')).toMatchObject({ title: 'Blocking your goal', subtitle: 'Holding your goal back' })
    expect(byGroup.get('conflicting')).toMatchObject({ title: 'Conflicting', subtitle: "Don't work well together" })
    expect(byGroup.get('likely-the-problem')).toMatchObject({ title: 'Likely the problem', subtitle: "What's causing trouble" })
    expect(byGroup.get('undecided')).toMatchObject({ title: 'Still checking' })
    expect(await dataOf<ReadyView>(await getVerdict(guest))).toEqual(view)
  })

  it('suggests what to do with each product from its verdict: keep, step down by its kind, stop now (with a professional when it escalates), and photograph the back label of a can\'t-tell one', async () => {
    const { guest, steroid, mercury, helping, twin, unlabelled } = await builtMemberShelf()

    const view = await dataOf<ReadyView>(await getVerdict(guest))

    const lines = (entryId: string) => view.products.find((product) => product.entryId === entryId)!.suggest
    for (const product of view.products) {
      expect(product.suggest.length, product.group).toBeGreaterThanOrEqual(1)
      expect(product.suggest.length, product.group).toBeLessThanOrEqual(3)
      for (const line of product.suggest) {
        expect(line.trim().length).toBeGreaterThan(0)
        expect(gateTrips(line), `"${line}"`).toEqual([])
      }
    }
    expect(lines(helping)).toHaveLength(1)
    // The steroid is stopped by its step-down: named by its kind, and never stopped suddenly.
    expect(lines(steroid).join(' ')).toMatch(/steroid/i)
    expect(lines(steroid).join(' ')).toMatch(/\b(?:never|don't|do not)\b[^.]*\b(?:suddenly|abruptly|all at once)\b/i)
    // Mercury is stopped at once and goes to a professional; the redundant twin is stopped at once and does not.
    expect(lines(mercury).join(' ')).toMatch(/\bstop\b/i)
    expect(lines(mercury).join(' ')).toMatch(/professional/i)
    expect(lines(twin).join(' ')).toMatch(/\bstop\b/i)
    expect(lines(twin).join(' ')).not.toMatch(/professional/i)
    // The tub nothing could be read from is asked to be photographed; no other product is.
    expect(lines(unlabelled).join(' ')).toMatch(/photograph/i)
    for (const other of [steroid, mercury, helping, twin]) expect(lines(other).join(' ')).not.toMatch(/photograph/i)
  })

  it('answers pending with no groups for a member whose verdict is not built yet', async () => {
    const guest = await newMember()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    await onShelf(guest)

    const body = await dataOf<Record<string, unknown>>(await getVerdict(guest))

    expect(body).toEqual({ status: 'pending' })
    expect(body).not.toHaveProperty('groups')
  })
})

describe('GET /api/v1/me/verdict: the shelf entry\'s product on each verdict product', () => {
  it('gives each product exactly the kind and the product or noLabel that GET /me/shelf/{entryId} gives for its entry, so the verdict reads without a second call', async () => {
    const guest = await newMember()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const named = await onShelf(guest)
    const other = await onShelf(guest)
    const unlabelled = await noLabelOnShelf(guest, 'moisturise')
    await getVerdict(guest)
    await buildQueued(guest)

    const view = await dataOf<ReadyView>(await getVerdict(guest))

    expect(view.products.map((product) => product.entryId).sort()).toEqual([named, other, unlabelled].sort())
    for (const item of view.products) {
      const res = await getEntry(guest, item.entryId)
      expect(res.status).toBe(200)
      const entry = await dataOf<{ kind: string; product?: unknown; noLabel?: unknown }>(res)
      expect(item.kind).toBe(entry.kind)
      expect(item.product).toEqual(entry.product)
      expect(item.noLabel).toEqual(entry.noLabel)
    }
    const byId = new Map(view.products.map((product) => [product.entryId, product]))
    // A named product shows its summary and no noLabel; one with no label shows what the user said of it and no product.
    expect(byId.get(named)).toMatchObject({ kind: 'product', product: { kind: 'named', category: 'skin' } })
    expect(byId.get(named)).not.toHaveProperty('noLabel')
    expect(byId.get(unlabelled)).toMatchObject({ kind: 'no-label', noLabel: { purpose: 'moisturise', source: 'market-vendor', usedFor: '6-months-2-years', description: 'A tub from the market' } })
    expect(byId.get(unlabelled)).not.toHaveProperty('product')
    // The body has the same top-level shape as before: the product's fields sit on each product, not beside the verdict.
    expect(Object.keys(view).sort()).toEqual(['fit', 'groups', 'locked', 'products', 'status', 'tapers'])
  })

  it('still gives only the fields it names: the product adds none of how the rules reached a verdict', async () => {
    const guest = await newMember()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    await onShelf(guest)
    await getVerdict(guest)
    await buildQueued(guest)

    const [item] = (await dataOf<ReadyView>(await getVerdict(guest))).products

    expect(Object.keys(item!).sort()).toEqual(['entryId', 'escalate', 'group', 'kind', 'product', 'reason', 'suggest', 'verdict'])
  })

  it('reads the product when it is asked, with no new build: it is not what the verdict was built from', async () => {
    const guest = await newMember()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const entryId = await onShelf(guest)
    await getVerdict(guest)
    await buildQueued(guest)
    const before = await dataOf<ReadyView>(await getVerdict(guest))

    const again = await dataOf<ReadyView>(await getVerdict(guest))

    expect(again).toEqual(before)
    expect(again.products[0]!.product).toEqual((await dataOf<{ product: unknown }>(await getEntry(guest, entryId))).product)
    expect(queuedFor(guest)).toHaveLength(1)
  })
})

/** Every string of the full verdict a guest must never be sent: ids, names, the reasons, the step-down, and the words the product carries. */
const privateTo = (shelf: (entryId: string) => { product?: object; noLabel?: object }, full: ReadyView): string[] => [
  ...full.products.flatMap((product) => [product.entryId, product.reason, ...(product.verdict.taperCode ? [product.verdict.taperCode] : [])]),
  ...full.products.flatMap((product) => {
    const shown = shelf(product.entryId).product as { brand?: string; name?: string } | undefined
    return shown ? [shown.brand ?? '', shown.name ?? ''] : []
  }),
  ...full.tapers.flatMap((taper) => [taper.code, taper.whatToExpect, taper.seeAProfessionalIf]),
  STEROID_INGREDIENT,
  'VerdictBrand',
  'A tub from the market',
  'photograph-back-label',
].filter((text) => text.length > 0)

describe('GET /api/v1/me/verdict: a guest is given the locked preview, never the full verdict', () => {
  /** A guest whose shelf holds a steroid cream, a mercury cream, a serum, its twin and a tub with no label, and whose verdict has been built. */
  const builtShelf = async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    await onShelf(guest, [...CLEAN, MERCURY_INGREDIENT])
    const helping = await onShelf(guest)
    const twin = await onShelf(guest)
    await noLabelOnShelf(guest, 'moisturise')
    await getVerdict(guest)
    await buildQueued(guest, { [twin]: { label: 'redundant', sameJobAs: helping } })
    return guest
  }

  it('answers 200 ready with the counts of each group, the total, and how many to see a professional about, and no product, step-down, id, name or reason', async () => {
    const guest = await builtShelf()

    const res = await getVerdict(guest)

    expect(res.status).toBe(200)
    const raw = await res.text()
    const body = (JSON.parse(raw) as Envelope<VerdictBody>) as { success: true; data: LockedView }
    expect(body.data).toEqual({
      status: 'ready',
      locked: true,
      fit: 'ready',
      // steroid cream and mercury cream (likely-the-problem), the serum (helping), its twin (redundant), the tub nothing could be read from (cant-tell).
      total: 5,
      counts: { ...NO_GROUPS, helping: 1, redundant: 1, 'likely-the-problem': 2, 'cant-tell': 1 },
      ...GROUPS,
      // Only the mercury cream routes to a professional; the guest is told how many, never which.
      escalates: 1,
    })
    expect(Object.keys(body.data).sort()).toEqual(['counts', 'escalates', 'fit', 'groups', 'locked', 'status', 'total'])
    expect(Object.keys(body.data.counts).sort()).toEqual(Object.keys(NO_GROUPS).sort())
    for (const field of ['products', 'tapers', 'entryId', 'reason', 'verdict']) expect(raw).not.toContain(`"${field}"`)
  })

  it('gives the preview the same eight groups as the full verdict, in the owner\'s order, with counts equal to `counts`, and no product, reason or line of advice', async () => {
    const guest = await builtShelf()

    const res = await getVerdict(guest)

    const preview = await dataOf<LockedView>(res)
    expect(preview.groups.map(({ group }) => group)).toEqual([...GROUP_ORDER])
    expect(countsByGroup(preview.groups)).toEqual(preview.counts)
    expect(countsByGroup(preview.groups)).toEqual({ ...NO_GROUPS, helping: 1, redundant: 1, 'likely-the-problem': 2, 'cant-tell': 1 })
    for (const entry of preview.groups) {
      expect(Object.keys(entry).sort(), entry.group).toEqual(['count', 'group', 'intro', 'subtitle', 'title'])
      for (const text of [entry.title, entry.subtitle, entry.intro]) expect(gateTrips(text), `${entry.group}: "${text}"`).toEqual([])
    }
    expect(JSON.stringify(preview)).not.toContain('suggest')
    // After signing up the same words are on the full verdict.
    await guest.signUp()
    const full = await dataOf<ReadyView>(await getVerdict(guest))
    expect(full.groups).toEqual(preview.groups)
  })

  it('shows nothing a member of the same profile is shown: no entry id, product name, brand, reason, step-down or word of the rules appears anywhere in the guest\'s body', async () => {
    const guest = await builtShelf()
    const shows = await shelfShows(guest)
    const raw = await (await getVerdict(guest)).text()
    expect(JSON.parse(raw).data.locked).toBe(true)

    // The full verdict, read once the guest has signed up, is the independent source for what the preview must not give away.
    await guest.signUp()
    const full = await dataOf<ReadyView>(await getVerdict(guest))
    expect(full.products).toHaveLength(5)
    const hidden = privateTo(shows, full)
    expect(hidden.length).toBeGreaterThan(10)
    for (const text of hidden) expect(raw).not.toContain(text)
  })

  it('carries the fit as it is: not ready when the judge failed, with the products it has not decided counted as undecided', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    await onShelf(guest)
    await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    await getVerdict(guest)

    await buildWithFitFailing(guest)

    const res = await getVerdict(guest)
    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({
      status: 'ready',
      locked: true,
      fit: 'not-ready',
      total: 2,
      counts: { ...NO_GROUPS, undecided: 1, 'likely-the-problem': 1 },
      ...GROUPS,
      escalates: 0,
    })
  })

  it('counts the products the judge has not decided under Still checking, on the groups of the preview as well as in `counts`', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    await onShelf(guest)
    await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    await getVerdict(guest)
    await buildWithFitFailing(guest)

    const preview = await dataOf<LockedView>(await getVerdict(guest))

    expect(preview.fit).toBe('not-ready')
    expect(countsByGroup(preview.groups)).toEqual({ ...NO_GROUPS, undecided: 1, 'likely-the-problem': 1 })
    expect(preview.groups.find(({ group }) => group === 'undecided')!.title).toBe('Still checking')
  })
})

describe('GET /api/v1/me/verdict: a guest who signs up', () => {
  it('gets the full verdict from the same build, with no new build queued: promotion keeps the profile, and the preview the guest had counted exactly it', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const steroid = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    const serum = await onShelf(guest)
    const shows = await shelfShows(guest)
    await getVerdict(guest)
    const calls = await buildQueued(guest)
    const asGuest = await dataOf<LockedView>(await getVerdict(guest))
    expect(asGuest).toEqual({ status: 'ready', locked: true, fit: 'ready', total: 2, counts: { ...NO_GROUPS, helping: 1, 'likely-the-problem': 1 }, ...GROUPS, escalates: 0 })
    const queuedBefore = queuedFor(guest).length

    await guest.signUp()

    const res = await getVerdict(guest)
    expect(res.status).toBe(200)
    const asMember = await dataOf<ReadyView>(res)
    expect(asMember).toEqual({
      status: 'ready',
      locked: false,
      fit: 'ready',
      ...GROUPS,
      products: [
        { entryId: steroid, ...shows(steroid), group: 'likely-the-problem', verdict: { kind: 'stop', taperCode: STEROID_TAPER }, reason: expect.any(String), escalate: false, ...SUGGEST },
        { entryId: serum, ...shows(serum), group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false, ...SUGGEST },
      ],
      tapers: [expect.objectContaining({ code: STEROID_TAPER, kind: 'steroid' })],
    })
    expect(queuedFor(guest)).toHaveLength(queuedBefore)
    expect(calls).toHaveLength(1)
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
    const guest = await newMember()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const entryId = await onShelf(guest)
    const shows = await shelfShows(guest)
    await getVerdict(guest)

    await buildWithFitFailing(guest)

    const res = await getVerdict(guest)
    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({
      status: 'ready',
      locked: false,
      fit: 'not-ready',
      ...GROUPS,
      products: [{ entryId, ...shows(entryId), group: 'undecided', verdict: { kind: 'keep' }, reason: expect.any(String), escalate: false, ...SUGGEST }],
      tapers: [],
    })
  })

  it('shows one product of a clashing pair as conflicting, reduced to alternate days, and the other as the judge left it', async () => {
    const guest = await newMember()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const retinoid = await onShelf(guest, [...CLEAN, RETINOID_INGREDIENT])
    const acid = await onShelf(guest, [...CLEAN, ACID_INGREDIENT])
    const shows = await shelfShows(guest)
    await getVerdict(guest)

    await buildQueued(guest)

    const view = await dataOf<ReadyView>(await getVerdict(guest))
    expect(view).toMatchObject({ status: 'ready', locked: false, fit: 'ready', tapers: [] })
    const byId = new Map(view.products.map((product) => [product.entryId, product]))
    // The judge named no pick, so the floor's tie-break reduces the add-on (the acid) before the treatment.
    expect(byId.get(acid)).toEqual({ entryId: acid, ...shows(acid), group: 'conflicting', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' }, reason: expect.any(String), escalate: false, ...SUGGEST })
    expect(byId.get(acid)!.reason.length).toBeGreaterThan(0)
    expect(byId.get(retinoid)).toEqual({ entryId: retinoid, ...shows(retinoid), group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false, ...SUGGEST })
  })

  it('suggests the frequency, in plain words, for a product reduced to alternate days', async () => {
    const guest = await newMember()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    await onShelf(guest, [...CLEAN, RETINOID_INGREDIENT])
    const acid = await onShelf(guest, [...CLEAN, ACID_INGREDIENT])
    await getVerdict(guest)
    await buildQueued(guest)

    const view = await dataOf<ReadyView>(await getVerdict(guest))

    const reduced = view.products.find((product) => product.entryId === acid)!
    expect(reduced.verdict).toEqual({ kind: 'reduce', maxFrequency: 'alternate-days' })
    expect(reduced.suggest.length).toBeGreaterThanOrEqual(1)
    expect(reduced.suggest.length).toBeLessThanOrEqual(3)
    for (const line of reduced.suggest) {
      expect(line.toLowerCase()).not.toContain('alternate-days')
      expect(gateTrips(line), `"${line}"`).toEqual([])
    }
    expect(reduced.suggest).not.toEqual(view.products.find((product) => product.entryId !== acid)!.suggest)
  })

  it('shows a product the user said a doctor prescribed as prescribed and kept, whatever the rules would say of its ingredients', async () => {
    const guest = await newMember()
    await putGoal(guest)
    const brand = freshBrand()
    const entryId = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT], brand)
    const shows = await shelfShows(guest)
    await putSafety(guest, { choices: ['prescription'], prescriptionText: `${brand} from my dermatologist` })
    await parseNamedProduct(brand)
    await getVerdict(guest)

    await buildQueued(guest)

    const view = await dataOf<ReadyView>(await getVerdict(guest))
    expect(view).toEqual({
      status: 'ready',
      locked: false,
      fit: 'ready',
      ...GROUPS,
      products: [{ entryId, ...shows(entryId), group: 'prescribed', verdict: { kind: 'keep' }, reason: expect.any(String), escalate: false, ...SUGGEST }],
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

// --- POST /api/v1/me/verdict/products/{entryId}/reports (spec #259, PR B1) ---
//
// "Report a mistake": a verified account tells the team that a product's verdict looks wrong. It stores a report and raises the verdict-report ops alert; it never changes
// the verdict. The route has no call on the typed client until it exists, so it is called with plain fetch (as `getEntry` is). The checks run in this order: 401 (no session),
// 403 SIGNUP_REQUIRED (a guest), 400 VALIDATION_FAILED (the note), 404 VERDICT_PRODUCT_NOT_FOUND (the entry is not a product of the verdict the person would be served right now:
// ready, and built from the inputs as they are now; a pending or stale verdict has none). Answers 201 { id } for a new report and 200 { id } for an update of the report for the
// same entry and verdict. Reports are read back through the repository, the only way to see them (the team reads the table).
// The alert is not asserted here: its claim is per kind and window in the shared database, so whether this file wins the window is not up to a test (the service test pins it).

// Imported when first used, so that a missing repository fails the report tests alone and not every test in this file.
const reportsRepository = {
  find: async (id: string) => new (await import('../../src/modules/verdicts/verdicts.reports.repository')).D1VerdictReportsRepository(db).find(id),
}
const reportsUrl = (entryId: string) => `${ORIGIN}/api/v1/me/verdict/products/${entryId}/reports`
const postReport = (guest: Guest | undefined, entryId: string, body: unknown = {}) =>
  fetchWorker(reportsUrl(entryId), {
    method: 'POST',
    headers: { ...(guest ? guest.headers() : { 'cf-connecting-ip': freshIp() }), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const reportIdOf = async (res: Response) => (await dataOf<{ id: string }>(res)).id
const failureOf = async (res: Response) => (await res.json()) as { success: false; status: number; error: { code: string } }

/** A member with a goal, a clean shelf of `count` products (and a steroid cream when asked) and a verdict that has been built the way life builds one. */
const memberWithVerdict = async (count: number, withSteroid = false) => {
  const member = await newMember()
  await putGoal(member)
  await putSafety(member, { choices: ['none'] })
  const clean: string[] = []
  for (let i = 0; i < count; i++) clean.push(await onShelf(member))
  const steroid = withSteroid ? await onShelf(member, [...CLEAN, STEROID_INGREDIENT]) : undefined
  await getVerdict(member)
  await buildQueued(member)
  return { member, clean, steroid }
}

describe('POST /api/v1/me/verdict/products/{entryId}/reports: who may report', () => {
  it('answers 401 AUTH_REQUIRED without a session, even for a body that would be refused', async () => {
    const res = await postReport(undefined, crypto.randomUUID(), { note: 'x'.repeat(600) })

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ success: false, status: 401, error: { code: 'AUTH_REQUIRED' } })
  })

  it('answers a guest 403 SIGNUP_REQUIRED, even for a note that is too long, and stores nothing', async () => {
    const guest = await newGuest()

    const res = await postReport(guest, crypto.randomUUID(), { note: 'x'.repeat(600) })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ success: false, status: 403, error: { code: 'SIGNUP_REQUIRED' } })
  })
})

describe('POST /api/v1/me/verdict/products/{entryId}/reports: reporting a product of the verdict', () => {
  it('answers 201 with the new report\'s id in the success envelope, and stores what the person was shown: the product\'s group and verdict, the note and the verdict\'s fingerprint', async () => {
    const { member, clean } = await memberWithVerdict(1)

    const res = await postReport(member, clean[0]!, { note: 'This is not my cream' })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { id: string } }
    expect(body).toEqual({ success: true, status: 201, message: expect.any(String), data: { id: expect.any(String) } })
    const stored = await reportsRepository.find(body.data.id)
    expect(stored).toMatchObject({
      profileId: member.profileId,
      entryId: clean[0],
      kind: 'mistake',
      group: 'helping',
      verdict: { kind: 'keep' },
      basis: null,
      note: 'This is not my cream',
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      oldProductId: null,
      newProductId: null,
    })
  })

  it('stores a stopped product with its step-down\'s code, so the verdict can be reproduced', async () => {
    const { member, steroid } = await memberWithVerdict(1, true)

    const res = await postReport(member, steroid!, { note: 'I stopped this long ago' })

    expect(res.status).toBe(201)
    expect(await reportsRepository.find(await reportIdOf(res))).toMatchObject({ entryId: steroid, group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: STEROID_TAPER } })
  })

  it('answers 200 with the same id when the same product is reported again for the same verdict, and keeps the latest note', async () => {
    const { member, clean } = await memberWithVerdict(1)
    const first = await postReport(member, clean[0]!, { note: 'first thoughts' })
    expect(first.status).toBe(201)
    const id = await reportIdOf(first)

    const again = await postReport(member, clean[0]!, { note: 'second thoughts' })

    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ success: true, status: 200, message: expect.any(String), data: { id } })
    expect(await reportsRepository.find(id)).toMatchObject({ note: 'second thoughts' })
  })

  it('answers 201 with a new id for the same product once the verdict has been rebuilt, and keeps the first report', async () => {
    const { member, clean } = await memberWithVerdict(1)
    const first = await postReport(member, clean[0]!, { note: 'before the rebuild' })
    const firstId = await reportIdOf(first)
    await onShelf(member)
    await getVerdict(member)
    await buildQueued(member)

    const second = await postReport(member, clean[0]!, { note: 'after the rebuild' })

    expect(second.status).toBe(201)
    const secondId = await reportIdOf(second)
    expect(secondId).not.toBe(firstId)
    const [before, after] = [await reportsRepository.find(firstId), await reportsRepository.find(secondId)]
    expect(before).toMatchObject({ note: 'before the rebuild' })
    expect(after).toMatchObject({ note: 'after the rebuild' })
    expect(after!.fingerprint).not.toBe(before!.fingerprint)
  })

  it('never changes the verdict: the same body is served after the report, and no new build is queued', async () => {
    const { member, clean } = await memberWithVerdict(2)
    const before = await dataOf<VerdictBody>(await getVerdict(member))
    const queuedBefore = queuedFor(member).length

    expect((await postReport(member, clean[0]!, { note: 'wrong' })).status).toBe(201)

    expect(await dataOf(await getVerdict(member))).toEqual(before)
    expect(queuedFor(member)).toHaveLength(queuedBefore)
  })
})

describe('POST /api/v1/me/verdict/products/{entryId}/reports: the note', () => {
  it('keeps a note of exactly 500 characters, answers 201 for 500 characters with spaces around them and stores them trimmed, and refuses 501 with 400 VALIDATION_FAILED', async () => {
    const { member, clean } = await memberWithVerdict(3)

    const exact = await postReport(member, clean[0]!, { note: 'a'.repeat(500) })
    const padded = await postReport(member, clean[1]!, { note: `  ${'b'.repeat(500)}\n` })
    const over = await postReport(member, clean[2]!, { note: 'c'.repeat(501) })

    expect(exact.status).toBe(201)
    expect((await reportsRepository.find(await reportIdOf(exact)))!.note).toBe('a'.repeat(500))
    expect(padded.status).toBe(201)
    expect((await reportsRepository.find(await reportIdOf(padded)))!.note).toBe('b'.repeat(500))
    expect(over.status).toBe(400)
    expect((await failureOf(over)).error.code).toBe('VALIDATION_FAILED')
  })

  it.each([
    ['no note', {}],
    ['an empty note', { note: '' }],
    ['a note of spaces', { note: '   ' }],
  ])('answers 201 for %s and stores a null note', async (_label, body) => {
    const { member, clean } = await memberWithVerdict(1)

    const res = await postReport(member, clean[0]!, body)

    expect(res.status).toBe(201)
    expect((await reportsRepository.find(await reportIdOf(res)))!.note).toBeNull()
  })

  it.each([
    ['a note that is not text', { note: 12 }],
    ['a null note', { note: null }],
    ['a field it does not know', { note: 'fine', entryId: 'other' }],
  ])('answers 400 VALIDATION_FAILED for %s', async (_label, body) => {
    const { member, clean } = await memberWithVerdict(1)

    const res = await postReport(member, clean[0]!, body)

    expect(res.status).toBe(400)
    expect((await failureOf(res)).error.code).toBe('VALIDATION_FAILED')
  })

  it('looks at the note before the entry: a note that is too long for an entry that is not in the verdict gets 400, not 404', async () => {
    const { member } = await memberWithVerdict(1)

    const res = await postReport(member, crypto.randomUUID(), { note: 'x'.repeat(501) })

    expect(res.status).toBe(400)
    expect((await failureOf(res)).error.code).toBe('VALIDATION_FAILED')
  })
})

describe('POST /api/v1/me/verdict/products/{entryId}/reports: a product that is not in the verdict being served', () => {
  it('answers 404 VERDICT_PRODUCT_NOT_FOUND in the failure envelope for an entry the verdict does not hold', async () => {
    const { member } = await memberWithVerdict(1)

    const res = await postReport(member, crypto.randomUUID(), { note: 'x' })

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ success: false, status: 404, error: { code: 'VERDICT_PRODUCT_NOT_FOUND' } })
  })

  it('answers 404 for another profile\'s entry, and stores nothing for either', async () => {
    const mine = await memberWithVerdict(1)
    const theirs = await memberWithVerdict(1)

    const res = await postReport(mine.member, theirs.clean[0]!, { note: 'x' })

    expect(res.status).toBe(404)
    expect((await failureOf(res)).error.code).toBe('VERDICT_PRODUCT_NOT_FOUND')
  })

  it('answers 404 while the verdict is pending, for an entry that is on the shelf', async () => {
    const member = await newMember()
    await putGoal(member)
    await putSafety(member, { choices: ['none'] })
    const entryId = await onShelf(member)
    await getVerdict(member)

    const res = await postReport(member, entryId, { note: 'x' })

    expect(res.status).toBe(404)
    expect((await failureOf(res)).error.code).toBe('VERDICT_PRODUCT_NOT_FOUND')
  })

  it('answers 404 for a product of a verdict that is stale: the shelf changed after it was built, and it is not served as if it were current', async () => {
    const { member, clean } = await memberWithVerdict(1)
    await onShelf(member)

    const res = await postReport(member, clean[0]!, { note: 'x' })

    expect(res.status).toBe(404)
    expect((await failureOf(res)).error.code).toBe('VERDICT_PRODUCT_NOT_FOUND')
  })
})

describe('POST /api/v1/me/verdict/products/{entryId}/reports: the note stays private', () => {
  const PRIVATE = 'QZ-PRIVATE-NOTE-7731'

  it('is in no console output, queued message, outbound request or later response, whether the report is new, updated or refused', async () => {
    const { member, clean } = await memberWithVerdict(1)
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    // A report makes no outbound call of its own: any would fail here.
    const outbound: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      outbound.push(String(input))
      throw new Error('no outbound request is expected')
    })

    const responses = [
      await postReport(member, clean[0]!, { note: PRIVATE }),
      await postReport(member, clean[0]!, { note: `${PRIVATE} again` }),
      await postReport(member, crypto.randomUUID(), { note: PRIVATE }),
      await postReport(member, clean[0]!, { note: PRIVATE.repeat(30) }),
    ]
    vi.unstubAllGlobals()

    expect(responses.map((res) => res.status)).toEqual([201, 200, 404, 400])
    expect(outbound).toEqual([])
    for (const res of responses) expect(await res.clone().text()).not.toContain(PRIVATE)
    expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(PRIVATE)
    expect(JSON.stringify({ email: emailQueued, verdicts: verdictsQueued, parse: parseQueued })).not.toContain(PRIVATE)
  })

  it('is not sent to the fit judge when the verdict is rebuilt after a report, and is in no verdict body', async () => {
    const { member, clean } = await memberWithVerdict(1)
    expect((await postReport(member, clean[0]!, { note: PRIVATE })).status).toBe(201)
    await onShelf(member)
    await getVerdict(member)

    const calls = await buildQueued(member)

    expect(calls.length).toBeGreaterThan(0)
    expect(JSON.stringify(calls.map((call) => call.body))).not.toContain(PRIVATE)
    expect(JSON.stringify(await dataOf(await getVerdict(member)))).not.toContain(PRIVATE)
    expect(JSON.stringify(verdictsQueued)).not.toContain(PRIVATE)
  })
})
