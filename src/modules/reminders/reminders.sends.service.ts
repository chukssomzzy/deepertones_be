import { describeError } from '../../jobs/safe-error'
import { daysBetween, dueOnDay } from '../catalog/catalog.frequency'
import type { InboxService, InboxWrite } from '../inbox/inbox.service'
import { allDoneText, pauseCheckInText, routineReminderText, stepDownAlertText } from '../notifications/notifications.copy'
import type { NotificationsService } from '../notifications/notifications.service'
import type { RemindersRepository } from './reminders.repository'
import type { ReminderSendsRepository } from './reminders.sends.repository'
import type { RemindersService } from './reminders.service'
import { dayAfter, dayBefore, DEFAULT_TIMES, dueReminders, type DueReminder, type ReminderClock, type SlotReadings } from './reminders.slot'
import type { DueCheckIn, ReminderRoutinePlan, ReminderSettings } from './reminders.types'

export type ReminderSendsServiceDeps = {
  /** The send job's one query: every profile with reminders on; and one profile's row, for the consumer of the cron's profile message. */
  settings: Pick<RemindersRepository, 'listEnabled' | 'get'>
  sends: ReminderSendsRepository
  /** The routine as the job reads it, by profile id (RoutineViewerService.reminderPlanFor); null while the routine is not Started. */
  routine: { reminderPlanFor(profileId: string): Promise<ReminderRoutinePlan | null> }
  /** The missed-days read (RoutineCheckInsService.missedStreak: reminders may not import routines, so this is a narrow type): `today` is the profile's local day; `since` is the run's first day. */
  checkIns: {
    missedStreak(profileId: string, today: string): Promise<{ days: number; since: string | null }>
    /** The halves of the local day `day` the profile has checked in (RoutineCheckInsService.checkedTimes). */
    checkedTimes(profileId: string, day: string): Promise<ReminderTime[]>
  }
  /** The channel the nudge goes by (RemindersService.missedDaysChannelFor). */
  channel: Pick<RemindersService, 'missedDaysChannelFor'>
  notifications: Pick<NotificationsService, 'hasPhone' | 'routineReminder' | 'stepDownAlert' | 'missedDaysNudge' | 'pauseCheckIn'>
  /** Where the consumer writes the inbox rows of what is due (SkinCare and the routine write theirs themselves). */
  inbox: Pick<InboxService, 'write'>
  /** The check-ins after a pause that are due (SkinCareService.checkInsDue: reminders may not import skin care, so this is a narrow type): `today` is the profile's local day. */
  skinCare: { checkInsDue(profileId: string, today: string): Promise<DueCheckIn[]> }
}

type ReminderTime = 'morning' | 'evening'

/** The ids of the rows written (or already held) for a slot, by key: what a push names as `inboxId`. A row that could not be written has no entry. */
type RowIds = Map<string, string>

/** Everything one inbox row needs but the profile, which is the same for every row of a run. */
type Row = Omit<InboxWrite, 'profileId'>

// Copy awaiting the owner's sign-off (the fixed text of the rest night and the next change: short, kind and generic by design). It passes FORBIDDEN_WORDING, which InboxService.write enforces.
const REST_NIGHT_TEXT = { title: 'A rest night', body: 'Nothing is due this evening. Your skin gets a night off.' }
const NEXT_CHANGE_TEXT = { title: 'A change is coming', body: 'A step in your routine changes tomorrow. Have a look at what is new.' }

/**
 * The reminder send (spec #217), run per profile by the queue consumer since the fan-out (`sendForProfile`, PR 8a; `sendDue` is the loop over every profile the cron ran before): finds the profiles whose morning or evening time was reached in the last quarter hour, in their own zone, and queues one
 * push for each through NotificationsService (which sends it, with the retries, dead tokens and receipts every push has). Since PR 8b the consumer also writes the inbox rows of what is due,
 * for every started profile and not only those it pushes to (see `sendForProfile`). It reads no request context, so it needs no actor.
 */
export class ReminderSendsService {
  /** A run of this many missed days or more is nudged. */
  private static readonly NUDGE_AFTER_DAYS = 2
  /** A message for a slot older than this is dropped (see `sendForProfile`). */
  private static readonly STALE_AFTER_MS = 30 * 60 * 1000

  private readonly settings: ReminderSendsServiceDeps['settings']
  private readonly sends: ReminderSendsRepository
  private readonly routine: ReminderSendsServiceDeps['routine']
  private readonly checkIns: ReminderSendsServiceDeps['checkIns']
  private readonly channel: ReminderSendsServiceDeps['channel']
  private readonly notifications: ReminderSendsServiceDeps['notifications']
  private readonly inbox: ReminderSendsServiceDeps['inbox']
  private readonly skinCare: ReminderSendsServiceDeps['skinCare']

