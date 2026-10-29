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
import { applied, claimWordRow, code, escalationRow, REVIEWER_ROLE, ruleRow, taperRow, word } from './admin.catalog.support'

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
// #259 A3 adds, to each product, `basis: Basis[]` (kind 'rule' | 'fit' | 'told-us' | 'no-label', each with a fixed `line`), and to the verdict `professional:
// { whoToSee, howSoon, whatToTellThem } | null`; neither is on the guest's preview. A reviewer role of null and a professional of null cannot be reached here: the
// import refuses an approved rule or claim word with no reviewer_role and a workbook with no approved about-a-product row, so those two are pinned in the service tests.
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
  basis: Record<string, unknown>[]
}
type PublicTaper = { code: string; kind: string; schedule: { fromWeek: number; toWeek: number; frequency: string }[]; whatToExpect: string; seeAProfessionalIf: string }
type PublicProfessional = { whoToSee: string; howSoon: string; whatToTellThem: string }
type ReadyView = { status: 'ready'; locked: false; fit: 'ready' | 'not-ready'; groups: GroupEntry[]; products: PublicProduct[]; tapers: PublicTaper[]; professional: PublicProfessional | null }
type Groups = { helping: number; redundant: number; blocking: number; conflicting: number; 'likely-the-problem': number; 'cant-tell': number; prescribed: number; undecided: number }
type LockedView = { status: 'ready'; locked: true; fit: 'ready' | 'not-ready'; groups: GroupEntry[]; total: number; counts: Groups; escalates: number }
type VerdictBody = { status: 'pending' } | ReadyView | LockedView
const NO_GROUPS: Groups = { helping: 0, redundant: 0, blocking: 0, conflicting: 0, 'likely-the-problem': 0, 'cant-tell': 0, prescribed: 0, undecided: 0 }
// #259 A2: every ready verdict also carries `groups` (the screen's headings, fixed copy) and every product `suggest` (what to do, fixed lines). The tests below that
// compare a whole body say only that they are there; what they hold is pinned by the tests of their own further down and by verdicts.view.test.ts.
const GROUP_ORDER = ['likely-the-problem', 'conflicting', 'cant-tell', 'blocking', 'redundant', 'helping', 'prescribed', 'undecided'] as const
const SUGGEST = { suggest: expect.any(Array) }
// #259 A3: every product of the full verdict also carries `basis` (where its verdict came from) and the verdict carries `professional`; the tests that compare a whole
// body say only that they are there, and the A3 tests at the end of the file pin what they hold.
const BASIS = { basis: expect.any(Array) }
// The about-a-product row is imported by every upload of this file (the contract needs it), so the verdict has it; its words are pinned by the A3 tests at the end.
const PROFESSIONAL = { professional: expect.objectContaining({ whoToSee: expect.any(String), howSoon: expect.any(String), whatToTellThem: expect.any(String) }) }
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
      ...PROFESSIONAL,
      products: [{ entryId, ...shows(entryId), group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false, ...SUGGEST, ...BASIS }],
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
    expect(Object.keys(view).sort()).toEqual(['fit', 'groups', 'locked', 'products', 'professional', 'status', 'tapers'])
    expect(view).toMatchObject({ status: 'ready', locked: false, fit: 'ready' })
    const byId = new Map(view.products.map((product) => [product.entryId, product]))
    expect([...byId.keys()].sort()).toEqual([steroid, mercury, helping, twin, unlabelled].sort())

    // A steroid stops with its kind's step-down, named by the template's code, with no escalation.
    expect(byId.get(steroid)).toEqual({ entryId: steroid, ...shows(steroid), group: 'likely-the-problem', verdict: { kind: 'stop', taperCode: STEROID_TAPER }, reason: expect.any(String), escalate: false, ...SUGGEST, ...BASIS })
    // Mercury stops at once, with no step-down, and routes to a professional.
    expect(byId.get(mercury)).toEqual({ entryId: mercury, ...shows(mercury), group: 'likely-the-problem', verdict: { kind: 'drop' }, reason: expect.any(String), escalate: true, ...SUGGEST, ...BASIS })
    // The judge's words are the reason as given, and a redundant product names the product that stays and does its job.
    expect(byId.get(helping)).toEqual({ entryId: helping, ...shows(helping), group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false, ...SUGGEST, ...BASIS })
    expect(byId.get(twin)).toEqual({ entryId: twin, ...shows(twin), group: 'redundant', verdict: { kind: 'drop' }, reason: 'Reason: redundant.', escalate: false, sameJobAs: helping, ...SUGGEST, ...BASIS })
    // A product nothing could be read from is set aside with the nudge to photograph the back label.
    expect(byId.get(unlabelled)).toEqual({ entryId: unlabelled, ...shows(unlabelled), group: 'cant-tell', verdict: { kind: 'drop' }, reason: expect.any(String), escalate: false, nudge: 'photograph-back-label', ...SUGGEST, ...BASIS })
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
    expect(Object.keys(view).sort()).toEqual(['fit', 'groups', 'locked', 'products', 'professional', 'status', 'tapers'])
  })

  it('still gives only the fields it names: the product adds none of how the rules reached a verdict', async () => {
    const guest = await newMember()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    await onShelf(guest)
    await getVerdict(guest)
    await buildQueued(guest)

    const [item] = (await dataOf<ReadyView>(await getVerdict(guest))).products

    expect(Object.keys(item!).sort()).toEqual(['basis', 'entryId', 'escalate', 'group', 'kind', 'product', 'reason', 'suggest', 'verdict'])
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
  // #259 A3: where each verdict came from (its fixed lines, the rule's words, its source link and reviewer role) and the professional to see are the member's too.
  ...full.products.flatMap((product) => product.basis.flatMap((basis) => [String(basis.line), ...(typeof basis.sourceUrl === 'string' ? [basis.sourceUrl] : []), ...(typeof basis.reviewerRole === 'string' ? [basis.reviewerRole] : [])])),
  ...(full.professional ? [full.professional.whoToSee, full.professional.howSoon, full.professional.whatToTellThem] : []),
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
      ...PROFESSIONAL,
      products: [
        { entryId: steroid, ...shows(steroid), group: 'likely-the-problem', verdict: { kind: 'stop', taperCode: STEROID_TAPER }, reason: expect.any(String), escalate: false, ...SUGGEST, ...BASIS },
        { entryId: serum, ...shows(serum), group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false, ...SUGGEST, ...BASIS },
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
      ...PROFESSIONAL,
      products: [{ entryId, ...shows(entryId), group: 'undecided', verdict: { kind: 'keep' }, reason: expect.any(String), escalate: false, ...SUGGEST, ...BASIS }],
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
    expect(byId.get(acid)).toEqual({ entryId: acid, ...shows(acid), group: 'conflicting', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' }, reason: expect.any(String), escalate: false, ...SUGGEST, ...BASIS })
    expect(byId.get(acid)!.reason.length).toBeGreaterThan(0)
    expect(byId.get(retinoid)).toEqual({ entryId: retinoid, ...shows(retinoid), group: 'helping', verdict: { kind: 'keep' }, reason: 'Reason: helping.', escalate: false, ...SUGGEST, ...BASIS })
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
      ...PROFESSIONAL,
      products: [{ entryId, ...shows(entryId), group: 'prescribed', verdict: { kind: 'keep' }, reason: expect.any(String), escalate: false, ...SUGGEST, ...BASIS }],
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

// --- #259 A3: where a verdict comes from, and "Talk to a professional" ---

const SOURCED_BANNED = `${word('zq')} muskum`
const SOURCED_RULE_URL = 'https://example.org/rules/muskum'
const SOURCED_ROLE = 'a toxicologist'
const CLAIM_PHRASE = word('zqphrase')
const CLAIM_URL = 'https://example.org/claims/phrase'
const ABOUT_A_PRODUCT = { who_to_see: 'A pharmacist, or a doctor you trust.', how_soon: 'Within the week, or sooner if it gets worse.', what_to_tell_them: 'The product, how long you used it, and what changed on your skin.' }

describe('GET /api/v1/me/verdict: where each verdict comes from, and the professional to see (#259 A3)', () => {
  beforeAll(async () => {
    await applied((workbook) => {
      workbook.ingredients.rows.push(
        ruleRow({ name: SOURCED_BANNED, kind: 'banned-substance', statement: 'Not allowed in cosmetics in many countries.', source_url: SOURCED_RULE_URL, reviewer_role: SOURCED_ROLE }),
      )
      workbook.claimWords.rows.push(claimWordRow({ phrase: CLAIM_PHRASE, source_url: CLAIM_URL, reviewer_role: 'a pharmacist' }))
      // The row is changed in place when the workbook has it (an upload keeps a reason's row), and added when it does not.
      const row = workbook.escalations.rows.find((candidate) => candidate.reason === 'about-a-product')
      if (row) Object.assign(row, ABOUT_A_PRODUCT)
      else workbook.escalations.rows.push(escalationRow({ reason: 'about-a-product', ...ABOUT_A_PRODUCT }))
    })
  })

  /** A member whose shelf holds a steroid cream, a cream with a sourced banned ingredient, a cream named for a lightening claim, a serum and a tub with no label. */
  const builtShelf = async (asGuest = false) => {
    const guest = asGuest ? await newGuest() : await newMember()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const steroid = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    const sourced = await onShelf(guest, [...CLEAN, SOURCED_BANNED])
    const claimed = await onShelf(guest, CLEAN, `${freshBrand()} ${CLAIM_PHRASE}`)
    const serum = await onShelf(guest)
    const unlabelled = await noLabelOnShelf(guest, 'moisturise')
    await getVerdict(guest)
    await buildQueued(guest)
    return { guest, steroid, sourced, claimed, serum, unlabelled }
  }
  const basisOfEntry = (view: ReadyView, entryId: string) => view.products.find((product) => product.entryId === entryId)!.basis

  it('gives each product the basis it was built with: the workbook\'s own rule, with its source link and reviewer role, the claim word, the fit, and the unknown contents', async () => {
    const { guest, steroid, sourced, claimed, serum, unlabelled } = await builtShelf()

    const view = await dataOf<ReadyView>(await getVerdict(guest))

    // ruleRow's defaults: no source link, and the role every rule here is approved with.
    expect(basisOfEntry(view, steroid)).toEqual([
      { kind: 'rule', source: 'ingredient-rule', statement: 'A topical steroid.', sourceUrl: null, reviewerRole: REVIEWER_ROLE, line: 'A topical steroid.' },
    ])
    expect(basisOfEntry(view, sourced)).toEqual([
      { kind: 'rule', source: 'ingredient-rule', statement: 'Not allowed in cosmetics in many countries.', sourceUrl: SOURCED_RULE_URL, reviewerRole: SOURCED_ROLE, line: 'Not allowed in cosmetics in many countries.' },
    ])
    expect(basisOfEntry(view, claimed)).toEqual([
      { kind: 'rule', source: 'claim-word', statement: expect.stringContaining(CLAIM_PHRASE), sourceUrl: CLAIM_URL, reviewerRole: 'a pharmacist', line: expect.stringContaining(CLAIM_PHRASE) },
    ])
    expect(basisOfEntry(view, serum)).toEqual([{ kind: 'fit', line: expect.any(String) }])
    expect(basisOfEntry(view, unlabelled)).toEqual([{ kind: 'no-label', about: 'unknown-contents', line: expect.any(String) }])
  })

  it('reads the same basis on every ask, with no new build, and gives it no field the app is not meant to read', async () => {
    const { guest } = await builtShelf()
    const before = await dataOf<ReadyView>(await getVerdict(guest))
    const queuedBefore = queuedFor(guest).length

    const again = await dataOf<ReadyView>(await getVerdict(guest))

    expect(again).toEqual(before)
    expect(queuedFor(guest)).toHaveLength(queuedBefore)
    for (const product of before.products) for (const basis of product.basis) expect(Object.keys(basis).sort(), JSON.stringify(basis)).toEqual(
      { rule: ['kind', 'line', 'reviewerRole', 'source', 'sourceUrl', 'statement'], fit: ['kind', 'line'], 'told-us': ['about', 'kind', 'line'], 'no-label': ['about', 'kind', 'line'] }[basis.kind as 'rule' | 'fit' | 'told-us' | 'no-label'],
    )
  })

  it('passes the wording gate on every fixed line of the verdict, and on the words of a claim word\'s statement around the phrase it names', async () => {
    const { guest } = await builtShelf()

    const view = await dataOf<ReadyView>(await getVerdict(guest))

    const lines = view.products.flatMap((product) => product.basis).filter((basis) => basis.source !== 'ingredient-rule')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const basis of lines) {
      const text = String(basis.source === 'claim-word' ? String(basis.statement).replaceAll(CLAIM_PHRASE, '') : basis.line)
      expect(gateTrips(text), `"${text}"`).toEqual([])
    }
  })

  it('gives the full verdict the approved about-a-product row: who to see, how soon, and what to tell them', async () => {
    const { guest } = await builtShelf()

    const view = await dataOf<ReadyView>(await getVerdict(guest))

    expect(view.professional).toEqual({ whoToSee: ABOUT_A_PRODUCT.who_to_see, howSoon: ABOUT_A_PRODUCT.how_soon, whatToTellThem: ABOUT_A_PRODUCT.what_to_tell_them })
  })

  it('gives a guest neither the basis nor the professional: the preview is the counts and the groups, and no word of either appears in it', async () => {
    const { guest } = await builtShelf(true)

    const raw = await (await getVerdict(guest)).text()

    const preview = (JSON.parse(raw) as { data: LockedView }).data
    expect(preview.locked).toBe(true)
    expect(Object.keys(preview).sort()).toEqual(['counts', 'escalates', 'fit', 'groups', 'locked', 'status', 'total'])
    expect(raw).not.toMatch(/basis|professional|whoToSee|howSoon|whatToTellThem|reviewerRole|sourceUrl/)
    // Once the guest has signed up, the same build shows both: the words the preview must not give away are the member's.
    await guest.signUp()
    const member = await dataOf<ReadyView>(await getVerdict(guest))
    expect(member.professional).not.toBeNull()
    const hidden = [ABOUT_A_PRODUCT.who_to_see, ABOUT_A_PRODUCT.how_soon, ABOUT_A_PRODUCT.what_to_tell_them, ...member.products.flatMap((product) => product.basis.map((basis) => String(basis.line))), SOURCED_RULE_URL, SOURCED_ROLE]
    expect(hidden.length).toBeGreaterThan(8)
    for (const text of hidden) expect(raw).not.toContain(text)
  })
})
