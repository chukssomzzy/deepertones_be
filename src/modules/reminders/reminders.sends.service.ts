import { describeError } from '../../jobs/safe-error'
import { daysBetween, dueOnDay } from '../catalog/catalog.frequency'
import type { NotificationsService } from '../notifications/notifications.service'
import type { RemindersRepository } from './reminders.repository'
import type { ReminderSendsRepository } from './reminders.sends.repository'
import type { RemindersService } from './reminders.service'
import type { ReminderRoutinePlan, ReminderSettings } from './reminders.types'

export type ReminderSendsServiceDeps = {
  /** The send job's one query: every profile with reminders on. */
  settings: Pick<RemindersRepository, 'listEnabled'>
  sends: ReminderSendsRepository
  /** The routine as the job reads it, by profile id (RoutineViewerService.reminderPlanFor); null while the routine is not Started. */
  routine: { reminderPlanFor(profileId: string): Promise<ReminderRoutinePlan | null> }
  /** The missed-days read (RoutineCheckInsService.missedStreak: reminders may not import routines, so this is a narrow type): `today` is the profile's local day; `since` is the run's first day. */
  checkIns: { missedStreak(profileId: string, today: string): Promise<{ days: number; since: string | null }> }
  /** The channel the nudge goes by (RemindersService.missedDaysChannelFor). */
  channel: Pick<RemindersService, 'missedDaysChannelFor'>
  notifications: Pick<NotificationsService, 'hasPhone' | 'routineReminder' | 'stepDownAlert' | 'missedDaysNudge'>
}

type ReminderTime = 'morning' | 'evening'

/** A wall-clock reading as 'YYYY-MM-DDTHH:MM', which sorts as text. */
type Wall = string

/**
 * The 15-minute reminder send job (spec #217): finds the profiles whose morning or evening time was reached in the last quarter hour, in their own zone, and queues one
 * push for each through NotificationsService (which sends it, with the retries, dead tokens and receipts every push has). It reads no request context, so it needs no actor.
 */
export class ReminderSendsService {
  /** A run of this many missed days or more is nudged. */
  private static readonly NUDGE_AFTER_DAYS = 2
  private static readonly WINDOW_MS = 15 * 60 * 1000
  private static readonly DAY_MS = 24 * 60 * 60 * 1000

  private static readonly formatters = new Map<string, Intl.DateTimeFormat>()

  private readonly settings: ReminderSendsServiceDeps['settings']
  private readonly sends: ReminderSendsRepository
  private readonly routine: ReminderSendsServiceDeps['routine']
  private readonly checkIns: ReminderSendsServiceDeps['checkIns']
  private readonly channel: ReminderSendsServiceDeps['channel']
  private readonly notifications: ReminderSendsServiceDeps['notifications']

  constructor(deps: ReminderSendsServiceDeps) {
    this.settings = deps.settings
    this.sends = deps.sends
    this.routine = deps.routine
    this.checkIns = deps.checkIns
    this.channel = deps.channel
    this.notifications = deps.notifications
  }

