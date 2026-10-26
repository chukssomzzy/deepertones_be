import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PermanentJobError } from '../../jobs/job'
import { type Actor, runAs } from '../../lib/context'
import { ConflictError, UnavailableError } from '../../lib/errors'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryScanEvents } from '../../providers/scan-events/memory.scan-events'
import type { FitRequest, FitResult } from '../../providers/verdict-fitting/verdict-fitter.provider'
import { MemoryVerdictFitter } from '../../providers/verdict-fitting/memory.verdict-fitter'
import type { ShelfFacts } from '../catalog/catalog.service'
import type { TaperRow } from '../catalog/catalog.workbook.schema'
import type { CatalogWorkbookService, VerdictReference } from '../catalog/catalog.workbook.service'
import type { ProductCatalogService } from '../catalog/catalog.service'
import type { Category, RoutineStep, TaperKind } from '../catalog/catalog.vocabulary'
import type { FaceScanService } from '../face-scans/face-scans.service'
import type { Band, ShownConcern, SkinTypeLabel } from '../face-scans/face-scans.tables'
import type { GoalsService } from '../goals/goals.service'
import type { Goal } from '../goals/goals.vocabulary'
import type { SafetyService } from '../safety/safety.service'
import type { ParseState, SafetyMentionRow, SafetyView } from '../safety/safety.types'
import type { SafetyChoice } from '../safety/safety.vocabulary'
import type { NoLabelPurpose } from '../scans/scans.vocabulary'
import type { ShelfActiveEntry, ShelfService } from '../shelf/shelf.service'
import type { z } from 'zod'
import type { buildVerdictSpec } from './verdicts.job-specs'
import { FakeVerdictsRepository } from './verdicts.repository.fake'
import { VerdictService } from './verdicts.service'

// The shelf verdict's service (spec #171, D2b): `current` (what GET /me/verdict will return), `build` (the body of the build-verdict job), `requeueDueFits` (the daily
// sweep), `markFitFailed` (the dead-letter hook) and `savedFor` (what the routine, #152, reads). The other services are Pick<> fakes that answer from one mutable
// `world`, so a test changes the world (a product added, a goal changed) and reads the outcome from the queue, the repository and the service. A "ready" row is only
// ever reached the way life reaches it: current() asks, the queue message it left is handed to build().
//
// The contract this file pins:
//   new VerdictService({ repository, fitter, jobs, events, workbook, catalog, shelf, scans, safety, goals, faceScans, now }), where the services are the Pick<> of
//   what the verdict reads: workbook (verdictReference, tapersByCode, stepsFor, skinConcernsFor), catalog (shelfFacts, latestIngredients), shelf (activeEntriesFor), scans (noLabelFacts,
//   hasShelfWorkInFlight), safety (snapshotFor), goals (goalFor), faceScans (latestConcernLevelsFor). Everything is read by profile id, so build() needs no session;
//   current() uses the session's profile and throws GOAL_REQUIRED itself.
//   current()      answers { status: 'pending' } or { status: 'ready', fit: 'ready' | 'not-ready', products, tapers }; `tapers` lists, once each, the rows (retired ones
//                  included) of the step-down codes the products use, and is [] when none is used.
//   build(body)    runs the build-verdict job. requeueDueFits(now) answers how many retries it queued. markFitFailed(body) is the dead-letter hook.
//   savedFor(profileId)   answers null, or { fingerprint, fit, builtAt, rulesVersion, products }.

type BuildBody = z.infer<typeof buildVerdictSpec.schema>

// The one clock every test hangs off; later times are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)
// A pending request older than this is taken over (its build died).
const STALE_AFTER = 30 * MINUTE
const MAX_WAITS = 15
const SECRET = 'QZ7'

const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'anonymous'): Actor => ({ kind: 'user', userId, status, profileId })
const AMARA = actor('user-amara', 'profile-amara-1')
const TOLU = actor('user-tolu', 'profile-tolu-1', 'verified')
const SYSTEM: Actor = { kind: 'system', job: 'build-verdict' }
const PUBLIC: Actor = { kind: 'public' }

const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
const STEROID = ['Aqua', 'Clobetasol Propionate']
const STEROID_SOURCE = 'https://example.org/rules/clobetasol'

// ---- the world the other services answer from ----

type Rule = VerdictReference['rules'][number]
const rule = (over: Partial<Rule> & Pick<Rule, 'name' | 'kind'>): Rule => ({ aliases: [], rule: `${over.name} (test rule)`, source: null, group: null, clashesWith: [], helps: [], ...over })

const taperRow = (code: string, kind: TaperKind, status: TaperRow['status'] = 'approved'): TaperRow => ({
  code,
  kind,
  schedule: [{ fromWeek: 1, toWeek: 2, frequency: 'alternate-days' }],
  whatToExpect: 'Skin may flare for a few days after each step down.',
  seeAProfessionalIf: 'The redness spreads or the skin weeps.',
  status,
  approvedBy: 'Dr A. Reviewer',
  approvedOn: at(-3 * DAY),
  auditedBy: null,
  auditedOn: null,
})

type World = {
  reference: VerdictReference
  goal: Goal | null
  entries: ShelfActiveEntry[]
  facts: Map<string, ShelfFacts>
  noLabels: Map<string, { purpose: NoLabelPurpose; category: Category }>
  steps: Map<string, RoutineStep[]>
  /** The skin concerns the recommendation catalog gives a product, by catalog product id. */
  skinConcerns: Map<string, ShownConcern[]>
  safety: { view: SafetyView | null; parseState: ParseState | null; mentions: SafetyMentionRow[] }
  mentionIngredients: Map<string, string[]>
  scan: { skinType: SkinTypeLabel | null; concerns: { concern: ShownConcern; band: Band }[] } | null
  inFlight: boolean
  tapers: Map<string, TaperRow>
  /** The profile id every read was made for, and the codes tapersByCode was asked for. */
  profilesRead: string[]
  tapersAsked: string[][]
}

const safetyView = (choices: SafetyChoice[], over: Partial<SafetyView> = {}): SafetyView => ({
  choices,
  reactionText: null,
  prescriptionText: null,
  excludesPregnancyCaution: choices.includes('pregnant') || choices.includes('breastfeeding'),
  updatedAt: T0,
  ...over,
})

const mention = (over: Partial<SafetyMentionRow> = {}): SafetyMentionRow => ({
  id: 'mention-1',
  safetyId: 'safety-1',
  source: 'reaction',
  kind: 'ingredient',
  brand: null,
  name: 'fragrance',
  variant: null,
  category: null,
  productId: null,
  resolution: null,
  position: 0,
  createdAt: T0,
  ...over,
})

const newWorld = (): World => ({
  reference: {
    rulesVersion: 'rules-v1',
    catalogVersion: 1,
    rules: [
      rule({ name: 'niacinamide', kind: 'irritation', source: 'https://example.org/rules/niacinamide', helps: ['hd_radiance'] }),
      rule({ name: 'clobetasol propionate', aliases: ['clobetasol'], kind: 'banned-substance', group: 'steroid', source: STEROID_SOURCE }),
      rule({ name: 'hydroquinone', kind: 'restricted-substance', group: 'lightening-agent', source: 'https://example.org/rules/hydroquinone' }),
    ],
    claimPhrases: ['whitening'],
    tapers: { steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' },
  },
  goal: 'fade-dark-marks',
  entries: [],
  facts: new Map(),
  noLabels: new Map(),
  steps: new Map(),
  skinConcerns: new Map(),
  safety: { view: safetyView(['reaction'], { reactionText: 'I react to fragrance' }), parseState: 'done', mentions: [mention()] },
  mentionIngredients: new Map(),
  scan: { skinType: 'combination', concerns: [{ concern: 'hd_age_spot', band: 'some' }] },
  inFlight: false,
  tapers: new Map([
    ['TPR-STEROID-1', taperRow('TPR-STEROID-1', 'steroid')],
    ['TPR-STEROID-2', taperRow('TPR-STEROID-2', 'steroid')],
    ['TPR-LIGHTENING-1', taperRow('TPR-LIGHTENING-1', 'lightening-agent')],
  ]),
  profilesRead: [],
  tapersAsked: [],
})

let world: World
let entryCount = 0

/** Puts a product on the shelf the way the accessors give it: an active entry, and the formulation facts it points at. */
const addProduct = (id: string, ingredients: string[], over: Partial<ShelfFacts> = {}) => {
  world.entries.push({ id, kind: 'product', addedAt: at(entryCount++ * MINUTE), productId: `prod-${id}`, formulationId: `form-${id}` })
  world.facts.set(`form-${id}`, { productId: `prod-${id}`, brand: 'Orbis', name: `Product ${id}`, variant: null, form: 'cream', category: 'skin', ingredients, ...over })
}
const removeEntry = (id: string) => {
  world.entries = world.entries.filter((entry) => entry.id !== id)
}

let clock: Date
let repository: FakeVerdictsRepository
let fitter: MemoryVerdictFitter
let jobs: MemoryJobQueue
let events: MemoryScanEvents
let service: VerdictService

const profileOf = (who: Actor): string => (who.kind === 'user' ? who.profileId : '')

const current = (who: Actor = AMARA) => runAs(who, () => service.current())
const build = (body: BuildBody) => runAs(SYSTEM, () => service.build(body))
const markFitFailed = (body: BuildBody) => runAs(SYSTEM, () => service.markFitFailed(body))
const requeueDueFits = (now: Date) => runAs(SYSTEM, () => service.requeueDueFits(now))
const savedFor = (profileId: string, who: Actor = SYSTEM) => runAs(who, () => service.savedFor(profileId))
const setClock = (offsetMs: number) => {
  clock = at(offsetMs)
}

const queued = () => jobs.enqueued.map((e) => ({ job: e.job, body: e.body, delaySeconds: e.delaySeconds ?? 0 }))
const lastBody = (): BuildBody => jobs.enqueued.at(-1)!.body as BuildBody
const rowOf = async (who: Actor = AMARA) => (await repository.find(profileOf(who)))!
const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

/** Asks for the verdict and runs the build the ask queued: the way a row becomes ready. */
const built = async (who: Actor = AMARA) => {
  await current(who)
  await build(lastBody())
}

const openIds = (request: FitRequest) => request.shelf.filter((p) => p.floor.status === 'open').map((p) => p.id)
const helpingAll = (request: FitRequest): FitResult => ({
  products: openIds(request).map((id) => ({ id, label: 'helping' as const, reason: 'Suits the goal.', sameJobAs: null })),
  clashes: [],
})
const fitFails = (message = 'the fit judge is unavailable') =>
  fitter.respondWith(() => {
    throw new Error(message)
  })

const spyOnConsole = () => (['log', 'debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
const loggedBy = (spies: ReturnType<typeof spyOnConsole>) => spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call)))

