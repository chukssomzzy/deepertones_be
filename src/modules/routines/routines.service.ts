import { describeError } from '../../jobs/safe-error'
import type { Actor } from '../../lib/context'
import { runAs } from '../../lib/context'
import { ConflictError, NotFoundError } from '../../lib/errors'
import { stableJson } from '../../lib/stable-json'
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
    if (!profile) {
      console.log({ outcome: 'routine-profile-missing', profileId })
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
    // A build may have finished while the product was being added: the copy is of the routine in force now, and only if it still recommends this product.
    // Otherwise the product is on the shelf already, and the next rebuild swaps it in.
    const inForce = (await this.repository.current(profileId)) ?? ready
    const holdsIt = (version: RoutineVersionRow) => version.steps.some((entry) => entry.step === step && entry.product.kind === 'candidate' && entry.product.code === code)
    if (!holdsIt(inForce)) throw new ConflictError('STEP_NOT_RECOMMENDED', 'This step has no recommended product')
    const steps = inForce.steps.map((entry) => (entry.step === step && entry.product.kind === 'candidate' && entry.product.code === code ? { ...entry, gotIt: true } : entry))
    const now = this.now()
    await this.repository.append({ ...structuredClone(inForce), id: this.newId(), status: 'ready', createdAt: now, readyAt: now, steps, reason: 'got-it', writerCalls: 0, servedAt: null })
    console.log({ outcome: 'routine-got-it', profileId, step })
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
    const today = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
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
    // A step-down that begins after Start (a new stop) begins the day of the rebuild.
    const ready = (built: SplicedRoutine, over: Partial<RoutineVersionRow> = {}): RoutineVersionRow => ({
      ...base,
      id: this.newId(),
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

    const pending: RoutineVersionRow = { ...base, id: this.newId(), status: 'pending', cautions: null, goal: null, routineFingerprint: null, catalogVersion: null, source: null }
    await this.repository.append(pending)
    // Start may have landed after the routine in force was read: the pending version is then started too (as Start does for a pending version it finds).
    const startedBefore = pending.startedOn === null ? (await this.repository.current(profileId))?.startedOn : null
    if (startedBefore) await this.repository.markStarted(profileId, startedBefore)

    const { written, calls } = await this.write(profileId, pending.id, asked, checking, assemble)
    const built = written ?? assemble(rulesOnlyRoutine(asked))
    const after = await this.afterWrite(profileId, pending, built.steps)
    const day = pending.startedOn ? today : after.startedOn
    const done: CompletedRoutineBuild = {
      steps: after.steps,
      tapers: RoutineService.datedFrom(built.tapers, day, day ?? today),
      expectation: built.expectation,
      cautions: skeleton.person.cautions,
      goal: skeleton.goal,
      // The writer is named whenever it was called, even if the rules wrote the routine in the end.
      model: calls > 0 ? this.writerIdentity.model : null,
      promptHash: calls > 0 ? this.writerIdentity.promptHash : null,
      catalogVersion,
      routineFingerprint: routine,
      hintsShown: false,
      source: written ? 'writer' : 'rules',
      writerRetryDueAt: written ? null : new Date(at.getTime() + RoutineService.DAY_MS),
      writerCalls: calls,
      readyAt: this.now(),
    }
    if (!(await this.repository.complete(pending.id, done))) console.error({ outcome: 'routine-complete-skipped', profileId, versionId: pending.id })
    console.log({ outcome: 'routine-built', profileId, versionId: pending.id, source: done.source, writerCalls: calls })
    return 'built'
  }

  /** Appends a version that needs no pending phase, ready now. If Start landed after the routine in force was read, the version is started too. */
  private async appendReady(row: RoutineVersionRow): Promise<void> {
    const startedOn = row.startedOn ?? (await this.repository.current(row.profileId))?.startedOn ?? null
    const tapers = row.startedOn === null && startedOn !== null ? RoutineService.datedFrom(row.tapers, startedOn, startedOn) : row.tapers
    await this.repository.append({ ...row, readyAt: this.now(), startedOn, tapers })
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

  /** The step-downs with the undated ones dated `day`, when the routine is started (`startedOn` set); before Start none has a date. */
  private static datedFrom(tapers: StoredTaper[], startedOn: Date | null, day: Date): StoredTaper[] {
    return startedOn === null ? tapers : tapers.map((taper) => ({ ...taper, startedOn: taper.startedOn ?? day }))
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
