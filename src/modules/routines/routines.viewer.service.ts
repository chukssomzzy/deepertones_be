import { describeError } from '../../jobs/safe-error'
import { requireUser } from '../../lib/context'
import { ConflictError, ForbiddenError, UnavailableError } from '../../lib/errors'
import type { ScanEvents } from '../../providers/scan-events/scan-events.provider'
import type { ProductCatalogService } from '../catalog/catalog.service'
import type { ProductForm, RoutineStep } from '../catalog/catalog.vocabulary'
import type { CatalogWorkbookService } from '../catalog/catalog.workbook.service'
import type { GoalsService } from '../goals/goals.service'
import type { Goal } from '../goals/goals.vocabulary'
import type { RecommendationService } from '../recommendations/recommendations.service'
import type { SafetyService } from '../safety/safety.service'
import type { ShelfService } from '../shelf/shelf.service'
import { NO_LABEL_NAME } from '../verdicts/verdicts.inputs'
import { VerdictService } from '../verdicts/verdicts.service'
import type { RoutinesRepository, RoutineVersionRow } from './routines.repository'
import type { RoutineService, RoutineView } from './routines.service'
import { titleFor } from './routines.copy'
import { commonlySoldAt, LOOK_FOR_PRODUCTS, whyFor } from './routines.look-for'
import type { LookForResponse, RoutineResponse } from './routines.schemas'
import { isSoldIn, toReminderPlan, toRoutineResponse, type ReminderPlan, type RoutineViewInput } from './routines.view'

export type RoutineViewerServiceDeps = {
  routines: Pick<RoutineService, 'current' | 'start' | 'gotIt' | 'request' | 'requestIfStale'>
  goals: Pick<GoalsService, 'requireGoal'>
  workbook: Pick<CatalogWorkbookService, 'verdictReference' | 'recommendedByCode' | 'tapersByCode' | 'countries' | 'guideFor'>
  catalog: Pick<ProductCatalogService, 'shelfFacts' | 'productSummaries'>
  shelf: Pick<ShelfService, 'activeEntriesFor'>
  recommendations: Pick<RecommendationService, 'shoppingFor' | 'candidatesFor'>
  /** Whether the person is pregnant or breastfeeding, for the guide's pregnancy text. */
  safety: Pick<SafetyService, 'currentOrNull'>
  repository: Pick<RoutinesRepository, 'lastServedBefore' | 'markServed'>
  /** Tells whoever follows a profile's routine that it changed (`routine:<profileId>`). */
  events: ScanEvents
  /** Whether routines are switched on in this environment (the routine service's own switch): off, a build is never queued, and "find one sold here" answers as if it were. */
  enabled: boolean
  now?: () => Date
}

/**
 * The routine as a person's screen reads it (spec #189): what the routes call. Each session method is the caller's own (no profile id; the actor's profile is the
 * one read) over RoutineService's profile-keyed internals, and adds what only a screen needs: the gates, the body a client reads (routines.view.ts), "what changed
 * since last shown", and the live stream. `announce` is the build's way to the same stream, by profile id.
 *
 * The gates, in order: 401, 403 `SIGNUP_REQUIRED` for a guest (a routine is saved with an account), 409 `GOAL_REQUIRED`, then 503 `VERDICT_UNAVAILABLE` while a step-down
 * template of the verdict is not approved, since the routine is built from the verdict and would stay pending for ever.
 */
export class RoutineViewerService {
  private readonly routines: RoutineViewerServiceDeps['routines']
  private readonly goals: RoutineViewerServiceDeps['goals']
  private readonly workbook: RoutineViewerServiceDeps['workbook']
  private readonly catalog: RoutineViewerServiceDeps['catalog']
  private readonly shelf: RoutineViewerServiceDeps['shelf']
  private readonly recommendations: RoutineViewerServiceDeps['recommendations']
  private readonly safety: RoutineViewerServiceDeps['safety']
  private readonly repository: RoutineViewerServiceDeps['repository']
  private readonly events: ScanEvents
  private readonly enabled: boolean
  private readonly now: () => Date

  constructor(deps: RoutineViewerServiceDeps) {
    this.routines = deps.routines
    this.goals = deps.goals
    this.workbook = deps.workbook
    this.catalog = deps.catalog
    this.shelf = deps.shelf
    this.recommendations = deps.recommendations
    this.safety = deps.safety
    this.repository = deps.repository
    this.events = deps.events
    this.enabled = deps.enabled
    this.now = deps.now ?? (() => new Date())
  }

