import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, currentActor, requireUser, runAs } from '../../lib/context'
import { ConflictError } from '../../lib/errors'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryRoutineWriter } from '../../providers/routine-writing/memory.routine-writer'
import type { RoutineRetry } from '../../providers/routine-writing/routine-writer.provider'
import type { ProductCatalogService, ShelfFacts } from '../catalog/catalog.service'
import type { RoutineStep } from '../catalog/catalog.vocabulary'
import type { CatalogWorkbookService } from '../catalog/catalog.workbook.service'
import type { FaceScanService } from '../face-scans/face-scans.service'
import type { GoalsService } from '../goals/goals.service'
import type { Goal } from '../goals/goals.vocabulary'
import type { RecommendationService } from '../recommendations/recommendations.service'
import type { Candidate } from '../recommendations/recommendations.types'
import type { SafetyService } from '../safety/safety.service'
import type { ParseState, SafetyMentionRow, SafetyView } from '../safety/safety.types'
import type { SafetyChoice } from '../safety/safety.vocabulary'
import type { ShelfActiveEntry, ShelfService } from '../shelf/shelf.service'
import type { SkinCareService } from '../skin-care/skin-care.service'
import type { ProfilesService } from '../profiles/profiles.service'
import type { RemindersService } from '../reminders/reminders.service'
import type { SavedVerdictView, VerdictService } from '../verdicts/verdicts.service'
import type { SavedVerdictProduct } from '../verdicts/verdicts.types'
import { checkRoutine } from './routines.gates'
import { buildRoutineSpec, type BuildRoutineMessage } from './routines.job-specs'
import { routineFingerprint } from './routines.fingerprint'
import { FakeOutcomeCountsRepository } from './routines.outcome-counts.repository.fake'
import { hintsShown } from './routines.outcomes'
import { FakeRoutinesRepository } from './routines.repository.fake'
import { ROUTINE_RULES_VERSION } from './routines.rules'
import { RoutineService, type RoutineServiceDeps } from './routines.service'
import type { Routine, RoutineEntry, RoutineSkeleton, ShelfVerdict } from './routines.types'

// The routine service (spec #189, PR 2b): `build` (what the build-routine job will run), `current`, `start` and `gotIt`. The other services are Pick<> fakes that
// answer from one mutable `world`, as the verdicts test does, so a test changes the world (a product removed, a country changed, a safety answer added) and
// reads the outcome from the repository, the writer's record and the service. The writer is the real MemoryRoutineWriter, the repository the real fake. A routine
// is only ever reached the way life reaches it: first build, Start, then a change and a rebuild. `stableMerge` is the service's own dependency and is not tested
// here: only what a caller can see (which steps the writer was asked about, which steps came out the same).
//
// The contract this file pins:
//   new RoutineService({ verdicts, recommendations, goals, safety, shelf, catalog, faceScans, workbook, profiles, writer, writerIdentity, repository, now, newId }),
//   the first nine being the Pick<> of what the build reads: verdicts (savedFor), recommendations (candidatesFor, shoppingFor), goals (goalFor), safety (snapshotFor),
//   shelf (activeEntriesFor, add), catalog (shelfFacts), faceScans (seenFor), workbook (countries, verdictReference), profiles (find). `writerIdentity` is
//   { model, promptHash }. `newId()` is called once for each build that gets as far as reading its facts (PR 3c mints the version's id before the skeleton, to decide
//   whether hints are shown from it), so a build that appends nothing ('unchanged') has used an id; the id of the version appended is the one minted.
//   build(profileId, reason, options?: { exclude?: { step, code } }): Promise<'built' | 'unchanged' | 'waiting'>   all run by profile id, as a job runs them
//   current(profileId): Promise<{ status: 'pending' } | { status: 'updating'; version } | { status: 'ready'; version }>   `version` is the stored row (id, steps, tapers, ...)
//   start(profileId): Promise<void>    ConflictError ROUTINE_NOT_READY without a ready version
//   gotIt(profileId, step, clientIp): Promise<void>    ConflictError STEP_NOT_RECOMMENDED unless the step's product is a recommended one; calls shelf.add(product id, clientIp)
//
// PR 5 (the plan summary): every version a build writes records how it sorted the shelf, `shelfCounts: { keep, reduce, drop, stop }`, from the skeleton's shelf
// (so a reduced sunscreen, which the skeleton keeps as it is, counts as keep, and a verdict entry the build leaves out counts nowhere); a pending version has null.
// The counts are the version's own: a copy ("I got it") carries them unchanged, a rebuild counts the shelf it was built from, and a rebuild that finds nothing
// to change appends nothing and so leaves them. And Start makes TOMORROW (the next UTC midnight) day 1, a step-down never beginning before day 1.
//
// PR 6 (the "Your routine" screen): every version a build writes also records what the routine was built without, `notInRoutine: { entryId, title, status, reason }[]`,
// frozen at build. One item for each product of the skeleton's shelf (the products the build used, in the shelf's order, not the verdict's) whose verdict is `stop`
// (status 'stepping-down') or `drop` ('left-out'), with `reason` the verdict item's own one-line reason (SavedVerdictProduct.reason, which the skeleton does not carry:
// the service reads it from the saved verdict) and `title` from the title rule (routines.view.test.ts) using the product's form (shelfFacts) and the verdict's step.
// It is stored, carried and refreshed exactly as `shelfCounts` is: null while pending, [] for none, carried by the "I got it" copy, rewritten by a build that writes a
// version, refreshed (before the fingerprint) by a rebuild that finds nothing to change when the inputs moved or the version has none, and left alone otherwise.
// Assumed repository method: setNotInRoutine(id, items), the sibling of setShelfCounts.
//
// PR 3 of spec #217 (local days): one more dep, `reminders: Pick<RemindersService, 'zoneFor'>`, read for the profile's stored time zone (zoneFor(profileId): Promise<string |
// null>, null while none is stored; the world's `zone`, null by default). The zone only decides what "today" is. The dates the routine stores are CALENDAR DATES, each the UTC
// midnight of the person's local date, fixed when set: Start makes the local date after the person's local today day 1 (a Lagos tap at 00:30 on the 16th, 23:30 UTC on the
// 15th, stores 2030-06-17T00:00Z), and a step-down that begins after Start is dated the local date of the rebuild (still never before day 1). Nothing stored moves when the
// zone changes later. With no zone both stay on the UTC date, exactly as before, which is what every test above the "local days" blocks relies on. The helpers are
// src/lib/local-day.ts (pinned in its own test); here it is only what Start and the dating do with them.
//
// PR 3b adds two deps, `jobs: JobQueue` (here the MemoryJobQueue, which records each enqueue and its delay) and `enabled: boolean`, and three methods (spec #189):
//   request(profileId, reason, requestKey): Promise<boolean>   (whether a build was queued) never throws. Disabled: does nothing at all (no claim either). Otherwise claims the build with
//       repository.claim(profileId, requestKey, now, now - a stale cut-off) and, when it wins, enqueues the job `build-routine` with
//       { profileId, reason, requestKey, requestedAt: now.getTime(), waits: 0 } and no delay. A queue that refuses gives the claim back. Failures are logged by id.
//   run(body: BuildRoutineMessage): Promise<void>   calls build(body.profileId, body.reason). On 'waiting' for reason `first` or `review-point` while
//       body.waits < 15 it enqueues { ...body, waits: body.waits + 1 } with delaySeconds 60 and keeps the claim; any other outcome releases the claim
//       (repository.release(profileId, new Date(body.requestedAt))). An error from build is thrown for the queue to retry.
//   markBuildFailed(body: BuildRoutineMessage): Promise<void>   the dead letter: releases the claim; the first time sets the request's retry due 24 hours on
//       (repository.setRequestRetry), a body with `retry: true` is final (no retry due) and logged.

// The one clock every test hangs off; later times are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)
const utcDay = (date: Date) => date.toISOString().slice(0, 10)

const AMARA_PROFILE = 'profile-amara-1'
const AMARA_USER = 'user-amara'
// Who a read by profile id must run as: the account that owns the profile, verified (the routine is for signed-up accounts).
const AMARA_ACTOR: Actor = { kind: 'user', userId: AMARA_USER, status: 'verified', profileId: AMARA_PROFILE }
const SYSTEM: Actor = { kind: 'system', job: 'build-routine' }

const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
const STEROID = ['Aqua', 'Clobetasol Propionate']
const STEROID_SOURCE = 'https://example.org/rules/clobetasol'
const CLIENT_IP = '203.0.113.7'

// ---- the world the other services answer from ----

type NG_OR_GH = 'NG' | 'GH'
type Country = Awaited<ReturnType<CatalogWorkbookService['countries']>>[number]

type World = {
  saved: SavedVerdictView | null
  goal: Goal | null
  safety: { view: SafetyView | null; parseState: ParseState | null; mentions: SafetyMentionRow[] }
  shopping: { country: string; budgetBand: 'low' | 'mid' | 'high' | null } | null
  entries: ShelfActiveEntry[]
  facts: Map<string, ShelfFacts>
  candidates: Record<NG_OR_GH, Partial<Record<RoutineStep, Candidate[]>>>
  seen: Awaited<ReturnType<FaceScanService['seenFor']>>
  countries: Country[]
  profiles: Map<string, string>
  /** The IANA time zone the profile stored with its reminder settings, or null when it stored none (the UTC day applies). */
  zone: string | null
  /** The users who have not verified: guests. Everyone else is verified (every test but the guest ones is about a signed-up account). */
  guests: Set<string>
  /** The actor in force at each call that needs a session in life (candidatesFor and shelf.add both require a user). */
  actors: Actor[]
  shelfAdds: { productId: string; clientIp: string }[]
  /** Runs inside shelf.add, after the product is added: a build or a Start that lands while the user taps "I got it". */
  duringAdd: (() => Promise<void>) | null
}

const safetyView = (choices: SafetyChoice[]): SafetyView => ({
  choices,
  reactionText: null,
  prescriptionText: null,
  excludesPregnancyCaution: choices.includes('pregnant') || choices.includes('breastfeeding'),
  updatedAt: T0,
})

const candidate = (code: string, priceMin: number, frequency: Candidate['frequency']): Candidate => ({
  code,
  product: { id: `prod-${code}`, kind: 'named', brand: `Brand ${code}`, name: `Name ${code}`, variant: null, form: 'cream', category: 'skin', imageUrl: null },
  keyIngredient: null,
  strength: null,
  skinConcerns: ['hd_age_spot'],
  ingredients: ['Aqua', 'Niacinamide'],
  evidenceUrls: [`https://example.org/evidence/${code}`],
  ingredientsSourceUrl: `https://example.org/ingredients/${code}`,
  passed: ['country', 'step'],
  sharedWithReaction: [],
  origin: 'sourced',
  frequency,
  priceMin,
  priceMax: priceMin + 1000,
  whereSold: 'Pharmacies',
})

const verdictProduct = (entryId: string, verdict: ShelfVerdict, step: RoutineStep | null, over: Partial<SavedVerdictProduct> = {}): SavedVerdictProduct => ({
  entryId,
  group: verdict.kind === 'stop' ? 'likely-the-problem' : 'helping',
  verdict,
  escalate: false,
  reason: 'A test reason.',
  facts: [],
  basis: [],
  step,
  sourceUrls: [],
  ...over,
})

