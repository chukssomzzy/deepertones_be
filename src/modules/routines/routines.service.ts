import { describeError } from '../../jobs/safe-error'
import type { Actor } from '../../lib/context'
import { runAs } from '../../lib/context'
import { ConflictError, NotFoundError } from '../../lib/errors'
import { stableJson } from '../../lib/stable-json'
import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import type { RoutineRetry, RoutineWriter } from '../../providers/routine-writing/routine-writer.provider'
import type { ProductCatalogService } from '../catalog/catalog.service'
import { ROUTINE_STEPS, type RoutineStep } from '../catalog/catalog.vocabulary'
import type { CatalogWorkbookService } from '../catalog/catalog.workbook.service'
import type { FaceScanService } from '../face-scans/face-scans.service'
import type { GoalsService } from '../goals/goals.service'
import type { Goal } from '../goals/goals.vocabulary'
import type { ProfilesService } from '../profiles/profiles.service'
import type { RecommendationService } from '../recommendations/recommendations.service'
import type { Candidate } from '../recommendations/recommendations.types'
import type { SafetyService } from '../safety/safety.service'
import type { ShelfActiveEntry, ShelfService } from '../shelf/shelf.service'
import { NO_LABEL_NAME } from '../verdicts/verdicts.inputs'
import type { SavedVerdictView, VerdictService } from '../verdicts/verdicts.service'
import { expectationFor } from './routines.copy'
import { checkRoutine } from './routines.gates'
import { routineFingerprint } from './routines.fingerprint'
import { buildRoutineSpec, type BuildRoutineMessage } from './routines.job-specs'
import type { CompletedRoutineBuild, RoutineVersionRow, RoutinesRepository } from './routines.repository'
import { rulesOnlyRoutine } from './routines.rules-only'
import { ROUTINE_RULES_VERSION } from './routines.rules'
import { assembleSkeleton, candidateOf, cautionsOf } from './routines.skeleton'
import { asRoutine, spliceFixed, stableMerge, type SplicedRoutine, type StableCarry } from './routines.stable'
import type { GateFailure, Routine, RoutineSkeleton, SkeletonShelfProduct, StoredRoutineStep, StoredTaper } from './routines.types'

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
  writer: RoutineWriter
  /** The model and prompt hash the writer runs under, recorded on every routine it writes. */
  writerIdentity: { model: string; promptHash: string }
  repository: RoutinesRepository
  jobs: JobQueue
  /** Whether routines are switched on in this environment: off, `request` does nothing at all. */
  enabled: boolean
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
  private readonly writer: RoutineWriter
  private readonly writerIdentity: RoutineServiceDeps['writerIdentity']
  private readonly repository: RoutinesRepository
  private readonly jobs: JobQueue
  private readonly enabled: boolean
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
    this.writer = deps.writer
    this.writerIdentity = deps.writerIdentity
    this.repository = deps.repository
    this.jobs = deps.jobs
    this.enabled = deps.enabled
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Builds the profile's next routine version: `waiting` (nothing appended) while the verdict is not saved and ready for the inputs as they are, or the goal, the
   * safety answers or the shopping country are missing. After Start, `unchanged` (nothing appended) when no step, step-down or caution changed; otherwise `built`.
   * A failure of the repository or of reading the other modules throws, leaving a pending version if one was appended, which goes stale on its own.
   */
  async build(profileId: string, reason: RoutineBuildReason, options: RoutineBuildOptions = {}): Promise<RoutineBuildResult> {
    const profile = await this.profiles.find(profileId)
    if (!profile) return 'waiting'
    return runAs(RoutineService.actorOf(profile.userId, profileId), () => this.buildAs(profileId, reason, options))
  }

  /**
   * The routine to show: the one in force (`ready`), `updating` while a newer build is under way, and `pending` when there is nothing to show yet or the one in force
   * no longer fits the person's safety answers (then it is hidden until the build under way replaces it). A build that died long ago is not under way.
   */
  async current(profileId: string): Promise<RoutineView> {
    const [ready, latest] = await Promise.all([this.repository.current(profileId), this.repository.latest(profileId)])
    if (!ready) return { status: 'pending' }
    if (latest?.status !== 'pending' || this.now().getTime() - latest.createdAt.getTime() >= RoutineService.STALE_AFTER_MS) return { status: 'ready', version: ready }
    return (await this.hiddenBySafety(profileId, ready)) ? { status: 'pending' } : { status: 'updating', version: ready }
  }

  /** Makes today day 1 of the routine in force, and of its step-downs. 409 `ROUTINE_NOT_READY` before there is one. Starting again changes nothing. */
  async start(profileId: string): Promise<void> {
    if (!(await this.repository.current(profileId))) throw new ConflictError('ROUTINE_NOT_READY', 'Your routine is not ready yet')
    const now = this.now()
    await this.repository.markStarted(profileId, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())))
  }

  /**
   * "I got it" for a recommended product: puts it on the shelf (by its catalog product, as the shelf's own add does) and appends a copy of the routine in force with
   * that step marked got, with no writer call. 409 `ROUTINE_NOT_READY` before there is a routine and 409 `STEP_NOT_RECOMMENDED` when the step does not hold a
   * recommended product, or its product is sold nowhere now. The swap to the shelf entry happens at the next rebuild, once the shelf holds the product.
   */
  async gotIt(profileId: string, step: RoutineStep, clientIp: string): Promise<void> {
    const profile = await this.profiles.find(profileId)
    if (!profile) throw new NotFoundError('PROFILE_NOT_FOUND', 'No such profile')
    const ready = await this.repository.current(profileId)
    if (!ready) throw new ConflictError('ROUTINE_NOT_READY', 'Your routine is not ready yet')
    const chosen = ready.steps.find((entry) => entry.step === step && entry.product.kind === 'candidate')
    if (chosen?.product.kind !== 'candidate') throw new ConflictError('STEP_NOT_RECOMMENDED', 'This step has no recommended product')
    const code = chosen.product.code
    await runAs(RoutineService.actorOf(profile.userId, profileId), async () => {
      const found = await this.findAnywhere(profileId, step, code)
      if (!found) throw new ConflictError('STEP_NOT_RECOMMENDED', 'This step has no recommended product')
      // The shelf first: if it refuses (a limit, an unknown product) no got-it version is left behind, and asking again does both.
      await this.shelf.add(found.product.id, clientIp)
    })
    const steps = ready.steps.map((entry) => (entry.step === step && entry.product.kind === 'candidate' ? { ...entry, gotIt: true } : entry))
    await this.repository.append({ ...structuredClone(ready), id: this.newId(), status: 'ready', createdAt: this.now(), steps, reason: 'got-it', writerCalls: 0, servedAt: null })
    console.log({ outcome: 'routine-got-it', profileId, step })
  }

  /**
   * Asks for a build of the profile's routine, to be run by the queue. Does nothing when routines are switched off. Otherwise claims the request by its key and
   * queues it, unless a request is already being worked on (a different key too: a request made mid-build is dropped, and the triggers ask again afterwards). If
   * the queue refuses, the claim is given back. Never throws: a trigger must not fail for it. Logs ids and outcomes only.
   */
  async request(profileId: string, reason: RoutineBuildReason, requestKey: string): Promise<void> {
    if (!this.enabled) return
    try {
      const now = this.now()
      if (!(await this.repository.claim(profileId, requestKey, now, new Date(now.getTime() - RoutineService.CLAIM_STALE_AFTER_MS)))) return
      try {
        await this.jobs.enqueue(buildRoutineSpec, { profileId, reason, requestKey, requestedAt: now.getTime(), waits: 0 })
      } catch (error) {
        // A claim with no job behind it would hold every ask off for 15 minutes. If the release fails too the claim goes stale on its own.
        await this.repository.release(profileId, now).catch(() => undefined)
        throw error
      }
    } catch (error) {
      console.error({ outcome: 'routine-request-failed', profileId, reason, error: describeError(error) })
    }
  }

  /**
   * The body of the build job, run by the queue as the system actor. Builds the routine. While the verdict is not ready for the first build or a review-point
   * rebuild it queues itself again a minute on, up to 15 times, keeping the claim, and then gives up. Any other outcome gives the claim back. An error is thrown
   * for the queue to retry, the claim kept.
   */
  async run(body: BuildRoutineMessage): Promise<void> {
    const { profileId, reason } = body
    const result = await this.build(profileId, reason)
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
    const { skeleton } = facts

    const current = await this.repository.current(profileId)
    const previous = current?.startedOn ? current : null
    const merge = previous ? stableMerge(RoutineService.previousOf(previous, skeleton.goal), skeleton, await this.carryFor(facts, previous.steps, options)) : null
    const checking = merge?.checking ?? skeleton
    const assemble = (answer: Routine): SplicedRoutine => (merge ? spliceFixed(merge, answer) : { steps: answer.steps.map((e) => ({ ...e, gotIt: false, fixedFrom: null })), tapers: RoutineService.stoppedOf(skeleton), expectation: answer.expectation })

    const at = this.now()
    const catalogVersion = (await this.workbook.verdictReference()).catalogVersion
    const routine = await routineFingerprint({
      goal: skeleton.goal,
      cautions: skeleton.person.cautions,
      products: skeleton.shelf.map((p) => ({ entryId: p.id, verdict: p.verdict, step: p.step })),
      rulesVersion: ROUTINE_RULES_VERSION,
    })
    const base: Omit<RoutineVersionRow, 'id'> = {
      profileId,
      status: 'ready',
      createdAt: at,
      steps: [],
      tapers: [],
      expectation: null,
      cautions: skeleton.person.cautions,
      goal: skeleton.goal,
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
    const ready = (built: SplicedRoutine, over: Partial<RoutineVersionRow> = {}): RoutineVersionRow => ({ ...base, id: this.newId(), steps: built.steps, tapers: built.tapers, expectation: built.expectation, ...over })

    // Nothing is broken: the routine is kept as it is, and only a change to what it shows (or the cautions it was built under) is worth a version.
    if (merge && merge.writerSkeleton === null) {
      const kept = { steps: merge.fixed, tapers: merge.carriedTapers, expectation: merge.expectation ?? expectationFor(skeleton.goal) }
      if (RoutineService.sameAs(current!, kept) && stableJson(current!.cautions) === stableJson(skeleton.person.cautions)) {
        console.log({ outcome: 'routine-unchanged', profileId })
        return 'unchanged'
      }
      await this.repository.append(ready(kept, { writerRetryDueAt: current!.writerRetryDueAt }))
      console.log({ outcome: 'routine-built', profileId, source: 'rules', writerCalls: 0 })
      return 'built'
    }

    const since = new Date(at.getTime() - RoutineService.DAY_MS)
    if ((await this.repository.writerBuildsSince(profileId, since)) >= RoutineService.WRITER_BUILDS_PER_DAY) {
      await this.repository.append(ready(assemble(rulesOnlyRoutine(checking)), { writerRetryDueAt: new Date(at.getTime() + RoutineService.DAY_MS) }))
      console.log({ outcome: 'routine-built', profileId, source: 'rules', writerCalls: 0, limited: true })
      return 'built'
    }

    const pending: RoutineVersionRow = { ...base, id: this.newId(), status: 'pending', cautions: null, goal: null, routineFingerprint: null, catalogVersion: null, source: null }
    await this.repository.append(pending)

    const { written, calls } = await this.write(profileId, pending.id, merge?.writerSkeleton ?? skeleton, checking, assemble)
    const built = written ?? assemble(rulesOnlyRoutine(checking))
    const startedOn = await this.startedMeanwhile(profileId, pending)
    const done: CompletedRoutineBuild = {
      steps: built.steps,
      tapers: startedOn ? built.tapers.map((taper) => ({ ...taper, startedOn: taper.startedOn ?? startedOn })) : built.tapers,
      expectation: built.expectation,
      cautions: skeleton.person.cautions,
      goal: skeleton.goal,
      model: written ? this.writerIdentity.model : null,
      promptHash: written ? this.writerIdentity.promptHash : null,
      catalogVersion,
      routineFingerprint: routine,
      hintsShown: false,
      source: written ? 'writer' : 'rules',
      writerRetryDueAt: written ? null : new Date(at.getTime() + RoutineService.DAY_MS),
      writerCalls: calls,
    }
    if (!(await this.repository.complete(pending.id, done))) console.error({ outcome: 'routine-complete-skipped', profileId, versionId: pending.id })
    console.log({ outcome: 'routine-built', profileId, versionId: pending.id, source: done.source, writerCalls: calls })
    return 'built'
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

  /** The day the routine was started while this build was under way (Start dates the pending version too), or null. */
  private async startedMeanwhile(profileId: string, pending: RoutineVersionRow): Promise<Date | null> {
    if (pending.startedOn !== null) return null
    const latest = await this.repository.latest(profileId)
    return latest?.id === pending.id ? latest.startedOn : null
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

    const entries = await this.shelf.activeEntriesFor(profileId)
    const shelfFacts = await this.catalog.shelfFacts(entries.flatMap((entry) => (entry.kind === 'product' ? [entry.formulationId] : [])))
    const decided = new Map(saved.products.map((product) => [product.entryId, product]))
    // An entry the verdict has no decision for, or whose product cannot be found, is left out: there is nothing to build it from.
    const shelf = entries.flatMap((entry): SkeletonShelfProduct[] => {
      const verdict = decided.get(entry.id)
      if (!verdict) return []
      const named = entry.kind === 'no-label' ? { brand: null, name: NO_LABEL_NAME, ingredients: [] } : shelfFacts.get(entry.formulationId)
      if (!named) return []
      return [{ id: entry.id, brand: named.brand, name: named.name, ingredients: [...named.ingredients], step: verdict.step, verdict: verdict.verdict, sourceUrls: [...verdict.sourceUrls] }]
    })

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
    return { profileId, skeleton, offered, entries, country: shopping.country }
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
