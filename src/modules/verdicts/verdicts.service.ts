import { PermanentJobError } from '../../jobs/job'
import { describeError } from '../../jobs/safe-error'
import { requireUser } from '../../lib/context'
import { ConflictError, UnavailableError } from '../../lib/errors'
import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import type { ScanEvent, ScanEvents } from '../../providers/scan-events/scan-events.provider'
import type { VerdictFitter } from '../../providers/verdict-fitting/verdict-fitter.provider'
import type { ProductCatalogService } from '../catalog/catalog.service'
import type { TaperRow } from '../catalog/catalog.workbook.schema'
import type { CatalogWorkbookService, VerdictReference } from '../catalog/catalog.workbook.service'
import type { FaceScanService } from '../face-scans/face-scans.service'
import type { GoalsService } from '../goals/goals.service'
import type { Goal } from '../goals/goals.vocabulary'
import type { RoutineTrigger } from '../routines/routines.trigger'
import type { SafetyService } from '../safety/safety.service'
import type { ScanService } from '../scans/scans.service'
import type { ShelfService } from '../shelf/shelf.service'
import { floorVerdicts } from './verdicts.floor'
import { verdictFingerprint } from './verdicts.fingerprint'
import { assembleVerdictInputs, fingerprintInputOf, fitRequestOf, provenanceOf, type VerdictFacts } from './verdicts.inputs'
import { buildVerdictSpec, type BuildVerdictMessage } from './verdicts.job-specs'
import { mergeVerdict, type MergedVerdict } from './verdicts.merge'
import type { FitState, ShelfVerdictRow, VerdictsRepository } from './verdicts.repository'
import type { SavedVerdictProduct, ShownVerdictProduct } from './verdicts.types'
import { previewOf, toShelfVerdictResponse, type VerdictView } from './verdicts.view'

export type VerdictServiceDeps = {
  repository: VerdictsRepository
  fitter: VerdictFitter
  jobs: JobQueue
  /** Tells whoever follows a profile's verdict that it was built: the full verdict on `verdict:<profileId>`, the guest's preview on `verdict-preview:<profileId>`. */
  events: ScanEvents
  workbook: Pick<CatalogWorkbookService, 'verdictReference' | 'tapersByCode' | 'stepsFor' | 'skinConcernsFor'>
  catalog: Pick<ProductCatalogService, 'shelfFacts' | 'latestIngredients'>
  shelf: Pick<ShelfService, 'activeEntriesFor' | 'viewsFor'>
  scans: Pick<ScanService, 'noLabelFacts' | 'hasShelfWorkInFlight'>
  safety: Pick<SafetyService, 'snapshotFor'>
  goals: Pick<GoalsService, 'goalFor'>
  faceScans: Pick<FaceScanService, 'latestConcernLevelsFor'>
  /** Asks for the profile's routine to follow a verdict just saved. A failure of it never changes what the build does. */
  onRoutineTrigger?: RoutineTrigger
  now?: () => Date
}

/** The saved verdict as the routine reads it. */
export type SavedVerdictView = { fingerprint: string; fit: 'ready' | 'not-ready'; builtAt: Date; rulesVersion: string | null; products: SavedVerdictProduct[] }

/** The two streams of a profile's verdict: the account's full verdict, and the guest's locked preview. A guest is never subscribed to the full one. */
type VerdictStream = 'full' | 'preview'

/** A ready row: the build columns a saved verdict always has are not null. */
type ReadyRow = ShelfVerdictRow & { status: 'ready'; fit: 'ready' | 'not-ready'; builtAt: Date }

const BOTH_STREAMS: readonly VerdictStream[] = ['full', 'preview']

const isReady = (row: ShelfVerdictRow | null): row is ReadyRow => row !== null && row.status === 'ready' && row.fit !== null && row.builtAt !== null

