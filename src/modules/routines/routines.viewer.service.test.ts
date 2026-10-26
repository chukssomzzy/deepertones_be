import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { ConflictError } from '../../lib/errors'
import { MemoryScanEvents } from '../../providers/scan-events/memory.scan-events'
import type { ProductCatalogService, ProductSummary, ShelfFacts } from '../catalog/catalog.service'
import type { RoutineStep } from '../catalog/catalog.vocabulary'
import type { RecommendedByCode } from '../catalog/catalog.workbook.repository'
import type { CountryRow, TaperRow } from '../catalog/catalog.workbook.schema'
import type { CatalogWorkbookService } from '../catalog/catalog.workbook.service'
import type { GoalsService } from '../goals/goals.service'
import type { RecommendationService } from '../recommendations/recommendations.service'
import type { ShelfActiveEntry, ShelfService } from '../shelf/shelf.service'
import { NO_LABEL_NAME } from '../verdicts/verdicts.inputs'
import { FakeRoutinesRepository } from './routines.repository.fake'
import type { RoutineVersionRow } from './routines.repository'
import type { RoutineService, RoutineView } from './routines.service'
import { RoutineViewerService } from './routines.viewer.service'

// The session-facing routine (spec #189, PR 4b): what the routes call. Each method is the session's own (no profile id; the actor's profile is the one read) over
// PR 2b's profile-keyed RoutineService, and adds what only a screen needs: the gates, the body a client reads, "what changed since last shown", the live stream.
// The other services are Pick<> fakes answering from one mutable `world`, as routines.service.test.ts does; the repository is the real fake.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the methods, not the constructor):
//   new RoutineViewerService({ routines, goals, workbook, catalog, shelf, recommendations, repository, events, enabled, now })
//     routines         Pick<RoutineService, 'current' | 'start' | 'gotIt' | 'request' | 'requestIfStale'>   (requestIfStale(profileId) is PR 3c's; it never throws)
//     goals            Pick<GoalsService, 'requireGoal'>
//     workbook         Pick<CatalogWorkbookService, 'verdictReference' | 'recommendedByCode' | 'tapersByCode' | 'countries'>
//     catalog          Pick<ProductCatalogService, 'shelfFacts' | 'productSummaries'>
//     shelf            Pick<ShelfService, 'activeEntriesFor'>
//     recommendations  Pick<RecommendationService, 'shoppingFor'>
//     repository       Pick<RoutinesRepository, 'lastServedBefore' | 'markServed'>
//     events           ScanEvents (the Durable Object in life, MemoryScanEvents here)
//   current(): Promise<RoutineResponse>            { status: 'pending' } | the ready or updating body (routines.view.ts)
//   watch(): Promise<Response>                     the text/event-stream of `routine:<profileId>`: a snapshot of what current() answers, then `done` once ready
//   start(): Promise<RoutineResponse>              routines.start(profileId), then the body; 409 ROUTINE_NOT_READY is RoutineService's
//   gotIt(step, clientIp): Promise<RoutineResponse>    routines.gotIt(profileId, step, clientIp), then the body
//   findSoldHere(step): Promise<RoutineResponse>   routines.request(profileId, 'sold-here', `sold-here:${versionId}:${step}`, { exclude: { step, code } }), then the body
//                                                   with status 'updating'
//   announce(profileId): Promise<void>             by profile id, for the build (no session): publishes the body as `{ type: 'routine', routine }` on `routine:<profileId>`
//                                                   and, when it is ready, `{ type: 'done' }`. It never marks a version served.
// The gates, in order, for all five session methods: 401, 403 SIGNUP_REQUIRED (a guest), 409 GOAL_REQUIRED, 503 VERDICT_UNAVAILABLE (either step-down template of
// the verdict not approved). Note the order: the verdict itself answers 503 before 409; the routine answers 409 before 503.

// The one clock every test hangs off; later times are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)
const START_DAY = new Date(Date.UTC(T0.getUTCFullYear(), T0.getUTCMonth(), T0.getUTCDate()))

const PROFILE = 'profile-amara-1'
const USER = 'user-amara'
const VERIFIED: Actor = { kind: 'user', userId: USER, status: 'verified', profileId: PROFILE }
const GUEST: Actor = { kind: 'user', userId: USER, status: 'anonymous', profileId: PROFILE }
const SYSTEM: Actor = { kind: 'system', job: 'build-routine' }
const IP = '203.0.113.7'