  /** The caller's routine: the one in force (`ready`), `updating` while a newer build is under way, `pending` when there is nothing to show yet. Asks for a build when none is fresh. Marks what it shows as served. */
  async current(): Promise<RoutineResponse> {
    const profileId = await this.gated()
    await this.routines.requestIfStale(profileId)
    return this.shown(profileId, await this.routines.current(profileId), true)
  }

  /**
   * The caller's routine followed live, as the `text/event-stream` of `routine:<profileId>`. The gates and the request for a build are `current`'s. It starts with the
   * routine `current` would answer, then carries each `routine` a build sends (see `announce`), and ends with `done` once the routine is ready. The snapshot is read
   * before the stream opens, so the routine is read again once it is open: a build that landed in between is sent, and a routine that is ready gets `done` straight
   * away. A failure to send is logged, and so is a failure of that re-read, which still hands back the stream.
   */
  async watch(): Promise<Response> {
    const profileId = await this.gated()
    await this.routines.requestIfStale(profileId)
    const view = await this.routines.current(profileId)
    const stream = await this.events.subscribe(RoutineViewerService.streamKey(profileId), await this.shown(profileId, view, true))
    let latest: RoutineView
    try {
      latest = await this.routines.current(profileId)
    } catch {
      console.error({ outcome: 'routine-watch-reread-failed', profileId })
      return stream
    }
    if (latest.status !== view.status || RoutineViewerService.versionIdOf(latest) !== RoutineViewerService.versionIdOf(view)) await this.publishRoutine(profileId, latest)
    if (latest.status === 'ready') await this.publishDone(profileId)
    return stream
  }

  /** Makes today day 1 of the routine in force, and answers it. 409 `ROUTINE_NOT_READY` before there is one; starting again changes nothing. */
  async start(): Promise<RoutineResponse> {
    const profileId = await this.gated()
    await this.routines.start(profileId)
    return this.shown(profileId, await this.routines.current(profileId), false)
  }

  /** "I got it" for the step's recommended product (RoutineService.gotIt), and the routine afterwards. */
  async gotIt(step: RoutineStep, clientIp: string): Promise<RoutineResponse> {
    const profileId = await this.gated()
    await this.routines.gotIt(profileId, step, clientIp)
    return this.shown(profileId, await this.routines.current(profileId), false)
  }

  /**
   * "Find one sold here": asks for the step to be built again without its recommended product, which the shopping country does not sell (or nobody sells any more).
   * 409 `ROUTINE_NOT_READY` before there is a routine, 409 `STEP_NOT_RECOMMENDED` for a step with no recommended product or one sold here already. The build runs in
   * the job. The answer is the routine in force, as `updating`. When routines are on and nothing was queued, the person's request would be lost (another build or a
   * read's own request holds the profile's claim, and a request made mid-build is dropped), so it is 409 `BUILD_IN_PROGRESS`: try again in a moment. With routines
   * off nothing is ever queued and the answer is as ever.
   */
  async findSoldHere(step: RoutineStep): Promise<RoutineResponse> {
    const profileId = await this.gated()
    const view = await this.routines.current(profileId)
    if (view.status === 'pending') throw new ConflictError('ROUTINE_NOT_READY', 'Your routine is not ready yet')
    const chosen = view.version.steps.find((entry) => entry.step === step)?.product
    if (chosen?.kind !== 'candidate') throw new ConflictError('STEP_NOT_RECOMMENDED', 'This step has no recommended product')
    const { code } = chosen
    const row = (await this.workbook.recommendedByCode([code])).get(code)
    if (row && isSoldIn(row, (await this.recommendations.shoppingFor(profileId)).country)) throw new ConflictError('STEP_NOT_RECOMMENDED', 'This product is sold in your country')
    const queued = await this.routines.request(profileId, 'sold-here', `sold-here:${view.version.id}:${step}`, { exclude: { step, code } })
    if (!queued && this.enabled) throw new ConflictError('BUILD_IN_PROGRESS', 'Your routine is being updated right now. Try again in a moment.')
    return this.shown(profileId, { status: 'updating', version: view.version }, false)
  }