/**
 * A profile's shelf verdict (spec #171): the rules floor's labels merged with the fit judge's, saved once per profile and rebuilt only when what it was built
 * from changes. `current` serves the saved verdict while its fingerprint still matches the inputs and otherwise queues a build; `build` is that job.
 *
 * The fit judge can fail without the user waiting on it: the verdict is then saved at once with the open products undecided and the fit not ready, and the
 * judge is tried again. A failed attempt throws so the queue retries; the third gives up for the day, and one more try is made 24 hours on by the daily sweep
 * (`requeueDueFits`). A build that the queue gives up on (`markFitFailed`) gets that same one more try. Everything is read by profile id, so a job needs no session.
 */
export class VerdictService {
  private static readonly MINUTE_MS = 60 * 1000
  private static readonly DAY_MS = 24 * 60 * VerdictService.MINUTE_MS
  // A pending request this old had its build die (the queue gave up, or the message was lost): the next ask takes it over.
  private static readonly STALE_AFTER_MS = 30 * VerdictService.MINUTE_MS
  // A build waits a minute at a time for a scan of the shelf or the parse of safety words, and builds anyway after this many waits.
  private static readonly MAX_WAITS = 15
  private static readonly WAIT_SECONDS = 60
  // The fit judge is tried this many times in a day before the build gives up until tomorrow.
  private static readonly FIT_ATTEMPTS_PER_DAY = 3
  // The daily sweep queues at most this many due retries, the longest overdue first, so a backlog is worked off over days and never floods the queue.
  private static readonly SWEEP_LIMIT = 200

  private readonly repository: VerdictsRepository
  private readonly fitter: VerdictFitter
  private readonly jobs: JobQueue
  private readonly events: ScanEvents
  private readonly workbook: VerdictServiceDeps['workbook']
  private readonly catalog: VerdictServiceDeps['catalog']
  private readonly shelf: VerdictServiceDeps['shelf']
  private readonly scans: VerdictServiceDeps['scans']
  private readonly safety: VerdictServiceDeps['safety']
  private readonly goals: VerdictServiceDeps['goals']
  private readonly faceScans: VerdictServiceDeps['faceScans']
  private readonly onRoutineTrigger: RoutineTrigger | undefined
  private readonly now: () => Date

