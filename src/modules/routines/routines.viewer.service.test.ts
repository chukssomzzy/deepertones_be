import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { ConflictError } from '../../lib/errors'
import { MemoryScanEvents } from '../../providers/scan-events/memory.scan-events'
import type { ProductCatalogService, ProductSummary, ShelfFacts } from '../catalog/catalog.service'
import type { RoutineStep } from '../catalog/catalog.vocabulary'
import type { RecommendedByCode } from '../catalog/catalog.workbook.repository'
import type { CountryRow, TaperRow } from '../catalog/catalog.workbook.schema'
import type { CatalogWorkbookService, Guide } from '../catalog/catalog.workbook.service'
import { SHOWN_CONCERNS, concernsForGoal, type ShownConcern } from '../face-scans/face-scans.tables'
import type { GoalsService } from '../goals/goals.service'
import { GOALS, type Goal } from '../goals/goals.vocabulary'
import type { RecommendationService } from '../recommendations/recommendations.service'
import type { Candidate } from '../recommendations/recommendations.types'
import type { SafetyService } from '../safety/safety.service'
import type { ShelfActiveEntry, ShelfService } from '../shelf/shelf.service'
import { NO_LABEL_NAME } from '../verdicts/verdicts.inputs'
import { FakeRoutinesRepository } from './routines.repository.fake'
import { FORBIDDEN_WORDING } from './routines.wording'
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
//     recommendations  Pick<RecommendationService, 'shoppingFor' | 'candidatesFor'>
//     safety           Pick<SafetyService, 'currentOrNull'>                (#217 PR 2: whether the person is pregnant or breastfeeding)
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
// PR 5 adds `summary` to the body (see routines.view.test.ts for what it holds): every way the body leaves the service (a read, the stream's snapshot and the frames
// the build publishes) carries the one summary, worked out from the version's stored counts.
// PR 6 replaces `steps` in that body (a read, the stream's snapshot and the frames the build publishes alike) with `morning` and `evening` lists of entries
// { step, title, product, when, reason, changed }, and adds `notInRoutine` (the version's stored list, or null for a version built before the column); the placement
// and the words are pinned in routines.view.test.ts. What this file adds is the reads that feed them: the form of a shelf product (catalog.shelfFacts) and of a
// recommended one (catalog.productSummaries) for the title, and the recommended row's key ingredient.
// #217 PR 2 adds a sixth session method, lookFor(step): Promise<LookForResponse> (screens 4.7 and 4.8; its contract is pinned at the foot of this file), and three
// reads the world fake below answers: workbook.guideFor(step, goal), recommendations.candidatesFor({ step }) (the session's own: it reads the actor, so the viewer
// passes no profile id) and safety.currentOrNull() (a new `safety` dep, for the pregnancy and breastfeeding answer).
// The gates, in order, for all six session methods: 401, 403 SIGNUP_REQUIRED (a guest), 409 GOAL_REQUIRED, 503 VERDICT_UNAVAILABLE (either step-down template of
// the verdict not approved). Note the order: the verdict itself answers 503 before 409; the routine answers 409 before 503.

// The one clock every test hangs off; later times are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)
// Start makes tomorrow day 1: the UTC midnight after T0's day. (RoutineService.start decides this; the stand-in below only stores it, so the viewer is shown a started routine.)
const START_DAY = new Date(Date.UTC(T0.getUTCFullYear(), T0.getUTCMonth(), T0.getUTCDate() + 1))

const PROFILE = 'profile-amara-1'
const USER = 'user-amara'
const VERIFIED: Actor = { kind: 'user', userId: USER, status: 'verified', profileId: PROFILE }
const GUEST: Actor = { kind: 'user', userId: USER, status: 'anonymous', profileId: PROFILE }
const SYSTEM: Actor = { kind: 'system', job: 'build-routine' }
const IP = '203.0.113.7'

