import { requireUser } from '../../lib/context'
import { ConflictError, ForbiddenError, ValidationError } from '../../lib/errors'
import { localDay, usableZone } from '../../lib/local-day'
import type { RemindersService } from '../reminders/reminders.service'
import type { RoutineCheckInsRepository, CheckInTime } from './routines.check-ins.repository'
import type { RoutinesRepository } from './routines.repository'

export type RoutineCheckInsServiceDeps = {
  repository: RoutineCheckInsRepository
  /** Read for the routine in force, whose `startedOn` is day 1. */
  versions: Pick<RoutinesRepository, 'current'>
  /** Read for the zone that decides what today is. */
  reminders: Pick<RemindersService, 'zoneFor'>
  now?: () => Date
}

/**
 * Check-ins and missed days (spec #217). A person says they did their morning or evening routine for a local day; `missedStreak` says how many days in a row they have
 * missed, for the nudge a job sends. Both work in calendar dates ('YYYY-MM-DD'), never hours: day 1 is stored as the UTC midnight of a calendar date, and a check-in's day
 * is fixed when it is made, so a later change of time zone moves neither.
 */
export class RoutineCheckInsService {
  private static readonly DAY_MS = 24 * 60 * 60 * 1000
  private static readonly DATE = /^\d{4}-\d{2}-\d{2}$/

  private readonly repository: RoutineCheckInsRepository
  private readonly versions: RoutineCheckInsServiceDeps['versions']
  private readonly reminders: RoutineCheckInsServiceDeps['reminders']
  private readonly now: () => Date

  constructor(deps: RoutineCheckInsServiceDeps) {
    this.repository = deps.repository
    this.versions = deps.versions
    this.reminders = deps.reminders
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Records the session profile's check-in for `day` and answers what was recorded. Gates, in order: 401, 403 `SIGNUP_REQUIRED` for a guest, 409 `ROUTINE_NOT_STARTED`
   * while the routine in force has no day 1, then 400 `VALIDATION_FAILED` unless `day` is a real calendar date that is today or yesterday in the person's local day (their
   * stored zone, else UTC) and is not before day 1. A refused call stores nothing. Idempotent: a check-in already held is the same answer and is not stored again.
   */
  async checkIn(day: string, time: CheckInTime): Promise<{ day: string; time: CheckInTime }> {
    const { profileId, status } = requireUser()
    if (status !== 'verified') throw new ForbiddenError('SIGNUP_REQUIRED', 'Sign up to check in')
    const startedOn = (await this.versions.current(profileId))?.startedOn
    if (!startedOn) throw new ConflictError('ROUTINE_NOT_STARTED', 'Start your routine first')
    const now = this.now()
    // A stored zone Intl cannot read is the UTC day, as Today reads it: the slide must not fail where the screen renders.
    const today = localDay(now, usableZone(now, await this.reminders.zoneFor(profileId)))
    if (!RoutineCheckInsService.isDate(day) || (day !== today && day !== RoutineCheckInsService.shift(today, -1)) || day < RoutineCheckInsService.dateOf(startedOn)) {
      throw new ValidationError('VALIDATION_FAILED', 'day must be today or yesterday, and not before your first day')
    }
    await this.repository.record(profileId, day, time, now)
    return { day, time }
  }

  /**
   * The run of missed days that ends yesterday, by profile id with no session (a job reads it). A missed day is one on or after day 1 with no check-in at either time. Today
   * never counts, since it is not over, and a check-in made today does not change the answer. `since` is the first day of the run, which is what a nudge is sent once per.
   * `{ days: 0, since: null }` before the routine is started, on day 1, and whenever yesterday was checked in.
   */
  async missedStreak(profileId: string, today: string): Promise<{ days: number; since: string | null }> {
    const none = { days: 0, since: null }
    const startedOn = (await this.versions.current(profileId))?.startedOn
    if (!startedOn) return none
    const dayOne = RoutineCheckInsService.dateOf(startedOn)
    const yesterday = RoutineCheckInsService.shift(today, -1)
    if (yesterday < dayOne) return none
    // The run starts the day after the latest day done, or on day 1 when none was.
    const lastDone = await this.repository.latestDay(profileId, dayOne, yesterday)
    const since = lastDone === null ? dayOne : RoutineCheckInsService.shift(lastDone, 1)
    if (since > yesterday) return none
    return { days: RoutineCheckInsService.daysBetween(since, yesterday) + 1, since }
  }

  private static dateOf(startedOn: Date): string {
    return startedOn.toISOString().slice(0, 10)
  }

  private static isDate(day: string): boolean {
    return RoutineCheckInsService.DATE.test(day) && RoutineCheckInsService.shift(day, 0) === day
  }

  /** The calendar date `n` days from `date`; for a text that is not a real date, one that differs from it, so `isDate` can compare. */
  private static shift(date: string, n: number): string {
    const start = new Date(`${date}T00:00:00.000Z`).getTime()
    return Number.isNaN(start) ? '' : new Date(start + n * RoutineCheckInsService.DAY_MS).toISOString().slice(0, 10)
  }

  private static daysBetween(from: string, to: string): number {
    return (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / RoutineCheckInsService.DAY_MS
  }
}