  constructor(deps: VerdictServiceDeps) {
    this.repository = deps.repository
    this.fitter = deps.fitter
    this.jobs = deps.jobs
    this.events = deps.events
    this.workbook = deps.workbook
    this.catalog = deps.catalog
    this.shelf = deps.shelf
    this.scans = deps.scans
    this.safety = deps.safety
    this.goals = deps.goals
    this.faceScans = deps.faceScans
    this.onRoutineTrigger = deps.onRoutineTrigger
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * The caller's verdict. 503 `VERDICT_UNAVAILABLE` while either step-down template is not approved (a stopped product could not be shown its taper), then 409
   * `GOAL_REQUIRED` for a profile with no goal. A saved verdict built from the inputs as they are now is served, whatever its fit. Otherwise the build is claimed
   * and queued (a request still fresh is not queued twice) and the answer is `pending`, the previous verdict included: it is not served as if it were current.
   * A guest (status `anonymous`) is answered the locked preview of the same saved row and a verified user the full verdict: one build, read two ways.
   */
  async current(): Promise<VerdictView> {
    const { profileId, status } = requireUser()
    const { reference, goal } = await this.gated(profileId)
    return this.viewOf(profileId, await this.servable(profileId, reference, goal), VerdictService.streamOf(status))
  }

  /**
   * The caller's verdict followed live, as the `text/event-stream` of `verdict:<profileId>`, or of `verdict-preview:<profileId>` for a guest, whose snapshot and
   * frames are only ever the locked preview. The gates, the claim and the queued build are `current`'s (nothing is
   * subscribed or queued when a gate throws). It starts with the verdict `current` would answer, then carries each `verdict` a build saves, and ends with `done`
   * once nothing more is coming soon: the fit is ready, or its day's attempts and its retry are spent (`fitRetried`). A verdict whose fit is not ready and still
   * has an attempt coming leaves the stream open to see that land. The snapshot is read before the stream opens, so the verdict is read again once it is open:
   * a build saved in between is sent, and a verdict that is finished gets `done` straight away. A failure to send is logged, and so is a failure of that
   * re-read (`watch-reread-failed`), which still hands back the stream.
   */
  async watch(): Promise<Response> {
    const { profileId, status } = requireUser()
    const mine = VerdictService.streamOf(status)
    const { reference, goal } = await this.gated(profileId)
    const row = await this.servable(profileId, reference, goal)
    const stream = await this.events.subscribe(VerdictService.streamKey(profileId, mine), toShelfVerdictResponse(await this.viewOf(profileId, row, mine)))
    let latest: ReadyRow | null
    try {
      latest = (await this.lookup(profileId, reference, goal)).row ?? row
    } catch {
      console.error({ outcome: 'watch-reread-failed', profileId })
      return stream
    }
    if (!latest) return stream
    // The full frame joins the shelf's products and can fail on its own; `done` is sent apart from it, so a failed join never leaves the stream open.
    if (latest.builtAt.getTime() !== row?.builtAt.getTime()) await this.publishVerdict(profileId, latest.fit, latest.products, [mine])
    if (VerdictService.isFinished(latest)) await this.publishDone(profileId, [mine])
    return stream
  }

  /**
   * The body of the build job, run by the queue as the system actor and safe to run again. A step-down template withdrawn since the ask, or a profile with no
   * goal, fails for good (before any waiting). While a scan of the shelf is under way or safety words are being parsed it queues itself again a minute on, up to
   * 15 times, and then builds with what it has. It builds from the inputs as they are when it runs, not as they were when asked, and saves the fingerprint of
   * those. A verdict already built from them with its fit ready is left alone, so a repeat costs no second call to the judge.
   *
   * When the judge fails, or its answer does not fit the shelf, the verdict is saved without its fit (see the class) and the attempt is counted: the first
   * two throw for the queue to retry, the third, and the one retry the day after, return. The stream is then sent the verdict, and `done` once it is finished
   * (see `watch`); if the inputs changed while the judge worked it is sent `pending` instead and the build for the new inputs is queued. Never logs a product's name, a reason or the words typed: ids and outcomes.
   */
  async build(body: BuildVerdictMessage): Promise<void> {
    const { profileId } = body
    const { reference, goal } = await this.buildGates(profileId)

    const safety = await this.safety.snapshotFor(profileId)
    if (body.waits < VerdictService.MAX_WAITS && (safety.parseState === 'pending' || (await this.scans.hasShelfWorkInFlight(profileId)))) {
      await this.jobs.enqueue(buildVerdictSpec, { ...body, waits: body.waits + 1 }, { delaySeconds: VerdictService.WAIT_SECONDS })
      return
    }

    const { facts, inputs, floor, fingerprint } = await this.assemble(profileId, reference, goal, safety)
    // A fit retry is for the shelf it was queued for: one for a shelf that has changed since is left to the build that the change queued.
    if (body.retry && body.fingerprint !== fingerprint) return
    for (const entryId of inputs.unresolved) console.error({ outcome: 'verdict-entry-unresolved', profileId, entryId })

    const row = await this.repository.find(profileId)
    if (isReady(row) && row.fingerprint === fingerprint && row.fit === 'ready') return
    // Both the day's attempts and the one retry are spent: only the sweep's retry message tries the judge again, not a repeat of an old message.
    if (!body.retry && isReady(row) && row.fingerprint === fingerprint && row.fit === 'not-ready' && row.fitRetried) return
    // Fit retries belong to one fingerprint: a build of a shelf that has changed since the row was claimed starts afresh.
    const prior = row?.fingerprint === fingerprint ? row : null

    // Only the judge's call and the merge of its answer count as a failed attempt; the floor-only merge below is ours and a failure there is not the judge's.
    const request = fitRequestOf(facts, floor)
    const choices = facts.safety.view?.choices ?? []
    let merged: MergedVerdict | undefined
    let failure: unknown
    let failed = false
    try {
      if (request !== null) merged = mergeVerdict({ floor, fit: await this.fitter.fit(request), entries: inputs.entries, choices, reference })
    } catch (error) {
      failed = true
      failure = error
      console.error({ outcome: 'fit-failed', profileId, error: describeError(error) })
    }
    merged ??= mergeVerdict({ floor, fit: null, entries: inputs.entries, choices, reference })

    const now = this.now()
    const products = merged.products.map((product) => ({ ...product, ...(inputs.perEntry.get(product.entryId) ?? { step: null, sourceUrls: [] }) }))
    const fitState = failed ? this.afterFailure(body, prior, now) : { fitAttempts: 0, fitRetried: false, fitRetryDueAt: null }
    await this.repository.save(profileId, {
      fingerprint,
      fit: merged.fit,
      products,
      builtAt: now,
      rulesVersion: reference.rulesVersion,
      catalogVersion: reference.catalogVersion,
      model: this.fitter.identity.model,
      promptHash: this.fitter.identity.promptHash,
      inputs: provenanceOf(facts, floor),
      ...fitState,
    })
    // The judge can take a while, and the shelf, the safety words or the goal can change under it: what was just saved is then already out of date, and saying it
    // is ready would be wrong. The stream is told it is pending, with no `done`, and the build for the inputs as they are now is queued as `current` queues it.
    const asNow = await this.buildGates(profileId)
    const fingerprintNow = (await this.assemble(profileId, asNow.reference, asNow.goal, await this.safety.snapshotFor(profileId))).fingerprint
    const outdated = fingerprintNow !== fingerprint
    if (outdated) await this.claimAndEnqueue(profileId, fingerprintNow)
    // The routine follows a verdict that is saved, current and ready: an outdated one is followed by the build just queued, and a not-ready one would only make the
    // routine wait. Before the stream is told anything and in a try of its own, so a failure of either never costs the other.
    if (!outdated && merged.fit === 'ready') {
      try {
        await this.onRoutineTrigger?.(profileId, 'verdict', fingerprint)
      } catch {
        console.error({ outcome: 'routine-trigger-failed', reason: 'verdict', profileId })
      }
    }
    // Sent before the failure below is thrown: the saved verdict is already the user's, and the retry's verdict follows it on the same stream. The full frame joins the
    // shelf's products and can fail on that; `done` does not depend on it, so it is sent whatever became of the frame.
    if (outdated) await this.publishPending(profileId)
    else await this.publishVerdict(profileId, merged.fit, products, BOTH_STREAMS)
    if (!outdated && VerdictService.isFinished({ fit: merged.fit, fitRetried: fitState.fitRetried })) await this.publishDone(profileId, BOTH_STREAMS)
    // Saved first, so the user has the verdict whether or not the queue tries again. Only the attempts before the day's last leave `fitRetried` false. An
    // outdated build is not retried: the build just queued for the inputs as they are now has its own attempts, and a retry of this one would bill twice.
    if (failed && !fitState.fitRetried && !outdated) throw failure
  }

  /**
   * The daily sweep, run by the cron with no session: queues, with no delay, the retry of every verdict whose fit retry has come due, the longest overdue
   * first and at most 200 a run. The row keeps its due time until the retry builds, so a lost message is queued again the next day. A queue that is down is logged
   * by id only. Answers how many were queued.
   */
  async requeueDueFits(now: Date): Promise<number> {
    let queued = 0
    for (const row of await this.repository.fitDue(now, VerdictService.SWEEP_LIMIT)) {
      try {
        await this.jobs.enqueue(buildVerdictSpec, { profileId: row.profileId, fingerprint: row.fingerprint, requestedAt: now.getTime(), waits: 0, retry: true })
        queued++
      } catch {
        console.error({ outcome: 'fit-retry-enqueue-failed', profileId: row.profileId })
      }
    }
    return queued
  }

  /**
   * Where the dead-letter queue lands a build whose retries ran out (an outage, not a failed fit). Like the safety parse it is given one more try the next day:
   * the row is marked retried and the retry due in 24 hours, for the daily sweep to queue; nothing is queued here. A second dead letter is final: nothing more is
   * due. A row that has moved on (another fingerprint), has none, or is built with its fit ready is left alone. Otherwise the stream is told it is over: the row's
   * verdict if it has one, and `done`.
   */
  async markFitFailed(body: BuildVerdictMessage): Promise<void> {
    const row = await this.repository.find(body.profileId)
    if (!row || row.fingerprint !== body.fingerprint || (isReady(row) && row.fit === 'ready')) return
    const final = row.fitRetried || body.retry === true
    await this.repository.setFitState(row.profileId, {
      fitAttempts: row.fitAttempts,
      fitRetried: true,
      fitRetryDueAt: final ? null : new Date(this.now().getTime() + VerdictService.DAY_MS),
    })
    // Nothing more is coming soon, so a stream still open is told what the row holds and that it is over. Never throws: the retry above is already scheduled. The verdict's frame joins the shelf's products and can fail on that, which must not skip `done`.
    if (isReady(row)) await this.publishVerdict(row.profileId, row.fit, row.products, BOTH_STREAMS)
    await this.publishDone(row.profileId, BOTH_STREAMS)
  }

  /**
   * What the routine reads: the profile's ready verdict while it was built from the inputs as they are now, and otherwise null, with the build claimed and queued
   * as `current` does. Null too, without writing, when a step-down template is not approved or the profile has no goal. Reads by profile id, with any session.
   */
  async savedFor(profileId: string): Promise<SavedVerdictView | null> {
    const reference = await this.workbook.verdictReference()
    if (VerdictService.lacksTapers(reference)) return null
    const goal = await this.goals.goalFor(profileId)
    if (goal === null) return null
    const row = await this.servable(profileId, reference, goal)
    return row && { fingerprint: row.fingerprint, fit: row.fit, builtAt: row.builtAt, rulesVersion: row.rulesVersion, products: row.products }
  }

  /** The gates of the caller's verdict, in order: 503 while a step-down template is not approved, then 409 for a profile with no goal. */
  private async gated(profileId: string): Promise<{ reference: VerdictReference; goal: Goal }> {
    const reference = await this.workbook.verdictReference()
    if (VerdictService.lacksTapers(reference)) throw new UnavailableError('VERDICT_UNAVAILABLE', 'The verdict is not available yet')
    const goal = await this.goals.goalFor(profileId)
    if (goal === null) throw new ConflictError('GOAL_REQUIRED', 'Pick a goal first')
    return { reference, goal }
  }

  /** The row as the stream's reader is shown it. The preview reads only what was saved, so a guest costs no shelf lookup. */
  private async viewOf(profileId: string, row: ReadyRow | null, stream: VerdictStream): Promise<VerdictView> {
    if (!row) return { status: 'pending' }
    return stream === 'preview' ? previewOf(row.fit, row.products) : this.fullViewOf(profileId, row.fit, row.products)
  }

  private async fullViewOf(profileId: string, fit: 'ready' | 'not-ready', saved: readonly SavedVerdictProduct[]): Promise<VerdictView> {
    const products = await this.shown(profileId, saved)
    return { status: 'ready', locked: false, fit, products, tapers: await this.tapersOf(products) }
  }

  /**
   * The saved products with their shelf entry's kind and product or noLabel, read now in one call and never saved (a rename is no new build). A product whose
   * entry no longer resolves (taken off the shelf since the build, which a rebuild then drops) is still shown, as saved and without them: its verdict, its
   * escalation and its step-down are the user's to see, and none of them depends on the entry. No throw and no new build.
   */
  private async shown(profileId: string, products: readonly SavedVerdictProduct[]): Promise<ShownVerdictProduct[]> {
    const views = await this.shelf.viewsFor(profileId, products.map(({ entryId }) => entryId))
    return products.map((product): ShownVerdictProduct => {
      const view = views.get(product.entryId)
      if (view?.kind === 'product' && view.product) return { ...product, kind: 'product', product: view.product }
      if (view?.kind === 'no-label' && view.noLabel) return { ...product, kind: 'no-label', noLabel: view.noLabel }
      return product
    })
  }

  /** The ready row built from the inputs as they are now, or null, and those inputs' fingerprint. Writes nothing. */
  private async lookup(profileId: string, reference: VerdictReference, goal: Goal): Promise<{ fingerprint: string; row: ReadyRow | null }> {
    const { fingerprint } = await this.assemble(profileId, reference, goal, await this.safety.snapshotFor(profileId))
    const row = await this.repository.find(profileId)
    return { fingerprint, row: isReady(row) && row.fingerprint === fingerprint ? row : null }
  }

  /**
   * The verdict as each stream carries it: the public body GET answers for that stream's reader. Never throws, so a caller's next send (`done`) never depends on it;
   * a failure is logged. When the full verdict's frame cannot be built (its join of the shelf's products failed) nothing of this verdict is sent, so the two streams
   * never tell different stories; each stream's frame is otherwise sent in a try of its own.
   */
  private async publishVerdict(profileId: string, fit: 'ready' | 'not-ready', products: SavedVerdictProduct[], streams: readonly VerdictStream[]): Promise<void> {
    let full: VerdictView | undefined
    if (streams.includes('full')) {
      try {
        full = await this.fullViewOf(profileId, fit, products)
      } catch {
        console.error({ outcome: 'publish-failed', profileId })
        return
      }
    }
    for (const stream of streams) {
      await this.publishTo(profileId, stream, { type: 'verdict', verdict: toShelfVerdictResponse(stream === 'full' ? full! : previewOf(fit, products)) })
    }
  }

  /** The inputs changed under a build: every stream is told the verdict it was following is pending again. */
  private async publishPending(profileId: string): Promise<void> {
    for (const stream of BOTH_STREAMS) await this.publishTo(profileId, stream, { type: 'verdict', verdict: toShelfVerdictResponse({ status: 'pending' }) })
  }

  private async publishDone(profileId: string, streams: readonly VerdictStream[]): Promise<void> {
    for (const stream of streams) await this.publishTo(profileId, stream, { type: 'done' })
  }

  /** Sends one frame to one stream. A failure to send is logged by profile id and never thrown: the saved verdict is the truth. */
  private async publishTo(profileId: string, stream: VerdictStream, frame: ScanEvent): Promise<void> {
    try {
      await this.events.publish(VerdictService.streamKey(profileId, stream), frame)
    } catch {
      console.error({ outcome: 'publish-failed', profileId })
    }
  }

  /** The stream a caller reads: only a verified account is given the full verdict. */
  private static streamOf(status: 'anonymous' | 'verified'): VerdictStream {
    return status === 'verified' ? 'full' : 'preview'
  }

  private static streamKey(profileId: string, stream: VerdictStream): string {
    return `${stream === 'full' ? 'verdict' : 'verdict-preview'}:${profileId}`
  }

  /** The ready row built from the inputs as they are now. Otherwise null, after claiming and queuing the build (a request still fresh is not queued twice). */
  private async servable(profileId: string, reference: VerdictReference, goal: Goal): Promise<ReadyRow | null> {
    const { fingerprint, row } = await this.lookup(profileId, reference, goal)
    if (row) return row
    await this.claimAndEnqueue(profileId, fingerprint)
    return null
  }

  /** Claims the build of `fingerprint` and queues it, unless a request for it is still fresh. If the queue refuses, the claim is released and its error thrown. */
  private async claimAndEnqueue(profileId: string, fingerprint: string): Promise<void> {
    const now = this.now()
    if (!(await this.repository.requestBuild(profileId, fingerprint, now, new Date(now.getTime() - VerdictService.STALE_AFTER_MS)))) return
    try {
      await this.jobs.enqueue(buildVerdictSpec, { profileId, fingerprint, requestedAt: now.getTime(), waits: 0 })
    } catch (error) {
      // A claim with no job behind it would hold every ask off for 30 minutes. If the release fails too the claim goes stale on its own, and the queue's error is the one worth seeing.
      await this.repository.releaseClaim(profileId, now).catch(() => undefined)
      throw error
    }
  }

  /** What the build job needs to run at all; a template withdrawn since the ask, or a profile with no goal, fails it for good. */
  private async buildGates(profileId: string): Promise<{ reference: VerdictReference; goal: Goal }> {
    const reference = await this.workbook.verdictReference()
    if (VerdictService.lacksTapers(reference)) throw new PermanentJobError('A step-down template is no longer approved')
    const goal = await this.goals.goalFor(profileId)
    if (goal === null) throw new PermanentJobError('The profile has no goal')
    return { reference, goal }
  }

  /** The stream ends after a verdict whose fit is ready, or one whose fit is not but has had its retry: nothing more is coming soon (the next try is a day away or none). */
  private static isFinished(row: { fit: 'ready' | 'not-ready'; fitRetried: boolean }): boolean {
    return row.fit === 'ready' || row.fitRetried
  }

  /** Both step-down kinds must have an approved template, whatever this shelf needs: the shelf can change under a saved verdict, and a stop with no taper is never shown. */
  static lacksTapers(reference: VerdictReference): boolean {
    return !reference.tapers.steroid || !reference.tapers['lightening-agent']
  }

  /** The fit state after a failed attempt (see `build`): the third attempt of the day, and the one retry the day after, stop trying until tomorrow, or for good. */
  private afterFailure(body: BuildVerdictMessage, prior: ShelfVerdictRow | null, now: Date): FitState {
    const fitAttempts = (prior?.fitAttempts ?? 0) + 1
    if (body.retry || prior?.fitRetried) return { fitAttempts, fitRetried: true, fitRetryDueAt: null }
    if (fitAttempts < VerdictService.FIT_ATTEMPTS_PER_DAY) return { fitAttempts, fitRetried: false, fitRetryDueAt: null }
    return { fitAttempts, fitRetried: true, fitRetryDueAt: new Date(now.getTime() + VerdictService.DAY_MS) }
  }

  /** The step-down templates the stopped products use, each once and as the workbook holds them now (a retired one still shows the template it was built with). */
  private async tapersOf(products: readonly SavedVerdictProduct[]): Promise<TaperRow[]> {
    const codes = [...new Set(products.flatMap(({ verdict }) => (verdict.kind === 'stop' ? [verdict.taperTemplateId] : [])))].sort()
    return codes.length === 0 ? [] : [...(await this.workbook.tapersByCode(codes)).values()]
  }

  /** Loads what a verdict is built from for the profile and runs it through the pure pieces: the inputs, the floor and the fingerprint. */
  private async assemble(profileId: string, reference: VerdictReference, goal: Goal, safety: VerdictFacts['safety']) {
    const entries = await this.shelf.activeEntriesFor(profileId)
    const shelfFacts = await this.catalog.shelfFacts(entries.flatMap((entry) => (entry.kind === 'product' ? [entry.formulationId] : [])))
    const noLabelFacts = await this.scans.noLabelFacts(entries.flatMap((entry) => (entry.kind === 'no-label' ? [entry.itemId] : [])))
    const productIds = [...new Set([...shelfFacts.values()].map((product) => product.productId))]
    const [steps, skinConcerns] = await Promise.all([this.workbook.stepsFor(productIds), this.workbook.skinConcernsFor(productIds)])
    const mentionIngredients = new Map<string, string[]>()
    for (const productId of new Set(safety.mentions.flatMap(({ productId }) => (productId === null ? [] : [productId])))) {
      const ingredients = await this.catalog.latestIngredients(productId)
      if (ingredients !== null) mentionIngredients.set(productId, ingredients)
    }
    const facts: VerdictFacts = {
      reference,
      goal,
      entries,
      shelfFacts,
      noLabelFacts,
      steps,
      skinConcerns,
      safety,
      mentionIngredients,
      scan: await this.faceScans.latestConcernLevelsFor(profileId),
      fitter: this.fitter.identity,
    }
    const inputs = assembleVerdictInputs(facts)
    const floor = floorVerdicts(inputs.floorInput)
    return { facts, inputs, floor, fingerprint: await verdictFingerprint(fingerprintInputOf(facts, floor)) }
  }
}