const newWorld = (): World => ({
  saved: {
    fingerprint: 'verdict-fp-1',
    fit: 'ready',
    builtAt: T0,
    rulesVersion: 'verdict-rules-7',
    products: [
      verdictProduct('entry-a', { kind: 'keep' }, 'cleanse'),
      verdictProduct('entry-b', { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, 'treat', { sourceUrls: [STEROID_SOURCE] }),
    ],
  },
  goal: 'fade-dark-marks',
  safety: { view: safetyView(['reaction']), parseState: 'done', mentions: [] },
  shopping: { country: 'NG', budgetBand: 'mid' },
  entries: [],
  facts: new Map(),
  // Cheapest first, as the recommendation rules give them. SERUM-1 is sold in NG only.
  candidates: {
    NG: {
      cleanse: [candidate('CLEANSER-1', 2000, 'am'), candidate('CLEANSER-2', 3500, 'pm')],
      treat: [candidate('SERUM-1', 3000, 'pm'), candidate('SERUM-2', 5000, 'alternate-days')],
      moisturise: [candidate('MOIST-1', 2500, 'am-pm')],
      protect: [candidate('SPF-1', 4000, 'am')],
    },
    GH: {
      cleanse: [candidate('CLEANSER-1', 2000, 'am')],
      treat: [candidate('SERUM-GH', 3500, 'pm')],
      moisturise: [candidate('MOIST-1', 2500, 'am-pm')],
      protect: [candidate('SPF-1', 4000, 'am')],
    },
  },
  seen: { seen: [{ concern: 'hd_age_spot', level: 'some' }], alsoNoticed: [{ concern: 'hd_radiance', level: 'faint' }], skinType: 'combination' },
  countries: [
    { code: 'NG', currency: 'NGN', lowMax: 5000, midMax: 15000, status: 'active' },
    { code: 'GH', currency: 'GHS', lowMax: 100, midMax: 300, status: 'active' },
  ],
  profiles: new Map([[AMARA_PROFILE, AMARA_USER]]),
  zone: null,
  guests: new Set(),
  actors: [],
  shelfAdds: [],
  duringAdd: null,
})

let world: World
/** The catalog version the workbook says is live: a build records it. */
let catalogVersion = 42
let entryCount = 0
let verdictRevision = 1

/** Puts a product on the shelf the way the accessors give it: an active entry, and the formulation facts it points at. */
const addProduct = (id: string, ingredients: string[], over: Partial<ShelfFacts> = {}) => {
  world.entries.push({ id, kind: 'product', addedAt: at(entryCount++ * MINUTE), productId: `prod-${id}`, formulationId: `form-${id}` })
  world.facts.set(`form-${id}`, { productId: `prod-${id}`, brand: 'Orbis', name: `Product ${id}`, variant: null, form: 'cream', category: 'skin', ingredients, ...over })
}

/** The verdict was saved again from different inputs: a new fingerprint, these products. */
const saveVerdict = (products: SavedVerdictProduct[]) => {
  world.saved = { ...world.saved!, fingerprint: `verdict-fp-${++verdictRevision}`, products }
}
const productsOfVerdict = () => world.saved!.products
/** The same verdict saved again from other inputs (a new fingerprint), nothing in it different. */
const reverdict = () => saveVerdict(productsOfVerdict())
const removeShelfProduct = (id: string) => {
  world.entries = world.entries.filter((entry) => entry.id !== id)
  saveVerdict(productsOfVerdict().filter((p) => p.entryId !== id))
}
/** SERUM-1 leaves the catalog: it is sold nowhere. */
const retireSerum1 = () => {
  for (const country of ['NG', 'GH'] as const) {
    world.candidates[country].treat = (world.candidates[country].treat ?? []).filter((c) => c.code !== 'SERUM-1')
  }
}

// ---- the writer: a Memory writer that can pause at the start of a call, so a test can look at the service while a build is running ----

class HookedWriter extends MemoryRoutineWriter {
  hook: (() => Promise<void>) | null = null
  async write(skeleton: RoutineSkeleton, retry?: RoutineRetry): Promise<Routine> {
    await this.hook?.()
    return super.write(skeleton, retry)
  }
}

/** A routine in "the writer's words": every reason says which attempt wrote it, so a step taken from one build is told from a step written by another. */
const routineFrom = (skeleton: RoutineSkeleton, tag: string): Routine => {
  const steps: RoutineEntry[] = skeleton.steps.map((step): RoutineEntry => {
    const allowed = skeleton.limits.allowed[step]
    const kept = skeleton.shelf.find((p) => p.step === step && (p.verdict.kind === 'keep' || p.verdict.kind === 'reduce'))
    if (kept) return { step, product: { kind: 'shelf', id: kept.id }, frequency: allowed[0]!, reason: `${tag}: ${step}.`, grounding: [] }
    const first = skeleton.gaps.find((gap) => gap.step === step)?.candidates[0]
    if (!first) return { step, product: { kind: 'none' }, frequency: allowed[0]!, reason: `${tag}: ${step}.`, grounding: [] }
    return { step, product: { kind: 'candidate', code: first.code }, frequency: allowed.includes(first.frequency) ? first.frequency : allowed[0]!, reason: `${tag}: ${step}.`, grounding: [] }
  })
  const tapers = skeleton.shelf.flatMap((p) => (p.verdict.kind === 'stop' ? [{ shelfProductId: p.id, templateId: p.verdict.taperTemplateId }] : []))
  return { steps, tapers, expectation: `${tag}: expect results in 8 to 12 weeks.` }
}

type Answer = (skeleton: RoutineSkeleton) => Routine
/** A routine that breaks exactly one gate, the frequency one, at the protect step. */
const breaksFrequency = (answer: Answer): Answer => (skeleton) => {
  const routine = answer(skeleton)
  return { ...routine, steps: routine.steps.map((entry) => (entry.step === 'protect' ? { ...entry, frequency: 'pm' as const } : entry)) }
}
const FREQUENCY_AT_PROTECT = { failed: [{ gate: 'frequency', step: 'protect' }] }

let clock: Date
let repository: FakeRoutinesRepository
let outcomeCounts: FakeOutcomeCountsRepository
let jobs: MemoryJobQueue
let deps: RoutineServiceDeps
let writer: HookedWriter
let service: RoutineService
/** How many times the writer was asked, failed asks included. The words of the n-th ask are tagged "Written n". */
let attempts: number
let ids: number
/** The profile ids the service told the live stream about (PR 4b), in order. */
let announces: string[]
/** The calls the service made to skin care's reconcile (spec #233, PR 4b): the profile, and the id of the version in force at the moment of the call. */
let reconciled: { profileId: string; versionId: string | null }[]

const setClock = (offsetMs: number) => {
  clock = at(offsetMs)
}
/** The writer answers the next asks with these (a function that throws is a writer error), then well. */
const script = (...answers: Answer[]) => {
  let asked = 0
  writer.respondWith((skeleton) => {
    attempts++
    const answer = answers[asked++] ?? ((s: RoutineSkeleton) => routineFrom(s, `Written ${attempts}`))
    return answer(skeleton)
  })
}
const good = (): Answer => (skeleton) => routineFrom(skeleton, `Written ${attempts}`)
const throws = (): Answer => () => {
  throw new Error('the routine writer is unavailable')
}

type Reason = Parameters<RoutineService['build']>[1]
const build = (reason: Reason = 'first', options?: Parameters<RoutineService['build']>[2]) => runAs(SYSTEM, () => service.build(AMARA_PROFILE, reason, options))
const current = () => runAs(SYSTEM, () => service.current(AMARA_PROFILE))
const start = () => runAs(SYSTEM, () => service.start(AMARA_PROFILE))
const gotIt = (step: RoutineStep) => runAs(SYSTEM, () => service.gotIt(AMARA_PROFILE, step, CLIENT_IP))
const latestRow = async () => (await repository.latest(AMARA_PROFILE))!
const currentRow = async () => (await repository.current(AMARA_PROFILE))!
const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

type Row = NonNullable<Awaited<ReturnType<FakeRoutinesRepository['latest']>>>
/** A step as the user sees it: with the bookkeeping (gotIt, fixedFrom, changedOn) taken off. */
const plain = (row: Row) => row.steps.map(({ gotIt: _gotIt, fixedFrom: _fixedFrom, changedOn: _changedOn, ...entry }) => entry)
const shapeOf = (row: Row) => row.steps.map(({ step, product, frequency }) => ({ step, product, frequency }))
const FIRST_SHAPE = [
  { step: 'cleanse', product: { kind: 'shelf', id: 'entry-a' }, frequency: 'am' },
  { step: 'treat', product: { kind: 'candidate', code: 'SERUM-1' }, frequency: 'pm' },
  { step: 'moisturise', product: { kind: 'candidate', code: 'MOIST-1' }, frequency: 'am-pm' },
  { step: 'protect', product: { kind: 'candidate', code: 'SPF-1' }, frequency: 'am' },
]

/** The first build, the way a verified account gets it. */
const firstBuild = async (): Promise<Row> => {
  expect(await build('first')).toBe('built')
  return currentRow()
}
/** The first build, then the user taps Start two days on: a routine after which only the broken steps change. Returns the version in force. */
const started = async (): Promise<Row> => {
  await firstBuild()
  setClock(2 * DAY)
  await start()
  return currentRow()
}

const spyOnConsole = () => (['log', 'debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))

beforeEach(() => {
  clock = T0
  catalogVersion = 42
  entryCount = 0
  verdictRevision = 1
  attempts = 0
  ids = 0
  announces = []
  reconciled = []
  world = newWorld()
  // Amara's shelf: a cleanser the rules keep, and a cream with a steroid in it, which the rules stop (with the steroid step-down).
  addProduct('entry-a', CLEAN, { name: 'Calm Cleanser' })
  addProduct('entry-b', STEROID, { name: 'Karo Glow Cream' })

  repository = new FakeRoutinesRepository()
  outcomeCounts = new FakeOutcomeCountsRepository()
  jobs = new MemoryJobQueue()
  writer = new HookedWriter()
  script()
  deps = {
    verdicts: {
      savedFor: async () => (world.saved ? structuredClone(world.saved) : null),
    } satisfies Pick<VerdictService, 'savedFor'>,
    recommendations: {
      candidatesFor: async ({ step, country }: { step: RoutineStep; country?: string }) => {
        world.actors.push(currentActor())
        requireUser()
        if (world.goal === null) throw new ConflictError('GOAL_REQUIRED', 'Pick a goal first')
        if (world.safety.view === null) throw new ConflictError('SAFETY_ANSWERS_REQUIRED', 'Answer the safety questions first')
        if (world.shopping === null) throw new ConflictError('SHOPPING_REQUIRED', 'Say which country you shop in first')
        return structuredClone(world.candidates[(country ?? world.shopping.country) as NG_OR_GH]?.[step] ?? [])
      },
      shoppingFor: async () => {
        if (world.shopping === null) throw new ConflictError('SHOPPING_REQUIRED', 'Say which country you shop in first')
        return { ...world.shopping, updatedAt: T0 }
      },
    } satisfies Pick<RecommendationService, 'candidatesFor' | 'shoppingFor'>,
    goals: { goalFor: async () => world.goal } satisfies Pick<GoalsService, 'goalFor'>,
    safety: { snapshotFor: async () => structuredClone(world.safety) } satisfies Pick<SafetyService, 'snapshotFor'>,
    shelf: {
      activeEntriesFor: async () => structuredClone(world.entries),
      add: async (productId: string, clientIp: string) => {
        world.actors.push(currentActor())
        requireUser()
        world.shelfAdds.push({ productId, clientIp })
        await world.duringAdd?.()
        return { status: 'started' as const, scanId: 'scan-1', itemId: 'item-1' }
      },
    } satisfies Pick<ShelfService, 'activeEntriesFor' | 'add'>,
    catalog: {
      shelfFacts: async (formulationIds: string[]) => new Map(formulationIds.flatMap((id): [string, ShelfFacts][] => (world.facts.has(id) ? [[id, structuredClone(world.facts.get(id)!)]] : []))),
    } satisfies Pick<ProductCatalogService, 'shelfFacts'>,
    faceScans: { seenFor: async () => structuredClone(world.seen) } satisfies Pick<FaceScanService, 'seenFor'>,
    workbook: {
      countries: async () => structuredClone(world.countries),
      // Where the catalog version a routine records comes from.
      verdictReference: async () => ({ rulesVersion: 'verdict-rules-7', catalogVersion, rules: [], claimPhrases: [], claimWords: [], tapers: { steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' } }),
    } satisfies Pick<CatalogWorkbookService, 'countries' | 'verdictReference'>,
    profiles: {
      find: async (profileId: string) => {
        const userId = world.profiles.get(profileId)
        return userId === undefined ? null : { id: profileId, userId, ownerStatus: world.guests.has(userId) ? ('anonymous' as const) : ('verified' as const) }
      },
    } satisfies Pick<ProfilesService, 'find'>,
    reminders: { zoneFor: async () => world.zone } satisfies Pick<RemindersService, 'zoneFor'>,
    writer,
    writerIdentity: { model: 'claude-test-model', promptHash: 'prompt-hash-test' },
    repository,
    outcomeCounts,
    jobs,
    enabled: true,
    announce: async (profileId: string) => void announces.push(profileId),
    skinCare: {
      reconcile: async (profileId: string) => void reconciled.push({ profileId, versionId: (await repository.current(profileId))?.id ?? null }),
    } satisfies Pick<SkinCareService, 'reconcile'>,
    now: () => clock,
    newId: () => `version-${++ids}`,
  }
  service = new RoutineService(deps)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RoutineService.build: when there is nothing to build from yet', () => {
  it.each([
    ['the saved verdict is not available (outdated, or its build is still queued)', () => (world.saved = null)],
    ['the saved verdict is there but its fit is not ready', () => (world.saved = { ...world.saved!, fit: 'not-ready' })],
    ['the profile has no goal', () => (world.goal = null)],
    ['the profile has not answered the safety question', () => (world.safety = { view: null, parseState: null, mentions: [] })],
    ['the profile has not said where it shops', () => (world.shopping = null)],
  ])('answers waiting, appending nothing and not calling the writer, when %s', async (_why, change) => {
    change()

    expect(await build('first')).toBe('waiting')

    expect(await repository.latest(AMARA_PROFILE)).toBeNull()
    expect(writer.calls).toEqual([])
    expect(attempts).toBe(0)
  })

  it('leaves the routine already in force as it was when the verdict has gone out of date', async () => {
    const first = await firstBuild()
    world.saved = null

    expect(await build('verdict')).toBe('waiting')

    expect(await repository.latest(AMARA_PROFILE)).toEqual(first)
  })
})

describe('RoutineService.build: the first build', () => {
  it('writes the routine with the writer and saves it ready, each step the skeleton allows: a kept shelf product, and the cheapest candidate for each gap', async () => {
    expect(await build('first')).toBe('built')

    const row = await latestRow()
    expect(row.status).toBe('ready')
    expect(shapeOf(row)).toEqual(FIRST_SHAPE)
    expect(row.steps.map((s) => s.reason)).toEqual(['Written 1: cleanse.', 'Written 1: treat.', 'Written 1: moisturise.', 'Written 1: protect.'])
    expect(row.steps.every((s) => !s.gotIt && s.fixedFrom === null && s.grounding.length === 0)).toBe(true)
    expect(row.expectation).toBe('Written 1: expect results in 8 to 12 weeks.')
    // The step-down is set in code from the stopped product, naming the verdict's own template, and not started.
    expect(row.tapers).toEqual([{ shelfProductId: 'entry-b', templateId: 'TPR-STEROID-1', startedOn: null }])
    expect(await repository.current(AMARA_PROFILE)).toEqual(row)
  })

  it('gives the writer the skeleton the rules made: the goal, the person, the shelf with the verdict\'s decisions, and every gap with its candidates', async () => {
    await build('first')

    expect(writer.calls).toHaveLength(1)
    expect(writer.retries).toEqual([undefined])
    expect(writer.calls[0]).toMatchObject({
      goal: 'fade-dark-marks',
      steps: ['cleanse', 'treat', 'moisturise', 'protect'],
      person: {
        seen: [{ concern: 'hd_age_spot', level: 'some' }],
        alsoNoticed: [{ concern: 'hd_radiance', level: 'faint' }],
        skinType: 'combination',
        cautions: ['tapering', 'recent-reaction'],
        budgetBand: 'mid',
      },
      shelf: [
        { id: 'entry-a', brand: 'Orbis', name: 'Calm Cleanser', ingredients: CLEAN, step: 'cleanse', verdict: { kind: 'keep' }, sourceUrls: [] },
        { id: 'entry-b', brand: 'Orbis', name: 'Karo Glow Cream', ingredients: STEROID, step: 'treat', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, sourceUrls: [STEROID_SOURCE] },
      ],
      limits: { maxNewProducts: 3 },
      // 'version-1' is among the nine tenths of routine ids that show hints (routines.outcomes.ts hintsShown), with or without counts to show.
      hintsShown: true,
    })
    const gaps = writer.calls[0]!.gaps.map((gap) => [gap.step, gap.candidates.map((c) => c.code)])
    expect(gaps).toEqual([
      ['treat', ['SERUM-1', 'SERUM-2']],
      ['moisturise', ['MOIST-1']],
      ['protect', ['SPF-1']],
    ])
  })

  it('names a shelf entry with no label with the verdict\'s own "no label" words, no brand and no ingredients, and leaves out an entry whose product cannot be found', async () => {
    world.entries.push({ id: 'entry-n', kind: 'no-label', addedAt: at(10 * MINUTE), itemId: 'item-n' })
    addProduct('entry-lost', CLEAN)
    world.facts.delete('form-entry-lost')
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-n', { kind: 'drop' }, null), verdictProduct('entry-lost', { kind: 'keep' }, 'moisturise')])

    await build('first')

    const shelf = writer.calls[0]!.shelf
    // The words are hashed into the verdict's fingerprint, so they are pinned here as literals: rewording them would re-bill every shelf with a no-label item.
    expect(shelf.find((p) => p.id === 'entry-n')).toMatchObject({ brand: null, name: 'A product with no label', ingredients: [], verdict: { kind: 'drop' } })
    expect(shelf.map((p) => p.id)).toEqual(['entry-a', 'entry-b', 'entry-n'])
  })

  it('reads everything that needs a session as the profile\'s own verified user, whoever runs the build', async () => {
    await build('first')

    expect(world.actors.length).toBeGreaterThan(0)
    for (const actor of world.actors) expect(actor).toEqual(AMARA_ACTOR)
  })

  it('has the version pending while the writer works, filled in to the very same version when it is done', async () => {
    let during: Row | null = null
    let viewDuring: unknown
    writer.hook = async () => {
      during = await repository.latest(AMARA_PROFILE)
      viewDuring = await current()
    }

    await build('first')

    expect(during).toMatchObject({ status: 'pending', id: 'version-1', reason: 'first', steps: [], tapers: [], expectation: null, source: null, shelfCounts: null, notInRoutine: null, verdictFingerprint: 'verdict-fp-1' })
    expect(viewDuring).toEqual({ status: 'pending' })
    expect((await latestRow()).id).toBe('version-1')
    expect(ids).toBe(1)
  })

  it('records what the version was built from: the writer, the rules and catalog it ran under, the fingerprints, the cautions and why', async () => {
    setClock(5 * MINUTE)
    await build('shelf')

    const row = await latestRow()
    expect(row).toMatchObject({
      id: 'version-1',
      profileId: AMARA_PROFILE,
      status: 'ready',
      createdAt: at(5 * MINUTE),
      source: 'writer',
      model: 'claude-test-model',
      promptHash: 'prompt-hash-test',
      catalogVersion: 42,
      rulesVersion: ROUTINE_RULES_VERSION,
      hintsShown: true,
      verdictFingerprint: 'verdict-fp-1',
      cautions: ['tapering', 'recent-reaction'],
      reason: 'shelf',
      writerCalls: 1,
      writerRetryDueAt: null,
      startedOn: null,
      servedAt: null,
    })
    // What the routine's own freshness is judged by: the goal, the cautions, each verdict product's decision and the rules version, as the spec lists them.
    expect(row.routineFingerprint).toBe(
      await routineFingerprint({
        goal: 'fade-dark-marks',
        cautions: ['tapering', 'recent-reaction'],
        products: [
          { entryId: 'entry-a', verdict: { kind: 'keep' }, step: 'cleanse' },
          { entryId: 'entry-b', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, step: 'treat' },
        ],
        rulesVersion: ROUTINE_RULES_VERSION,
      }),
    )
  })

  it('gives the same fingerprint to a routine built again from the same inputs, and another when the goal differs', async () => {
    await build('first')
    const first = (await latestRow()).routineFingerprint
    setClock(MINUTE)
    await build('first')
    const again = (await latestRow()).routineFingerprint
    world.goal = 'glow'
    setClock(2 * MINUTE)
    await build('goal')
    const otherGoal = (await latestRow()).routineFingerprint

    expect(again).toBe(first)
    expect(otherGoal).not.toBe(first)
    expect(otherGoal).toMatch(/^[0-9a-f]{64}$/)
  })

  it('writes a whole new routine, not a patched one, when the shelf changes before the routine is started', async () => {
    await firstBuild()
    removeShelfProduct('entry-a')
    setClock(MINUTE)

    expect(await build('shelf')).toBe('built')

    const row = await latestRow()
    expect(row.id).toBe('version-2')
    expect(row.steps.map((s) => s.reason)).toEqual(['Written 2: cleanse.', 'Written 2: treat.', 'Written 2: moisturise.', 'Written 2: protect.'])
    expect(row.steps.every((s) => s.fixedFrom === null)).toBe(true)
    expect(writer.calls[1]!.gaps.map((gap) => [gap.step, gap.candidates.length])).toEqual([
      ['cleanse', 2],
      ['treat', 2],
      ['moisturise', 1],
      ['protect', 1],
    ])
  })
})

describe('RoutineService.build: how the shelf was sorted (the plan summary counts)', () => {
  // Amara's shelf is a cleanser the rules keep and a steroid cream they stop: one of each.
  const FIRST_COUNTS = { keep: 1, reduce: 0, drop: 0, stop: 1 }

  /** More products on the shelf, each with the verdict the rules gave it. */
  const shelve = (...products: [id: string, verdict: ShelfVerdict, step: RoutineStep | null][]) => {
    for (const [id] of products) addProduct(id, CLEAN)
    saveVerdict([...productsOfVerdict(), ...products.map(([id, verdict, step]) => verdictProduct(id, verdict, step))])
  }

  it('records one count for each product of the shelf the routine was built from: the cleanser kept and the steroid cream stopped', async () => {
    await build('first')

    expect((await latestRow()).shelfCounts).toEqual(FIRST_COUNTS)
  })

  it('puts every product in exactly one count: kept, reduced, dropped and stopped products each in their own', async () => {
    shelve(
      ['entry-c', { kind: 'reduce', maxFrequency: 'alternate-days' }, 'moisturise'],
      ['entry-d', { kind: 'drop' }, null],
      ['entry-e', { kind: 'drop' }, 'treat'],
      ['entry-f', { kind: 'keep' }, null],
    )

    await build('first')

    // entry-a and entry-f kept; entry-c reduced; entry-d and entry-e dropped; entry-b stopped.
    expect((await latestRow()).shelfCounts).toEqual({ keep: 2, reduce: 1, drop: 2, stop: 1 })
  })

  it('counts a product kept for a step and one kept for none (a spare) alike as kept', async () => {
    shelve(['entry-g', { kind: 'keep' }, null])

    await build('first')

    expect((await latestRow()).shelfCounts).toEqual({ ...FIRST_COUNTS, keep: 2 })
  })

  it('counts a reduced sunscreen as kept, the way the routine keeps it: sun protection is never used less', async () => {
    shelve(['entry-spf', { kind: 'reduce', maxFrequency: 'alternate-days' }, 'protect'])

    await build('first')

    expect((await latestRow()).shelfCounts).toEqual({ keep: 2, reduce: 0, drop: 0, stop: 1 })
    expect(shapeOf(await latestRow()).find((s) => s.step === 'protect')).toMatchObject({ product: { kind: 'shelf', id: 'entry-spf' } })
  })

  it('counts a reduced product that is not a sunscreen as reduced, not kept', async () => {
    shelve(['entry-m', { kind: 'reduce', maxFrequency: 'alternate-days' }, 'moisturise'])

    await build('first')

    expect((await latestRow()).shelfCounts).toEqual({ ...FIRST_COUNTS, reduce: 1 })
  })

  it('counts nothing for a verdict entry whose product is no longer on the shelf: the build leaves it out', async () => {
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-ghost', { kind: 'drop' }, null)])

    await build('first')

    expect((await latestRow()).shelfCounts).toEqual(FIRST_COUNTS)
  })

  it('counts a shelf entry with no label from the verdict like any other', async () => {
    world.entries.push({ id: 'entry-nl', kind: 'no-label', addedAt: at(10 * MINUTE), itemId: 'item-nl' })
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-nl', { kind: 'drop' }, null)])

    await build('first')

    expect((await latestRow()).shelfCounts).toEqual({ ...FIRST_COUNTS, drop: 1 })
  })

  it('records an empty shelf as four zeros, not as no counts', async () => {
    world.entries = []
    saveVerdict([])

    await build('first')

    expect((await latestRow()).shelfCounts).toEqual({ keep: 0, reduce: 0, drop: 0, stop: 0 })
  })

  it('records the same counts when the rules wrote the routine because the writer failed three times', async () => {
    script(throws(), throws(), throws())

    await build('first')

    expect(await latestRow()).toMatchObject({ source: 'rules', shelfCounts: FIRST_COUNTS })
  })

  it('records the same counts when the rules wrote the routine because the day\'s writer limit was spent', async () => {
    for (let i = 0; i < 5; i++) {
      setClock(i * MINUTE)
      await build('shelf')
    }
    setClock(10 * MINUTE)

    await build('shelf')

    expect(await latestRow()).toMatchObject({ source: 'rules', writerCalls: 0, shelfCounts: FIRST_COUNTS })
  })

  it('counts the shelf as it is when the build is made, not as an earlier version had it, while the routine is not started yet', async () => {
    await build('first')
    shelve(['entry-d', { kind: 'drop' }, null])
    setClock(HOUR)

    await build('shelf')

    expect((await latestRow()).shelfCounts).toEqual({ ...FIRST_COUNTS, drop: 1 })
  })

  it('recounts the shelf in a rebuild after Start that changes the routine: a second product stopped', async () => {
    await started()
    addProduct('entry-c', STEROID, { name: 'Second Cream' })
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-c', { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, null, { sourceUrls: [STEROID_SOURCE] })])
    setClock(3 * DAY + HOUR)

    expect(await build('verdict')).toBe('built')

    expect((await currentRow()).shelfCounts).toEqual({ keep: 1, reduce: 0, drop: 0, stop: 2 })
  })

  it('recounts the shelf in a rebuild after Start that refills a broken step: the cleanser gone leaves one product stopped and none kept', async () => {
    await started()
    removeShelfProduct('entry-a')
    setClock(2 * DAY + HOUR)

    expect(await build('shelf')).toBe('built')

    expect((await currentRow()).shelfCounts).toEqual({ keep: 0, reduce: 0, drop: 0, stop: 1 })
  })

  it('recounts it too in a rebuild after Start that only keeps the routine under new cautions: the version is counted from the shelf it was built from, not copied', async () => {
    await started()
    addProduct('entry-c', CLEAN, { name: 'Spare Toner' })
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-c', { kind: 'keep' }, null)])
    world.safety = { ...world.safety, view: safetyView(['reaction', 'pregnant']) }
    setClock(3 * DAY)

    expect(await build('safety')).toBe('built')

    expect((await currentRow()).shelfCounts).toEqual({ keep: 2, reduce: 0, drop: 0, stop: 1 })
  })

  it('is carried unchanged into the copy that "I got it" appends, and by a rebuild that finds nothing to change (no new version)', async () => {
    const before = await started()
    expect(before.shelfCounts).toEqual(FIRST_COUNTS)

    reverdict()
    setClock(2 * DAY + HOUR)
    expect(await build('verdict')).toBe('unchanged')
    expect((await currentRow()).shelfCounts).toEqual(FIRST_COUNTS)

    await gotIt('treat')

    expect(await currentRow()).toMatchObject({ reason: 'got-it', shelfCounts: FIRST_COUNTS })
  })

  it('is carried into the got-it copy as the version had it, even when the shelf has changed since (the copy is not a rebuild)', async () => {
    await started()
    shelve(['entry-d', { kind: 'drop' }, null])

    await gotIt('treat')

    expect(await currentRow()).toMatchObject({ reason: 'got-it', shelfCounts: FIRST_COUNTS })
  })
})

describe('RoutineService.build: what is left out of the routine (the "Not in your routine" list)', () => {
  // Amara's shelf: a cleanser the rules keep, and a steroid cream (a cream, treat step) they stop. The default reason of a verdict product is 'A test reason.'.
  const STEROID_REASON = 'It has a steroid in it, so we stop it slowly.'
  const STOPPED = { entryId: 'entry-b', title: 'Cream', status: 'stepping-down' as const, reason: 'A test reason.' }

  /** More products on the shelf, each with the verdict the rules gave it and the reason the verdict screen shows. */
  const shelve = (...products: [id: string, verdict: ShelfVerdict, step: RoutineStep | null, reason: string, facts?: Partial<ShelfFacts>][]) => {
    for (const [id, , , , facts] of products) addProduct(id, CLEAN, facts)
    saveVerdict([...productsOfVerdict(), ...products.map(([id, verdict, step, reason]) => verdictProduct(id, verdict, step, { reason }))])
  }
  /** The verdict saved again, the reason of one product changed. */
  const rewordVerdict = (entryId: string, reason: string) => saveVerdict(productsOfVerdict().map((p) => (p.entryId === entryId ? { ...p, reason } : p)))
  const listOf = async () => (await latestRow()).notInRoutine

  it('records the steroid cream, which the rules stop, as stepping down with the verdict\'s own reason and a plain title, and leaves the kept cleanser out', async () => {
    await build('first')

    expect(await listOf()).toEqual([STOPPED])
  })

  it('takes each reason from the verdict item of that product, not from the routine\'s words', async () => {
    saveVerdict(productsOfVerdict().map((p) => (p.entryId === 'entry-b' ? { ...p, reason: STEROID_REASON } : p)))

    await build('first')

    expect(await listOf()).toEqual([{ ...STOPPED, reason: STEROID_REASON }])
    expect((await latestRow()).steps.map((s) => s.reason).join(' ')).not.toContain(STEROID_REASON)
  })

  it('lists a stopped product as stepping-down and a dropped one as left-out, titled by form and step, in the order of the shelf and not of the verdict', async () => {
    shelve(
      ['entry-c', { kind: 'drop' }, 'cleanse', 'It does the same job as your cleanser.', { form: 'gel' }],
      ['entry-d', { kind: 'drop' }, null, 'It holds back the goal you chose.', { form: 'serum' }],
    )
    // The verdict names them in the opposite order to the shelf.
    saveVerdict([...productsOfVerdict()].reverse())

    await build('first')

    expect(await listOf()).toEqual([
      STOPPED,
      { entryId: 'entry-c', title: 'Gel cleanser', status: 'left-out', reason: 'It does the same job as your cleanser.' },
      { entryId: 'entry-d', title: 'Serum', status: 'left-out', reason: 'It holds back the goal you chose.' },
    ])
  })

  it('lists a dropped product that fills no step, and titles one with no label by its step', async () => {
    world.entries.push({ id: 'entry-nl', kind: 'no-label', addedAt: at(10 * MINUTE), itemId: 'item-nl' })
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-nl', { kind: 'drop' }, 'treat', { reason: 'We could not tell what is in it.' })])

    await build('first')

    expect(await listOf()).toEqual([STOPPED, { entryId: 'entry-nl', title: 'Treatment', status: 'left-out', reason: 'We could not tell what is in it.' }])
  })

  it('keeps reduced products out of the list (they stay in the routine), a reduced sunscreen too, and kept spares', async () => {
    shelve(
      ['entry-m', { kind: 'reduce', maxFrequency: 'alternate-days' }, 'moisturise', 'Better used less often.'],
      ['entry-spf', { kind: 'reduce', maxFrequency: 'alternate-days' }, 'protect', 'Better used less often.'],
      ['entry-k', { kind: 'keep' }, null, 'It suits you.'],
    )

    await build('first')

    expect(await listOf()).toEqual([STOPPED])
  })

  it('leaves out a verdict entry whose product is no longer on the shelf, and one whose product cannot be found: the routine was not built from them', async () => {
    addProduct('entry-lost', CLEAN)
    world.facts.delete('form-entry-lost')
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-lost', { kind: 'drop' }, null), verdictProduct('entry-ghost', { kind: 'drop' }, null)])

    await build('first')

    expect(await listOf()).toEqual([STOPPED])
  })

  it('records an empty list, not null, when nothing was left out', async () => {
    world.entries = []
    saveVerdict([])

    await build('first')

    expect(await listOf()).toEqual([])
  })

  it('has none recorded (null) while the version is pending, and the very version it is filled in to has the list', async () => {
    let during: Row | null = null
    writer.hook = async () => {
      during = await repository.latest(AMARA_PROFILE)
    }

    await build('first')

    expect(during).toMatchObject({ status: 'pending', notInRoutine: null })
    expect(await listOf()).toEqual([STOPPED])
  })

  it('records the same list when the rules wrote the routine because the writer failed three times', async () => {
    script(throws(), throws(), throws())

    await build('first')

    expect(await latestRow()).toMatchObject({ source: 'rules', notInRoutine: [STOPPED] })
  })

  it('records the same list when the rules wrote the routine because the day\'s writer limit was spent', async () => {
    for (let i = 0; i < 5; i++) {
      setClock(i * MINUTE)
      await build('shelf')
    }
    setClock(10 * MINUTE)

    await build('shelf')

    expect(await latestRow()).toMatchObject({ source: 'rules', writerCalls: 0, notInRoutine: [STOPPED] })
  })

  it('lists the shelf as it is when the build is made, with the verdict\'s words of that time, while the routine is not started yet', async () => {
    await build('first')
    shelve(['entry-d', { kind: 'drop' }, null, 'It holds back the goal you chose.'])
    rewordVerdict('entry-b', STEROID_REASON)
    setClock(HOUR)

    await build('shelf')

    expect(await listOf()).toEqual([{ ...STOPPED, reason: STEROID_REASON }, { entryId: 'entry-d', title: 'Cream', status: 'left-out', reason: 'It holds back the goal you chose.' }])
  })

  it('lists it again in a rebuild after Start that changes the routine: the cleanser gone, and what the verdict now says about the cream', async () => {
    await started()
    removeShelfProduct('entry-a')
    rewordVerdict('entry-b', STEROID_REASON)
    setClock(2 * DAY + HOUR)

    expect(await build('shelf')).toBe('built')

    expect((await currentRow()).notInRoutine).toEqual([{ ...STOPPED, reason: STEROID_REASON }])
  })

  it('lists it again in a rebuild after Start that only keeps the routine under new cautions: it is written from the shelf it was built from, not copied', async () => {
    await started()
    shelve(['entry-c', { kind: 'drop' }, null, 'It holds back the goal you chose.'])
    world.safety = { ...world.safety, view: safetyView(['reaction', 'pregnant']) }
    setClock(3 * DAY)

    expect(await build('safety')).toBe('built')

    expect((await currentRow()).notInRoutine).toEqual([STOPPED, { entryId: 'entry-c', title: 'Cream', status: 'left-out', reason: 'It holds back the goal you chose.' }])
  })

  it('keeps the words of the build when the verdict is reworded and nothing else moved: the rebuild finds nothing to change and writes nothing', async () => {
    const before = await started()
    rewordVerdict('entry-b', STEROID_REASON)
    const setList = vi.spyOn(repository, 'setNotInRoutine')
    setClock(2 * DAY + HOUR)

    expect(await build('verdict')).toBe('unchanged')

    expect(setList).not.toHaveBeenCalled()
    expect(await currentRow()).toEqual(before)
    expect((await currentRow()).notInRoutine).toEqual([STOPPED])
  })

  it('refreshes the list with the counts on a rebuild that finds nothing to change but whose inputs moved: the shelf as it sorts now, in the verdict\'s words now', async () => {
    const before = await started()
    shelve(['entry-c', { kind: 'drop' }, null, 'It holds back the goal you chose.'])
    rewordVerdict('entry-b', STEROID_REASON)
    setClock(3 * DAY)

    expect(await build('verdict')).toBe('unchanged')

    const now = await currentRow()
    expect(now.id).toBe(before.id)
    expect(now.notInRoutine).toEqual([{ ...STOPPED, reason: STEROID_REASON }, { entryId: 'entry-c', title: 'Cream', status: 'left-out', reason: 'It holds back the goal you chose.' }])
    expect(now.shelfCounts).toEqual({ keep: 1, reduce: 0, drop: 1, stop: 1 })
  })

  it('gives a routine built before the column its list on an unchanged rebuild, though its counts and fingerprint are the build\'s already', async () => {
    const before = await started()
    await repository.append({ ...structuredClone(before), id: 'version-old', notInRoutine: null, createdAt: at(3 * DAY), readyAt: at(3 * DAY) })
    expect((await currentRow()).notInRoutine).toBeNull()
    const setFingerprint = vi.spyOn(repository, 'setRoutineFingerprint')
    setClock(4 * DAY)

    expect(await build('verdict')).toBe('unchanged')

    expect(await currentRow()).toMatchObject({ id: 'version-old', notInRoutine: [STOPPED], routineFingerprint: before.routineFingerprint })
    expect(setFingerprint).not.toHaveBeenCalled()
  })

  it('writes the list before the fingerprint, so a failure between them leaves the fingerprint unrecorded and the next attempt records both', async () => {
    const before = await started()
    shelve(['entry-c', { kind: 'drop' }, null, 'It holds back the goal you chose.'])
    setClock(3 * DAY)
    vi.spyOn(repository, 'setNotInRoutine').mockRejectedValueOnce(new Error('d1 down'))

    await expect(build('verdict')).rejects.toThrow('d1 down')

    expect((await currentRow()).routineFingerprint).toBe(before.routineFingerprint)

    expect(await build('verdict')).toBe('unchanged')

    expect((await currentRow()).notInRoutine).toHaveLength(2)
    expect((await currentRow()).routineFingerprint).not.toBe(before.routineFingerprint)
  })

  it('writes no list when the fingerprint is already the build\'s and the version has one', async () => {
    const before = await started()
    const setList = vi.spyOn(repository, 'setNotInRoutine')

    expect(await build('verdict')).toBe('unchanged')

    expect(setList).not.toHaveBeenCalled()
    expect(await currentRow()).toEqual(before)
  })

  it('is carried unchanged into the copy that "I got it" appends, even when the shelf and the verdict\'s words have changed since (the copy is not a rebuild)', async () => {
    const before = await started()
    expect(before.notInRoutine).toEqual([STOPPED])
    shelve(['entry-d', { kind: 'drop' }, null, 'It holds back the goal you chose.'])
    rewordVerdict('entry-b', STEROID_REASON)

    await gotIt('treat')

    expect(await currentRow()).toMatchObject({ reason: 'got-it', notInRoutine: [STOPPED] })
  })

  it('carries null into the copy of a routine built before the column: the copy does not invent a list', async () => {
    const before = await started()
    await repository.append({ ...structuredClone(before), id: 'version-old', notInRoutine: null, createdAt: at(3 * DAY), readyAt: at(3 * DAY) })

    setClock(3 * DAY + HOUR)
    await gotIt('treat')

    expect(await currentRow()).toMatchObject({ reason: 'got-it', notInRoutine: null })
  })
})

describe('RoutineService.build: a writer that gets it wrong', () => {
  it('asks again, told the gates it failed, when its routine breaks one, and saves the second answer', async () => {
    script(breaksFrequency(good()), good())

    expect(await build('first')).toBe('built')

    expect(writer.calls).toHaveLength(2)
    expect(writer.retries).toEqual([undefined, FREQUENCY_AT_PROTECT])
    const row = await latestRow()
    expect(row).toMatchObject({ source: 'writer', writerCalls: 2, model: 'claude-test-model', promptHash: 'prompt-hash-test', writerRetryDueAt: null })
    expect(row.steps.map((s) => s.reason)).toEqual(['Written 2: cleanse.', 'Written 2: treat.', 'Written 2: moisturise.', 'Written 2: protect.'])
    expect(shapeOf(row)).toEqual(FIRST_SHAPE)
  })

  it('counts a writer error as a failed try, and tries again', async () => {
    script(throws(), good())

    expect(await build('first')).toBe('built')

    expect(attempts).toBe(2)
    expect(await latestRow()).toMatchObject({ source: 'writer', writerCalls: 2, model: 'claude-test-model' })
    expect((await latestRow()).steps[0]!.reason).toBe('Written 2: cleanse.')
  })

  it('falls back to the rules alone after three failed tries, each retry told the gates it failed, and marks the routine for the writer a day on', async () => {
    script(breaksFrequency(good()), breaksFrequency(good()), breaksFrequency(good()))
    setClock(10 * MINUTE)

    expect(await build('first')).toBe('built')

    expect(writer.retries).toEqual([undefined, FREQUENCY_AT_PROTECT, FREQUENCY_AT_PROTECT])
    const row = await latestRow()
    expect(row).toMatchObject({ status: 'ready', source: 'rules', model: 'claude-test-model', promptHash: 'prompt-hash-test', writerCalls: 3, writerRetryDueAt: at(10 * MINUTE + DAY), reason: 'first', hintsShown: false })
    // The rules' own routine: fixed words for each step, no grounding, and the same step-down.
    expect(row.steps).toEqual([
      { step: 'cleanse', product: { kind: 'shelf', id: 'entry-a' }, frequency: 'am', reason: 'Your cleanser, used as it is.', grounding: [], gotIt: false, fixedFrom: null, changedOn: null },
      { step: 'treat', product: { kind: 'candidate', code: 'SERUM-1' }, frequency: 'pm', reason: 'A treatment product, used at a gentle pace.', grounding: [], gotIt: false, fixedFrom: null, changedOn: null },
      { step: 'moisturise', product: { kind: 'candidate', code: 'MOIST-1' }, frequency: 'am-pm', reason: 'A simple moisturiser that keeps the skin soft and comfortable.', grounding: [], gotIt: false, fixedFrom: null, changedOn: null },
      { step: 'protect', product: { kind: 'candidate', code: 'SPF-1' }, frequency: 'am', reason: 'A daily sunscreen that protects the skin from the sun.', grounding: [], gotIt: false, fixedFrom: null, changedOn: null },
    ])
    expect(row.tapers).toEqual([{ shelfProductId: 'entry-b', templateId: 'TPR-STEROID-1', startedOn: null }])
    expect(row.expectation).not.toBe('')
    expect(row.expectation).not.toMatch(/^Written/)
    // It passes the same gates the writer's routine has to.
    const asRoutine: Routine = { steps: plain(row), tapers: row.tapers.map(({ shelfProductId, templateId }) => ({ shelfProductId, templateId })), expectation: row.expectation! }
    expect(checkRoutine(writer.calls[0]!, asRoutine)).toEqual([])
  })

  it('falls back to the rules after three writer errors too, never throwing to the caller', async () => {
    script(throws(), throws(), throws())

    expect(await build('first')).toBe('built')

    expect(attempts).toBe(3)
    expect(await latestRow()).toMatchObject({ source: 'rules', model: 'claude-test-model', promptHash: 'prompt-hash-test', writerCalls: 3, writerRetryDueAt: at(DAY) })
  })

  it('counts a build whose writer calls all failed toward the daily limit, because those calls were paid for', async () => {
    script(throws(), throws(), throws())
    await build('first')

    expect(await repository.writerBuildsSince(AMARA_PROFILE, at(-DAY))).toBe(1)
  })
})

describe('RoutineService.build: at most 5 writer builds a profile a day', () => {
  /** Five full builds before Start, a minute apart from T0, each with the writer. */
  const fiveWriterBuilds = async () => {
    for (let i = 0; i < 5; i++) {
      setClock(i * MINUTE)
      expect(await build('shelf')).toBe('built')
      expect((await latestRow()).source).toBe('writer')
    }
    expect(attempts).toBe(5)
  }

  it('uses the writer for the fifth build and the rules alone for the sixth, with no writer call and a retry due a day on', async () => {
    await fiveWriterBuilds()
    setClock(10 * MINUTE)

    expect(await build('shelf')).toBe('built')

    expect(attempts).toBe(5)
    expect(await latestRow()).toMatchObject({ source: 'rules', model: null, promptHash: null, writerCalls: 0, writerRetryDueAt: at(10 * MINUTE + DAY), reason: 'shelf' })
    expect((await latestRow()).steps.map((s) => s.reason)).toContain('Your cleanser, used as it is.')
  })

  it('counts the last 24 hours rolling: a build exactly 24 hours old still counts', async () => {
    await fiveWriterBuilds()
    // The first of the five was at T0; at T0 + 24h its age is exactly a day, and the cut-off is "a day ago or later".
    setClock(DAY)

    expect(await build('shelf')).toBe('built')

    expect(attempts).toBe(5)
    expect(await latestRow()).toMatchObject({ source: 'rules', writerCalls: 0 })
  })

  it('stops counting a build a millisecond older than 24 hours: the writer is used again', async () => {
    await fiveWriterBuilds()
    setClock(DAY + 1)

    expect(await build('shelf')).toBe('built')

    expect(attempts).toBe(6)
    expect(await latestRow()).toMatchObject({ source: 'writer', writerCalls: 1 })
  })

  it('still keeps a started routine current past the limit, by the rules alone: only the broken step is refilled and the writer is not called', async () => {
    await fiveWriterBuilds()
    setClock(10 * MINUTE)
    await start()
    const before = await currentRow()
    removeShelfProduct('entry-a')
    setClock(20 * MINUTE)

    expect(await build('shelf')).toBe('built')

    expect(attempts).toBe(5)
    const row = await latestRow()
    expect(row).toMatchObject({ source: 'rules', writerCalls: 0, model: null, promptHash: null, startedOn: before.startedOn })
    expect(row.steps[0]).toMatchObject({ step: 'cleanse', product: { kind: 'candidate', code: 'CLEANSER-1' }, reason: 'A gentle cleanser that cleans the skin without stripping it.' })
    expect(row.steps.slice(1)).toEqual(before.steps.slice(1).map((step) => ({ ...step, fixedFrom: before.id })))
  })
})

describe('RoutineService.build: after Start, only what broke changes', () => {
  it('refills only the step whose shelf product is gone, asking the writer about that step alone, and keeps every other step as it was', async () => {
    const before = await started()
    removeShelfProduct('entry-a')
    setClock(2 * DAY + HOUR)

    expect(await build('shelf')).toBe('built')

    // The writer was shown the cleanse gap whole, and each fixed step's gap narrowed to the one product it already has.
    expect(writer.calls).toHaveLength(2)
    expect(writer.calls[1]!.gaps.map((gap) => [gap.step, gap.candidates.map((c) => c.code)])).toEqual([
      ['cleanse', ['CLEANSER-1', 'CLEANSER-2']],
      ['treat', ['SERUM-1']],
      ['moisturise', ['MOIST-1']],
      ['protect', ['SPF-1']],
    ])
    const row = await latestRow()
    expect(row).toMatchObject({ id: 'version-2', status: 'ready', reason: 'shelf', source: 'writer', writerCalls: 1 })
    // Re-picked at 13:00 on the 17th, the day before day 1: stamped day 1, the first day the routine exists.
    expect(row.steps[0]).toEqual({ step: 'cleanse', product: { kind: 'candidate', code: 'CLEANSER-1' }, frequency: 'am', reason: 'Written 2: cleanse.', grounding: [], gotIt: false, fixedFrom: null, changedOn: DAY_ONE })
    // The fixed steps are the earlier ones whole (words included, not the writer's new words), marked as carried from the version they came from.
    expect(row.steps.slice(1)).toEqual(before.steps.slice(1).map((step) => ({ ...step, fixedFrom: before.id })))
    expect(row.steps.slice(1).map((s) => s.reason)).toEqual(['Written 1: treat.', 'Written 1: moisturise.', 'Written 1: protect.'])
  })

  it('carries the start date, the step-down under way with its date, and the expectation into the new version', async () => {
    const before = await started()
    expect(before.startedOn).not.toBeNull()
    removeShelfProduct('entry-a')
    setClock(2 * DAY + HOUR)

    await build('shelf')

    const row = await latestRow()
    expect(row.startedOn).toEqual(before.startedOn)
    expect(row.tapers).toEqual([{ shelfProductId: 'entry-b', templateId: 'TPR-STEROID-1', startedOn: before.startedOn }])
    expect(row.expectation).toBe('Written 1: expect results in 8 to 12 weeks.')
  })

  it('answers unchanged, appending nothing and not calling the writer, when nothing is broken: the verdict was saved again but decides the same', async () => {
    const before = await started()
    reverdict()
    setClock(2 * DAY + HOUR)

    expect(await build('verdict')).toBe('unchanged')

    expect(attempts).toBe(1)
    expect(await repository.latest(AMARA_PROFILE)).toEqual(before)
  })

  it('answers unchanged at the review point when every step is still allowed: the check-in confirms the routine and swaps nothing', async () => {
    const before = await started()
    setClock(2 * DAY + 6 * 7 * DAY)

    expect(await build('review-point')).toBe('unchanged')

    expect(attempts).toBe(1)
    expect(await repository.latest(AMARA_PROFILE)).toEqual(before)
  })

  it.each<Reason>(['review-point', 'catalog-retired'])('re-picks the step whose recommended product left the catalog, with reason %s, even though the routine\'s own inputs (the fingerprint) are the same', async (reason) => {
    const before = await started()
    retireSerum1()
    setClock(2 * DAY + HOUR)

    expect(await build(reason)).toBe('built')

    expect(writer.calls[1]!.gaps.map((gap) => [gap.step, gap.candidates.map((c) => c.code)])).toEqual([
      ['treat', ['SERUM-2']],
      ['moisturise', ['MOIST-1']],
      ['protect', ['SPF-1']],
    ])
    const row = await latestRow()
    expect(row.reason).toBe(reason)
    expect(row.routineFingerprint).toBe(before.routineFingerprint)
    expect(shapeOf(row)).toEqual([FIRST_SHAPE[0], { step: 'treat', product: { kind: 'candidate', code: 'SERUM-2' }, frequency: 'alternate-days' }, FIRST_SHAPE[2], FIRST_SHAPE[3]])
    expect(row.steps[0]).toEqual({ ...before.steps[0], fixedFrom: before.id })
  })

  it('re-picks one step when "find one sold here" excludes its product: the other candidate, and nothing else changes', async () => {
    const before = await started()
    setClock(2 * DAY + HOUR)

    expect(await build('sold-here', { exclude: { step: 'treat', code: 'SERUM-1' } })).toBe('built')

    // The excluded code is not among the choices the writer is given for that step.
    expect(writer.calls[1]!.gaps.find((gap) => gap.step === 'treat')!.candidates.map((c) => c.code)).toEqual(['SERUM-2'])
    const row = await latestRow()
    expect(row.reason).toBe('sold-here')
    expect(shapeOf(row)).toEqual([FIRST_SHAPE[0], { step: 'treat', product: { kind: 'candidate', code: 'SERUM-2' }, frequency: 'alternate-days' }, FIRST_SHAPE[2], FIRST_SHAPE[3]])
    expect([0, 2, 3].map((i) => row.steps[i])).toEqual([0, 2, 3].map((i) => ({ ...before.steps[i], fixedFrom: before.id })))
  })

  it('keeps a recommended product that is not sold in the new shopping country: the routine is not rebuilt for a country', async () => {
    const before = await started()
    world.shopping = { country: 'GH', budgetBand: 'mid' }
    reverdict()
    setClock(2 * DAY + HOUR)

    expect(await build('verdict')).toBe('unchanged')

    expect(attempts).toBe(1)
    expect(await repository.latest(AMARA_PROFILE)).toEqual(before)
  })

  it('still refills a step when its product is sold nowhere, in the new country or any other', async () => {
    await started()
    world.shopping = { country: 'GH', budgetBand: 'mid' }
    retireSerum1()
    setClock(2 * DAY + HOUR)

    expect(await build('catalog-retired')).toBe('built')

    const treat = (await latestRow()).steps.find((s) => s.step === 'treat')!
    expect(treat.product).toEqual({ kind: 'candidate', code: 'SERUM-GH' })
  })

  it('does not soften a step that is still allowed when a caution is added: the same frequency and words stay', async () => {
    const before = await started()
    world.safety = { ...world.safety, view: safetyView(['reaction', 'prescription']) }
    reverdict()
    setClock(2 * DAY + HOUR)

    await build('safety')

    expect(attempts).toBe(1)
    expect(plain(await currentRow())).toEqual(plain(before))
  })

  it('rewrites the expectation, and records the new goal, when the goal changed even though the build is asked for under another reason, keeping every step that still passes', async () => {
    const before = await started()
    expect(before.goal).toBe('fade-dark-marks')
    world.goal = 'glow'
    reverdict()
    setClock(2 * DAY + HOUR)

    expect(await build('verdict')).toBe('built')

    const row = await latestRow()
    expect(row).toMatchObject({ reason: 'verdict', goal: 'glow', source: 'writer', writerCalls: 1 })
    expect(row.expectation).toBe('Written 2: expect results in 8 to 12 weeks.')
    expect(plain(row)).toEqual(plain(before))
  })

  it('completes a version with no writer call when only the step-down changed, taking the new template, dated the day of the rebuild, and keeping the steps', async () => {
    const before = await started()
    saveVerdict(productsOfVerdict().map((p) => (p.entryId === 'entry-b' ? { ...p, verdict: { kind: 'stop' as const, taperTemplateId: 'TPR-STEROID-2' } } : p)))
    // Two days after day 1 (started() taps on 2030-06-17, so day 1 is the 18th): the rebuild's day is well past the start, and is what dates the new step-down.
    setClock(4 * DAY + HOUR)

    expect(await build('verdict')).toBe('built')

    expect(attempts).toBe(1)
    const row = await latestRow()
    expect(row).toMatchObject({ id: 'version-2', writerCalls: 0, reason: 'verdict', startedOn: before.startedOn })
    expect(row.tapers).toEqual([{ shelfProductId: 'entry-b', templateId: 'TPR-STEROID-2', startedOn: new Date('2030-06-19T00:00:00.000Z') }])
    expect(plain(row)).toEqual(plain(before))
    expect(row.expectation).toBe(before.expectation)
  })

  it('refills the step with the rules\' own pick when the writer fails three times, keeping the fixed steps the writer wrote', async () => {
    const before = await started()
    removeShelfProduct('entry-a')
    script(throws(), throws(), throws())
    setClock(2 * DAY + HOUR)

    expect(await build('shelf')).toBe('built')

    const row = await latestRow()
    expect(row).toMatchObject({ source: 'rules', model: 'claude-test-model', promptHash: 'prompt-hash-test', writerCalls: 3, writerRetryDueAt: at(3 * DAY + HOUR) })
    expect(row.steps[0]).toMatchObject({ step: 'cleanse', product: { kind: 'candidate', code: 'CLEANSER-1' }, frequency: 'am', reason: 'A gentle cleanser that cleans the skin without stripping it.' })
    expect(row.steps.slice(1)).toEqual(before.steps.slice(1).map((step) => ({ ...step, fixedFrom: before.id })))
  })

  it('switches a recommended product the user has got to their own shelf product when it joins the shelf, keeping its frequency and words, with no writer call', async () => {
    await started()
    await gotIt('treat')
    const gotItVersion = await currentRow()
    // The product the user got is on their shelf now (the typed scan finished) and the verdict keeps it for the treat step.
    addProduct('entry-s', ['Aqua', 'Niacinamide'], { productId: 'prod-SERUM-1', name: 'Name SERUM-1', brand: 'Brand SERUM-1' })
    world.entries = world.entries.map((entry) => (entry.id === 'entry-s' && entry.kind === 'product' ? { ...entry, productId: 'prod-SERUM-1' } : entry))
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-s', { kind: 'keep' }, 'treat')])
    setClock(2 * DAY + HOUR)

    expect(await build('verdict')).toBe('built')

    expect(attempts).toBe(1)
    const row = await latestRow()
    expect(row.writerCalls).toBe(0)
    expect(row.steps[1]).toMatchObject({ step: 'treat', product: { kind: 'shelf', id: 'entry-s' }, frequency: 'pm', reason: 'Written 1: treat.', gotIt: false })
    expect(row.steps.filter((_, i) => i !== 1).map(({ gotIt, fixedFrom, ...entry }) => entry)).toEqual(gotItVersion.steps.filter((_, i) => i !== 1).map(({ gotIt, fixedFrom, ...entry }) => entry))
  })
})

// Spec #233, PR 4b: pauses are kept or ended against every new routine version. After a version is written the service asks skin care to reconcile the profile (a Pick of
// SkinCareService, `skinCare: Pick<SkinCareService, 'reconcile'>`; skin care never imports routines). It happens after the version is stored, so reconcile reads the new routine,
// once per version written: the build that completes a pending version, the one that appends a ready version at once (the rules wrote it, or only the cautions changed), and
// "I got it". A build that appends nothing, or waits, has nothing new to reconcile.
describe('RoutineService: reconciling skin-care pauses against a new version', () => {
  it('reconciles the profile once the first build has completed its version, and only then', async () => {
    expect(await build('first')).toBe('built')

    expect(reconciled).toEqual([{ profileId: AMARA_PROFILE, versionId: (await currentRow()).id }])
  })

  it('reconciles after the rules alone append a version because the day\'s writer limit is spent', async () => {
    for (let i = 0; i < 5; i++) {
      setClock(i * MINUTE)
      await build('shelf')
    }
    reconciled = []
    setClock(10 * MINUTE)

    await build('shelf')

    expect(await latestRow()).toMatchObject({ source: 'rules', writerCalls: 0 })
    expect(reconciled).toEqual([{ profileId: AMARA_PROFILE, versionId: (await latestRow()).id }])
  })

  it('reconciles after a rebuild after Start that only keeps the routine under new cautions and appends it at once', async () => {
    await started()
    reconciled = []
    world.safety = { ...world.safety, view: safetyView(['reaction', 'pregnant']) }
    setClock(3 * DAY)

    expect(await build('safety')).toBe('built')

    expect(reconciled).toEqual([{ profileId: AMARA_PROFILE, versionId: (await currentRow()).id }])
    expect(attempts).toBe(1)
  })

  it('reconciles after a rebuild after Start that refills a broken step', async () => {
    await started()
    reconciled = []
    removeShelfProduct('entry-a')
    setClock(2 * DAY + HOUR)

    expect(await build('shelf')).toBe('built')

    expect(reconciled).toEqual([{ profileId: AMARA_PROFILE, versionId: (await currentRow()).id }])
  })

  it('reconciles after "I got it" has appended its version', async () => {
    await started()
    reconciled = []
    setClock(2 * DAY + HOUR)

    await gotIt('treat')

    expect(reconciled).toEqual([{ profileId: AMARA_PROFILE, versionId: (await currentRow()).id }])
    expect((await currentRow()).reason).toBe('got-it')
  })

  it('does not reconcile for "I got it" that changes nothing (the step is already marked)', async () => {
    await started()
    await gotIt('treat')
    reconciled = []

    await gotIt('treat')

    expect(reconciled).toEqual([])
  })

  it('does not reconcile when a build finds nothing to change and appends nothing', async () => {
    await started()
    reconciled = []
    reverdict()
    setClock(2 * DAY + HOUR)

    expect(await build('verdict')).toBe('unchanged')

    expect(reconciled).toEqual([])
  })

  it('does not reconcile when the build has to wait for the verdict', async () => {
    world.saved = null

    expect(await build('first')).toBe('waiting')

    expect(reconciled).toEqual([])
  })
})

describe('RoutineService.start', () => {
  it('is 409 ROUTINE_NOT_READY before there is a routine, and while the first one is only pending', async () => {
    expect(await errorOf(start())).toBeInstanceOf(ConflictError)
    expect(await errorOf(start())).toMatchObject({ code: 'ROUTINE_NOT_READY' })
    writer.hook = async () => {
      expect(await errorOf(start())).toMatchObject({ code: 'ROUTINE_NOT_READY' })
    }

    await build('first')

    expect((await currentRow()).startedOn).toBeNull()
  })

  it('makes tomorrow day 1, on the routine in force and its step-downs: the next UTC midnight, not the moment of the tap', async () => {
    await firstBuild()
    setClock(2 * DAY + 3 * HOUR)

    await start()

    const view = await current()
    expect(view.status).toBe('ready')
    const version = (view as { version: Row }).version
    // Tapped on 2030-06-17 at 15:00 UTC: day 1 is 2030-06-18 at 00:00 UTC.
    expect(version.startedOn).toEqual(new Date('2030-06-18T00:00:00.000Z'))
    expect(utcDay(version.startedOn!)).toBe(utcDay(at(3 * DAY)))
    expect(version.tapers).toHaveLength(1)
    expect(version.tapers[0]!.startedOn).toEqual(version.startedOn)
  })

  // Tomorrow is the next UTC calendar day, whatever the hour: the last millisecond of a day and the first of the next are one day apart in their answers.
  it.each([
    ['the last millisecond of a UTC day', 12 * HOUR - 1, '2030-06-16T00:00:00.000Z'],
    ['the first millisecond of the next UTC day', 12 * HOUR, '2030-06-17T00:00:00.000Z'],
  ])('dates day 1 from %s as the following UTC midnight', async (_when, offsetMs, day1) => {
    await firstBuild()
    setClock(offsetMs)

    await start()

    expect((await currentRow()).startedOn).toEqual(new Date(day1))
  })

  it('is idempotent: starting again on a later day moves nothing and appends no version', async () => {
    await firstBuild()
    setClock(2 * DAY)
    await start()
    const afterFirstStart = await currentRow()
    expect(afterFirstStart.startedOn).toEqual(new Date('2030-06-18T00:00:00.000Z'))
    setClock(5 * DAY)

    await expect(start()).resolves.toBeUndefined()

    expect(await repository.latest(AMARA_PROFILE)).toEqual(afterFirstStart)
    expect(ids).toBe(1)
  })

  it('is idempotent on the same day too: a second tap before day 1 has begun does not move day 1 nor date the step-downs again', async () => {
    await firstBuild()
    setClock(2 * DAY)
    await start()
    const afterFirstStart = await currentRow()
    setClock(2 * DAY + HOUR)

    await start()

    expect(await currentRow()).toEqual(afterFirstStart)
  })

  it('reaches a build that is under way, so the version it completes already has the start date', async () => {
    await firstBuild()
    removeShelfProduct('entry-a')
    setClock(DAY)
    writer.hook = async () => {
      await start()
    }

    await build('shelf')

    const row = await currentRow()
    expect(row.id).toBe('version-2')
    expect(row.startedOn).not.toBeNull()
    expect(utcDay(row.startedOn!)).toBe(utcDay(at(2 * DAY)))
  })
})

describe('RoutineService.start: a routine hidden by a safety change', () => {
  it('is 409 ROUTINE_NOT_READY, and the routine in force is not started, while a reported reaction or pregnancy hides it', async () => {
    const before = await firstBuild()
    world.safety = { ...world.safety, view: safetyView(['reaction', 'pregnant']) }
    expect(await current()).toEqual({ status: 'pending' })
    setClock(2 * DAY)

    const error = await errorOf(start())

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({ code: 'ROUTINE_NOT_READY' })
    expect((await currentRow()).startedOn).toBeNull()
    expect(await repository.latest(AMARA_PROFILE)).toEqual(before)
  })

  it('starts it once the build that stores the new cautions has replaced it', async () => {
    await firstBuild()
    world.safety = { ...world.safety, view: safetyView(['reaction', 'pregnant']) }
    reverdict()
    await build('safety')
    setClock(2 * DAY)

    await start()

    expect((await currentRow()).startedOn).not.toBeNull()
  })
})

describe('RoutineService.gotIt: a routine hidden by a safety change', () => {
  it('is 409 ROUTINE_NOT_READY, adding nothing to the shelf and appending no version, while a reported reaction or pregnancy hides it', async () => {
    const before = await started()
    world.safety = { ...world.safety, view: safetyView(['reaction', 'pregnant']) }
    expect(await current()).toEqual({ status: 'pending' })

    const error = await errorOf(gotIt('treat'))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({ code: 'ROUTINE_NOT_READY' })
    expect(world.shelfAdds).toEqual([])
    expect(await repository.latest(AMARA_PROFILE)).toEqual(before)
  })
})

describe('RoutineService.gotIt: tapping it again', () => {
  it('is idempotent: three taps leave one got-it version and one shelf add, and the later taps return without error', async () => {
    await started()
    await gotIt('treat')
    const afterFirst = await repository.latest(AMARA_PROFILE)
    setClock(2 * DAY + HOUR)

    await expect(gotIt('treat')).resolves.toBeUndefined()
    await expect(gotIt('treat')).resolves.toBeUndefined()

    expect(world.shelfAdds).toHaveLength(1)
    expect(await repository.latest(AMARA_PROFILE)).toEqual(afterFirst)
    expect(ids).toBe(2)
  })
})

describe('RoutineService.gotIt: "I got it"', () => {
  it('appends a ready version that is the routine in force with that step marked got, no writer call, and the product on the shelf', async () => {
    const before = await started()
    setClock(2 * DAY + HOUR)

    await gotIt('treat')

    const row = await currentRow()
    expect(row).toMatchObject({ id: 'version-2', status: 'ready', reason: 'got-it', writerCalls: 0, createdAt: at(2 * DAY + HOUR), startedOn: before.startedOn })
    expect(row.steps.map((s) => s.gotIt)).toEqual([false, true, false, false])
    expect(plain(row)).toEqual(plain(before))
    expect(row.tapers).toEqual(before.tapers)
    expect(row.expectation).toBe(before.expectation)
    expect(attempts).toBe(1)
    // The shelf module is asked by catalog product id (what its add takes), with the caller's address for its limits, as the user.
    expect(world.shelfAdds).toEqual([{ productId: 'prod-SERUM-1', clientIp: CLIENT_IP }])
    expect(world.actors.at(-1)).toEqual(AMARA_ACTOR)
  })

  it('does not count toward the daily limit of writer builds', async () => {
    await started()

    await gotIt('moisturise')

    expect(await repository.writerBuildsSince(AMARA_PROFILE, at(-DAY))).toBe(1)
  })

  it('is 409 STEP_NOT_RECOMMENDED for a step that holds the user\'s own product, appending nothing and adding nothing to the shelf', async () => {
    const before = await started()

    const error = await errorOf(gotIt('cleanse'))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({ code: 'STEP_NOT_RECOMMENDED' })
    expect(await repository.latest(AMARA_PROFILE)).toEqual(before)
    expect(world.shelfAdds).toEqual([])
  })

  it('is 409 STEP_NOT_RECOMMENDED for a step that says "use what you have"', async () => {
    world.candidates.NG.moisturise = []
    const before = await started()
    expect(before.steps[2]!.product).toEqual({ kind: 'none' })

    expect(await errorOf(gotIt('moisturise'))).toMatchObject({ code: 'STEP_NOT_RECOMMENDED' })

    expect(world.shelfAdds).toEqual([])
    expect(await repository.latest(AMARA_PROFILE)).toEqual(before)
  })
})

describe('RoutineService.current', () => {
  it('is pending before any routine is built', async () => {
    expect(await current()).toEqual({ status: 'pending' })
  })

  it('serves the routine in force as ready', async () => {
    const row = await firstBuild()

    const view = await current()

    expect(view).toMatchObject({ status: 'ready', version: { id: row.id, steps: row.steps, tapers: row.tapers, expectation: row.expectation, startedOn: null } })
  })

  it('serves the routine in force as updating, not a pending one, while a newer one is being built', async () => {
    const before = await started()
    removeShelfProduct('entry-a')
    let viewDuring: unknown
    writer.hook = async () => {
      viewDuring = await current()
    }
    setClock(2 * DAY + HOUR)

    await build('shelf')

    expect(viewDuring).toMatchObject({ status: 'updating', version: { id: before.id, steps: before.steps } })
    expect(await current()).toMatchObject({ status: 'ready', version: { id: 'version-2' } })
  })

  it('serves nothing but pending while the routine is being rebuilt after a safety change that the old routine does not reflect', async () => {
    await started()
    world.safety = { ...world.safety, view: safetyView(['reaction', 'pregnant']) }
    // The cleanser is gone too, so a step is broken and the writer has work: the build is then really under way.
    removeShelfProduct('entry-a')
    let viewDuring: unknown
    writer.hook = async () => {
      viewDuring = await current()
    }
    setClock(2 * DAY + HOUR)

    await build('safety')

    expect(viewDuring).toEqual({ status: 'pending' })
    expect((await current()).status).toBe('ready')
  })

  it('stops counting a pending version from a build that died: young enough it is still an update under way, old enough it is ignored and the routine in force is simply ready', async () => {
    const before = await started()
    removeShelfProduct('entry-a')
    vi.spyOn(repository, 'complete').mockRejectedValueOnce(new Error('the worker died'))
    setClock(2 * DAY + HOUR)
    await expect(build('shelf')).rejects.toThrow('the worker died')
    expect((await latestRow()).status).toBe('pending')

    setClock(2 * DAY + HOUR + 2 * MINUTE)
    expect(await current()).toMatchObject({ status: 'updating', version: { id: before.id } })

    setClock(2 * DAY + HOUR + 3 * HOUR)
    expect(await current()).toMatchObject({ status: 'ready', version: { id: before.id } })
  })

  it('builds again over a pending version left by a build that died, and serves the new one', async () => {
    await started()
    removeShelfProduct('entry-a')
    vi.spyOn(repository, 'complete').mockRejectedValueOnce(new Error('the worker died'))
    setClock(2 * DAY + HOUR)
    await expect(build('shelf')).rejects.toThrow('the worker died')

    setClock(2 * DAY + 5 * HOUR)
    expect(await build('shelf')).toBe('built')

    expect(await current()).toMatchObject({ status: 'ready', version: { id: 'version-3' } })
  })

  it('keeps the logs free of what the person said and of product names', async () => {
    const spies = spyOnConsole()
    script(throws(), throws(), throws())

    await build('first')

    const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call))).join('\n')
    expect(logged).not.toContain('Karo Glow Cream')
    expect(logged).not.toContain('Calm Cleanser')
  })
})

// ---- PR 3b: asking for a build, running it from the queue, and the dead letter ----

const PROFILE_REQUEST = { profileId: AMARA_PROFILE, reason: 'first', requestKey: 'routine-fp-1' } as const
// A claim that has stood this long is a build that died, whatever the exact cut-off is (the brief does not give one): a request this much later takes it over.
const LONG_AFTER = DAY

const request = (reason: Reason = 'first', requestKey = 'routine-fp-1') => service.request(AMARA_PROFILE, reason, requestKey)
const run = (body: BuildRoutineMessage) => runAs(SYSTEM, () => service.run(body))
const markBuildFailed = (body: BuildRoutineMessage) => runAs(SYSTEM, () => service.markBuildFailed(body))
const queued = () => jobs.enqueued
/** The message `request` queued first, as the queue would hand it to `run`. */
const queuedBody = () => jobs.enqueued[0]!.body as BuildRoutineMessage
const bodyOf = (over: Partial<BuildRoutineMessage> = {}): BuildRoutineMessage => ({ ...PROFILE_REQUEST, requestedAt: T0.getTime(), waits: 0, ...over })
const requestRow = () => repository.findRequest(AMARA_PROFILE)
const loggedText = (spies: ReturnType<typeof spyOnConsole>) => spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call))).join('\n')

