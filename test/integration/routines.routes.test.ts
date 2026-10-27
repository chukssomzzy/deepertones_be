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
import { D1RoutinesRepository, type RoutineVersionRow } from '../../src/modules/routines/routines.repository'
import { profileProducts } from '../../src/modules/shelf/shelf.table'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'
import { applied, code, guideRow, taperRow } from './admin.catalog.support'
import { availabilityRow, countryRow, productRow, putCountry, type RawWorkbook } from './catalog.workbook.support'
import { BURST_NEEDS_MS, inOneRateWindow, RATE_TEST_TIMEOUT_MS } from './rate-window'
import { parseFrame, sseReader, type SseReader } from './sse'

// The routine endpoints (spec #189, PR 4b) through the Worker's public surface: the real entrypoint, real local D1 under it, plain fetch for the new routes (the
// typed client has no call for them until they exist) and the typed client for the sign-in that already does. A routine version reaches the database the way the
// build leaves it: appended through D1RoutinesRepository.append (the same write the build uses for a ready row), never by the real writer, which calls a model.
// What a routine is made of (the rules, the writer, the gates, the stable merge) is routines.service.test.ts's business and the body's mapping is
// routines.view.test.ts's; this file is the routes': who may ask, the envelope and every status code, and the shape of what a client reads.
//
// THE PUBLIC SHAPE PINNED HERE (pr4-plan.md):
//   { status: 'pending' }
//   { status: 'ready' | 'updating', startedOn: 'YYYY-MM-DD' | null, expectation, morning: Entry[], evening: Entry[], notInRoutine: NotInRoutine[] | null, tapers: Taper[], summary: Summary | null }
//   (PR 6: `steps` is gone. Placement and the words are pinned in routines.view.test.ts; this file pins that they reach the wire.)
//   NotInRoutine = { entryId, title, status: 'stepping-down' | 'left-out', reason }   (null for a version built before the column)
//   Summary = { goal: { id, label }, keepUsing, useLessOrChange, stepDown: { products: { brand, name }[], message } | null }   (PR 5; null for a version with no stored counts)
//   Entry = { step, title, when, reason, changed, product }
//   product = { kind: 'own', entryId, brand, name } | { kind: 'recommended', code, brand, name, imageUrl, origin?, price: { min, max, currency } | null, whereSold,
//             soldInCurrentCountry, soldElsewhere, keyIngredient, strength, notYetGot } | { kind: 'none' }
//   Taper = { entryId, brand, name, code, kind, whatToExpect, seeAProfessionalIf, steps: { fromWeek, toWeek, frequency, fromDate?, toDate? }[] }
// GET /me/routine, GET /me/routine/events, POST /me/routine/start, POST /me/routine/steps/{step}/got-it, POST /me/routine/steps/{step}/find-sold-here and (#217 PR 2)
// GET /me/routine/steps/{step}/look-for, whose body is pinned in its own describe at the foot of this file.
// Every one is for a signed-up account: 401 AUTH_REQUIRED, then 403 SIGNUP_REQUIRED (a guest), then 409 GOAL_REQUIRED, then 503 VERDICT_UNAVAILABLE (a step-down
// template of the verdict is not approved yet). Note the order against the verdict's own, which answers 503 before 409.
// Start answers 200 with the body (409 ROUTINE_NOT_READY before there is a routine) and is idempotent; got-it answers 200 with the body (409 ROUTINE_NOT_READY,
// 409 STEP_NOT_RECOMMENDED, 429 on the shelf-add limits); find-sold-here answers 202 with the `updating` body (the build runs in the job, never in the request), or 409 BUILD_IN_PROGRESS when routines are on and nothing could be queued.
// Never in any body: grounding, fixedFrom, source links, the model and prompt, the workbook's audit columns, ids of the catalog.
//
// The step-down templates are the workbook's, one database for the whole file, so the first describes run in order against the state the one before left: no
// template approved, then both.

const OTP_QUEUE = 'deepertones-otp-delivery-development'
const ZEPTO_URL = 'https://zeptomail.test/v1.1/email'
const SOURCE_URL = 'https://shop.example/product'
const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
// How long to listen for a frame that must not come.
const QUIET_MS = 300

// Every time here hangs off this one anchor (the real clock, which the Worker also runs on).
const ANCHOR = new Date()
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (offsetMs: number) => new Date(ANCHOR.getTime() + offsetMs)
const utcDay = (date: Date) => date.toISOString().slice(0, 10)

type Queued = { body: unknown }
const routinesQueued: Queued[] = []
const routinesQueue = { send: async (body: unknown) => void routinesQueued.push({ body }), sendBatch: async () => {} } as unknown as Queue
const quietQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
const otpQueued: unknown[] = []
// Routines are switched on only for the calls that need a build asked for: setting a goal, a shopping country or a safety answer must not claim a build.
let routinesEnabled = false
const workerEnv = () =>
  ({
    ...env,
    OTP_CHANNELS: 'email',
    ZEPTOMAIL_API_URL: ZEPTO_URL,
    ZEPTOMAIL_API_KEY: 'test-key',
    OTP_DELIVERY_QUEUE: { send: async (body: unknown) => void otpQueued.push(body) } as unknown as Queue,
    ROUTINES_ENABLED: routinesEnabled ? 'true' : 'false',
    ROUTINES_QUEUE: routinesQueue,
    VERDICTS_QUEUE: quietQueue,
    SCAN_ITEMS_QUEUE: quietQueue,
    PARSE_SAFETY_QUEUE: quietQueue,
    PUSH_DELIVERY_QUEUE: quietQueue,
  }) as typeof env
const ORIGIN = 'http://deepertones.test'
const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, workerEnv(), createExecutionContext())
const api = hc<AppType>(ORIGIN, { fetch: fetchWorker as typeof fetch })
const v1 = api.api.v1

const opened: SseReader[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  routinesQueued.length = 0
  otpQueued.length = 0
  routinesEnabled = false
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
const freshEmail = () => `Routine-${runSalt}-${next()}@Example.com`
const freshBrand = () => `${runSalt}${next()}x RoutineBrand`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number; headers: Headers }
const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
const errorCodeOf = async (res: Reply) => {
  const body = (await res.json()) as Envelope<unknown>
  if (!body.success) return body.error.code
  throw new Error(`expected an error, got ${res.status}`)
}

type Step = { step: string; title: string; when: string; reason: string; changed: boolean; product: Record<string, any> }
type NotInRoutine = { entryId: string; title: string; status: string; reason: string }
type Taper = { entryId: string; brand: string | null; name: string; code: string; kind: string; whatToExpect: string; seeAProfessionalIf: string; steps: Record<string, any>[] }
type Summary = { goal: { id: string; label: string }; keepUsing: number; useLessOrChange: number; stepDown: { products: { brand: string | null; name: string }[]; message: string } | null }
type ReadyBody = { status: 'ready' | 'updating'; startedOn: string | null; expectation: string; morning: Step[]; evening: Step[]; notInRoutine: NotInRoutine[] | null; tapers: Taper[]; summary: Summary | null }
type RoutineBody = { status: 'pending' } | ReadyBody
/** The entries of a body once each, in routine order: a step in both lists is one entry. */
const stepsOf = (body: ReadyBody): Step[] => {
  const byStep = new Map<string, Step>()
  for (const entry of [...body.morning, ...body.evening]) if (!byStep.has(entry.step)) byStep.set(entry.step, entry)
  return ['cleanse', 'treat', 'moisturise', 'protect'].flatMap((step) => byStep.get(step) ?? [])
}