type Step = RoutineVersionRow['steps'][number]
const stepOf = (step: RoutineStep, product: Step['product'], frequency: Step['frequency']): Step => ({ step, product, frequency, reason: `Reason for ${step}.`, grounding: ['https://internal.example/g'], gotIt: false, fixedFrom: null })

// Cleanse is on the shelf, treat is SERUM-1 (sold in NG, where Amara shops), moisturise is MOIST-GH (sold in GH only), protect has nothing to recommend.
const defaultSteps = (): Step[] => [
  stepOf('cleanse', { kind: 'shelf', id: 'entry-a' }, 'am'),
  stepOf('treat', { kind: 'candidate', code: 'SERUM-1' }, 'pm'),
  stepOf('moisturise', { kind: 'candidate', code: 'MOIST-GH' }, 'am-pm'),
  stepOf('protect', { kind: 'none' }, 'am'),
]

let ids = 0
const versionRow = (over: Partial<RoutineVersionRow> = {}): RoutineVersionRow => ({
  id: `version-${++ids}`,
  profileId: PROFILE,
  status: 'ready',
  createdAt: at(-HOUR),
  steps: defaultSteps(),
  tapers: [{ shelfProductId: 'entry-b', templateId: 'TPR-STEROID-1', startedOn: null }],
  expectation: 'Give it 8 to 12 weeks before judging.',
  cautions: [],
  goal: 'fade-dark-marks',
  readyAt: at(-HOUR),
  startedOn: null,
  servedAt: null,
  model: 'claude-internal',
  promptHash: 'internal-hash',
  catalogVersion: 7,
  rulesVersion: '1',
  hintsShown: false,
  verdictFingerprint: 'verdict-fp',
  routineFingerprint: 'routine-fp',
  source: 'writer',
  reason: 'first',
  writerRetryDueAt: null,
  writerCalls: 1,
  ...over,
})

const recommended = (code: string, formulationId: string, countries: string[], over: Partial<RecommendedByCode> = {}): RecommendedByCode => ({
  code,
  status: 'approved',
  productId: `product-${code}`,
  formulationId,
  origin: 'sourced',
  keyIngredient: null,
  strength: null,
  availability: countries.map((country) => ({ country, priceMin: 3000, priceMax: 4500, whereSold: 'Pharmacies' })),
  ...over,
})
const summary = (formulationId: string, brand: string, name: string): ProductSummary => ({ id: `product-of-${formulationId}`, kind: 'named', brand, name, variant: null, form: 'serum', category: 'skin', imageUrl: null })

const TEMPLATE: TaperRow = {
  code: 'TPR-STEROID-1',
  kind: 'steroid',
  schedule: [
    { fromWeek: 1, toWeek: 2, frequency: 'alternate-days' },
    { fromWeek: 3, toWeek: 4, frequency: 'weekly' },
    { fromWeek: 5, toWeek: 5, frequency: 'stop' },
  ],
  whatToExpect: 'Skin may flare for a few days.',
  seeAProfessionalIf: 'The redness spreads.',
  status: 'approved',
  approvedBy: 'Dr A. Reviewer',
  approvedOn: at(-30 * DAY),
  auditedBy: null,
  auditedOn: null,
}

type World = {
  goal: string | null
  /** The step-down templates the verdict needs: both approved, or one missing. */
  tapers: { steroid?: string; 'lightening-agent'?: string }
  shopping: { country: string; budgetBand: null; updatedAt: Date }
  entries: ShelfActiveEntry[]
  facts: Map<string, ShelfFacts>
  recommended: Map<string, RecommendedByCode>
  summaries: Map<string, ProductSummary>
  countries: CountryRow[]
  /** What RoutineService.current answers. */
  routine: RoutineView
}

