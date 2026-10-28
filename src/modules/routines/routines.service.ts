import { describeError } from '../../jobs/safe-error'
import type { Actor } from '../../lib/context'
import { runAs } from '../../lib/context'
import { ConflictError, NotFoundError } from '../../lib/errors'
import { localDate, nextLocalDay } from '../../lib/local-day'
import { stableJson } from '../../lib/stable-json'
import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import type { RoutineRetry, RoutineWriter } from '../../providers/routine-writing/routine-writer.provider'
import type { ProductCatalogService } from '../catalog/catalog.service'
import { ROUTINE_STEPS, type ProductForm, type RoutineStep } from '../catalog/catalog.vocabulary'
import type { CatalogWorkbookService } from '../catalog/catalog.workbook.service'
import type { FaceScanService } from '../face-scans/face-scans.service'
import type { GoalsService } from '../goals/goals.service'
import type { Goal } from '../goals/goals.vocabulary'
import type { ProfilesService } from '../profiles/profiles.service'
import type { RecommendationService } from '../recommendations/recommendations.service'
import type { Candidate } from '../recommendations/recommendations.types'
import type { RemindersService } from '../reminders/reminders.service'
import type { SafetyService } from '../safety/safety.service'
import type { ShelfActiveEntry, ShelfService } from '../shelf/shelf.service'
import { NO_LABEL_NAME } from '../verdicts/verdicts.inputs'
import type { SavedVerdictView, VerdictService } from '../verdicts/verdicts.service'
import { expectationFor, titleFor } from './routines.copy'
import { checkRoutine } from './routines.gates'
import { routineFingerprint } from './routines.fingerprint'
import { applyOutcomeHints } from './routines.hints'
import { buildRoutineSpec, type BuildRoutineMessage } from './routines.job-specs'
import type { OutcomeCountsRepository } from './routines.outcome-counts.repository'
import { hintsShown } from './routines.outcomes'
import type { CompletedRoutineBuild, RoutineRequestRow, RoutineVersionRow, RoutinesRepository } from './routines.repository'
import { rulesOnlyRoutine } from './routines.rules-only'
import { ROUTINE_RULES_VERSION } from './routines.rules'
import { assembleSkeleton, candidateOf, cautionsOf, sunscreenKept } from './routines.skeleton'
import { asRoutine, sameProductBefore, spliceFixed, stableMerge, type SplicedRoutine, type StableCarry } from './routines.stable'
import type { NotInRoutineItem, ShelfCounts } from './routines.table'
import type { CautionState, GateFailure, Routine, RoutineSkeleton, SkeletonShelfProduct, StoredRoutineStep, StoredTaper } from './routines.types'

export type RoutineServiceDeps = {
  verdicts: Pick<VerdictService, 'savedFor'>
  recommendations: Pick<RecommendationService, 'candidatesFor' | 'shoppingFor'>
  goals: Pick<GoalsService, 'goalFor'>
  safety: Pick<SafetyService, 'snapshotFor'>
  shelf: Pick<ShelfService, 'activeEntriesFor' | 'add'>
  catalog: Pick<ProductCatalogService, 'shelfFacts'>
  faceScans: Pick<FaceScanService, 'seenFor'>
  workbook: Pick<CatalogWorkbookService, 'verdictReference' | 'countries'>
  profiles: Pick<ProfilesService, 'find'>
  /** The profile's stored time zone, which decides where its local days begin. */
  reminders: Pick<RemindersService, 'zoneFor'>
  writer: RoutineWriter
  /** The model and prompt hash the writer runs under, recorded on every routine it writes. */
  writerIdentity: { model: string; promptHash: string }
  repository: RoutinesRepository
  /** What other users' outcomes were with each product, read for the hints of the routines that show them. */
  outcomeCounts: Pick<OutcomeCountsRepository, 'counts'>
  jobs: JobQueue
  /** Whether routines are switched on in this environment: off, `request` does nothing at all. */
  enabled: boolean
  /** Tells whoever follows the profile's routine that it changed (the viewer's, which publishes it on `routine:<profileId>`); a lazy callback because the viewer reads this service. */
  announce: (profileId: string) => Promise<void>
  now?: () => Date
  newId?: () => string
}

/** Why a version is built: the stored reasons. */
export type RoutineBuildReason = RoutineVersionRow['reason']

/** `find one sold here` re-picks one step: that code is taken out of its gap, so the step is broken and picks again. */
export type RoutineBuildOptions = { exclude?: { step: RoutineStep; code: string } }

export type RoutineView = { status: 'pending' } | { status: 'updating'; version: RoutineVersionRow } | { status: 'ready'; version: RoutineVersionRow }

/** What a build leaves for the caller to ask again about later: `waiting` means nothing was built because something it reads is not there yet. */
export type RoutineBuildResult = 'built' | 'unchanged' | 'waiting'

// The readers' own refusals for a profile that is not far enough along yet: the routine waits for it, it is not an error.
const NOT_YET = new Set(['GOAL_REQUIRED', 'SAFETY_ANSWERS_REQUIRED', 'SHOPPING_REQUIRED'])

type Facts = {
  profileId: string
  skeleton: RoutineSkeleton
  /** Every step's candidates in the shopping country, as the recommendation rules gave them (the excluded code already out). */
  offered: Record<RoutineStep, Candidate[]>
  entries: ShelfActiveEntry[]
  /** For each shelf product the skeleton is built from (by entry id): the form of its product and the verdict item's one-line reason, for the "Not in your routine" list. */
  noted: ReadonlyMap<string, { form: ProductForm | null; reason: string }>
  country: string
}