describe('RoutineService.request', () => {
  it('queues one build-routine message for the profile, with the reason, the key and the time it was asked, and no delay', async () => {
    await request('verdict', 'routine-fp-9')

    expect(queued()).toEqual([
      { job: 'build-routine', body: { profileId: AMARA_PROFILE, reason: 'verdict', requestKey: 'routine-fp-9', requestedAt: T0.getTime(), waits: 0 } },
    ])
  })

  it('queues nothing a second time for the same key while the first request is still being worked on', async () => {
    await request()
    setClock(MINUTE)
    await request()

    expect(queued()).toHaveLength(1)
  })

  it('takes over a request that has stood so long its build must have died, and queues it again', async () => {
    await request()
    setClock(LONG_AFTER)

    await request()

    expect(queued().map((m) => (m.body as BuildRoutineMessage).requestedAt)).toEqual([T0.getTime(), at(LONG_AFTER).getTime()])
  })

  it('queues again for the same key once the build has run, because the claim was given back', async () => {
    await request()
    await run(queuedBody())
    setClock(MINUTE)

    await request()

    expect(queued()).toHaveLength(2)
  })

  describe('when routines are switched off', () => {
    beforeEach(() => {
      service = new RoutineService({ ...deps, enabled: false })
    })

    it('queues nothing', async () => {
      await request()

      expect(queued()).toEqual([])
    })

    it('takes no claim either, so switching routines on later does not find the key held', async () => {
      await request()
      service = new RoutineService({ ...deps, enabled: true })

      await request()

      expect(queued()).toHaveLength(1)
      expect(await requestRow()).toMatchObject({ requestKey: 'routine-fp-1' })
    })

    it('leaves no request row behind', async () => {
      await request()

      expect(await requestRow()).toBeNull()
    })
  })

  describe('when the queue or the claim fails', () => {
    it('does not throw when the queue refuses the message, and logs by id and never the words of the error', async () => {
      const spies = spyOnConsole()
      jobs.failNextWith(new Error('queue down while holding Karo Glow Cream'))

      await expect(request()).resolves.toBe(false)

      expect(loggedText(spies)).toContain(AMARA_PROFILE)
      expect(loggedText(spies)).not.toContain('Karo Glow Cream')
    })

    it('gives the claim back when the queue refuses, so the next request for the same key queues', async () => {
      jobs.failNextWith(new Error('queue down'))
      await request()
      expect(queued()).toEqual([])
      setClock(SECOND)

      await request()

      expect(queued()).toHaveLength(1)
    })

    it('does not throw when the claim itself fails, and queues nothing', async () => {
      spyOnConsole()
      vi.spyOn(repository, 'claim').mockRejectedValueOnce(new Error('the database is down'))

      await expect(request()).resolves.toBe(false)

      expect(queued()).toEqual([])
    })
  })

  describe('whether anything was queued', () => {
    it('answers true when the build was queued', async () => {
      await expect(request()).resolves.toBe(true)
    })

    it('answers false when a request already being worked on holds the claim, whatever its key', async () => {
      await request('verdict', 'routine-fp-1')
      setClock(MINUTE)

      await expect(request('sold-here', 'sold-here:version-1:treat')).resolves.toBe(false)
      expect(queued()).toHaveLength(1)
    })

    it('answers false when routines are switched off, and for a guest', async () => {
      service = new RoutineService({ ...deps, enabled: false })
      await expect(request()).resolves.toBe(false)
      service = new RoutineService({ ...deps, enabled: true })
      asGuest()
      await expect(request()).resolves.toBe(false)
    })
  })
})