const newWorld = (): World => ({
  goal: 'fade-dark-marks',
  tapers: { steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' },
  shopping: { country: 'NG', budgetBand: null, updatedAt: T0 },
  entries: [
    { id: 'entry-a', kind: 'product', addedAt: T0, productId: 'prod-a', formulationId: 'form-a' },
    { id: 'entry-b', kind: 'product', addedAt: T0, productId: 'prod-b', formulationId: 'form-b' },
  ],
  facts: new Map([
    ['form-a', { productId: 'prod-a', brand: 'Orbis', name: 'Calm Cleanser', variant: null, form: 'cream', category: 'skin', ingredients: ['Aqua'] }],
    ['form-b', { productId: 'prod-b', brand: 'Karo', name: 'Karo Glow Cream', variant: null, form: 'cream', category: 'skin', ingredients: ['Aqua', 'Clobetasol Propionate'] }],
  ]),
  recommended: new Map([
    ['SERUM-1', recommended('SERUM-1', 'form-serum-1', ['NG'])],
    ['SERUM-2', recommended('SERUM-2', 'form-serum-2', ['NG'])],
    ['MOIST-GH', recommended('MOIST-GH', 'form-moist-gh', ['GH'])],
  ]),
  summaries: new Map([
    ['form-serum-1', summary('form-serum-1', 'Lumina', 'Bright Serum')],
    ['form-serum-2', summary('form-serum-2', 'Lumina', 'Bright Serum Two')],
    ['form-moist-gh', summary('form-moist-gh', 'Accra Skin', 'Shea Moisturiser')],
  ]),
  countries: [
    { code: 'NG', currency: 'NGN', lowMax: 5000, midMax: 15000, status: 'active' },
    { code: 'GH', currency: 'GHS', lowMax: 100, midMax: 300, status: 'active' },
  ],
  routine: { status: 'pending' },
})

let world: World
let clock: Date
let repository: FakeRoutinesRepository
let events: MemoryScanEvents
let viewer: RoutineViewerService
let routinesEnabled: boolean
let routines: { [K in 'current' | 'start' | 'gotIt' | 'request' | 'requestIfStale']: ReturnType<typeof vi.fn> }
let requireGoal: ReturnType<typeof vi.fn>

const setClock = (offsetMs: number) => {
  clock = at(offsetMs)
}

/** The routine in force is this version (stored in the repository too, as it is in life), shown as ready or updating. */
const showing = async (row: RoutineVersionRow, status: 'ready' | 'updating' = 'ready') => {
  await repository.append(row)
  world.routine = { status, version: row }
  return row
}

const makeViewer = () =>
  new RoutineViewerService({
    routines: routines as unknown as Pick<RoutineService, 'current' | 'start' | 'gotIt' | 'request' | 'requestIfStale'>,
    goals: { requireGoal } as unknown as Pick<GoalsService, 'requireGoal'>,
    workbook: {
      verdictReference: async () => ({ rulesVersion: 'r', catalogVersion: 42, rules: [], claimPhrases: [], tapers: { ...world.tapers } }),
      recommendedByCode: async (codes: string[]) => new Map(codes.flatMap((code): [string, RecommendedByCode][] => (world.recommended.has(code) ? [[code, structuredClone(world.recommended.get(code)!)]] : []))),
      tapersByCode: async (codes: string[]) => new Map(codes.flatMap((code): [string, TaperRow][] => (code === TEMPLATE.code ? [[code, structuredClone(TEMPLATE)]] : []))),
      countries: async () => structuredClone(world.countries),
    } as unknown as Pick<CatalogWorkbookService, 'verdictReference' | 'recommendedByCode' | 'tapersByCode' | 'countries'>,
    catalog: {
      shelfFacts: async (ids: string[]) => new Map(ids.flatMap((id): [string, ShelfFacts][] => (world.facts.has(id) ? [[id, structuredClone(world.facts.get(id)!)]] : []))),
      productSummaries: async (ids: string[]) => new Map(ids.flatMap((id): [string, ProductSummary][] => (world.summaries.has(id) ? [[id, structuredClone(world.summaries.get(id)!)]] : []))),
    } as unknown as Pick<ProductCatalogService, 'shelfFacts' | 'productSummaries'>,
    shelf: { activeEntriesFor: async () => structuredClone(world.entries) } as unknown as Pick<ShelfService, 'activeEntriesFor'>,
    recommendations: { shoppingFor: async () => ({ ...world.shopping }) } as unknown as Pick<RecommendationService, 'shoppingFor'>,
    repository,
    events,
    enabled: routinesEnabled,
    now: () => clock,
  })

beforeEach(() => {
  clock = T0
  ids = 0
  world = newWorld()
  routinesEnabled = true
  repository = new FakeRoutinesRepository()
  events = new MemoryScanEvents()
  routines = {
    // As RoutineService.current does: the version is read from the repository, so what Start and the viewer wrote (served, started) shows on the next read.
    current: vi.fn(async () => {
      const shown = structuredClone(world.routine)
      if (shown.status === 'pending') return shown
      const stored = await repository.current(PROFILE)
      if (stored?.id !== shown.version.id) return shown
      return { ...shown, version: { ...shown.version, servedAt: stored.servedAt, startedOn: stored.startedOn, tapers: stored.tapers } }
    }),
    start: vi.fn(async () => {
      if (world.routine.status === 'pending') throw new ConflictError('ROUTINE_NOT_READY', 'Your routine is not ready yet')
      await repository.markStarted(PROFILE, START_DAY)
    }),
    gotIt: vi.fn(async () => {}),
    // Whether a build was queued: true unless a test says the claim was held.
    request: vi.fn(async () => true),
    requestIfStale: vi.fn(async () => {}),
  }
  requireGoal = vi.fn(async () => {
    if (world.goal === null) throw new ConflictError('GOAL_REQUIRED', 'Pick a goal first')
    return { goal: world.goal }
  })
  viewer = makeViewer()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const asVerified = <T>(fn: () => Promise<T>) => runAs(VERIFIED, fn)
const asGuest = <T>(fn: () => Promise<T>) => runAs(GUEST, fn)
const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}
const body = async (promise: Promise<unknown>) => JSON.parse(JSON.stringify(await promise)) as any

const SESSION_METHODS: [string, () => Promise<unknown>][] = [
  ['current', () => viewer.current()],
  ['watch', () => viewer.watch()],
  ['start', () => viewer.start()],
  ['gotIt', () => viewer.gotIt('treat', IP)],
  ['findSoldHere', () => viewer.findSoldHere('moisturise')],
]
const touched = () => [...Object.values(routines)].some((fn) => fn.mock.calls.length > 0)

describe.each(SESSION_METHODS)('RoutineViewerService.%s: who may ask, and when', (_name, call) => {
  it('refuses a guest with 403 SIGNUP_REQUIRED before reading anything', async () => {
    const error = await errorOf(asGuest(call))

    expect(error).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(requireGoal).not.toHaveBeenCalled()
    expect(touched()).toBe(false)
    expect(events.subscribed).toEqual([])
  })

  it('refuses a guest with 403, not 409 or 503, even when there is no goal and the verdict is unavailable', async () => {
    world.goal = null
    world.tapers = {}

    expect(await errorOf(asGuest(call))).toMatchObject({ code: 'SIGNUP_REQUIRED' })
  })

  it('refuses a signed-up account with no goal with 409 GOAL_REQUIRED, even when the verdict is also unavailable', async () => {
    world.goal = null
    world.tapers = {}

    const error = await errorOf(asVerified(call))

    expect(error).toMatchObject({ name: 'ConflictError', code: 'GOAL_REQUIRED' })
    expect(touched()).toBe(false)
    expect(events.subscribed).toEqual([])
  })

  it.each([
    ['neither step-down template is approved', {}],
    ['only the steroid template is approved', { steroid: 'TPR-STEROID-1' }],
    ['only the lightening-agent template is approved', { 'lightening-agent': 'TPR-LIGHTENING-1' }],
  ])('refuses with 503 VERDICT_UNAVAILABLE when %s, since the routine would stay pending for ever, and reads nothing of the routine', async (_why, tapers) => {
    world.tapers = tapers

    const error = await errorOf(asVerified(call))

    expect(error).toMatchObject({ name: 'UnavailableError', code: 'VERDICT_UNAVAILABLE' })
    expect(touched()).toBe(false)
    expect(events.subscribed).toEqual([])
  })
})

describe('RoutineViewerService.current', () => {
  it('answers pending when there is no routine yet, and asks for a build when none is fresh', async () => {
    expect(await body(asVerified(() => viewer.current()))).toEqual({ status: 'pending' })

    expect(routines.requestIfStale).toHaveBeenCalledTimes(1)
    expect(routines.requestIfStale).toHaveBeenCalledWith(PROFILE)
  })

  it('answers pending, and marks nothing served, when the routine in force is hidden (the safety answers moved on) or none exists', async () => {
    const row = versionRow()
    await repository.append(row)
    world.routine = { status: 'pending' }

    expect(await body(asVerified(() => viewer.current()))).toEqual({ status: 'pending' })

    expect((await repository.current(PROFILE))!.servedAt).toBeNull()
  })

  it('answers a ready routine as the body: its steps in order with each product as the shelf and the catalog know it, and the step-down the verdict stopped', async () => {
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.current()))

    expect(routine).toMatchObject({ status: 'ready', startedOn: null, expectation: 'Give it 8 to 12 weeks before judging.' })
    expect(routine.steps.map((s: any) => [s.step, s.frequency, s.changed])).toEqual([
      ['cleanse', 'am', false],
      ['treat', 'pm', false],
      ['moisturise', 'am-pm', false],
      ['protect', 'am', false],
    ])
    expect(routine.steps[0].product).toEqual({ kind: 'own', entryId: 'entry-a', brand: 'Orbis', name: 'Calm Cleanser' })
    expect(routine.steps[1].product).toMatchObject({ kind: 'recommended', code: 'SERUM-1', brand: 'Lumina', name: 'Bright Serum', soldInCurrentCountry: true, soldElsewhere: [], price: { min: 3000, max: 4500, currency: 'NGN' } })
    expect(routine.steps[2].product).toMatchObject({ kind: 'recommended', code: 'MOIST-GH', brand: 'Accra Skin', soldInCurrentCountry: false, soldElsewhere: ['GH'], price: null })
    expect(routine.steps[3].product).toEqual({ kind: 'none' })
    expect(routine.tapers).toHaveLength(1)
    expect(routine.tapers[0]).toMatchObject({ entryId: 'entry-b', brand: 'Karo', name: 'Karo Glow Cream', code: 'TPR-STEROID-1', kind: 'steroid' })
  })

  it('prices a recommended product in the shopping country\'s currency', async () => {
    world.shopping = { country: 'GH', budgetBand: null, updatedAt: T0 }
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.current()))

    expect(routine.steps[2].product).toMatchObject({ code: 'MOIST-GH', soldInCurrentCountry: true, price: { min: 3000, max: 4500, currency: 'GHS' } })
    expect(routine.steps[1].product).toMatchObject({ code: 'SERUM-1', soldInCurrentCountry: false, soldElsewhere: ['NG'] })
  })

  it('shows a shelf product with no label under the no-label name and no brand', async () => {
    world.entries = [{ id: 'entry-a', kind: 'no-label', addedAt: T0, itemId: 'item-1' }]
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.current()))

    expect(routine.steps[0].product).toEqual({ kind: 'own', entryId: 'entry-a', brand: null, name: NO_LABEL_NAME })
  })

  it('answers an updating routine with the routine in force and the status updating', async () => {
    await showing(versionRow(), 'updating')

    const routine = await body(asVerified(() => viewer.current()))

    expect(routine.status).toBe('updating')
    expect(routine.steps).toHaveLength(4)
  })

  it('keeps a retired recommended product on the screen rather than hiding it', async () => {
    world.recommended.set('SERUM-1', recommended('SERUM-1', 'form-serum-1', [], { status: 'retired' }))
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.current()))

    expect(routine.steps[1].product).toMatchObject({ kind: 'recommended', code: 'SERUM-1', brand: 'Lumina', soldInCurrentCountry: false, soldElsewhere: [], price: null })
  })

  it('asks for a build when none is fresh whatever it answers, and does not wait for it', async () => {
    await showing(versionRow())

    await asVerified(() => viewer.current())

    expect(routines.requestIfStale).toHaveBeenCalledWith(PROFILE)
  })

  it('does not show how the writer reached the routine: no grounding, no fixedFrom, no model or prompt, no source links', async () => {
    await showing(versionRow({ steps: defaultSteps().map((s) => ({ ...s, fixedFrom: 'version-0' })) }))

    const text = JSON.stringify(await body(asVerified(() => viewer.current())))

    for (const internal of ['grounding', 'fixedFrom', 'sourceUrls', 'promptHash', 'internal.example', 'claude-internal', 'internal-hash', 'verdict-fp', 'routine-fp']) expect(text, internal).not.toContain(internal)
  })
})