type Step = RoutineVersionRow['steps'][number]
const ROUTINE_ORDER = ['cleanse', 'treat', 'moisturise', 'protect']
/** The entries of a body once each, in routine order: a step in both lists is one entry. */
const entriesOf = (routine: any): any[] => {
  const byStep = new Map<string, any>()
  for (const entry of [...routine.morning, ...routine.evening]) if (!byStep.has(entry.step)) byStep.set(entry.step, entry)
  return ROUTINE_ORDER.flatMap((step) => (byStep.has(step) ? [byStep.get(step)] : []))
}

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
  // As the build counted Amara's shelf: two kept, nothing reduced, one dropped, and the steroid cream (the one step-down below) stopped.
  shelfCounts: { keep: 2, reduce: 0, drop: 1, stop: 1 },
  // What the build left out, frozen with the counts: the steroid cream, which the one step-down above stops.
  notInRoutine: [{ entryId: 'entry-b', title: 'Cream', status: 'stepping-down', reason: 'It has a steroid in it, so we stop it slowly.' }],
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
  /** The Guides tab as `guideFor` resolves it: keyed `${step}|${goal}`, or `${step}|` for a step's base row. */
  guides: Map<string, Guide>
  /** What `candidatesFor` answers per step: the safe candidates for this person, as the recommendation service already filtered them. */
  candidates: Partial<Record<RoutineStep, Candidate[]>>
  /** The ticked boxes of the person's current safety answer. */
  safetyChoices: string[]
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
  guides: new Map(ROUTINE_ORDER.map((step): [string, Guide] => [`${step}|`, { whatItDoes: `What ${step} does.`, lookFor: `What to look for in ${step}.`, forDeeperSkin: `Deeper skin and ${step}.`, lookForWhenPregnant: null }])),
  candidates: {},
  safetyChoices: ['none'],
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
      guideFor: async (step: RoutineStep, goal: Goal) => structuredClone(world.guides.get(`${step}|${goal}`) ?? world.guides.get(`${step}|`) ?? null),
      verdictReference: async () => ({ rulesVersion: 'r', catalogVersion: 42, rules: [], claimPhrases: [], tapers: { ...world.tapers } }),
      recommendedByCode: async (codes: string[]) => new Map(codes.flatMap((code): [string, RecommendedByCode][] => (world.recommended.has(code) ? [[code, structuredClone(world.recommended.get(code)!)]] : []))),
      tapersByCode: async (codes: string[]) => new Map(codes.flatMap((code): [string, TaperRow][] => (code === TEMPLATE.code ? [[code, structuredClone(TEMPLATE)]] : []))),
      countries: async () => structuredClone(world.countries),
    } as unknown as Pick<CatalogWorkbookService, 'verdictReference' | 'recommendedByCode' | 'tapersByCode' | 'countries' | 'guideFor'>,
    catalog: {
      shelfFacts: async (ids: string[]) => new Map(ids.flatMap((id): [string, ShelfFacts][] => (world.facts.has(id) ? [[id, structuredClone(world.facts.get(id)!)]] : []))),
      productSummaries: async (ids: string[]) => new Map(ids.flatMap((id): [string, ProductSummary][] => (world.summaries.has(id) ? [[id, structuredClone(world.summaries.get(id)!)]] : []))),
    } as unknown as Pick<ProductCatalogService, 'shelfFacts' | 'productSummaries'>,
    shelf: { activeEntriesFor: async () => structuredClone(world.entries) } as unknown as Pick<ShelfService, 'activeEntriesFor'>,
    recommendations: {
      shoppingFor: async () => ({ ...world.shopping }),
      // As RecommendationService.candidatesFor answers: cheapest first (lowest price, then code), and nothing for another country's question.
      candidatesFor: async ({ step, country }: { step: RoutineStep; country?: string }) =>
        country === undefined ? structuredClone([...(world.candidates[step] ?? [])].sort((a, b) => a.priceMin - b.priceMin || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))) : [],
    } as unknown as Pick<RecommendationService, 'shoppingFor' | 'candidatesFor'>,
    safety: {
      // As SafetyService.view has it: pregnant or breastfeeding ticked is excludesPregnancyCaution.
      currentOrNull: async () => ({ choices: [...world.safetyChoices], excludesPregnancyCaution: world.safetyChoices.includes('pregnant') || world.safetyChoices.includes('breastfeeding') }),
    } as unknown as Pick<SafetyService, 'currentOrNull'>,
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
  ['lookFor', () => viewer.lookFor('treat')],
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

  it('answers a ready routine as the body: its morning and evening lists in order with each product as the shelf and the catalog know it, and the step-down the verdict stopped', async () => {
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.current()))

    expect(routine).toMatchObject({ status: 'ready', startedOn: null, expectation: 'Give it 8 to 12 weeks before judging.' })
    expect(routine).not.toHaveProperty('steps')
    // Cleanse am, treat pm, moisturise am-pm, protect am.
    expect(routine.morning.map((e: any) => [e.step, e.when, e.changed])).toEqual([
      ['cleanse', 'Every day', false],
      ['moisturise', 'Every day', false],
      ['protect', 'Every day', false],
    ])
    expect(routine.evening.map((e: any) => [e.step, e.when, e.changed])).toEqual([
      ['treat', 'Every day', false],
      ['moisturise', 'Every day', false],
    ])
    const entries = entriesOf(routine)
    expect(entries[0].product).toEqual({ kind: 'own', entryId: 'entry-a', brand: 'Orbis', name: 'Calm Cleanser' })
    expect(entries[1].product).toMatchObject({ kind: 'recommended', code: 'SERUM-1', brand: 'Lumina', name: 'Bright Serum', soldInCurrentCountry: true, soldElsewhere: [], price: { min: 3000, max: 4500, currency: 'NGN' } })
    expect(entries[2].product).toMatchObject({ kind: 'recommended', code: 'MOIST-GH', brand: 'Accra Skin', soldInCurrentCountry: false, soldElsewhere: ['GH'], price: null })
    expect(entries[3].product).toEqual({ kind: 'none' })
    expect(routine.tapers).toHaveLength(1)
    expect(routine.tapers[0]).toMatchObject({ entryId: 'entry-b', brand: 'Karo', name: 'Karo Glow Cream', code: 'TPR-STEROID-1', kind: 'steroid' })
  })

  it('titles each entry from the forms the catalog knows: a shelf product by the form its shelf facts give, a recommended one by its summary\'s form and its row\'s key ingredient', async () => {
    world.facts.set('form-a', { ...world.facts.get('form-a')!, form: 'gel' })
    world.recommended.set('SERUM-1', recommended('SERUM-1', 'form-serum-1', ['NG'], { keyIngredient: 'Niacinamide' }))
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.current()))

    // cleanse: own gel; treat: Niacinamide, a serum; moisturise: a serum with no key ingredient (a moisturiser step is "Moisturiser" whatever the form); protect: nothing recommended.
    expect(entriesOf(routine).map((e: any) => [e.step, e.title])).toEqual([
      ['cleanse', 'Gel cleanser'],
      ['treat', 'Niacinamide serum'],
      ['moisturise', 'Moisturiser'],
      ['protect', 'Sunscreen'],
    ])
  })

  it('titles a shelf product with no label, which has no form, by its step', async () => {
    world.entries = [{ id: 'entry-a', kind: 'no-label', addedAt: T0, itemId: 'item-1' }]
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.current()))

    expect(entriesOf(routine)[0]).toMatchObject({ step: 'cleanse', title: 'Cleanser' })
  })

  it('answers what the build left out as the version stored it, whatever the shelf holds now', async () => {
    const stored = [
      { entryId: 'entry-b', title: 'Cream', status: 'stepping-down' as const, reason: 'It has a steroid in it, so we stop it slowly.' },
      { entryId: 'entry-gone', title: 'Gel cleanser', status: 'left-out' as const, reason: 'It does the same job as your cleanser.' },
    ]
    await showing(versionRow({ notInRoutine: stored }))

    expect((await body(asVerified(() => viewer.current()))).notInRoutine).toEqual(stored)
  })

  it('answers null for what was left out, not an empty list, for a version built before the column', async () => {
    await showing(versionRow({ notInRoutine: null }))

    expect(await body(asVerified(() => viewer.current()))).toHaveProperty('notInRoutine', null)
  })

  it('answers the plan summary with the goal, the stored counts and the step-down of the product the verdict stopped, named from the shelf', async () => {
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.current()))

    expect(routine.summary).toEqual({
      goal: { id: 'fade-dark-marks', label: 'Fade dark marks' },
      keepUsing: 2,
      useLessOrChange: 1,
      stepDown: {
        products: [{ brand: 'Karo', name: 'Karo Glow Cream' }],
        message: "Stopping Karo Karo Glow Cream suddenly can make your skin flare. We'll take it step by step, so the rough days are expected, not a surprise.",
      },
    })
  })

  it('answers the same summary for an updating routine, and null for a version with no stored counts', async () => {
    await showing(versionRow(), 'updating')
    expect((await body(asVerified(() => viewer.current()))).summary).toMatchObject({ keepUsing: 2, useLessOrChange: 1 })
    world.routine = { status: 'updating', version: versionRow({ shelfCounts: null }) }

    expect(await body(asVerified(() => viewer.current()))).toHaveProperty('summary', null)
  })

  it('has no summary on a pending routine: there is no plan to summarise', async () => {
    expect(await body(asVerified(() => viewer.current()))).toEqual({ status: 'pending' })
  })

  it('prices a recommended product in the shopping country\'s currency', async () => {
    world.shopping = { country: 'GH', budgetBand: null, updatedAt: T0 }
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.current()))

    expect(entriesOf(routine)[2].product).toMatchObject({ code: 'MOIST-GH', soldInCurrentCountry: true, price: { min: 3000, max: 4500, currency: 'GHS' } })
    expect(entriesOf(routine)[1].product).toMatchObject({ code: 'SERUM-1', soldInCurrentCountry: false, soldElsewhere: ['NG'] })
  })

  it('shows a shelf product with no label under the no-label name and no brand', async () => {
    world.entries = [{ id: 'entry-a', kind: 'no-label', addedAt: T0, itemId: 'item-1' }]
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.current()))

    expect(entriesOf(routine)[0].product).toEqual({ kind: 'own', entryId: 'entry-a', brand: null, name: NO_LABEL_NAME })
  })

  it('answers an updating routine with the routine in force and the status updating', async () => {
    await showing(versionRow(), 'updating')

    const routine = await body(asVerified(() => viewer.current()))

    expect(routine.status).toBe('updating')
    expect(entriesOf(routine)).toHaveLength(4)
  })

  it('keeps a retired recommended product on the screen rather than hiding it', async () => {
    world.recommended.set('SERUM-1', recommended('SERUM-1', 'form-serum-1', [], { status: 'retired' }))
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.current()))

    expect(entriesOf(routine)[1].product).toMatchObject({ kind: 'recommended', code: 'SERUM-1', brand: 'Lumina', soldInCurrentCountry: false, soldElsewhere: [], price: null })
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
    expect(entriesOf(routine)).toHaveLength(4)
    expect(error).toHaveBeenCalled()
    const logged = JSON.stringify(error.mock.calls)
    expect(logged).toContain(PROFILE)
    for (const word of ['Calm Cleanser', 'Karo', 'Bright Serum', 'Reason for']) expect(logged, word).not.toContain(word)
  })
})

