import { describeError } from '../../jobs/safe-error'
import { requireUser } from '../../lib/context'
import { ConflictError, ForbiddenError, UnavailableError } from '../../lib/errors'
import { localDay, localHour, usableZone } from '../../lib/local-day'
import type { ScanEvents } from '../../providers/scan-events/scan-events.provider'
import type { ProductCatalogService } from '../catalog/catalog.service'
import { rulesMatching } from '../catalog/catalog.rules'
import { ROUTINE_STEPS, type IngredientGroup, type ProductForm, type RoutineStep } from '../catalog/catalog.vocabulary'
import type { CatalogWorkbookService } from '../catalog/catalog.workbook.service'
import type { GoalsService } from '../goals/goals.service'
import type { Goal } from '../goals/goals.vocabulary'
import type { InboxService } from '../inbox/inbox.service'
import type { RecommendationService } from '../recommendations/recommendations.service'
import type { RemindersService } from '../reminders/reminders.service'
import type { SafetyService } from '../safety/safety.service'
import type { ShelfActiveEntry, ShelfService } from '../shelf/shelf.service'
import type { SkinCareRoutine, SkinCareState, StepPause } from '../skin-care/skin-care.types'
import { NO_LABEL_NAME } from '../verdicts/verdicts.inputs'
import { VerdictService } from '../verdicts/verdicts.service'
import type { RoutineCheckInsRepository } from './routines.check-ins.repository'
import type { RoutinesRepository, RoutineVersionRow } from './routines.repository'
import type { RoutineService, RoutineView } from './routines.service'
import { titleFor } from './routines.copy'
import { commonlySoldAt, LOOK_FOR_PRODUCTS, whyFor } from './routines.look-for'
import type { LookForResponse, RoutineResponse, TodayResponse } from './routines.schemas'
import type { StoredRoutineStep } from './routines.types'
import { isSoldIn, stepDownsOf, stepTitleOf, toReminderPlan, toRoutineResponse, toTodayLists, weekOf, type ReminderPlan, type RoutineViewInput, type StepOverlay } from './routines.view'