describe('RoutineService.run', () => {
  it('builds the routine for the profile and reason in the message', async () => {
    await request('first')

    await run(queuedBody())

    expect(await repository.current(AMARA_PROFILE)).toMatchObject({ status: 'ready', reason: 'first' })
    expect(shapeOf(await currentRow())).toEqual(FIRST_SHAPE)
  })

  it('records the reason it was asked with on the version it builds', async () => {
    await request('verdict', 'routine-fp-2')

    await run(queuedBody())

    expect((await latestRow()).reason).toBe('verdict')
  })

  it('leaves a routine unchanged after Start when the rebuild finds nothing to change, and gives the claim back', async () => {
    await started()
    await request('shelf', 'routine-fp-2')
    const before = await latestRow()

    await run(queued().at(-1)!.body as BuildRoutineMessage)

    // Nothing was appended. (The build mints its version's id before it knows whether there will be one, so the id counter is no witness to that.)
    expect(await latestRow()).toEqual(before)
    setClock(2 * DAY + MINUTE)
    await request('shelf', 'routine-fp-2')
    expect(queued()).toHaveLength(2)
  })

  it('gives the claim back once the build is done, so the same key can be asked for again', async () => {
    await request()
    await run(queuedBody())
    expect(queued()).toHaveLength(1)

    setClock(MINUTE)
    await request()

    expect(queued()).toHaveLength(2)
  })

  it('throws what the build throws, for the queue to retry', async () => {
    await request()
    vi.spyOn(repository, 'append').mockRejectedValueOnce(new Error('the database is down'))

    await expect(run(queuedBody())).rejects.toThrow('the database is down')
  })

  describe('while the routine has nothing to be built from yet', () => {
    beforeEach(() => {
      world.saved = null
    })

    it.each(['first', 'review-point'] as const)('queues itself again a minute on with one more wait, for the reason %s', async (reason) => {
      const body = bodyOf({ reason, requestKey: 'k', requestedAt: 5_000, waits: 2 })

      await run(body)

      expect(queued()).toEqual([{ job: 'build-routine', body: { ...body, waits: 3 }, delaySeconds: 60 }])
      expect(await repository.latest(AMARA_PROFILE)).toBeNull()
    })

    it('keeps the message\'s retry flag when it waits', async () => {
      await run(bodyOf({ retry: true, waits: 0 }))

      expect(queued()[0]!.body).toMatchObject({ retry: true, waits: 1 })
    })

    it('keeps the claim while it waits, so a request for the same key is still held off', async () => {
      await request()
      await run(queuedBody())
      expect(queued()).toHaveLength(2)

      setClock(MINUTE)
      await request()

      expect(queued()).toHaveLength(2)
    })

    it('still waits at 14 waits: a message that has waited 14 times queues the 15th', async () => {
      await run(bodyOf({ waits: 14 }))

      expect(queued()).toEqual([{ job: 'build-routine', body: expect.objectContaining({ waits: 15 }), delaySeconds: 60 }])
    })

    it('stops waiting at the 15th: a message that has waited 15 times queues nothing more, and does not throw', async () => {
      await expect(run(bodyOf({ waits: 15 }))).resolves.toBeUndefined()

      expect(queued()).toEqual([])
    })

    it('gives the claim back when it stops waiting, so a later request for the same key queues', async () => {
      await request()
      const body = { ...queuedBody(), waits: 15 }
      await run(body)
      setClock(MINUTE)

      await request()

      expect(queued()).toHaveLength(2)
    })

    it.each(['shelf', 'goal', 'safety', 'verdict', 'catalog-retired', 'sold-here', 'got-it', 'writer-retry'] as const)(
      'never waits for the reason %s: nothing is queued, and the claim is given back',
      async (reason) => {
        await request(reason, `key-${reason}`)

        await run(queuedBody())

        expect(queued()).toHaveLength(1)
        setClock(MINUTE)
        await request(reason, `key-${reason}`)
        expect(queued()).toHaveLength(2)
      },
    )
  })

  it('gives back only the claim made at the time in the message: a newer request\'s claim survives an older run', async () => {
    await request('first', 'key-1')
    const older = queuedBody()
    // The first build died long ago; a later request took its claim over.
    setClock(LONG_AFTER)
    await request('first', 'key-1')
    expect(queued()).toHaveLength(2)

    await run(older)
    setClock(LONG_AFTER + SECOND)
    await request('first', 'key-1')

    expect(queued()).toHaveLength(2)
  })
})

