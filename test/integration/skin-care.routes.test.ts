import { abortAllDurableObjects, createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { D1CatalogWorkbookRepository } from '../../src/modules/catalog/catalog.workbook.repository'
import { FakeOpsAlertsRepository } from '../../src/modules/ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { ProfilesService } from '../../src/modules/profiles/profiles.service'
import { D1RoutinesRepository, type RoutineVersionRow } from '../../src/modules/routines/routines.repository'
import { profileProducts } from '../../src/modules/shelf/shelf.table'
import { D1StepPausesRepository } from '../../src/modules/skin-care/skin-care.pauses.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'
import { applied, code, responseRow, taperRow } from './admin.catalog.support'
import { countryRow, putCountry, type RawWorkbook } from './catalog.workbook.support'

// The skin-log and pause routes (spec #233, PR 4b) through the Worker's public surface: the real entrypoint and real local D1 under it, plain fetch (the typed client has no call
// for routes that did not exist) and the typed client for the set-up that already does. A routine reaches the database the way a build leaves it: appended through
// D1RoutinesRepository.append, never by the real writer. What a pause is, who it picks and how Undo counts days is skin-care.service.pauses.test.ts's business and the choice
// is skin-care.step-choice.test.ts's; this file is the routes': who may ask, the envelope, every status code, the shape of what a client reads, and that a pause reaches
// `GET /me/routine`.
//
// THE PUBLIC SHAPE PINNED HERE (assumed: the brief gives the bodies in prose; the wrappers named below are the assumptions):
//   POST /api/v1/me/skin-logs   { noticing: string[], where?: string[], howBad?: string | null, note?: string | null }
//        200 { log: { id, day, noticing, where, howBad, outcome }, outcome, response, paused: { id, step, title, checkDay } | null }
//        outcome is the service's: { kind: 'pause', duringStepDown } | { kind: 'professional', reason } | { kind: 'advice', codes } | { kind: 'nothing-to-pause' } | { kind: 'expected-flare' } | { kind: 'logged' }
//        response is the reviewed text: a { title, body, whatToDoNow } for a pause (with {step} filled), nothing-to-pause and the expected flare, an array of them for advice,
//        { whoToSee, howSoon, whatToTellThem, facts } for a professional, null for a good day. paused.title is the routine's title for the step; paused.checkDay is the local day + 3.
//        The schema's enums are the vocabulary: an unknown symptom, place or level is 400 VALIDATION_FAILED, as is every refusal of the service's rules (nothing stored).
//   GET  /api/v1/me/skin-logs   200 { logs: [{ id, day, noticing, where, howBad, outcome }] }, the last 20, newest first. Never the note or the profile id.
//   POST /api/v1/me/skin-care/pauses/{id}/undo   200 { id, state: 'undone' }; 404 PAUSE_NOT_FOUND (not the caller's, or none); 409 UNDO_EXPIRED after the pause's local day.
//   All three: 401 AUTH_REQUIRED with no session (before the body is looked at), 403 SIGNUP_REQUIRED for a guest.
//   GET /api/v1/me/routine marks an entry `status: 'paused'` while its step's product is paused, and `active` again after Undo.
//
// The worker runs on the real clock, so every day here hangs off one ANCHOR taken at load. A pause that must have been made on an earlier day is put in place through the
// pauses repository (the only way to be a day late within a test); that one case is marked where it happens.

const ORIGIN = 'http://deepertones.test'
const SOURCE_URL = 'https://shop.example/product'
const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
const STEROID_TAPER = code('TPR-STEROID')
const LIGHTENING_TAPER = code('TPR-LIGHTENING')

const ANCHOR = new Date()
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (offsetMs: number) => new Date(ANCHOR.getTime() + offsetMs)
const utcDay = (date: Date) => date.toISOString().slice(0, 10)

const quietQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
const workerEnv = () =>
  ({
    ...env,
    OTP_CHANNELS: 'email',
    ROUTINES_ENABLED: 'false',
    ROUTINES_QUEUE: quietQueue,
    VERDICTS_QUEUE: quietQueue,
    SCAN_ITEMS_QUEUE: quietQueue,
    PARSE_SAFETY_QUEUE: quietQueue,
    PUSH_DELIVERY_QUEUE: quietQueue,
  }) as typeof env
const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, workerEnv(), createExecutionContext())
const api = hc<AppType>(ORIGIN, { fetch: fetchWorker as typeof fetch })
const v1 = api.api.v1

