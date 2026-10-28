import { requireUser } from '../../lib/context'
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationError } from '../../lib/errors'
import { localDay } from '../../lib/local-day'
import { FREQUENCY_STRENGTH, type Frequency, type IngredientGroup, type RoutineStep } from '../catalog/catalog.vocabulary'
import type { ScheduleStep } from '../catalog/catalog.workbook.schema'
import type { CatalogWorkbookService, Escalation, Response } from '../catalog/catalog.workbook.service'
import type { InboxService } from '../inbox/inbox.service'
import type { RemindersService } from '../reminders/reminders.service'
import { type SkinLogReading, type SkinOutcome, SKIN_OUTCOME_RULES_VERSION, outcomeFor } from './skin-care.outcomes'
import type { StepPausesRepository } from './skin-care.pauses.repository'
import type { SkinCareRepository } from './skin-care.repository'
import { pauseKeyOf, stepToPause } from './skin-care.step-choice'
import type { SkinCareRoutine, SkinCareRoutineStep, SkinCareState, SkinLog, StepPause } from './skin-care.types'
import { fillResponse, STEP_NOUN } from './skin-care.text'
import { CHECK_IN_ANSWERS, HOW_BAD, NOTICING, WHERE, type CheckInAnswer, type HowBad, type Noticing, type PauseState, type Where } from './skin-care.vocabulary'

