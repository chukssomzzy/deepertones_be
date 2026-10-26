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
import type { ProfilesService } from '../profiles/profiles.service'
import type { SavedVerdictView, VerdictService } from '../verdicts/verdicts.service'
import type { SavedVerdictProduct } from '../verdicts/verdicts.types'
import { checkRoutine } from './routines.gates'
import type { BuildRoutineMessage } from './routines.job-specs'
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
// PR 3b adds two deps, `jobs: JobQueue` (here the MemoryJobQueue, which records each enqueue and its delay) and `enabled: boolean`, and three methods (spec #189):
//   request(profileId, reason, requestKey): Promise<void>   never throws. Disabled: does nothing at all (no claim either). Otherwise claims the build with
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
  skinConcerns: ['hd_age_spot'],
  ingredients: ['Aqua', 'Niacinamide'],
  evidenceUrls: [`https://example.org/evidence/${code}`],
  ingredientsSourceUrl: `https://example.org/ingredients/${code}`,
  keyIngredient: null,
  strength: null,
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
/** A step as the user sees it: with the bookkeeping (gotIt, fixedFrom) taken off. */
const plain = (row: Row) => row.steps.map(({ gotIt: _gotIt, fixedFrom: _fixedFrom, ...entry }) => entry)
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
      verdictReference: async () => ({ rulesVersion: 'verdict-rules-7', catalogVersion, rules: [], claimPhrases: [], tapers: { steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' } }),
    } satisfies Pick<CatalogWorkbookService, 'countries' | 'verdictReference'>,
    profiles: {
      find: async (profileId: string) => (world.profiles.has(profileId) ? { id: profileId, userId: world.profiles.get(profileId)! } : null),
    } satisfies Pick<ProfilesService, 'find'>,
    writer,
    writerIdentity: { model: 'claude-test-model', promptHash: 'prompt-hash-test' },
    repository,
    outcomeCounts,
    jobs,
    enabled: true,
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

    expect(during).toMatchObject({ status: 'pending', id: 'version-1', reason: 'first', steps: [], tapers: [], expectation: null, source: null, verdictFingerprint: 'verdict-fp-1' })
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
    expect(row).toMatchObject({ status: 'ready', source: 'rules', model: 'claude-test-model', promptHash: 'prompt-hash-test', writerCalls: 3, writerRetryDueAt: at(10 * MINUTE + DAY), reason: 'first', hintsShown: true })
    // The rules' own routine: fixed words for each step, no grounding, and the same step-down.
    expect(row.steps).toEqual([
      { step: 'cleanse', product: { kind: 'shelf', id: 'entry-a' }, frequency: 'am', reason: 'Your cleanser, used as it is.', grounding: [], gotIt: false, fixedFrom: null },
      { step: 'treat', product: { kind: 'candidate', code: 'SERUM-1' }, frequency: 'pm', reason: 'A treatment product, used at a gentle pace.', grounding: [], gotIt: false, fixedFrom: null },
      { step: 'moisturise', product: { kind: 'candidate', code: 'MOIST-1' }, frequency: 'am-pm', reason: 'A simple moisturiser that keeps the skin soft and comfortable.', grounding: [], gotIt: false, fixedFrom: null },
      { step: 'protect', product: { kind: 'candidate', code: 'SPF-1' }, frequency: 'am', reason: 'A daily sunscreen that protects the skin from the sun.', grounding: [], gotIt: false, fixedFrom: null },
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
    expect(row.steps[0]).toEqual({ step: 'cleanse', product: { kind: 'candidate', code: 'CLEANSER-1' }, frequency: 'am', reason: 'Written 2: cleanse.', grounding: [], gotIt: false, fixedFrom: null })
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
    setClock(2 * DAY + HOUR)

    expect(await build('verdict')).toBe('built')

    expect(attempts).toBe(1)
    const row = await latestRow()
    expect(row).toMatchObject({ id: 'version-2', writerCalls: 0, reason: 'verdict', startedOn: before.startedOn })
    expect(row.tapers).toEqual([{ shelfProductId: 'entry-b', templateId: 'TPR-STEROID-2', startedOn: new Date('2030-06-17T00:00:00.000Z') }])
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

  it('makes today day 1, on the routine in force and its step-downs', async () => {
    await firstBuild()
    setClock(2 * DAY + 3 * HOUR)

    await start()

    const view = await current()
    expect(view.status).toBe('ready')
    const version = (view as { version: Row }).version
    expect(version.startedOn).toBeInstanceOf(Date)
    expect(utcDay(version.startedOn!)).toBe(utcDay(clock))
    expect(version.tapers).toHaveLength(1)
    expect(version.tapers[0]!.startedOn).toEqual(version.startedOn)
  })

  it('is idempotent: starting again on a later day moves nothing and appends no version', async () => {
    await firstBuild()
    setClock(2 * DAY)
    await start()
    const afterFirstStart = await currentRow()
    setClock(5 * DAY)

    await expect(start()).resolves.toBeUndefined()

    expect(await repository.latest(AMARA_PROFILE)).toEqual(afterFirstStart)
    expect(ids).toBe(1)
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
    expect(utcDay(row.startedOn!)).toBe(utcDay(at(DAY)))
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

      await expect(request()).resolves.toBeUndefined()

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

      await expect(request()).resolves.toBeUndefined()

      expect(queued()).toEqual([])
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
    expect(utcDay(row.startedOn!)).toBe(utcDay(at(DAY)))
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
    expect(utcDay(row.startedOn!)).toBe(utcDay(at(10 * MINUTE)))
    expect(row.tapers.every((taper) => taper.startedOn !== null)).toBe(true)
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