describe('RoutineViewerService.current: what changed since the routine was last shown', () => {
  const served = (over: Partial<RoutineVersionRow> = {}) => versionRow({ createdAt: at(-3 * DAY), readyAt: at(-3 * DAY), servedAt: at(-2 * DAY), ...over })
  const withTreat = (code: string, frequency: Step['frequency'] = 'pm') => defaultSteps().map((s) => (s.step === 'treat' ? stepOf('treat', { kind: 'candidate', code }, frequency) : s))
  const changedOf = (routine: any) => entriesOf(routine).map((s: any) => s.changed)

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

    expect(entriesOf(routine)[1].product).toMatchObject({ kind: 'own', entryId: 'entry-s' })
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
    expect(snapshot).not.toHaveProperty('steps')
    expect(entriesOf(snapshot)).toHaveLength(4)
    expect(snapshot).toEqual(await body(asVerified(() => viewer.current())))
  })

  it('carries the plan summary in the snapshot, the very one a read answers', async () => {
    await showing(versionRow())

    await asVerified(() => viewer.watch())

    const snapshot = JSON.parse(JSON.stringify(events.subscribed[0]!.snapshot))
    expect(snapshot.summary).toMatchObject({ goal: { id: 'fade-dark-marks', label: 'Fade dark marks' }, keepUsing: 2, useLessOrChange: 1, stepDown: { products: [{ brand: 'Karo', name: 'Karo Glow Cream' }] } })
    expect(snapshot.summary).toEqual((await body(asVerified(() => viewer.current()))).summary)
  })

  it('carries the morning and evening lists and what was left out in the snapshot, the very ones a read answers', async () => {
    await showing(versionRow())

    await asVerified(() => viewer.watch())

    const snapshot = JSON.parse(JSON.stringify(events.subscribed[0]!.snapshot))
    const read = await body(asVerified(() => viewer.current()))
    expect(snapshot.morning.map((e: any) => e.step)).toEqual(['cleanse', 'moisturise', 'protect'])
    expect(snapshot.evening.map((e: any) => e.step)).toEqual(['treat', 'moisturise'])
    expect(snapshot.notInRoutine).toEqual([{ entryId: 'entry-b', title: 'Cream', status: 'stepping-down', reason: 'It has a steroid in it, so we stop it slowly.' }])
    expect([snapshot.morning, snapshot.evening, snapshot.notInRoutine]).toEqual([read.morning, read.evening, read.notInRoutine])
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
  it('starts the routine of the caller\'s profile and answers the body, started with its step-downs dated from the start day', async () => {
    await showing(versionRow())

    const routine = await body(asVerified(() => viewer.start()))

    expect(routines.start).toHaveBeenCalledWith(PROFILE)
    expect(routine.status).toBe('ready')
    expect(routine.startedOn).toBe('2030-06-16')
    expect(routine.tapers[0].steps[0]).toMatchObject({ fromDate: '2030-06-16', toDate: '2030-06-29' })
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
    expect(entriesOf(routine)).toHaveLength(4)
  })

  it('shows the product as got once the routine in force says it is', async () => {
    await showing(versionRow())
    routines.gotIt.mockImplementation(async () => {
      const { version } = world.routine as Extract<RoutineView, { version: RoutineVersionRow }>
      world.routine = { status: 'ready', version: { ...version, steps: version.steps.map((s) => (s.step === 'treat' ? { ...s, gotIt: true } : s)) } }
    })

    const routine = await body(asVerified(() => viewer.gotIt('treat', IP)))

    expect(entriesOf(routine)[1].product).toMatchObject({ code: 'SERUM-1', notYetGot: false })
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
    expect(entriesOf(routine)).toHaveLength(4)
    expect(entriesOf(routine)[2].product).toMatchObject({ code: 'MOIST-GH' })
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

  it('carries the plan summary in the frame it publishes, for a ready routine and an updating one', async () => {
    const row = await showing(versionRow())
    await announce()
    const ready = (events.eventsFor(key)[0] as any).routine

    expect(ready.summary).toMatchObject({ goal: { id: 'fade-dark-marks', label: 'Fade dark marks' }, keepUsing: 2, useLessOrChange: 1, stepDown: { products: [{ brand: 'Karo', name: 'Karo Glow Cream' }] } })
    expect(JSON.parse(JSON.stringify(ready.summary))).toEqual((await body(asVerified(() => viewer.current()))).summary)

    world.routine = { status: 'updating', version: row }
    await announce()
    expect((events.eventsFor(key).at(-1) as any).routine).toMatchObject({ status: 'updating', summary: { keepUsing: 2, useLessOrChange: 1 } })
  })

  it('carries the morning and evening lists and what was left out in the frame it publishes, in place of steps', async () => {
    await showing(versionRow())
    await announce()
    const frame = JSON.parse(JSON.stringify((events.eventsFor(key)[0] as any).routine))

    expect(frame).not.toHaveProperty('steps')
    expect(frame.morning.map((e: any) => e.step)).toEqual(['cleanse', 'moisturise', 'protect'])
    expect(frame.evening.map((e: any) => e.step)).toEqual(['treat', 'moisturise'])
    expect(frame.notInRoutine).toEqual([{ entryId: 'entry-b', title: 'Cream', status: 'stepping-down', reason: 'It has a steroid in it, so we stop it slowly.' }])
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

// ============================================================ #217 PR 2: lookFor(step), screens 4.7 and 4.8 ============================================================
//
// THE CONTRACT THIS BLOCK PINS (assumed: the brief names the endpoint and the body, not the service):
//   lookFor(step): Promise<LookForResponse>     GET /me/routine/steps/{step}/look-for, for the caller's own profile
//   LookForResponse = { category, guide: { whatItDoes, lookFor, forDeeperSkin }, typicalPrice: { low, high, currency } | null, commonlySoldAt: string[],
//                       products: { code, brand, name, imageUrl, origin?, aboutPrice: { amount, currency }, whereSold, why, keyIngredient, strength, inYourRoutine }[] }
//   Gates: the four every session method has, then 409 ROUTINE_NOT_READY (no routine to show, a safety change hiding it included), then 409 STEP_IS_YOURS (the routine's
//   entry for the step is a shelf product), then 503 GUIDE_UNAVAILABLE (guideFor has no approved row for the step). It answers for a recommended step and for "none".
//   guide         guideFor(step, the person's goal from requireGoal()); `lookFor` is the row's `lookForWhenPregnant` when the person is pregnant or breastfeeding
//                 (safety.currentOrNull().excludesPregnancyCaution) and the row has one, else the row's `lookFor`. The row's pregnancy text itself is never a field.
//   products      recommendations.candidatesFor({ step }) (the existing rules; nothing is filtered here), the routine's pick first when it is one of them, then the rest in the
//                 order the candidates came (cheapest, then code); at most 10, the pick counted in them. A pick that is not a candidate (not sold here, retired) is not shown.
//                 aboutPrice is the candidate's priceMin in the shopping country's currency (countries tab); `origin` is 'brand-submitted' only for a brand-submitted candidate.
//   typicalPrice  { low: lowest priceMin, high: highest priceMax, currency } over ALL the candidates (not only the ten shown); null with none.
//   commonlySoldAt up to 3 whereSold texts, most frequent first, ties alphabetical, over ALL the candidates; a null whereSold counts for nothing.
//   why           "Works on X.", "Works on X and Y." or "Works on X, Y and Z." from the candidate's skinConcerns that the person's goal also has, in the GOAL's order,
//                 worded by WORDS below; a fixed generic line when none overlap. Fixed copy: it passes FORBIDDEN_WORDING for every goal and every overlap.

/** What each concern is called in a `why` line: plain seen-words, never a condition (face-scans.tables.ts WORDING is the register). */
const WORDS: Record<ShownConcern, string> = {
  hd_acne: 'spots',
  hd_pore: 'open pores',
  hd_oiliness: 'shine',
  hd_age_spot: 'dark marks',
  hd_redness: 'redness',
  hd_radiance: 'dullness',
  hd_texture: 'rough texture',
  hd_dark_circle: 'dark circles',
  hd_moisture: 'dry skin',
}
const CATEGORY: Record<RoutineStep, string> = { cleanse: 'Cleanser', treat: 'Treatment', moisturise: 'Moisturiser', protect: 'Sunscreen' }

const candidate = (code: string, over: Partial<Candidate> = {}): Candidate => ({
  code,
  product: summary(`form-${code}`, 'Lumina', `Name of ${code}`),
  skinConcerns: ['hd_age_spot'],
  // Everything below the key ingredient is how the candidate was reached: none of it is for a client.
  ingredients: ['Aqua', 'SECRET-INGREDIENT'],
  evidenceUrls: ['https://internal.example/evidence'],
  ingredientsSourceUrl: 'https://internal.example/ingredients',
  keyIngredient: null,
  strength: null,
  passed: ['country', 'step', 'skin-concern', 'skin-type', 'ingredient-rules'],
  sharedWithReaction: [{ productId: 'internal-product-id', ingredients: ['SECRET-INGREDIENT'] }],
  origin: 'sourced',
  frequency: 'am',
  priceMin: 3000,
  priceMax: 4500,
  whereSold: 'Pharmacies',
  ...over,
})

/** The routine in force: cleanse is the shelf's, treat is `treat`, moisturise is a Ghana-only product, protect has nothing. */
const showingTreat = (treat: Step['product'] = { kind: 'candidate', code: 'SERUM-1' }, status: 'ready' | 'updating' = 'ready') =>
  showing(versionRow({ steps: [stepOf('cleanse', { kind: 'shelf', id: 'entry-a' }, 'am'), stepOf('treat', treat, 'pm'), stepOf('moisturise', { kind: 'candidate', code: 'MOIST-GH' }, 'am-pm'), stepOf('protect', { kind: 'none' }, 'am')] }), status)

const lookFor = (step: RoutineStep) => body(asVerified(() => viewer.lookFor(step)))
const productCodes = (response: any): string[] => response.products.map((p: any) => p.code)
/** The numbered candidates C01..Cnn, each a little dearer than the one before, all sold at Pharmacies. */
const numbered = (count: number): Candidate[] =>
  Array.from({ length: count }, (_, i) => candidate(`C${String(i + 1).padStart(2, '0')}`, { priceMin: 1000 + i * 100, priceMax: 1000 + i * 100 + 50 }))

describe('RoutineViewerService.lookFor: when there is nothing to show', () => {
  it('refuses with 409 ROUTINE_NOT_READY when there is no routine yet', async () => {
    const error = await errorOf(asVerified(() => viewer.lookFor('treat')))

    expect(error).toMatchObject({ name: 'ConflictError', code: 'ROUTINE_NOT_READY' })
  })

  it('refuses with 409 ROUTINE_NOT_READY, before 503 GUIDE_UNAVAILABLE, when there is no routine and no guide', async () => {
    world.guides.clear()

    expect(await errorOf(asVerified(() => viewer.lookFor('treat')))).toMatchObject({ code: 'ROUTINE_NOT_READY' })
  })

  it('refuses with 409 STEP_IS_YOURS for a step that is the person\'s own shelf product, so they are not pushed to buy a replacement', async () => {
    await showingTreat()

    const error = await errorOf(asVerified(() => viewer.lookFor('cleanse')))

    expect(error).toMatchObject({ name: 'ConflictError', code: 'STEP_IS_YOURS' })
  })

  it('refuses with 409 STEP_IS_YOURS, before 503 GUIDE_UNAVAILABLE, for an own step when no guide is approved', async () => {
    await showingTreat()
    world.guides.clear()

    expect(await errorOf(asVerified(() => viewer.lookFor('cleanse')))).toMatchObject({ code: 'STEP_IS_YOURS' })
  })

  it('refuses with 503 GUIDE_UNAVAILABLE, and never invents copy, when no guide is approved for the step', async () => {
    await showingTreat()
    world.candidates.treat = [candidate('SERUM-1')]
    world.guides.delete('treat|')

    const error = await errorOf(asVerified(() => viewer.lookFor('treat')))

    expect(error).toMatchObject({ name: 'UnavailableError', code: 'GUIDE_UNAVAILABLE' })
  })

  it('answers for the other steps while one step has no guide: the gap is the step\'s, not the screen\'s', async () => {
    await showingTreat()
    world.guides.delete('treat|')

    expect((await lookFor('moisturise')).guide).toEqual({ whatItDoes: 'What moisturise does.', lookFor: 'What to look for in moisturise.', forDeeperSkin: 'Deeper skin and moisturise.' })
  })
})

describe('RoutineViewerService.lookFor: the guide', () => {
  it.each(['treat', 'moisturise', 'protect'] as const)('answers the %s step with its category noun, its guide and nothing else of the row', async (step) => {
    await showingTreat()

    const response = await lookFor(step)

    expect(response.category).toBe(CATEGORY[step])
    expect(response.guide).toEqual({ whatItDoes: `What ${step} does.`, lookFor: `What to look for in ${step}.`, forDeeperSkin: `Deeper skin and ${step}.` })
  })

  it('answers a recommended step, a "use what you have" step and a routine that is updating, each with the guide', async () => {
    await showingTreat({ kind: 'candidate', code: 'SERUM-1' }, 'updating')

    expect((await lookFor('treat')).guide.whatItDoes).toBe('What treat does.')
    expect((await lookFor('protect')).guide.whatItDoes).toBe('What protect does.')
  })

  it('answers the row written for the person\'s goal instead of the step\'s base row', async () => {
    world.goal = 'even-tone'
    world.guides.set('treat|even-tone', { whatItDoes: 'Treat, for an even tone.', lookFor: 'Look for, for an even tone.', forDeeperSkin: 'Deeper skin, for an even tone.', lookForWhenPregnant: null })
    await showingTreat()

    expect((await lookFor('treat')).guide).toEqual({ whatItDoes: 'Treat, for an even tone.', lookFor: 'Look for, for an even tone.', forDeeperSkin: 'Deeper skin, for an even tone.' })
  })

  it('answers the step\'s base row when the only goal row is for another goal, and when the goal has none', async () => {
    world.goal = 'fade-dark-marks'
    world.guides.set('treat|even-tone', { whatItDoes: 'Treat, for an even tone.', lookFor: 'x', forDeeperSkin: 'x', lookForWhenPregnant: null })
    await showingTreat()

    expect((await lookFor('treat')).guide.whatItDoes).toBe('What treat does.')
  })

  describe('for a person who is pregnant or breastfeeding', () => {
    const withPregnancyText = () => world.guides.set('treat|', { whatItDoes: 'What treat does.', lookFor: 'Look for the usual ingredient.', forDeeperSkin: 'Deeper skin and treat.', lookForWhenPregnant: 'Look for the pregnancy-safe ingredient.' })

    it.each([['pregnant'], ['breastfeeding'], ['pregnant', 'breastfeeding']])('serves the pregnancy text as lookFor when %s is ticked and the row has one', async (...choices) => {
      withPregnancyText()
      world.safetyChoices = choices
      await showingTreat()

      const { guide } = await lookFor('treat')

      expect(guide.lookFor).toBe('Look for the pregnancy-safe ingredient.')
      expect(guide).toEqual({ whatItDoes: 'What treat does.', lookFor: 'Look for the pregnancy-safe ingredient.', forDeeperSkin: 'Deeper skin and treat.' })
    })

    it('serves the ordinary lookFor to a person who is neither, although the row has a pregnancy text', async () => {
      withPregnancyText()
      world.safetyChoices = ['reaction', 'prescription']
      await showingTreat()

      expect((await lookFor('treat')).guide.lookFor).toBe('Look for the usual ingredient.')
    })

    it('serves the ordinary lookFor when the row has no pregnancy text: the row was written safe for pregnancy', async () => {
      world.safetyChoices = ['pregnant']
      await showingTreat()

      expect((await lookFor('treat')).guide.lookFor).toBe('What to look for in treat.')
    })

    it('serves the pregnancy text of the goal\'s row, not the base row\'s, when the goal has its own row', async () => {
      world.goal = 'even-tone'
      withPregnancyText()
      world.guides.set('treat|even-tone', { whatItDoes: 'x', lookFor: 'Goal look for.', forDeeperSkin: 'x', lookForWhenPregnant: 'Goal pregnancy look for.' })
      world.safetyChoices = ['breastfeeding']
      await showingTreat()

      expect((await lookFor('treat')).guide.lookFor).toBe('Goal pregnancy look for.')
    })
  })
})

describe('RoutineViewerService.lookFor: the products we have reviewed', () => {
  it('answers a product as the screen needs it, and nothing of how it was reached', async () => {
    world.candidates.treat = [
      candidate('SERUM-1', {
        product: { ...summary('form-serum-1', 'Lumina', 'Bright Serum'), imageUrl: 'https://img.example/serum-1.png' },
        keyIngredient: 'Niacinamide',
        strength: '5%',
        priceMin: 3000,
        priceMax: 4500,
        whereSold: 'Pharmacies',
        skinConcerns: ['hd_age_spot'],
      }),
    ]
    await showingTreat()

    const response = await lookFor('treat')

    expect(response.products).toEqual([
      {
        code: 'SERUM-1',
        brand: 'Lumina',
        name: 'Bright Serum',
        imageUrl: 'https://img.example/serum-1.png',
        aboutPrice: { amount: 3000, currency: 'NGN' },
        whereSold: 'Pharmacies',
        why: `Works on ${WORDS.hd_age_spot}.`,
        keyIngredient: 'Niacinamide',
        strength: '5%',
        inYourRoutine: true,
      },
    ])
  })

  it('passes a missing image, key ingredient, strength and where-sold on as null', async () => {
    world.candidates.treat = [candidate('SERUM-2', { keyIngredient: null, strength: null, whereSold: null })]
    await showingTreat()

    expect((await lookFor('treat')).products[0]).toMatchObject({ imageUrl: null, keyIngredient: null, strength: null, whereSold: null })
  })

  it('says "brand-submitted" on a product a brand submitted, and says nothing on one we sourced', async () => {
    world.candidates.treat = [candidate('SERUM-1', { origin: 'brand-submitted' }), candidate('SERUM-2', { origin: 'sourced', priceMin: 3100 })]
    await showingTreat()

    const response = await lookFor('treat')

    expect(response.products[0].origin).toBe('brand-submitted')
    expect(response.products[1]).not.toHaveProperty('origin')
  })

  it('prices a product in the currency of the country the person shops in', async () => {
    world.shopping = { country: 'GH', budgetBand: null, updatedAt: T0 }
    world.candidates.treat = [candidate('SERUM-1', { priceMin: 40, priceMax: 55 })]
    await showingTreat()

    const response = await lookFor('treat')

    expect(response.products[0].aboutPrice).toEqual({ amount: 40, currency: 'GHS' })
    expect(response.typicalPrice).toEqual({ low: 40, high: 55, currency: 'GHS' })
  })

  describe('in order', () => {
    it('puts the routine\'s pick first and marks it, although cheaper products exist; the rest follow cheapest first, then by code', async () => {
      world.candidates.treat = [
        candidate('SERUM-1', { priceMin: 5000, priceMax: 6000 }),
        candidate('B-TIE', { priceMin: 2000, priceMax: 2500 }),
        candidate('A-TIE', { priceMin: 2000, priceMax: 2500 }),
        candidate('CHEAPEST', { priceMin: 1500, priceMax: 1800 }),
        candidate('DEAR', { priceMin: 9000, priceMax: 9500 }),
      ]
      await showingTreat({ kind: 'candidate', code: 'SERUM-1' })

      const response = await lookFor('treat')

      expect(productCodes(response)).toEqual(['SERUM-1', 'CHEAPEST', 'A-TIE', 'B-TIE', 'DEAR'])
      expect(response.products.map((p: any) => p.inYourRoutine)).toEqual([true, false, false, false, false])
    })

    it('marks nothing as in the routine when the pick is not one of the candidates (it is sold only elsewhere now), and shows no product that is not a candidate', async () => {
      world.candidates.moisturise = [candidate('MOIST-NG-1', { priceMin: 2500, priceMax: 3000 }), candidate('MOIST-NG-2', { priceMin: 3000, priceMax: 3500 })]
      await showingTreat()

      const response = await lookFor('moisturise')

      expect(productCodes(response)).toEqual(['MOIST-NG-1', 'MOIST-NG-2'])
      expect(response.products.every((p: any) => p.inYourRoutine === false)).toBe(true)
    })

    it('marks nothing as in the routine on a "use what you have" step, and lists the step\'s candidates cheapest first', async () => {
      world.candidates.protect = [candidate('SPF-2', { priceMin: 4000, priceMax: 4500 }), candidate('SPF-1', { priceMin: 3000, priceMax: 3500 })]
      await showingTreat()

      const response = await lookFor('protect')

      expect(productCodes(response)).toEqual(['SPF-1', 'SPF-2'])
      expect(response.products.every((p: any) => p.inYourRoutine === false)).toBe(true)
      expect(response.guide.whatItDoes).toBe('What protect does.')
    })

    it('asks for the step it was asked about: the candidates of another step are never shown', async () => {
      world.candidates.treat = [candidate('TREAT-ONLY')]
      world.candidates.protect = [candidate('SPF-ONLY')]
      await showingTreat()

      expect(productCodes(await lookFor('protect'))).toEqual(['SPF-ONLY'])
    })
  })

  describe('at most ten', () => {
    it.each([
      [9, 9],
      [10, 10],
      [11, 10],
      [12, 10],
    ])('shows %i candidates as %i products, the cheapest ten when nothing is picked', async (count, shown) => {
      world.candidates.protect = numbered(count)
      await showingTreat()

      const response = await lookFor('protect')

      expect(response.products).toHaveLength(shown)
      expect(productCodes(response)).toEqual(numbered(count).slice(0, shown).map((c) => c.code))
    })

    it('counts the pick among the ten: it, then the nine cheapest others, even when the pick is not among the ten cheapest', async () => {
      world.candidates.treat = numbered(12)
      await showingTreat({ kind: 'candidate', code: 'C12' })

      const response = await lookFor('treat')

      expect(productCodes(response)).toEqual(['C12', 'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09'])
      expect(response.products[0].inYourRoutine).toBe(true)
    })

    it('keeps a pick that is among the ten cheapest where it belongs, first, and drops the dearest', async () => {
      world.candidates.treat = numbered(12)
      await showingTreat({ kind: 'candidate', code: 'C05' })

      expect(productCodes(await lookFor('treat'))).toEqual(['C05', 'C01', 'C02', 'C03', 'C04', 'C06', 'C07', 'C08', 'C09', 'C10'])
    })
  })

  describe('the typical price', () => {
    it('runs from the lowest price to the highest price across the candidates, in the shopping currency', async () => {
      world.candidates.treat = [
        candidate('SERUM-1', { priceMin: 3000, priceMax: 4500 }),
        candidate('SERUM-2', { priceMin: 2000, priceMax: 2500 }),
        // The dearest price is a range's top; the dearest lowest price (3500) is not what high is.
        candidate('SERUM-3', { priceMin: 3500, priceMax: 9000 }),
      ]
      await showingTreat()

      expect((await lookFor('treat')).typicalPrice).toEqual({ low: 2000, high: 9000, currency: 'NGN' })
    })

    it('is a single range for one candidate', async () => {
      world.candidates.treat = [candidate('SERUM-1', { priceMin: 3000, priceMax: 4500 })]
      await showingTreat()

      expect((await lookFor('treat')).typicalPrice).toEqual({ low: 3000, high: 4500, currency: 'NGN' })
    })

    it('is null, with no products and nothing commonly sold, when no product is a candidate for the step; the guide is still served', async () => {
      await showingTreat()

      const response = await lookFor('treat')

      expect(response.typicalPrice).toBeNull()
      expect(response.products).toEqual([])
      expect(response.commonlySoldAt).toEqual([])
      expect(response.guide.whatItDoes).toBe('What treat does.')
    })

    it('counts all the candidates, not only the ten shown: a dearer eleventh and twelfth still set the top of the range', async () => {
      world.candidates.protect = numbered(12)
      await showingTreat()

      const response = await lookFor('protect')

      expect(response.products).toHaveLength(10)
      expect(response.typicalPrice).toEqual({ low: 1000, high: 2150, currency: 'NGN' })
    })
  })

  describe('where such products are commonly sold', () => {
    const soldAt = (...places: (string | null)[]) => places.map((whereSold, i) => candidate(`S${i}`, { whereSold, priceMin: 1000 + i, priceMax: 2000 + i }))

    it('lists up to the three places that most candidates are sold at, most common first, a tie in alphabetical order', async () => {
      world.candidates.protect = soldAt('Pharmacies', 'Online', 'Market stalls', 'Pharmacies', 'Supermarkets', 'Online', 'Market stalls', 'Pharmacies')
      await showingTreat()

      // Pharmacies 3, Online 2, Market stalls 2, Supermarkets 1: the tie at 2 is broken alphabetically, and the fourth place is left out.
      expect((await lookFor('protect')).commonlySoldAt).toEqual(['Pharmacies', 'Market stalls', 'Online'])
    })

    it('breaks a tie for the last place alphabetically', async () => {
      world.candidates.protect = soldAt('Zeta shop', 'Alpha shop', 'Mid shop', 'Beta shop')

      await showingTreat()

      expect((await lookFor('protect')).commonlySoldAt).toEqual(['Alpha shop', 'Beta shop', 'Mid shop'])
    })

    it('lists fewer than three when fewer places are known, and leaves out a candidate with no where-sold text', async () => {
      world.candidates.protect = soldAt('Pharmacies', null, 'Pharmacies', null)
      await showingTreat()

      expect((await lookFor('protect')).commonlySoldAt).toEqual(['Pharmacies'])
    })

    it('counts all the candidates, not only the ten shown', async () => {
      // The ten cheapest: four sold at Alpha shop and six at Zeta shop. The three dearer ones, not shown, are sold at Alpha shop too: counting all thirteen, Alpha leads 7 to 6.
      const shown = numbered(10).map((c, i) => ({ ...c, whereSold: i < 4 ? 'Alpha shop' : 'Zeta shop' }))
      const hidden = [10, 11, 12].map((i) => candidate(`D${i}`, { priceMin: 5000 + i, priceMax: 6000 + i, whereSold: 'Alpha shop' }))
      world.candidates.protect = [...shown, ...hidden]
      await showingTreat()

      const response = await lookFor('protect')

      expect(response.products).toHaveLength(10)
      expect(response.commonlySoldAt).toEqual(['Alpha shop', 'Zeta shop'])
    })
  })
})

describe('RoutineViewerService.lookFor: why a product is here', () => {
  const whyOf = async (goal: Goal, skinConcerns: ShownConcern[]): Promise<string> => {
    world.goal = goal
    world.candidates.treat = [candidate('SERUM-1', { skinConcerns })]
    await showingTreat()
    return (await lookFor('treat')).products[0].why
  }
  /** Every non-empty choice of a goal's concerns, in every order they could be listed in, plus none at all. */
  const overlaps = (goal: Goal): ShownConcern[][] => {
    const own = concernsForGoal(goal)
    const subsets: ShownConcern[][] = [[]]
    for (const concern of own) subsets.push(...subsets.map((subset) => [...subset, concern]))
    return subsets
  }

  it.each(SHOWN_CONCERNS)('words %s as the one concern it works on', async (concern) => {
    const goal = GOALS.find((candidateGoal) => concernsForGoal(candidateGoal).includes(concern))!

    expect(await whyOf(goal, [concern])).toBe(`Works on ${WORDS[concern]}.`)
  })

  it('words two overlapping concerns with "and", as the spec\'s example does', async () => {
    // Even tone is dark marks, redness and radiance; this product works on dark marks and radiance.
    expect(await whyOf('even-tone', ['hd_radiance', 'hd_age_spot'])).toBe('Works on dark marks and dullness.')
  })

  it('words three overlapping concerns with commas and a last "and", in the order the goal lists them whatever order the product lists them in', async () => {
    // Fade dark marks is hd_age_spot, hd_acne, hd_texture.
    expect(await whyOf('fade-dark-marks', ['hd_texture', 'hd_acne', 'hd_age_spot'])).toBe('Works on dark marks, spots and rough texture.')
  })

  it('names only the concerns the goal has: a product\'s other concerns are not mentioned', async () => {
    const why = await whyOf('fade-dark-marks', ['hd_dark_circle', 'hd_age_spot', 'hd_moisture'])

    expect(why).toBe('Works on dark marks.')
  })

  it('answers a generic line, which names no concern, when none of the product\'s concerns is the goal\'s', async () => {
    const why = await whyOf('fade-dark-marks', ['hd_dark_circle', 'hd_moisture'])
    const empty = await whyOf('fade-dark-marks', [])

    expect(why).toMatch(/^[A-Z].*\.$/)
    expect(why).not.toMatch(/Works on/)
    for (const words of Object.values(WORDS)) expect(why).not.toContain(words)
    expect(empty).toBe(why)
  })

  it.each(GOALS)('says nothing the wording gate forbids, for %s, whichever of its concerns a product works on', async (goal) => {
    for (const skinConcerns of overlaps(goal)) {
      const why = await whyOf(goal, skinConcerns)

      expect(why.length, `${goal} / ${skinConcerns.join(',')}`).toBeGreaterThan(0)
      for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(why), `"${why}" trips ${code}`).toBe(false)
    }
  })

  it('says nothing the wording gate forbids for any concern the catalog can hold, under any goal', async () => {
    for (const goal of GOALS) {
      const why = await whyOf(goal, [...SHOWN_CONCERNS])

      for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(why), `${goal}: "${why}" trips ${code}`).toBe(false)
    }
  })
})

describe('RoutineViewerService.lookFor: nothing internal is served', () => {
  const INTERNAL_KEYS = [
    'ingredients',
    'evidenceUrls',
    'ingredientsSourceUrl',
    'passed',
    'sharedWithReaction',
    'frequency',
    'skinConcerns',
    'product',
    'id',
    'productId',
    'formulationId',
    'priceMin',
    'priceMax',
    'lookForWhenPregnant',
    'grounding',
    'fixedFrom',
    'approvedBy',
    'approvedOn',
    'auditedBy',
    'auditedOn',
    'model',
    'promptHash',
    'rulesVersion',
    'catalogVersion',
  ]
  const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]) : [])

  it('answers exactly the documented fields, at the top, in the guide and on each product', async () => {
    world.candidates.treat = [candidate('SERUM-1', { origin: 'brand-submitted', keyIngredient: 'Niacinamide', strength: '5%' }), candidate('SERUM-2', { priceMin: 3500 })]
    world.guides.set('treat|', { whatItDoes: 'a', lookFor: 'b', forDeeperSkin: 'c', lookForWhenPregnant: 'd' })
    world.safetyChoices = ['pregnant']
    await showingTreat()

    const response = await lookFor('treat')

    expect(Object.keys(response).sort()).toEqual(['category', 'commonlySoldAt', 'guide', 'products', 'typicalPrice'])
    expect(Object.keys(response.guide).sort()).toEqual(['forDeeperSkin', 'lookFor', 'whatItDoes'])
    expect(Object.keys(response.typicalPrice).sort()).toEqual(['currency', 'high', 'low'])
    expect(Object.keys(response.products[0]).sort()).toEqual(['aboutPrice', 'brand', 'code', 'imageUrl', 'inYourRoutine', 'keyIngredient', 'name', 'origin', 'strength', 'whereSold', 'why'])
    expect(Object.keys(response.products[1]).sort()).toEqual(['aboutPrice', 'brand', 'code', 'imageUrl', 'inYourRoutine', 'keyIngredient', 'name', 'strength', 'whereSold', 'why'])
    expect(Object.keys(response.products[0].aboutPrice).sort()).toEqual(['amount', 'currency'])
  })

  it('carries none of the candidate\'s, the routine\'s or the guide row\'s own fields, and none of their values', async () => {
    world.candidates.treat = [candidate('SERUM-1')]
    await showingTreat()

    const response = await lookFor('treat')

    const found = keysOf(response).filter((key) => INTERNAL_KEYS.includes(key))
    expect(found).toEqual([])
    const text = JSON.stringify(response)
    for (const secret of ['internal.example', 'SECRET-INGREDIENT', 'internal-product-id', 'claude-internal', 'internal-hash', 'product-of-form']) expect(text).not.toContain(secret)
  })
})

// --- the plan the reminder send job reads (spec #217, PR 4b) ---

// THE CONTRACT THIS FILE PINS (assumed: the brief says the send job lists "that morning's entry titles" and needs each entry's frequency and day 1, which the routine body does not carry
// (it shows the `when` label, not the frequency); reminders may not import routines, so the reader lives here and the container hands it to the reminders module as a narrow type):
//   reminderPlanFor(profileId: string): Promise<{ dayOne: 'YYYY-MM-DD'; morning: PlanEntry[]; evening: PlanEntry[] } | null>
//       PlanEntry = { step, title, frequency }. By profile id, no session and no gates (a job calls it). The routine in force as `current` reads it: the morning and evening lists of the
//       body (the same placement, order and titles), each entry with its step's raw frequency. null while that routine has no day 1 (not Started), when there is none, and while it is hidden (pending).
//       It asks for no build, marks nothing served and reads no goal.
// #217 PR 4c extends the SAME read with the step-down alert's days (pinned in the block at the foot of this file): `stepDownChanges`, a flat list of { day, title, line }.
describe('RoutineViewerService.reminderPlanFor', () => {
  const plan = (profileId = PROFILE) => viewer.reminderPlanFor(profileId)

  it('answers day 1 and the morning and evening lists as the body places them, with each entry\'s title and raw frequency', async () => {
    await showing(versionRow({ startedOn: START_DAY }))

    // Cleanse am, treat pm, moisturise am-pm, protect am. The cleanser is Amara's own cream, the treatment a recommended serum. The one step-down in the default version has no
    // date yet (its `startedOn` is null), so it has no change days.
    expect(await plan()).toEqual({
      dayOne: START_DAY.toISOString().slice(0, 10),
      morning: [
        { step: 'cleanse', title: 'Cream cleanser', frequency: 'am' },
        { step: 'moisturise', title: 'Moisturiser', frequency: 'am-pm' },
        { step: 'protect', title: 'Sunscreen', frequency: 'am' },
      ],
      evening: [
        { step: 'treat', title: 'Serum', frequency: 'pm' },
        { step: 'moisturise', title: 'Moisturiser', frequency: 'am-pm' },
      ],
      stepDownChanges: [],
    })
  })

  it('puts a product used less than daily in the evening with its own frequency, as-needed ones too, and the sunscreen only in the morning', async () => {
    await showing(
      versionRow({
        startedOn: START_DAY,
        steps: [
          stepOf('cleanse', { kind: 'shelf', id: 'entry-a' }, 'pm'),
          stepOf('treat', { kind: 'candidate', code: 'SERUM-1' }, 'alternate-days'),
          stepOf('moisturise', { kind: 'none' }, 'as-needed'),
          stepOf('protect', { kind: 'none' }, 'am'),
        ],
      }),
    )

    const read = (await plan())!

    expect(read.morning.map((e) => [e.step, e.frequency])).toEqual([['protect', 'am']])
    expect(read.evening.map((e) => [e.step, e.frequency])).toEqual([
      ['cleanse', 'pm'],
      ['treat', 'alternate-days'],
      ['moisturise', 'as-needed'],
    ])
  })

  it('carries a weekly frequency as it is', async () => {
    await showing(
      versionRow({
        startedOn: START_DAY,
        steps: [stepOf('cleanse', { kind: 'shelf', id: 'entry-a' }, 'pm'), stepOf('treat', { kind: 'candidate', code: 'SERUM-1' }, 'weekly'), stepOf('moisturise', { kind: 'none' }, 'am')],
      }),
    )

    const read = (await plan())!

    expect(read.evening.map((e) => [e.step, e.frequency])).toEqual([
      ['cleanse', 'pm'],
      ['treat', 'weekly'],
    ])
  })

  it('titles an entry as the body does, from the forms the catalog knows and the recommended row\'s key ingredient', async () => {
    world.recommended.set('SERUM-1', recommended('SERUM-1', 'form-serum-1', ['NG'], { keyIngredient: 'Niacinamide' }))
    await showing(versionRow({ startedOn: START_DAY }))

    const read = (await plan())!

    expect(read.evening[0]).toEqual({ step: 'treat', title: 'Niacinamide serum', frequency: 'pm' })
  })

  it('titles an entry whose key ingredient trips the wording gate by its plain step noun, and every title it answers passes the gate', async () => {
    // The catalog's words are the maker's own: "Skin whitening" must never reach a lock screen.
    world.recommended.set('SERUM-1', recommended('SERUM-1', 'form-serum-1', ['NG'], { keyIngredient: 'Skin whitening' }))
    world.recommended.set('MOIST-GH', recommended('MOIST-GH', 'form-moist-gh', ['GH'], { keyIngredient: 'Melasma' }))
    await showing(versionRow({ startedOn: START_DAY }))

    const read = (await plan())!

    expect(read.evening.map((e) => [e.step, e.title])).toEqual([
      ['treat', 'Serum'],
      ['moisturise', 'Moisturiser'],
    ])
    for (const { title } of [...read.morning, ...read.evening]) {
      for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(title), `"${title}" trips ${code}`).toBe(false)
    }
  })

  it('answers the routine in force while a newer one is being built', async () => {
    await showing(versionRow({ startedOn: START_DAY }), 'updating')

    expect(await plan()).toMatchObject({ dayOne: START_DAY.toISOString().slice(0, 10) })
  })

  it('answers null before the routine is Started and while a build is pending (RoutineService.current answers pending when there is no routine or it is hidden)', async () => {
    await showing(versionRow({ startedOn: null }))
    expect(await plan()).toBeNull()

    world.routine = { status: 'pending' }
    expect(await plan()).toBeNull()
  })

  it('asks for no build, marks nothing served and reads no goal', async () => {
    const row = await showing(versionRow({ startedOn: START_DAY }))

    await plan()

    expect(routines.request).not.toHaveBeenCalled()
    expect(routines.requestIfStale).not.toHaveBeenCalled()
    expect(requireGoal).not.toHaveBeenCalled()
    expect((await repository.current(PROFILE))!.servedAt).toBeNull()
    expect(row.servedAt).toBeNull()
  })
})