describe('RoutineViewerService.current: marking the routine served', () => {
  it('marks the routine in force served at the time it was read', async () => {
    const row = await showing(versionRow())
    setClock(5 * MINUTE)

    await asVerified(() => viewer.current())

    expect((await repository.current(PROFILE))!.servedAt).toEqual(at(5 * MINUTE))
    expect(row.servedAt).toBeNull()
  })

  it('marks it only the first time: a second read leaves the time it was first served', async () => {
    await showing(versionRow())
    setClock(5 * MINUTE)
    await asVerified(() => viewer.current())
    const markServed = vi.spyOn(repository, 'markServed')
    setClock(DAY)

    await asVerified(() => viewer.current())

    expect(markServed).not.toHaveBeenCalled()
    expect((await repository.current(PROFILE))!.servedAt).toEqual(at(5 * MINUTE))
  })

  it('marks an updating routine served too: it is what the person is looking at', async () => {
    await showing(versionRow(), 'updating')

    await asVerified(() => viewer.current())

    expect((await repository.current(PROFILE))!.servedAt).toEqual(T0)
  })

  it('still answers the routine when the mark fails, and logs the failure with ids and no words', async () => {
    await showing(versionRow())
    vi.spyOn(repository, 'markServed').mockRejectedValue(new Error('D1 is down'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const routine = await body(asVerified(() => viewer.current()))

    expect(routine.status).toBe('ready')
    expect(routine.steps).toHaveLength(4)
    expect(error).toHaveBeenCalled()
    const logged = JSON.stringify(error.mock.calls)
    expect(logged).toContain(PROFILE)
    for (const word of ['Calm Cleanser', 'Karo', 'Bright Serum', 'Reason for']) expect(logged, word).not.toContain(word)
  })
})

describe('RoutineViewerService.current: what changed since the routine was last shown', () => {
  const served = (over: Partial<RoutineVersionRow> = {}) => versionRow({ createdAt: at(-3 * DAY), readyAt: at(-3 * DAY), servedAt: at(-2 * DAY), ...over })
  const withTreat = (code: string, frequency: Step['frequency'] = 'pm') => defaultSteps().map((s) => (s.step === 'treat' ? stepOf('treat', { kind: 'candidate', code }, frequency) : s))
  const changedOf = (routine: any) => routine.steps.map((s: any) => s.changed)

  it('marks nothing changed the first time the routine is shown: there is nothing to compare it with', async () => {
    await showing(versionRow())

    expect(changedOf(await body(asVerified(() => viewer.current())))).toEqual([false, false, false, false])
  })

  it('marks a step changed when its product differs from the routine shown before, and only that step', async () => {
    await repository.append(served({ steps: withTreat('SERUM-2') }))
    await showing(versionRow({ steps: withTreat('SERUM-1') }))

    expect(changedOf(await body(asVerified(() => viewer.current())))).toEqual([false, true, false, false])
  })

  it('marks a step changed when only its frequency differs from the routine shown before', async () => {
    await repository.append(served({ steps: withTreat('SERUM-1', 'am') }))
    await showing(versionRow({ steps: withTreat('SERUM-1', 'pm') }))

    expect(changedOf(await body(asVerified(() => viewer.current())))).toEqual([false, true, false, false])
  })

  it('does not mark a step changed when the recommended product the routine shown before had is now the user\'s own entry of the same formulation (they got it)', async () => {
    world.entries.push({ id: 'entry-s', kind: 'product', addedAt: T0, productId: 'prod-s', formulationId: 'form-serum-1' })
    world.facts.set('form-serum-1', { productId: 'prod-s', brand: 'Lumina', name: 'Bright Serum', variant: null, form: 'serum', category: 'skin', ingredients: ['Aqua'] })
    await repository.append(served({ steps: withTreat('SERUM-1') }))
    const swapped = defaultSteps().map((s) => (s.step === 'treat' ? stepOf('treat', { kind: 'shelf', id: 'entry-s' }, 'pm') : s))
    await showing(versionRow({ steps: swapped }))

    const routine = await body(asVerified(() => viewer.current()))

    expect(routine.steps[1].product).toMatchObject({ kind: 'own', entryId: 'entry-s' })
    expect(changedOf(routine)).toEqual([false, false, false, false])
  })

  it('compares with the newest version that was shown, not with one that was built and never shown', async () => {
    await repository.append(served({ id: 'shown', steps: withTreat('SERUM-1') }))
    await repository.append(versionRow({ id: 'never-shown', createdAt: at(-DAY), readyAt: at(-DAY), steps: withTreat('SERUM-2') }))
    await showing(versionRow({ steps: withTreat('SERUM-1') }))

    expect(changedOf(await body(asVerified(() => viewer.current())))).toEqual([false, false, false, false])
  })

  it('shows the same marks on a second read of the same routine: serving it does not make it the thing it is compared with', async () => {
    await repository.append(served({ steps: withTreat('SERUM-2') }))
    await showing(versionRow({ steps: withTreat('SERUM-1') }))
    const first = await body(asVerified(() => viewer.current()))
    setClock(HOUR)

    const second = await body(asVerified(() => viewer.current()))

    expect(changedOf(first)).toEqual([false, true, false, false])
    expect(changedOf(second)).toEqual(changedOf(first))
  })
})

describe('RoutineViewerService.watch', () => {
  it('opens the stream of the profile\'s routine with the body current() answers as its snapshot', async () => {
    await showing(versionRow())

    await asVerified(() => viewer.watch())

    expect(events.subscribed).toHaveLength(1)
    expect(events.subscribed[0]!.scanId).toBe(`routine:${PROFILE}`)
    const snapshot = JSON.parse(JSON.stringify(events.subscribed[0]!.snapshot))
    expect(snapshot).toMatchObject({ status: 'ready', startedOn: null })
    expect(snapshot.steps).toHaveLength(4)
    expect(snapshot).toEqual(await body(asVerified(() => viewer.current())))
  })

  it('answers the stream the events provider opened', async () => {
    const response = await asVerified(() => viewer.watch())

    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  })

  it('asks for a build when none is fresh, as a read does', async () => {
    await asVerified(() => viewer.watch())

    expect(routines.requestIfStale).toHaveBeenCalledWith(PROFILE)
  })

  it('marks the routine in its snapshot served', async () => {
    await showing(versionRow())
    setClock(MINUTE)

    await asVerified(() => viewer.watch())

    expect((await repository.current(PROFILE))!.servedAt).toEqual(at(MINUTE))
  })

  it('follows a routine that is already ready with done at once: nothing more is coming', async () => {
    await showing(versionRow())

    await asVerified(() => viewer.watch())

    expect(events.eventsFor(`routine:${PROFILE}`)).toEqual([{ type: 'done' }])
  })

  it.each([
    ['pending', async () => undefined],
    ['updating', async () => void (await showing(versionRow(), 'updating'))],
  ])('leaves the stream open when the routine is %s: the build\'s frame is still to come', async (_status, arrange) => {
    await arrange()

    await asVerified(() => viewer.watch())

    expect(events.eventsFor(`routine:${PROFILE}`)).toEqual([])
    expect(events.subscribed).toHaveLength(1)
  })
})

describe('RoutineViewerService.start', () => {
  it('starts the routine of the caller\'s profile and answers the body, started today with its step-downs dated', async () => {
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.start()))

    expect(routines.start).toHaveBeenCalledWith(PROFILE)
    expect(routine.status).toBe('ready')
    expect(routine.startedOn).toBe('2030-06-15')
    expect(routine.tapers[0].steps[0]).toMatchObject({ fromDate: '2030-06-15', toDate: '2030-06-28' })
  })

  it('answers 409 ROUTINE_NOT_READY before there is a routine', async () => {
    expect(await errorOf(asVerified(() => viewer.start()))).toMatchObject({ code: 'ROUTINE_NOT_READY' })
  })
})