describe('RoutineService.markBuildFailed', () => {
  it('sets the retry due exactly 24 hours after the dead letter, the first time', async () => {
    await request()
    setClock(30 * MINUTE)

    await markBuildFailed(queuedBody())

    const row = await requestRow()
    expect(row!.retryDueAt).toEqual(at(30 * MINUTE + DAY))
    expect(row!.retried).toBe(true)
  })

  it('gives the claim back, so a new request for the same key is queued at once', async () => {
    await request()
    setClock(MINUTE)
    await markBuildFailed(queuedBody())

    await request()

    expect(queued()).toHaveLength(2)
  })

  it('makes a second dead letter final: no retry is due', async () => {
    await request()
    setClock(30 * MINUTE)
    await markBuildFailed(queuedBody())
    expect((await requestRow())!.retryDueAt).not.toBeNull()

    // The daily sweep (PR 3c) queues the retry with retry: true and a time of its own; it too runs out of tries.
    const retry = { ...queuedBody(), requestedAt: at(DAY + HOUR).getTime(), retry: true }
    setClock(DAY + 2 * HOUR)
    await markBuildFailed(retry)

    expect((await requestRow())!.retryDueAt).toBeNull()
  })

  it('logs a final failure by id, never the words of the person', async () => {
    await request()
    const spies = spyOnConsole()

    await markBuildFailed({ ...queuedBody(), retry: true })

    expect(loggedText(spies)).toContain(AMARA_PROFILE)
    expect(loggedText(spies)).not.toContain('Karo Glow Cream')
  })

  it('does not set a retry due for a request that has no row, and does not throw', async () => {
    await expect(markBuildFailed(bodyOf())).resolves.toBeUndefined()

    expect(await requestRow()).toBeNull()
  })
})

describe('RoutineService.current: the safety hide', () => {
  /** The person reports a prescription and a pregnancy: the cautions the routine in force was not built under. */
  const reportMoreCautions = () => {
    world.safety = { ...world.safety, view: safetyView(['reaction', 'prescription', 'pregnant']) }
  }

  it('hides the routine in force as soon as the safety answers differ from the ones it was built under, with no build under way: a reaction reported while the verdict is not ready', async () => {
    await firstBuild()
    world.saved = null
    world.safety = { ...world.safety, view: safetyView(['reaction', 'pregnant']) }

    expect(await build('safety')).toBe('waiting')

    expect(await current()).toEqual({ status: 'pending' })
  })

  it('shows the routine again once the build that stores the new cautions is done', async () => {
    await firstBuild()
    world.safety = { ...world.safety, view: safetyView(['reaction', 'pregnant']) }
    reverdict()
    setClock(MINUTE)
    expect(await current()).toEqual({ status: 'pending' })

    expect(await build('safety')).toBe('built')

    expect(await current()).toMatchObject({ status: 'ready', version: { cautions: ['pregnant', 'tapering', 'recent-reaction'] } })
  })

  it('hides it even when the only pending version is a stale one from a build that died', async () => {
    await started()
    removeShelfProduct('entry-a')
    vi.spyOn(repository, 'complete').mockRejectedValueOnce(new Error('the worker died'))
    setClock(2 * DAY + HOUR)
    await expect(build('shelf')).rejects.toThrow('the worker died')
    reportMoreCautions()

    setClock(2 * DAY + HOUR + 3 * HOUR)

    expect(await current()).toEqual({ status: 'pending' })
  })

  it('does not hide it for a caution that comes from the shelf (tapering) rather than from an answer', async () => {
    await started()
    saveVerdict(productsOfVerdict().filter((p) => p.entryId !== 'entry-b'))

    expect(await current()).toMatchObject({ status: 'ready' })
  })

  it('never shows the old routine with the old cautions, before, while or after the copy that stores the new cautions is appended (no step changed, so no writer is asked)', async () => {
    const before = await started()
    reportMoreCautions()
    reverdict()
    setClock(2 * DAY + HOUR)
    const seen: unknown[] = [await current()]
    const original = repository.append.bind(repository)
    vi.spyOn(repository, 'append').mockImplementation(async (row) => {
      seen.push(await current())
      await original(row)
    })

    expect(await build('safety')).toBe('built')

    seen.push(await current())
    expect(seen.slice(0, 2)).toEqual([{ status: 'pending' }, { status: 'pending' }])
    expect(seen[2]).toMatchObject({ status: 'ready', version: { id: 'version-2', cautions: ['pregnant', 'tapering', 'recent-reaction', 'prescription'] } })
    expect(attempts).toBe(1)
    expect(plain((await currentRow()))).toEqual(plain(before))
  })
})

describe('RoutineService.gotIt racing a build', () => {
  it('copies the version a build made while the product was being added, with that step marked got, when the step still holds the same product', async () => {
    await started()
    removeShelfProduct('entry-a')
    world.duringAdd = async () => {
      setClock(2 * DAY + 2 * HOUR)
      await build('shelf')
      setClock(2 * DAY + 3 * HOUR)
    }

    await gotIt('moisturise')

    const row = await currentRow()
    expect(row).toMatchObject({ id: 'version-3', reason: 'got-it', writerCalls: 0 })
    // The cleanse step is the build's new pick, not the old shelf product the got-it started from.
    expect(row.steps[0]).toMatchObject({ step: 'cleanse', product: { kind: 'candidate', code: 'CLEANSER-1' } })
    expect(row.steps.map((s) => s.gotIt)).toEqual([false, false, true, false])
    expect(world.shelfAdds).toHaveLength(1)
  })

  it('is 409 STEP_NOT_RECOMMENDED, with the product already on the shelf and no got-it version appended, when the build that landed meanwhile chose another product for the step', async () => {
    await started()
    world.duringAdd = async () => {
      for (const country of ['NG', 'GH'] as const) world.candidates[country].moisturise = [candidate('MOIST-2', 2600, 'am-pm')]
      reverdict()
      setClock(2 * DAY + 2 * HOUR)
      await build('verdict')
      setClock(2 * DAY + 3 * HOUR)
    }

    const error = await errorOf(gotIt('moisturise'))

    expect(error).toMatchObject({ code: 'STEP_NOT_RECOMMENDED' })
    expect(world.shelfAdds).toHaveLength(1)
    const row = await latestRow()
    expect(row).toMatchObject({ id: 'version-2', reason: 'verdict' })
    expect(row.steps[2]).toMatchObject({ product: { kind: 'candidate', code: 'MOIST-2' }, gotIt: false })
  })

  it('keeps the got mark through a build that was under way when it was tapped: the build\'s version has the step marked', async () => {
    await started()
    removeShelfProduct('entry-a')
    writer.hook = async () => {
      writer.hook = null
      await gotIt('moisturise')
      setClock(2 * DAY + 2 * HOUR)
    }
    setClock(2 * DAY + HOUR)

    expect(await build('shelf')).toBe('built')

    const row = await currentRow()
    expect(row.id).toBe('version-2')
    expect(row.steps.map((s) => s.gotIt)).toEqual([false, false, true, false])
    expect(world.shelfAdds).toEqual([{ productId: 'prod-MOIST-1', clientIp: CLIENT_IP }])
  })

  it('records the got-it copy with the source, model and prompt hash of the version it copies, and no writer calls', async () => {
    const before = await started()

    await gotIt('protect')

    expect(await currentRow()).toMatchObject({ reason: 'got-it', writerCalls: 0, source: before.source, model: 'claude-test-model', promptHash: 'prompt-hash-test' })
  })
})

describe('RoutineService.build: a Start that lands during a build', () => {
  it('dates the version, and its step-down, when Start lands between the read of the routine in force and the pending version being appended', async () => {
    await firstBuild()
    removeShelfProduct('entry-a')
    setClock(DAY)
    const original = repository.append.bind(repository)
    vi.spyOn(repository, 'append').mockImplementation(async (row) => {
      if (row.status === 'pending') await start()
      await original(row)
    })

    expect(await build('shelf')).toBe('built')

    const row = await currentRow()
    expect(row.id).toBe('version-2')
    expect(utcDay(row.startedOn!)).toBe(utcDay(at(2 * DAY)))
    expect(row.tapers).toEqual([{ shelfProductId: 'entry-b', templateId: 'TPR-STEROID-1', startedOn: row.startedOn }])
  })

  it('dates a version appended ready by the daily limit when Start lands just before it', async () => {
    for (let i = 0; i < 5; i++) {
      setClock(i * MINUTE)
      await build('shelf')
    }
    setClock(10 * MINUTE)
    // Start lands after the build has read the routine in force and before it appends: while it counts the day's writer builds.
    const counted = repository.writerBuildsSince.bind(repository)
    vi.spyOn(repository, 'writerBuildsSince').mockImplementationOnce(async (profileId, since) => {
      await start()
      return counted(profileId, since)
    })

    expect(await build('shelf')).toBe('built')

    const row = await latestRow()
    expect(row).toMatchObject({ source: 'rules', writerCalls: 0 })
    expect(utcDay(row.startedOn!)).toBe(utcDay(at(10 * MINUTE + DAY)))
    expect(row.tapers.every((taper) => taper.startedOn !== null && taper.startedOn.getTime() === row.startedOn!.getTime())).toBe(true)
  })
})

describe('RoutineService.build: a step-down that begins after Start', () => {
  it('dates a new stop the day of the rebuild, in UTC, and keeps the date of one already under way', async () => {
    const before = await started()
    addProduct('entry-c', STEROID, { name: 'Second Cream' })
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-c', { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, null, { sourceUrls: [STEROID_SOURCE] })])
    setClock(3 * DAY + HOUR)

    expect(await build('verdict')).toBe('built')

    expect(attempts).toBe(1)
    expect((await currentRow()).tapers).toEqual([
      { shelfProductId: 'entry-b', templateId: 'TPR-STEROID-1', startedOn: before.startedOn },
      { shelfProductId: 'entry-c', templateId: 'TPR-STEROID-1', startedOn: new Date('2030-06-18T00:00:00.000Z') },
    ])
  })
})

describe('RoutineService.build: a step-down that would begin before day 1', () => {
  // ASSUMED, not in the brief's words: "taper dates count from [day 1]". Start taps on the 17th make the 18th day 1; a stop the rules add the same evening must not
  // begin on the 17th, a day before the routine it belongs to has begun.
  it('begins a new stop that a rebuild adds between the tap and day 1 on day 1, not on the day of the rebuild', async () => {
    const before = await started()
    expect(before.startedOn).toEqual(new Date('2030-06-18T00:00:00.000Z'))
    addProduct('entry-c', STEROID, { name: 'Second Cream' })
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-c', { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, null, { sourceUrls: [STEROID_SOURCE] })])
    // 2030-06-17 at 13:00 UTC: after the tap, a day before day 1.
    setClock(2 * DAY + HOUR)

    expect(await build('verdict')).toBe('built')

    expect((await currentRow()).tapers).toEqual([
      { shelfProductId: 'entry-b', templateId: 'TPR-STEROID-1', startedOn: before.startedOn },
      { shelfProductId: 'entry-c', templateId: 'TPR-STEROID-1', startedOn: new Date('2030-06-18T00:00:00.000Z') },
    ])
  })

  it('begins a stop that a rebuild adds on day 1 itself that very day (the boundary: day 1 is the first day it may begin)', async () => {
    const before = await started()
    addProduct('entry-c', STEROID, { name: 'Second Cream' })
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-c', { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, null, { sourceUrls: [STEROID_SOURCE] })])
    // 2030-06-18 at 00:00:00.000 UTC, the first millisecond of day 1.
    setClock(2 * DAY + 12 * HOUR)

    expect(await build('verdict')).toBe('built')

    expect((await currentRow()).tapers[1]).toEqual({ shelfProductId: 'entry-c', templateId: 'TPR-STEROID-1', startedOn: before.startedOn })
  })
})

// ---- local days (spec #217, PR 3) ----
// Dates here are offsets from T0 (2030-06-15 12:00 UTC). Lagos is UTC+1 and New York (June) UTC-4. Every stored date is the UTC midnight of a local calendar date, worked out
// by hand. Each test (the clamp-to-day-1 pair apart, and the no-zone ones, which pin the old rule) is built so that the UTC rule would give a DIFFERENT answer.
const LAGOS = 'Africa/Lagos'
const NEW_YORK = 'America/New_York'
// Europe/London goes forward to BST at 2030-03-31 01:00 UTC (the 31st is a 23-hour local day) and back to GMT at 2030-10-27 01:00 UTC.
const LONDON_FORWARD_OFFSET = Date.UTC(2030, 2, 31, 1) - T0.getTime()
const LONDON_BACK_OFFSET = Date.UTC(2030, 9, 27, 1) - T0.getTime()

describe('RoutineService.start: with a stored time zone', () => {
  it('makes the Lagos 16th day 1 for a tap at 23:30 Lagos time on the 15th (22:30 UTC)', async () => {
    world.zone = LAGOS
    await firstBuild()
    setClock(10 * HOUR + 30 * MINUTE) // 2030-06-15 22:30 UTC = 23:30 in Lagos

    await start()

    const row = await currentRow()
    expect(row.startedOn).toEqual(new Date('2030-06-16T00:00:00.000Z'))
    expect(row.tapers[0]!.startedOn).toEqual(row.startedOn)
  })

  it('makes the Lagos 17th day 1 for a tap at 00:30 Lagos time on the 16th (23:30 UTC on the 15th), when the Lagos date is already a day ahead of UTC', async () => {
    world.zone = LAGOS
    await firstBuild()
    setClock(11 * HOUR + 30 * MINUTE) // 2030-06-15 23:30 UTC = 00:30 on the 16th in Lagos

    await start()

    // Tomorrow in Lagos is the 17th. The UTC rule would store the 16th, which is the Lagos day it is already.
    expect((await currentRow()).startedOn).toEqual(new Date('2030-06-17T00:00:00.000Z'))
  })

  // The edge of the Lagos midnight: one millisecond either side moves day 1 by a whole day.
  it.each([
    ['the last millisecond of the Lagos 15th', 11 * HOUR - 1, '2030-06-16T00:00:00.000Z'],
    ['the first millisecond of the Lagos 16th', 11 * HOUR, '2030-06-17T00:00:00.000Z'],
  ])('dates day 1 from %s', async (_when, offsetMs, day1) => {
    world.zone = LAGOS
    await firstBuild()
    setClock(offsetMs)

    await start()

    expect((await currentRow()).startedOn).toEqual(new Date(day1))
  })

  it('makes the New York 16th day 1 for a tap at 22:00 New York time on the 15th (02:00 UTC on the 16th), west of UTC where the local date is behind', async () => {
    world.zone = NEW_YORK
    await firstBuild()
    setClock(14 * HOUR) // 2030-06-16 02:00 UTC = 22:00 on the 15th in New York

    await start()

    // The UTC rule would store the 17th.
    const row = await currentRow()
    expect(row.startedOn).toEqual(new Date('2030-06-16T00:00:00.000Z'))
    expect(row.tapers[0]!.startedOn).toEqual(row.startedOn)
  })

  it('goes by the local date across London\'s clock change: 00:30 BST on 1 April (23:30 UTC on 31 March) makes 2 April day 1', async () => {
    world.zone = 'Europe/London'
    await firstBuild()
    setClock(LONDON_FORWARD_OFFSET + 22 * HOUR + 30 * MINUTE) // 2030-03-31 23:30 UTC

    await start()

    // The UTC rule would store 1 April.
    expect((await currentRow()).startedOn).toEqual(new Date('2030-04-02T00:00:00.000Z'))
  })

  it('goes by the local date across London\'s autumn change: 00:30 BST on 27 October (23:30 UTC on the 26th) makes the 28th day 1', async () => {
    world.zone = 'Europe/London'
    await firstBuild()
    setClock(LONDON_BACK_OFFSET - HOUR - 30 * MINUTE) // 2030-10-26 23:30 UTC

    await start()

    // The UTC rule would store the 27th.
    expect((await currentRow()).startedOn).toEqual(new Date('2030-10-28T00:00:00.000Z'))
  })

  it('stays on the next UTC day for a profile with no stored zone, at the same instant that Lagos gives another answer', async () => {
    world.zone = null
    await firstBuild()
    setClock(11 * HOUR + 30 * MINUTE) // 2030-06-15 23:30 UTC

    await start()

    expect((await currentRow()).startedOn).toEqual(new Date('2030-06-16T00:00:00.000Z'))
  })

  it('stays idempotent: a later tap, even after the zone changed, moves nothing', async () => {
    world.zone = LAGOS
    await firstBuild()
    setClock(11 * HOUR + 30 * MINUTE)
    await start()
    const afterFirstStart = await currentRow()
    world.zone = NEW_YORK
    setClock(2 * DAY)

    await start()

    expect(await currentRow()).toEqual(afterFirstStart)
  })
})