/**
 * A profile's routine (spec #189): the rules decide what the shelf and the goal allow, the writer puts it in words, and the gates check what it wrote. A routine is
 * stored as versions. Before the person taps Start every build writes the routine afresh. After Start a rebuild keeps every step that still passes the gates
 * exactly as it was and asks the writer only about the steps that broke (routines.stable.ts). The writer is tried three times, told which gates its last routine
 * failed, and the rules' own routine is saved when it cannot do it, or after five builds with the writer in a day. Everything is read by profile id, so a job needs
 * no session; what the recommendation and shelf modules read as the caller runs as the profile's own verified user.
 */
export class RoutineService {
  private static readonly MINUTE_MS = 60 * 1000
  private static readonly DAY_MS = 24 * 60 * RoutineService.MINUTE_MS
  // A pending version this old had its build die: it is ignored, and the next build goes on over it.
  private static readonly STALE_AFTER_MS = 15 * RoutineService.MINUTE_MS
  private static readonly WRITER_TRIES = 3
  // Builds that called the writer in the last 24 hours; at this many, the rules alone write the next.
  private static readonly WRITER_BUILDS_PER_DAY = 5
  // A build request claimed this long ago had its build die: the next request takes the claim over.
  private static readonly CLAIM_STALE_AFTER_MS = 15 * RoutineService.MINUTE_MS
  // The first build and the review-point rebuild wait for the verdict to be ready: a minute apart, 15 times, then they give up quietly.
  private static readonly MAX_WAITS = 15
  private static readonly WAIT_SECONDS = 60
  // The daily sweeps look at this many rows each, so a day's work stays inside the Worker's subrequests; the rest wait for the next run.
  private static readonly SWEEP_LIMIT = 200
  private static readonly WAITING_REASONS: ReadonlySet<RoutineBuildReason> = new Set(['first', 'review-point'])