export type RoutineViewerServiceDeps = {
  routines: Pick<RoutineService, 'current' | 'start' | 'gotIt' | 'request' | 'requestIfStale'>
  goals: Pick<GoalsService, 'requireGoal'>
  workbook: Pick<CatalogWorkbookService, 'verdictReference' | 'recommendedByCode' | 'tapersByCode' | 'countries' | 'guideFor' | 'weekCardFor'>
  catalog: Pick<ProductCatalogService, 'shelfFacts' | 'productSummaries'>
  shelf: Pick<ShelfService, 'activeEntriesFor'>
  recommendations: Pick<RecommendationService, 'shoppingFor' | 'candidatesFor'>
  /** Whether the person is pregnant or breastfeeding, for the guide's pregnancy text. */
  safety: Pick<SafetyService, 'currentOrNull'>
  repository: Pick<RoutinesRepository, 'lastServedBefore' | 'markServed'>
  /** What the skin-care module says about a profile on its local day: the pauses and the hold that change what the routine shows. Required: a viewer without it would show every entry as active. */
  skinCare: { stateFor(profileId: string, today: string): Promise<SkinCareState>; checkInsDue(profileId: string, today: string): Promise<StepPause[]> }
  /** Where the person's day begins (the state is asked for their local day), and whether reminders are on, for Today's banner (one read of both). */
  reminders: Pick<RemindersService, 'zoneFor' | 'zoneAndEnabledFor'>
  /** The day's check-ins, for Today's done flags. */
  checkIns: Pick<RoutineCheckInsRepository, 'list'>
  /** The unread count and newest rows Today carries. */
  inbox: Pick<InboxService, 'summaryFor'>
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
  /** The ingredient groups that make a product an active: the ones a pause is for. In vocabulary order, which is the order the ladder group is chosen in. */
  private static readonly ACTIVE_GROUPS = ['retinoid', 'exfoliating-acid', 'benzoyl-peroxide'] as const satisfies readonly IngredientGroup[]

  /** Today's morning list runs until this hour of the person's local day, and its evening list from it: fixed, so the reminder times only decide when a push goes out. */
  private static readonly EVENING_FROM_HOUR = 15

  private readonly routines: RoutineViewerServiceDeps['routines']
  private readonly goals: RoutineViewerServiceDeps['goals']
  private readonly workbook: RoutineViewerServiceDeps['workbook']
  private readonly catalog: RoutineViewerServiceDeps['catalog']
  private readonly shelf: RoutineViewerServiceDeps['shelf']
  private readonly recommendations: RoutineViewerServiceDeps['recommendations']
  private readonly safety: RoutineViewerServiceDeps['safety']
  private readonly repository: RoutineViewerServiceDeps['repository']
  private readonly skinCare: RoutineViewerServiceDeps['skinCare']
  private readonly reminders: RoutineViewerServiceDeps['reminders']
  private readonly checkIns: RoutineViewerServiceDeps['checkIns']
  private readonly inbox: RoutineViewerServiceDeps['inbox']
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
    this.skinCare = deps.skinCare
    this.reminders = deps.reminders
    this.checkIns = deps.checkIns
    this.inbox = deps.inbox
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
   * Today (screens 5.1A/B), computed for the caller's local day and asking for no build: the gates are `lookFor`'s (so nothing of skin-care is read for a guest, a profile with no goal or while the verdict is
   * unavailable). The week and its reviewed card (for the current goal, and the step-down version while a dated step-down runs), the current half of the day (morning before 15:00 local, evening from
   * then; fixed, never the reminder time) and the other, each with the entries due that day (a paused or held step, a rest day and an as-needed step are left out) and whether it was ticked off, the
   * progress of each running step-down, the steps being brought back, the check-ins due, a hold, the reminders banner and the inbox summary. Before day 1 there is no week, card or entry, and the hold,
   * the check-ins due, the banner and the inbox are still read, since a red flag can be logged before Start. Fails closed: when skin-care cannot be read, so does Today.
   */
  async today(): Promise<TodayResponse> {
    const { profileId, goal } = await this.gatedWithGoal()
    const now = this.now()
    const settings = await this.reminders.zoneAndEnabledFor(profileId)
    const zone = usableZone(now, settings.zone)
    const day = localDay(now, zone)
    const half: 'morning' | 'evening' = localHour(now, zone) < RoutineViewerService.EVENING_FROM_HOUR ? 'morning' : 'evening'
    // The state settles the pauses first (it ends a ladder, replaces a pause whose product changed, pauses a step again), so the check-ins due are asked after it, never beside it.
    const stateRead = this.skinCare.stateFor(profileId, day)
    const [view, state, due, inbox] = await Promise.all([
      this.routines.current(profileId),
      stateRead,
      stateRead.then(() => this.skinCare.checkInsDue(profileId, day)),
      this.inboxSummary(profileId),
    ])
    const hold = state.held ? ({ title: 'See a professional' } as const) : null
    const rest = { day, half, hold, remindersOff: !settings.enabled, inbox }
    const nothing = { done: false, entries: [] }
    if (view.status === 'pending') {
      return { started: false, startsOn: null, week: null, card: null, current: nothing, other: nothing, allDone: false, stepDowns: [], checkInsDue: due.map(({ id, step, checkDay }) => ({ pauseId: id, step, title: null, checkDay })), bringingBack: [], paused: [], ...rest }
    }
    const { input, entries } = await this.aroundVersion(profileId, view.status, view.version, null, true)
    const shown = await this.overlaid(profileId, input, entries, state)
    const titles = new Map(shown.version.steps.map((step) => [step.step, stepTitleOf(step, shown)]))
    const checkInsDue = due.map(({ id, step, checkDay }) => ({ pauseId: id, step, title: step === null ? null : (titles.get(step) ?? null), checkDay }))
    const paused = state.pauses.flatMap(({ step, state: kind, pauseId, checkDay }) => {
      const title = titles.get(step)
      return kind === 'paused' && pauseId !== undefined && checkDay !== undefined && title !== undefined ? [{ pauseId, step, title, checkDay }] : []
    })
    const { startedOn } = view.version
    const startsOn = startedOn === null ? null : startedOn.toISOString().slice(0, 10)
    const week = startsOn === null ? null : weekOf(startsOn, day)
    // Start makes tomorrow day 1: on the day of the tap the routine has started, and there is nothing to show yet.
    if (startsOn === null || week === null) {
      return { started: startsOn !== null, startsOn, week: null, card: null, current: nothing, other: nothing, allDone: false, stepDowns: [], checkInsDue, bringingBack: [], paused, ...rest }
    }
    const progress = stepDownsOf(shown, day).filter(({ running }) => running)
    const [card, ticked] = await Promise.all([this.workbook.weekCardFor(week, goal, progress.length > 0), this.checkIns.list(profileId, day, day)])
    const lists = toTodayLists(shown, day)
    // A half with nothing due has nothing to tick off, so it counts as done: a day whose evening is all paused or resting can still be all done.
    const doneIn = (time: 'morning' | 'evening') => lists[time].length === 0 || ticked.some((checkIn) => checkIn.time === time)
    const other = half === 'morning' ? 'evening' : 'morning'
    const bringingBack = shown.version.steps
      .map((step) => ({ step, over: shown.overlay?.get(step) }))
      .sort((a, b) => ROUTINE_STEPS.indexOf(a.step.step) - ROUTINE_STEPS.indexOf(b.step.step))
      .flatMap(({ step, over }) => {
        if (over?.status !== 'bringing-back' || over.rung === undefined || over.of === undefined) return []
        const title = stepTitleOf(step, shown)
        return [{ step: step.step, title, rung: over.rung, of: over.of, line: `Bringing back ${title}: step ${over.rung} of ${over.of}` }]
      })
    return {
      started: true,
      startsOn,
      week,
      card,
      current: { done: doneIn(half), entries: lists[half] },
      other: { done: doneIn(other), entries: lists[other] },
      allDone: doneIn('morning') && doneIn('evening'),
      stepDowns: progress.map(({ entryId, title, step, of }) => ({ entryId, title, step, of, line: `Step-down: step ${step} of ${of}` })),
      checkInsDue,
      bringingBack,
      paused,
      ...rest,
    }
  }

  /** The inbox rows Today carries, field by field. Only the skin-care reads fail Today closed: an inbox that cannot be read is logged and shown empty. */
  private async inboxSummary(profileId: string): Promise<TodayResponse['inbox']> {
    try {
      const { unread, latest } = await this.inbox.summaryFor(profileId)
      return { unread, latest: latest.map(({ id, kind, day, title, body, link, read, createdAt }) => ({ id, kind, day, title, body, link, read, createdAt: createdAt.toISOString() })) }
    } catch {
      console.error({ outcome: 'today-inbox-failed', profileId })
      return { unread: 0, latest: [] }
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

  /**
   * The routine in force as the skin-care module reads it: day 1, and for each step its title, stored product, the catalog product it is, the day it last changed and the active
   * groups its ingredients hold (read against the approved ingredient rules, as the verdict's floor reads them). By profile id with no session or gates. Null while there is no
   * routine to read (none, or one a safety change hides). It asks for no build, marks nothing served and reads no goal, and it never asks `skinCare.stateFor`, which reads this.
   */
  async skinCareRoutineFor(profileId: string): Promise<SkinCareRoutine | null> {
    const view = await this.routines.current(profileId)
    if (view.status === 'pending') return null
    const { version } = view
    const { input, entries } = await this.aroundVersion(profileId, view.status, version, null, true)
    const identities = version.steps.map((step) => RoutineViewerService.identityOf(step, entries, input.recommended))
    const groups = await this.activeGroupsOf(identities)
    const dayOne = version.startedOn === null ? null : version.startedOn.toISOString().slice(0, 10)
    const ordered = version.steps.map((step, at) => ({ step, at })).sort((a, b) => ROUTINE_STEPS.indexOf(a.step.step) - ROUTINE_STEPS.indexOf(b.step.step))
    return {
      dayOne,
      steps: ordered.map(({ step, at }) => ({
        step: step.step,
        title: stepTitleOf(step, input),
        productRef: step.product,
        productId: identities[at]!.productId,
        changedOn: step.changedOn === null ? dayOne : step.changedOn.toISOString().slice(0, 10),
        activeGroups: groups[at]!,
      })),
      stepDownRunning: stepDownsOf(input, await this.todayOf(profileId)).some(({ running }) => running),
    }
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
    const { input, entries } = await this.aroundVersion(profileId, status, version, previous, withTapers)
    return this.overlaid(profileId, input, entries)
  }

  /** `inputFor` without what the skin-care state does to the steps, and the shelf entries it read. */
  private async aroundVersion(
    profileId: string,
    status: 'ready' | 'updating',
    version: RoutineVersionRow,
    previous: RoutineVersionRow | null,
    withTapers: boolean,
  ): Promise<{ input: RoutineViewInput; entries: ShelfActiveEntry[] }> {
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
    return { input: { status, version, previous, country: shopping.country, countries, own, recommended, summaries, tapers }, entries }
  }

  /**
   * The input with what the skin-care state does to each step: a pause names a step and the key of its product (the catalog product it is, else the shelf entry's id), so a product
   * that has become the person's own entry of the same product is still the paused one. An open hold marks the steps whose product holds an active group. With no pause and no hold the input is returned as it is.
   */
  private async overlaid(profileId: string, input: RoutineViewInput, entries: ShelfActiveEntry[], read?: SkinCareState): Promise<RoutineViewInput> {
    const state = read ?? (await this.skinCare.stateFor(profileId, await this.todayOf(profileId)))
    if (state.pauses.length === 0 && !state.held) return input
    const { steps } = input.version
    const identities = steps.map((step) => RoutineViewerService.identityOf(step, entries, input.recommended))
    const groups = state.held ? await this.activeGroupsOf(identities) : null
    const overlay = new Map<StoredRoutineStep, StepOverlay>()
    steps.forEach((step, at) => {
      // A pause is keyed by the catalog product, else by the shelf entry (a product with no label has no catalog product), as skin-care keys it.
      const key = identities[at]!.productId ?? (step.product.kind === 'shelf' ? step.product.id : null)
      const pause = key === null ? undefined : state.pauses.find((paused) => paused.step === step.step && paused.productId === key)
      const held = (groups?.[at]?.length ?? 0) > 0
      // An open hold wins over a rung: nothing active comes back while it is open. A paused step stays paused (both are left out of the reminders).
      if (pause && !(held && pause.state === 'bringing-back')) overlay.set(step, { status: pause.state, ...(pause.frequency === undefined ? {} : { frequency: pause.frequency }), ...(pause.anchor === undefined ? {} : { anchor: pause.anchor }), ...(pause.rung === undefined ? {} : { rung: pause.rung }), ...(pause.of === undefined ? {} : { of: pause.of }) })
      else if (held) overlay.set(step, { status: 'held' })
    })
    return { ...input, overlay }
  }

  /** The person's local day, 'YYYY-MM-DD': the stored zone's, or UTC with none or with one Intl cannot use. */
  private async todayOf(profileId: string): Promise<string> {
    const now = this.now()
    return localDay(now, usableZone(now, await this.reminders.zoneFor(profileId)))
  }

  /** The catalog product a step's product is, and the formulation its ingredients are read from. Both null for an entry with no label, "use what you have", and a product that has left the shelf or the catalog. */
  private static identityOf(step: StoredRoutineStep, entries: readonly ShelfActiveEntry[], recommended: RoutineViewInput['recommended']): { productId: string | null; formulationId: string | null } {
    const { product } = step
    if (product.kind === 'shelf') {
      const entry = entries.find(({ id }) => id === product.id)
      return entry?.kind === 'product' ? { productId: entry.productId, formulationId: entry.formulationId } : { productId: null, formulationId: null }
    }
    const row = product.kind === 'candidate' ? recommended.get(product.code) : undefined
    return row ? { productId: row.productId, formulationId: row.formulationId } : { productId: null, formulationId: null }
  }

  /** For each identity, the active groups its formulation's ingredients hold, matched against the approved ingredient rules (which carry their group, as the verdict's floor reads them). */
  private async activeGroupsOf(identities: readonly { formulationId: string | null }[]): Promise<IngredientGroup[][]> {
    const ids = [...new Set(identities.flatMap(({ formulationId }) => (formulationId === null ? [] : [formulationId])))]
    if (ids.length === 0) return identities.map(() => [])
    const [facts, { rules }] = await Promise.all([this.catalog.shelfFacts(ids), this.workbook.verdictReference()])
    return identities.map(({ formulationId }) => {
      const held = new Set<IngredientGroup>()
      for (const ingredient of (formulationId === null ? undefined : facts.get(formulationId))?.ingredients ?? []) {
        for (const { group } of rulesMatching(ingredient, rules)) if (group !== null) held.add(group)
      }
      return RoutineViewerService.ACTIVE_GROUPS.filter((group) => held.has(group))
    })
  }

  private static versionIdOf(view: RoutineView): string | null {
    return view.status === 'pending' ? null : view.version.id
  }

  private static streamKey(profileId: string): string {
    return `routine:${profileId}`
  }
}
