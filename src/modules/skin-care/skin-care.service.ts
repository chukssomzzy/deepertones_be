import { requireUser } from '../../lib/context'
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationError } from '../../lib/errors'
import { localDay } from '../../lib/local-day'
import type { RoutineStep } from '../catalog/catalog.vocabulary'
import type { CatalogWorkbookService, Escalation, Response } from '../catalog/catalog.workbook.service'
import type { InboxService } from '../inbox/inbox.service'
import type { RemindersService } from '../reminders/reminders.service'
import { type SkinLogReading, type SkinOutcome, SKIN_OUTCOME_RULES_VERSION, outcomeFor } from './skin-care.outcomes'
import type { StepPausesRepository } from './skin-care.pauses.repository'
import type { SkinCareRepository } from './skin-care.repository'
import { pauseKeyOf, stepToPause } from './skin-care.step-choice'
import type { SkinCareRoutine, SkinCareRoutineStep, SkinCareState, SkinLog, StepPause } from './skin-care.types'
import { fillResponse, STEP_NOUN } from './skin-care.text'
import { HOW_BAD, NOTICING, WHERE, type HowBad, type Noticing, type Where } from './skin-care.vocabulary'

export type SkinCareServiceDeps = {
  repository: SkinCareRepository
  pauses: StepPausesRepository
  /** The reviewed text of the outcomes; null where the team has not written a row yet. */
  workbook: Pick<CatalogWorkbookService, 'responseFor' | 'escalationFor'>
  /** Read for the zone that decides what today is. */
  reminders: Pick<RemindersService, 'zoneFor'>
  /** What the routine module answers (skin-care never imports routines): whether the profile has a step-down running on `today` (a local day, 'YYYY-MM-DD'), and the routine in force. */
  routine: {
    /** `routine` is the read this log has already made, when it made one (null: there is no routine; undefined: none was read, so read it); answering from it saves a second read. */
    stepDownRunning(profileId: string, today: string, routine?: SkinCareRoutine | null): Promise<boolean>
    skinCareRoutineFor(profileId: string): Promise<SkinCareRoutine | null>
  }
  /** Where a pause tells the person (the inbox row). */
  inbox: Pick<InboxService, 'write'>
  now?: () => Date
}

export type LogInput = { noticing: Noticing[]; where?: Where[]; howBad?: HowBad | null; note?: string | null }

/** A log as the app sees it: never the note, the profile or the reason. */
export type SkinLogView = { id: string; day: string; noticing: Noticing[]; where: Where[]; howBad: HowBad | null; outcome: SkinOutcome['kind'] }

/** What the person logged, repeated back on the professional screen. */
export type LogFacts = { noticing: Noticing[]; where: Where[]; howBad: HowBad | null; note: string | null }

/** The reviewed text of the outcome; a good day (`logged`) has none. */
export type LogResponse = Response[] | Response | (Escalation & { facts: LogFacts }) | null

/** The pause a log made: the step, the routine's own title for it, and the local day it is checked. */
export type PausedView = { id: string; step: RoutineStep; title: string; checkDay: string }

/** `outcome` is the final action: a `pause` outcome the rules came to may end as a professional or as nothing to pause (see `log`). `paused` is set only for a pause. */
export type LogResult = { log: SkinLogView; outcome: SkinOutcome; response: LogResponse; paused: PausedView | null }

/** When a pause is made, and the pauses open before it. */
type PauseTime = { today: string; checkDay: string; now: Date; open: StepPause[] }

/** What `log` does about the rules' outcome: the final outcome, and the step when it is a pause. */
type Action = { outcome: SkinOutcome; step: SkinCareRoutineStep | null }

/**
 * Skin logs and pauses (spec #233): the person says what they are noticing, where, and how bad, and fixed rules (`outcomeFor`) decide the outcome. A harm signal pauses a
 * step (`stepToPause`), up to two at a time. Nothing here is AI and the note, which is only stored and shown back on the professional screen, never changes the outcome and is
 * never written to a log line or an error. Allowed before Start and with no routine.
 */