// --- people: a guest of one install, and the sign-in that makes the guest an account ---

const db = createDb(env.DB)
const device = () => {
  const deviceId = `device-routine-${runSalt}-${next()}`
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
  await worker.queue!(batch, workerEnv(), ctx)
  expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['m'])
  vi.unstubAllGlobals()
  const found = /\b(\d{6})\b/.exec(sent[0]!.textbody)?.[1]
  if (!found) throw new Error('no code in the email')
  return found
}

const putGoal = async (guest: Guest, goal = 'glow') => expect((await v1.me.goal.$put({ json: { goal } as never }, { headers: guest.headers() })).status).toBe(200)
const putSafety = async (guest: Guest, json: Record<string, unknown> = { choices: ['none'] }) => expect((await v1.me.safety.$put({ json: json as never }, { headers: guest.headers() })).status).toBe(200)
const putShopping = async (guest: Guest, country = 'NG') => expect((await v1.me.shopping.$put({ json: { country } as never }, { headers: guest.headers() })).status).toBe(200)

/** A signed-up account with a goal, safety answers and a shopping country: ready to have a routine. */
const account = async () => {
  const guest = await newGuest()
  await guest.signUp()
  await putGoal(guest)
  await putSafety(guest)
  await putShopping(guest)
  return guest
}

// --- the routes, with plain fetch ---

const send = async (method: 'GET' | 'POST', path: string, guest?: Guest) =>
  fetchWorker(`${ORIGIN}/api/v1/me/routine${path}`, { method, headers: guest ? guest.headers() : { 'cf-connecting-ip': freshIp() } })
const getRoutine = (guest?: Guest) => send('GET', '', guest)
const startRoutine = (guest?: Guest) => send('POST', '/start', guest)
const gotIt = (step: string, guest?: Guest) => send('POST', `/steps/${step}/got-it`, guest)
const findSoldHere = (step: string, guest?: Guest) => send('POST', `/steps/${step}/find-sold-here`, guest)
const lookFor = (step: string, guest?: Guest) => send('GET', `/steps/${step}/look-for`, guest)
const eventsOf = (guest?: Guest) => send('GET', '/events', guest)
const watch = async (guest: Guest) => {
  const res = await eventsOf(guest)
  expect(res.status).toBe(200)
  const stream = sseReader(res)
  opened.push(stream)
  return { res, stream }
}
const bodyOf = async (guest: Guest) => dataOf<RoutineBody>(await getRoutine(guest))
const readyOf = async (guest: Guest) => {
  const body = await bodyOf(guest)
  if (body.status === 'pending') throw new Error('expected a routine, got pending')
  return body
}

const ENDPOINTS: [string, (guest?: Guest) => Promise<Response>][] = [
  ['GET /me/routine', getRoutine],
  ['GET /me/routine/events', eventsOf],
  ['POST /me/routine/start', startRoutine],
  ['POST /me/routine/steps/{step}/got-it', (guest) => gotIt('moisturise', guest)],
  ['POST /me/routine/steps/{step}/find-sold-here', (guest) => findSoldHere('treat', guest)],
  ['GET /me/routine/steps/{step}/look-for', (guest) => lookFor('treat', guest)],
]

// --- the shelf and the catalog ---

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
  await db.insert(profileProducts).values({ id, profileId: guest.profileId, kind: 'product', productId: resolved.productId, formulationId: found.formulationId, scanId: crypto.randomUUID(), itemId: crypto.randomUUID(), addedAt: now, lastScannedAt: now })
  return id
}
/** What GET /me/shelf shows of an entry: the independent source for the brand and name of an own product. */
const shelfProduct = async (guest: Guest, entryId: string) => {
  const { entries } = await dataOf<{ entries: { id: string; product?: { brand: string; name: string } }[] }>(await v1.me.shelf.$get({}, { headers: guest.headers() }))
  const entry = entries.find((candidate) => candidate.id === entryId)
  if (!entry?.product) throw new Error(`entry ${entryId} is not a product on the shelf`)
  return entry.product
}

// --- the workbook: the countries, the recommended products and the step-down templates, put in the way the team does, through the admin import ---

const STEROID_TAPER = code('TPR-STEROID')
const LIGHTENING_TAPER = code('TPR-LIGHTENING')
const WHAT_TO_EXPECT = 'Skin may flare or look redder for a few days after each step down. This is expected and passes.'
const SEE_A_PROFESSIONAL_IF = 'The redness spreads, the skin weeps or blisters, or you feel unwell.'

type Seed = { code: string; brand: string; name: string }
const seed = (suffix: string, name: string): Seed => ({ code: code(`RT-${suffix}`), brand: freshBrand(), name })
// Treat is sold in Ghana only; moisturise is sold in Nigeria (and, by a brand's submission, with a key ingredient); protect's is retired.
const TREAT_GH = seed('TREAT', 'Accra Brightening Serum')
const MOIST_NG = seed('MOIST', 'Lagos Moisture Cream')
const MOIST_GH_TOO = seed('MOIST2', 'Cape Coast Moisture Cream')
const PROTECT_RETIRED = seed('PROTECT', 'Retired Sunscreen')

const loadCatalog = (rawWorkbook: Parameters<Parameters<typeof applied>[0]>[0]) => {
  // The two support files type a workbook alike but not identically.
  const workbook = rawWorkbook as unknown as RawWorkbook
  putCountry(workbook, countryRow('NG'))
  putCountry(workbook, countryRow('GH', { currency: 'GHS', low_max: 100, mid_max: 300 }))
  const add = (s: Seed, over: Record<string, string | number | null>, ...sold: [string, number, number][]) => {
    workbook.products.rows.push(productRow({ code: s.code, brand: s.brand, name: s.name, ...over }))
    for (const [country, min, max] of sold) workbook.availability.rows.push(availabilityRow(s.code, country, min, max))
  }
  add(TREAT_GH, { steps: 'treat', frequency: 'pm' }, ['GH', 40, 55])
  add(MOIST_NG, { steps: 'moisturise', origin: 'brand-submitted', key_ingredient: 'Shea butter', strength: '15%' }, ['NG', 3000, 4500])
  add(MOIST_GH_TOO, { steps: 'moisturise' }, ['NG', 2500, 3000], ['GH', 30, 45])
  // A retired row stays in the workbook with its list, sold nowhere.
  add(PROTECT_RETIRED, { steps: 'protect', status: 'retired', approved_by: null, approved_on: null })
}

// --- the routine versions, appended the way the build leaves them ---