  /**
   * What to look for in a step, and the reviewed products that suit the person (screens 4.7 and 4.8). The gates are `current`'s; then 409 `ROUTINE_NOT_READY` when there is
   * no routine to show (a safety change that hides it included), 409 `STEP_IS_YOURS` when the routine uses the person's own product for the step (they are not pushed to
   * buy a replacement), and 503 `GUIDE_UNAVAILABLE` when no approved guide covers the step. A recommended step and a "use what you have" step both answer. Reads only: it
   * asks for no build and marks nothing served.
   *
   * The products are the step's candidates as the recommendation rules found them, none filtered here: the routine's pick first (counted in the ten) when it is one
   * of them, then the rest as they came (cheapest, then code). A pick that is not a candidate (sold elsewhere now, or retired) is not shown. The price range and the
   * places are over every candidate, not only the ten shown.
   */
  async lookFor(step: RoutineStep): Promise<LookForResponse> {
    const { profileId, goal } = await this.gatedWithGoal()
    const view = await this.routines.current(profileId)
    if (view.status === 'pending') throw new ConflictError('ROUTINE_NOT_READY', 'Your routine is not ready yet')
    const chosen = view.version.steps.find((entry) => entry.step === step)?.product
    if (chosen?.kind === 'shelf') throw new ConflictError('STEP_IS_YOURS', 'You already use your own product for this step')
    const guide = await this.workbook.guideFor(step, goal)
    if (guide === null) throw new UnavailableError('GUIDE_UNAVAILABLE', 'The guide for this step is not available yet')
    const [candidates, shopping, countries, safety] = await Promise.all([
      this.recommendations.candidatesFor({ step }),
      this.recommendations.shoppingFor(profileId),
      this.workbook.countries(),
      this.safety.currentOrNull(),
    ])
    const currency = countries.find((country) => country.code === shopping.country)?.currency
    const pick = chosen?.kind === 'candidate' ? chosen.code : null
    const shown = [...candidates.filter(({ code }) => code === pick), ...candidates.filter(({ code }) => code !== pick)].slice(0, LOOK_FOR_PRODUCTS)
    return {
      category: titleFor({ step, form: null }),
      guide: {
        whatItDoes: guide.whatItDoes,
        lookFor: safety?.excludesPregnancyCaution && guide.lookForWhenPregnant !== null ? guide.lookForWhenPregnant : guide.lookFor,
        forDeeperSkin: guide.forDeeperSkin,
      },
      // A candidate is only ever found in an active country, which has a currency; with none there is nothing to price.
      typicalPrice: currency === undefined || candidates.length === 0 ? null : { low: Math.min(...candidates.map((c) => c.priceMin)), high: Math.max(...candidates.map((c) => c.priceMax)), currency },
      commonlySoldAt: commonlySoldAt(candidates),
      products:
        currency === undefined
          ? []
          : shown.map((candidate) => ({
              code: candidate.code,
              brand: candidate.product.brand,
              name: candidate.product.name,
              imageUrl: candidate.product.imageUrl,
              ...(candidate.origin === 'brand-submitted' ? { origin: 'brand-submitted' as const } : {}),
              aboutPrice: { amount: candidate.priceMin, currency },
              whereSold: candidate.whereSold,
              why: whyFor(goal, candidate.skinConcerns),
              keyIngredient: candidate.keyIngredient,
              strength: candidate.strength,
              inYourRoutine: candidate.code === pick,
            })),
    }
  }

  /**
   * Sends the profile's routine to whoever follows it, as the body GET answers (`routine`), and `done` when it is ready. For the build to call, by profile id with no
   * gates and no session. Never marks a version served: only a person looking at it does. Throws when it cannot be sent; callers log that.
   */
  async announce(profileId: string): Promise<void> {
    const view = await this.routines.current(profileId)
    await this.publishRoutine(profileId, view)
    if (view.status === 'ready') await this.publishDone(profileId)
  }

  /**
   * The routine in force as the reminder send job reads it: day 1 and the morning and evening lists, as the body places and titles them, each entry with its step's raw
   * frequency, and the days a step-down changes (it reads the step-down templates for them). By profile id with no session or gates (a job calls it). Null while there is nothing to remind of: no routine, one hidden (pending) or one not Started.
   * It asks for no build, marks nothing served and reads no goal.
   */
  async reminderPlanFor(profileId: string): Promise<ReminderPlan | null> {
    const view = await this.routines.current(profileId)
    if (view.status === 'pending' || view.version.startedOn === null) return null
    return toReminderPlan(await this.inputFor(profileId, view.status, view.version, null, true))
  }