  /**
   * Queues the reminders due at `now` and answers how many were queued (an enqueue that failed is not counted). A reminder is one profile and one time (the morning's or the evening's), however many phones it reaches. The
   * job is given the time its cron was scheduled for, so a window is never missed or counted twice by a Worker that started late.
   *
   * A time is due when the profile's local time (its zone; UTC while none is stored) is in [time, time + 15 minutes) of real time: a time the clocks skip is due at the first
   * instant after the gap, and one that happens twice is due once (the second pass is refused by the claim). Nothing is sent before day 1, for a profile with no phone or when
   * nothing is due. The evening lists only the entries due that local day: alternate-days entries on every other day and weekly ones on the same weekday, counted from the entry's anchor day (an entry being brought back after a pause) or
   * day 1 without one, never as-needed ones. The order is the phone (once per profile, before the routine is read), then per reminder the claim, then the push: a window with no phone
   * claims nothing, so a phone that registers before it closes is still sent to. A push whose enqueue fails keeps its claim, so it is not tried again that day.
   *
   * At the morning time there are up to two more pushes, each its own claim and its own job: the step-down alert (a step of a step-down begins that local day; claimed as 'step-down' for
   * the day; needs the alerts switch) and the missed-days nudge (a run of two or more missed days; claimed as `nudge:{since}` on the run's first day, so once per run; needs the nudge
   * switch and a push channel). The rows `listEnabled` answers have reminders on, which every kind needs. The count is every push queued, whatever its kind.
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
      if (await this.sendDaily(settings, plan, time, day, now)) queued++
      if (time !== 'morning') continue
      if (settings.stepDownAlerts && (await this.sendStepDownAlert(settings.profileId, plan, day, now))) queued++
      if (settings.missedDaysNudge && (await this.sendMissedDaysNudge(settings, day, now))) queued++
    }
    return queued
  }

  /** The daily push: claimed per (profile, local day, time), then queued. Answers whether it was queued; an empty list claims nothing. */
  private async sendDaily(settings: ReminderSettings, plan: ReminderRoutinePlan, time: ReminderTime, day: string, now: Date): Promise<boolean> {
    const title = ReminderSendsService.titleFor(plan, time, day)
    if (title === '') return false
    if (!(await this.sends.claim(settings.profileId, day, time, now))) return false
    return this.notifications.routineReminder({ profileId: settings.profileId, day, time, title })
  }

  /** One alert listing every step-down step that begins on `day`, claimed as 'step-down' for the day. Nothing is claimed on a day with no change. */
  private async sendStepDownAlert(profileId: string, plan: ReminderRoutinePlan, day: string, now: Date): Promise<boolean> {
    const changes = plan.stepDownChanges.filter((change) => change.day === day).map(({ title, line }) => ({ title, line }))
    if (changes.length === 0) return false
    if (!(await this.sends.claim(profileId, day, 'step-down', now))) return false
    return this.notifications.stepDownAlert({ profileId, day, changes })
  }

  /**
   * One nudge for a run of two or more missed days, counted from the day reminders were turned on at the earliest (`enabledOn`): someone who starts late and opts in now is not
   * nudged for days before they asked. The run is clamped here, in calendar dates, so `missedStreak` stays the plain count. A row with no `enabledOn` (only a row that has never been turned on
   * by the service; the migration stamps the existing ones) is not clamped. Claimed as `nudge:{since}` on the run's first day (not today) so the claim is held for the whole run and every later
   * morning of it finds it taken; a new run has a new `since`. The WhatsApp channel claims and queues nothing (the nudge goes out once that send exists) and logs the id alone.
   */
  private async sendMissedDaysNudge(settings: ReminderSettings, today: string, now: Date): Promise<boolean> {
    const { profileId, enabledOn } = settings
    const streak = await this.checkIns.missedStreak(profileId, today)
    if (streak.since === null) return false
    const since = enabledOn !== null && enabledOn > streak.since ? enabledOn : streak.since
    const days = daysBetween(since, ReminderSendsService.dayBefore(today)) + 1
    if (days < ReminderSendsService.NUDGE_AFTER_DAYS) return false
    if ((await this.channel.missedDaysChannelFor(profileId)) === 'whatsapp') {
      console.log({ job: 'reminder-send', outcome: 'nudge-whatsapp-not-sent', profileId, channel: 'whatsapp' })
      return false
    }
    if (!(await this.sends.claim(profileId, since, `nudge:${since}`, now))) return false
    return this.notifications.missedDaysNudge({ profileId, since })
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
    const entries = time === 'morning' ? plan.morning : plan.evening.filter(({ frequency, anchor }) => dueOnDay(frequency, anchor ?? plan.dayOne, day))
    return entries.map(({ title }) => title).join(', ')
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