describe('RoutineViewerService.gotIt', () => {
  it('records "I got it" for the profile\'s step with the client address, and answers the body', async () => {
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.gotIt('treat', IP)))

    expect(routines.gotIt).toHaveBeenCalledWith(PROFILE, 'treat', IP)
    expect(routine.status).toBe('ready')
    expect(routine.steps).toHaveLength(4)
  })

  it('shows the product as got once the routine in force says it is', async () => {
    await showing(versionRow())
    routines.gotIt.mockImplementation(async () => {
      const { version } = world.routine as Extract<RoutineView, { version: RoutineVersionRow }>
      world.routine = { status: 'ready', version: { ...version, steps: version.steps.map((s) => (s.step === 'treat' ? { ...s, gotIt: true } : s)) } }
    })

    const routine = await body(asVerified(() => viewer.gotIt('treat', IP)))

    expect(routine.steps[1].product).toMatchObject({ code: 'SERUM-1', notYetGot: false })
  })

  it('passes on what the routine refuses: 409 STEP_NOT_RECOMMENDED', async () => {
    await showing(versionRow())
    routines.gotIt.mockRejectedValue(new ConflictError('STEP_NOT_RECOMMENDED', 'This step has no recommended product'))

    expect(await errorOf(asVerified(() => viewer.gotIt('cleanse', IP)))).toMatchObject({ code: 'STEP_NOT_RECOMMENDED' })
  })
})