beforeEach(() => {
  clock = T0
  entryCount = 0
  world = newWorld()
  // Amara's shelf: a serum nothing is known against (the judge decides it) and a cream with a steroid in it (the rules stop it, with the steroid step-down).
  addProduct('entry-a', CLEAN, { name: 'Calm Serum' })
  addProduct('entry-b', STEROID, { name: 'Karo Glow Cream' })
  world.steps.set('prod-entry-a', ['moisturise'])

  repository = new FakeVerdictsRepository()
  fitter = new MemoryVerdictFitter()
  fitter.respondWith(helpingAll)
  jobs = new MemoryJobQueue()
  events = new MemoryScanEvents()
  const deps = {
    repository,
    fitter,
    jobs,
    events,
    workbook: {
      verdictReference: async () => structuredClone(world.reference),
      tapersByCode: async (codes: string[]) => {
        world.tapersAsked.push(codes)
        return new Map(codes.flatMap((code): [string, TaperRow][] => (world.tapers.has(code) ? [[code, structuredClone(world.tapers.get(code)!)]] : [])))
      },
      stepsFor: async (productIds: string[]) => new Map(productIds.flatMap((id): [string, RoutineStep[]][] => (world.steps.has(id) ? [[id, [...world.steps.get(id)!]]] : []))),
      skinConcernsFor: async (productIds: string[]) =>
        new Map(productIds.flatMap((id): [string, ShownConcern[]][] => (world.skinConcerns.has(id) ? [[id, [...world.skinConcerns.get(id)!]]] : []))),
    } satisfies Pick<CatalogWorkbookService, 'verdictReference' | 'tapersByCode' | 'stepsFor' | 'skinConcernsFor'>,
    catalog: {
      shelfFacts: async (formulationIds: string[]) => new Map(formulationIds.flatMap((id): [string, ShelfFacts][] => (world.facts.has(id) ? [[id, structuredClone(world.facts.get(id)!)]] : []))),
      latestIngredients: async (productId: string) => world.mentionIngredients.get(productId) ?? null,
    } satisfies Pick<ProductCatalogService, 'shelfFacts' | 'latestIngredients'>,
    shelf: {
      activeEntriesFor: async (profileId: string) => {
        world.profilesRead.push(profileId)
        return structuredClone(world.entries)
      },
    } satisfies Pick<ShelfService, 'activeEntriesFor'>,
    scans: {
      noLabelFacts: async (itemIds: string[]) => new Map(itemIds.flatMap((id) => (world.noLabels.has(id) ? [[id, world.noLabels.get(id)!] as const] : []))),
      hasShelfWorkInFlight: async (profileId: string) => {
        world.profilesRead.push(profileId)
        return world.inFlight
      },
    },
    safety: {
      snapshotFor: async (profileId: string) => {
        world.profilesRead.push(profileId)
        return structuredClone(world.safety)
      },
    } satisfies Pick<SafetyService, 'snapshotFor'>,
    goals: {
      goalFor: async (profileId: string) => {
        world.profilesRead.push(profileId)
        return world.goal
      },
    } satisfies Pick<GoalsService, 'goalFor'>,
    faceScans: {
      latestConcernLevelsFor: async (profileId: string) => {
        world.profilesRead.push(profileId)
        return structuredClone(world.scan)
      },
    } satisfies Pick<FaceScanService, 'latestConcernLevelsFor'>,
    now: () => clock,
  }
  service = new VerdictService(deps as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('VerdictService.current: asking for the verdict', () => {
  it('answers pending, and queues one build of the shelf as it is now, the first time a profile asks', async () => {
    expect(await current()).toEqual({ status: 'pending' })

    expect(queued()).toEqual([
      { job: 'build-verdict', body: { profileId: 'profile-amara-1', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), requestedAt: T0.getTime(), waits: 0 }, delaySeconds: 0 },
    ])
    // The message names the fingerprint the pending row was claimed with.
    expect(await rowOf()).toMatchObject({ status: 'pending', fingerprint: lastBody().fingerprint, requestedAt: T0 })
  })

  it('answers pending without queuing a second build when asked again right after', async () => {
    await current()

    expect(await current()).toEqual({ status: 'pending' })
    setClock(MINUTE)
    expect(await current()).toEqual({ status: 'pending' })

    expect(jobs.enqueued).toHaveLength(1)
  })

  it('takes a pending request over, queuing it again, exactly when it is 30 minutes old, and not a millisecond before', async () => {
    await current()

    setClock(STALE_AFTER - 1)
    expect(await current()).toEqual({ status: 'pending' })
    expect(jobs.enqueued).toHaveLength(1)

    setClock(STALE_AFTER)
    expect(await current()).toEqual({ status: 'pending' })
    expect(queued()[1]).toMatchObject({ job: 'build-verdict', body: { profileId: 'profile-amara-1', requestedAt: at(STALE_AFTER).getTime(), waits: 0 }, delaySeconds: 0 })
    expect(jobs.enqueued).toHaveLength(2)
  })

  it('gives the claim back when the queue is down, so the very next ask claims and queues again, and the queue\'s own error is what the first ask fails with', async () => {
    const down = new Error('the queue is down')
    jobs.failNextWith(down)

    expect(await errorOf(current())).toBe(down)
    expect(jobs.enqueued).toEqual([])

    // One minute on: far inside the 30 minutes a live claim would hold the build back.
    setClock(MINUTE)
    expect(await current()).toEqual({ status: 'pending' })
    expect(queued()).toEqual([
      { job: 'build-verdict', body: { profileId: 'profile-amara-1', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), requestedAt: at(MINUTE).getTime(), waits: 0 }, delaySeconds: 0 },
    ])
    expect(await rowOf()).toMatchObject({ status: 'pending', fingerprint: lastBody().fingerprint, requestedAt: at(MINUTE) })
  })

  it('gives the claim back on a rebuild too: the ask after a failed queueing of a stale verdict queues the build', async () => {
    await built()
    world.goal = 'glow'
    jobs.failNextWith(new Error('the queue is down'))
    await expect(current()).rejects.toThrow('the queue is down')

    expect(await current()).toEqual({ status: 'pending' })

    expect(jobs.enqueued).toHaveLength(2)
    expect(lastBody().fingerprint).toBe((await rowOf()).fingerprint)
  })

  it('serves a guest: the verdict needs a session but not a verified account', async () => {
    expect(AMARA.kind === 'user' && AMARA.status).toBe('anonymous')

    expect(await current(AMARA)).toEqual({ status: 'pending' })
  })

  it('refuses a request with no session, writing and queuing nothing', async () => {
    expect(await errorOf(current(PUBLIC))).toMatchObject({ code: 'AUTH_REQUIRED' })

    expect(jobs.enqueued).toEqual([])
  })

  it('reads the shelf, the goal, the safety answers and the face scan of the session\'s own profile', async () => {
    await current(TOLU)

    expect(new Set(world.profilesRead)).toEqual(new Set(['profile-tolu-1']))
    expect(lastBody().profileId).toBe('profile-tolu-1')
    expect(await repository.find('profile-amara-1')).toBeNull()
  })

  describe('the step-down gate and the goal gate', () => {
    it.each<TaperKind>(['steroid', 'lightening-agent'])('answers 503 VERDICT_UNAVAILABLE, writing and queuing nothing, when no step-down template is approved for %s', async (kind) => {
      delete world.reference.tapers[kind]

      const error = await errorOf(current())

      expect(error).toBeInstanceOf(UnavailableError)
      expect(error).toMatchObject({ code: 'VERDICT_UNAVAILABLE' })
      expect(await repository.find('profile-amara-1')).toBeNull()
      expect(jobs.enqueued).toEqual([])
    })

    it('answers 409 GOAL_REQUIRED, writing and queuing nothing, when the profile has no goal', async () => {
      world.goal = null

      const error = await errorOf(current())

      expect(error).toBeInstanceOf(ConflictError)
      expect(error).toMatchObject({ code: 'GOAL_REQUIRED' })
      expect(await repository.find('profile-amara-1')).toBeNull()
      expect(jobs.enqueued).toEqual([])
    })

    it('checks the step-down gate before the goal: with neither, it is VERDICT_UNAVAILABLE', async () => {
      delete world.reference.tapers.steroid
      world.goal = null

      expect(await errorOf(current())).toMatchObject({ code: 'VERDICT_UNAVAILABLE' })
    })
  })
})

describe('VerdictService.build: a verdict from the shelf', () => {
  it('judges the open products with the fit judge, merges its answer under the rules\' labels and saves the verdict as ready', async () => {
    await current()
    setClock(2 * MINUTE)

    await build(lastBody())

    // The judge was asked once, about the one open product, with the steroid cream as context.
    expect(fitter.calls).toHaveLength(1)
    expect(fitter.calls[0]).toMatchObject({ goal: { id: 'fade-dark-marks' }, skinType: 'combination' })
    expect(fitter.calls[0]!.shelf.map((p) => [p.id, p.floor])).toEqual([
      ['entry-a', { status: 'open' }],
      ['entry-b', { status: 'fixed', group: 'likely-the-problem' }],
    ])
    expect(await current()).toMatchObject({
      status: 'ready',
      fit: 'ready',
      products: [
        { entryId: 'entry-a', group: 'helping', verdict: { kind: 'keep' } },
        { entryId: 'entry-b', group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' } },
      ],
    })
  })

  it('tells the fit judge what a recommended product is for from the recommendation catalog, joined with what its ingredient rules help, and leaves a product the catalog does not recommend with its rules alone', async () => {
    // entry-a is a recommended product the rules know nothing about; entry-c is niacinamide (its rule helps radiance) and is not recommended;
    // entry-d is niacinamide and recommended for moisture and redness.
    addProduct('entry-c', ['Aqua', 'Niacinamide'])
    addProduct('entry-d', ['Aqua', 'Niacinamide'])
    world.skinConcerns.set('prod-entry-a', ['hd_redness', 'hd_moisture'])
    world.skinConcerns.set('prod-entry-d', ['hd_redness', 'hd_moisture'])
    await current()

    await build(lastBody())

    expect(fitter.calls).toHaveLength(1)
    expect(fitter.calls[0]!.shelf.filter((p) => p.floor.status === 'open').map((p) => [p.id, p.skinConcerns])).toEqual([
      ['entry-a', ['hd_moisture', 'hd_redness']],
      ['entry-c', ['hd_radiance']],
      ['entry-d', ['hd_moisture', 'hd_radiance', 'hd_redness']],
    ])
  })

  it('does not rebuild a ready verdict because the catalog\'s skin concerns for a product changed, since they are not part of its fingerprint', async () => {
    await built()
    const before = (await rowOf()).fingerprint

    world.skinConcerns.set('prod-entry-a', ['hd_acne'])
    await current()

    expect(jobs.enqueued).toHaveLength(1)
    expect((await rowOf()).fingerprint).toBe(before)
  })

  it('saves what the verdict was built from: the fingerprint it was requested with, the versions, the model and prompt, the time, and ids and codes only', async () => {
    await current()
    setClock(2 * MINUTE)

    await build(lastBody())

    expect(await rowOf()).toMatchObject({
      status: 'ready',
      fingerprint: lastBody().fingerprint,
      fit: 'ready',
      builtAt: at(2 * MINUTE),
      rulesVersion: 'rules-v1',
      catalogVersion: 1,
      model: 'memory-model',
      promptHash: 'memory-prompt-hash',
      fitRetryDueAt: null,
      inputs: {
        goal: 'fade-dark-marks',
        entries: [
          { id: 'entry-a', formulationId: 'form-entry-a' },
          { id: 'entry-b', formulationId: 'form-entry-b' },
        ],
        scan: { skinType: 'combination', concerns: [{ concern: 'hd_age_spot', band: 'some' }] },
        safety: { choices: ['reaction'], parseState: 'done' },
        taperCodes: ['TPR-STEROID-1'],
      },
    })
  })

  it('saves each product with its routine step and the sources of the rules that match it, for the routine', async () => {
    await built()

    expect((await savedFor('profile-amara-1'))!.products).toMatchObject([
      { entryId: 'entry-a', step: 'moisturise', sourceUrls: [] },
      { entryId: 'entry-b', step: null, sourceUrls: [STEROID_SOURCE] },
    ])
  })

  it('uses the judge\'s label for an open product: blocking the goal is a drop', async () => {
    fitter.respondWith((request) => ({ products: openIds(request).map((id) => ({ id, label: 'blocking' as const, reason: 'Works against the goal.', sameJobAs: null })), clashes: [] }))

    await built()

    expect(await current()).toMatchObject({ products: [{ entryId: 'entry-a', group: 'blocking', verdict: { kind: 'drop' } }, { entryId: 'entry-b' }] })
  })

  it('does not call the fit judge, and saves the verdict as ready, when the rules decided every product and found no clash', async () => {
    removeEntry('entry-a')

    await built()

    expect(fitter.calls).toEqual([])
    expect(await rowOf()).toMatchObject({ status: 'ready', fit: 'ready' })
    expect(await current()).toMatchObject({ status: 'ready', fit: 'ready', products: [{ entryId: 'entry-b', group: 'likely-the-problem' }] })
  })

  it('saves an empty shelf as a ready verdict with no products, without asking the judge', async () => {
    world.entries = []

    await built()

    expect(fitter.calls).toEqual([])
    expect(await current()).toEqual({ status: 'ready', fit: 'ready', products: [], tapers: [] })
  })

  it('does nothing when the row is already built from this fingerprint: no second bill for the fit judge, and the saved verdict is untouched', async () => {
    await built()
    const before = await rowOf()
    setClock(HOUR)

    await build(lastBody())

    expect(fitter.calls).toHaveLength(1)
    expect(await rowOf()).toEqual(before)
  })

  it('builds the current shelf for a message about an older fingerprint that is not a retry: that is how a takeover of a dead request works', async () => {
    await current()
    const asked = lastBody()
    world.goal = 'glow'
    setClock(STALE_AFTER)
    await current()
    const takeover = lastBody()
    expect(takeover.fingerprint).not.toBe(asked.fingerprint)

    // The first request's message finally arrives (retry flag absent, then explicitly false), after the shelf moved on.
    await build(asked)

    expect(fitter.calls).toHaveLength(1)
    expect(await rowOf()).toMatchObject({ status: 'ready', fit: 'ready', fingerprint: takeover.fingerprint })

    // Built already, so the same message again costs nothing.
    await build({ ...asked, retry: false })
    expect(fitter.calls).toHaveLength(1)
  })

  it('builds from the shelf as it is when the job runs, not as it was when the verdict was asked for', async () => {
    await current()
    const asked = lastBody()
    addProduct('entry-c', CLEAN, { name: 'Dew Lotion' })

    await build(asked)

    const row = await rowOf()
    expect(row.fingerprint).not.toBe(asked.fingerprint)
    // The verdict is served as it stands, with the product added after the ask, and nothing is queued again.
    expect(await current()).toMatchObject({ status: 'ready', products: [{ entryId: 'entry-a' }, { entryId: 'entry-b' }, { entryId: 'entry-c', group: 'helping' }] })
    expect(jobs.enqueued).toHaveLength(1)
  })

  it('leaves out an entry that no longer resolves, and logs its id and nothing else', async () => {
    world.entries.push({ id: 'entry-ghost', kind: 'product', addedAt: at(10 * MINUTE), productId: 'prod-ghost', formulationId: 'form-ghost' })
    world.facts.get('form-entry-a')!.name = `${SECRET} Calm Serum`
    world.safety.view = safetyView(['reaction'], { reactionText: `I react to ${SECRET} perfume` })
    fitter.respondWith((request) => ({ products: openIds(request).map((id) => ({ id, label: 'helping' as const, reason: `${SECRET} suits you`, sameJobAs: null })), clashes: [] }))
    const spies = spyOnConsole()

    await built()

    expect(await current()).toMatchObject({ status: 'ready', products: [{ entryId: 'entry-a' }, { entryId: 'entry-b' }] })
    const lines = loggedBy(spies)
    expect(lines.some((line) => line.includes('entry-ghost'))).toBe(true)
    for (const line of lines) expect(line).not.toContain(SECRET)
  })

  it('keeps a verdict built for a guest when the guest signs up: the profile is the same, so it is served at once', async () => {
    await built(AMARA)
    const verified = actor('user-amara', 'profile-amara-1', 'verified')

    expect(await current(verified)).toMatchObject({ status: 'ready', fit: 'ready' })
    expect(jobs.enqueued).toHaveLength(1)
  })
})

describe('VerdictService.current: a ready verdict', () => {
  it('serves a ready verdict built from the same inputs without queuing anything', async () => {
    await built()

    const view = await current()

    expect(view).toMatchObject({ status: 'ready', fit: 'ready' })
    expect(jobs.enqueued).toHaveLength(1)
    expect(fitter.calls).toHaveLength(1)
  })

  it('gives each step-down template a stopped product uses once, as the row the workbook holds', async () => {
    addProduct('entry-c', STEROID, { name: 'Dermo Fade Gel' })

    await built()

    const view = await current()
    expect(view).toMatchObject({ status: 'ready' })
    expect((view as { tapers: TaperRow[] }).tapers).toEqual([expect.objectContaining({ code: 'TPR-STEROID-1', kind: 'steroid', status: 'approved' })])
    // Only the code in use is looked up, never the template of a kind the shelf did not need.
    expect(world.tapersAsked.at(-1)).toEqual(['TPR-STEROID-1'])
  })

  it('gives the row of a step-down template as the workbook holds it even when it has been retired since', async () => {
    await built()
    world.tapers.set('TPR-STEROID-1', taperRow('TPR-STEROID-1', 'steroid', 'retired'))

    const view = (await current()) as { status: string; tapers: TaperRow[] }

    expect(view.status).toBe('ready')
    expect(view.tapers).toEqual([expect.objectContaining({ code: 'TPR-STEROID-1', status: 'retired' })])
  })

  it('gives no step-down templates when no product is stopped', async () => {
    removeEntry('entry-b')

    await built()

    expect(await current()).toMatchObject({ status: 'ready', tapers: [] })
  })
})

// Each of these changes what the verdict was built from, so the next ask answers pending and queues a build of the new fingerprint.
const changesThatRebuild: [string, () => void][] = [
  ['a product is added to the shelf', () => addProduct('entry-c', CLEAN, { name: 'Dew Lotion' })],
  ['a product is taken off the shelf', () => removeEntry('entry-a')],
  ['the goal changes', () => void (world.goal = 'glow')],
  ['the safety choices change', () => void (world.safety.view = safetyView(['reaction', 'pregnant'], { reactionText: 'I react to fragrance' }))],
  ['the face scan reads a concern at a different band', () => void (world.scan = { skinType: 'combination', concerns: [{ concern: 'hd_age_spot', band: 'clear' }] })],
  ['the rules version changes', () => void (world.reference.rulesVersion = 'rules-v2')],
  ['a lightening claim phrase is added', () => void world.reference.claimPhrases.push('toning')],
  ['the step-down template of a kind the shelf uses is replaced', () => void (world.reference.tapers.steroid = 'TPR-STEROID-2')],
]

describe('VerdictService.current: when the verdict goes stale', () => {
  const changes = changesThatRebuild

  it.each(changes)('rebuilds when %s', async (_label, change) => {
    await built()
    const first = lastBody()
    change()

    expect(await current()).toEqual({ status: 'pending' })

    expect(jobs.enqueued).toHaveLength(2)
    expect(lastBody()).toMatchObject({ profileId: 'profile-amara-1', waits: 0 })
    expect(lastBody().fingerprint).not.toBe(first.fingerprint)
  })

  // These change something the verdict does not read: serving the saved one is right, and a rebuild would bill the fit judge again for nothing.
  const harmless: [string, () => void][] = [
    ['the step-down template of a kind the shelf does not use is replaced', () => void (world.reference.tapers['lightening-agent'] = 'TPR-LIGHTENING-2')],
    ['the catalog version moves on its own', () => void (world.reference.catalogVersion = 99)],
    [
      'the same safety answers are saved again',
      () => {
        world.safety.view = safetyView(['reaction'], { reactionText: 'I react to fragrance', updatedAt: at(HOUR) })
        world.safety.mentions = [mention({ id: 'mention-9', safetyId: 'safety-2', position: 3, createdAt: at(HOUR) })]
      },
    ],
    ['a product that is not skin joins the shelf', () => addProduct('entry-hair', CLEAN, { name: 'Curl Oil', category: 'hair' })],
  ]

  it.each(harmless)('serves the saved verdict, queuing nothing, when %s', async (_label, change) => {
    await built()
    change()

    expect(await current()).toMatchObject({ status: 'ready', fit: 'ready' })

    expect(jobs.enqueued).toHaveLength(1)
    expect(fitter.calls).toHaveLength(1)
  })

  it('answers pending, not the previous verdict, while the rebuild is out', async () => {
    await built()
    world.goal = 'glow'

    expect(await current()).toEqual({ status: 'pending' })
  })

  it('reads a user\'s step-down gate afresh each time: a template that stops being approved makes the verdict unavailable even when a saved one exists', async () => {
    await built()
    delete world.reference.tapers.steroid

    expect(await errorOf(current())).toMatchObject({ code: 'VERDICT_UNAVAILABLE' })
  })
})

describe('VerdictService.build: waiting for the shelf to settle', () => {
  const settling: [string, () => void][] = [
    ['the safety words are still being parsed', () => void (world.safety.parseState = 'pending')],
    ['a scan of the shelf is still being worked on', () => void (world.inFlight = true)],
  ]

  it.each(settling)('queues itself again a minute on, one wait further, and saves nothing, while %s', async (_label, hold) => {
    await current()
    const body = lastBody()
    hold()

    await build(body)

    expect(queued().at(-1)).toEqual({ job: 'build-verdict', body: { ...body, waits: 1 }, delaySeconds: 60 })
    expect(jobs.enqueued).toHaveLength(2)
    expect(fitter.calls).toEqual([])
    expect(await rowOf()).toMatchObject({ status: 'pending', fit: null, builtAt: null })
  })

  it('keeps the retry flag on the message it queues again', async () => {
    await current()
    world.safety.parseState = 'pending'

    await build({ ...lastBody(), retry: true })

    expect(queued().at(-1)!.body).toMatchObject({ retry: true, waits: 1 })
  })

  it.each(settling)('waits one last time at 14 waits, and builds at 15, whatever %s', async (_label, hold) => {
    await current()
    const body = lastBody()
    hold()

    await build({ ...body, waits: MAX_WAITS - 1 })
    expect(queued().at(-1)).toEqual({ job: 'build-verdict', body: { ...body, waits: MAX_WAITS }, delaySeconds: 60 })
    expect(await rowOf()).toMatchObject({ status: 'pending' })

    const before = jobs.enqueued.length
    await build({ ...body, waits: MAX_WAITS })
    expect(jobs.enqueued).toHaveLength(before)
    expect(await rowOf()).toMatchObject({ status: 'ready', fit: 'ready' })
  })

  it('does not wait when nothing is settling', async () => {
    await current()

    await build(lastBody())

    expect(jobs.enqueued).toHaveLength(1)
    expect(await rowOf()).toMatchObject({ status: 'ready' })
  })

  it('reads whether the shelf is settling for the profile the job is about', async () => {
    await current(TOLU)
    world.profilesRead.length = 0

    await build(lastBody())

    expect(new Set(world.profilesRead)).toEqual(new Set(['profile-tolu-1']))
  })
})

describe('VerdictService.build: a step-down template that is no longer approved', () => {
  it.each<TaperKind>(['steroid', 'lightening-agent'])('fails for good with a PermanentJobError, saving nothing, when the %s template has been withdrawn since the ask', async (kind) => {
    await current()
    const body = lastBody()
    delete world.reference.tapers[kind]

    const error = await errorOf(build(body))

    expect(error).toBeInstanceOf(PermanentJobError)
    expect(await rowOf()).toMatchObject({ status: 'pending', fit: null, builtAt: null })
    expect(fitter.calls).toEqual([])
  })

  it('fails for good before it waits: a build that can never finish is not held for a scan', async () => {
    await current()
    const body = lastBody()
    delete world.reference.tapers.steroid
    world.inFlight = true

    expect(await errorOf(build(body))).toBeInstanceOf(PermanentJobError)
    expect(jobs.enqueued).toHaveLength(1)
  })
})

describe('VerdictService.build: when the fit judge cannot answer', () => {
  /** Asks for the verdict, answering the message the ask queued: the one the queue would hand to build(), again on each retry. */
  const ask = async () => {
    await current()
    return lastBody()
  }

  const failures: [string, () => void][] = [
    ['the judge throws', () => fitFails()],
    ['the judge answers for no product, so the merge refuses its answer', () => fitter.respondWith(() => ({ products: [], clashes: [] }))],
  ]

  describe.each(failures)('when %s', (_label, breakFit) => {
    beforeEach(breakFit)

    it('shows the user a ready verdict at once: the rules\' labels stand, the open products are undecided, and the fit is not ready', async () => {
      const body = await ask()

      expect(await errorOf(build(body))).not.toBeInstanceOf(PermanentJobError)

      expect(await current()).toMatchObject({
        status: 'ready',
        fit: 'not-ready',
        products: [
          { entryId: 'entry-a', group: 'undecided', verdict: { kind: 'keep' } },
          { entryId: 'entry-b', group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' } },
        ],
      })
      expect(jobs.enqueued).toHaveLength(1)
    })

    it('counts one failed attempt, and throws so the queue tries again, for the first and the second', async () => {
      const body = await ask()

      await expect(build(body)).rejects.toThrow()
      expect(await rowOf()).toMatchObject({ status: 'ready', fit: 'not-ready', fitAttempts: 1, fitRetried: false, fitRetryDueAt: null })

      await expect(build(body)).rejects.toThrow()
      expect(await rowOf()).toMatchObject({ status: 'ready', fit: 'not-ready', fitAttempts: 2, fitRetried: false, fitRetryDueAt: null })
    })

    it('gives up for today on the third failed attempt: it returns normally, and a retry is due in 24 hours', async () => {
      const body = await ask()
      await expect(build(body)).rejects.toThrow()
      await expect(build(body)).rejects.toThrow()
      setClock(5 * MINUTE)

      await expect(build(body)).resolves.toBeUndefined()

      expect(await rowOf()).toMatchObject({ status: 'ready', fit: 'not-ready', fitAttempts: 3, fitRetried: true, fitRetryDueAt: at(5 * MINUTE + DAY) })
      expect(await current()).toMatchObject({ status: 'ready', fit: 'not-ready' })
    })

    it('makes the single try of the 24 hour retry, and when it fails too returns normally and schedules nothing further', async () => {
      const body = await ask()
      await expect(build(body)).rejects.toThrow()
      await expect(build(body)).rejects.toThrow()
      await build(body)
      const due = (await rowOf()).fitRetryDueAt!
      await requeueDueFits(due)
      const retry = lastBody()

      await expect(build(retry)).resolves.toBeUndefined()

      expect(await rowOf()).toMatchObject({ status: 'ready', fit: 'not-ready', fitRetried: true, fitRetryDueAt: null })
      expect(await requeueDueFits(at(30 * DAY))).toBe(0)
      expect(await current()).toMatchObject({ status: 'ready', fit: 'not-ready' })
    })

    it('logs the failed attempt as fit-failed, with the profile id', async () => {
      const body = await ask()
      const spies = spyOnConsole()

      await expect(build(body)).rejects.toThrow()

      expect(loggedBy(spies).filter((line) => line.includes('fit-failed') && line.includes('profile-amara-1'))).toHaveLength(1)
    })
  })

  it('finishes the verdict when the 24 hour retry gets an answer: the fit is ready, the open product is decided and nothing more is due', async () => {
    const body = await ask()
    fitFails()
    await expect(build(body)).rejects.toThrow()
    await expect(build(body)).rejects.toThrow()
    await build(body)
    setClock(DAY)
    await requeueDueFits(clock)
    fitter.respondWith(helpingAll)

    await build(lastBody())

    expect(await rowOf()).toMatchObject({ status: 'ready', fit: 'ready', fitRetryDueAt: null, builtAt: at(DAY) })
    expect(await current()).toMatchObject({ status: 'ready', fit: 'ready', products: [{ entryId: 'entry-a', group: 'helping' }, { entryId: 'entry-b' }] })
    expect(await requeueDueFits(at(30 * DAY))).toBe(0)
  })

  it('tries the judge again on a message for a verdict that is ready but not complete (the queue\'s own retry), and finishes it on success', async () => {
    const body = await ask()
    fitFails()
    await expect(build(body)).rejects.toThrow()
    fitter.respondWith(helpingAll)

    await build(body)

    expect(fitter.calls).toHaveLength(1)
    expect(await rowOf()).toMatchObject({ status: 'ready', fit: 'ready', fitRetryDueAt: null })
  })

  describe('while the 24 hour retry is waiting', () => {
    /** Attempts 1 to 3 have failed: the verdict is saved not-ready, the retry is scheduled for tomorrow, and the judge could answer now. */
    const waitingForTomorrow = async () => {
      const body = await ask()
      fitFails()
      await expect(build(body)).rejects.toThrow()
      await expect(build(body)).rejects.toThrow()
      setClock(5 * MINUTE)
      await build(body)
      fitter.respondWith(helpingAll)
      const row = await rowOf()
      expect(row).toMatchObject({ fit: 'not-ready', fitAttempts: 3, fitRetried: true, fitRetryDueAt: at(5 * MINUTE + DAY) })
      return { body, row }
    }

    it.each<[string, (body: BuildBody) => BuildBody]>([
      ['a redelivery of the message whose third attempt failed', (body) => body],
      ['a leftover wait hop of the build', (body) => ({ ...body, waits: 2 })],
    ])('makes no second paid call to the judge for %s, and leaves the retry due when it was', async (_label, message) => {
      const { body, row } = await waitingForTomorrow()
      setClock(HOUR)

      await expect(build(message(body))).resolves.toBeUndefined()

      expect(fitter.calls).toEqual([])
      expect(await rowOf()).toEqual(row)
    })

    it('still makes its one try when the retry message from the sweep arrives', async () => {
      const { body } = await waitingForTomorrow()
      setClock(DAY + 5 * MINUTE)

      await build({ ...body, retry: true, requestedAt: clock.getTime() })

      expect(fitter.calls).toHaveLength(1)
      expect(await rowOf()).toMatchObject({ fit: 'ready', fitRetryDueAt: null })
    })
  })

  describe('a retry message for an old fingerprint', () => {
    /** A verdict whose three attempts failed and whose retry the sweep has queued; the judge could answer now. */
    const retryQueued = async () => {
      const body = await ask()
      fitFails()
      await expect(build(body)).rejects.toThrow()
      await expect(build(body)).rejects.toThrow()
      await build(body)
      setClock(DAY)
      await requeueDueFits(clock)
      fitter.respondWith(helpingAll)
      return lastBody()
    }

    it('is skipped once the shelf has changed and the new fingerprint is claimed: the judge is not called and the new request is left to its own job', async () => {
      const retry = await retryQueued()
      expect(retry).toMatchObject({ retry: true })
      world.goal = 'glow'
      await current()
      const before = await rowOf()
      const queuedBefore = jobs.enqueued.length

      await expect(build(retry)).resolves.toBeUndefined()

      expect(fitter.calls).toEqual([])
      expect(await rowOf()).toEqual(before)
      expect(before).toMatchObject({ status: 'pending', fingerprint: expect.not.stringMatching(retry.fingerprint) })
      expect(jobs.enqueued).toHaveLength(queuedBefore)
    })

    it('is skipped when the shelf has changed but nothing has claimed the new fingerprint yet: the row stays as it was', async () => {
      const retry = await retryQueued()
      world.goal = 'glow'
      const before = await rowOf()

      await expect(build(retry)).resolves.toBeUndefined()

      expect(fitter.calls).toEqual([])
      expect(await rowOf()).toEqual(before)
    })

    it('is built when its fingerprint is still the current one', async () => {
      const retry = await retryQueued()

      await build(retry)

      expect(fitter.calls).toHaveLength(1)
      expect(await rowOf()).toMatchObject({ fit: 'ready', fingerprint: retry.fingerprint })
    })
  })

  it('logs the failure without its message, which can carry the model\'s words', async () => {
    const body = await ask()
    fitFails(`${SECRET} said something about the shelf`)
    const spies = spyOnConsole()

    await expect(build(body)).rejects.toThrow()

    for (const line of loggedBy(spies)) expect(line).not.toContain(SECRET)
  })
})

describe('VerdictService.requeueDueFits: the daily sweep', () => {
  /** A verdict whose three attempts failed, so a retry is due 24 hours after `failedAt`. */
  const failedThrice = async (who: Actor, failedAt: number) => {
    fitFails()
    await current(who)
    const body = lastBody()
    setClock(failedAt)
    await expect(build(body)).rejects.toThrow()
    await expect(build(body)).rejects.toThrow()
    await build(body)
    return body
  }

  it('queues the retry of a verdict whose retry is due, and not a millisecond before', async () => {
    const body = await failedThrice(AMARA, 0)
    const queuedBefore = jobs.enqueued.length

    expect(await requeueDueFits(at(DAY - 1))).toBe(0)
    expect(jobs.enqueued).toHaveLength(queuedBefore)

    expect(await requeueDueFits(at(DAY))).toBe(1)
    expect(queued().at(-1)).toEqual({
      job: 'build-verdict',
      body: { profileId: 'profile-amara-1', fingerprint: body.fingerprint, requestedAt: at(DAY).getTime(), waits: 0, retry: true },
      delaySeconds: 0,
    })
  })

  it('queues one retry for each profile that is due, the longest overdue first', async () => {
    await failedThrice(TOLU, 0)
    setClock(HOUR)
    await failedThrice(AMARA, HOUR)
    const queuedBefore = jobs.enqueued.length

    expect(await requeueDueFits(at(2 * DAY))).toBe(2)

    expect(queued().slice(queuedBefore).map((m) => (m.body as BuildBody).profileId)).toEqual(['profile-tolu-1', 'profile-amara-1'])
  })

  it('queues nothing for a verdict that is complete, or that never failed', async () => {
    await built()

    expect(await requeueDueFits(at(30 * DAY))).toBe(0)
  })
})

describe('VerdictService.markFitFailed: the dead-letter hook', () => {
  // A build that ran out of queue retries on an infrastructure error. Like the safety parse it is given one more try tomorrow, and a second dead letter is final.
  it('schedules the one more try for tomorrow the first time: marked retried and due in 24 hours, queuing nothing', async () => {
    await current()
    const body = lastBody()
    setClock(HOUR)

    await markFitFailed(body)

    expect(await rowOf()).toMatchObject({ fitRetried: true, fitRetryDueAt: at(HOUR + DAY) })
    expect(jobs.enqueued).toHaveLength(1)
  })

  it('has the sweep queue that retry when it falls due', async () => {
    await current()
    const body = lastBody()
    await markFitFailed(body)

    expect(await requeueDueFits(at(DAY))).toBe(1)

    expect(queued().at(-1)!.body).toEqual({ profileId: 'profile-amara-1', fingerprint: body.fingerprint, requestedAt: at(DAY).getTime(), waits: 0, retry: true })
  })

  it('makes it final the second time: the retry that was due is cleared and never queued', async () => {
    await current()
    const body = lastBody()
    await markFitFailed(body)

    await markFitFailed({ ...body, retry: true })

    expect(await rowOf()).toMatchObject({ fitRetried: true, fitRetryDueAt: null })
    expect(await requeueDueFits(at(30 * DAY))).toBe(0)
  })

  it('leaves a verdict that was finished alone', async () => {
    await built()
    const before = await rowOf()

    await markFitFailed(lastBody())

    expect(await rowOf()).toEqual(before)
  })

  it('ignores a dead letter for a build the row has moved on from: its fingerprint is not the row\'s', async () => {
    await current()
    const stale = lastBody()
    const before = await rowOf()

    await markFitFailed({ ...stale, fingerprint: 'a'.repeat(64) })

    expect(await rowOf()).toEqual(before)
  })

  it('resolves, creating nothing, for a profile with no verdict row', async () => {
    await expect(markFitFailed({ profileId: 'profile-nobody', fingerprint: 'a'.repeat(64), requestedAt: T0.getTime(), waits: 0 })).resolves.toBeUndefined()

    expect(await repository.find('profile-nobody')).toBeNull()
  })
})

describe('VerdictService.savedFor: what the routine reads', () => {
  it('answers null for a profile that never asked for a verdict, and asks for the build the way current() does', async () => {
    expect(await savedFor('profile-amara-1')).toBeNull()

    expect(queued()).toEqual([
      { job: 'build-verdict', body: { profileId: 'profile-amara-1', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), requestedAt: T0.getTime(), waits: 0 }, delaySeconds: 0 },
    ])
    expect(await rowOf()).toMatchObject({ status: 'pending', fingerprint: lastBody().fingerprint, requestedAt: T0 })
  })

  it('answers null while the verdict is pending, even when an earlier build is still stored', async () => {
    await built()
    world.goal = 'glow'
    await current()

    expect(await rowOf()).toMatchObject({ status: 'pending' })
    expect(await savedFor('profile-amara-1')).toBeNull()
  })

  it('does not queue a second build for a request that is still fresh', async () => {
    await current()

    expect(await savedFor('profile-amara-1')).toBeNull()
    setClock(MINUTE)
    expect(await savedFor('profile-amara-1')).toBeNull()

    expect(jobs.enqueued).toHaveLength(1)
  })

  it('answers the ready verdict: its fingerprint, fit, build time, rules version and products', async () => {
    setClock(MINUTE)
    await built()

    const saved = await savedFor('profile-amara-1')

    expect(saved).toEqual({
      fingerprint: (await rowOf()).fingerprint,
      fit: 'ready',
      builtAt: at(MINUTE),
      rulesVersion: 'rules-v1',
      products: [
        expect.objectContaining({ entryId: 'entry-a', group: 'helping', step: 'moisturise', sourceUrls: [] }),
        expect.objectContaining({ entryId: 'entry-b', group: 'likely-the-problem', step: null, sourceUrls: [STEROID_SOURCE] }),
      ],
    })
    expect(jobs.enqueued).toHaveLength(1)
  })

  it('answers a verdict whose fit is not ready as it stands, saying so', async () => {
    fitFails()
    await current()
    await expect(build(lastBody())).rejects.toThrow()

    expect(await savedFor('profile-amara-1')).toMatchObject({ fit: 'not-ready', products: [{ entryId: 'entry-a', group: 'undecided' }, { entryId: 'entry-b' }] })
    expect(jobs.enqueued).toHaveLength(1)
  })

  it('reads by the profile id it is given, with another profile\'s session or none', async () => {
    await built(AMARA)

    expect(await savedFor('profile-amara-1', TOLU)).toMatchObject({ fit: 'ready' })
    expect(await savedFor('profile-amara-1', SYSTEM)).toMatchObject({ fit: 'ready' })
    expect(await savedFor('profile-tolu-1', AMARA)).toBeNull()
  })

  describe('when what the verdict was built from has changed', () => {
    it.each(changesThatRebuild)('never serves the stale verdict when %s: answers null and queues the build of the new fingerprint', async (_label, change) => {
      await built()
      const first = lastBody()
      change()

      expect(await savedFor('profile-amara-1')).toBeNull()

      expect(jobs.enqueued).toHaveLength(2)
      expect(lastBody()).toMatchObject({ profileId: 'profile-amara-1', waits: 0 })
      expect(lastBody().fingerprint).not.toBe(first.fingerprint)
      expect(await rowOf()).toMatchObject({ status: 'pending', fingerprint: lastBody().fingerprint })
    })

    it('queues the build only once for repeated reads, and serves the new verdict once it is built', async () => {
      await built()
      world.goal = 'glow'

      expect(await savedFor('profile-amara-1')).toBeNull()
      expect(await savedFor('profile-amara-1')).toBeNull()
      expect(jobs.enqueued).toHaveLength(2)

      await build(lastBody())

      expect(await savedFor('profile-amara-1')).toMatchObject({ fit: 'ready', fingerprint: (await rowOf()).fingerprint })
      expect(jobs.enqueued).toHaveLength(2)
    })

    it('serves the saved verdict, queuing nothing, when only something the verdict does not read has changed', async () => {
      await built()
      world.reference.catalogVersion = 99

      expect(await savedFor('profile-amara-1')).toMatchObject({ fit: 'ready' })

      expect(jobs.enqueued).toHaveLength(1)
    })

    it('reads and queues for the profile it is given, whatever the session', async () => {
      await built(AMARA)
      world.goal = 'glow'
      world.profilesRead.length = 0

      expect(await savedFor('profile-amara-1', TOLU)).toBeNull()

      expect(new Set(world.profilesRead)).toEqual(new Set(['profile-amara-1']))
      expect(lastBody().profileId).toBe('profile-amara-1')
      expect(await repository.find('profile-tolu-1')).toBeNull()
    })

    it('takes a request over that is 30 minutes old, as current() does', async () => {
      await current()
      setClock(STALE_AFTER)

      expect(await savedFor('profile-amara-1')).toBeNull()

      expect(jobs.enqueued).toHaveLength(2)
      expect(lastBody().requestedAt).toBe(at(STALE_AFTER).getTime())
    })
  })

  describe('when the verdict cannot be computed', () => {
    it.each<[string, () => void]>([
      ['a step-down template is not approved', () => void delete world.reference.tapers.steroid],
      ['the profile has no goal', () => void (world.goal = null)],
    ])('answers null without throwing, and queues nothing, when %s and there is no verdict yet', async (_label, gate) => {
      gate()

      expect(await savedFor('profile-amara-1')).toBeNull()

      expect(jobs.enqueued).toEqual([])
      expect(await repository.find('profile-amara-1')).toBeNull()
    })

    it.each<[string, () => void]>([
      ['a step-down template is no longer approved', () => void delete world.reference.tapers.steroid],
      ['the profile\'s goal has been removed', () => void (world.goal = null)],
    ])('answers null, not the saved verdict, and queues nothing, when %s since it was built', async (_label, gate) => {
      await built()
      gate()

      expect(await savedFor('profile-amara-1')).toBeNull()

      expect(jobs.enqueued).toHaveLength(1)
    })
  })
})

// ---- D3: following the verdict live (GET /me/verdict/events) ----
//
// The contract this section pins (the precedent is FaceScanService.watch and publishFrame):
//   events is a ScanEvents (the port the face scans use), keyed by `verdict:<profileId>`.
//   watch() answers the `text/event-stream` from events.subscribe(key, snapshot). The gates and the claim are `current()`'s: 503 VERDICT_UNAVAILABLE, then 409
//   GOAL_REQUIRED, nothing subscribed; otherwise the build is claimed and queued as `current` does.
//   The snapshot, and the body of every `verdict` frame, is the PUBLIC body `GET /me/verdict` answers: { status: 'pending' } or { status: 'ready', fit, products,
//   tapers }. `facts`, `step`, `sourceUrls` and the saved `taperTemplateId` never reach a frame.
//   The events are { type: 'verdict'; verdict: <that body> } and { type: 'done' }, which ends the stream.
//   When `done` is sent: after a ready verdict whose fit is 'ready', and after one whose fit is 'not-ready' but whose `fitRetried` is true, because the queue has no
//   retry coming within seconds (the next try is the daily sweep's, a day on, or there is none). Only a verdict whose fit is 'not-ready' with `fitRetried` false
//   (attempts 1 and 2, which the queue retries within seconds) leaves the stream open for that retry's verdict. build() and the snapshot of watch() follow the same rule.
//   markFitFailed (the queue gave up on a build) sends `done` too, since no retry is coming soon: after the saved verdict's frame when the row is ready, alone when it is
//   still pending, and nothing when it ignores the dead letter. A failure to send is logged as publish-failed and never thrown.
//   A build whose inputs changed while it ran (the fingerprint recomputed after the save is not the one it built) sends { status: 'pending' } as its verdict, with no
//   `done`, and claims and queues the build for the new fingerprint, as `current` does; that build's verdict reaches the stream later.
//   build() publishes after the verdict is saved and before it throws for the queue's retry. A publish that fails never fails the build: it is logged as
//   { outcome: 'publish-failed', profileId } and the saved verdict is the truth.

const KEY = 'verdict:profile-amara-1'
const TOLU_KEY = 'verdict:profile-tolu-1'
const STEROID_TAPER_BODY = {
  code: 'TPR-STEROID-1',
  kind: 'steroid',
  schedule: [{ fromWeek: 1, toWeek: 2, frequency: 'alternate-days' }],
  whatToExpect: 'Skin may flare for a few days after each step down.',
  seeAProfessionalIf: 'The redness spreads or the skin weeps.',
}
/** Amara's shelf as a client reads it: the serum the judge decided (or left undecided when its fit is not ready), and the steroid cream stopped by its step-down. */
const amarasBody = (fit: 'ready' | 'not-ready') => ({
  status: 'ready',
  fit,
  products: [
    fit === 'ready'
      ? { entryId: 'entry-a', group: 'helping', verdict: { kind: 'keep' }, reason: 'Suits the goal.', escalate: false }
      : { entryId: 'entry-a', group: 'undecided', verdict: { kind: 'keep' }, reason: expect.any(String), escalate: false },
    { entryId: 'entry-b', group: 'likely-the-problem', verdict: { kind: 'stop', taperCode: 'TPR-STEROID-1' }, reason: expect.any(String), escalate: false },
  ],
  tapers: [STEROID_TAPER_BODY],
})
const verdictFrame = (fit: 'ready' | 'not-ready') => ({ type: 'verdict', verdict: amarasBody(fit) })
const DONE_FRAME = { type: 'done' }

const watch = (who: Actor = AMARA) => runAs(who, () => service.watch())
/** The fit judge failing on the first attempt: the build saves the floor alone and throws for the queue to try again. */
const builtWithFitFailing = async () => {
  await current()
  fitFails()
  await expect(build(lastBody())).rejects.toThrow()
}
/** The judge failing all three attempts of the day: the third returns normally, with the retry due in 24 hours. */
const builtWithThreeFailures = async () => {
  await builtWithFitFailing()
  const body = lastBody()
  await expect(build(body)).rejects.toThrow()
  await expect(build(body)).resolves.toBeUndefined()
}

describe('VerdictService.watch: opening the stream', () => {
  it('subscribes to the profile\'s own verdict stream with a pending snapshot, answers the event stream, and queues one build', async () => {
    const response = await watch()

    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(events.subscribed).toEqual([{ scanId: KEY, snapshot: { status: 'pending' } }])
    expect(events.published).toEqual([])
    expect(queued()).toEqual([
      { job: 'build-verdict', body: { profileId: 'profile-amara-1', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), requestedAt: T0.getTime(), waits: 0 }, delaySeconds: 0 },
    ])
    expect(await rowOf()).toMatchObject({ status: 'pending', fingerprint: lastBody().fingerprint })
  })

  it('queues one build however many ask at once, by watching or by reading', async () => {
    await Promise.all([watch(), watch(), current()])
    await watch()

    expect(jobs.enqueued).toHaveLength(1)
    expect(events.subscribed).toHaveLength(3)
  })

  it('keys the stream by the session\'s profile, so two profiles never share one', async () => {
    await watch(AMARA)
    await watch(TOLU)

    expect(events.subscribed.map((s) => s.scanId)).toEqual([KEY, TOLU_KEY])
  })

  describe('the gates are the verdict\'s own and come before any stream', () => {
    it('answers 503 VERDICT_UNAVAILABLE while a step-down template is not approved, subscribing and queuing nothing', async () => {
      delete world.reference.tapers['lightening-agent']

      const error = await errorOf(watch())

      expect(error).toBeInstanceOf(UnavailableError)
      expect(error).toMatchObject({ code: 'VERDICT_UNAVAILABLE' })
      expect(events.subscribed).toEqual([])
      expect(jobs.enqueued).toEqual([])
      expect(await repository.find('profile-amara-1')).toBeNull()
    })

    it('answers 409 GOAL_REQUIRED for a profile with no goal, subscribing and queuing nothing', async () => {
      world.goal = null

      const error = await errorOf(watch())

      expect(error).toBeInstanceOf(ConflictError)
      expect(error).toMatchObject({ code: 'GOAL_REQUIRED' })
      expect(events.subscribed).toEqual([])
      expect(jobs.enqueued).toEqual([])
    })

    it('checks the step-down gate before the goal: with neither, it is VERDICT_UNAVAILABLE', async () => {
      delete world.reference.tapers.steroid
      world.goal = null

      expect(await errorOf(watch())).toMatchObject({ code: 'VERDICT_UNAVAILABLE' })
    })
  })

  it('fails with the event store\'s own error when the stream cannot be opened, since there is no stream without it', async () => {
    const down = new Error('the stream is down')
    vi.spyOn(events, 'subscribe').mockRejectedValue(down)

    expect(await errorOf(watch())).toBe(down)
  })
})

describe('VerdictService.watch: a verdict that is already built', () => {
  it('starts with the public body GET answers, with the step-down by its code and nothing of how the rules reached the verdict, then closes at once when the fit is ready', async () => {
    await built()
    // The build's own frames went to listeners of its day; this client starts afresh.
    events.published.length = 0

    await watch()

    expect(events.subscribed).toHaveLength(1)
    expect(events.subscribed[0]!.scanId).toBe(KEY)
    expect(events.subscribed[0]!.snapshot).toEqual(amarasBody('ready'))
    const snapshot = events.subscribed[0]!.snapshot as unknown as { products: object[] }
    for (const product of snapshot.products) for (const internal of ['facts', 'step', 'sourceUrls', 'taperTemplateId']) expect(product).not.toHaveProperty(internal)
    // Nothing but `done` follows the snapshot, and no second copy of the verdict.
    expect(events.eventsFor(KEY)).toEqual([DONE_FRAME])
  })

  it('starts with the verdict and leaves the stream open when the fit is not ready and the queue is still to retry it (attempt 1 failed)', async () => {
    await builtWithFitFailing()
    expect(await rowOf()).toMatchObject({ fit: 'not-ready', fitRetried: false })
    events.published.length = 0

    await watch()

    expect(events.subscribed[0]!.snapshot).toEqual(amarasBody('not-ready'))
    expect(events.published).toEqual([])
  })

  it('starts with the verdict and then sends done when the fit is not ready and no retry is coming soon (the third attempt failed, the next is a day on)', async () => {
    await builtWithThreeFailures()
    expect(await rowOf()).toMatchObject({ fit: 'not-ready', fitRetried: true })
    events.published.length = 0

    await watch()

    expect(events.subscribed[0]!.snapshot).toEqual(amarasBody('not-ready'))
    expect(events.eventsFor(KEY)).toEqual([DONE_FRAME])
  })

  it('sends done after the snapshot of a not-ready verdict whose 24 hour retry is spent too', async () => {
    await builtWithThreeFailures()
    await requeueDueFits(at(DAY))
    await expect(build(lastBody())).resolves.toBeUndefined()
    expect(await rowOf()).toMatchObject({ fit: 'not-ready', fitRetried: true, fitRetryDueAt: null })
    events.published.length = 0

    await watch()

    expect(events.subscribed[0]!.snapshot).toEqual(amarasBody('not-ready'))
    expect(events.eventsFor(KEY)).toEqual([DONE_FRAME])
  })

  it('does not queue a build for a verdict that is current', async () => {
    await built()

    await watch()

    expect(jobs.enqueued).toHaveLength(1)
  })

  it('sends what a build saved in the moment between the snapshot and the open stream: the verdict, and done', async () => {
    await current()
    const body = lastBody()
    const open = events.subscribe.bind(events)
    vi.spyOn(events, 'subscribe').mockImplementation(async (key, snapshot) => {
      // The build lands after the snapshot was read; nobody was listening yet, so what it published reached no one.
      await build(body)
      events.published.length = 0
      return open(key, snapshot)
    })

    await watch()

    expect(events.subscribed[0]!.snapshot).toEqual({ status: 'pending' })
    expect(events.eventsFor(KEY)).toEqual([verdictFrame('ready'), DONE_FRAME])
  })

  it('logs a failure to send, by profile id, and still hands back the stream', async () => {
    await built()
    const spies = spyOnConsole()
    vi.spyOn(events, 'publish').mockRejectedValue(new Error(SECRET))

    const response = await watch()

    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    const lines = loggedBy(spies).filter((line) => line.includes('publish-failed'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toContain('profile-amara-1')
      expect(line).not.toContain(SECRET)
    }
  })
})

describe('VerdictService.markFitFailed: telling the stream', () => {
  it('sends the saved verdict and then done when the queue gives up on a build whose floor-only verdict was saved: no retry is coming soon', async () => {
    await builtWithFitFailing()
    const body = lastBody()
    events.published.length = 0

    await markFitFailed(body)

    expect(events.eventsFor(KEY)).toEqual([verdictFrame('not-ready'), DONE_FRAME])
    expect(events.published.every((p) => p.scanId === KEY)).toBe(true)
  })

  it('sends done alone when the build died before anything was saved, so the row is still pending', async () => {
    await current()
    expect(await rowOf()).toMatchObject({ status: 'pending' })

    await markFitFailed(lastBody())

    expect(events.eventsFor(KEY)).toEqual([DONE_FRAME])
  })

  it('sends nothing for a dead letter it ignores: a verdict that is finished, or a build the row has moved on from', async () => {
    await built()
    events.published.length = 0
    await markFitFailed(lastBody())
    expect(events.published).toEqual([])

    world.goal = 'glow'
    await current()
    const moved = { ...lastBody(), fingerprint: 'a'.repeat(64) }
    await markFitFailed(moved)
    expect(events.published).toEqual([])
  })

  it('logs a failure to send as publish-failed with the profile id alone, still marks the retry, and never throws', async () => {
    await builtWithFitFailing()
    const body = lastBody()
    const spies = spyOnConsole()
    vi.spyOn(events, 'publish').mockRejectedValue(new Error(SECRET))

    await expect(markFitFailed(body)).resolves.toBeUndefined()

    expect(await rowOf()).toMatchObject({ fitRetried: true, fitRetryDueAt: at(DAY) })
    const lines = loggedBy(spies)
    const failed = lines.filter((line) => line.includes('publish-failed'))
    expect(failed.length).toBeGreaterThan(0)
    for (const line of failed) expect(line).toContain('profile-amara-1')
    for (const line of lines) for (const private_ of [SECRET, 'Calm Serum', 'Karo Glow Cream', 'Suits the goal', 'Clobetasol', 'TPR-STEROID-1']) expect(line).not.toContain(private_)
  })
})

describe('VerdictService.build: telling the stream', () => {
  it('publishes the ready verdict, the public body, to the profile\'s stream and then done, when the fit is ready', async () => {
    await built()

    expect(events.eventsFor(KEY)).toEqual([verdictFrame('ready'), DONE_FRAME])
  })

  it('publishes to the profile it built for and to no other', async () => {
    await built(AMARA)
    await built(TOLU)

    expect(events.eventsFor(KEY)).toEqual([verdictFrame('ready'), DONE_FRAME])
    expect(events.eventsFor(TOLU_KEY)).toEqual([verdictFrame('ready'), DONE_FRAME])
    expect([...new Set(events.published.map((p) => p.scanId))].sort()).toEqual([KEY, TOLU_KEY])
  })

  it('publishes nothing while the build only waits for the shelf to settle', async () => {
    world.inFlight = true
    await current()

    await build(lastBody())

    expect(events.published).toEqual([])
  })

  it('publishes the floor-only verdict the moment it is saved, even though the judge failed, and not done: the retry is still to come', async () => {
    await builtWithFitFailing()

    // The build threw for the queue to retry, and the verdict it saved had already been sent.
    expect(events.eventsFor(KEY)).toEqual([verdictFrame('not-ready')])
  })

  it('publishes the verdict again, with the fit ready, and then done, when a retry gets an answer', async () => {
    await builtWithFitFailing()
    const body = lastBody()
    fitter.respondWith(helpingAll)

    await build(body)

    expect(events.eventsFor(KEY)).toEqual([verdictFrame('not-ready'), verdictFrame('ready'), DONE_FRAME])
  })

  it('publishes the verdict, and done, for the judge\'s third failure of the day: the next try is a day away, so nothing more is coming soon', async () => {
    await builtWithFitFailing()
    const body = lastBody()
    await expect(build(body)).rejects.toThrow()
    expect(events.eventsFor(KEY)).toEqual([verdictFrame('not-ready'), verdictFrame('not-ready')])

    await expect(build(body)).resolves.toBeUndefined()

    expect(events.eventsFor(KEY)).toEqual([verdictFrame('not-ready'), verdictFrame('not-ready'), verdictFrame('not-ready'), DONE_FRAME])
  })

  it('publishes the verdict, and done, when the single 24 hour retry fails too', async () => {
    await builtWithThreeFailures()
    events.published.length = 0
    await requeueDueFits(at(DAY))

    await expect(build(lastBody())).resolves.toBeUndefined()

    expect(events.eventsFor(KEY)).toEqual([verdictFrame('not-ready'), DONE_FRAME])
  })

  describe('when what it built from changed while the fit judge was working', () => {
    /** The shelf gains a product during the judge's call, so the verdict saved is of a shelf that is gone by the time it is saved. */
    const shelfChangesDuringTheFit = () =>
      fitter.respondWith((request) => {
        addProduct('entry-c', CLEAN, { name: 'Late Toner' })
        return helpingAll(request)
      })

    it('tells the stream the verdict is pending, not ready and done, and queues the build for the shelf as it now is', async () => {
      await current()
      const asked = lastBody()
      shelfChangesDuringTheFit()

      await build(asked)

      expect(events.eventsFor(KEY)).toEqual([{ type: 'verdict', verdict: { status: 'pending' } }])
      expect(jobs.enqueued).toHaveLength(2)
      expect(lastBody()).toMatchObject({ profileId: 'profile-amara-1', waits: 0 })
      expect(lastBody().fingerprint).not.toBe(asked.fingerprint)
      // The new request is claimed as GET claims it, so asking again right away queues nothing more.
      expect(await rowOf()).toMatchObject({ status: 'pending', fingerprint: lastBody().fingerprint })
      expect(await current()).toEqual({ status: 'pending' })
      expect(jobs.enqueued).toHaveLength(2)
    })

    it('is not retried when the fit judge also failed: the queued build has its own attempts, so the shelf is never judged twice', async () => {
      await current()
      let judged = 0
      fitter.respondWith(() => {
        judged += 1
        addProduct('entry-c', CLEAN, { name: 'Late Toner' })
        throw new Error('judge down')
      })

      // Resolving is the point: a throw would have the queue deliver it again, and that delivery would judge the new shelf beside the build queued for it.
      await expect(build(lastBody())).resolves.toBeUndefined()

      expect(judged).toBe(1)
      expect(jobs.enqueued).toHaveLength(2)
      expect(events.eventsFor(KEY)).toEqual([{ type: 'verdict', verdict: { status: 'pending' } }])
    })

    it('sends the verdict of the new shelf, and done, once the queued build runs', async () => {
      await current()
      shelfChangesDuringTheFit()
      await build(lastBody())
      fitter.respondWith(helpingAll)

      await build(lastBody())

      const [pending, verdict, done, ...rest] = events.eventsFor(KEY)
      expect(pending).toEqual({ type: 'verdict', verdict: { status: 'pending' } })
      expect(verdict).toMatchObject({ type: 'verdict', verdict: { status: 'ready', fit: 'ready' } })
      expect((verdict as unknown as { verdict: { products: { entryId: string }[] } }).verdict.products.map((p) => p.entryId)).toContain('entry-c')
      expect(done).toEqual(DONE_FRAME)
      expect(rest).toEqual([])
    })

    it('does not say pending when nothing changed: the verdict and done as before', async () => {
      await built()

      expect(events.eventsFor(KEY)).toEqual([verdictFrame('ready'), DONE_FRAME])
      expect(jobs.enqueued).toHaveLength(1)
    })
  })

  describe('when the stream cannot be reached', () => {
    it('still saves the verdict and resolves: the verdict is the source of truth and the client reads it again', async () => {
      await current()
      vi.spyOn(events, 'publish').mockRejectedValue(new Error(SECRET))

      await expect(build(lastBody())).resolves.toBeUndefined()

      expect(await rowOf()).toMatchObject({ status: 'ready', fit: 'ready' })
      expect(await current()).toMatchObject({ status: 'ready', fit: 'ready' })
    })

    it('does not turn a failed fit into a different failure: the build still throws the judge\'s error for the queue\'s retry', async () => {
      await current()
      fitFails('the fit judge is unavailable')
      vi.spyOn(events, 'publish').mockRejectedValue(new Error(SECRET))

      await expect(build(lastBody())).rejects.toThrow('the fit judge is unavailable')

      expect(await rowOf()).toMatchObject({ status: 'ready', fit: 'not-ready', fitAttempts: 1 })
    })

    it('logs it as publish-failed with the profile id alone: no product, reason, error text or step-down', async () => {
      await current()
      const spies = spyOnConsole()
      vi.spyOn(events, 'publish').mockRejectedValue(new Error(SECRET))

      await build(lastBody())

      const lines = loggedBy(spies)
      const failed = lines.filter((line) => line.includes('publish-failed'))
      expect(failed.length).toBeGreaterThan(0)
      for (const line of failed) expect(line).toContain('profile-amara-1')
      for (const line of lines) for (const private_ of [SECRET, 'Calm Serum', 'Karo Glow Cream', 'Suits the goal', 'Clobetasol', 'TPR-STEROID-1']) expect(line).not.toContain(private_)
    })
  })
})
