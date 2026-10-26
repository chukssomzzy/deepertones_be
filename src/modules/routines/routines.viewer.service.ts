import { describeError } from '../../jobs/safe-error'
import { requireUser } from '../../lib/context'
import { ConflictError, ForbiddenError, UnavailableError } from '../../lib/errors'
import type { ScanEvents } from '../../providers/scan-events/scan-events.provider'
import type { ProductCatalogService } from '../catalog/catalog.service'
import type { RoutineStep } from '../catalog/catalog.vocabulary'
import type { CatalogWorkbookService } from '../catalog/catalog.workbook.service'
import type { GoalsService } from '../goals/goals.service'
import type { RecommendationService } from '../recommendations/recommendations.service'
import type { ShelfService } from '../shelf/shelf.service'
import { NO_LABEL_NAME } from '../verdicts/verdicts.inputs'
import { VerdictService } from '../verdicts/verdicts.service'
import type { RoutinesRepository } from './routines.repository'
import type { RoutineService, RoutineView } from './routines.service'
import type { RoutineResponse } from './routines.schemas'
import { isSoldIn, toRoutineResponse } from './routines.view'

export type RoutineViewServiceDeps = {
  routines: Pick<RoutineService, 'current' | 'start' | 'gotIt' | 'request' | 'requestIfStale'>
  goals: Pick<GoalsService, 'requireGoal'>
  workbook: Pick<CatalogWorkbookService, 'verdictReference' | 'recommendedByCode' | 'tapersByCode' | 'countries'>
  catalog: Pick<ProductCatalogService, 'shelfFacts' | 'productSummaries'>
  shelf: Pick<ShelfService, 'activeEntriesFor'>
  recommendations: Pick<RecommendationService, 'shoppingFor'>
  repository: Pick<RoutinesRepository, 'lastServedBefore' | 'markServed'>
  /** Tells whoever follows a profile's routine that it changed (`routine:<profileId>`). */
  events: ScanEvents
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
export class RoutineViewService {
  private readonly routines: RoutineViewServiceDeps['routines']
  private readonly goals: RoutineViewServiceDeps['goals']
  private readonly workbook: RoutineViewServiceDeps['workbook']
  private readonly catalog: RoutineViewServiceDeps['catalog']
  private readonly shelf: RoutineViewServiceDeps['shelf']
  private readonly recommendations: RoutineViewServiceDeps['recommendations']
  private readonly repository: RoutineViewServiceDeps['repository']
  private readonly events: ScanEvents
  private readonly now: () => Date

  constructor(deps: RoutineViewServiceDeps) {
    this.routines = deps.routines
    this.goals = deps.goals
    this.workbook = deps.workbook
    this.catalog = deps.catalog
    this.shelf = deps.shelf
    this.recommendations = deps.recommendations
    this.repository = deps.repository
    this.events = deps.events
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
    const stream = await this.events.subscribe(RoutineViewService.streamKey(profileId), await this.shown(profileId, view, true))
    let latest: RoutineView
    try {
      latest = await this.routines.current(profileId)
    } catch {
      console.error({ outcome: 'routine-watch-reread-failed', profileId })
      return stream
    }
    if (latest.status !== view.status || RoutineViewService.versionIdOf(latest) !== RoutineViewService.versionIdOf(view)) await this.publishRoutine(profileId, latest)
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
   * the job. The answer is the routine in force, as `updating`, whether or not a build was queued (one may be under way already, which will have it).
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
    await this.routines.request(profileId, 'sold-here', `sold-here:${view.version.id}:${step}`, { exclude: { step, code } })
    return this.shown(profileId, { status: 'updating', version: view.version }, false)
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

  /** The caller's profile once they may see a routine: signed up, with a goal, and the verdict available. */
  private async gated(): Promise<string> {
    const user = requireUser()
    if (user.status !== 'verified') throw new ForbiddenError('SIGNUP_REQUIRED', 'Sign up to get your routine')
    await this.goals.requireGoal()
    if (VerdictService.lacksTapers(await this.workbook.verdictReference())) throw new UnavailableError('VERDICT_UNAVAILABLE', 'The routine is not available yet')
    return user.profileId
  }

  private async publishRoutine(profileId: string, view: RoutineView): Promise<void> {
    try {
      await this.events.publish(RoutineViewService.streamKey(profileId), { type: 'routine', routine: await this.shown(profileId, view, false) })
    } catch {
      console.error({ outcome: 'routine-publish-failed', profileId })
    }
  }

  private async publishDone(profileId: string): Promise<void> {
    try {
      await this.events.publish(RoutineViewService.streamKey(profileId), { type: 'done' })
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
    const codes = [...new Set(version.steps.flatMap(({ product }) => (product.kind === 'candidate' ? [product.code] : [])))]
    const [shopping, entries, recommended, countries, tapers] = await Promise.all([
      this.recommendations.shoppingFor(profileId),
      this.shelf.activeEntriesFor(profileId),
      this.workbook.recommendedByCode(codes),
      this.workbook.countries(),
      this.workbook.tapersByCode([...new Set(version.tapers.map(({ templateId }) => templateId))]),
    ])
    const facts = await this.catalog.shelfFacts(entries.flatMap((entry) => (entry.kind === 'product' ? [entry.formulationId] : [])))
    const own = new Map<string, { brand: string | null; name: string }>()
    for (const entry of entries) {
      const named = entry.kind === 'no-label' ? { brand: null, name: NO_LABEL_NAME } : facts.get(entry.formulationId)
      if (named) own.set(entry.id, { brand: named.brand, name: named.name })
    }
    const summaries = await this.catalog.productSummaries([...recommended.values()].flatMap((row) => (row.formulationId ? [row.formulationId] : [])))
    const body = toRoutineResponse({ status: view.status, version, previous, country: shopping.country, countries, own, recommended, summaries, tapers })
    if (serve && version.servedAt === null) {
      try {
        await this.repository.markServed(version.id, this.now())
      } catch (error) {
        console.error({ outcome: 'routine-mark-served-failed', profileId, versionId: version.id, error: describeError(error) })
      }
    }
    return body
  }

  private static versionIdOf(view: RoutineView): string | null {
    return view.status === 'pending' ? null : view.version.id
  }

  private static streamKey(profileId: string): string {
    return `routine:${profileId}`
  }
}