// --- the step-down alert's days, on the same plan (spec #217, PR 4c) ---

// THE CONTRACT THIS FILE PINS (assumed: the brief says "feed the reminders module the taper change days and copy through a narrow plan read owned by routines, either extend that read or add a
// sibling"; this extends reminderPlanFor, because the job already reads the plan for the same profile in the same run, and a second read would redo the routine's reads):
//   reminderPlanFor(profileId) gains   stepDownChanges: { day: 'YYYY-MM-DD'; title: string; line: string }[]
//       One entry for the FIRST DAY of each step of each dated step-down's schedule (the same `fromDate` the routine body prints for the step, week 1 included, the `stop` step included),
//       in the version's step-down order and then the schedule's. A day inside a step (the second week of a two-week step) is not a change. A step-down with no date yet (`startedOn`
//       null) has none; a step-down whose template the workbook no longer holds has none (and is logged, as the body logs it) and does not stop the others'. [] when nothing changes.
//       `title` is the product's plain ROUTINE title (the frozen `notInRoutine` title for that shelf entry: "Cream"), never the maker's brand or name (those are the maker's own words and can
//       trip the wording gate), and it survives the product leaving the shelf. `line` is the fixed copy of the step, owned here with the rest of the routine's words, and passes the gate:
//         alternate-days -> 'From today: use it every other day'     weekly -> 'From today: use it once a week'     stop -> 'From today: stop using it'
//       (the other frequencies a schedule may hold are daily or as-needed; their lines start 'From today: ' too, and are pinned only by the gate sweep below).
//   ReminderRoutinePlan (reminders.types.ts, which this module never imports) is { dayOne, morning, evening, stepDownChanges }.
describe('RoutineViewerService.reminderPlanFor: the step-down change days', () => {
  const plan = () => viewer.reminderPlanFor(PROFILE)
  /** The calendar day `n` days after day 1. */
  const dayOne = (n: number) => new Date(START_DAY.getTime() + n * DAY).toISOString().slice(0, 10)
  const taper = (shelfProductId: string, startedOn: Date | null, templateId = TEMPLATE.code) => ({ shelfProductId, templateId, startedOn })
  const leftOut = (entryId: string, title: string) => ({ entryId, title, status: 'stepping-down' as const, reason: 'It is stopped slowly.' })

  it('lists the first day of each step of the schedule, week one included and the stop included, with the fixed line for the step and the product\'s routine title', async () => {
    await showing(versionRow({ startedOn: START_DAY, tapers: [taper('entry-b', START_DAY)] }))

    const read = (await plan())!

    // The template: weeks 1-2 every other day, weeks 3-4 weekly, week 5 stop. Steps start on days 0, 14 and 28; day 7 (week 2) is inside the first step and is no change.
    expect(read.stepDownChanges).toEqual([
      { day: dayOne(0), title: 'Cream', line: 'From today: use it every other day' },
      { day: dayOne(14), title: 'Cream', line: 'From today: use it once a week' },
      { day: dayOne(28), title: 'Cream', line: 'From today: stop using it' },
    ])
    // The maker's words never reach the plan: the shelf product is "Karo Glow Cream".
    expect(JSON.stringify(read.stepDownChanges)).not.toContain('Karo')
  })

  it('answers the same dates the routine body prints for the step-down (fromDate), so the alert and the schedule screen never disagree', async () => {
    await showing(versionRow({ startedOn: START_DAY, tapers: [taper('entry-b', START_DAY)] }))
    const shown = await body(asVerified(() => viewer.current()))

    const read = (await plan())!

    expect(read.stepDownChanges.map((change: { day: string }) => change.day)).toEqual(shown.tapers[0].steps.map((step: { fromDate: string }) => step.fromDate))
  })

  it('counts a step-down that began after Start from its own date, not from day 1', async () => {
    await showing(versionRow({ startedOn: START_DAY, tapers: [taper('entry-b', new Date(START_DAY.getTime() + 10 * DAY))] }))

    const read = (await plan())!

    expect(read.stepDownChanges.map((change: { day: string }) => change.day)).toEqual([dayOne(10), dayOne(24), dayOne(38)])
  })

  it('answers none for a step-down that has no date yet, and none while the routine is not Started (the plan is null)', async () => {
    await showing(versionRow({ startedOn: START_DAY, tapers: [taper('entry-b', null)] }))
    expect((await plan())!.stepDownChanges).toEqual([])

    await showing(versionRow({ startedOn: null, tapers: [taper('entry-b', null)] }))
    expect(await plan()).toBeNull()
  })

  it('answers none for a routine with nothing being stopped', async () => {
    await showing(versionRow({ startedOn: START_DAY, tapers: [], notInRoutine: [] }))

    expect((await plan())!.stepDownChanges).toEqual([])
  })

  it('lists each step-down\'s changes under its own title, in the version\'s order of step-downs and then the schedule\'s', async () => {
    await showing(
      versionRow({
        startedOn: START_DAY,
        tapers: [taper('entry-b', START_DAY), taper('entry-c', new Date(START_DAY.getTime() + 14 * DAY))],
        notInRoutine: [leftOut('entry-b', 'Cream'), leftOut('entry-c', 'Gel cleanser')],
      }),
    )

    const read = (await plan())!

    expect(read.stepDownChanges.map((change: { day: string; title: string }) => [change.day, change.title])).toEqual([
      [dayOne(0), 'Cream'],
      [dayOne(14), 'Cream'],
      [dayOne(28), 'Cream'],
      // The second step-down began on day 15, so its first step starts on the day the first one's second step does: two changes on one day.
      [dayOne(14), 'Gel cleanser'],
      [dayOne(28), 'Gel cleanser'],
      [dayOne(42), 'Gel cleanser'],
    ])
  })

  it('still titles a step-down whose shelf product has left the shelf, by the title the routine was built with', async () => {
    world.entries = world.entries.filter((entry) => entry.id !== 'entry-b')
    await showing(versionRow({ startedOn: START_DAY, tapers: [taper('entry-b', START_DAY)] }))

    const read = (await plan())!

    expect(read.stepDownChanges.map((change: { title: string }) => change.title)).toEqual(['Cream', 'Cream', 'Cream'])
  })

  it('drops a step-down whose template the workbook no longer holds, logs it by id, and keeps the others\' changes', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await showing(
      versionRow({
        startedOn: START_DAY,
        tapers: [taper('entry-c', START_DAY, 'TPR-GONE'), taper('entry-b', START_DAY)],
        notInRoutine: [leftOut('entry-b', 'Cream'), leftOut('entry-c', 'Gel cleanser')],
      }),
    )

    const read = (await plan())!

    expect(read.stepDownChanges.map((change: { title: string }) => change.title)).toEqual(['Cream', 'Cream', 'Cream'])
    expect(JSON.stringify(errors.mock.calls)).toContain('TPR-GONE')
  })

  it('passes the wording gate in every title and line, and the lines are different for different frequencies', async () => {
    await showing(versionRow({ startedOn: START_DAY, tapers: [taper('entry-b', START_DAY)] }))

    const read = (await plan())!

    for (const { title, line } of read.stepDownChanges) {
      for (const { code, pattern } of FORBIDDEN_WORDING) {
        expect(pattern.test(title), `"${title}" trips ${code}`).toBe(false)
        expect(pattern.test(line), `"${line}" trips ${code}`).toBe(false)
      }
      expect(line).toMatch(/^From today: /)
    }
    expect(new Set(read.stepDownChanges.map((change: { line: string }) => change.line)).size).toBe(3)
  })
})
