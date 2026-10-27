import { describeError } from '../../jobs/safe-error'
import type { Frequency } from '../catalog/catalog.vocabulary'
import type { NotificationsService } from '../notifications/notifications.service'
import type { RemindersRepository } from './reminders.repository'
import type { ReminderSendsRepository } from './reminders.sends.repository'
import type { ReminderRoutinePlan, ReminderSettings } from './reminders.types'

export type ReminderSendsServiceDeps = {
  /** The send job's one query: every profile with reminders on. */
  settings: Pick<RemindersRepository, 'listEnabled'>
  sends: ReminderSendsRepository
  /** The routine as the job reads it, by profile id (RoutineViewerService.reminderPlanFor); null while the routine is not Started. */
  routine: { reminderPlanFor(profileId: string): Promise<ReminderRoutinePlan | null> }
  notifications: Pick<NotificationsService, 'hasPhone' | 'routineReminder'>
}

type ReminderTime = 'morning' | 'evening'

/** A wall-clock reading as 'YYYY-MM-DDTHH:MM', which sorts as text. */
type Wall = string

/**
 * The 15-minute reminder send job (spec #217): finds the profiles whose morning or evening time was reached in the last quarter hour, in their own zone, and queues one
 * push for each through NotificationsService (which sends it, with the retries, dead tokens and receipts every push has). It reads no request context, so it needs no actor.
 */
export class ReminderSendsService {
  private static readonly WINDOW_MS = 15 * 60 * 1000
  private static readonly DAY_MS = 24 * 60 * 60 * 1000

  private static readonly formatters = new Map<string, Intl.DateTimeFormat>()

  private readonly settings: ReminderSendsServiceDeps['settings']
  private readonly sends: ReminderSendsRepository
  private readonly routine: ReminderSendsServiceDeps['routine']
  private readonly notifications: ReminderSendsServiceDeps['notifications']

  constructor(deps: ReminderSendsServiceDeps) {
    this.settings = deps.settings
    this.sends = deps.sends
    this.routine = deps.routine
    this.notifications = deps.notifications
  }

  /**
   * Queues the reminders due at `now` and answers how many were queued (an enqueue that failed is not counted). A reminder is one profile and one time (the morning's or the evening's), however many phones it reaches. The
   * job is given the time its cron was scheduled for, so a window is never missed or counted twice by a Worker that started late.
   *
   * A time is due when the profile's local time (its zone; UTC while none is stored) is in [time, time + 15 minutes) of real time: a time the clocks skip is due at the first
   * instant after the gap, and one that happens twice is due once (the second pass is refused by the claim). Nothing is sent before day 1, for a profile with no phone or when
   * nothing is due. The evening lists only the entries due that local day: alternate-days entries on every other day counted from day 1, weekly ones on day 1's weekday,
   * never as-needed ones. The order is the phone (once per profile, before the routine is read), then per reminder the claim, then the push: a window with no phone
   * claims nothing, so a phone that registers before it closes is still sent to. A push whose enqueue fails keeps its claim, so it is not tried again that day.
   *
   * One profile's failure is logged by id and does not stop the others.
   */
  async sendDue(now: Date): Promise<number> {
    const walls = new Map<string, { now: Wall; before: Wall }>()
    let queued = 0
    for (const settings of await this.settings.listEnabled()) {
      try {
        queued += await this.sendFor(settings, now, walls)
      } catch (error) {
        // The profile's id, the outcome and the error's class (describeError names an unexpected error and says no more): never its text, which can carry a title, a token or a zone.
        console.error({ job: 'reminder-send', outcome: 'profile-failed', profileId: settings.profileId, error: describeError(error) })
      }
    }
    return queued
  }

  private async sendFor(settings: ReminderSettings, now: Date, walls: Map<string, { now: Wall; before: Wall }>): Promise<number> {
    const zone = settings.timeZone ?? 'UTC'
    let reading = walls.get(zone)
    if (!reading) {
      reading = { now: ReminderSendsService.wallOf(now, zone), before: ReminderSendsService.wallOf(new Date(now.getTime() - ReminderSendsService.WINDOW_MS), zone) }
      walls.set(zone, reading)
    }
    const due = (['morning', 'evening'] as const).flatMap((time) => {
      const day = ReminderSendsService.dueDay(reading, settings[time])
      return day === null ? [] : [{ time, day }]
    })
    if (due.length === 0) return 0
    // The phone first: a profile with none (it declined notifications, say) must not cost a routine read, and a window with no phone claims nothing.
    if (!(await this.notifications.hasPhone(settings.profileId))) {
      console.log({ job: 'reminder-send', outcome: 'no-phone', profileId: settings.profileId })
      return 0
    }
    const plan = await this.routine.reminderPlanFor(settings.profileId)
    if (plan === null) return 0

    let queued = 0
    for (const { time, day } of due) {
      if (day < plan.dayOne) continue
      const title = ReminderSendsService.titleFor(plan, time, day)
      if (title === '') continue
      if (!(await this.sends.claim(settings.profileId, day, time, now))) continue
      if (await this.notifications.routineReminder({ profileId: settings.profileId, day, time, title })) queued++
    }
    return queued
  }

  /**
   * The local day whose `time` ('HH:MM') was reached within the last 15 minutes, or null. The wall clock is compared on both ends of the window, so a time the clocks skip
   * is caught by the first reading past it, and one just before midnight is still due on the day it belongs to.
   */
  private static dueDay(reading: { now: Wall; before: Wall }, time: string): string | null {
    const today = reading.now.slice(0, 10)
    for (const day of [today, ReminderSendsService.dayBefore(today)]) {
      const target = `${day}T${time}`
      if (reading.now >= target && reading.before < target) return day
    }
    return null
  }

  /** The entry titles the reminder lists. The morning lists every entry; the evening only those due on `day`. Empty when nothing is. */
  private static titleFor(plan: ReminderRoutinePlan, time: ReminderTime, day: string): string {
    const entries = time === 'morning' ? plan.morning : plan.evening.filter(({ frequency }) => ReminderSendsService.dueOnDay(frequency, ReminderSendsService.daysBetween(plan.dayOne, day)))
    return entries.map(({ title }) => title).join(', ')
  }

  /** Whether an evening entry of this frequency is due `sinceDayOne` days after day 1 (0 on day 1 itself). */
  private static dueOnDay(frequency: Frequency, sinceDayOne: number): boolean {
    switch (frequency) {
      case 'pm':
      case 'am-pm':
        return true
      case 'alternate-days':
        return sinceDayOne % 2 === 0
      case 'weekly':
        return sinceDayOne % 7 === 0
      case 'am':
      case 'as-needed':
        return false
    }
  }

  private static daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / ReminderSendsService.DAY_MS)
  }

  private static dayBefore(day: string): string {
    return new Date(Date.parse(`${day}T00:00:00.000Z`) - ReminderSendsService.DAY_MS).toISOString().slice(0, 10)
  }

  /** The wall clock in `zone` at `at`, to the minute. Throws a RangeError for a zone Intl does not know. */
  private static wallOf(at: Date, zone: string): Wall {
    let formatter = ReminderSendsService.formatters.get(zone)
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      ReminderSendsService.formatters.set(zone, formatter)
    }
    const parts = formatter.formatToParts(at)
    const part = (type: string) => parts.find((p) => p.type === type)!.value
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
  }
}