export type SkinCareServiceDeps = {
  repository: SkinCareRepository
  pauses: StepPausesRepository
  /** The reviewed text of the outcomes and the ladders a step is brought back on; null (or no steps) where the team has not written a row yet. */
  workbook: Pick<CatalogWorkbookService, 'responseFor' | 'escalationFor' | 'reintroductionFor'>
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

/** The reasons a check-in sends the person to a professional. */
export type CheckInReason = 'worse-after-pause' | 'unchanged-after-checks'

export type CheckInOutcome = { kind: 'calmer' } | { kind: 'same' } | { kind: 'professional'; reason: CheckInReason }

/** `response` is the reviewed text with `{step}` filled (calmer, same) or the reviewed escalation (professional). `pause.checkDay` is set only while the pause is still `paused`. */
export type CheckInResult = {
  outcome: CheckInOutcome
  response: Response | Escalation
  pause: { id: string; step: RoutineStep | null; state: PauseState; checkDay: string | null }
}

/** When a pause is made, and the pauses open before it. */
type PauseTime = { today: string; checkDay: string; now: Date; open: StepPause[] }

/** What `log` does about the rules' outcome: the final outcome, the step when it is a pause, and the row to pause again when a step is being brought back (the cap's professional result pauses it again too, with no step). */
type Action = { outcome: SkinOutcome; step: SkinCareRoutineStep | null; again?: StepPause }

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
  // The third "about the same" in a row (two are already counted) goes to a professional.
  private static readonly SAME_LIMIT = 2
  private static readonly CHECK_IN_UNAVAILABLE = 'This guidance is not available yet. Your check-in was not saved; try again later.'
  private static readonly WEEK_DAYS = 7
  private static readonly DAY = /^\d{4}-\d{2}-\d{2}$/

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
   * and moves every other open `paused` row's to the same day; when that step is being brought back (an open `bringing-back` row whose step and product the routine still has), that same row
   * is paused again in place instead (`rePause`), keeping its ladder. With two steps already paused the result is the cap's professional one, and a step being brought back is paused again too
   * (best effort, logged `skin-care-pause-write-failed`), so a ladder never keeps running through a harm signal. The stored log says the final outcome. The log is stored, then the pause is made, then the reviewed text is
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
    const { open, again } = decided

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
    if (step === null && again !== undefined) {
      try {
        await this.rePause(profileId, row.id, again, when)
      } catch {
        console.error({ outcome: 'skin-care-pause-write-failed', profileId })
      }
    }
    if (step !== null) {
      try {
        if (again === undefined) {
          paused = await this.pause(profileId, row.id, step, when)
        } else {
          await this.rePause(profileId, row.id, again, when)
          paused = { id: again.id, step: step.step, title: step.title, checkDay: when.checkDay }
        }
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
    // The pause of a re-pause was told when it was first made (`paused:<id>`), so nothing is written for it.
    if (paused !== null && paused.id !== again?.id) await this.tellInbox(profileId, paused.id, today, response as Response)
    return { log: SkinCareService.viewOf({ ...row, outcome: outcome.kind, reason: outcome.kind === 'professional' ? outcome.reason : null }), outcome, response, paused }
  }

  /** The session profile's last 20 logs, newest first, without the note. 401, and 403 `SIGNUP_REQUIRED` for a guest. */
  async recent(): Promise<SkinLogView[]> {
    const { profileId } = SkinCareService.signedUp()
    return (await this.repository.recent(profileId, SkinCareService.RECENT_LIMIT)).map(SkinCareService.viewOf)
  }

  /**
   * Undo: sets the session profile's pause to `undone` and marks the log that caused it overridden (the log is kept). A pause made again while its step was being brought back (it still
   * has its ladder) is put back to `bringing-back` instead, ladder as it was, so the step never comes back at full strength. Only on the local day of the pause, today read in the zone
   * stored now against the pause's frozen day. 401, 403 `SIGNUP_REQUIRED`, 404 `PAUSE_NOT_FOUND` (another profile's pause, none, one that is no longer `paused`, the check-in with no
   * step, which pauses nothing and so has nothing to undo, or a pause no log of the person's made), 409 `UNDO_EXPIRED`.
   * The log is marked first and the state change is conditional on the pause still being `paused`, so a request that fails between the two can be repeated and still marks the log,
   * and a pause another request has closed (replaced by a rebuild) is never turned into `undone`.
   */
  async undo(pauseId: string): Promise<{ id: string; state: 'undone' | 'bringing-back' }> {
    const { profileId } = SkinCareService.signedUp()
    const pause = await this.pauses.find(profileId, pauseId)
    // A pause with no source log was made by the system (a replaced product with no ladder to bring it back on), not by a log the person made: there is nothing of theirs to undo.
    if (pause === null || pause.state !== 'paused' || pause.step === null || pause.sourceLogId === null) throw new NotFoundError('PAUSE_NOT_FOUND', 'No such pause')
    if ((await this.dayOf(profileId, this.now())) > pause.pausedOn) throw new ConflictError('UNDO_EXPIRED', 'A pause can only be undone on the day it was made')
    if (pause.sourceLogId !== null) await this.repository.markOverridden(profileId, pause.sourceLogId)
    const state = pause.ladderStartedOn === null ? 'undone' : 'bringing-back'
    if (!(await this.pauses.update(profileId, pause.id, { state }, 'paused'))) throw new NotFoundError('PAUSE_NOT_FOUND', 'No such pause')
    return { id: pause.id, state }
  }

  /** The 401 and 403 `SIGNUP_REQUIRED` gates of `answerCheckIn`, for a caller that must apply them before it reads a body. */
  requireSignedUp(): void {
    SkinCareService.signedUp()
  }

  /** The profile's `paused` rows (the check-in with no step too) whose check day has come: `check_day <= today`, a local day. By profile id with no session. Never a step being brought back or sent to a professional. */
  async checkInsDue(profileId: string, today: string): Promise<StepPause[]> {
    return (await this.pauses.openFor(profileId)).filter((pause) => pause.state === 'paused' && pause.checkDay <= today)
  }

  /**
   * The answer to a check-in on a pause that is due. Gates, in order: 401, 403 `SIGNUP_REQUIRED`, 400 `VALIDATION_FAILED` (an answer outside the three), 404 `PAUSE_NOT_FOUND` (another
   * profile's pause, none, or one that is not `paused`), 409 `CHECK_IN_NOT_DUE` (today, read in the zone stored now, against the check day frozen on the pause). The reviewed text of the
   * answer is read before anything is written: a missing or unreadable one is 503 `CONTENT_UNAVAILABLE` and the pause is as it was.
   * - Calmer, on a step: the ladder of the pause's frozen group (else the default) is frozen on the row as JSON, the pause becomes `bringing-back` starting today, and one inbox row
   *   `bringing-back:<id>:1` is written; no ladder, or an empty one, is 503. On the check-in with no step: `ended`.
   * - Same: the next check is three days from today, not from the old check day, and the count goes up; the third in a row is a professional (`unchanged-after-checks`).
   * - Worse: a professional (`worse-after-pause`).
   * A professional result sets the pause to `escalated`. The state change is conditional on the pause still being `paused`, so a request another has answered first is 404.
   */
  async answerCheckIn(pauseId: string, answer: CheckInAnswer): Promise<CheckInResult> {
    const { profileId } = SkinCareService.signedUp()
    if (!(CHECK_IN_ANSWERS as readonly unknown[]).includes(answer)) throw new ValidationError('VALIDATION_FAILED', 'Choose calmer, about the same or worse')
    const pause = await this.pauses.find(profileId, pauseId)
    if (pause === null || pause.state !== 'paused') throw new NotFoundError('PAUSE_NOT_FOUND', 'No such pause')
    const today = await this.dayOf(profileId, this.now())
    if (today < pause.checkDay) throw new ConflictError('CHECK_IN_NOT_DUE', 'This check-in is not due yet')
    if (answer === 'worse') return this.professional(profileId, pause, 'worse-after-pause')
    if (answer === 'same') return pause.sameCount >= SkinCareService.SAME_LIMIT ? this.professional(profileId, pause, 'unchanged-after-checks') : this.same(profileId, pause, today)
    return this.calmer(profileId, pause, today)
  }

  /**
   * Called after the routine writes a version, by profile id with no session: an open pause with a step (`paused`, `bringing-back` or `escalated`) stays while the routine still has that step
   * with the same product key, and is set to `replaced` when the step now has another product (or none). When the step has a new product with a key, that product is brought back from
   * the first rung of the ladder of its own first active group (else the default), frozen, starting today (no inbox row: the only reviewed line is the calmer one, which would be untrue here);
   * with no ladder it is paused, checked in three days, instead (the safe side); a replaced `escalated` step opens an `escalated` row with no ladder (professional help is pending, so the
   * step stays out). Nothing changes while there is no routine to read. Idempotent: a second call finds the new row matching the routine.
   */
  async reconcile(profileId: string): Promise<void> {
    await this.reconcileOpen(profileId, await this.pauses.openFor(profileId))
  }

  /**
   * What the routine shows of the profile's pauses: each open step as `paused` (a `paused` or `escalated` pause) or `bringing-back` on its current rung (`frequency`, and `anchor`, the rung's
   * first day), with `productId` the pause's product key (so a product with no label is named by its shelf entry), and no hold yet. By profile id with no session. A ladder whose back rung
   * has come ends the pause (best effort: a failed write is logged `{ outcome: 'skin-care-ladder-end-failed', profileId }`) and the step is omitted, back at full strength. It reconciles first, so
   * a rebuild whose hook was missed heals here. A failed reconcile is logged `{ outcome: 'skin-care-reconcile-failed', profileId }`, and the pauses are read again: when the routine cannot be read the
   * read goes on with them, but when it can and an open step is no longer the routine's (a replaced product whose new row was not written), the read rejects, so a replaced step is never
   * shown as active. A failure to read the pauses rejects too: it never answers "no pauses", so the routine read fails closed. A ladder that cannot be read keeps the step out as `paused`, and
   * the row is paused again in place (best effort), due now, so the person is asked and a Calmer freezes a fresh ladder.
   */
  async stateFor(profileId: string, today: string): Promise<SkinCareState> {
    let open = await this.pauses.openFor(profileId)
    let replaced = new Set<string>()
    let started: StepPause[] = []
    try {
      ;({ replaced, started } = await this.reconcileOpen(profileId, open))
    } catch {
      console.error({ outcome: 'skin-care-reconcile-failed', profileId })
      // Another request may have finished the work, or only some of it was done: use what is stored now, and refuse to answer while a step is still held by a product it no longer has.
      open = await this.pauses.openFor(profileId)
      await this.requireHeld(profileId, open)
    }
    const pauses: SkinCareState['pauses'] = []
    for (const pause of [...open.filter(({ id }) => !replaced.has(id)), ...started]) {
      if (pause.step === null) continue
      if (pause.state !== 'bringing-back') {
        if (pause.state === 'paused' || pause.state === 'escalated') pauses.push({ step: pause.step, productId: pause.productKey, state: 'paused' })
        continue
      }
      const rung = SkinCareService.rungOf(pause, today)
      if (rung === null) {
        // A ladder that cannot be read keeps the step out rather than let it back at full strength, and the person is asked.
        console.error({ outcome: 'skin-care-ladder-unreadable', profileId, pauseId: pause.id })
        pauses.push({ step: pause.step, productId: pause.productKey, state: 'paused' })
        await this.askAbout(profileId, pause, today)
      } else if (rung.frequency === 'back') {
        await this.endLadder(profileId, pause.id)
      } else {
        pauses.push({ step: pause.step, productId: pause.productKey, state: 'bringing-back', frequency: rung.frequency as Frequency, anchor: rung.anchor })
      }
    }
    return { pauses, held: false }
  }

  /** `reconcile` over the pauses already read: the ids it set to `replaced`, and the rows it opened for the new products. */
  private async reconcileOpen(profileId: string, open: StepPause[]): Promise<{ replaced: Set<string>; started: StepPause[] }> {
    const replaced = new Set<string>()
    const started: StepPause[] = []
    if (!open.some((pause) => pause.step !== null)) return { replaced, started }
    const routine = await this.routine.skinCareRoutineFor(profileId)
    if (routine === null) return { replaced, started }
    const now = this.now()
    let today: string | null = null
    for (const pause of open) {
      if (pause.step === null || SkinCareService.holdsStep(routine, pause)) continue
      const entry = routine.steps.find((candidate) => candidate.step === pause.step)
      const key = entry === undefined ? null : pauseKeyOf(entry)
      // The new product is opened before the old pause is closed, so a failure between the two leaves both open (the step still out of the routine) and the next call finishes it.
      if (entry !== undefined && key !== null && ![...open, ...started].some((other) => !replaced.has(other.id) && other.step === entry.step && other.productKey === key)) {
        today ??= await this.dayOf(profileId, now)
        started.push(await this.startNewProduct(profileId, entry, key, pause.state === 'escalated', today, now))
      }
      await this.pauses.update(profileId, pause.id, { state: 'replaced' })
      replaced.add(pause.id)
    }
    return { replaced, started }
  }

  /**
   * The step's new product: brought back from the first rung of its ladder, or paused and checked in three days when there is no ladder to bring it back on, or `escalated` (no ladder) when
   * the pause it replaces was sent to a professional. No inbox row is written for a ladder started this way: the only reviewed line is the calmer one, which would be untrue here; a
   * reviewed "your new product starts slowly" line needs a Responses outcome (a contract bump) and is out of scope. A failed insert is "already started" when the row is there
   * (a competing request made it, and the unique index refused this one), else it rejects.
   */
  private async startNewProduct(profileId: string, entry: SkinCareRoutineStep, key: string, escalated: boolean, today: string, now: Date): Promise<StepPause> {
    const group = entry.activeGroups[0] ?? null
    const ladder = escalated ? null : await this.ladderFor(group)
    const row: StepPause = {
      id: crypto.randomUUID(),
      profileId,
      step: entry.step,
      productKey: key,
      productId: entry.productId,
      productRef: entry.productRef,
      ingredientGroup: group,
      state: escalated ? 'escalated' : ladder === null ? 'paused' : 'bringing-back',
      pausedOn: today,
      checkDay: SkinCareService.plusDays(today, SkinCareService.CHECK_IN_DAYS),
      sameCount: 0,
      sourceLogId: null,
      ladderCode: ladder === null ? null : JSON.stringify(ladder),
      ladderStartedOn: ladder === null ? null : today,
      versionId: null,
      createdAt: now,
    }
    try {
      await this.pauses.insert(row)
    } catch (error) {
      const started = (await this.pauses.openFor(profileId)).find((open) => open.step === entry.step && open.productKey === key)
      if (started === undefined) throw error
      return started
    }
    return row
  }

  /** Refuses (rejects) while an open step is held by a product the routine no longer has there. Cannot tell, and so allows, when the routine cannot be read or there is none. */
  private async requireHeld(profileId: string, open: StepPause[]): Promise<void> {
    if (!open.some((pause) => pause.step !== null)) return
    let routine: SkinCareRoutine | null
    try {
      routine = await this.routine.skinCareRoutineFor(profileId)
    } catch {
      return
    }
    if (routine !== null && open.some((pause) => pause.step !== null && !SkinCareService.holdsStep(routine, pause))) throw new Error('a step is held by a product the routine no longer has')
  }

  /** A ladder that cannot be read: the row is paused again in place (the ladder columns and the log are kept), due today, so the person is asked. Best effort: a failure is logged by ids. */
  private async askAbout(profileId: string, pause: StepPause, today: string): Promise<void> {
    try {
      await this.pauses.rePause(profileId, pause.id, { pausedOn: today, checkDay: today, sourceLogId: pause.sourceLogId })
    } catch {
      console.error({ outcome: 'skin-care-ladder-repause-failed', profileId, pauseId: pause.id })
    }
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
      return { ...(open !== null && SkinCareService.capReached(open) ? SkinCareService.capped(SkinCareService.ladderHit(open, null)?.pause) : SkinCareService.readFailed(profileId)), open: open ?? [] }
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

  private static capped(again?: StepPause): Action {
    return { outcome: { kind: 'professional', reason: 'harm-while-two-paused' }, step: null, ...(again === undefined ? {} : { again }) }
  }

  /** What a `pause` outcome comes to, from the pauses open and the routine in force (see `log`). */
  private static actionFor(ruled: Extract<SkinOutcome, { kind: 'pause' }>, routine: SkinCareRoutine | null, open: StepPause[]): Action {
    // A step with nothing to key a pause by cannot be paused (and the routine could not show it paused).
    const pausable = (routine?.steps ?? []).filter((entry) => pauseKeyOf(entry) !== null)
    // The cap is checked first. A step being brought back is paused again even then, so a ladder never keeps running through a harm signal.
    if (SkinCareService.capReached(open)) return SkinCareService.capped(SkinCareService.ladderHit(open, pausable)?.pause)


    // The step being brought back is the one a harm signal hits, before any choice. During a step-down it is still only an active step (the basics are never paused for it).
    const again = SkinCareService.ladderHit(open, pausable.filter(({ activeGroups }) => !ruled.duringStepDown || activeGroups.length > 0))
    if (again !== null) return { outcome: ruled, step: again.entry!, again: again.pause }
    // Any open pause, being brought back or sent to a professional too, holds its step: a second open pause for it would be refused by the table, or is not wanted.
    const held = open.map(({ step }) => ({ step }))
    if (ruled.duringStepDown) {
      // The step-down is never stopped, and the basics are never paused for it: only another active step, else a professional.
      const chosen = routine === null ? null : stepToPause({ ...routine, steps: pausable.filter(({ activeGroups }) => activeGroups.length > 0) }, held)
      return chosen === null ? { outcome: { kind: 'professional', reason: 'hard-to-ignore-during-step-down' }, step: null } : { outcome: ruled, step: chosen }
    }
    const chosen = routine === null || routine.dayOne === null ? null : stepToPause({ ...routine, steps: pausable }, held)
    return chosen === null ? { outcome: { kind: 'nothing-to-pause' }, step: null } : { outcome: ruled, step: chosen }
  }

  /**
   * The open `bringing-back` row whose step and product the routine still has (`pausable`), with that entry; the one whose ladder started last when there are several. Null when none.
   * With `pausable` null (the routine could not be read) any such row counts, with no entry.
   */
  private static ladderHit(open: StepPause[], pausable: SkinCareRoutineStep[] | null): { pause: StepPause; entry: SkinCareRoutineStep | null } | null {
    const hits = open.flatMap((pause) => {
      const entry = pausable === null ? null : (pausable.find((candidate) => candidate.step === pause.step && pauseKeyOf(candidate) === pause.productKey) ?? undefined)
      return pause.state === 'bringing-back' && entry !== undefined ? [{ pause, entry }] : []
    })
    return hits.sort((a, b) => (b.pause.ladderStartedOn ?? '').localeCompare(a.pause.ladderStartedOn ?? '') || (a.pause.id < b.pause.id ? -1 : 1))[0] ?? null
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

  /**
   * Every pause again of a step being brought back passes here (PR 6b hooks the reaction mark here: this is the "second pause" the owner defined as a reaction). The same open row is
   * flipped to `paused` in place, keeping its ladder, and every other open `paused` row's check day moves to the same day. False from the store (the row was changed meanwhile) rejects.
   */
  private async rePause(profileId: string, logId: string, target: StepPause, when: PauseTime): Promise<void> {
    if (!(await this.pauses.rePause(profileId, target.id, { pausedOn: when.today, checkDay: when.checkDay, sourceLogId: logId }))) throw new Error('the pause is no longer being brought back')
    for (const other of when.open.filter(({ state }) => state === 'paused')) await this.pauses.update(profileId, other.id, { checkDay: when.checkDay })
  }

  /** The one open check-in with no step: opened by the first "nothing to pause", and moved by each after it. */
  private async checkInWithNoStep(profileId: string, logId: string, when: PauseTime): Promise<void> {
    const held = when.open.find(({ step, state }) => step === null && state === 'paused')
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

  private async calmer(profileId: string, pause: StepPause, today: string): Promise<CheckInResult> {
    const text = fillResponse(SkinCareService.reviewed(await this.workbook.responseFor('check-calmer'), SkinCareService.CHECK_IN_UNAVAILABLE), pause.step === null ? null : STEP_NOUN[pause.step])
    if (pause.step === null) {
      await this.moveFromPaused(profileId, pause, { state: 'ended' })
      return SkinCareService.answered({ kind: 'calmer' }, text, pause, 'ended')
    }
    // The schedule itself is frozen on the row, never a reference to the workbook's row, so a later edit never changes a running ladder.
    const ladder = await this.ladderFor(pause.ingredientGroup)
    if (ladder === null) throw new UnavailableError('CONTENT_UNAVAILABLE', SkinCareService.CHECK_IN_UNAVAILABLE)
    await this.moveFromPaused(profileId, pause, { state: 'bringing-back', ladderCode: JSON.stringify(ladder), ladderStartedOn: today })
    await this.tellBringingBack(profileId, pause.id, today, text)
    return SkinCareService.answered({ kind: 'calmer' }, text, pause, 'bringing-back')
  }

  private async same(profileId: string, pause: StepPause, today: string): Promise<CheckInResult> {
    const text = fillResponse(SkinCareService.reviewed(await this.workbook.responseFor('check-same'), SkinCareService.CHECK_IN_UNAVAILABLE), pause.step === null ? null : STEP_NOUN[pause.step])
    const checkDay = SkinCareService.plusDays(today, SkinCareService.CHECK_IN_DAYS)
    await this.moveFromPaused(profileId, pause, { checkDay, sameCount: pause.sameCount + 1 })
    return SkinCareService.answered({ kind: 'same' }, text, { ...pause, checkDay }, 'paused')
  }

  /**
   * Every professional result of a check-in passes here (PR 6b hooks the hold and the reaction mark here, next to the `escalated` state). The reviewed escalation is read before the
   * pause is written; the pause becomes `escalated`, so it is never due again and its step stays out of the routine.
   */
  private async professional(profileId: string, pause: StepPause, reason: CheckInReason): Promise<CheckInResult> {
    const text = SkinCareService.reviewed(await this.workbook.escalationFor(reason), SkinCareService.CHECK_IN_UNAVAILABLE)
    await this.moveFromPaused(profileId, pause, { state: 'escalated' })
    return SkinCareService.answered({ kind: 'professional', reason }, text, pause, 'escalated')
  }

  private static answered(outcome: CheckInOutcome, response: Response | Escalation, pause: StepPause, state: PauseState): CheckInResult {
    return { outcome, response, pause: { id: pause.id, step: pause.step, state, checkDay: state === 'paused' ? pause.checkDay : null } }
  }

  /** Writes the patch only if the pause is still `paused`: a pause another request has answered or a rebuild has replaced is 404, not overwritten. */
  private async moveFromPaused(profileId: string, pause: StepPause, patch: Parameters<StepPausesRepository['update']>[2]): Promise<void> {
    if (!(await this.pauses.update(profileId, pause.id, patch, 'paused'))) throw new NotFoundError('PAUSE_NOT_FOUND', 'No such pause')
  }

  /** The ladder a step is brought back on: the approved schedule of the group, else the default. Null when it is empty or cannot be read. */
  private async ladderFor(group: IngredientGroup | null): Promise<ScheduleStep[] | null> {
    try {
      const ladder = await this.workbook.reintroductionFor(group)
      return ladder.length > 0 ? ladder : null
    } catch {
      return null
    }
  }

  /**
   * The rung a `bringing-back` row is on today: the last rung that has started (rung n starts `ladderStartedOn` + 7 * (fromWeek - 1) days), the first before any has. Null when the ladder stored
   * on the row is not one `reintroductionFor` could have given: whole weeks from 1 on the first rung and ascending after it, each rung ending no earlier than it starts, a known frequency on
   * every rung, `back` on the last rung only, and a real date for every rung's start.
   */
  private static rungOf(pause: StepPause, today: string): { frequency: string; anchor: string } | null {
    try {
      const startedOn = pause.ladderStartedOn
      const ladder: unknown = JSON.parse(pause.ladderCode ?? '')
      if (startedOn === null || !SkinCareService.DAY.test(startedOn) || !Array.isArray(ladder) || ladder.length === 0) return null
      let before = 0
      const starts: { frequency: string; anchor: string }[] = []
      for (const [index, rung] of ladder.entries()) {
        if (typeof rung !== 'object' || rung === null) return null
        const { fromWeek, toWeek, frequency } = rung as Record<string, unknown>
        if (!Number.isInteger(fromWeek) || !Number.isInteger(toWeek) || typeof frequency !== 'string') return null
        const [from, to] = [fromWeek as number, toWeek as number]
        if (from < 1 || to < from || (index === 0 ? from !== 1 : from <= before)) return null
        if (frequency === 'back' ? index !== ladder.length - 1 : !Object.hasOwn(FREQUENCY_STRENGTH, frequency) || index === ladder.length - 1) return null
        const anchor = SkinCareService.plusDays(startedOn, SkinCareService.WEEK_DAYS * (from - 1))
        if (!SkinCareService.DAY.test(anchor)) return null
        before = to
        starts.push({ frequency, anchor })
      }
      return starts.filter(({ anchor }) => anchor <= today).at(-1) ?? starts[0]!
    } catch {
      return null
    }
  }

  /** The ladder's back rung has come: the pause ends. Best effort, the step is out of the routine either way, so a failure is logged by id. */
  private async endLadder(profileId: string, pauseId: string): Promise<void> {
    try {
      await this.pauses.update(profileId, pauseId, { state: 'ended' }, 'bringing-back')
    } catch {
      console.error({ outcome: 'skin-care-ladder-end-failed', profileId })
    }
  }

  /** The inbox row of a Calmer answer, the first rung of a ladder. The ladder stands if it cannot be written: logged by ids. */
  private async tellBringingBack(profileId: string, pauseId: string, day: string, text: Response): Promise<void> {
    try {
      await this.inbox.write({ profileId, kind: 'bringing-back', day, title: text.title, body: text.body, link: '/routine', key: `bringing-back:${pauseId}:1` })
    } catch {
      console.error({ outcome: 'bringing-back-inbox-write-failed', profileId, pauseId })
    }
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

  private static reviewed<T>(row: T | null, message = 'This guidance is not available yet. Your log was saved.'): T {
    if (row === null) throw new UnavailableError('CONTENT_UNAVAILABLE', message)
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