describe('RoutineService.build: a step-down that begins after Start, with a stored time zone', () => {
  const addSecondStop = () => {
    addProduct('entry-c', STEROID, { name: 'Second Cream' })
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-c', { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, null, { sourceUrls: [STEROID_SOURCE] })])
  }

  it('dates a new stop the local date of the rebuild, not the UTC date', async () => {
    world.zone = LAGOS
    const before = await started()
    // Tapped 2030-06-17 12:00 UTC (13:00 in Lagos): Lagos day 1 is the 18th.
    expect(before.startedOn).toEqual(new Date('2030-06-18T00:00:00.000Z'))
    addSecondStop()
    setClock(5 * DAY + 11 * HOUR + 30 * MINUTE) // 2030-06-20 23:30 UTC = 00:30 on the 21st in Lagos

    expect(await build('verdict')).toBe('built')

    // The Lagos date is the 21st. The UTC rule would date it the 20th, a whole Lagos day early.
    expect((await currentRow()).tapers).toEqual([
      { shelfProductId: 'entry-b', templateId: 'TPR-STEROID-1', startedOn: before.startedOn },
      { shelfProductId: 'entry-c', templateId: 'TPR-STEROID-1', startedOn: new Date('2030-06-21T00:00:00.000Z') },
    ])
  })

  it('dates a new stop west of UTC by the New York date: a rebuild at 02:00 UTC is still the evening before in New York', async () => {
    world.zone = NEW_YORK
    const before = await started()
    // Tapped 2030-06-17 12:00 UTC (08:00 in New York): day 1 is the 18th.
    expect(before.startedOn).toEqual(new Date('2030-06-18T00:00:00.000Z'))
    addSecondStop()
    setClock(5 * DAY - 10 * HOUR) // 2030-06-20 02:00 UTC = 22:00 on the 19th in New York

    expect(await build('verdict')).toBe('built')

    // The New York date is the 19th. The UTC rule would date it the 20th, a day late.
    expect((await currentRow()).tapers[1]).toEqual({ shelfProductId: 'entry-c', templateId: 'TPR-STEROID-1', startedOn: new Date('2030-06-19T00:00:00.000Z') })
  })

  // None begins before day 1 (the 18th). The clamp holds either side of the Lagos midnight that ends the 17th, since the 17th is before day 1 and the 18th is day 1 itself.
  it.each([
    ['the last millisecond of the Lagos 17th: it waits for day 1', 2 * DAY + 11 * HOUR - 1],
    ['the first millisecond of the Lagos 18th (day 1): it begins on day 1 itself', 2 * DAY + 11 * HOUR],
  ])('begins a stop added %s', async (_when, offsetMs) => {
    world.zone = LAGOS
    const before = await started()
    expect(before.startedOn).toEqual(new Date('2030-06-18T00:00:00.000Z'))
    addSecondStop()
    setClock(offsetMs) // 2030-06-17 22:59:59.999 UTC / 23:00:00.000 UTC

    expect(await build('verdict')).toBe('built')

    expect((await currentRow()).tapers[1]).toEqual({ shelfProductId: 'entry-c', templateId: 'TPR-STEROID-1', startedOn: before.startedOn })
  })

  // Past day 1 the Lagos midnight moves the date by a day, where the UTC midnight an hour later would not have yet.
  it.each([
    ['the last millisecond of the Lagos 18th', 3 * DAY + 11 * HOUR - 1, '2030-06-18T00:00:00.000Z'],
    ['the first millisecond of the Lagos 19th', 3 * DAY + 11 * HOUR, '2030-06-19T00:00:00.000Z'],
  ])('dates a stop added %s', async (_when, offsetMs, date) => {
    world.zone = LAGOS
    await started()
    addSecondStop()
    setClock(offsetMs)

    expect(await build('verdict')).toBe('built')

    expect((await currentRow()).tapers[1]).toEqual({ shelfProductId: 'entry-c', templateId: 'TPR-STEROID-1', startedOn: new Date(date) })
  })

  it('keeps the date of a step-down already under way when the zone changes before the rebuild', async () => {
    world.zone = LAGOS
    const before = await started()
    addSecondStop()
    world.zone = NEW_YORK
    setClock(5 * DAY)

    expect(await build('verdict')).toBe('built')

    expect((await currentRow()).tapers[0]).toEqual({ shelfProductId: 'entry-b', templateId: 'TPR-STEROID-1', startedOn: before.startedOn })
  })

  it('still dates a new stop the UTC date of the rebuild for a profile with no stored zone', async () => {
    world.zone = null
    const before = await started()
    addSecondStop()
    setClock(5 * DAY + 11 * HOUR + 30 * MINUTE) // 2030-06-20 23:30 UTC

    expect(await build('verdict')).toBe('built')

    expect((await currentRow()).tapers).toEqual([
      { shelfProductId: 'entry-b', templateId: 'TPR-STEROID-1', startedOn: before.startedOn },
      { shelfProductId: 'entry-c', templateId: 'TPR-STEROID-1', startedOn: new Date('2030-06-20T00:00:00.000Z') },
    ])
  })
})

// The regression: dates are fixed when they are set. A phone that reports its zone later (a US user who started with none) or a traveller whose zone changes must not
// move day 1 or any step-down date, which the routine response prints as stored.
describe('RoutineService: a change of zone after Start moves no stored date', () => {
  const addSecondStop = () => {
    addProduct('entry-c', STEROID, { name: 'Second Cream' })
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-c', { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, null, { sourceUrls: [STEROID_SOURCE] })])
  }

  it.each([
    ['no zone at first, then New York (the phone reports it later)', null, NEW_YORK],
    ['Lagos, then New York (a traveller)', LAGOS, NEW_YORK],
    ['New York, then none (the zone is cleared)', NEW_YORK, null],
  ])('keeps day 1 and the step-down date, and the version in force, through a zone that goes from %s', async (_label, first, then) => {
    world.zone = first
    const before = await started()
    const days = before.tapers.map((taper) => taper.startedOn)
    const startedOn = before.startedOn
    world.zone = then

    // Nothing writes a date, and a rebuild that finds nothing to change leaves the routine in force alone.
    setClock(3 * DAY)
    expect(await build('verdict')).toBe('unchanged')
    await start()

    const after = await currentRow()
    expect(after.startedOn).toEqual(startedOn)
    expect(after.tapers.map((taper) => taper.startedOn)).toEqual(days)
  })

  it('keeps the dates of what was set before the change, and dates what is added after it by the zone it then has', async () => {
    world.zone = null
    const before = await started() // 2030-06-18T00:00Z
    world.zone = LAGOS
    addSecondStop()
    setClock(5 * DAY + 11 * HOUR + 30 * MINUTE) // 2030-06-20 23:30 UTC = the Lagos 21st

    expect(await build('verdict')).toBe('built')

    const row = await currentRow()
    expect(row.startedOn).toEqual(before.startedOn)
    expect(row.tapers).toEqual([
      { shelfProductId: 'entry-b', templateId: 'TPR-STEROID-1', startedOn: before.startedOn },
      { shelfProductId: 'entry-c', templateId: 'TPR-STEROID-1', startedOn: new Date('2030-06-21T00:00:00.000Z') },
    ])
  })
})

describe('RoutineService.build: a writer retry with nothing to change', () => {
  it('answers unchanged and clears the version\'s retry due time, calling no writer', async () => {
    await started()
    removeShelfProduct('entry-a')
    script(throws(), throws(), throws())
    setClock(2 * DAY + HOUR)
    await build('shelf')
    const rulesBuilt = await currentRow()
    expect(rulesBuilt.writerRetryDueAt).not.toBeNull()
    const asked = attempts
    setClock(3 * DAY + 2 * HOUR)

    expect(await build('writer-retry')).toBe('unchanged')

    expect(attempts).toBe(asked)
    expect(await currentRow()).toEqual({ ...rulesBuilt, writerRetryDueAt: null })
  })

  it('does not clear the due time on an unchanged answer to any other reason', async () => {
    await started()
    removeShelfProduct('entry-a')
    script(throws(), throws(), throws())
    setClock(2 * DAY + HOUR)
    await build('shelf')
    const rulesBuilt = await currentRow()

    expect(await build('verdict')).toBe('unchanged')

    expect(await currentRow()).toEqual(rulesBuilt)
  })
})

describe('RoutineService.build: a profile that does not exist', () => {
  it('answers waiting and logs the id, nothing else', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(await runAs(SYSTEM, () => service.build('profile-nobody', 'first'))).toBe('waiting')

    expect(log).toHaveBeenCalledWith({ outcome: 'routine-profile-missing', profileId: 'profile-nobody' })
    expect(await repository.latest('profile-nobody')).toBeNull()
  })
})

// ---- PR 4b: "find one sold here" reaches the job, and the live stream is told ----
//
// request(profileId, reason, requestKey, options?: { exclude?: { step, code } }) carries the exclusion in the queued message, `run` hands it to `build`, and the
// job message schema keeps it. The service is also given `announce: (profileId) => Promise<void>` (the viewer's, which publishes the routine's body on
// `routine:<profileId>`; wired lazily in the container since the viewer reads the service): it is called when a build has put a pending version in place (the
// routine is now `updating`) and again when that build is done. A failing announce never fails a build, and the log carries ids only.

const EXCLUDE = { step: 'treat', code: 'SERUM-1' } as const

describe('RoutineService.request: find one sold here', () => {
  it('queues the exclusion with the message, and the job message schema keeps it', async () => {
    await service.request(AMARA_PROFILE, 'sold-here', 'sold-here:version-1:treat', { exclude: EXCLUDE })

    expect(queued()).toEqual([
      { job: 'build-routine', body: { profileId: AMARA_PROFILE, reason: 'sold-here', requestKey: 'sold-here:version-1:treat', requestedAt: T0.getTime(), waits: 0, exclude: EXCLUDE } },
    ])
    expect(buildRoutineSpec.schema.parse(queuedBody())).toEqual(queuedBody())
  })

  it('queues no exclusion with an ordinary request', async () => {
    await request('shelf', 'routine-fp-2')

    expect(queuedBody()).not.toHaveProperty('exclude')
  })

  it('is held off by a request already being worked on, the exclusion included', async () => {
    await request('shelf', 'routine-fp-2')

    await service.request(AMARA_PROFILE, 'sold-here', 'sold-here:version-1:treat', { exclude: EXCLUDE })

    expect(queued()).toHaveLength(1)
  })
})

describe('RoutineService.run: find one sold here', () => {
  it('builds the routine again with that product out of its step, changing only that step', async () => {
    const before = await started()
    setClock(2 * DAY + HOUR)
    await service.request(AMARA_PROFILE, 'sold-here', `sold-here:${before.id}:treat`, { exclude: EXCLUDE })

    await run(queuedBody())

    const row = await currentRow()
    expect(row.reason).toBe('sold-here')
    expect(shapeOf(row)).toEqual([FIRST_SHAPE[0], { step: 'treat', product: { kind: 'candidate', code: 'SERUM-2' }, frequency: 'alternate-days' }, FIRST_SHAPE[2], FIRST_SHAPE[3]])
    expect([0, 2, 3].map((i) => row.steps[i])).toEqual([0, 2, 3].map((i) => ({ ...before.steps[i], fixedFrom: before.id })))
  })

  it('gives the claim back once it is done, as for any build', async () => {
    const before = await started()
    setClock(2 * DAY + HOUR)
    await service.request(AMARA_PROFILE, 'sold-here', `sold-here:${before.id}:treat`, { exclude: EXCLUDE })
    await run(queuedBody())
    setClock(2 * DAY + 2 * HOUR)

    await service.request(AMARA_PROFILE, 'sold-here', `sold-here:${before.id}:moisturise`, { exclude: { step: 'moisturise', code: 'MOIST-1' } })

    expect(queued()).toHaveLength(2)
  })
})

describe('RoutineService: telling the live stream', () => {
  it('announces once when the build has put its pending version in place, before the writer is asked, and again when the build is done', async () => {
    let announcedWhileWriting: string[] | null = null
    writer.hook = async () => {
      announcedWhileWriting ??= [...announces]
    }

    expect(await build('first')).toBe('built')

    expect(announcedWhileWriting).toEqual([AMARA_PROFILE])
    expect(announces).toEqual([AMARA_PROFILE, AMARA_PROFILE])
  })

  it('announces only the profile that was built', async () => {
    await build('first')

    expect(new Set(announces)).toEqual(new Set([AMARA_PROFILE]))
  })

  it('announces nothing when there is nothing to build from yet', async () => {
    world.saved = null

    expect(await build('first')).toBe('waiting')

    expect(announces).toEqual([])
  })

  it('announces nothing when a rebuild after Start finds nothing to change', async () => {
    await started()
    announces.length = 0
    setClock(2 * DAY + HOUR)

    expect(await build('shelf')).toBe('unchanged')

    expect(announces).toEqual([])
  })

  it('still builds, and logs the failure by profile id, when the announcement fails', async () => {
    const spies = spyOnConsole()
    let tried = 0
    deps = { ...deps, announce: async () => { tried++; throw new Error('the stream is down') } }
    service = new RoutineService(deps)

    expect(await build('first')).toBe('built')

    expect(tried).toBeGreaterThan(0)

    expect((await currentRow()).status).toBe('ready')
    const logged = loggedText(spies)
    expect(logged).toContain(AMARA_PROFILE)
    expect(logged).not.toContain('Calm Cleanser')
    expect(logged).not.toContain('Karo Glow Cream')
  })
})

// ---- PR 3c: the stale read, the daily sweeps, and outcome hints in the build (spec #189) ----
//
// New on the service (assumed shapes, what this file pins):
//   requestIfStale(profileId): Promise<void>   never throws. Works out the routine fingerprint from the inputs as they are now (the goal; the cautions the safety answers
//       state, plus tapering when the saved verdict stops a product; each saved verdict product's entryId, verdict and step; the rules version) and, when it differs
//       from the routine in force's routineFingerprint, or there is no routine in force while the saved verdict is ready, calls request(profileId, 'verdict', fingerprint).
//       Nothing is asked when the verdict is not saved and ready, or the goal or the safety answers are not there yet. Disabled: nothing.
//   sweep(now: Date): Promise<number>   the daily sweeps, run by the cron with no session, answering how many builds it queued in all. Three, each at most 200 rows,
//       and each does nothing at all when routines are switched off:
//         - the dead-letter retry due (retryDueAt <= now): queues { profileId, reason, requestKey: the request's own key, requestedAt: now, waits: 0, retry: true } with
//           no delay and clears the retry due (the reason is not pinned: the request row does not keep one);
//         - the writer retry due: request(profileId, 'writer-retry', `writer-retry:${versionId}`) for the routine in force when its writerRetryDueAt <= now;
//         - the retired codes: request(profileId, 'catalog-retired', `catalog-retired:${versionId}`) for the routine in force holding a recommended product retired
//           after the version was built (catalog version greater than the version's).
//   The repository gives it dueRequests(now, limit), writerRetriesDue(now, limit) and retiredCodeVersions(limit) (routines.repository.contract.ts); the fake is told
//   which codes the catalog retired with retireCode(code, updatedInVersion).
//   deps.outcomeCounts: Pick<OutcomeCountsRepository, 'counts'>, read for the codes of the skeleton's gap candidates when the version shows hints.

const requestIfStale = () => runAs(AMARA_ACTOR, () => service.requestIfStale(AMARA_PROFILE))
const sweep = (offsetMs: number) => {
  setClock(offsetMs)
  return service.sweep(at(offsetMs))
}
const bodies = () => jobs.enqueued.map((entry) => entry.body as BuildRoutineMessage)

describe('RoutineService.requestIfStale', () => {
  /** The fingerprint of the routine for Amara's goal, cautions and decisions as the world has them at the start of a test: the two products of the verdict. */
  const fingerprintOfWorld = (over: { goal?: Goal; cautions?: Parameters<typeof routineFingerprint>[0]['cautions']; products?: Parameters<typeof routineFingerprint>[0]['products'] } = {}) =>
    routineFingerprint({
      goal: over.goal ?? 'fade-dark-marks',
      cautions: over.cautions ?? ['tapering', 'recent-reaction'],
      products: over.products ?? [
        { entryId: 'entry-a', verdict: { kind: 'keep' }, step: 'cleanse' },
        { entryId: 'entry-b', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, step: 'treat' },
      ],
      rulesVersion: ROUTINE_RULES_VERSION,
    })

  it('asks for the first routine, keyed by the fingerprint of its inputs, when the verdict is ready and there is no routine yet', async () => {
    await requestIfStale()

    expect(queued()).toEqual([{ job: 'build-routine', body: { profileId: AMARA_PROFILE, reason: 'verdict', requestKey: await fingerprintOfWorld(), requestedAt: T0.getTime(), waits: 0 } }])
  })

  it.each([
    ['there is no saved verdict (outdated, or its build is still queued)', () => (world.saved = null)],
    ['the saved verdict\'s fit is not ready', () => (world.saved = { ...world.saved!, fit: 'not-ready' })],
    ['the profile has no goal', () => (world.goal = null)],
    ['the profile has not answered the safety question', () => (world.safety = { view: null, parseState: null, mentions: [] })],
  ])('asks for nothing when there is no routine yet and %s', async (_why, change) => {
    change()

    await expect(requestIfStale()).resolves.toBeUndefined()

    expect(queued()).toEqual([])
  })

  it('asks for nothing when the routine in force was built from the very inputs there are now', async () => {
    await firstBuild()

    await requestIfStale()

    expect(queued()).toEqual([])
  })

  // The build leaves out a verdict product whose shelf entry cannot be found, and keeps a reduced sunscreen as keep: its fingerprint is of the skeleton's shelf, not of the
  // verdict's list. A read that fingerprinted the verdict's products as they are would disagree with every build, and ask for a rebuild each time it was asked.
  it('asks for nothing when the verdict names an entry the build leaves out, because the read fingerprints what the build does', async () => {
    addProduct('entry-lost', CLEAN)
    world.facts.delete('form-entry-lost')
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-lost', { kind: 'keep' }, 'moisturise')])
    await firstBuild()

    await requestIfStale()

    expect(queued()).toEqual([])
  })

  it('asks for nothing when the verdict reduces a sunscreen the build keeps as it is', async () => {
    addProduct('entry-spf', CLEAN)
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-spf', { kind: 'reduce', maxFrequency: 'alternate-days' }, 'protect')])
    await firstBuild()

    await requestIfStale()

    expect(queued()).toEqual([])
  })

  it('asks for nothing about a routine already started, when its inputs have not changed', async () => {
    await started()

    await requestIfStale()

    expect(queued()).toEqual([])
  })

  const changes: [string, () => void, () => ReturnType<typeof routineFingerprint>][] = [
    ['the goal changed', () => (world.goal = 'glow'), () => routineFingerprint({ goal: 'glow', cautions: ['tapering', 'recent-reaction'], products: [{ entryId: 'entry-a', verdict: { kind: 'keep' }, step: 'cleanse' }, { entryId: 'entry-b', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, step: 'treat' }], rulesVersion: ROUTINE_RULES_VERSION })],
    [
      'a safety answer was added',
      () => (world.safety = { ...world.safety, view: safetyView(['reaction', 'pregnant']) }),
      () => routineFingerprint({ goal: 'fade-dark-marks', cautions: ['pregnant', 'tapering', 'recent-reaction'], products: [{ entryId: 'entry-a', verdict: { kind: 'keep' }, step: 'cleanse' }, { entryId: 'entry-b', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, step: 'treat' }], rulesVersion: ROUTINE_RULES_VERSION }),
    ],
    [
      'the stopped product is now kept, so the tapering caution goes',
      () => saveVerdict([verdictProduct('entry-a', { kind: 'keep' }, 'cleanse'), verdictProduct('entry-b', { kind: 'keep' }, 'treat')]),
      () => routineFingerprint({ goal: 'fade-dark-marks', cautions: ['recent-reaction'], products: [{ entryId: 'entry-a', verdict: { kind: 'keep' }, step: 'cleanse' }, { entryId: 'entry-b', verdict: { kind: 'keep' }, step: 'treat' }], rulesVersion: ROUTINE_RULES_VERSION }),
    ],
    [
      'a product left the shelf',
      () => removeShelfProduct('entry-a'),
      () => routineFingerprint({ goal: 'fade-dark-marks', cautions: ['tapering', 'recent-reaction'], products: [{ entryId: 'entry-b', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, step: 'treat' }], rulesVersion: ROUTINE_RULES_VERSION }),
    ],
  ]

  it.each(changes)('asks for a rebuild, keyed by the new fingerprint, when %s, and that key is what the rebuild then records', async (_why, change, expected) => {
    const before = await firstBuild()
    change()

    await requestIfStale()

    const key = await expected()
    expect(key).not.toBe(before.routineFingerprint)
    expect(queued()).toEqual([{ job: 'build-routine', body: { profileId: AMARA_PROFILE, reason: 'verdict', requestKey: key, requestedAt: T0.getTime(), waits: 0 } }])
    await run(queuedBody())
    expect((await latestRow()).routineFingerprint).toBe(key)
  })

  it('does not ask a second time for the same inputs while the first request is being worked on', async () => {
    await firstBuild()
    reverdict()
    world.goal = 'glow'

    await requestIfStale()
    await requestIfStale()

    expect(queued()).toHaveLength(1)
  })

  it('asks for nothing when routines are switched off', async () => {
    service = new RoutineService({ ...deps, enabled: false })

    await requestIfStale()

    expect(queued()).toEqual([])
    expect(await repository.findRequest(AMARA_PROFILE)).toBeNull()
  })

  it('does not throw, asks for nothing and logs only the id, when the saved verdict cannot be read', async () => {
    const spies = spyOnConsole()
    deps.verdicts = { savedFor: async () => Promise.reject(new Error('the database is down while holding Karo Glow Cream')) }
    service = new RoutineService(deps)

    await expect(requestIfStale()).resolves.toBeUndefined()

    expect(queued()).toEqual([])
    expect(spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call))).join('\n')).not.toContain('Karo Glow Cream')
  })

  it('does not throw when the routine in force cannot be read', async () => {
    spyOnConsole()
    vi.spyOn(repository, 'current').mockRejectedValue(new Error('the database is down'))

    await expect(requestIfStale()).resolves.toBeUndefined()

    expect(queued()).toEqual([])
  })

  it('does not throw when the queue refuses the request', async () => {
    spyOnConsole()
    jobs.failNextWith(new Error('queue down'))

    await expect(requestIfStale()).resolves.toBeUndefined()
  })
})