  constructor(deps: ReminderSendsServiceDeps) {
    this.settings = deps.settings
    this.sends = deps.sends
    this.routine = deps.routine
    this.checkIns = deps.checkIns
    this.channel = deps.channel
    this.notifications = deps.notifications
    this.inbox = deps.inbox
    this.skinCare = deps.skinCare
  }

  /**
   * TEST-ONLY REFERENCE PATH: not wired, and it must not be wired again. It is the push-only loop the cron ran before the fan-out, and it writes no inbox rows, so a Worker that ran it would
   * send pushes with no `inboxId` and leave the inbox empty. The equivalence test (test/integration/reminders.fan-out.test.ts) runs it as the "before" path; production goes cron → fan-out →
   * `sendForProfile`.
   *
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
   * switch and a push channel), and one push for each check-in after a pause that is due (claimed as `pause-check:{pauseId}:{checkDay}` on the check day, so once per check day). The rows `listEnabled`
   * answers have reminders on, which every kind needs. The count is every push queued, whatever its kind. This loop writes no inbox rows, so its pushes carry no `inboxId`.
   *
   * One profile's failure is logged by id and does not stop the others.
   */
  async sendDue(now: Date): Promise<number> {
    const readings: SlotReadings = new Map()
    let queued = 0
    for (const settings of await this.settings.listEnabled()) {
      try {
        queued += await this.sendFor(settings, now, dueReminders(settings, now, readings))
      } catch (error) {
        // The profile's id, the outcome and the error's class (describeError names an unexpected error and says no more): never its text, which can carry a title, a token or a zone.
        console.error({ job: 'reminder-send', outcome: 'profile-failed', profileId: settings.profileId, error: describeError(error) })
      }
    }
    return queued
  }

  /**
   * One profile's reminder work for the slot the cron was scheduled for: what `sendDue` does for that profile, with the same gating, claims and order, and the inbox rows besides.
   * Unlike `sendDue` it does not swallow a failure: it throws, so the queue retries the message. Nothing is claimed before the reads that can fail (the routine, the check-ins and the phone), and a claim made
   * before a later failure is kept, so the retry sends what is left and never a push twice. Answers how many pushes were queued.
   *
   * The profile's rows are written for every profile with a Started routine and something due, whether or not reminders are on, a phone is registered or the alert switches are on:
   * a profile with reminders off, or with no settings row, is counted by the default times (07:00 and 21:00 in its stored zone, UTC with none), as the cron counts it. The row is read now, so a profile
   * that turned reminders off since the cron listed it is sent no push, and gets its rows all the same. The rows come first, so a push can carry the id of the row it delivers (`data.inboxId`);
   * a write is idempotent by key, so a retry, or a phone that registers later in the window, finds the row it wrote and names its id. A row that cannot be written is logged by the profile id and its kind and
   * never fails the message or holds back a push (that push goes without an `inboxId`). The missed-days nudge has no row.
   *
   * A slot more than 30 minutes before `now` is dropped (logged `stale-slot`, 0): a message that waited that long in a backed-up queue would send a reminder for a time long
   * gone, and a skipped slot is not made up. A zone that is not one is the profile's stored data, which a retry cannot mend: it is logged and answers 0, as the cron does.
   */
  async sendForProfile(profileId: string, slot: Date, now: Date = new Date()): Promise<number> {
    if (now.getTime() - slot.getTime() > ReminderSendsService.STALE_AFTER_MS) {
      console.log({ job: 'reminder-send', outcome: 'stale-slot', profileId })
      return 0
    }
    const settings = await this.settings.get(profileId)
    const clock = ReminderSendsService.clockOf(settings)
    let due: DueReminder[]
    try {
      due = dueReminders(clock, slot)
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      console.error({ job: 'reminder-send', outcome: 'profile-skipped', profileId })
      return 0
    }
    if (due.length === 0) return 0
    const plan = await this.routine.reminderPlanFor(profileId)
    if (plan === null) return 0
    const checkIns = await this.checkInsDue(profileId, plan, due)
    const rows = await this.writeRows(profileId, plan, due, checkIns)
    if (settings === null || !settings.enabled || !(await this.hasPhone(profileId))) return 0
    return this.sendPushes(settings, plan, due, checkIns, rows, slot)
  }

  private async hasPhone(profileId: string): Promise<boolean> {
    const phone = await this.notifications.hasPhone(profileId)
    if (!phone) console.log({ job: 'reminder-send', outcome: 'no-phone', profileId })
    return phone
  }