  private readonly verdicts: RoutineServiceDeps['verdicts']
  private readonly recommendations: RoutineServiceDeps['recommendations']
  private readonly goals: RoutineServiceDeps['goals']
  private readonly safety: RoutineServiceDeps['safety']
  private readonly shelf: RoutineServiceDeps['shelf']
  private readonly catalog: RoutineServiceDeps['catalog']
  private readonly faceScans: RoutineServiceDeps['faceScans']
  private readonly workbook: RoutineServiceDeps['workbook']
  private readonly profiles: RoutineServiceDeps['profiles']
  private readonly reminders: RoutineServiceDeps['reminders']
  private readonly writer: RoutineWriter
  private readonly writerIdentity: RoutineServiceDeps['writerIdentity']
  private readonly repository: RoutinesRepository
  private readonly outcomeCounts: RoutineServiceDeps['outcomeCounts']
  private readonly jobs: JobQueue
  private readonly enabled: boolean
  private readonly announce: RoutineServiceDeps['announce']
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: RoutineServiceDeps) {
    this.verdicts = deps.verdicts
    this.recommendations = deps.recommendations
    this.goals = deps.goals
    this.safety = deps.safety
    this.shelf = deps.shelf
    this.catalog = deps.catalog
    this.faceScans = deps.faceScans
    this.workbook = deps.workbook
    this.profiles = deps.profiles
    this.reminders = deps.reminders
    this.writer = deps.writer
    this.writerIdentity = deps.writerIdentity
    this.repository = deps.repository
    this.outcomeCounts = deps.outcomeCounts
    this.jobs = deps.jobs
    this.enabled = deps.enabled
    this.announce = deps.announce
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Builds the profile's next routine version: `waiting` (nothing appended) while the verdict is not saved and ready for the inputs as they are, or the goal, the
   * safety answers or the shopping country are missing. After Start, `unchanged` (nothing appended) when no step, step-down or caution changed; otherwise `built`.
   * A profile whose user has not verified (a guest) never gets one: `waiting`, however the build was asked for. A failure of the repository or of reading the other
   * modules throws, leaving a pending version if one was appended, which goes stale on its own.
   */
  async build(profileId: string, reason: RoutineBuildReason, options: RoutineBuildOptions = {}): Promise<RoutineBuildResult> {
    const profile = await this.profiles.find(profileId)
    if (!profile) {
      console.log({ outcome: 'routine-profile-missing', profileId })
      return 'waiting'
    }
    if (profile.ownerStatus !== 'verified') {
      console.log({ outcome: 'routine-not-verified', profileId })
      return 'waiting'
    }
    return runAs(RoutineService.actorOf(profile.userId, profileId), () => this.buildAs(profileId, reason, options))
  }

  /**
   * The routine to show: the one in force (`ready`), `updating` while a newer build is under way, and `pending` when there is nothing to show yet or the one in force
   * no longer fits the person's safety answers. That hides it whether or not a build is under way (even a dead one, or none could start yet), until a build that
   * stores the new cautions replaces it. A build that died long ago is not under way.
   */
  async current(profileId: string): Promise<RoutineView> {
    const [ready, latest] = await Promise.all([this.repository.current(profileId), this.repository.latest(profileId)])
    if (!ready || (await this.hiddenBySafety(profileId, ready))) return { status: 'pending' }
    if (latest?.status !== 'pending' || this.now().getTime() - latest.createdAt.getTime() >= RoutineService.STALE_AFTER_MS) return { status: 'ready', version: ready }
    return { status: 'updating', version: ready }
  }

  /**
   * Makes tomorrow (the person's next local date in their stored time zone, else the next UTC date; stored as that date's UTC midnight and never moved by a later change of zone) day 1 of the routine in force, and of its step-downs: the person taps Start on the evening they decide, and the plan begins with the morning after. 409 `ROUTINE_NOT_READY` before there is one, and while a safety change hides it (`current`
   * answers pending): a routine the person cannot see is not started. Starting again changes nothing.
   */
  async start(profileId: string): Promise<void> {
    if ((await this.current(profileId)).status === 'pending') throw new ConflictError('ROUTINE_NOT_READY', 'Your routine is not ready yet')
    const zone = await this.reminders.zoneFor(profileId)
    // The zone only decides which date tomorrow is; what is stored is that calendar date (its UTC midnight), so a later change of zone moves nothing.
    await this.repository.markStarted(profileId, localDate(nextLocalDay(this.now(), zone), zone))
  }

  /**
   * "I got it" for a recommended product: puts it on the shelf (by its catalog product, as the shelf's own add does) and appends a copy of the routine in force with
   * that step marked got, with no writer call. 409 `ROUTINE_NOT_READY` before there is a routine and 409 `STEP_NOT_RECOMMENDED` when the step does not hold a
   * recommended product, or its product is sold nowhere now. The swap to the shelf entry happens at the next rebuild, once the shelf holds the product. Also 409
   * `ROUTINE_NOT_READY` while a safety change hides the routine. Idempotent: a step already marked got changes nothing (no shelf add, no version).
   */
  async gotIt(profileId: string, step: RoutineStep, clientIp: string): Promise<void> {
    const profile = await this.profiles.find(profileId)
    if (!profile) throw new NotFoundError('PROFILE_NOT_FOUND', 'No such profile')
    const view = await this.current(profileId)
    if (view.status === 'pending') throw new ConflictError('ROUTINE_NOT_READY', 'Your routine is not ready yet')
    const ready = view.version
    const chosen = ready.steps.find((entry) => entry.step === step && entry.product.kind === 'candidate')
    if (chosen?.product.kind !== 'candidate') throw new ConflictError('STEP_NOT_RECOMMENDED', 'This step has no recommended product')
    if (chosen.gotIt) return
    const code = chosen.product.code
    await runAs(RoutineService.actorOf(profile.userId, profileId), async () => {
      const found = await this.findAnywhere(profileId, step, code)
      if (!found) throw new ConflictError('STEP_NOT_RECOMMENDED', 'This step has no recommended product')
      // The shelf first: if it refuses (a limit, an unknown product) no got-it version is left behind, and asking again does both.
      await this.shelf.add(found.product.id, clientIp)
    })
    // A build may have finished while the product was being added: the copy is of the routine in force now, and only if it still recommends this product.
    // Otherwise the product is on the shelf already, and the next rebuild swaps it in.
    const inForce = (await this.repository.current(profileId)) ?? ready
    const holdsIt = (version: RoutineVersionRow) => version.steps.some((entry) => entry.step === step && entry.product.kind === 'candidate' && entry.product.code === code)
    if (!holdsIt(inForce)) throw new ConflictError('STEP_NOT_RECOMMENDED', 'This step has no recommended product')
    // A tap that raced this one has marked it already: its version stands.
    if (inForce.steps.some((entry) => entry.step === step && entry.gotIt)) return
    const now = this.now()
    // Before Start every step is day 1 (null), so the zone is not read.
    const changedOn = inForce.startedOn === null ? null : RoutineService.stampedDay(inForce.startedOn, localDate(now, await this.reminders.zoneFor(profileId)))
    const steps = inForce.steps.map((entry) => (entry.step === step && entry.product.kind === 'candidate' && entry.product.code === code ? { ...entry, gotIt: true, changedOn } : entry))
    await this.repository.append({ ...structuredClone(inForce), id: this.newId(), status: 'ready', createdAt: now, readyAt: now, steps, reason: 'got-it', writerCalls: 0, hintsShown: false, servedAt: null })
    console.log({ outcome: 'routine-got-it', profileId, step })
    await this.tell(profileId)
  }

  /**
   * Asks for a build of the profile's routine, to be run by the queue. Does nothing when routines are switched off. Otherwise claims the request by its key and
   * queues it, unless a request is already being worked on (a different key too: a request made mid-build is dropped, and the triggers ask again afterwards). If
   * the queue refuses, the claim is given back. `options.exclude` rides in the queued message for `run` to hand to the build. Does nothing for a profile whose
   * user has not verified (a guest has no routine): no claim is made either. Never throws: a trigger must not fail for it. Logs ids and outcomes only. Answers
   * whether a build was queued; a trigger that can ask again later may ignore it, but a caller whose request would be lost if dropped (an exclusion) must not.
   */
  async request(profileId: string, reason: RoutineBuildReason, requestKey: string, options: RoutineBuildOptions = {}): Promise<boolean> {
    return this.ask(profileId, reason, requestKey, options)
  }

  /**
   * Asks for a build of the profile's routine when its inputs are not the ones the routine in force was built from (or there is no routine yet and the verdict is
   * ready), keyed by the fingerprint of those inputs. For the read that shows the routine to call: the person may have changed the shelf, the goal or the safety
   * answers since the build, and the triggers may not have caught up. Runs as the caller, who is the profile's own user. Asks for nothing while the build would only
   * wait (no saved ready verdict, goal, safety answers or shopping country), or for a guest, so a read that cannot be answered yet does not ask again each time.
   * Never throws.
   */
  async requestIfStale(profileId: string): Promise<void> {
    if (!this.enabled) return
    try {
      if (!(await this.isVerified(profileId))) return
      const saved = await this.verdicts.savedFor(profileId)
      if (!saved || saved.fit !== 'ready') return
      const [goal, safety] = await Promise.all([this.goals.goalFor(profileId), this.safety.snapshotFor(profileId)])
      if (goal === null || safety.view === null) return
      try {
        await this.recommendations.shoppingFor(profileId)
      } catch (error) {
        if (error instanceof ConflictError && NOT_YET.has(error.code)) return
        throw error
      }
      // The shelf as the build keeps it: an entry the build leaves out, or a reduced sunscreen the build keeps, must not make the two fingerprints differ.
      const shelf = (await this.shelfOf(profileId, saved)).shelf.map(sunscreenKept)
      const fingerprint = await RoutineService.fingerprintOf(goal, cautionsOf(safety.view.choices, shelf), shelf)
      if ((await this.repository.current(profileId))?.routineFingerprint === fingerprint) return
      await this.enqueue(profileId, 'verdict', fingerprint)
    } catch (error) {
      console.error({ outcome: 'routine-stale-check-failed', profileId, error: describeError(error) })
    }
  }

  /**
   * The daily sweeps, run by the cron with no session. Each looks at 200 rows at most, and a failure of one does not stop the others (the first is thrown at the end).
   * Does nothing while routines are off. Answers how many builds it queued.
   * - Nothing is queued for a profile whose user has not verified (a guest).
   * - A build request whose dead-letter retry is due is queued again, marked as the retry, and its due date cleared. It is not claimed, as the first try was: the
   *   claim is long released, and a second build that overlapped it would find nothing to change. A queue that refuses it keeps the due date for the next run.
   * - A rules-only routine in force whose writer retry is due is requested again, with `writer-retry`.
   * - A routine in force that recommends a product the catalog has retired since is requested again, with `catalog-retired`.
   */
  async sweep(now: Date): Promise<number> {
    if (!this.enabled) return 0
    let queued = 0
    let failed = false
    let failure: unknown
    for (const part of [() => this.retryDeadLetters(now), () => this.retryWriters(now), () => this.rebuildRetired()]) {
      try {
        queued += await part()
      } catch (error) {
        console.error({ outcome: 'routine-sweep-failed', error: describeError(error) })
        if (!failed) {
          failed = true
          failure = error
        }
      }
    }
    if (failed) throw failure
    return queued
  }

  /** `request`, saying whether a build was queued. */
  private async ask(profileId: string, reason: RoutineBuildReason, requestKey: string, options: RoutineBuildOptions = {}): Promise<boolean> {
    if (!this.enabled) return false
    try {
      if (!(await this.isVerified(profileId))) return false
      return await this.enqueue(profileId, reason, requestKey, options)
    } catch (error) {
      console.error({ outcome: 'routine-request-failed', profileId, reason, error: describeError(error) })
      return false
    }
  }

  /** Whether the profile exists and its user has verified: a guest is never given a routine. */
  private async isVerified(profileId: string): Promise<boolean> {
    return (await this.profiles.find(profileId))?.ownerStatus === 'verified'
  }

  /** Claims the request and queues the build, saying whether it did. Throws what the repository or the queue throws, the claim given back where it can be. */
  private async enqueue(profileId: string, reason: RoutineBuildReason, requestKey: string, options: RoutineBuildOptions = {}): Promise<boolean> {
    const now = this.now()
    if (!(await this.repository.claim(profileId, requestKey, now, new Date(now.getTime() - RoutineService.CLAIM_STALE_AFTER_MS)))) return false
    try {
      await this.jobs.enqueue(buildRoutineSpec, { profileId, reason, requestKey, requestedAt: now.getTime(), waits: 0, ...(options.exclude ? { exclude: options.exclude } : {}) })
    } catch (error) {
      // A claim with no job behind it would hold every ask off for 15 minutes. If the release fails too the claim goes stale on its own.
      await this.repository.release(profileId, now).catch(() => undefined)
      throw error
    }
    return true
  }

  private async retryDeadLetters(now: Date): Promise<number> {
    let queued = 0
    for (const row of await this.repository.dueRequests(now, RoutineService.SWEEP_LIMIT)) {
      const { profileId, requestKey } = row
      try {
        // A guest's request (one made before guests were refused) is not retried, and its due date is cleared so it stops filling the sweep's 200.
        if (!(await this.isVerified(profileId))) {
          await this.repository.setRequestRetry(profileId, { retried: true, retryDueAt: null })
          continue
        }
        await this.jobs.enqueue(buildRoutineSpec, { profileId, reason: RoutineService.reasonOf(requestKey), requestKey, requestedAt: now.getTime(), waits: 0, retry: true })
        queued++
        // Only once it is queued: a refused message leaves the retry due for the next run.
        await this.repository.setRequestRetry(profileId, { retried: true, retryDueAt: null })
      } catch (error) {
        console.error({ outcome: 'routine-retry-failed', profileId, error: describeError(error) })
      }
    }
    return queued
  }

  private async retryWriters(now: Date): Promise<number> {
    let queued = 0
    for (const { profileId, id } of await this.repository.writerRetriesDue(now, RoutineService.SWEEP_LIMIT)) {
      if (await this.ask(profileId, 'writer-retry', `writer-retry:${id}`)) queued++
    }
    return queued
  }

  private async rebuildRetired(): Promise<number> {
    let queued = 0
    for (const { profileId, id } of await this.repository.retiredCodeVersions(RoutineService.SWEEP_LIMIT)) {
      if (await this.ask(profileId, 'catalog-retired', `catalog-retired:${id}`)) queued++
    }
    return queued
  }

  /** What a request was for, from its key: the request row keeps no reason. The routine fingerprint (a freshness request) and anything unknown are `verdict`. */
  private static reasonOf(requestKey: string): RoutineBuildReason {
    if (requestKey === 'first') return 'first'
    for (const reason of ['review-point', 'writer-retry', 'catalog-retired'] as const) if (requestKey.startsWith(`${reason}:`)) return reason
    return 'verdict'
  }

  /**
   * The body of the build job, run by the queue as the system actor. Builds the routine. While the verdict is not ready for the first build or a review-point
   * rebuild it queues itself again a minute on, up to 15 times, keeping the claim, and then gives up. Any other outcome gives the claim back. An error is thrown
   * for the queue to retry, the claim kept.
   */
  async run(body: BuildRoutineMessage): Promise<void> {
    const { profileId, reason } = body
    const result = await this.build(profileId, reason, body.exclude ? { exclude: body.exclude } : {})
    if (result === 'waiting' && RoutineService.WAITING_REASONS.has(reason) && body.waits < RoutineService.MAX_WAITS) {
      await this.jobs.enqueue(buildRoutineSpec, { ...body, waits: body.waits + 1 }, { delaySeconds: RoutineService.WAIT_SECONDS })
      return
    }
    if (result === 'waiting') console.log({ outcome: 'routine-gave-up-waiting', profileId, reason, waits: body.waits })
    await this.repository.release(profileId, new Date(body.requestedAt))
  }

  /**
   * Where the dead-letter queue lands a build whose retries ran out. Gives the claim back, and the first time sets a retry due in 24 hours for the daily sweep to
   * queue; nothing is queued here. A second dead letter (the retry's own, or one on a request that was already retried) is final: nothing more is due, and it is
   * logged. A request that has moved on to another key has its own dead letter, so it is left alone.
   */
  async markBuildFailed(body: BuildRoutineMessage): Promise<void> {
    const { profileId } = body
    await this.repository.release(profileId, new Date(body.requestedAt))
    const row = await this.repository.findRequest(profileId)
    if (!row || row.requestKey !== body.requestKey) return
    const final = row.retried || body.retry === true
    await this.repository.setRequestRetry(profileId, { retried: true, retryDueAt: final ? null : new Date(this.now().getTime() + RoutineService.DAY_MS) })
    if (final) console.error({ outcome: 'routine-build-failed-final', profileId, reason: body.reason })
  }

  private static actorOf(userId: string, profileId: string): Actor {
    return { kind: 'user', userId, status: 'verified', profileId }
  }

  /** Whether the safety answers now state a caution that the routine in force was not built under. A caution from the shelf (tapering) comes from the verdict, not an answer. */
  private async hiddenBySafety(profileId: string, ready: RoutineVersionRow): Promise<boolean> {
    if (ready.cautions === null) return false
    const { view } = await this.safety.snapshotFor(profileId)
    const stated = cautionsOf(view?.choices ?? [], [])
    return stableJson(stated) !== stableJson(ready.cautions.filter((caution) => caution !== 'tapering'))
  }

  private async buildAs(profileId: string, reason: RoutineBuildReason, options: RoutineBuildOptions): Promise<RoutineBuildResult> {
    const saved = await this.verdicts.savedFor(profileId)
    if (!saved || saved.fit !== 'ready') return 'waiting'
    const facts = await this.factsOf(profileId, saved, options)
    if (!facts) return 'waiting'
    // The version's id is minted before anything is written from the skeleton, because whether the writer sees outcome hints is decided by it.
    const versionId = this.newId()
    // Hints are only counted as shown once the counts are read: a read that fails costs the hints, not the build.
    const hinted = hintsShown(versionId) ? await this.withHints(facts) : null
    const skeleton = hinted ?? facts.skeleton

    const current = await this.repository.current(profileId)
    const previous = current?.startedOn ? current : null
    const carry = previous ? await this.carryFor(facts, previous.steps, options) : null
    const merge = previous && carry ? stableMerge(RoutineService.previousOf(previous, skeleton.goal), skeleton, carry) : null
    const checking = merge?.checking ?? skeleton
    const at = this.now()
    const today = localDate(at, await this.reminders.zoneFor(profileId))
    // After Start, a step the merge did not keep is stamped with the day of this rebuild only if its product changed (or the step is new): the same product, a candidate the
    // person has since got included, keeps the day it had, whether the merge kept the step or the writer, or a whole-routine rebuild, wrote it again. Before Start every step is day 1, which is null.
    const changedOn = RoutineService.stampedDay(previous?.startedOn ?? null, today)
    const stamped = (built: SplicedRoutine, before: StoredRoutineStep[], onShelf: StableCarry['onShelf']): SplicedRoutine => ({
      ...built,
      steps: built.steps.map((e) => {
        if (e.fixedFrom !== null) return e
        const same = sameProductBefore(before, e, onShelf)
        // The day the same product had stands, null (day 1) included.
        return { ...e, changedOn: same ? same.changedOn : changedOn }
      }),
    })
    const assemble = (answer: Routine): SplicedRoutine =>
      merge && previous && carry ? stamped(spliceFixed(merge, answer), previous.steps, carry.onShelf) : { steps: answer.steps.map((e) => ({ ...e, gotIt: false, fixedFrom: null, changedOn: null })), tapers: RoutineService.stoppedOf(skeleton), expectation: answer.expectation }
    const catalogVersion = (await this.workbook.verdictReference()).catalogVersion
    const routine = await RoutineService.fingerprintOf(skeleton.goal, skeleton.person.cautions, skeleton.shelf)
    const shelfCounts = RoutineService.countsOf(skeleton.shelf)
    const notInRoutine = RoutineService.leftOutOf(skeleton.shelf, facts.noted)
    const base: Omit<RoutineVersionRow, 'id'> = {
      profileId,
      status: 'ready',
      createdAt: at,
      steps: [],
      tapers: [],
      expectation: null,
      cautions: skeleton.person.cautions,
      goal: skeleton.goal,
      shelfCounts,
      notInRoutine,
      readyAt: null,
      startedOn: current?.startedOn ?? null,
      servedAt: null,
      model: null,
      promptHash: null,
      catalogVersion,
      rulesVersion: ROUTINE_RULES_VERSION,
      hintsShown: false,
      verdictFingerprint: saved.fingerprint,
      routineFingerprint: routine,
      source: 'rules',
      reason,
      writerRetryDueAt: null,
      writerCalls: 0,
    }
    // A step-down that begins after Start (a new stop) begins the day of the rebuild, or day 1 when that is still ahead (Start was tapped, day 1 has not come).
    const ready = (built: SplicedRoutine, over: Partial<RoutineVersionRow> = {}): RoutineVersionRow => ({
      ...base,
      id: versionId,
      steps: built.steps,
      tapers: RoutineService.datedFrom(built.tapers, base.startedOn, today),
      expectation: built.expectation,
      ...over,
    })

    // Nothing is broken: the routine is kept as it is, and only a change to what it shows (or the cautions it was built under) is worth a version.
    if (merge && merge.writerSkeleton === null) {
      const kept = { steps: merge.fixed, tapers: RoutineService.datedFrom(merge.carriedTapers, base.startedOn, today), expectation: merge.expectation ?? expectationFor(skeleton.goal) }
      if (RoutineService.sameAs(current!, kept) && stableJson(current!.cautions) === stableJson(skeleton.person.cautions)) {
        // A retry that finds nothing to rewrite is done with: the version is not due another.
        if (reason === 'writer-retry' && current!.writerRetryDueAt !== null) await this.repository.clearWriterRetry(current!.id)
        // The inputs changed (or the stale read would ask again on every read) but the routine did not: it now stands for the inputs it was just checked against.
        // The counts and the list go first and the fingerprint last: if a later write fails the fingerprint still differs, so the next attempt writes them all again. A routine
        // built before the columns has no counts or list; with the fingerprint equal, the shelf as it stands is the shelf the routine was built from, so they are filled in too.
        const moved = current!.routineFingerprint !== routine
        if (moved || current!.shelfCounts === null) await this.repository.setShelfCounts(current!.id, shelfCounts)
        if (moved || current!.notInRoutine === null) await this.repository.setNotInRoutine(current!.id, notInRoutine)
        if (moved) await this.repository.setRoutineFingerprint(current!.id, routine)
        console.log({ outcome: 'routine-unchanged', profileId })
        return 'unchanged'
      }
      await this.appendReady(ready(kept, { writerRetryDueAt: reason === 'writer-retry' ? null : current!.writerRetryDueAt }))
      console.log({ outcome: 'routine-built', profileId, source: 'rules', writerCalls: 0 })
      return 'built'
    }

    // What the writer is asked is also what the rules write from: a broken step is never given a product the person's country does not sell.
    const asked = merge?.writerSkeleton ?? skeleton
    const since = new Date(at.getTime() - RoutineService.DAY_MS)
    if ((await this.repository.writerBuildsSince(profileId, since)) >= RoutineService.WRITER_BUILDS_PER_DAY) {
      await this.appendReady(ready(assemble(rulesOnlyRoutine(asked)), { writerRetryDueAt: new Date(at.getTime() + RoutineService.DAY_MS) }))
      console.log({ outcome: 'routine-built', profileId, source: 'rules', writerCalls: 0, limited: true })
      return 'built'
    }

    const pending: RoutineVersionRow = { ...base, id: versionId, status: 'pending', cautions: null, goal: null, shelfCounts: null, notInRoutine: null, routineFingerprint: null, catalogVersion: null, source: null }
    await this.repository.append(pending)
    await this.tell(profileId)
    // Start may have landed after the routine in force was read: the pending version is then started too (as Start does for a pending version it finds).
    const startedBefore = pending.startedOn === null ? (await this.repository.current(profileId))?.startedOn : null
    if (startedBefore) await this.repository.markStarted(profileId, startedBefore)

    const { written, calls } = await this.write(profileId, pending.id, asked, checking, assemble)
    const built = written ?? assemble(rulesOnlyRoutine(asked))
    const after = await this.afterWrite(profileId, pending, built.steps)
    const startedOn = pending.startedOn ?? after.startedOn
    const done: CompletedRoutineBuild = {
      steps: after.steps,
      tapers: RoutineService.datedFrom(built.tapers, startedOn, today),
      expectation: built.expectation,
      cautions: skeleton.person.cautions,
      goal: skeleton.goal,
      shelfCounts,
      notInRoutine,
      // The writer is named whenever it was called, even if the rules wrote the routine in the end.
      model: calls > 0 ? this.writerIdentity.model : null,
      promptHash: calls > 0 ? this.writerIdentity.promptHash : null,
      catalogVersion,
      routineFingerprint: routine,
      // Recorded only when a writer call received the hinted skeleton and the routine is what it wrote: a rules-built routine (daily limit, three failures) shows none.
      hintsShown: hinted !== null && written !== null,
      source: written ? 'writer' : 'rules',
      writerRetryDueAt: written ? null : new Date(at.getTime() + RoutineService.DAY_MS),
      writerCalls: calls,
      readyAt: this.now(),
    }
    if (!(await this.repository.complete(pending.id, done))) console.error({ outcome: 'routine-complete-skipped', profileId, versionId: pending.id })
    console.log({ outcome: 'routine-built', profileId, versionId: pending.id, source: done.source, writerCalls: calls })
    await this.tell(profileId)
    return 'built'
  }

  /** Appends a version that needs no pending phase, ready now. If Start landed after the routine in force was read, the version is started too. */
  private async appendReady(row: RoutineVersionRow): Promise<void> {
    const startedOn = row.startedOn ?? (await this.repository.current(row.profileId))?.startedOn ?? null
    const tapers = row.startedOn === null && startedOn !== null ? RoutineService.datedFrom(row.tapers, startedOn, startedOn) : row.tapers
    await this.repository.append({ ...row, readyAt: this.now(), startedOn, tapers })
    await this.tell(row.profileId)
  }

  /** Tells the live stream the routine changed. A failure is logged by id and never fails the build: the version is stored, and a client sees it on its next read. */
  private async tell(profileId: string): Promise<void> {
    try {
      await this.announce(profileId)
    } catch (error) {
      console.error({ outcome: 'routine-announce-failed', profileId, error: describeError(error) })
    }
  }

  /**
   * Asks the writer up to three times. Each answer is put together with the fixed steps and checked against the real skeleton; the next try is told the gates it
   * failed. A writer error is a failed try (told nothing, there being nothing to tell). Null when all fail.
   */
  private async write(
    profileId: string,
    versionId: string,
    asked: RoutineSkeleton,
    checking: RoutineSkeleton,
    assemble: (answer: Routine) => SplicedRoutine,
  ): Promise<{ written: SplicedRoutine | null; calls: number }> {
    let retry: RoutineRetry | undefined
    for (let calls = 1; calls <= RoutineService.WRITER_TRIES; calls++) {
      let answer: Routine
      try {
        answer = await this.writer.write(asked, retry)
      } catch (error) {
        console.error({ outcome: 'routine-writer-failed', profileId, versionId, attempt: calls, error: describeError(error) })
        retry = { failed: [] }
        continue
      }
      const built = assemble(answer)
      const failed: GateFailure[] = checkRoutine(checking, asRoutine(built.steps, built.tapers, built.expectation))
      if (failed.length === 0) return { written: built, calls }
      retry = { failed }
    }
    return { written: null, calls: RoutineService.WRITER_TRIES }
  }

  /**
   * What happened to the routine while the writer worked: the day it was started, if Start landed meanwhile (Start dates the pending version too), and the steps with
   * the "I got it" marks of any version made meanwhile, so a mark tapped during the build is not lost to it.
   */
  private async afterWrite(profileId: string, pending: RoutineVersionRow, steps: StoredRoutineStep[]): Promise<{ startedOn: Date | null; steps: StoredRoutineStep[] }> {
    const [latest, inForce] = await Promise.all([this.repository.latest(profileId), this.repository.current(profileId)])
    const got = new Set((inForce?.steps ?? []).flatMap((entry) => (entry.gotIt && entry.product.kind === 'candidate' ? [`${entry.step}:${entry.product.code}`] : [])))
    return {
      startedOn: pending.startedOn === null && latest?.id === pending.id ? latest.startedOn : null,
      steps: steps.map((entry) => (entry.product.kind === 'candidate' && got.has(`${entry.step}:${entry.product.code}`) ? { ...entry, gotIt: true } : entry)),
    }
  }

  /** Reads what the skeleton is built from, as the profile's user. Null while the goal, the safety answers or the shopping country are missing. */
  private async factsOf(profileId: string, saved: SavedVerdictView, options: RoutineBuildOptions): Promise<Facts | null> {
    const [goal, safety] = await Promise.all([this.goals.goalFor(profileId), this.safety.snapshotFor(profileId)])
    if (goal === null || safety.view === null) return null
    let shopping: Awaited<ReturnType<RoutineServiceDeps['recommendations']['shoppingFor']>>
    let offered: Record<RoutineStep, Candidate[]>
    try {
      shopping = await this.recommendations.shoppingFor(profileId)
      const lists = await Promise.all(ROUTINE_STEPS.map((step) => this.recommendations.candidatesFor({ step })))
      offered = Object.fromEntries(ROUTINE_STEPS.map((step, i) => [step, lists[i]!.filter((c) => !(options.exclude?.step === step && options.exclude.code === c.code))])) as Record<RoutineStep, Candidate[]>
    } catch (error) {
      if (error instanceof ConflictError && NOT_YET.has(error.code)) return null
      throw error
    }

    const { entries, shelf, noted } = await this.shelfOf(profileId, saved)
    const seen = await this.faceScans.seenFor(profileId)
    const skeleton = assembleSkeleton({
      goal,
      seen: seen.seen,
      alsoNoticed: seen.alsoNoticed,
      skinType: seen.skinType,
      budgetBand: shopping.budgetBand,
      safetyChoices: safety.view.choices,
      shelf,
      candidates: offered,
      hintsShown: false,
    })
    return { profileId, skeleton, offered, entries, noted, country: shopping.country }
  }

  /** The active shelf entries, and the ones the skeleton is built from: those the verdict decided on and whose product can be found. */
  private async shelfOf(profileId: string, saved: SavedVerdictView): Promise<{ entries: ShelfActiveEntry[]; shelf: SkeletonShelfProduct[]; noted: Facts['noted'] }> {
    const entries = await this.shelf.activeEntriesFor(profileId)
    const shelfFacts = await this.catalog.shelfFacts(entries.flatMap((entry) => (entry.kind === 'product' ? [entry.formulationId] : [])))
    const decided = new Map(saved.products.map((product) => [product.entryId, product]))
    const noted = new Map<string, { form: ProductForm | null; reason: string }>()
    // An entry the verdict has no decision for, or whose product cannot be found, is left out: there is nothing to build it from.
    const shelf = entries.flatMap((entry): SkeletonShelfProduct[] => {
      const verdict = decided.get(entry.id)
      if (!verdict) return []
      const named = entry.kind === 'no-label' ? { brand: null, name: NO_LABEL_NAME, ingredients: [] } : shelfFacts.get(entry.formulationId)
      if (!named) return []
      noted.set(entry.id, { form: 'form' in named ? named.form : null, reason: verdict.reason })
      return [{ id: entry.id, brand: named.brand, name: named.name, ingredients: [...named.ingredients], step: verdict.step, verdict: verdict.verdict, sourceUrls: [...verdict.sourceUrls] }]
    })
    return { entries, shelf, noted }
  }

  /** The one fingerprint of a routine's inputs, for the build to record and the stale read to compare: `shelf` is the skeleton's own (a reduced sunscreen already kept). */
  private static fingerprintOf(goal: Goal, cautions: CautionState[], shelf: readonly SkeletonShelfProduct[]): Promise<string> {
    return routineFingerprint({ goal, cautions, products: shelf.map((p) => ({ entryId: p.id, verdict: p.verdict, step: p.step })), rulesVersion: ROUTINE_RULES_VERSION })
  }

  /**
   * The skeleton with each gap candidate's outcome hint, from the counts of people with the same goal and skin type in the same country. Null when the counts cannot
   * be read: they are only hints, so the build goes on without them (logging the id only).
   */
  private async withHints({ profileId, skeleton, country }: Facts): Promise<RoutineSkeleton | null> {
    const codes = skeleton.gaps.flatMap((gap) => gap.candidates.map((candidate) => candidate.code))
    let counts: Awaited<ReturnType<RoutineServiceDeps['outcomeCounts']['counts']>>
    try {
      counts = await this.outcomeCounts.counts({ goal: skeleton.goal, skinType: skeleton.person.skinType, country }, codes)
    } catch {
      console.log({ outcome: 'hint-counts-failed', profileId })
      return null
    }
    return applyOutcomeHints(skeleton, counts, true, (code) => console.log({ outcome: 'hint-counts-corrupt', profileId, code }))
  }

  /**
   * What the stable merge cannot know: for each recommended product of the routine in force, where else it is still sold when the person's country (or budget) no
   * longer offers it, and which shelf entry it has become once the person has it. A product sold nowhere (retired, or unsafe for this person) is simply not carried,
   * and the excluded one never is.
   */
  private async carryFor(facts: Facts, steps: StoredRoutineStep[], options: RoutineBuildOptions): Promise<StableCarry> {
    const carry: StableCarry = { candidates: {}, onShelf: {} }
    const onShelf = new Set(facts.skeleton.shelf.map((p) => p.id))
    for (const { step, product } of steps) {
      if (product.kind !== 'candidate') continue
      const { code } = product
      if (options.exclude?.step === step && options.exclude.code === code) continue
      let found = facts.offered[step].find((c) => c.code === code)
      if (!found) {
        found = (await this.findAnywhere(facts.profileId, step, code, facts.country)) ?? undefined
        if (found) (carry.candidates[step] ??= []).push(candidateOf(found))
      }
      if (!found) continue
      const productId = found.product.id
      const held = facts.entries.find((entry) => entry.kind === 'product' && entry.productId === productId && onShelf.has(entry.id))
      if (held) carry.onShelf[code] = held.id
    }
    return carry
  }

  /** The candidate with this code at the step in the profile's country, or else in any active country (the budget band is not asked of another country, nor of this one). Null when none sells it. */
  private async findAnywhere(profileId: string, step: RoutineStep, code: string, preferred?: string): Promise<Candidate | null> {
    const shopping = preferred ?? (await this.recommendations.shoppingFor(profileId)).country
    const active = (await this.workbook.countries()).filter((country) => country.status === 'active').map((country) => country.code)
    for (const country of [shopping, ...active.filter((c) => c !== shopping)]) {
      const found = (await this.recommendations.candidatesFor({ step, country })).find((candidate) => candidate.code === code)
      if (found) return found
    }
    return null
  }

  /** The routine in force as the merge reads it. A row written before versions stored their goal is taken to have the current one. */
  private static previousOf(row: RoutineVersionRow, goal: Goal) {
    return { id: row.id, goal: row.goal ?? goal, expectation: row.expectation ?? '', steps: row.steps, tapers: row.tapers }
  }

  /** The step-downs with the undated ones dated `day` (the person's local date at the rebuild, as its UTC midnight), when the routine is started (`startedOn` set); before Start none has a date. None begins before day 1: Start makes tomorrow day 1, so a stop added in between waits for it. */
  private static datedFrom(tapers: StoredTaper[], startedOn: Date | null, day: Date): StoredTaper[] {
    if (startedOn === null) return tapers
    const begin = startedOn.getTime() > day.getTime() ? startedOn : day
    return tapers.map((taper) => ({ ...taper, startedOn: taper.startedOn ?? begin }))
  }

  /** How the shelf (as the skeleton holds it, a reduced sunscreen already kept) sorts: each product in exactly one count. */
  private static countsOf(shelf: readonly SkeletonShelfProduct[]): ShelfCounts {
    const counts: ShelfCounts = { keep: 0, reduce: 0, drop: 0, stop: 0 }
    for (const { verdict } of shelf) counts[verdict.kind]++
    return counts
  }

  /** The shelf products the build leaves out, in the shelf's order: a stopped one is stepping down, a dropped one is left out. Titles and reasons are fixed here, from the form and the verdict item's own words. */
  private static leftOutOf(shelf: readonly SkeletonShelfProduct[], noted: Facts['noted']): NotInRoutineItem[] {
    return shelf.flatMap((p): NotInRoutineItem[] => {
      if (p.verdict.kind !== 'stop' && p.verdict.kind !== 'drop') return []
      // Every product of the skeleton's shelf came through `shelfOf`, which noted it.
      const { form, reason } = noted.get(p.id)!
      return [{ entryId: p.id, title: titleFor({ step: p.step, form }), status: p.verdict.kind === 'stop' ? 'stepping-down' : 'left-out', reason }]
    })
  }

  /** The day a step changed, as it is stored: the person's local date, never before day 1 (Start makes tomorrow day 1); null before Start, when every step is day 1. */
  private static stampedDay(startedOn: Date | null, day: Date): Date | null {
    if (startedOn === null) return null
    return startedOn.getTime() > day.getTime() ? startedOn : day
  }

  private static stoppedOf(skeleton: RoutineSkeleton): StoredTaper[] {
    return skeleton.shelf.flatMap((p) => (p.verdict.kind === 'stop' ? [{ shelfProductId: p.id, templateId: p.verdict.taperTemplateId, startedOn: null }] : []))
  }

  /** Whether the routine in force shows the same steps and step-downs (to the day) as `next`; the bookkeeping of where a step came from is not shown. */
  private static sameAs(row: RoutineVersionRow, next: Pick<SplicedRoutine, 'steps' | 'tapers'>): boolean {
    const stepsOf = (steps: StoredRoutineStep[]) => steps.map(({ fixedFrom: _fixedFrom, ...step }) => step)
    const tapersOf = (tapers: StoredTaper[]) => tapers.map((t) => ({ ...t, startedOn: t.startedOn?.getTime() ?? null }))
    return stableJson(stepsOf(row.steps)) === stableJson(stepsOf(next.steps)) && stableJson(tapersOf(row.tapers)) === stableJson(tapersOf(next.tapers))
  }
}