afterEach(async () => {
  await abortAllDurableObjects()
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshEmail = () => `SkinCare-${runSalt}-${next()}@Example.com`
const freshBrand = () => `${runSalt}${next()}x SkinCareBrand`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number }
const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
const errorCodeOf = async (res: Reply) => {
  const body = (await res.json()) as Envelope<unknown>
  if (body.success) throw new Error(`expected an error, got ${res.status}`)
  return body.error.code
}

const headers = (bearer?: string): Record<string, string> => ({
  'cf-connecting-ip': freshIp(),
  ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
})

// --- people ---

const db = createDb(env.DB)
const users = new UsersService({ repository: new D1UsersRepository(db) })
const profiles = new ProfilesService({ repository: new D1ProfilesRepository(db) })
const tokenService = new TokenService({ secret: env.JWT_SECRET })

type Account = { userId: string; profileId: string; accessToken: string }

const newGuest = async () => {
  const res = await v1.auth.anonymous.$post({ json: { deviceId: `device-skin-${runSalt}-${next()}`, platform: 'ios' } }, { headers: headers() })
  const session = await dataOf<{ tokens: { accessToken: string } }>(res)
  return { accessToken: session.tokens.accessToken }
}

/** A signed-up account with a goal, safety answers and a shopping country: ready to have a routine. */
const newAccount = async (): Promise<Account> => {
  const guest = await users.guestForDevice(`seed-skin-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: freshEmail().toLowerCase() as EmailAddress })
  const profileId = (await profiles.defaultFor(user.id)).id
  const accessToken = (await tokenService.issue(user, profileId)).accessToken
  expect((await v1.me.goal.$put({ json: { goal: 'glow' } as never }, { headers: headers(accessToken) })).status).toBe(200)
  expect((await v1.me.safety.$put({ json: { choices: ['none'] } as never }, { headers: headers(accessToken) })).status).toBe(200)
  expect((await v1.me.shopping.$put({ json: { country: 'NG' } as never }, { headers: headers(accessToken) })).status).toBe(200)
  return { userId: user.id, profileId, accessToken }
}

// --- the shelf, the workbook and the routine ---

/** A shelf entry with no label (a product the app could not read), put on the account's shelf. It has no catalog product, so its pause is keyed by the entry id. */
const noLabelOnShelf = async (account: Account): Promise<string> => {
  const id = crypto.randomUUID()
  const now = new Date()
  await db.insert(profileProducts).values({ id, profileId: account.profileId, kind: 'no-label', productId: null, formulationId: null, scanId: crypto.randomUUID(), itemId: crypto.randomUUID(), addedAt: now, lastScannedAt: now })
  return id
}

const quietOpsAlerts = () => new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: new MemoryJobQueue(), email: new MemoryEmailSender(), recipient: '', environment: 'test' })
/** A product the catalog holds, researched and analysed, put on the account's shelf. Answers the shelf entry's id. */
const onShelf = async (account: Account): Promise<string> => {
  const researcher = new MemoryProductResearcher()
  researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))
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
  await db.insert(profileProducts).values({ id, profileId: account.profileId, kind: 'product', productId: resolved.productId, formulationId: found.formulationId, scanId: crypto.randomUUID(), itemId: crypto.randomUUID(), addedAt: now, lastScannedAt: now })
  return id
}

// The reviewed text is the workbook's, one database for the whole file. The paused and nothing-to-pause rows are written with {step}, as the team writes them; every other
// row is the support file's default, which names its own key.
const PAUSED_BODY = 'Your skin needs a rest from your {step}. We will ask how it feels in three days.'
const NOTHING_BODY = 'Skip anything that stings and rinse with water. Keep {step} simple until it settles.'
beforeAll(async () => {
  await applied((workbook) => {
    const raw = workbook as unknown as RawWorkbook
    putCountry(raw, countryRow('NG'))
    workbook.tapers.rows.push(taperRow({ code: STEROID_TAPER, kind: 'steroid' }), taperRow({ code: LIGHTENING_TAPER, kind: 'lightening-agent' }))
    workbook.responses.rows.push(
      responseRow({ outcome: 'paused', title: 'We paused your {step}', body: PAUSED_BODY, what_to_do_now: 'Skip anything that stings. Keep to a gentle cleanser and moisturiser.' }),
      responseRow({ outcome: 'nothing-to-pause', title: 'Nothing to pause yet', body: NOTHING_BODY, what_to_do_now: 'Keep sunscreen if it does not sting.' }),
    )
  })
})

const routines = new D1RoutinesRepository(db)
type StoredStep = RoutineVersionRow['steps'][number]
const stored = (step: StoredStep['step'], product: StoredStep['product'], frequency: StoredStep['frequency']): StoredStep => ({
  step,
  product,
  frequency,
  reason: `Reason for ${step}.`,
  grounding: ['https://internal.example/grounding'],
  gotIt: false,
  fixedFrom: null,
  changedOn: null,
})
const appendVersion = async (account: Account, over: Partial<RoutineVersionRow> = {}): Promise<RoutineVersionRow> => {
  const row: RoutineVersionRow = {
    id: crypto.randomUUID(),
    profileId: account.profileId,
    status: 'ready',
    createdAt: at(-HOUR),
    steps: [],
    tapers: [],
    expectation: 'Give it 8 to 12 weeks before judging.',
    cautions: [],
    goal: 'glow',
    shelfCounts: { keep: 3, reduce: 0, drop: 0, stop: 0 },
    notInRoutine: [],
    readyAt: at(-HOUR + MINUTE),
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

/** An account whose routine, started three days ago, is its own cleanser, treatment and moisturiser (all plain products: no step is active) and no sunscreen. */
const withRoutine = async (over: Partial<RoutineVersionRow> = {}, options: { steppingDown?: boolean; noLabelTreat?: boolean } = {}) => {
  const account = await newAccount()
  const entries = { cleanse: await onShelf(account), treat: options.noLabelTreat ? await noLabelOnShelf(account) : await onShelf(account), moisturise: await onShelf(account) }
  // A steroid cream being stopped slowly: its step-down began three days ago and runs five weeks (the template's schedule), so one is running today.
  const stopped = options.steppingDown ? await onShelf(account) : null
  await appendVersion(account, {
    tapers: stopped === null ? [] : [{ shelfProductId: stopped, templateId: STEROID_TAPER, startedOn: new Date(`${utcDay(at(-3 * DAY))}T00:00:00.000Z`) }],
    notInRoutine: stopped === null ? [] : [{ entryId: stopped, title: 'Cream', status: 'stepping-down', reason: 'It has a steroid in it, so we stop it slowly.' }],
    steps: [
      stored('cleanse', { kind: 'shelf', id: entries.cleanse }, 'am'),
      stored('treat', { kind: 'shelf', id: entries.treat }, 'pm'),
      stored('moisturise', { kind: 'shelf', id: entries.moisturise }, 'am-pm'),
      stored('protect', { kind: 'none' }, 'am'),
    ],
    startedOn: new Date(`${utcDay(at(-3 * DAY))}T00:00:00.000Z`),
    ...over,
  })
  return { ...account, entries }
}

// --- the calls ---

type SkinLog = { id: string; day: string; noticing: string[]; where: string[]; howBad: string | null; outcome: string }
type Paused = { id: string; step: string; title: string; checkDay: string }
type LogResult = { log: SkinLog; outcome: { kind: string; [key: string]: unknown }; response: any; paused: Paused | null }
type Step = { step: string; title: string; status: string }
type RoutineBody = { status: string; morning: Step[]; evening: Step[] }

const postLog = (bearer: string | undefined, json: unknown) =>
  fetchWorker(`${ORIGIN}/api/v1/me/skin-logs`, { method: 'POST', headers: { ...headers(bearer), 'content-type': 'application/json' }, body: JSON.stringify(json) })
const getLogs = (bearer?: string) => fetchWorker(`${ORIGIN}/api/v1/me/skin-logs`, { headers: headers(bearer) })
const postUndo = (bearer: string | undefined, id: string) => fetchWorker(`${ORIGIN}/api/v1/me/skin-care/pauses/${id}/undo`, { method: 'POST', headers: headers(bearer) })
const getRoutine = (bearer: string) => fetchWorker(`${ORIGIN}/api/v1/me/routine`, { headers: headers(bearer) })

const STING = { noticing: ['stinging-or-burning'], where: ['cheeks'], howBad: 'mild' }
const sting = async (account: Account) => dataOf<LogResult>(await postLog(account.accessToken, STING))
/** The entries of the routine body once each, with the status the body gives them. */
const statusesOf = async (account: Account): Promise<Record<string, string>> => {
  const body = await dataOf<RoutineBody>(await getRoutine(account.accessToken))
  const byStep = new Map<string, Step>()
  for (const entry of [...body.morning, ...body.evening]) if (!byStep.has(entry.step)) byStep.set(entry.step, entry)
  return Object.fromEntries([...byStep.values()].map((entry) => [entry.step, entry.status]))
}
const titleOf = async (account: Account, step: string): Promise<string> => {
  const body = await dataOf<RoutineBody>(await getRoutine(account.accessToken))
  return [...body.morning, ...body.evening].find((entry) => entry.step === step)!.title
}

describe('who may use the skin-log and pause routes', () => {
  const calls: [string, (bearer?: string) => Response | Promise<Response>][] = [
    ['POST /me/skin-logs', (bearer) => postLog(bearer, STING)],
    ['GET /me/skin-logs', (bearer) => getLogs(bearer)],
    ['POST /me/skin-care/pauses/{id}/undo', (bearer) => postUndo(bearer, crypto.randomUUID())],
  ]

  it.each(calls)('%s answers 401 AUTH_REQUIRED with no session', async (_name, call) => {
    const res = await call()

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it.each(calls)('%s answers 403 SIGNUP_REQUIRED to a guest', async (_name, call) => {
    const { accessToken } = await newGuest()

    const res = await call(accessToken)

    expect(res.status).toBe(403)
    expect(await errorCodeOf(res)).toBe('SIGNUP_REQUIRED')
  })

  it('answers 401 to a log with no session before it looks at the body, a bodiless one included', async () => {
    const withoutBody = await fetchWorker(`${ORIGIN}/api/v1/me/skin-logs`, { method: 'POST', headers: headers() })
    const invalid = await postLog(undefined, { noticing: ['rash'] })

    expect(withoutBody.status).toBe(401)
    expect(invalid.status).toBe(401)
  })
})

describe('POST /api/v1/me/skin-logs: pausing a step', () => {
  it('pauses the step the rules choose and answers the log, the outcome, the reviewed text with {step} filled and the pause', async () => {
    const account = await withRoutine()
    const treatTitle = await titleOf(account, 'treat')

    const res = await postLog(account.accessToken, { ...STING, note: 'It started after the serum.' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: true; status: 200; message: string; data: LogResult }
    expect(body).toMatchObject({ success: true, status: 200, message: expect.any(String) })
    expect(body.data).toEqual({
      log: { id: expect.any(String), day: utcDay(ANCHOR), noticing: ['stinging-or-burning'], where: ['cheeks'], howBad: 'mild', outcome: 'pause' },
      outcome: { kind: 'pause', duringStepDown: false },
      response: {
        title: 'We paused your Treatment',
        body: 'Your skin needs a rest from your Treatment. We will ask how it feels in three days.',
        whatToDoNow: 'Skip anything that stings. Keep to a gentle cleanser and moisturiser.',
      },
      paused: { id: expect.any(String), step: 'treat', title: treatTitle, checkDay: utcDay(at(3 * DAY)) },
    })
    expect(JSON.stringify(body)).not.toContain('It started after the serum.')
  })

  it('shows the paused step as paused in the routine, and the others as active', async () => {
    const account = await withRoutine()
    expect(await statusesOf(account)).toEqual({ cleanse: 'active', treat: 'active', moisturise: 'active', protect: 'active' })

    await sting(account)

    expect(await statusesOf(account)).toEqual({ cleanse: 'active', treat: 'paused', moisturise: 'active', protect: 'active' })
  })

  it('does not show another account\'s pause in this account\'s routine', async () => {
    const paused = await withRoutine()
    const other = await withRoutine()

    await sting(paused)

    expect(await statusesOf(other)).toEqual({ cleanse: 'active', treat: 'active', moisturise: 'active', protect: 'active' })
  })

  it('pauses the next step on a second log, and sends a third harm log to a professional with the two pauses untouched', async () => {
    const account = await withRoutine()
    const first = await sting(account)
    const second = await sting(account)

    const res = await postLog(account.accessToken, { ...STING, note: 'Still stinging.' })

    expect(first.paused).toMatchObject({ step: 'treat' })
    expect(second.paused).toMatchObject({ step: 'cleanse' })
    expect(res.status).toBe(200)
    expect(await dataOf<LogResult>(res)).toEqual({
      log: expect.objectContaining({ outcome: 'professional' }),
      outcome: { kind: 'professional', reason: 'harm-while-two-paused' },
      response: {
        whoToSee: 'Who to see for harm-while-two-paused.',
        howSoon: 'How soon for harm-while-two-paused.',
        whatToTellThem: 'What to tell them for harm-while-two-paused.',
        facts: { noticing: ['stinging-or-burning'], where: ['cheeks'], howBad: 'mild', note: 'Still stinging.' },
      },
      paused: null,
    })
    expect(await statusesOf(account)).toEqual({ cleanse: 'paused', treat: 'paused', moisturise: 'active', protect: 'active' })
  })
})

describe('POST /api/v1/me/skin-logs: a shelf product with no label', () => {
  // The pause is keyed by the shelf entry id (it has no catalog product), and the routine matches it on that key: the entry shows as paused like any other.
  it('can be paused, and the routine shows it as paused, then active again after Undo', async () => {
    const account = await withRoutine({}, { noLabelTreat: true })
    expect(await statusesOf(account)).toEqual({ cleanse: 'active', treat: 'active', moisturise: 'active', protect: 'active' })

    const result = await sting(account)

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(result.paused).toMatchObject({ step: 'treat' })
    expect(await statusesOf(account)).toEqual({ cleanse: 'active', treat: 'paused', moisturise: 'active', protect: 'active' })

    expect((await postUndo(account.accessToken, result.paused!.id)).status).toBe(200)
    expect(await statusesOf(account)).toEqual({ cleanse: 'active', treat: 'active', moisturise: 'active', protect: 'active' })
  })

  it('does not show another account\'s no-label entry as paused', async () => {
    const paused = await withRoutine({}, { noLabelTreat: true })
    const other = await withRoutine({}, { noLabelTreat: true })

    await sting(paused)

    expect(await statusesOf(other)).toEqual({ cleanse: 'active', treat: 'active', moisturise: 'active', protect: 'active' })
  })
})

describe('POST /api/v1/me/skin-logs: the other outcomes', () => {
  it('answers nothing-to-pause before there is a routine at all, with the reviewed text and "your routine"', async () => {
    const account = await newAccount()

    const res = await postLog(account.accessToken, STING)

    expect(res.status).toBe(200)
    expect(await dataOf<LogResult>(res)).toEqual({
      log: expect.objectContaining({ outcome: 'nothing-to-pause', day: utcDay(ANCHOR) }),
      outcome: { kind: 'nothing-to-pause' },
      response: {
        title: 'Nothing to pause yet',
        body: 'Skip anything that stings and rinse with water. Keep your routine simple until it settles.',
        whatToDoNow: 'Keep sunscreen if it does not sting.',
      },
      paused: null,
    })
  })

  it('answers nothing-to-pause for a routine that has not been started, and shows no step as paused', async () => {
    const account = await withRoutine({ startedOn: null })

    const result = await sting(account)

    expect(result.outcome).toEqual({ kind: 'nothing-to-pause' })
    expect(await statusesOf(account)).toEqual({ cleanse: 'active', treat: 'active', moisturise: 'active', protect: 'active' })
  })

  it('answers the reviewed advice, one line for each thing noticed, and pauses nothing', async () => {
    const account = await withRoutine()

    const result = await dataOf<LogResult>(await postLog(account.accessToken, { noticing: ['itching', 'tightness-or-dryness'], howBad: 'noticeable' }))

    expect(result.outcome).toEqual({ kind: 'advice', codes: ['advice-tightness', 'advice-itching'] })
    expect(result.response).toEqual([
      { title: 'Title for advice-tightness', body: 'Body for advice-tightness.', whatToDoNow: 'What to do for advice-tightness.' },
      { title: 'Title for advice-itching', body: 'Body for advice-itching.', whatToDoNow: 'What to do for advice-itching.' },
    ])
    expect(result.paused).toBeNull()
    expect(await statusesOf(account)).toEqual({ cleanse: 'active', treat: 'active', moisturise: 'active', protect: 'active' })
  })

  it('sends a red flag to a professional with the reviewed row and what was logged, the note included, and pauses nothing', async () => {
    const account = await withRoutine()

    const result = await dataOf<LogResult>(await postLog(account.accessToken, { noticing: ['swelling'], where: ['nose'], howBad: 'mild', note: 'Since Tuesday.' }))

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'swelling' })
    expect(result.response).toEqual({
      whoToSee: 'Who to see for swelling.',
      howSoon: 'How soon for swelling.',
      whatToTellThem: 'What to tell them for swelling.',
      facts: { noticing: ['swelling'], where: ['nose'], howBad: 'mild', note: 'Since Tuesday.' },
    })
    expect(result.paused).toBeNull()
  })

  it('records a good day with no level and no text', async () => {
    const account = await newAccount()

    const result = await dataOf<LogResult>(await postLog(account.accessToken, { noticing: ['nothing-unusual'] }))

    expect(result).toEqual({ log: expect.objectContaining({ outcome: 'logged', howBad: null, where: [] }), outcome: { kind: 'logged' }, response: null, paused: null })
  })
})

describe('POST /api/v1/me/skin-logs: what it refuses', () => {
  it.each([
    ['no noticing', {}],
    ['an empty noticing', { noticing: [], howBad: 'mild' }],
    ['noticing that is not a list', { noticing: 'itching', howBad: 'mild' }],
    ['a symptom outside the vocabulary', { noticing: ['rash'], howBad: 'mild' }],
    ['a place outside the vocabulary', { noticing: ['itching'], where: ['ear'], howBad: 'mild' }],
    ['a level outside the vocabulary', { noticing: ['itching'], howBad: 'awful' }],
    ['a symptom with no level', { noticing: ['itching'] }],
    ['a symptom with a null level', { noticing: ['swelling'], howBad: null }],
    ['nothing unusual together with a symptom', { noticing: ['nothing-unusual', 'itching'], howBad: 'mild' }],
    ['nothing unusual together with a place', { noticing: ['nothing-unusual'], where: ['near-eyes'] }],
    ['a note of 501 characters', { noticing: ['itching'], howBad: 'mild', note: 'a'.repeat(501) }],
    ['a note that is not text', { noticing: ['itching'], howBad: 'mild', note: 7 }],
  ])('answers 400 VALIDATION_FAILED for %s, and stores nothing', async (_why, json) => {
    const account = await newAccount()

    const res = await postLog(account.accessToken, json)

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    expect(await dataOf(await getLogs(account.accessToken))).toEqual({ logs: [] })
  })

  it('accepts a note of exactly 500 characters', async () => {
    const account = await newAccount()

    const res = await postLog(account.accessToken, { noticing: ['itching'], howBad: 'mild', note: 'a'.repeat(500) })

    expect(res.status).toBe(200)
  })
})

describe('GET /api/v1/me/skin-logs', () => {
  it('answers no logs for an account that never logged', async () => {
    const account = await newAccount()

    const res = await getLogs(account.accessToken)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ logs: [] })
  })

  it('answers the caller\'s logs newest first, each as the log was answered, and never the note, the profile or another account\'s logs', async () => {
    const account = await withRoutine()
    const other = await newAccount()
    const first = await dataOf<LogResult>(await postLog(account.accessToken, { noticing: ['itching'], howBad: 'mild', note: 'A private note about my cheeks.' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await dataOf<LogResult>(await postLog(account.accessToken, { noticing: ['nothing-unusual'] }))
    await postLog(other.accessToken, { noticing: ['nothing-unusual'] })

    const res = await getLogs(account.accessToken)

    expect(res.status).toBe(200)
    const { logs } = await dataOf<{ logs: SkinLog[] }>(res)
    expect(logs).toEqual([second.log, first.log])
    for (const entry of logs) {
      expect(entry).not.toHaveProperty('note')
      expect(entry).not.toHaveProperty('profileId')
    }
    expect(JSON.stringify(logs)).not.toContain('A private note')
  })
})

describe('POST /api/v1/me/skin-care/pauses/{id}/undo', () => {
  it('brings the step back on the day it was paused: 200, the routine shows it active again, and a new harm log can pause it again', async () => {
    const account = await withRoutine()
    const result = await sting(account)
    expect(await statusesOf(account)).toMatchObject({ treat: 'paused' })

    const res = await postUndo(account.accessToken, result.paused!.id)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ id: result.paused!.id, state: 'undone' })
    expect(await statusesOf(account)).toEqual({ cleanse: 'active', treat: 'active', moisturise: 'active', protect: 'active' })
    expect((await sting(account)).paused).toMatchObject({ step: 'treat' })
  })

  it('keeps the log it undid in the list', async () => {
    const account = await withRoutine()
    const result = await sting(account)

    await postUndo(account.accessToken, result.paused!.id)

    expect((await dataOf<{ logs: SkinLog[] }>(await getLogs(account.accessToken))).logs.map((entry) => entry.id)).toEqual([result.log.id])
  })

  // The Worker runs on the real clock, so a pause "from yesterday" is put in place through the pauses repository, the way the pauses of an earlier day are left by the log route.
  it('answers 409 UNDO_EXPIRED for a pause made on an earlier day, and leaves it paused', async () => {
    const account = await withRoutine()
    const pauses = new D1StepPausesRepository(db)
    const yesterday = crypto.randomUUID()
    await pauses.insert({
      id: yesterday,
      profileId: account.profileId,
      step: 'treat',
      productKey: `old-${yesterday}`,
      productId: null,
      productRef: { kind: 'shelf', id: account.entries.treat },
      ingredientGroup: null,
      state: 'paused',
      pausedOn: utcDay(at(-DAY)),
      checkDay: utcDay(at(2 * DAY)),
      sameCount: 0,
      sourceLogId: `log-${yesterday}`,
      ladderCode: null,
      ladderStartedOn: null,
      versionId: null,
      createdAt: at(-DAY),
    })

    const res = await postUndo(account.accessToken, yesterday)

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('UNDO_EXPIRED')
    expect((await pauses.find(account.profileId, yesterday))!.state).toBe('paused')
  })

  it('answers 404 PAUSE_NOT_FOUND for another account\'s pause, and leaves it paused', async () => {
    const owner = await withRoutine()
    const stranger = await newAccount()
    const result = await sting(owner)

    const res = await postUndo(stranger.accessToken, result.paused!.id)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('PAUSE_NOT_FOUND')
    expect(await statusesOf(owner)).toMatchObject({ treat: 'paused' })
  })

  it('answers 404 PAUSE_NOT_FOUND for a pause that does not exist', async () => {
    const account = await newAccount()

    const res = await postUndo(account.accessToken, crypto.randomUUID())

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('PAUSE_NOT_FOUND')
  })
})

// The step-down that is running comes from the routine in force (the viewer's read), not from a stub: with one running, redness is the expected flare and a strong flare
// never pauses a basic step.
describe('POST /api/v1/me/skin-logs: while a step-down is running in the routine', () => {
  it('explains mild redness as the expected flare, with the reviewed text, and pauses nothing', async () => {
    const account = await withRoutine({}, { steppingDown: true })

    const result = await dataOf<LogResult>(await postLog(account.accessToken, { noticing: ['new-redness'], howBad: 'noticeable' }))

    expect(result.outcome).toEqual({ kind: 'expected-flare' })
    expect(result.response).toEqual({ title: 'Title for expected-flare', body: 'Body for expected-flare.', whatToDoNow: 'What to do for expected-flare.' })
    expect(result.paused).toBeNull()
    expect(await statusesOf(account)).toEqual({ cleanse: 'active', treat: 'active', moisturise: 'active', protect: 'active' })
  })

  it('sends hard-to-ignore redness to a professional when no other step is active, and never pauses a basic step', async () => {
    const account = await withRoutine({}, { steppingDown: true })

    const result = await dataOf<LogResult>(await postLog(account.accessToken, { noticing: ['new-redness'], howBad: 'hard-to-ignore' }))

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'hard-to-ignore-during-step-down' })
    expect(result.paused).toBeNull()
    expect(await statusesOf(account)).toEqual({ cleanse: 'active', treat: 'active', moisturise: 'active', protect: 'active' })
  })

  it('pauses as usual once no step-down is running for the account (the answer is per account)', async () => {
    const account = await withRoutine()

    const result = await dataOf<LogResult>(await postLog(account.accessToken, { noticing: ['new-redness'], howBad: 'noticeable' }))

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
  })
})