describe('RoutineService.sweep: the dead-letter retry due', () => {
  /** A request that was built, dead-lettered 30 minutes in, and so has its retry due 24 hours after that. */
  const deadLettered = async (key = 'routine-fp-1') => {
    await request('verdict', key)
    setClock(30 * MINUTE)
    await markBuildFailed(queuedBody())
    return 30 * MINUTE + DAY
  }

  it('queues the retry of a request whose retry is due, marked as the retry, with no delay, and not a millisecond before', async () => {
    const due = await deadLettered()
    const queuedBefore = jobs.enqueued.length

    expect(await sweep(due - 1)).toBe(0)
    expect(jobs.enqueued).toHaveLength(queuedBefore)

    expect(await sweep(due)).toBe(1)
    expect(jobs.enqueued).toHaveLength(queuedBefore + 1)
    const sent = jobs.enqueued.at(-1)!
    expect(sent.job).toBe('build-routine')
    expect(sent.delaySeconds).toBeUndefined()
    expect(sent.body).toEqual({ profileId: AMARA_PROFILE, reason: expect.any(String), requestKey: 'routine-fp-1', requestedAt: at(due).getTime(), waits: 0, retry: true })
  })

  it('clears the retry due when it queues the retry, so a second sweep queues nothing for it', async () => {
    const due = await deadLettered()
    await sweep(due)
    const queuedBefore = jobs.enqueued.length

    expect(await sweep(due + HOUR)).toBe(0)

    expect(jobs.enqueued).toHaveLength(queuedBefore)
    expect((await repository.findRequest(AMARA_PROFILE))!.retryDueAt).toBeNull()
  })

  it('queues nothing for a request that never dead-lettered, or whose build finished', async () => {
    await request('verdict', 'routine-fp-1')
    await run(queuedBody())

    expect(await sweep(10 * DAY)).toBe(0)

    expect(jobs.enqueued).toHaveLength(1)
  })

  it('does not queue a third try: a retry that dead-letters in turn is final', async () => {
    const due = await deadLettered()
    await sweep(due)
    setClock(due + HOUR)
    await markBuildFailed(jobs.enqueued.at(-1)!.body as BuildRoutineMessage)
    const queuedBefore = jobs.enqueued.length

    expect(await sweep(due + 3 * DAY)).toBe(0)

    expect(jobs.enqueued).toHaveLength(queuedBefore)
    expect((await repository.findRequest(AMARA_PROFILE))!.retryDueAt).toBeNull()
  })

  it('keeps the retry due when the queue refuses the message, so the next sweep tries again', async () => {
    spyOnConsole()
    const due = await deadLettered()
    jobs.failNextWith(new Error('queue down'))

    await expect(sweep(due)).resolves.toBe(0)
    expect((await repository.findRequest(AMARA_PROFILE))!.retryDueAt).toEqual(at(due))

    expect(await sweep(due + DAY)).toBe(1)
  })

  it('queues nothing, and leaves the retry due, when routines are switched off', async () => {
    const due = await deadLettered()
    service = new RoutineService({ ...deps, enabled: false })
    const queuedBefore = jobs.enqueued.length

    expect(await sweep(due)).toBe(0)

    expect(jobs.enqueued).toHaveLength(queuedBefore)
    expect((await repository.findRequest(AMARA_PROFILE))!.retryDueAt).toEqual(at(due))
  })

  it('queues at most 200 retries a run, the longest overdue first, and the rest on the next run', async () => {
    for (let i = 0; i <= 200; i++) {
      world.profiles.set(`profile-${i}`, `user-${i}`)
      await repository.claim(`profile-${i}`, `routine-fp-${i}`, at(0), at(-HOUR))
      await repository.setRequestRetry(`profile-${i}`, { retried: true, retryDueAt: at(HOUR + i * SECOND) })
    }

    expect(await sweep(DAY)).toBe(200)

    expect(bodies()).toHaveLength(200)
    expect(new Set(bodies().map((body) => body.profileId)).size).toBe(200)
    expect(bodies().map((body) => body.profileId)).not.toContain('profile-200')
    expect((await repository.findRequest('profile-200'))!.retryDueAt).toEqual(at(HOUR + 200 * SECOND))

    expect(await sweep(DAY + HOUR)).toBe(1)
    expect(bodies().at(-1)).toMatchObject({ profileId: 'profile-200', requestKey: 'routine-fp-200', retry: true })
  })
})

describe('RoutineService.sweep: the writer retry due', () => {
  /** A first build the writer failed three times: the rules wrote the routine, and the writer is due another try 24 hours after the build. */
  const rulesBuilt = async () => {
    script(throws(), throws(), throws())
    const row = await firstBuild()
    expect(row).toMatchObject({ source: 'rules', writerRetryDueAt: at(DAY) })
    script()
    return row
  }

  it('asks for the writer retry of the routine in force when it is due, keyed by the version, and not a millisecond before', async () => {
    const row = await rulesBuilt()

    expect(await sweep(DAY - 1)).toBe(0)
    expect(queued()).toEqual([])

    expect(await sweep(DAY)).toBe(1)
    expect(queued()).toEqual([{ job: 'build-routine', body: { profileId: AMARA_PROFILE, reason: 'writer-retry', requestKey: `writer-retry:${row.id}`, requestedAt: at(DAY).getTime(), waits: 0 } }])
  })

  it('stops asking once the retry has built a routine the writer wrote', async () => {
    await rulesBuilt()
    await sweep(DAY)
    await run(queuedBody())
    expect(await currentRow()).toMatchObject({ source: 'writer', reason: 'writer-retry', writerRetryDueAt: null })

    expect(await sweep(DAY + HOUR)).toBe(0)

    expect(queued()).toHaveLength(1)
  })

  it('asks for nothing for a routine the writer wrote', async () => {
    await firstBuild()

    expect(await sweep(10 * DAY)).toBe(0)

    expect(queued()).toEqual([])
  })

  it('never asks for a rules-only version that a newer ready version has replaced', async () => {
    await rulesBuilt()
    setClock(MINUTE)
    reverdict()
    await build('verdict')
    expect(await currentRow()).toMatchObject({ source: 'writer', writerRetryDueAt: null })

    expect(await sweep(10 * DAY)).toBe(0)

    expect(queued()).toEqual([])
  })

  it('asks only for the newest ready version when an older rules-only version is due too', async () => {
    await rulesBuilt()
    setClock(MINUTE)
    reverdict()
    script(throws(), throws(), throws())
    await build('verdict')
    const newest = await currentRow()
    expect(newest).toMatchObject({ source: 'rules', writerRetryDueAt: at(MINUTE + DAY) })

    expect(await sweep(10 * DAY)).toBe(1)

    expect(bodies().map((body) => body.requestKey)).toEqual([`writer-retry:${newest.id}`])
  })

  it('asks for nothing when routines are switched off', async () => {
    await rulesBuilt()
    service = new RoutineService({ ...deps, enabled: false })

    expect(await sweep(DAY)).toBe(0)

    expect(queued()).toEqual([])
  })

  it('asks for at most 200 profiles a run', async () => {
    const base = await rulesBuilt()
    // 201 more profiles with a rules-only routine due at the same time: 202 are due in all.
    for (let i = 0; i <= 200; i++) {
      world.profiles.set(`profile-${i}`, `user-${i}`)
      await repository.append({ ...base, id: `version-due-${i}`, profileId: `profile-${i}`, createdAt: at(i * SECOND), readyAt: at(i * SECOND) })
    }

    expect(await sweep(DAY)).toBe(200)

    expect(jobs.enqueued).toHaveLength(200)
    expect(new Set(bodies().map((body) => body.profileId)).size).toBe(200)
  })
})

describe('RoutineService.sweep: a recommended product retired since the routine was built', () => {
  it('asks for a rebuild of the routine in force when a product it recommends was retired in a later catalog version', async () => {
    const row = await firstBuild()
    expect(row).toMatchObject({ catalogVersion: 42 })
    expect(shapeOf(row).map((step) => step.product)).toContainEqual({ kind: 'candidate', code: 'SERUM-1' })
    await repository.retireCode('SERUM-1', 43)

    expect(await sweep(HOUR)).toBe(1)

    expect(queued()).toEqual([{ job: 'build-routine', body: { profileId: AMARA_PROFILE, reason: 'catalog-retired', requestKey: `catalog-retired:${row.id}`, requestedAt: at(HOUR).getTime(), waits: 0 } }])
  })

  it.each([
    ['in the catalog version the routine was built under', 42],
    ['in an earlier catalog version', 41],
  ])('asks for nothing when the product was retired %s', async (_when, retiredIn) => {
    await firstBuild()
    await repository.retireCode('SERUM-1', retiredIn)

    expect(await sweep(HOUR)).toBe(0)

    expect(queued()).toEqual([])
  })

  it('asks for nothing when the retired product is not one the routine recommends', async () => {
    await firstBuild()
    await repository.retireCode('SERUM-2', 43)

    expect(await sweep(HOUR)).toBe(0)

    expect(queued()).toEqual([])
  })

  it('asks for nothing once the routine was rebuilt under the catalog that retired the product', async () => {
    await firstBuild()
    catalogVersion = 43
    retireSerum1()
    await repository.retireCode('SERUM-1', 43)
    await sweep(HOUR)
    expect(queued()).toHaveLength(1)
    await run(queuedBody())
    const rebuilt = await currentRow()
    expect(rebuilt).toMatchObject({ catalogVersion: 43 })
    expect(shapeOf(rebuilt).map((step) => step.product)).not.toContainEqual({ kind: 'candidate', code: 'SERUM-1' })

    expect(await sweep(2 * HOUR)).toBe(0)

    expect(queued()).toHaveLength(1)
  })

  it('asks for nothing when routines are switched off', async () => {
    await firstBuild()
    await repository.retireCode('SERUM-1', 43)
    service = new RoutineService({ ...deps, enabled: false })

    expect(await sweep(HOUR)).toBe(0)

    expect(queued()).toEqual([])
  })
})

describe('RoutineService.build: outcome hints', () => {
  // hintsShown(routineId) is false for about one id in ten, by hash. These two ids were found by hashing, and are checked here so that a change of hash fails loudly.
  const SHOWN_ID = 'version-1'
  const HIDDEN_ID = 'hidden-6'
  const GROUP = { goal: 'fade-dark-marks', skinType: 'combination', country: 'NG' } as const
  // 40 similar users, of whom 30 saw it fainter and 10 flared or stopped: a net fainter score of (30 - 10) / 40 = 0.5.
  const GOOD = { n: 40, fainter: 30, flared: 2, flaredOrStopped: 10, fainterAndFlaredOrStopped: 4 }
  // Under 30 users: no hint to quote.
  const FEW = { n: 10, fainter: 6, flared: 0, flaredOrStopped: 1, fainterAndFlaredOrStopped: 0 }
  // More users saw it fainter than there are users: no such group exists.
  const CORRUPT = { n: 10, fainter: 11, flared: 0, flaredOrStopped: 0, fainterAndFlaredOrStopped: 0 }

  const withId = (id: string) => {
    service = new RoutineService({ ...deps, newId: () => id })
  }
  const hintsOf = (step: RoutineStep) => Object.fromEntries(writer.calls[0]!.gaps.find((gap) => gap.step === step)!.candidates.map((c) => [c.code, c.outcomeHint]))

  it('is checked that the fixture ids fall on the sides they are used for', () => {
    expect(hintsShown(SHOWN_ID)).toBe(true)
    expect(hintsShown(HIDDEN_ID)).toBe(false)
  })

  it('gives the writer each candidate\'s hint from the counts of the profile\'s group, when the routine shows hints', async () => {
    withId(SHOWN_ID)
    await outcomeCounts.upsert(GROUP, 'SERUM-1', GOOD, T0)
    await outcomeCounts.upsert(GROUP, 'SERUM-2', FEW, T0)

    await build('first')

    expect(writer.calls[0]!.hintsShown).toBe(true)
    const treat = hintsOf('treat')
    expect(treat['SERUM-1']).toMatchObject({ n: 40 })
    expect(treat['SERUM-1']!.netFainter).toBeCloseTo(0.5, 10)
    // Too few users, and no row at all: no hint.
    expect(treat['SERUM-2']).toBeNull()
    expect(hintsOf('moisturise')['MOIST-1']).toBeNull()
  })

  it('records on the version whether hints were shown', async () => {
    withId(SHOWN_ID)
    await build('first')
    expect((await latestRow()).hintsShown).toBe(true)
  })

  it('reads the counts once, for the group of the goal, the skin type and the shopping country, and for the codes of every gap candidate', async () => {
    withId(SHOWN_ID)
    const read = vi.spyOn(outcomeCounts, 'counts')

    await build('first')

    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![0]).toEqual(GROUP)
    expect([...read.mock.calls[0]![1]].sort()).toEqual(['MOIST-1', 'SERUM-1', 'SERUM-2', 'SPF-1'])
  })

  it('reads the group of users with no face scan when the profile has no skin type', async () => {
    withId(SHOWN_ID)
    world.seen = { ...world.seen, skinType: null }
    await outcomeCounts.upsert({ ...GROUP, skinType: null }, 'SERUM-1', GOOD, T0)
    await outcomeCounts.upsert(GROUP, 'SERUM-2', GOOD, T0)

    await build('first')

    expect(hintsOf('treat')['SERUM-1']).toMatchObject({ n: 40 })
    expect(hintsOf('treat')['SERUM-2']).toBeNull()
  })

  it('reads the group of the shopping country, and never another country\'s counts', async () => {
    withId(SHOWN_ID)
    world.shopping = { country: 'GH', budgetBand: 'mid' }
    await outcomeCounts.upsert(GROUP, 'SPF-1', GOOD, T0)
    await outcomeCounts.upsert({ ...GROUP, country: 'GH' }, 'SPF-1', { n: 50, fainter: 40, flared: 0, flaredOrStopped: 5, fainterAndFlaredOrStopped: 0 }, T0)

    await build('first')

    expect(hintsOf('protect')['SPF-1']).toMatchObject({ n: 50 })
    expect(hintsOf('protect')['SPF-1']!.netFainter).toBeCloseTo(0.7, 10)
  })

  it('reads no counts and gives the writer no hint, when the routine is one of the tenth that shows none', async () => {
    withId(HIDDEN_ID)
    await outcomeCounts.upsert(GROUP, 'SERUM-1', GOOD, T0)
    const read = vi.spyOn(outcomeCounts, 'counts')

    await build('first')

    expect(read).not.toHaveBeenCalled()
    expect(writer.calls[0]!.hintsShown).toBe(false)
    expect(Object.values(hintsOf('treat'))).toEqual([null, null])
    expect((await latestRow()).hintsShown).toBe(false)
  })

  it('costs one hint and not the routine when a counts row is corrupt: the others are kept, and the code (never the numbers) is logged', async () => {
    withId(SHOWN_ID)
    await outcomeCounts.upsert(GROUP, 'SERUM-1', GOOD, T0)
    await outcomeCounts.upsert(GROUP, 'SERUM-2', CORRUPT, T0)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(await build('first')).toBe('built')

    expect(hintsOf('treat')['SERUM-1']).toMatchObject({ n: 40 })
    expect(hintsOf('treat')['SERUM-2']).toBeNull()
    expect(log).toHaveBeenCalledWith({ outcome: 'hint-counts-corrupt', profileId: AMARA_PROFILE, code: 'SERUM-2' })
    expect(await currentRow()).toMatchObject({ status: 'ready', source: 'writer' })
  })

  it('mints the version\'s id before the skeleton and gives that same id to the version it appends', async () => {
    const minted: string[] = []
    service = new RoutineService({ ...deps, newId: () => (minted.push(`minted-${minted.length + 1}`), minted.at(-1)!) })
    let idWhenWriting = ''
    writer.hook = async () => {
      idWhenWriting = (await repository.latest(AMARA_PROFILE))!.id
    }

    await build('first')

    expect(minted).toEqual(['minted-1'])
    expect(idWhenWriting).toBe('minted-1')
    expect((await latestRow()).id).toBe('minted-1')
  })
})

// ---- PR 3d: guests never trigger a build, a stale read settles, honest hintsShown, a counts failure costs no build (spec #189) ----
//
// New on the deps: profiles.find answers { id, userId, ownerStatus: 'anonymous' | 'verified' }, the status of the profile's owner. Only a verified owner gets a routine:
//   request / the sweeps' asks / requestIfStale: do nothing at all for a guest (no claim, nothing queued, the verdict not even read for the stale read);
//   build: answers 'waiting' for a guest, appending nothing and calling no writer, and logs { outcome: 'routine-not-verified', profileId }.
// New on the repository: setRoutineFingerprint(id, fingerprint), which a build that ends 'unchanged' calls on the routine in force.

const asGuest = () => world.guests.add(AMARA_USER)

describe('RoutineService: a guest never gets a routine built', () => {
  it('queues nothing and claims nothing when a guest\'s verdict save asks for a build, whatever the reason', async () => {
    asGuest()

    for (const [reason, key] of [['verdict', 'verdict-fp-1'], ['first', 'first'], ['review-point', 'review-point:scan-1']] as const) await service.request(AMARA_PROFILE, reason, key)

    expect(queued()).toEqual([])
    expect(await repository.findRequest(AMARA_PROFILE)).toBeNull()
  })

  it('still queues the build of a verified account', async () => {
    await service.request(AMARA_PROFILE, 'verdict', 'verdict-fp-1')

    expect(queued()).toHaveLength(1)
  })

  it('asks for nothing on a stale read of a guest, and does not read the verdict for it', async () => {
    asGuest()
    const savedFor = vi.spyOn(deps.verdicts, 'savedFor')
    service = new RoutineService(deps)

    await expect(requestIfStale()).resolves.toBeUndefined()

    expect(queued()).toEqual([])
    expect(await repository.findRequest(AMARA_PROFILE)).toBeNull()
    expect(savedFor).not.toHaveBeenCalled()
  })

  it('answers waiting for a guest with a ready verdict, appending nothing, calling no writer and logging only the id', async () => {
    asGuest()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(await build('first')).toBe('waiting')

    expect(await repository.latest(AMARA_PROFILE)).toBeNull()
    expect(writer.calls).toEqual([])
    expect(log).toHaveBeenCalledWith({ outcome: 'routine-not-verified', profileId: AMARA_PROFILE })
  })

  it('does not build for a guest when the queue runs an old message, and gives the claim back', async () => {
    await service.request(AMARA_PROFILE, 'verdict', 'verdict-fp-1')
    const body = queuedBody()
    asGuest()

    await run(body)

    expect(writer.calls).toEqual([])
    expect(await repository.latest(AMARA_PROFILE)).toBeNull()
  })

  it('queues nothing from the sweeps for a guest: not a writer retry due, not a retired code, not a dead-letter retry', async () => {
    setClock(0)
    await started()
    removeShelfProduct('entry-a')
    script(throws(), throws(), throws())
    setClock(2 * DAY + HOUR)
    await build('shelf')
    expect((await currentRow()).writerRetryDueAt).not.toBeNull()
    await repository.retireCode('SERUM-1', 43)
    await repository.claim(AMARA_PROFILE, 'review-point:scan-1', at(DAY), at(0))
    await repository.setRequestRetry(AMARA_PROFILE, { retried: true, retryDueAt: at(2 * DAY) })
    asGuest()
    const before = jobs.enqueued.length

    expect(await sweep(5 * DAY)).toBe(0)

    expect(jobs.enqueued).toHaveLength(before)
    // The guest's retry is dropped rather than left due, where it would take one of the 200 places of every run.
    expect(await repository.findRequest(AMARA_PROFILE)).toMatchObject({ requestKey: 'review-point:scan-1', retryDueAt: null })
  })

  it('sweeps a verified account as before', async () => {
    setClock(0)
    await firstBuild()
    await repository.retireCode('SERUM-1', 43)

    expect(await sweep(HOUR)).toBe(1)
  })

  it('builds for a verified account (the profile read says verified)', async () => {
    expect(await build('first')).toBe('built')
  })
})