  private async sendFor(settings: ReminderSettings, now: Date, due: DueReminder[]): Promise<number> {
    if (due.length === 0) return 0
    // The phone first: a profile with none (it declined notifications, say) must not cost a routine read, and a window with no phone claims nothing.
    if (!(await this.hasPhone(settings.profileId))) return 0
    const plan = await this.routine.reminderPlanFor(settings.profileId)
    if (plan === null) return 0
    // `sendDue` is the push-only loop: it writes no rows, so its pushes carry no `inboxId`.
    return this.sendPushes(settings, plan, due, await this.checkInsDue(settings.profileId, plan, due), null, now)
  }

  private async sendPushes(settings: ReminderSettings, plan: ReminderRoutinePlan, due: DueReminder[], checkIns: Map<string, DueCheckIn[]>, rows: RowIds | null, now: Date): Promise<number> {
    let queued = 0
    for (const { time, day } of due) {
      if (day < plan.dayOne) continue
      if (await this.sendDaily(settings, plan, time, day, rows, now)) queued++
      if (time !== 'morning') continue
      if (settings.stepDownAlerts && (await this.sendStepDownAlert(settings.profileId, plan, day, rows, now))) queued++
      if (settings.missedDaysNudge && (await this.sendMissedDaysNudge(settings, day, now))) queued++
      for (const checkIn of checkIns.get(day) ?? []) if (await this.sendPauseCheckIn(settings.profileId, checkIn, rows, now)) queued++
    }
    return queued
  }

  /** The times a profile is counted by: its own while reminders are on, the defaults while they are off or it has no settings row. The zone is its stored one either way. */
  private static clockOf(settings: ReminderSettings | null): ReminderClock {
    return settings?.enabled ? { morning: settings.morning, evening: settings.evening, timeZone: settings.timeZone } : { ...DEFAULT_TIMES, timeZone: settings?.timeZone ?? null }
  }

  /** The check-ins after a pause that are due, for each local day whose morning is due (from day 1 on). Read once for the rows and the pushes alike. */
  private async checkInsDue(profileId: string, plan: ReminderRoutinePlan, due: DueReminder[]): Promise<Map<string, DueCheckIn[]>> {
    const byDay = new Map<string, DueCheckIn[]>()
    for (const { time, day } of due) if (time === 'morning' && day >= plan.dayOne) byDay.set(day, await this.skinCare.checkInsDue(profileId, day))
    return byDay
  }

  /**
   * The inbox rows of what is due, whatever the profile's switches. The reminder row has the words of the push and is keyed by the time of day (`reminder:{day}:morning`), not the clock time, so a
   * time changed during the day cannot make a second row; so has the step-down row, whatever `stepDownAlerts` says (only the push is gated). The morning has a row for each check-in after a pause
   * that is due, written before any claim and again, idempotently, on every morning it stays unanswered, so a row lost to a failed write is mended by the next delivery. The evening has a rest night
   * when the routine lists evening entries and none is due that day (and the day's all-done row, when the morning is checked in), and a next change when a step of a step-down begins the day after.
   * Answers the ids by key, those of rows that already existed included.
   */
  private async writeRows(profileId: string, plan: ReminderRoutinePlan, due: DueReminder[], checkIns: Map<string, DueCheckIn[]>): Promise<RowIds> {
    const ids: RowIds = new Map()
    const write = (row: Row) => this.writeRow(profileId, row, ids)
    for (const { time, day } of due) {
      if (day < plan.dayOne) continue
      const title = ReminderSendsService.titleFor(plan, time, day)
      if (title !== '') await write({ kind: 'reminder', day, key: `reminder:${day}:${time}`, ...routineReminderText(time, title), link: '/routine' })
      if (time === 'morning') {
        const changes = plan.stepDownChanges.filter((change) => change.day === day)
        if (changes.length > 0) await write({ kind: 'step-down', day, key: `step-down:${day}`, ...stepDownAlertText(changes), link: '/routine/step-down' })
        for (const checkIn of checkIns.get(day) ?? []) await write(ReminderSendsService.checkInRow(day, checkIn))
        continue
      }
      if (title === '' && plan.evening.length > 0) {
        await write({ kind: 'rest-night', day, key: `rest-night:${day}`, ...REST_NIGHT_TEXT, link: '/routine' })
        // The evening has nothing to do, so the day is done once the morning is: the check-in service writes the same row when the morning is checked in after this slot.
        if ((await this.checkIns.checkedTimes(profileId, day)).includes('morning')) await write({ kind: 'all-done', day, key: `all-done:${day}`, ...allDoneText(), link: '/routine' })
      }
      const tomorrow = dayAfter(day)
      if (plan.stepDownChanges.some((change) => change.day === tomorrow)) await write({ kind: 'next-change', day, key: `next-change:${day}`, ...NEXT_CHANGE_TEXT, link: '/routine/step-down' })
    }
    return ids
  }