describe('RoutineViewerService.findSoldHere', () => {
  it('asks for the step to be built again without that product, and answers the routine in force as updating', async () => {
    const row = await showing(versionRow())

    const routine = await body(asVerified(() => viewer.findSoldHere('moisturise')))

    expect(routines.request).toHaveBeenCalledTimes(1)
    expect(routines.request).toHaveBeenCalledWith(PROFILE, 'sold-here', `sold-here:${row.id}:moisturise`, { exclude: { step: 'moisturise', code: 'MOIST-GH' } })
    expect(routine.status).toBe('updating')
    expect(routine.steps).toHaveLength(4)
    expect(routine.steps[2].product).toMatchObject({ code: 'MOIST-GH' })
  })

  it('refuses with 409 BUILD_IN_PROGRESS when nothing was queued (another build holds the claim), so the exclusion is not silently lost', async () => {
    await showing(versionRow())
    routines.request.mockResolvedValue(false)

    const error = await errorOf(asVerified(() => viewer.findSoldHere('moisturise')))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({ code: 'BUILD_IN_PROGRESS' })
    expect(error.message).toMatch(/try again/i)
  })

  it('still answers updating when routines are switched off and nothing was queued: there is no build to wait for', async () => {
    routinesEnabled = false
    viewer = makeViewer()
    await showing(versionRow())
    routines.request.mockResolvedValue(false)

    expect((await body(asVerified(() => viewer.findSoldHere('moisturise')))).status).toBe('updating')
  })

  it('treats a product sold nowhere (retired) as one that is not sold here', async () => {
    world.recommended.set('MOIST-GH', recommended('MOIST-GH', 'form-moist-gh', [], { status: 'retired' }))
    const row = await showing(versionRow())

    await asVerified(() => viewer.findSoldHere('moisturise'))

    expect(routines.request).toHaveBeenCalledWith(PROFILE, 'sold-here', `sold-here:${row.id}:moisturise`, { exclude: { step: 'moisturise', code: 'MOIST-GH' } })
  })

  it('asks again for the same step of a later routine under a key of its own', async () => {
    const first = await showing(versionRow())
    await asVerified(() => viewer.findSoldHere('moisturise'))
    const second = await showing(versionRow({ createdAt: at(HOUR), readyAt: at(HOUR) }))

    await asVerified(() => viewer.findSoldHere('moisturise'))

    const keys = routines.request.mock.calls.map((call) => call[2])
    expect(keys).toEqual([`sold-here:${first.id}:moisturise`, `sold-here:${second.id}:moisturise`])
    expect(new Set(keys).size).toBe(2)
  })

  it('refuses with 409 STEP_NOT_RECOMMENDED a product that is sold here already, and asks for nothing', async () => {
    await showing(versionRow())

    expect(await errorOf(asVerified(() => viewer.findSoldHere('treat')))).toMatchObject({ name: 'ConflictError', code: 'STEP_NOT_RECOMMENDED' })
    expect(routines.request).not.toHaveBeenCalled()
  })

  it.each([
    ['one of her own', 'cleanse'],
    ['nothing to recommend', 'protect'],
  ] as const)('refuses with 409 STEP_NOT_RECOMMENDED a step whose product is %s, and asks for nothing', async (_why, step) => {
    await showing(versionRow())

    expect(await errorOf(asVerified(() => viewer.findSoldHere(step)))).toMatchObject({ name: 'ConflictError', code: 'STEP_NOT_RECOMMENDED' })
    expect(routines.request).not.toHaveBeenCalled()
  })

  it('refuses with 409 ROUTINE_NOT_READY before there is a routine, and asks for nothing', async () => {
    expect(await errorOf(asVerified(() => viewer.findSoldHere('moisturise')))).toMatchObject({ name: 'ConflictError', code: 'ROUTINE_NOT_READY' })
    expect(routines.request).not.toHaveBeenCalled()
  })
})