describe('RoutineService.requestIfStale: after a build that found nothing to change', () => {
  // Start, then a shelf product the verdict has no step for: the inputs' fingerprint moves, and the routine does not.
  const droppedProduct = () => {
    addProduct('entry-c', CLEAN, { name: 'Spare Toner' })
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-c', { kind: 'keep' }, null)])
  }

  it('records the new fingerprint on the routine in force when the rebuild is unchanged, and so asks for nothing the next time', async () => {
    const before = await started()
    droppedProduct()
    await requestIfStale()
    expect(queued()).toHaveLength(1)
    const key = queuedBody().requestKey
    expect(key).not.toBe(before.routineFingerprint)

    await run(queuedBody())

    expect(attempts).toBe(1)
    // Only the fingerprint and the shelf counts under it change: the spare toner now on the shelf is one more product kept.
    expect(await currentRow()).toEqual({ ...before, routineFingerprint: key, shelfCounts: { ...before.shelfCounts!, keep: before.shelfCounts!.keep + 1 } })
    await requestIfStale()
    expect(queued()).toHaveLength(1)
  })

  it('answers unchanged and records the fingerprint of the build itself', async () => {
    const before = await started()
    droppedProduct()
    setClock(3 * DAY)

    expect(await build('verdict')).toBe('unchanged')

    expect((await currentRow()).routineFingerprint).not.toBe(before.routineFingerprint)
    expect((await currentRow()).routineFingerprint).toBe(await routineFingerprint({
      goal: 'fade-dark-marks',
      cautions: ['tapering', 'recent-reaction'],
      products: [
        { entryId: 'entry-a', verdict: { kind: 'keep' }, step: 'cleanse' },
        { entryId: 'entry-b', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, step: 'treat' },
        { entryId: 'entry-c', verdict: { kind: 'keep' }, step: null },
      ],
      rulesVersion: ROUTINE_RULES_VERSION,
    }))
  })

  it('records the counts of the shelf as it is now with the fingerprint, so the summary counts the product that joined it', async () => {
    const before = await started()
    expect(before.shelfCounts).toEqual({ keep: 1, reduce: 0, drop: 0, stop: 1 })
    droppedProduct()
    setClock(3 * DAY)

    expect(await build('verdict')).toBe('unchanged')

    expect((await currentRow()).shelfCounts).toEqual({ keep: 2, reduce: 0, drop: 0, stop: 1 })
  })

  it('writes the counts before the fingerprint, so a failure between them leaves the fingerprint unrecorded and the next attempt records both', async () => {
    const before = await started()
    droppedProduct()
    setClock(3 * DAY)
    vi.spyOn(repository, 'setShelfCounts').mockRejectedValueOnce(new Error('d1 down'))

    await expect(build('verdict')).rejects.toThrow('d1 down')

    expect(await currentRow()).toEqual(before)

    expect(await build('verdict')).toBe('unchanged')

    expect(await currentRow()).toMatchObject({ shelfCounts: { keep: 2, reduce: 0, drop: 0, stop: 1 } })
    expect((await currentRow()).routineFingerprint).not.toBe(before.routineFingerprint)
  })

  it('gives a routine built before the column its counts on an unchanged rebuild, though its fingerprint is the build\'s already', async () => {
    const before = await started()
    // An old routine in force: the same routine and fingerprint, no counts.
    await repository.append({ ...structuredClone(before), id: 'version-old', shelfCounts: null, createdAt: at(3 * DAY), readyAt: at(3 * DAY) })
    expect((await currentRow()).shelfCounts).toBeNull()
    const set = vi.spyOn(repository, 'setRoutineFingerprint')
    setClock(4 * DAY)

    expect(await build('verdict')).toBe('unchanged')

    expect(await currentRow()).toMatchObject({ id: 'version-old', shelfCounts: { keep: 1, reduce: 0, drop: 0, stop: 1 }, routineFingerprint: before.routineFingerprint })
    expect(set).not.toHaveBeenCalled()
  })

  it('leaves the fingerprint alone when it is already the build\'s', async () => {
    const before = await started()
    const set = vi.spyOn(repository, 'setRoutineFingerprint')
    const setCounts = vi.spyOn(repository, 'setShelfCounts')

    expect(await build('verdict')).toBe('unchanged')

    expect(set).not.toHaveBeenCalled()
    expect(setCounts).not.toHaveBeenCalled()
    expect(await currentRow()).toEqual(before)
  })
})

describe('RoutineService.requestIfStale: while the routine cannot be built yet', () => {
  it('asks for nothing for a verified account with a ready verdict and no shopping country, however often it is read', async () => {
    world.shopping = null

    await requestIfStale()
    await requestIfStale()

    expect(queued()).toEqual([])
    expect(await repository.findRequest(AMARA_PROFILE)).toBeNull()
  })

  it('asks as soon as the country is set', async () => {
    world.shopping = null
    await requestIfStale()
    world.shopping = { country: 'NG', budgetBand: 'mid' }

    await requestIfStale()

    expect(queued()).toHaveLength(1)
  })

  it('logs nothing as a failure for the missing country', async () => {
    world.shopping = null
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await requestIfStale()

    expect(error).not.toHaveBeenCalled()
  })
})

describe('RoutineService.build: hintsShown is recorded only when the writer saw the hints', () => {
  const SHOWN_ID = 'version-1'
  const HIDDEN_ID = 'hidden-6'
  const withId = (id: string) => {
    service = new RoutineService({ ...deps, newId: () => id })
  }

  it('is true for a version the writer wrote from the hinted skeleton, and is the same the writer was given', async () => {
    withId(SHOWN_ID)

    await build('first')

    expect(writer.calls[0]!.hintsShown).toBe(true)
    expect(await latestRow()).toMatchObject({ source: 'writer', hintsShown: true })
  })

  it('is false when the rules wrote the routine after three failed tries, though the writer was called', async () => {
    withId(SHOWN_ID)
    script(throws(), throws(), throws())

    await build('first')

    expect(await latestRow()).toMatchObject({ source: 'rules', writerCalls: 3, hintsShown: false })
  })

  it('is false when the daily limit sent the build to the rules alone', async () => {
    for (let i = 0; i < 5; i++) {
      setClock(i * MINUTE)
      await build('shelf')
    }
    // The sixth build's id is one of the nine tenths that show hints, so only the daily limit keeps the hints from the writer.
    expect(hintsShown('version-7')).toBe(true)
    withId('version-7')
    setClock(10 * MINUTE)

    await build('shelf')

    expect(await latestRow()).toMatchObject({ source: 'rules', writerCalls: 0, hintsShown: false })
  })

  it('is false for a build after Start that rewrote nothing and only kept the routine with new cautions', async () => {
    await started()
    world.safety = { ...world.safety, view: safetyView(['reaction', 'pregnant']) }
    setClock(3 * DAY)

    expect(await build('safety')).toBe('built')

    expect(await latestRow()).toMatchObject({ source: 'rules', writerCalls: 0, hintsShown: false })
  })

  it('is false for the copy that "I got it" makes of a routine whose writer saw hints', async () => {
    await firstBuild()
    expect(await currentRow()).toMatchObject({ hintsShown: true })

    await gotIt('treat')

    expect(await latestRow()).toMatchObject({ reason: 'got-it', writerCalls: 0, hintsShown: false })
  })

  it('is false when the routine is one of the tenth that shows no hints', async () => {
    withId(HIDDEN_ID)

    await build('first')

    expect(await latestRow()).toMatchObject({ source: 'writer', hintsShown: false })
  })
})

describe('RoutineService.build: the outcome counts are only hints', () => {
  it('builds without hints when the counts cannot be read, logging the id and nothing else, and records that none were shown', async () => {
    vi.spyOn(outcomeCounts, 'counts').mockRejectedValue(new Error('the database is down'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(await build('first')).toBe('built')

    expect(log).toHaveBeenCalledWith({ outcome: 'hint-counts-failed', profileId: AMARA_PROFILE })
    expect(writer.calls[0]!.hintsShown).toBe(false)
    expect(writer.calls[0]!.gaps.flatMap((gap) => gap.candidates.map((c) => c.outcomeHint))).toSatisfy((hints: unknown[]) => hints.every((hint) => hint === null))
    expect(await latestRow()).toMatchObject({ status: 'ready', source: 'writer', hintsShown: false })
  })
})

// ---- changedOn: the day each step's product last changed (spec #233, PR 4a) ----
// A fact the routine starts recording for the skin-care module (which must tell a reaction to a product the person has just started from one to an old habit). It is a calendar
// date (the UTC midnight of the person's local day, as the step-down dates are) in a JSON column, so there is no migration. Null means day 1. Before Start every step's is null.
// After Start a step that is new (the writer or the rules re-picked it: `fixedFrom` null) is stamped with the local date of the rebuild, and never earlier than day 1; a step the merge
// kept (fixed) carries its own through. "I got it" stamps the step whose product has just arrived. A copy that changes no product (got-it, cautions only) keeps every other step's.
// Start is tapped on the 17th (T0 + 2 days), so day 1 is the 18th; the helpers below name the calendar dates as offsets from T0's day.
const T0_DAY = new Date(Date.UTC(T0.getUTCFullYear(), T0.getUTCMonth(), T0.getUTCDate()))
/** The UTC midnight `days` calendar days after T0's day: how a stored date is written. */
const dateAt = (days: number) => new Date(T0_DAY.getTime() + days * DAY)
const DAY_ONE = dateAt(3)
const changedOnOf = (row: Row) => row.steps.map((entry) => entry.changedOn)

describe('RoutineService.build: changedOn before Start', () => {
  it('is null on every step of the first build, and of a rebuild before Start: null means day 1', async () => {
    const first = await firstBuild()
    expect(changedOnOf(first)).toEqual([null, null, null, null])
    removeShelfProduct('entry-a')
    setClock(HOUR)

    expect(await build('shelf')).toBe('built')

    const row = await latestRow()
    expect(row.steps[0]).toMatchObject({ step: 'cleanse', product: { kind: 'candidate', code: 'CLEANSER-1' } })
    expect(changedOnOf(row)).toEqual([null, null, null, null])
  })

  it('stays null on a step the rules fill in when the writer fails three times before Start', async () => {
    script(throws(), throws(), throws())

    await firstBuild()

    expect(changedOnOf(await currentRow())).toEqual([null, null, null, null])
  })
})

describe('RoutineService.build: changedOn after Start', () => {
  it('stamps the step the writer re-picks with the local date of the rebuild, and leaves every step the merge kept as it was', async () => {
    const before = await started()
    removeShelfProduct('entry-a')
    setClock(4 * DAY + HOUR)

    expect(await build('shelf')).toBe('built')

    const row = await latestRow()
    expect(row.steps[0]).toMatchObject({ step: 'cleanse', fixedFrom: null })
    expect(row.steps[0]!.changedOn).toEqual(dateAt(4))
    expect(row.steps.slice(1).map((entry) => [entry.fixedFrom, entry.changedOn])).toEqual(before.steps.slice(1).map((entry) => [before.id, entry.changedOn]))
  })

  it('stamps a step the rules pick when the writer fails three times, as it does one the writer picks', async () => {
    await started()
    removeShelfProduct('entry-a')
    script(throws(), throws(), throws())
    setClock(4 * DAY + HOUR)

    expect(await build('shelf')).toBe('built')

    const row = await latestRow()
    expect(row).toMatchObject({ source: 'rules' })
    expect(changedOnOf(row)).toEqual([dateAt(4), null, null, null])
  })

  it('carries the date a step already has through a later rebuild that changes another step', async () => {
    await started()
    removeShelfProduct('entry-a')
    setClock(4 * DAY + HOUR)
    await build('shelf')
    setClock(6 * DAY + HOUR)

    expect(await build('sold-here', { exclude: { step: 'treat', code: 'SERUM-1' } })).toBe('built')

    const row = await latestRow()
    expect(row.steps.map((entry) => [entry.step, entry.fixedFrom === null])).toEqual([['cleanse', false], ['treat', true], ['moisturise', false], ['protect', false]])
    expect(changedOnOf(row)).toEqual([dateAt(4), dateAt(6), null, null])
  })

  // Day 1 is the 18th. A rebuild on the 17th (after the tap, before day 1) stamps the 18th, never the day before the routine began; the 18th is the first day it is stamped as itself.
  it.each([
    ['an hour after the tap, the day before day 1', 2 * DAY + HOUR, DAY_ONE],
    ['the last millisecond before day 1 begins', 2 * DAY + 12 * HOUR - 1, DAY_ONE],
    ['the first millisecond of day 1', 2 * DAY + 12 * HOUR, DAY_ONE],
    ['the last millisecond of day 1', 3 * DAY + 12 * HOUR - 1, DAY_ONE],
    ['the first millisecond of day 2', 3 * DAY + 12 * HOUR, dateAt(4)],
  ])('stamps %s with the right date, never earlier than day 1', async (_when, offset, expected) => {
    await started()
    removeShelfProduct('entry-a')
    setClock(offset)

    await build('shelf')

    expect((await latestRow()).steps[0]!.changedOn).toEqual(expected)
  })

  it('stamps the local date in the stored time zone, not the UTC date', async () => {
    world.zone = LAGOS
    await started()
    removeShelfProduct('entry-a')
    // 2030-06-18 23:30 UTC is 00:30 on the 19th in Lagos (UTC+1): the UTC date would be a day early.
    setClock(3 * DAY + 11 * HOUR + 30 * MINUTE)

    await build('shelf')

    expect((await latestRow()).steps[0]!.changedOn).toEqual(dateAt(4))
  })

  it('keeps every date through a rebuild that changes only a step-down: the copy is made without a writer', async () => {
    await started()
    removeShelfProduct('entry-a')
    setClock(4 * DAY + HOUR)
    await build('shelf')
    const before = await currentRow()
    saveVerdict(productsOfVerdict().map((p) => (p.entryId === 'entry-b' ? { ...p, verdict: { kind: 'stop' as const, taperTemplateId: 'TPR-STEROID-2' } } : p)))
    setClock(5 * DAY + HOUR)

    expect(await build('verdict')).toBe('built')

    const row = await latestRow()
    expect(row).toMatchObject({ writerCalls: 0, reason: 'verdict' })
    expect(changedOnOf(row)).toEqual(changedOnOf(before))
    expect(changedOnOf(row)).toEqual([dateAt(4), null, null, null])
  })

  it('reads a routine stored before the field existed as null on every step, and carries null through a rebuild that keeps those steps', async () => {
    const before = await started()
    // The version in force is one an older build wrote: its steps have no changedOn at all.
    const legacySteps = before.steps.map(({ changedOn: _changedOn, ...entry }) => entry) as unknown as Row['steps']
    await repository.append({ ...before, id: 'version-legacy', createdAt: at(2 * DAY + 30 * MINUTE), readyAt: at(2 * DAY + 30 * MINUTE), steps: legacySteps })
    expect(changedOnOf(await currentRow())).toEqual([null, null, null, null])
    removeShelfProduct('entry-a')
    setClock(4 * DAY + HOUR)

    await build('shelf')

    const row = await latestRow()
    expect(row.steps.slice(1).map((entry) => [entry.fixedFrom, entry.changedOn])).toEqual([
      ['version-legacy', null],
      ['version-legacy', null],
      ['version-legacy', null],
    ])
    expect(row.steps[0]!.changedOn).toEqual(dateAt(4))
  })
})

describe('RoutineService.build: changedOn when a step is written again with the same product', () => {
  // The expectation names a condition, so the gates fail the routine as a whole and nothing is kept: every step comes back from the writer.
  const WHOLE_FAILURE = 'Most people with rosacea see a change in 8 to 12 weeks.'
  /** A routine in force that a whole-routine rebuild follows: the version `before`, with these dates on its steps and an expectation the gates refuse. */
  const failingWholeWith = async (before: Row, dates: (Date | null)[]) => {
    await repository.append({ ...before, id: 'version-failing', createdAt: at(2 * DAY + 30 * MINUTE), readyAt: at(2 * DAY + 30 * MINUTE), expectation: WHOLE_FAILURE, steps: before.steps.map((entry, i) => ({ ...entry, changedOn: dates[i]! })) })
  }
  const swapsTreatTo = (code: string): Answer => (skeleton) => {
    const routine = routineFrom(skeleton, 'Written')
    return { ...routine, steps: routine.steps.map((entry) => (entry.step === 'treat' ? { ...entry, product: { kind: 'candidate' as const, code }, frequency: 'alternate-days' as const } : entry)) }
  }

  it('keeps the date of each step the writer picks again with the same product, null (day 1) included, and stamps only the step whose product changed', async () => {
    const before = await started()
    await failingWholeWith(before, [null, dateAt(4), dateAt(5), null])
    script(swapsTreatTo('SERUM-2'))
    setClock(6 * DAY + HOUR)

    expect(await build('shelf')).toBe('built')

    const row = await latestRow()
    expect(row.steps.map((entry) => entry.fixedFrom)).toEqual([null, null, null, null])
    expect(shapeOf(row).map(({ step, product }) => [step, product])).toEqual([
      ['cleanse', before.steps[0]!.product],
      ['treat', { kind: 'candidate', code: 'SERUM-2' }],
      ['moisturise', before.steps[2]!.product],
      ['protect', before.steps[3]!.product],
    ])
    expect(changedOnOf(row)).toEqual([null, dateAt(6), dateAt(5), null])
  })

  it('keeps the date of every step when the whole routine is written again and no product changed', async () => {
    const before = await started()
    await failingWholeWith(before, [dateAt(3), dateAt(4), dateAt(5), null])
    setClock(6 * DAY + HOUR)

    expect(await build('shelf')).toBe('built')

    const row = await latestRow()
    expect(row.steps.map((entry) => entry.fixedFrom)).toEqual([null, null, null, null])
    expect(shapeOf(row).map(({ product }) => product)).toEqual(before.steps.map((entry) => entry.product))
    expect(changedOnOf(row)).toEqual([dateAt(3), dateAt(4), dateAt(5), null])
  })

  it('keeps the date of a recommended product the person has got when the writer picks it as their own shelf entry: it is the same product, not a change', async () => {
    const before = await started()
    await gotIt('treat')
    const gotItVersion = await currentRow()
    await repository.append({ ...gotItVersion, id: 'version-failing', createdAt: at(2 * DAY + 45 * MINUTE), readyAt: at(2 * DAY + 45 * MINUTE), expectation: WHOLE_FAILURE, steps: gotItVersion.steps.map((entry) => (entry.step === 'treat' ? { ...entry, changedOn: dateAt(4) } : entry)) })
    addProduct('entry-s', ['Aqua', 'Niacinamide'], { productId: 'prod-SERUM-1', name: 'Name SERUM-1', brand: 'Brand SERUM-1' })
    world.entries = world.entries.map((entry) => (entry.id === 'entry-s' && entry.kind === 'product' ? { ...entry, productId: 'prod-SERUM-1' } : entry))
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-s', { kind: 'keep' }, 'treat')])
    setClock(6 * DAY + HOUR)

    expect(await build('verdict')).toBe('built')

    const row = await latestRow()
    expect(row.steps[1]).toMatchObject({ step: 'treat', product: { kind: 'shelf', id: 'entry-s' }, fixedFrom: null })
    expect(row.steps[1]!.changedOn).toEqual(dateAt(4))
    expect(before.steps[1]!.product).toEqual({ kind: 'candidate', code: 'SERUM-1' })
  })
})

describe('RoutineService.gotIt: changedOn', () => {
  it('stamps the step whose product has just arrived with the local date of the tap, and leaves every other step\'s date as it was', async () => {
    await started()
    removeShelfProduct('entry-a')
    setClock(4 * DAY + HOUR)
    await build('shelf')
    const before = await currentRow()
    setClock(6 * DAY + HOUR)

    await gotIt('treat')

    const row = await currentRow()
    expect(row).toMatchObject({ reason: 'got-it' })
    expect(row.steps.map((entry) => entry.gotIt)).toEqual([false, true, false, false])
    expect(changedOnOf(row)).toEqual([dateAt(4), dateAt(6), null, null])
    expect(changedOnOf(before)).toEqual([dateAt(4), null, null, null])
  })

  it('stamps no earlier than day 1 when it is tapped between Start and day 1', async () => {
    await started()
    setClock(2 * DAY + HOUR)

    await gotIt('treat')

    expect(changedOnOf(await currentRow())).toEqual([null, DAY_ONE, null, null])
  })

  it('stamps the local date in the stored time zone', async () => {
    world.zone = LAGOS
    await started()
    setClock(3 * DAY + 11 * HOUR + 30 * MINUTE)

    await gotIt('treat')

    expect((await currentRow()).steps[1]!.changedOn).toEqual(dateAt(4))
  })

  it('leaves it null before Start: every step is day 1 until the routine begins', async () => {
    await firstBuild()
    setClock(HOUR)

    await gotIt('treat')

    const row = await currentRow()
    expect(row.steps.map((entry) => entry.gotIt)).toEqual([false, true, false, false])
    expect(changedOnOf(row)).toEqual([null, null, null, null])
  })

  it('reads no time zone before Start, where the stamp is null whatever the day is', async () => {
    await firstBuild()
    setClock(HOUR)
    const zone = vi.spyOn(deps.reminders, 'zoneFor')

    await gotIt('treat')

    expect(zone).not.toHaveBeenCalled()
  })

  it('keeps the date when the product the person got becomes their own shelf entry at the next rebuild: it is the same product, not a change', async () => {
    await started()
    setClock(4 * DAY + HOUR)
    await gotIt('treat')
    addProduct('entry-s', ['Aqua', 'Niacinamide'], { productId: 'prod-SERUM-1', name: 'Name SERUM-1', brand: 'Brand SERUM-1' })
    world.entries = world.entries.map((entry) => (entry.id === 'entry-s' && entry.kind === 'product' ? { ...entry, productId: 'prod-SERUM-1' } : entry))
    saveVerdict([...productsOfVerdict(), verdictProduct('entry-s', { kind: 'keep' }, 'treat')])
    setClock(5 * DAY + HOUR)

    expect(await build('verdict')).toBe('built')

    const row = await latestRow()
    expect(row.steps[1]).toMatchObject({ step: 'treat', product: { kind: 'shelf', id: 'entry-s' } })
    expect(changedOnOf(row)).toEqual([null, dateAt(4), null, null])
  })
})