  private static checkInRow(day: string, { id, checkDay }: DueCheckIn): Row {
    return { kind: 'check-in-due', day, key: `check-in-due:${id}:${checkDay}`, ...pauseCheckInText(), link: '/routine' }
  }

  /** Writes one row and keeps its id by key. A failed write is logged and nothing more: the row is not the push, and the message is not retried for it. */
  private async writeRow(profileId: string, row: Row, ids: RowIds): Promise<void> {
    try {
      ids.set(row.key, (await this.inbox.write({ profileId, ...row })).id)
    } catch {
      // The profile's id and the row's kind: never the row's words, the key's contents nor the error's text.
      console.error({ job: 'reminder-send', outcome: 'inbox-write-failed', profileId, kind: row.kind })
    }
  }

  /** The daily push: claimed per (profile, local day, time), then queued. Answers whether it was queued; an empty list claims nothing. */
  private async sendDaily(settings: ReminderSettings, plan: ReminderRoutinePlan, time: ReminderTime, day: string, rows: RowIds | null, now: Date): Promise<boolean> {
    const title = ReminderSendsService.titleFor(plan, time, day)
    if (title === '') return false
    if (!(await this.sends.claim(settings.profileId, day, time, now))) return false
    return this.notifications.routineReminder({ profileId: settings.profileId, day, time, title, ...ReminderSendsService.inboxIdOf(rows, `reminder:${day}:${time}`) })
  }

  /** One alert listing every step-down step that begins on `day`, claimed as 'step-down' for the day. Nothing is claimed on a day with no change. */
  private async sendStepDownAlert(profileId: string, plan: ReminderRoutinePlan, day: string, rows: RowIds | null, now: Date): Promise<boolean> {
    const changes = plan.stepDownChanges.filter((change) => change.day === day).map(({ title, line }) => ({ title, line }))
    if (changes.length === 0) return false
    if (!(await this.sends.claim(profileId, day, 'step-down', now))) return false
    return this.notifications.stepDownAlert({ profileId, day, changes, ...ReminderSendsService.inboxIdOf(rows, `step-down:${day}`) })
  }

  /**
   * One push for a check-in after a pause that is due, claimed as `pause-check:{pauseId}:{checkDay}` on the check day (not today), so an unanswered check-in is not pushed again
   * on the mornings after it; a pause whose check day moves is a new check-in with a new claim. The words are the same for every pause. The push names the check-in's row, which is
   * written before the claim.
   */
  private async sendPauseCheckIn(profileId: string, { id, checkDay }: DueCheckIn, rows: RowIds | null, now: Date): Promise<boolean> {
    if (!(await this.sends.claim(profileId, checkDay, `pause-check:${id}:${checkDay}`, now))) return false
    return this.notifications.pauseCheckIn({ profileId, pauseId: id, checkDay, ...ReminderSendsService.inboxIdOf(rows, `check-in-due:${id}:${checkDay}`) })
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
    const days = daysBetween(since, dayBefore(today)) + 1
    if (days < ReminderSendsService.NUDGE_AFTER_DAYS) return false
    if ((await this.channel.missedDaysChannelFor(profileId)) === 'whatsapp') {
      console.log({ job: 'reminder-send', outcome: 'nudge-whatsapp-not-sent', profileId, channel: 'whatsapp' })
      return false
    }
    if (!(await this.sends.claim(profileId, since, `nudge:${since}`, now))) return false
    return this.notifications.missedDaysNudge({ profileId, since })
  }

  /** `{ inboxId }` for a key whose row exists, else nothing: the field is left out of the message, never set to undefined. */
  private static inboxIdOf(rows: RowIds | null, key: string): { inboxId?: string } {
    const inboxId = rows?.get(key)
    return inboxId === undefined ? {} : { inboxId }
  }

  /** The entry titles the reminder lists. The morning lists every entry; the evening only those due on `day`. Empty when nothing is. */
  private static titleFor(plan: ReminderRoutinePlan, time: ReminderTime, day: string): string {
    const entries = time === 'morning' ? plan.morning : plan.evening.filter(({ frequency, anchor }) => dueOnDay(frequency, anchor ?? plan.dayOne, day))
    return entries.map(({ title }) => title).join(', ')
  }
}