describe('RoutineViewerService.announce', () => {
  const key = `routine:${PROFILE}`
  const announce = () => runAs(SYSTEM, () => viewer.announce(PROFILE))

  it('publishes a ready routine as the body GET answers, on the profile\'s stream, followed by done', async () => {
    await showing(versionRow())

    await announce()

    const published = events.eventsFor(key)
    expect(published).toHaveLength(2)
    expect(published[0]).toMatchObject({ type: 'routine', routine: { status: 'ready' } })
    expect(JSON.parse(JSON.stringify((published[0] as any).routine))).toEqual(await body(asVerified(() => viewer.current())))
    expect(published[1]).toEqual({ type: 'done' })
  })

  it('publishes an updating routine without done: the build under way is still to land', async () => {
    await showing(versionRow(), 'updating')

    await announce()

    expect(events.eventsFor(key)).toEqual([expect.objectContaining({ type: 'routine', routine: expect.objectContaining({ status: 'updating' }) })])
  })

  it('publishes pending, without done', async () => {
    await announce()

    expect(events.eventsFor(key)).toEqual([{ type: 'routine', routine: { status: 'pending' } }])
  })

  it('never marks a version served: only a person looking at it does', async () => {
    await showing(versionRow())

    await announce()

    expect((await repository.current(PROFILE))!.servedAt).toBeNull()
  })

  it('publishes to the profile\'s stream only', async () => {
    await showing(versionRow())

    await announce()

    expect(events.published.every((p) => p.scanId === key)).toBe(true)
  })
})