export class SkinCareService {
  private static readonly MAX_NOTE_LENGTH = 500
  private static readonly RECENT_LIMIT = 20
  // A pause is checked this many local days on, and no more than this many steps are paused at once.
  private static readonly CHECK_IN_DAYS = 3
  private static readonly PAUSE_CAP = 2

  private readonly repository: SkinCareRepository
  private readonly pauses: StepPausesRepository
  private readonly workbook: SkinCareServiceDeps['workbook']
  private readonly reminders: SkinCareServiceDeps['reminders']
  private readonly routine: SkinCareServiceDeps['routine']
  private readonly inbox: SkinCareServiceDeps['inbox']
  private readonly now: () => Date

  constructor(deps: SkinCareServiceDeps) {
    this.repository = deps.repository
    this.pauses = deps.pauses
    this.workbook = deps.workbook
    this.reminders = deps.reminders
    this.routine = deps.routine
    this.inbox = deps.inbox
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Gates, in order: 401, 403 `SIGNUP_REQUIRED` for a guest (before the input is looked at), then 400 `VALIDATION_FAILED` (stores nothing): at least one symptom;
   * `nothing-unusual` only alone and with no place; a level for anything else; a note of at most 500 characters. A symptom or place named twice counts once.
   *
   * The rules' outcome is then acted on. A `pause` becomes: a professional (`harm-while-two-paused` when two steps are already `paused`, checked first, or
   * `hard-to-ignore-during-step-down` when a step-down is running and no other active step can be paused); `nothing-to-pause` (no routine, not Started, or no step that can be
   * paused), with one open check-in with no step per profile (a repeat moves its check day); or a pause of the step `stepToPause` chooses, whose check day is the local day + 3
   * and moves every other open `paused` row's to the same day. The stored log says the final outcome. The log is stored, then the pause is made, then the reviewed text is
   * read: a missing row is 503 `CONTENT_UNAVAILABLE`, and the log and the pause stand. The inbox row of a pause is written once the text is in hand.
   *
   * A valid log is always stored. A harm signal reads the open pauses and then the routine once (the step-down answer is given that read); when either read fails the outcome
   * is `nothing-to-pause` (a routine that cannot be read with two steps already paused is still the cap's professional result) and `{ outcome: 'skin-care-routine-read-failed',
   * profileId }` is logged. If the pause itself cannot be written, `{ outcome: 'skin-care-pause-write-failed', profileId }` is logged and: a pause for the same step that is
   * open by then (a double tap, a retry) is answered as this one's; otherwise the outcome is `nothing-to-pause` and the stored log is changed to say so. The check-in with no
   * step is written if the pauses store allows, and a failure to write it is logged and does not fail the log. A red flag, advice and a good day read nothing.
   */
  async log(input: LogInput): Promise<LogResult> {
    const { profileId } = SkinCareService.signedUp()
    const reading = SkinCareService.checked(input)
    const note = input.note ?? null
    const now = this.now()
    const today = await this.dayOf(profileId, now)
    const decided = await this.decide(profileId, today, reading)
    let { outcome, step } = decided
    const { open } = decided

    const row = await this.repository.append({
      id: crypto.randomUUID(),
      profileId,
      ...reading,
      note,
      localDay: today,
      outcome: outcome.kind,
      reason: outcome.kind === 'professional' ? outcome.reason : null,
      rulesVersion: SKIN_OUTCOME_RULES_VERSION,
      createdAt: now,
    })

    const when = { today, checkDay: SkinCareService.plusDays(today, SkinCareService.CHECK_IN_DAYS), now, open }
    let paused: PausedView | null = null
    if (step !== null) {
      try {
        paused = await this.pause(profileId, row.id, step, when)
      } catch {
        console.error({ outcome: 'skin-care-pause-write-failed', profileId })
        paused = await this.openPauseFor(profileId, step)
        if (paused === null) {
          outcome = { kind: 'nothing-to-pause' }
          step = null
          await this.settle(profileId, row.id)
        }
      }
    }
    if (outcome.kind === 'nothing-to-pause') await this.checkInWithNoStepOrLog(profileId, row.id, when)

    const response = await this.responseFor(outcome, { ...reading, note }, step?.step ?? null)
    if (paused !== null) await this.tellInbox(profileId, paused.id, today, response as Response)
    return { log: SkinCareService.viewOf({ ...row, outcome: outcome.kind, reason: outcome.kind === 'professional' ? outcome.reason : null }), outcome, response, paused }
  }

  /** The session profile's last 20 logs, newest first, without the note. 401, and 403 `SIGNUP_REQUIRED` for a guest. */
  async recent(): Promise<SkinLogView[]> {
    const { profileId } = SkinCareService.signedUp()
    return (await this.repository.recent(profileId, SkinCareService.RECENT_LIMIT)).map(SkinCareService.viewOf)
  }

  /**
   * Undo: sets the session profile's pause to `undone` and marks the log that caused it overridden (the log is kept). Only on the local day of the pause, today read in the zone
   * stored now against the pause's frozen day. 401, 403 `SIGNUP_REQUIRED`, 404 `PAUSE_NOT_FOUND` (another profile's pause, none, one that is no longer `paused`, or the check-in with no
   * step, which pauses nothing and so has nothing to undo), 409 `UNDO_EXPIRED`.
   * The log is marked first and the state change is conditional on the pause still being `paused`, so a request that fails between the two can be repeated and still marks the log,
   * and a pause another request has closed (replaced by a rebuild) is never turned into `undone`.
   */
  async undo(pauseId: string): Promise<{ id: string; state: 'undone' }> {
    const { profileId } = SkinCareService.signedUp()
    const pause = await this.pauses.find(profileId, pauseId)
    if (pause === null || pause.state !== 'paused' || pause.step === null) throw new NotFoundError('PAUSE_NOT_FOUND', 'No such pause')
    if ((await this.dayOf(profileId, this.now())) > pause.pausedOn) throw new ConflictError('UNDO_EXPIRED', 'A pause can only be undone on the day it was made')
    if (pause.sourceLogId !== null) await this.repository.markOverridden(profileId, pause.sourceLogId)
    if (!(await this.pauses.update(profileId, pause.id, { state: 'undone' }, 'paused'))) throw new NotFoundError('PAUSE_NOT_FOUND', 'No such pause')
    return { id: pause.id, state: 'undone' }
  }

  /**
   * Called after the routine writes a version, by profile id with no session: an open pause with a step stays while the routine still has that step with the same product key,
   * and is set to `replaced` when the step now has another product (or none). Starts no ladder. Nothing changes while there is no routine to read. Idempotent.
   */
  async reconcile(profileId: string): Promise<void> {
    await this.reconcileOpen(profileId, await this.pauses.openFor(profileId))
  }

  /**
   * What the routine shows of the profile's pauses: each open `paused` step with the key of its product (`productId` is the pause's product key, so a product with no label is
   * named by its shelf entry), and no hold yet. By profile id with no session. It reconciles first, so a rebuild whose hook was missed heals here; that is not fatal (a failure is
   * logged `{ outcome: 'skin-care-reconcile-failed', profileId }` and the read goes on). A failure to read the pauses rejects: it never answers "no pauses", so the routine read fails closed.
   */
  async stateFor(profileId: string, _today: string): Promise<SkinCareState> {
    const open = await this.pauses.openFor(profileId)
    let replaced = new Set<string>()
    try {
      replaced = await this.reconcileOpen(profileId, open)
    } catch {
      console.error({ outcome: 'skin-care-reconcile-failed', profileId })
    }
    return {
      pauses: open.flatMap((pause) => (pause.step !== null && pause.state === 'paused' && !replaced.has(pause.id) ? [{ step: pause.step, productId: pause.productKey, state: 'paused' as const }] : [])),
      held: false,
    }
  }

  /** `reconcile` over the pauses already read: answers the ids it set to `replaced`. */
  private async reconcileOpen(profileId: string, open: StepPause[]): Promise<Set<string>> {
    const replaced = new Set<string>()
    if (!open.some((pause) => pause.step !== null)) return replaced
    const routine = await this.routine.skinCareRoutineFor(profileId)
    if (routine === null) return replaced
    for (const pause of open) {
      if (pause.step === null || SkinCareService.holdsStep(routine, pause)) continue
      await this.pauses.update(profileId, pause.id, { state: 'replaced' })
      replaced.add(pause.id)
    }
    return replaced
  }

  /** Whether the routine still has the pause's step with the pause's product. */
  private static holdsStep(routine: SkinCareRoutine, pause: StepPause): boolean {
    return routine.steps.some((entry) => entry.step === pause.step && pauseKeyOf(entry) === pause.productKey)
  }

  /** The person's local day; the UTC day if the stored zone cannot be read or used, so a valid log is always stored. */
  private async dayOf(profileId: string, now: Date): Promise<string> {
    try {
      return localDay(now, await this.reminders.zoneFor(profileId))
    } catch {
      return localDay(now, null)
    }
  }

  /**
   * What the log comes to. A red flag, advice and a good day are decided from the log alone: nothing is read for them. For a harm signal the open pauses are read, then the
   * routine once, and that read is handed to the step-down answer (`routine.stepDownRunning` may use it instead of reading again); a step-down read that fails counts as no
   * step-down: the harm signal then pauses, which is more cautious than the expected flare. A read that fails ends in `nothing-to-pause` (see `log`), except that a routine which
   * cannot be read with two steps already paused is still the cap's professional result.
   */
  private async decide(profileId: string, today: string, reading: SkinLogReading): Promise<Action & { open: StepPause[] }> {
    const flagged = outcomeFor(reading, { stepDownRunning: false })
    if (flagged.kind !== 'pause') return { outcome: flagged, step: null, open: [] }

    let open: StepPause[] | null = null
    try {
      open = await this.pauses.openFor(profileId)
    } catch {
      // Not known: the cap cannot be applied and the check-in with no step may not be there to reuse.
    }
    let routine: SkinCareRoutine | null
    try {
      routine = await this.routine.skinCareRoutineFor(profileId)
    } catch {
      return { ...(open !== null && SkinCareService.capReached(open) ? SkinCareService.capped() : SkinCareService.readFailed(profileId)), open: open ?? [] }
    }
    let stepDownRunning = false
    try {
      stepDownRunning = await this.routine.stepDownRunning(profileId, today, routine)
    } catch {
      console.error({ outcome: 'step-down-read-failed', profileId })
    }
    const ruled = stepDownRunning ? outcomeFor(reading, { stepDownRunning }) : flagged
    if (ruled.kind !== 'pause') return { outcome: ruled, step: null, open: [] }
    if (open === null) return { ...SkinCareService.readFailed(profileId), open: [] }

    // A pause for a product the routine no longer has at that step is stale (a rebuild whose reconcile has not run yet): it neither counts nor holds its step.
    const live = routine === null ? open : open.filter((pause) => pause.step === null || SkinCareService.holdsStep(routine, pause))
    return { ...SkinCareService.actionFor(ruled, routine, live), open: live }
  }

  /** The log is stored and the person is told what is safe to do (skip what stings), as when there is no step to pause. Logs ids only. */
  private static readFailed(profileId: string): Action {
    console.error({ outcome: 'skin-care-routine-read-failed', profileId })
    return { outcome: { kind: 'nothing-to-pause' }, step: null }
  }

  private static capReached(open: StepPause[]): boolean {
    return open.filter((pause) => pause.state === 'paused' && pause.step !== null).length >= SkinCareService.PAUSE_CAP
  }

  private static capped(): Action {
    return { outcome: { kind: 'professional', reason: 'harm-while-two-paused' }, step: null }
  }

  /** What a `pause` outcome comes to, from the pauses open and the routine in force (see `log`). */
  private static actionFor(ruled: Extract<SkinOutcome, { kind: 'pause' }>, routine: SkinCareRoutine | null, open: StepPause[]): Action {
    if (SkinCareService.capReached(open)) return SkinCareService.capped()

    // A step with nothing to key a pause by cannot be paused (and the routine could not show it paused).
    const pausable = (routine?.steps ?? []).filter((entry) => pauseKeyOf(entry) !== null)
    // Any open pause, being brought back too, holds its step: a second open pause for it would be refused by the table.
    const held = open.map(({ step }) => ({ step }))
    if (ruled.duringStepDown) {
      // The step-down is never stopped, and the basics are never paused for it: only another active step, else a professional.
      const chosen = routine === null ? null : stepToPause({ ...routine, steps: pausable.filter(({ activeGroups }) => activeGroups.length > 0) }, held)
      return chosen === null ? { outcome: { kind: 'professional', reason: 'hard-to-ignore-during-step-down' }, step: null } : { outcome: ruled, step: chosen }
    }
    const chosen = routine === null || routine.dayOne === null ? null : stepToPause({ ...routine, steps: pausable }, held)
    return chosen === null ? { outcome: { kind: 'nothing-to-pause' }, step: null } : { outcome: ruled, step: chosen }
  }

  /** The `paused` row for the step that is open now, as a pause view: the answer when this log's own write failed but a double tap's or a retry's (or its own, before a later write failed) stands. Null when none, or when it cannot be read. */
  private async openPauseFor(profileId: string, entry: SkinCareRoutineStep): Promise<PausedView | null> {
    try {
      const held = (await this.pauses.openFor(profileId)).find((pause) => pause.state === 'paused' && pause.step === entry.step && pause.productKey === pauseKeyOf(entry))
      return held === undefined ? null : { id: held.id, step: entry.step, title: entry.title, checkDay: held.checkDay }
    } catch {
      return null
    }
  }

  /** Changes the stored log to say it came to nothing to pause, when the pause it started could not be made. A failure is logged and does not fail the log. */
  private async settle(profileId: string, logId: string): Promise<void> {
    try {
      await this.repository.setOutcome(profileId, logId, 'nothing-to-pause', null)
    } catch {
      console.error({ outcome: 'skin-care-log-outcome-update-failed', profileId })
    }
  }

  private async checkInWithNoStepOrLog(profileId: string, logId: string, when: PauseTime): Promise<void> {
    try {
      await this.checkInWithNoStep(profileId, logId, when)
    } catch {
      console.error({ outcome: 'skin-care-check-in-write-failed', profileId })
    }
  }

  /** Pauses the step, and moves every other open `paused` row's check day to the pause's, so the person is asked once. */
  private async pause(profileId: string, logId: string, entry: SkinCareRoutineStep, when: PauseTime): Promise<PausedView> {
    const id = crypto.randomUUID()
    await this.pauses.insert({
      id,
      profileId,
      step: entry.step,
      productKey: pauseKeyOf(entry)!,
      productId: entry.productId,
      productRef: entry.productRef,
      ingredientGroup: entry.activeGroups[0] ?? null,
      state: 'paused',
      pausedOn: when.today,
      checkDay: when.checkDay,
      sameCount: 0,
      sourceLogId: logId,
      ladderCode: null,
      ladderStartedOn: null,
      versionId: null,
      createdAt: when.now,
    })
    for (const other of when.open.filter(({ state }) => state === 'paused')) await this.pauses.update(profileId, other.id, { checkDay: when.checkDay })
    return { id, step: entry.step, title: entry.title, checkDay: when.checkDay }
  }

  /** The one open check-in with no step: opened by the first "nothing to pause", and moved by each after it. */
  private async checkInWithNoStep(profileId: string, logId: string, when: PauseTime): Promise<void> {
    const held = when.open.find(({ step }) => step === null)
    if (held !== undefined) {
      await this.pauses.update(profileId, held.id, { checkDay: when.checkDay })
      return
    }
    await this.pauses.insert({
      id: crypto.randomUUID(),
      profileId,
      step: null,
      productKey: '',
      productId: null,
      productRef: { kind: 'none' },
      ingredientGroup: null,
      state: 'paused',
      pausedOn: when.today,
      checkDay: when.checkDay,
      sameCount: 0,
      sourceLogId: logId,
      ladderCode: null,
      ladderStartedOn: null,
      versionId: null,
      createdAt: when.now,
    })
  }

  /** The inbox row of a pause. The pause and the answer stand if it cannot be written: the person has been told, and the failure is logged by ids. */
  private async tellInbox(profileId: string, pauseId: string, day: string, text: Response): Promise<void> {
    try {
      await this.inbox.write({ profileId, kind: 'paused', day, title: text.title, body: text.body, link: '/routine', key: `paused:${pauseId}` })
    } catch {
      console.error({ outcome: 'paused-inbox-write-failed', profileId, pauseId })
    }
  }

  private async responseFor(outcome: SkinOutcome, facts: LogFacts, step: RoutineStep | null): Promise<LogResponse> {
    const noun = step === null ? null : STEP_NOUN[step]
    switch (outcome.kind) {
      case 'advice': {
        const lines = await Promise.all(outcome.codes.map((code) => this.workbook.responseFor(code)))
        return lines.map((line) => fillResponse(SkinCareService.reviewed(line), null))
      }
      case 'expected-flare':
        return fillResponse(SkinCareService.reviewed(await this.workbook.responseFor('expected-flare')), null)
      case 'pause':
        return fillResponse(SkinCareService.reviewed(await this.workbook.responseFor('paused')), noun)
      case 'nothing-to-pause':
        return fillResponse(SkinCareService.reviewed(await this.workbook.responseFor('nothing-to-pause')), null)
      case 'professional':
        return { ...SkinCareService.reviewed(await this.workbook.escalationFor(outcome.reason)), facts }
      default:
        return null
    }
  }

  private static reviewed<T>(row: T | null): T {
    if (row === null) throw new UnavailableError('CONTENT_UNAVAILABLE', 'This guidance is not available yet. Your log was saved.')
    return row
  }

  private static viewOf(row: SkinLog): SkinLogView {
    return { id: row.id, day: row.localDay, noticing: row.noticing, where: row.where, howBad: row.howBad, outcome: row.outcome }
  }

  /** The calendar day `days` after `day` ('YYYY-MM-DD'): date arithmetic, so a day the clocks change in is no different. */
  private static plusDays(day: string, days: number): string {
    const date = new Date(`${day}T00:00:00.000Z`)
    date.setUTCDate(date.getUTCDate() + days)
    return date.toISOString().slice(0, 10)
  }

  private static signedUp() {
    const user = requireUser()
    if (user.status !== 'verified') throw new ForbiddenError('SIGNUP_REQUIRED', 'Sign up to log how your skin feels')
    return user
  }

  private static checked(input: LogInput): SkinLogReading {
    const refused = (message: string) => new ValidationError('VALIDATION_FAILED', message)
    if (!Array.isArray(input.noticing) || (input.where != null && !Array.isArray(input.where))) throw refused('Choose from the lists given')
    const noticing = [...new Set(input.noticing)]
    const where = [...new Set(input.where ?? [])]
    if (noticing.length === 0) throw refused('Choose at least one thing you are noticing')
    if (!noticing.every((item) => (NOTICING as readonly unknown[]).includes(item)) || !where.every((place) => (WHERE as readonly unknown[]).includes(place))) {
      throw refused('Choose from the lists given')
    }
    if (input.howBad != null && !(HOW_BAD as readonly unknown[]).includes(input.howBad)) throw refused('Choose how bad it is from the list given')
    const goodDay = noticing.includes('nothing-unusual')
    if (goodDay && (noticing.length > 1 || where.length > 0)) throw refused('Nothing unusual cannot be chosen with anything else, or with a place')
    if (!goodDay && !input.howBad) throw refused('Choose how bad it is')
    if (input.note != null && (typeof input.note !== 'string' || [...input.note].length > SkinCareService.MAX_NOTE_LENGTH)) {
      throw refused(`The note must be text of at most ${SkinCareService.MAX_NOTE_LENGTH} characters`)
    }
    return { noticing, where, howBad: goodDay ? null : (input.howBad ?? null) }
  }
}