  /** The caller's profile once they may see a routine: signed up, with a goal, and the verdict available. */
  private async gated(): Promise<string> {
    return (await this.gatedWithGoal()).profileId
  }

  /** `gated`, and the goal it found. */
  private async gatedWithGoal(): Promise<{ profileId: string; goal: Goal }> {
    const user = requireUser()
    if (user.status !== 'verified') throw new ForbiddenError('SIGNUP_REQUIRED', 'Sign up to get your routine')
    // requireGoal only answers a goal that was sorted, so there is one.
    const goal = (await this.goals.requireGoal()).goal!
    if (VerdictService.lacksTapers(await this.workbook.verdictReference())) throw new UnavailableError('VERDICT_UNAVAILABLE', 'The routine is not available yet')
    return { profileId: user.profileId, goal }
  }

  private async publishRoutine(profileId: string, view: RoutineView): Promise<void> {
    try {
      await this.events.publish(RoutineViewerService.streamKey(profileId), { type: 'routine', routine: await this.shown(profileId, view, false) })
    } catch {
      console.error({ outcome: 'routine-publish-failed', profileId })
    }
  }

  private async publishDone(profileId: string): Promise<void> {
    try {
      await this.events.publish(RoutineViewerService.streamKey(profileId), { type: 'done' })
    } catch {
      console.error({ outcome: 'routine-publish-failed', profileId })
    }
  }

  /**
   * The body for a routine view. `serve` marks the version shown as served (the first time only), after what changed since the one shown before is worked out, so a
   * second read shows the same marks. A failed mark is logged and never fails the read. A pending routine reads nothing else.
   */
  private async shown(profileId: string, view: RoutineView, serve: boolean): Promise<RoutineResponse> {
    if (view.status === 'pending') return { status: 'pending' }
    const { version } = view
    const previous = await this.repository.lastServedBefore(profileId, version.id)
    const body = toRoutineResponse(await this.inputFor(profileId, view.status, version, previous, true))
    if (serve && version.servedAt === null) {
      try {
        await this.repository.markServed(version.id, this.now())
      } catch (error) {
        console.error({ outcome: 'routine-mark-served-failed', profileId, versionId: version.id, error: describeError(error) })
      }
    }
    return body
  }

  /**
   * Everything the routine screen is made of, read around a version: the shown version's recommended products, and the previous one's (a product that has since become
   * the user's own is compared by its formulation). `withTapers` also reads the step-down templates, which only the body shows.
   */
  private async inputFor(profileId: string, status: 'ready' | 'updating', version: RoutineVersionRow, previous: RoutineVersionRow | null, withTapers: boolean): Promise<RoutineViewInput> {
    const codes = [...new Set([...version.steps, ...(previous?.steps ?? [])].flatMap(({ product }) => (product.kind === 'candidate' ? [product.code] : [])))]
    const [shopping, entries, recommended, countries, tapers] = await Promise.all([
      this.recommendations.shoppingFor(profileId),
      this.shelf.activeEntriesFor(profileId),
      this.workbook.recommendedByCode(codes),
      this.workbook.countries(),
      withTapers ? this.workbook.tapersByCode([...new Set(version.tapers.map(({ templateId }) => templateId))]) : new Map(),
    ])
    const facts = await this.catalog.shelfFacts(entries.flatMap((entry) => (entry.kind === 'product' ? [entry.formulationId] : [])))
    const own = new Map<string, { brand: string | null; name: string; formulationId?: string; form?: ProductForm | null }>()
    for (const entry of entries) {
      if (entry.kind === 'no-label') own.set(entry.id, { brand: null, name: NO_LABEL_NAME })
      else {
        const named = facts.get(entry.formulationId)
        if (named) own.set(entry.id, { brand: named.brand, name: named.name, formulationId: entry.formulationId, form: named.form })
      }
    }
    const summaries = await this.catalog.productSummaries([...recommended.values()].flatMap((row) => (row.formulationId ? [row.formulationId] : [])))
    return { status, version, previous, country: shopping.country, countries, own, recommended, summaries, tapers }
  }

  private static versionIdOf(view: RoutineView): string | null {
    return view.status === 'pending' ? null : view.version.id
  }

  private static streamKey(profileId: string): string {
    return `routine:${profileId}`
  }
}