const routines = new D1RoutinesRepository(db)
type StoredStep = RoutineVersionRow['steps'][number]
const stored = (step: StoredStep['step'], product: StoredStep['product'], frequency: StoredStep['frequency'], over: Partial<StoredStep> = {}): StoredStep => ({
  step,
  product,
  frequency,
  reason: `Reason for ${step}.`,
  grounding: ['https://internal.example/grounding'],
  gotIt: false,
  fixedFrom: null,
  ...over,
})
let versionCount = 0
/** A ready routine version for the guest, appended through the repository. `age` is how long ago it became ready. */
const appendVersion = async (guest: Guest, over: Partial<RoutineVersionRow> = {}, age = HOUR): Promise<RoutineVersionRow> => {
  const row: RoutineVersionRow = {
    id: crypto.randomUUID(),
    profileId: guest.profileId,
    status: 'ready',
    createdAt: at(-age + versionCount++),
    steps: [],
    tapers: [],
    expectation: 'Give it 8 to 12 weeks before judging.',
    cautions: [],
    goal: 'glow',
    // As the build sorted the seeded shelf (see withRoutine): one product kept, two to use less, three to leave out, and the steroid cream stopped.
    shelfCounts: { keep: 1, reduce: 2, drop: 3, stop: 1 },
    notInRoutine: [],
    readyAt: at(-age + versionCount),
    startedOn: null,
    servedAt: null,
    model: 'claude-internal-model',
    promptHash: 'internal-prompt-hash',
    catalogVersion: 7,
    rulesVersion: 'internal-rules-1',
    hintsShown: false,
    verdictFingerprint: 'internal-verdict-fp',
    routineFingerprint: 'internal-routine-fp',
    source: 'writer',
    reason: 'first',
    writerRetryDueAt: null,
    writerCalls: 1,
    ...over,
  }
  await routines.append(row)
  return row
}
/** A build under way: a pending version, created a minute ago. */
const appendPending = (guest: Guest) =>
  appendVersion(guest, { status: 'pending', createdAt: at(-MINUTE), steps: [], tapers: [], expectation: null, cautions: null, goal: null, shelfCounts: null, notInRoutine: null, readyAt: null, model: null, promptHash: null, catalogVersion: null, routineFingerprint: null, source: null, writerCalls: 0 })

type Seeded = { guest: Guest; own: string; stopped: string; version: RoutineVersionRow }
/** An account whose routine is: cleanse its own cleanser, treat a Ghana-only serum, moisturise a Nigerian cream, protect nothing; a steroid cream being stepped down. */
const withRoutine = async (over: Partial<RoutineVersionRow> = {}): Promise<Seeded> => {
  const guest = await account()
  const own = await onShelf(guest)
  const stopped = await onShelf(guest)
  const version = await appendVersion(guest, {
    steps: [
      stored('cleanse', { kind: 'shelf', id: own }, 'am'),
      stored('treat', { kind: 'candidate', code: TREAT_GH.code }, 'pm'),
      stored('moisturise', { kind: 'candidate', code: MOIST_NG.code }, 'am-pm'),
      stored('protect', { kind: 'none' }, 'am'),
    ],
    tapers: [{ shelfProductId: stopped, templateId: STEROID_TAPER, startedOn: null }],
    // As the build froze it: the steroid cream stepping down, and a product left out that has since gone from the shelf.
    notInRoutine: [
      { entryId: stopped, title: 'Cream', status: 'stepping-down', reason: 'It has a steroid in it, so we stop it slowly.' },
      { entryId: 'entry-since-removed', title: 'Gel cleanser', status: 'left-out', reason: 'It does the same job as your cleanser.' },
    ],
    ...over,
  })
  return { guest, own, stopped, version }
}

// ============================================================ phase 1: the verdict's step-down templates are not approved yet ============================================================

describe.each(ENDPOINTS)('%s: who may ask, and the verdict being unavailable', (_name, call) => {
  it('answers 401 AUTH_REQUIRED without a session', async () => {
    const res = await call()

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ success: false, status: 401, error: { code: 'AUTH_REQUIRED' } })
  })

  it('answers 403 SIGNUP_REQUIRED to a guest, with the failure envelope, even with no goal and the verdict unavailable', async () => {
    const guest = await newGuest()

    const res = await call(guest)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ success: false, status: 403, error: { code: 'SIGNUP_REQUIRED' } })
  })

  it('answers 403 SIGNUP_REQUIRED to a guest who has a goal and safety answers', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    await putSafety(guest)

    expect((await call(guest)).status).toBe(403)
  })

  it('answers 409 GOAL_REQUIRED, not 503, to a signed-up account with no goal while the verdict is unavailable', async () => {
    const guest = await newGuest()
    await guest.signUp()

    const res = await call(guest)

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, status: 409, error: { code: 'GOAL_REQUIRED' } })
  })

  it('answers 503 VERDICT_UNAVAILABLE to a signed-up account with a goal while no step-down template is approved, and queues nothing', async () => {
    const guest = await newGuest()
    await guest.signUp()
    await putGoal(guest)
    routinesEnabled = true

    const res = await call(guest)

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ success: false, status: 503, error: { code: 'VERDICT_UNAVAILABLE' } })
    expect(routinesQueued).toEqual([])
  })
})

describe('GET /api/v1/me/routine: with only the steroid step-down template approved', () => {
  it('still answers 503 VERDICT_UNAVAILABLE: both templates are needed', async () => {
    await applied((workbook) => {
      workbook.tapers.rows.push(taperRow({ code: STEROID_TAPER, kind: 'steroid' }))
    })
    const guest = await newGuest()
    await guest.signUp()
    await putGoal(guest)

    const res = await getRoutine(guest)

    expect(res.status).toBe(503)
    expect(await errorCodeOf(res)).toBe('VERDICT_UNAVAILABLE')
  })
})

// ============================================================ phase 2: both templates approved, the recommended products loaded ============================================================

