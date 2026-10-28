import { requireUser } from '../../lib/context'
import { ForbiddenError, UnavailableError, ValidationError } from '../../lib/errors'
import { localDay } from '../../lib/local-day'
import type { CatalogWorkbookService, Escalation, Response } from '../catalog/catalog.workbook.service'
import type { RemindersService } from '../reminders/reminders.service'
import { type SkinOutcome, SKIN_OUTCOME_RULES_VERSION, outcomeFor } from './skin-care.outcomes'
import type { SkinCareRepository } from './skin-care.repository'
import type { SkinLog } from './skin-care.types'
import type { HowBad, Noticing, Where } from './skin-care.vocabulary'

export type SkinCareServiceDeps = {
  repository: SkinCareRepository
  /** The reviewed text of the outcomes; null where the team has not written a row yet. */
  workbook: Pick<CatalogWorkbookService, 'responseFor' | 'escalationFor'>
  /** Read for the zone that decides what today is. */
  reminders: Pick<RemindersService, 'zoneFor'>
  /** Whether the profile has a step-down running on `today` (a local day, 'YYYY-MM-DD'). The routine module answers it; skin-care never imports routines. */
  routine: { stepDownRunning(profileId: string, today: string): Promise<boolean> }
  now?: () => Date
}

export type LogInput = { noticing: Noticing[]; where?: Where[]; howBad?: HowBad | null; note?: string | null }

/** A log as the app sees it: never the note, the profile or the reason. */
export type SkinLogView = { id: string; day: string; noticing: Noticing[]; where: Where[]; howBad: HowBad | null; outcome: SkinOutcome['kind'] }

/** What the person logged, repeated back on the professional screen. */
export type LogFacts = { noticing: Noticing[]; where: Where[]; howBad: HowBad | null; note: string | null }

/** `pause` and `logged` have no text yet (the pause text arrives with the route that pauses, PR 4b). */
export type LogResponse = Response[] | Response | (Escalation & { facts: LogFacts }) | null

export type LogResult = { log: SkinLogView; outcome: SkinOutcome; response: LogResponse }

/**
 * Skin logs (spec #233): the person says what they are noticing, where, and how bad, and fixed rules (`outcomeFor`) decide the outcome. Nothing here is AI and the note,
 * which is only stored and shown back on the professional screen, never changes the outcome and is never written to a log line or an error. Allowed before Start and
 * with no routine. No route yet: it arrives with pausing (PR 4b).
 */
export class SkinCareService {
  private static readonly MAX_NOTE_LENGTH = 500
  private static readonly RECENT_LIMIT = 20

  private readonly repository: SkinCareRepository
  private readonly workbook: SkinCareServiceDeps['workbook']
  private readonly reminders: SkinCareServiceDeps['reminders']
  private readonly routine: SkinCareServiceDeps['routine']
  private readonly now: () => Date

  constructor(deps: SkinCareServiceDeps) {
    this.repository = deps.repository
    this.workbook = deps.workbook
    this.reminders = deps.reminders
    this.routine = deps.routine
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Stores the log, then looks up the reviewed text for its outcome. Gates, in order: 401, 403 `SIGNUP_REQUIRED` for a guest (before the input is looked at), then 400
   * `VALIDATION_FAILED` (stores nothing): at least one symptom; `nothing-unusual` only alone and with no place; a level for anything else; a note of at most 500 characters.
   * A symptom or place named twice counts once. A reviewed row the team has not written is 503 `CONTENT_UNAVAILABLE`, and the log stays stored.
   */
  async log(input: LogInput): Promise<LogResult> {
    const { profileId } = SkinCareService.signedUp()
    const reading = SkinCareService.checked(input)
    const note = input.note ?? null
    const now = this.now()
    const today = localDay(now, await this.reminders.zoneFor(profileId))
    const outcome = outcomeFor(reading, { stepDownRunning: await this.routine.stepDownRunning(profileId, today) })

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

    return { log: SkinCareService.viewOf(row), outcome, response: await this.responseFor(outcome, { ...reading, note }) }
  }

  /** The session profile's last 20 logs, newest first, without the note. 401, and 403 `SIGNUP_REQUIRED` for a guest. */
  async recent(): Promise<SkinLogView[]> {
    const { profileId } = SkinCareService.signedUp()
    return (await this.repository.recent(profileId, SkinCareService.RECENT_LIMIT)).map(SkinCareService.viewOf)
  }

  private async responseFor(outcome: SkinOutcome, facts: LogFacts): Promise<LogResponse> {
    switch (outcome.kind) {
      case 'advice': {
        const lines = await Promise.all(outcome.codes.map((code) => this.workbook.responseFor(code)))
        return lines.map((line) => SkinCareService.reviewed(line))
      }
      case 'expected-flare':
        return SkinCareService.reviewed(await this.workbook.responseFor('expected-flare'))
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

  private static signedUp() {
    const user = requireUser()
    if (user.status !== 'verified') throw new ForbiddenError('SIGNUP_REQUIRED', 'Sign up to log how your skin feels')
    return user
  }

  private static checked(input: LogInput): { noticing: Noticing[]; where: Where[]; howBad: HowBad | null } {
    const noticing = [...new Set(input.noticing)]
    const where = [...new Set(input.where ?? [])]
    if (noticing.length === 0) throw new ValidationError('VALIDATION_FAILED', 'Choose at least one thing you are noticing')
    const goodDay = noticing.includes('nothing-unusual')
    if (goodDay && (noticing.length > 1 || where.length > 0)) {
      throw new ValidationError('VALIDATION_FAILED', 'Nothing unusual cannot be chosen with anything else, or with a place')
    }
    if (!goodDay && !input.howBad) throw new ValidationError('VALIDATION_FAILED', 'Choose how bad it is')
    if (input.note != null && input.note.length > SkinCareService.MAX_NOTE_LENGTH) {
      throw new ValidationError('VALIDATION_FAILED', `The note can be at most ${SkinCareService.MAX_NOTE_LENGTH} characters`)
    }
    return { noticing, where, howBad: goodDay ? null : (input.howBad ?? null) }
  }
}