describe('GET /api/v1/me/routine: with both step-down templates approved', () => {
  beforeAll(async () => {
    await applied((workbook) => {
      workbook.tapers.rows.push(taperRow({ code: LIGHTENING_TAPER, kind: 'lightening-agent' }))
      loadCatalog(workbook)
    })
  })

  describe('before and around a routine', () => {
    it('answers 409 GOAL_REQUIRED to a signed-up account with no goal, now that the verdict is available', async () => {
      const guest = await newGuest()
      await guest.signUp()

      const res = await getRoutine(guest)

      expect(res.status).toBe(409)
      expect(await errorCodeOf(res)).toBe('GOAL_REQUIRED')
    })

    it('answers 200 pending in the success envelope for an account with no routine yet', async () => {
      const guest = await account()

      const res = await getRoutine(guest)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, status: 200, message: expect.any(String), data: { status: 'pending' } })
    })

    it('answers 200 pending while a first build is under way: there is nothing to show yet', async () => {
      const guest = await account()
      await appendPending(guest)

      expect(await bodyOf(guest)).toEqual({ status: 'pending' })
    })

    it('answers updating, with the routine in force, while a newer build is under way', async () => {
      const { guest } = await withRoutine()
      await appendPending(guest)

      const body = await readyOf(guest)

      expect(body.status).toBe('updating')
      expect(stepsOf(body).map((s) => s.step)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
    })

    it('answers pending, not the routine, once the safety answers state a caution it was not built under, and shows it again when they no longer do', async () => {
      const { guest } = await withRoutine({ cautions: [] })
      expect((await readyOf(guest)).status).toBe('ready')

      await putSafety(guest, { choices: ['pregnant'] })
      expect(await bodyOf(guest)).toEqual({ status: 'pending' })

      await putSafety(guest, { choices: ['none'] })
      expect((await readyOf(guest)).status).toBe('ready')
    })
  })

  describe('the body of a ready routine', () => {
    it('shows each step with its plain title, when-label and reason, an own product as the shelf entry, a recommended one with its price, place, key ingredient and strength, and "use what you have" as none', async () => {
      const { guest, own, version } = await withRoutine()
      const shown = await shelfProduct(guest, own)

      const body = await readyOf(guest)

      expect(body).toMatchObject({ status: 'ready', startedOn: null, expectation: 'Give it 8 to 12 weeks before judging.' })
      expect(stepsOf(body).map((s) => [s.step, s.when, s.reason, s.changed])).toEqual([
        ['cleanse', 'Every day', 'Reason for cleanse.', false],
        ['treat', 'Every day', 'Reason for treat.', false],
        ['moisturise', 'Every day', 'Reason for moisturise.', false],
        ['protect', 'Every day', 'Reason for protect.', false],
      ])
      expect(stepsOf(body)[0]!.product).toEqual({ kind: 'own', entryId: own, brand: shown.brand, name: shown.name })
      expect(stepsOf(body)[2]!.product).toEqual({
        kind: 'recommended',
        code: MOIST_NG.code,
        brand: MOIST_NG.brand,
        name: MOIST_NG.name,
        imageUrl: null,
        origin: 'brand-submitted',
        price: { min: 3000, max: 4500, currency: 'NGN' },
        whereSold: 'Pharmacies and online',
        soldInCurrentCountry: true,
        soldElsewhere: [],
        keyIngredient: 'Shea butter',
        strength: '15%',
        notYetGot: true,
      })
      expect(stepsOf(body)[3]!.product).toEqual({ kind: 'none' })
      expect(version.steps).toHaveLength(4)
    })

    it('lists the steps by when they are used: morning and evening lists in routine order, a step used morning and evening in both, and no list of steps', async () => {
      const { guest } = await withRoutine()

      const body = await readyOf(guest)

      expect(body).not.toHaveProperty('steps')
      // Cleanse am, treat pm, moisturise am-pm, protect am.
      expect(body.morning.map((s) => s.step)).toEqual(['cleanse', 'moisturise', 'protect'])
      expect(body.evening.map((s) => s.step)).toEqual(['treat', 'moisturise'])
      expect(body.morning.find((s) => s.step === 'moisturise')).toEqual(body.evening.find((s) => s.step === 'moisturise'))
      for (const entry of [...body.morning, ...body.evening]) expect(Object.keys(entry).sort()).toEqual(['changed', 'product', 'reason', 'step', 'title', 'when'])
    })

    it('titles each step in plain words: the shelf product and the recommended product with no key ingredient by their step, a recommended one with a key ingredient by it, and "use what you have" by its step', async () => {
      const { guest } = await withRoutine()

      const body = await readyOf(guest)

      // The catalog has no form for any of these products (a workbook row with a blank form, a product found by name).
      expect(stepsOf(body).map((s) => [s.step, s.title])).toEqual([
        ['cleanse', 'Cleanser'],
        ['treat', 'Treatment'],
        ['moisturise', 'Shea butter moisturiser'],
        ['protect', 'Sunscreen'],
      ])
    })

    it('shows what the build left out as it froze it: each with its entry id, title, status and the verdict\'s reason, even for a product that has gone from the shelf', async () => {
      const { guest, stopped } = await withRoutine()

      const body = await readyOf(guest)

      expect(body.notInRoutine).toEqual([
        { entryId: stopped, title: 'Cream', status: 'stepping-down', reason: 'It has a steroid in it, so we stop it slowly.' },
        { entryId: 'entry-since-removed', title: 'Gel cleanser', status: 'left-out', reason: 'It does the same job as your cleanser.' },
      ])
    })

    it('shows an empty list when nothing was left out, and null for a routine built before the list was kept', async () => {
      const none = await withRoutine({ notInRoutine: [] })
      const old = await withRoutine({ notInRoutine: null })

      expect((await readyOf(none.guest)).notInRoutine).toEqual([])
      expect((await readyOf(old.guest)).notInRoutine).toBeNull()
      expect(stepsOf(await readyOf(old.guest))).toHaveLength(4)
    })

    it('shows the plan summary: the goal with its chip label, the stored counts, and the step-down of the stopped product with the sentence about it', async () => {
      const { guest, stopped } = await withRoutine()
      const shown = await shelfProduct(guest, stopped)

      const { summary } = await readyOf(guest)

      expect(summary).toEqual({
        goal: { id: 'glow', label: 'A glow' },
        keepUsing: 1,
        useLessOrChange: 5,
        stepDown: {
          products: [{ brand: shown.brand, name: shown.name }],
          message: `Stopping ${shown.brand} ${shown.name} suddenly can make your skin flare. We'll take it step by step, so the rough days are expected, not a surprise.`,
        },
      })
    })

    it('has no step-down in the summary when nothing is stopped', async () => {
      const { guest } = await withRoutine({ tapers: [], shelfCounts: { keep: 2, reduce: 0, drop: 1, stop: 0 } })

      const { summary } = await readyOf(guest)

      expect(summary).toEqual({ goal: { id: 'glow', label: 'A glow' }, keepUsing: 2, useLessOrChange: 1, stepDown: null })
    })

    it('has summary null for a routine with no stored counts, one built before the counts existed, and still shows its steps', async () => {
      const { guest } = await withRoutine({ shelfCounts: null })

      const body = await readyOf(guest)

      expect(body.summary).toBeNull()
      expect(stepsOf(body)).toHaveLength(4)
    })

    it('carries the same summary on an updating routine', async () => {
      const { guest } = await withRoutine()
      const ready = await readyOf(guest)
      await appendPending(guest)

      const updating = await readyOf(guest)

      expect(updating.status).toBe('updating')
      expect(updating.summary).toMatchObject({ goal: { id: 'glow', label: 'A glow' }, keepUsing: 1, useLessOrChange: 5 })
      expect(updating.summary).toEqual(ready.summary)
    })

    it('shows a product sold only in another country as not sold here, with the country that sells it and no price', async () => {
      const { guest } = await withRoutine()

      const treat = stepsOf(await readyOf(guest))[1]!.product

      expect(treat).toMatchObject({ kind: 'recommended', code: TREAT_GH.code, brand: TREAT_GH.brand, name: TREAT_GH.name, soldInCurrentCountry: false, price: null, whereSold: null, soldElsewhere: ['GH'] })
      expect(treat).not.toHaveProperty('origin')
    })

    it('prices a product in the currency of the country the account shops in', async () => {
      const { guest } = await withRoutine({
        steps: [stored('moisturise', { kind: 'candidate', code: MOIST_GH_TOO.code }, 'am-pm')],
      })
      await putShopping(guest, 'GH')

      const [moisturise] = stepsOf(await readyOf(guest))

      expect(moisturise!.product).toMatchObject({ code: MOIST_GH_TOO.code, soldInCurrentCountry: true, price: { min: 30, max: 45, currency: 'GHS' }, soldElsewhere: ['NG'] })
    })

    it('keeps a retired recommended product on the screen, as sold nowhere', async () => {
      const { guest } = await withRoutine({ steps: [stored('protect', { kind: 'candidate', code: PROTECT_RETIRED.code }, 'am')] })

      const [protect] = stepsOf(await readyOf(guest))

      expect(protect!.product).toMatchObject({ kind: 'recommended', code: PROTECT_RETIRED.code, brand: PROTECT_RETIRED.brand, name: PROTECT_RETIRED.name, soldInCurrentCountry: false, price: null, soldElsewhere: [] })
    })

    it('shows the step-down of a stopped product with the template\'s words and weeks, and no dates before Start', async () => {
      const { guest, stopped } = await withRoutine()
      const shown = await shelfProduct(guest, stopped)

      const [taper] = (await readyOf(guest)).tapers

      // taperRow's schedule is '1-2: alternate-days; 3-4: weekly; 5: stop'.
      expect(taper).toEqual({
        entryId: stopped,
        brand: shown.brand,
        name: shown.name,
        code: STEROID_TAPER,
        kind: 'steroid',
        whatToExpect: WHAT_TO_EXPECT,
        seeAProfessionalIf: SEE_A_PROFESSIONAL_IF,
        steps: [
          { fromWeek: 1, toWeek: 2, frequency: 'alternate-days' },
          { fromWeek: 3, toWeek: 4, frequency: 'weekly' },
          { fromWeek: 5, toWeek: 5, frequency: 'stop' },
        ],
      })
    })

    it('marks a step changed when the routine shown before had another product or frequency there', async () => {
      const { guest, own } = await withRoutine({ createdAt: at(-HOUR), readyAt: at(-HOUR) })
      // A routine shown to the account earlier (served), older than the one in force, with another moisturiser and another cleanser frequency.
      await appendVersion(
        guest,
        {
          steps: [
            stored('cleanse', { kind: 'shelf', id: own }, 'pm'),
            stored('treat', { kind: 'candidate', code: TREAT_GH.code }, 'pm'),
            stored('moisturise', { kind: 'candidate', code: MOIST_GH_TOO.code }, 'am-pm'),
            stored('protect', { kind: 'none' }, 'am'),
          ],
          servedAt: at(-2 * DAY),
        },
        3 * DAY,
      )

      const first = await readyOf(guest)

      expect(stepsOf(first).map((s) => s.changed)).toEqual([true, false, true, false])
    })

    it('serves a routine once: the version read is the one the next version is compared with', async () => {
      const { guest, own } = await withRoutine()
      const treatIs = (code: string, frequency = 'pm') => [
        stored('cleanse', { kind: 'shelf', id: own }, 'am'),
        stored('treat', { kind: 'candidate', code }, frequency as StoredStep['frequency']),
        stored('moisturise', { kind: 'candidate', code: MOIST_NG.code }, 'am-pm'),
        stored('protect', { kind: 'none' }, 'am'),
      ]
      // The routine in force was served to nobody before: nothing is marked changed, and reading it makes it the one the next is compared with.
      expect(stepsOf(await readyOf(guest)).every((s) => !s.changed)).toBe(true)
      // A newer routine whose treat step differs from the one just shown.
      await appendVersion(guest, { steps: treatIs(MOIST_GH_TOO.code) }, 0)

      const next = await readyOf(guest)

      expect(stepsOf(next).map((s) => s.changed)).toEqual([false, true, false, false])
      // Reading it again changes nothing about what it is compared with.
      expect(stepsOf(await readyOf(guest)).map((s) => s.changed)).toEqual([false, true, false, false])
    })
  })

  describe('nothing internal is shown', () => {
    const INTERNAL = [
      'grounding',
      'fixedFrom',
      'sourceUrls',
      'evidenceUrls',
      'ingredientsSourceUrl',
      'model',
      'promptHash',
      'rulesVersion',
      'catalogVersion',
      'verdictFingerprint',
      'routineFingerprint',
      'writerCalls',
      'writerRetryDueAt',
      'hintsShown',
      'source',
      'cautions',
      'shelfCounts',
      'shelf_counts',
      'gotIt',
      'approvedBy',
      'approvedOn',
      'auditedBy',
      'auditedOn',
      'productId',
      'formulationId',
      'profileId',
      'servedAt',
      'createdAt',
      'readyAt',
      'schedule',
    ]
    const keysDeep = (value: unknown, keys = new Set<string>()): Set<string> => {
      if (Array.isArray(value)) value.forEach((item) => keysDeep(item, keys))
      else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key)
          keysDeep(inner, keys)
        }
      }
      return keys
    }
    const expectClean = (body: unknown, text: string) => {
      const keys = keysDeep(body)
      for (const internal of INTERNAL) expect(keys, internal).not.toContain(internal)
      for (const value of ['internal.example', 'claude-internal-model', 'internal-prompt-hash', 'internal-verdict-fp', 'internal-routine-fp', 'internal-rules-1']) expect(text, value).not.toContain(value)
    }

    it('has no internal field or value in the body of a read', async () => {
      const { guest } = await withRoutine()
      const res = await getRoutine(guest)

      expect(res.status).toBe(200)
      expectClean(await res.clone().json(), await res.text())
    })

    it('has no internal field or value in the body of Start, of "I got it" or of "find one sold here"', async () => {
      const { guest } = await withRoutine()
      routinesEnabled = true
      for (const res of [await startRoutine(guest), await gotIt('moisturise', guest), await findSoldHere('treat', guest)]) {
        expect([200, 202]).toContain(res.status)
        expectClean(await res.clone().json(), await res.text())
      }
    })

    it('has no internal field or value in the first frame of the event stream', async () => {
      const { guest } = await withRoutine()
      const { stream } = await watch(guest)

      const { frames } = await stream.read(1)

      expectClean(parseFrame(frames[0]!).data, frames[0]!)
    })
  })

  describe('POST /api/v1/me/routine/start', () => {
    it('answers 409 ROUTINE_NOT_READY before there is a routine', async () => {
      const guest = await account()

      const res = await startRoutine(guest)

      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ success: false, status: 409, error: { code: 'ROUTINE_NOT_READY' } })
    })

    it('answers 200 with the routine started tomorrow (day 1 is the day after the tap), its step-downs dated from then, week by week', async () => {
      const { guest } = await withRoutine()
      const today = new Date()

      const res = await startRoutine(guest)

      expect(res.status).toBe(200)
      const body = await dataOf<ReadyBody>(res)
      const day = (offset: number) => utcDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset)))
      expect(body.status).toBe('ready')
      // A test that runs across UTC midnight would be wrong by a day; the read of the clock is a moment before the call.
      expect(body.startedOn).toBe(day(1))
      // From day 1 (tomorrow): weeks 1-2 are days 1-14, weeks 3-4 days 15-28, week 5 days 29-35.
      expect(body.tapers[0]!.steps).toEqual([
        { fromWeek: 1, toWeek: 2, frequency: 'alternate-days', fromDate: day(1), toDate: day(14) },
        { fromWeek: 3, toWeek: 4, frequency: 'weekly', fromDate: day(15), toDate: day(28) },
        { fromWeek: 5, toWeek: 5, frequency: 'stop', fromDate: day(29), toDate: day(35) },
      ])
    })

    it('is idempotent: starting again answers the same start day and the same dates, and a read after shows them', async () => {
      const { guest } = await withRoutine()
      const first = await dataOf<ReadyBody>(await startRoutine(guest))

      const second = await startRoutine(guest)

      expect(second.status).toBe(200)
      const again = await dataOf<ReadyBody>(second)
      expect(again.startedOn).toBe(first.startedOn)
      expect(again.tapers).toEqual(first.tapers)
      expect(await readyOf(guest)).toMatchObject({ startedOn: first.startedOn })
    })

    it('answers 409 ROUTINE_NOT_READY, and does not start it, while a safety change hides the routine; it starts once the change is undone', async () => {
      const { guest } = await withRoutine()
      await putSafety(guest, { choices: ['pregnant'] })
      expect(await bodyOf(guest)).toEqual({ status: 'pending' })

      const res = await startRoutine(guest)

      expect(res.status).toBe(409)
      expect(await errorCodeOf(res)).toBe('ROUTINE_NOT_READY')
      expect((await routines.current(guest.profileId))!.startedOn).toBeNull()
      await putSafety(guest, { choices: ['none'] })
      expect((await readyOf(guest)).startedOn).toBeNull()
      expect((await startRoutine(guest)).status).toBe(200)
    })

    it('answers with no request body: it takes none', async () => {
      const { guest } = await withRoutine()

      const res = await startRoutine(guest)

      expect(res.status).toBe(200)
    })
  })

  describe('POST /api/v1/me/routine/steps/{step}/got-it', () => {
    it('answers 400 VALIDATION_FAILED for a step that is not one of the four', async () => {
      const { guest } = await withRoutine()

      const res = await gotIt('serum', guest)

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    })

    it('answers 409 ROUTINE_NOT_READY before there is a routine', async () => {
      const guest = await account()

      const res = await gotIt('moisturise', guest)

      expect(res.status).toBe(409)
      expect(await errorCodeOf(res)).toBe('ROUTINE_NOT_READY')
    })

    it.each([
      ['a product of her own', 'cleanse'],
      ['nothing to recommend', 'protect'],
    ])('answers 409 STEP_NOT_RECOMMENDED for a step with %s', async (_why, step) => {
      const { guest } = await withRoutine()

      const res = await gotIt(step, guest)

      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ success: false, status: 409, error: { code: 'STEP_NOT_RECOMMENDED' } })
    })

    it('answers 200 with the routine, that product no longer "not yet got", and the other steps as they were', async () => {
      const { guest } = await withRoutine()

      const res = await gotIt('moisturise', guest)

      expect(res.status).toBe(200)
      const body = await dataOf<ReadyBody>(res)
      expect(body.status).toBe('ready')
      expect(stepsOf(body)[2]!.product).toMatchObject({ code: MOIST_NG.code, notYetGot: false })
      expect(stepsOf(body).map((s) => s.step)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
      expect(stepsOf(body)[1]!.product).toMatchObject({ code: TREAT_GH.code, notYetGot: true })
      // The routine read afterwards says so too.
      expect(stepsOf(await readyOf(guest))[2]!.product).toMatchObject({ notYetGot: false })
    })

    it('answers 409 ROUTINE_NOT_READY, and appends no version, while a safety change hides the routine', async () => {
      const { guest, version } = await withRoutine()
      await putSafety(guest, { choices: ['pregnant'] })

      const res = await gotIt('moisturise', guest)

      expect(res.status).toBe(409)
      expect(await errorCodeOf(res)).toBe('ROUTINE_NOT_READY')
      expect((await routines.latest(guest.profileId))!.id).toBe(version.id)
    })

    it('is idempotent: tapping it three times answers 200 each time and leaves one got-it version', async () => {
      const { guest } = await withRoutine()
      expect((await gotIt('moisturise', guest)).status).toBe(200)
      const afterFirst = (await routines.latest(guest.profileId))!

      const second = await gotIt('moisturise', guest)
      const third = await gotIt('moisturise', guest)

      expect([second.status, third.status]).toEqual([200, 200])
      expect(stepsOf(await dataOf<ReadyBody>(third))[2]!.product).toMatchObject({ notYetGot: false })
      expect((await routines.latest(guest.profileId))!.id).toBe(afterFirst.id)
      expect(afterFirst.reason).toBe('got-it')
    })

    it('answers 429 RATE_LIMITED with Retry-After to the 11th of one account in a minute (the shelf\'s add limits)', async () => {
      const guest = await account()

      const { statuses, limited } = await inOneRateWindow(async () => {
        const statuses: number[] = []
        let limited: Response | undefined
        for (let i = 0; i < 11; i++) {
          const res = await gotIt('moisturise', guest)
          statuses.push(res.status)
          if (res.status === 429) limited = res
        }
        return { statuses, limited }
      }, { needMs: BURST_NEEDS_MS })

      expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true)
      expect(statuses[10]).toBe(429)
      expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
      expect(Number(limited!.headers.get('Retry-After'))).toBeGreaterThan(0)
    }, RATE_TEST_TIMEOUT_MS)
  })

  describe('POST /api/v1/me/routine/steps/{step}/find-sold-here', () => {
    const queuedFor = (guest: Guest) => routinesQueued.map((message) => message.body as Record<string, unknown>).filter((body) => body.profileId === guest.profileId)

    it('answers 400 VALIDATION_FAILED for a step that is not one of the four', async () => {
      const { guest } = await withRoutine()

      expect((await findSoldHere('serum', guest)).status).toBe(400)
    })

    it('answers 409 ROUTINE_NOT_READY before there is a routine, and queues nothing', async () => {
      const guest = await account()
      routinesEnabled = true

      const res = await findSoldHere('treat', guest)

      expect(res.status).toBe(409)
      expect(await errorCodeOf(res)).toBe('ROUTINE_NOT_READY')
      expect(queuedFor(guest)).toEqual([])
    })

    it.each([
      ['a product sold in her country already', 'moisturise'],
      ['a product of her own', 'cleanse'],
      ['nothing to recommend', 'protect'],
    ])('answers 409 STEP_NOT_RECOMMENDED for a step with %s, and queues nothing', async (_why, step) => {
      const { guest } = await withRoutine()
      routinesEnabled = true

      const res = await findSoldHere(step, guest)

      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ success: false, status: 409, error: { code: 'STEP_NOT_RECOMMENDED' } })
      expect(queuedFor(guest)).toEqual([])
    })

    it('answers 202 with the routine as updating, and queues one build for the step without that product, none in the request itself', async () => {
      const { guest, version } = await withRoutine()
      routinesEnabled = true

      const res = await findSoldHere('treat', guest)

      expect(res.status).toBe(202)
      const body = await dataOf<ReadyBody>(res)
      expect(body.status).toBe('updating')
      expect(stepsOf(body).map((s) => s.step)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
      expect(stepsOf(body)[1]!.product).toMatchObject({ code: TREAT_GH.code })
      expect(queuedFor(guest)).toEqual([
        {
          profileId: guest.profileId,
          reason: 'sold-here',
          requestKey: `sold-here:${version.id}:treat`,
          requestedAt: expect.any(Number),
          waits: 0,
          exclude: { step: 'treat', code: TREAT_GH.code },
        },
      ])
      // The writer runs in the job: the request appended no version.
      expect((await readyOf(guest)).status).toBe('ready')
    })

    it('answers 409 BUILD_IN_PROGRESS, queuing no second build, when asked again for the same step while the first build is waiting', async () => {
      const { guest } = await withRoutine()
      routinesEnabled = true
      await findSoldHere('treat', guest)

      const again = await findSoldHere('treat', guest)

      expect(again.status).toBe(409)
      expect(await errorCodeOf(again)).toBe('BUILD_IN_PROGRESS')
      expect(queuedFor(guest)).toHaveLength(1)
    })

    it('answers 409 BUILD_IN_PROGRESS, not 202, when another build holds the claim so the exclusion could not be queued', async () => {
      const { guest } = await withRoutine()
      routinesEnabled = true
      expect(await routines.claim(guest.profileId, 'verdict-fp', new Date(), new Date(Date.now() - 15 * MINUTE))).toBe(true)

      const res = await findSoldHere('treat', guest)

      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ success: false, status: 409, message: expect.stringMatching(/try again/i), error: { code: 'BUILD_IN_PROGRESS' } })
      expect(queuedFor(guest)).toEqual([])
    })

    it('queues nothing when routines are switched off, and still answers 202 with the routine', async () => {
      const { guest } = await withRoutine()

      const res = await findSoldHere('treat', guest)

      expect(res.status).toBe(202)
      expect((await dataOf<ReadyBody>(res)).status).toBe('updating')
      expect(queuedFor(guest)).toEqual([])
    })
  })

  describe('GET /api/v1/me/routine/events', () => {
    it('starts with a snapshot that is the body GET answers, and ends at once with done for a routine that is ready', async () => {
      const { guest } = await withRoutine()
      const { res, stream } = await watch(guest)

      const { frames, ended } = await stream.read(3)

      expect(res.headers.get('Content-Type')).toContain('text/event-stream')
      expect(frames.map((frame) => parseFrame(frame).event)).toEqual(['snapshot', 'done'])
      expect(parseFrame(frames[0]!).data).toEqual(await readyOf(guest))
      expect(parseFrame(frames[1]!).data).toEqual({})
      expect(ended).toBe(true)
    })

    it('carries the morning and evening lists and what was left out in the snapshot frame, the very ones the read answers, and no steps', async () => {
      const { guest } = await withRoutine()
      const { stream } = await watch(guest)

      const { frames } = await stream.read(3)

      const snapshot = parseFrame(frames[0]!).data as ReadyBody
      const read = await readyOf(guest)
      expect(snapshot).not.toHaveProperty('steps')
      expect(snapshot.morning.map((s) => s.step)).toEqual(['cleanse', 'moisturise', 'protect'])
      expect(snapshot.evening.map((s) => s.step)).toEqual(['treat', 'moisturise'])
      expect(snapshot.notInRoutine).toHaveLength(2)
      expect([snapshot.morning, snapshot.evening, snapshot.notInRoutine]).toEqual([read.morning, read.evening, read.notInRoutine])
    })

    it('carries the plan summary in the snapshot frame, the one the read answers', async () => {
      const { guest } = await withRoutine()
      const { stream } = await watch(guest)

      const { frames } = await stream.read(3)

      const snapshot = parseFrame(frames[0]!).data as ReadyBody
      expect(snapshot.summary).toMatchObject({ goal: { id: 'glow', label: 'A glow' }, keepUsing: 1, useLessOrChange: 5, stepDown: { products: [expect.objectContaining({ name: expect.any(String) })] } })
      expect(snapshot.summary).toEqual((await readyOf(guest)).summary)
    })

    it('starts with a pending snapshot and stays open for an account with no routine yet', async () => {
      const guest = await account()
      const { stream } = await watch(guest)

      const { frames, ended } = await stream.read(2, QUIET_MS)

      expect(frames.map((frame) => parseFrame(frame))).toEqual([{ event: 'snapshot', data: { status: 'pending' }, comment: null }])
      expect(ended).toBe(false)
    })

    it('starts with an updating snapshot of the routine in force and stays open while a newer build is under way', async () => {
      const { guest } = await withRoutine()
      await appendPending(guest)
      const { stream } = await watch(guest)

      const { frames, ended } = await stream.read(2, QUIET_MS)

      expect(frames).toHaveLength(1)
      expect(parseFrame(frames[0]!)).toMatchObject({ event: 'snapshot', data: { status: 'updating' } })
      expect(ended).toBe(false)
    })

    it('answers the usual JSON envelope, not a stream, before it starts: 403 to a guest and 409 without a goal', async () => {
      const guest = await newGuest()
      const forbidden = await eventsOf(guest)
      expect(forbidden.status).toBe(403)
      expect(forbidden.headers.get('Content-Type')).toContain('application/json')

      await guest.signUp()
      const noGoal = await eventsOf(guest)
      expect(noGoal.status).toBe(409)
      expect(await errorCodeOf(noGoal)).toBe('GOAL_REQUIRED')
    })
  })

  // #217 PR 2 (screens 4.7 and 4.8). The body is { category, guide: { whatItDoes, lookFor, forDeeperSkin }, typicalPrice: { low, high, currency } | null, commonlySoldAt: string[],
  // products: { code, brand, name, imageUrl, origin?, aboutPrice: { amount, currency }, whereSold, why, keyIngredient, strength, inYourRoutine }[] }. The guide texts are the
  // workbook's base rows (admin.catalog.support's baseGuideRows says "What moisturise does." and so on), the prices and places are the seeded availability rows, and the
  // routine is the seeded one: moisturise's pick is MOIST_NG (3000 to 4500, brand-submitted) and a cheaper MOIST_GH_TOO (2500 to 3000) is the other Nigerian candidate.
  // The seeded person has the glow goal (radiance, moisture, texture), so a product for hd_moisture works on "dry skin".
  describe('GET /api/v1/me/routine/steps/{step}/look-for', () => {
    const PREGNANT_LOOK_FOR = 'Look for a plain moisturiser with no added actives.'
    const GLOW_PROTECT = { what_it_does: 'Protects your glow from the sun.', look_for: 'A sunscreen that feels light on the skin.', for_deeper_skin: 'Pick a finish that leaves no grey film.' }
    type LookForBody = {
      category: string
      guide: { whatItDoes: string; lookFor: string; forDeeperSkin: string }
      typicalPrice: { low: number; high: number; currency: string } | null
      commonlySoldAt: string[]
      products: Record<string, any>[]
    }
    const lookForOf = async (step: string, guest: Guest) => dataOf<LookForBody>(await lookFor(step, guest))

    beforeAll(async () => {
      await applied((workbook) => {
        const moisturiseBase = workbook.guides.rows.find((row) => row.step === 'moisturise' && row.goal === null)!
        moisturiseBase.look_for_when_pregnant = PREGNANT_LOOK_FOR
        workbook.guides.rows.push(guideRow({ step: 'protect', goal: 'glow', ...GLOW_PROTECT }))
      })
    })

    it('answers a recommended step with its guide, price range, places and reviewed products: the routine\'s pick first although a cheaper one exists', async () => {
      const { guest } = await withRoutine()

      const res = await lookFor('moisturise', guest)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        success: true,
        status: 200,
        message: expect.any(String),
        data: {
          category: 'Moisturiser',
          guide: { whatItDoes: 'What moisturise does.', lookFor: 'What to look for in moisturise.', forDeeperSkin: 'Deeper skin and moisturise.' },
          typicalPrice: { low: 2500, high: 4500, currency: 'NGN' },
          commonlySoldAt: ['Pharmacies and online'],
          products: [
            {
              code: MOIST_NG.code,
              brand: MOIST_NG.brand,
              name: MOIST_NG.name,
              imageUrl: null,
              origin: 'brand-submitted',
              aboutPrice: { amount: 3000, currency: 'NGN' },
              whereSold: 'Pharmacies and online',
              why: 'Works on dry skin.',
              keyIngredient: 'Shea butter',
              strength: '15%',
              inYourRoutine: true,
            },
            {
              code: MOIST_GH_TOO.code,
              brand: MOIST_GH_TOO.brand,
              name: MOIST_GH_TOO.name,
              imageUrl: null,
              aboutPrice: { amount: 2500, currency: 'NGN' },
              whereSold: 'Pharmacies and online',
              why: 'Works on dry skin.',
              keyIngredient: null,
              strength: null,
              inYourRoutine: false,
            },
          ],
        },
      })
    })

    it('answers a step whose pick is sold only in another country with the guide and no products or price, not an error', async () => {
      const { guest } = await withRoutine()

      const body = await lookForOf('treat', guest)

      expect(body).toEqual({
        category: 'Treatment',
        guide: { whatItDoes: 'What treat does.', lookFor: 'What to look for in treat.', forDeeperSkin: 'Deeper skin and treat.' },
        typicalPrice: null,
        commonlySoldAt: [],
        products: [],
      })
    })

    it('answers a "use what you have" step with the guide written for the person\'s goal instead of the step\'s base row', async () => {
      const { guest } = await withRoutine()

      const body = await lookForOf('protect', guest)

      expect(body.category).toBe('Sunscreen')
      expect(body.guide).toEqual({ whatItDoes: GLOW_PROTECT.what_it_does, lookFor: GLOW_PROTECT.look_for, forDeeperSkin: GLOW_PROTECT.for_deeper_skin })
      expect(body.products).toEqual([])
    })

    it.each(['pregnant', 'breastfeeding'])('serves the pregnancy-safe look-for text to a person who ticked %s', async (choice) => {
      const { guest, version } = await withRoutine({ cautions: [] })
      // The routine in force for her is one built under that caution (the one built before she ticked it is hidden until the rebuild), appended as the build does.
      await putSafety(guest, { choices: [choice] })
      await appendVersion(guest, { steps: version.steps, cautions: [choice as never] })

      const body = await lookForOf('moisturise', guest)

      expect(body.guide.lookFor).toBe(PREGNANT_LOOK_FOR)
      expect(body.guide).not.toHaveProperty('lookForWhenPregnant')
      expect(body.guide.whatItDoes).toBe('What moisturise does.')
      expect(body.guide.forDeeperSkin).toBe('Deeper skin and moisturise.')
    })

    it('answers 409 STEP_IS_YOURS for a step that is the person\'s own shelf product', async () => {
      const { guest } = await withRoutine()

      const res = await lookFor('cleanse', guest)

      expect(res.status).toBe(409)
      expect(await errorCodeOf(res)).toBe('STEP_IS_YOURS')
    })

    it('answers 409 ROUTINE_NOT_READY before there is a routine, and while a safety change hides it', async () => {
      const none = await account()
      const none409 = await lookFor('moisturise', none)
      expect(none409.status).toBe(409)
      expect(await errorCodeOf(none409)).toBe('ROUTINE_NOT_READY')

      const { guest } = await withRoutine({ cautions: [] })
      await putSafety(guest, { choices: ['pregnant'] })
      const hidden = await lookFor('moisturise', guest)
      expect(hidden.status).toBe(409)
      expect(await errorCodeOf(hidden)).toBe('ROUTINE_NOT_READY')
    })

    it('answers 400 VALIDATION_FAILED for a step that is not one of the four', async () => {
      const { guest } = await withRoutine()

      const res = await lookFor('serum', guest)

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    })

    it('has no internal field or value in the body: nothing of how a product or a guide was reached', async () => {
      const { guest } = await withRoutine()
      const res = await lookFor('moisturise', guest)
      const text = await res.text()

      const keys = new Set<string>()
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk)
        else if (value !== null && typeof value === 'object') for (const [key, inner] of Object.entries(value)) (keys.add(key), walk(inner))
      }
      // The body, not the envelope: the envelope's own `status` is the HTTP status, not a stored one.
      walk(JSON.parse(text).data)

      expect(res.status).toBe(200)
      for (const internal of ['ingredients', 'evidenceUrls', 'ingredientsSourceUrl', 'passed', 'sharedWithReaction', 'frequency', 'skinConcerns', 'productId', 'formulationId', 'id', 'product', 'lookForWhenPregnant', 'approvedBy', 'approvedOn', 'auditedBy', 'status', 'grounding', 'priceMin', 'priceMax']) {
        expect(keys, internal).not.toContain(internal)
      }
      for (const value of ['shop.example', 'Cetearyl', 'Test Reviewer', 'Dr A. Reviewer', 'internal.example']) expect(text, value).not.toContain(value)
    })
  })

  describe('a guest who signs up', () => {
    it('gets the routine the guest had: promotion keeps the profile', async () => {
      const guest = await newGuest()
      await putGoal(guest)
      await putSafety(guest)
      await putShopping(guest)
      const own = await onShelf(guest)
      await appendVersion(guest, { steps: [stored('cleanse', { kind: 'shelf', id: own }, 'am')] })
      expect((await getRoutine(guest)).status).toBe(403)

      await guest.signUp()

      const body = await readyOf(guest)
      expect(body.status).toBe('ready')
      expect(stepsOf(body).map((s) => s.step)).toEqual(['cleanse'])
    })
  })
})
