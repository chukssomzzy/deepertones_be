import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryPushSender } from '../../providers/push/memory.push'
import type { Frequency, RoutineStep } from '../catalog/catalog.vocabulary'
import { type PushNotificationMessage, sendPushSpec } from '../notifications/notifications.job-specs'
import { FakeNotificationSettingsRepository } from '../notifications/notification-settings.repository.fake'
import { NotificationsService } from '../notifications/notifications.service'
import { FakePushTokensRepository } from '../notifications/push-tokens.repository.fake'
import { FakeRoutineCheckInsRepository } from '../routines/routines.check-ins.repository.fake'
import { RoutineCheckInsService } from '../routines/routines.check-ins.service'
import type { RoutinesRepository } from '../routines/routines.repository'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import type { ProfilesService } from '../profiles/profiles.service'
import type { UsersService } from '../users/users.service'
import { FakeRemindersRepository } from './reminders.repository.fake'
import { FakeReminderSendsRepository } from './reminders.sends.repository.fake'
import { ReminderSendsService } from './reminders.sends.service'
import { RemindersService } from './reminders.service'

// The 15-minute reminder send job (spec #217, PR 4b2 and 4c): which profiles are due a reminder right now, and the push each one gets: the daily push (4b2), the step-down alert and
// the missed-days nudge (4c, pinned in the blocks at the foot of this file). The reminder goes down the same road as every other push: sendDue enqueues one `send-push` job per due reminder
// (NotificationsService.routineReminder), and the job's body, NotificationsService.deliver, sends it. Collaborators: the settings repository and the sends repository
// (the real fakes), the NOTIFICATIONS SERVICE (the real one over the real fakes, a MemoryJobQueue and a MemoryPushSender; the queue is drained through the real `deliver`, so what is
// asserted last is what a phone would be handed), a real RemindersService (deliver's gate reads `enabledFor`), and the routine, a one-method fake answering from `plans`.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the behaviour and the module, not the class or its constructor):
//   new ReminderSendsService({ settings, sends, routine, notifications })      in src/modules/reminders/reminders.sends.service.ts
//     settings       Pick<RemindersRepository, 'listEnabled'>   every enabled settings row (profileId, morning, evening, timeZone, ...): the job's one query. The window is worked out in code.
//     sends          ReminderSendsRepository                    claim(profileId, localDay, kind, at): Promise<boolean>; see reminders.sends.repository.contract.ts
//     routine        { reminderPlanFor(profileId): Promise<ReminderRoutinePlan | null> }   by profile id, no session. Reminders may not import routines, so this is a narrow type the
//                                                               reminders module owns; RoutineViewerService implements it (routines.viewer.service.test.ts) and the container wires it.
//                    ReminderRoutinePlan = { dayOne: 'YYYY-MM-DD', morning: PlanEntry[], evening: PlanEntry[] }, null while the routine in force is not Started
//                    PlanEntry = { step, title, frequency }    `title` is the routine view's title, already past the wording gate (the routines module owns that; this service does not gate or rewrite it)
//     notifications  Pick<NotificationsService, 'hasPhone' | 'routineReminder'>   (see notifications.routine-reminder.test.ts)
//                      hasPhone(profileId): Promise<boolean>   whether the profile has a registered phone: read BEFORE claiming, so a window with no phone claims nothing
//                      routineReminder({ profileId, day, time, title }): Promise<void>   enqueues the send-push job; a failed enqueue is logged and swallowed
//   sendDue(now: Date): Promise<number>        the number of reminders enqueued (a reminder is one profile and one time, however many phones it will reach); never throws for one profile's failure
//
// The window: a time 'HH:MM' is due when the profile's LOCAL time (its stored zone, UTC while none) is in [HH:MM, HH:MM + 15 minutes), measured in real time from the moment the
// time is reached. Both ends are pinned. A wall-clock time that does not exist on the day the clocks go forward is due at the first valid instant after it; one that happens twice on the day
// they go back is due once.
//
// The queued job: { job: 'send-push', body: { kind: 'routine-reminder', profileId, day, time, title } }, no delay. `title` is the entry titles joined with ', '. `day` ('YYYY-MM-DD', the profile's
// local day) and `time` ('morning' | 'evening') are what the "Done" action posts to POST /me/routine/check-ins.
// The push deliver then sends, one per phone of the profile:
//   { to, title, body: <fixed copy>, categoryId: 'routine-reminder', data: { kind: 'routine-reminder', url: '/routine', profileId, day, time } }     `data` holds nothing else.
// Sends are claimed in the sends table first, per (profile, local day, kind) with kind 'morning' | 'evening'. No phone means no claim, so a phone that registers in the same window still gets the push.
// Nothing is sent before day 1; an evening with nothing due is not sent; every delivered title and body passes FORBIDDEN_WORDING.
//
// PR 4c CHANGES TO THE CONTRACT ABOVE (assumed: the brief fixes the kinds, the claim kinds, the switches and "a narrow plan read owned by routines"; the names are these):
//   settings       Pick<RemindersRepository, 'listEnabled'>    UNCHANGED from 4b: the rows with `enabled` on. Every kind needs `enabled` (story 30: nothing reaches a person who never turned
//                                                              reminders on), and then its own switch: the daily push `enabled`, the alert `enabled && stepDownAlerts`, the nudge `enabled && missedDaysNudge`.
//   routine        reminderPlanFor(profileId) answers { dayOne, morning, evening, stepDownChanges }, stepDownChanges = { day, title, line }[] (routines.viewer.service.test.ts): the first day of each
//                  step of each dated step-down's schedule, with the product's routine title and the step's fixed line.
//                  (`stepDownChanges` is OPTIONAL in the type until this PR (4c2), so the 4c1 plan change leaves the 4b fixture valid; the fixture below always supplies it.)
//   checkIns       { missedStreak(profileId, today): Promise<{ days: number; since: string | null }> }     RoutineCheckInsService answers it (reminders may not import routines, so it is a narrow type). `today`
//                  is the profile's LOCAL day at the instant the job runs.
//   channel        { missedDaysChannelFor(profileId): Promise<'push' | 'whatsapp'> }     RemindersService answers it, by the same rule as the view's missedDaysChannel
//   notifications  Pick<NotificationsService, 'hasPhone' | 'routineReminder' | 'stepDownAlert' | 'missedDaysNudge'>     (notifications.reminder-alerts.test.ts)
//                    stepDownAlert({ profileId, day, changes: { title, line }[] }): Promise<boolean>        missedDaysNudge({ profileId, since }): Promise<boolean>
// The step-down alert: at the MORNING time (the same quarter-hour window as the daily morning push, and not at the evening time), on a local day on which at least one `stepDownChanges` entry has
//   `day` equal to that day; one alert lists all of that day's changes, in the plan's order. Claimed as kind 'step-down' for (profile, local day). Needs `enabled`, `stepDownAlerts` and a Started routine.
// The missed-days nudge: at the MORNING time, when missedStreak(profile, local today).days >= 2 (so also on a third morning that is the first the job sees it), and the channel is 'push'. Claimed as
//   kind `nudge:${since}`; the claim's local day is the run's first day, `since`, NOT the day of the send, so the claim is held for the whole run and the nudge goes once per run (a claim keyed by
//   today would send again every morning of the run). Needs `enabled` and `missedDaysNudge`. The 'whatsapp' channel is a no-op: it is logged by profile id (no token, text or zone), claims nothing and
//   queues nothing, so the nudge goes out by push or WhatsApp once the channel changes.
// All three pushes (daily, alert, nudge) are separate jobs with separate claims; the order per profile stays phone, plan, claim, push. `sendDue` counts every push queued, whatever its kind.
// The job is given `new Date(controller.scheduledTime)` (test/integration/scheduled.test.ts), the quarter-hour slot, not the moment the Worker started.

// The one clock every test hangs off. Midnight UTC of the test day; instants are offsets from it.
const MIDNIGHT = Date.UTC(2030, 5, 15)
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** A UTC instant on the test day (the 15th of June 2030). */
const utc = (hour: number, minute = 0, second = 0, ms = 0) => new Date(MIDNIGHT + hour * HOUR + minute * MINUTE + second * 1000 + ms)
/** The calendar day `n` days from the test day, as 'YYYY-MM-DD'. */
const day = (n: number) => new Date(MIDNIGHT + n * DAY).toISOString().slice(0, 10)
const TODAY = day(0)
/** Day 1 for the tests on the days the clocks change and in winter, which are months from the test day. */
const LONG_AGO = day(-200)

// Days the clocks change in Europe/London (the last Sunday of March and of October) and a winter day. These are the rules of the zone, not dates that rot.
const SPRING_FORWARD = '2030-03-31' // 01:00 UTC: the clocks go from 01:00 to 02:00, so local 01:00 to 01:59 does not exist
const FALL_BACK = '2030-10-27' // 01:00 UTC: the clocks go from 02:00 back to 01:00, so local 01:00 to 01:59 happens twice
const WINTER = '2030-01-15'

const LAGOS = 'Africa/Lagos' // UTC+1 all year
const NEW_YORK = 'America/New_York' // UTC-4 in June
const LONDON = 'Europe/London' // UTC+1 (BST) in June, UTC+0 in winter

const DEVICE_KEY = 'device-key-a'
const tokenOf = (id: string) => `ExponentPushToken[${id}]`
const AMARA_TOKEN = tokenOf('amaraamaraamaraamara')
const AMARA_SECOND_PHONE = tokenOf('amarasecondphonesecond')
const AMARA_OTHER_PROFILE_TOKEN = tokenOf('amaraotherprofileprofile')
const TOLU_TOKEN = tokenOf('tolutolutolutolutolu')
const NGOZI_TOKEN = tokenOf('ngozingozingozingozi')

const actor = (userId: string, profileId: string): Actor => ({ kind: 'user', userId, status: 'verified', profileId })
const AMARA = actor('user-amara', 'profile-amara-1')
const AMARA_OTHER_PROFILE = actor('user-amara', 'profile-amara-2')
const TOLU = actor('user-tolu', 'profile-tolu-1')
const NGOZI = actor('user-ngozi', 'profile-ngozi-1')

// `anchor` (spec #233, PR 4a) is the day a bringing-back entry's count starts ('YYYY-MM-DD'); an entry without one counts from the plan's day 1.
type PlanEntry = { step: RoutineStep; title: string; frequency: Frequency; anchor?: string }
type StepDownChange = { day: string; title: string; line: string }
type Plan = { dayOne: string; morning: PlanEntry[]; evening: PlanEntry[]; stepDownChanges: StepDownChange[] }
type Streak = { days: number; since: string | null }
const entry = (step: RoutineStep, title: string, frequency: Frequency, anchor?: string): PlanEntry => ({ step, title, frequency, ...(anchor === undefined ? {} : { anchor }) })

const CLEANSER = entry('cleanse', 'Cleanser', 'am')
const MOISTURISER = entry('moisturise', 'Moisturiser', 'am-pm')
const SUNSCREEN = entry('protect', 'Sunscreen', 'am')
/** Day 1 ten days ago, the usual morning, and an evening of two daily entries. */
const plan = (over: Partial<Plan> = {}): Plan => ({
  dayOne: day(-10),
  morning: [CLEANSER, MOISTURISER, SUNSCREEN],
  evening: [entry('cleanse', 'Cleanser', 'pm'), MOISTURISER],
  stepDownChanges: [],
  ...over,
})

// The fixed lines the routine owns for a step (routines.viewer.service.test.ts pins them) and the titles of two step-downs.
const EVERY_OTHER_DAY = 'From today: use it every other day'
const ONCE_A_WEEK = 'From today: use it once a week'
const STOP = 'From today: stop using it'
const change = (dayOffset: number, title: string, line: string): StepDownChange => ({ day: day(dayOffset), title, line })

let settings: FakeRemindersRepository
let sends: FakeReminderSendsRepository
let pushTokens: FakePushTokensRepository
let notificationSettings: FakeNotificationSettingsRepository
let push: MemoryPushSender
let jobs: MemoryJobQueue
let notifications: NotificationsService
let plans: Map<string, Plan>
/** What the missed-days read answers (PR 4c): nothing missed, until a test uses the real service or sets this. */
let missedStreak: (profileId: string, today: string) => Promise<Streak>
/** The channel the nudge goes by, per profile; push until a test says otherwise. */
let channels: Map<string, 'push' | 'whatsapp'>
/** A profile whose routine cannot be read (the read throws). */
let routineFailsFor: string | null
let reminders: RemindersService
let service: ReminderSendsService
/** How many of `jobs.enqueued` have been delivered already. */
let delivered: number

beforeEach(() => {
  settings = new FakeRemindersRepository()
  sends = new FakeReminderSendsRepository()
  pushTokens = new FakePushTokensRepository()
  notificationSettings = new FakeNotificationSettingsRepository()
  push = new MemoryPushSender()
  jobs = new MemoryJobQueue()
  delivered = 0
  // deliver reads whether reminders are on from the real RemindersService over the same settings the job reads.
  reminders = new RemindersService({
    repository: settings,
    users: { get: async () => { throw new Error('not read') } } as unknown as Pick<UsersService, 'get'>,
    profiles: { find: async () => null } as unknown as Pick<ProfilesService, 'find'>,
    whatsappEnabled: false,
    inbox: { write: async () => ({ id: 'unused', created: true }) },
  })
  notifications = new NotificationsService({ pushTokens, settings: notificationSettings, push, jobs, reminders, deviceIdKey: DEVICE_KEY, now: () => utc(0) })
  plans = new Map()
  missedStreak = async () => ({ days: 0, since: null })
  channels = new Map()
  routineFailsFor = null
  service = new ReminderSendsService({
    settings,
    sends,
    checkIns: { missedStreak: (profileId: string, today: string) => missedStreak(profileId, today) },
    channel: { missedDaysChannelFor: async (profileId: string) => channels.get(profileId) ?? 'push' },
    routine: {
      reminderPlanFor: async (profileId: string) => {
        if (profileId === routineFailsFor) throw new Error('the routine could not be read')
        return plans.get(profileId) ?? null
      },
    },
    notifications,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  // Whatever a test sent, none of it may say what the wording gate forbids.
  for (const message of push.sent) {
    for (const { code, pattern } of FORBIDDEN_WORDING) {
      expect(pattern.test(message.title), `title "${message.title}" trips ${code}`).toBe(false)
      expect(pattern.test(message.body), `body "${message.body}" trips ${code}`).toBe(false)
    }
  }
})

const profileOf = (who: Actor) => (who.kind === 'user' ? who.profileId : '')
/** The profile's reminder settings, saved the way the settings route saves them: reminders on unless the patch says otherwise. */
const remind = (who: Actor, patch: Parameters<FakeRemindersRepository['upsert']>[1] = {}) => settings.upsert(profileOf(who), { enabled: true, ...patch }, utc(0))
/** The phone registers its token the way the app does, as the signed-in profile. */
const phone = (who: Actor, token: string, deviceId = `device-${token}`) => runAs(who, () => notifications.register({ deviceId, platform: 'ios', token }))
const startedRoutine = (who: Actor, over: Partial<Plan> = {}) => plans.set(profileOf(who), plan(over))

/** Amara in Lagos: reminders on at the given times, a phone, and a started routine. */
const amara = async (patch: Parameters<FakeRemindersRepository['upsert']>[1] = {}, over: Partial<Plan> = {}) => {
  await remind(AMARA, { timeZone: LAGOS, ...patch })
  await phone(AMARA, AMARA_TOKEN)
  startedRoutine(AMARA, over)
}

/** The send-push jobs the queue holds that have not been delivered, run through the real `deliver` as the dispatcher would (a system actor), oldest first. */
const drain = async () => {
  const pending = jobs.enqueued.slice(delivered)
  delivered = jobs.enqueued.length
  for (const { job, body } of pending) if (job === 'send-push') await runAs({ kind: 'system', job: 'send-push' }, () => notifications.deliver(sendPushSpec.schema.parse(body) as PushNotificationMessage))
}
/** One run of the job, and then the queue it filled delivered. Returns how many reminders the run enqueued. */
const sendDue = async (now: Date) => {
  const count = await service.sendDue(now)
  await drain()
  return count
}
/** The cron: every 15 minutes on the quarter hour, from `from` to `to` inclusive (ISO instants). Returns how many reminders went out. */
const everyQuarterHour = async (from: string, to: string) => {
  let sent = 0
  for (let at = Date.parse(from); at <= Date.parse(to); at += 15 * MINUTE) sent += await sendDue(new Date(at))
  return sent
}
const titles = () => push.sent.map((message) => message.title)

describe('ReminderSendsService.sendDue: the 15-minute window in the profile\'s own zone', () => {
  // Morning is 07:00 local. Lagos is UTC+1, New York UTC-4 and London UTC+1 in June, so the window opens at 06:00, 11:00, 06:00 and (no zone: UTC) 07:00 UTC.
  const OPENS: [string, string | null, number][] = [
    ['Lagos', LAGOS, 6],
    ['New York', NEW_YORK, 11],
    ['London in summer', LONDON, 6],
    ['no stored zone, which is UTC', null, 7],
  ]
  const EDGES = [
    { edge: '1 ms before the window opens', offsetMs: -1, expected: 0 },
    { edge: 'the instant it opens', offsetMs: 0, expected: 1 },
    { edge: '1 ms before it closes (14 minutes 59.999 seconds in)', offsetMs: 15 * MINUTE - 1, expected: 1 },
    { edge: 'the instant it closes (15 minutes in)', offsetMs: 15 * MINUTE, expected: 0 },
  ]

  describe.each(OPENS)('%s', (_name, zone, openHour) => {
    it.each(EDGES)('at $edge, sends $expected morning reminder(s)', async ({ offsetMs, expected }) => {
      await remind(AMARA, { morning: '07:00', timeZone: zone })
      await phone(AMARA, AMARA_TOKEN)
      startedRoutine(AMARA)

      const count = await sendDue(new Date(utc(openHour).getTime() + offsetMs))

      expect(count).toBe(expected)
      expect(push.sent).toHaveLength(expected)
    })
  })

  it('uses the time that is stored, not the default: 06:30 is due at 05:30 UTC in Lagos and 07:00 is not', async () => {
    await amara({ morning: '06:30' })

    expect(await sendDue(utc(6))).toBe(0)
    expect(await sendDue(utc(5, 30))).toBe(1)
  })

  it('sends each profile at its own local time in one run, and leaves the ones whose window it is not', async () => {
    await remind(AMARA, { timeZone: LAGOS })
    await remind(NGOZI, { timeZone: LONDON })
    await remind(TOLU, { timeZone: NEW_YORK })
    for (const [who, token] of [[AMARA, AMARA_TOKEN], [NGOZI, NGOZI_TOKEN], [TOLU, TOLU_TOKEN]] as const) {
      await phone(who, token)
      startedRoutine(who)
    }

    // 06:05 UTC is 07:05 in Lagos and London, and 02:05 in New York.
    expect(await sendDue(utc(6, 5))).toBe(2)
    expect(push.sent.map((message) => message.to).sort()).toEqual([AMARA_TOKEN, NGOZI_TOKEN].sort())

    // 11:05 UTC is 07:05 in New York.
    expect(await sendDue(utc(11, 5))).toBe(1)
    expect(push.sent.map((message) => message.to)).toContain(TOLU_TOKEN)
  })

  it('sends the evening reminder at the evening time: 21:00 in Lagos is 20:00 UTC', async () => {
    await amara({ evening: '21:00' })

    expect(await sendDue(utc(19, 59))).toBe(0)
    expect(await sendDue(utc(20))).toBe(1)
    expect(push.sent[0]!.data).toMatchObject({ time: 'evening' })
  })

  it('follows the clocks in Europe/London: 07:00 is 06:00 UTC in summer and 07:00 UTC in winter', async () => {
    await remind(NGOZI, { timeZone: LONDON, morning: '07:00' })
    await phone(NGOZI, NGOZI_TOKEN)
    startedRoutine(NGOZI, { dayOne: LONG_AGO })
    const winter = (hour: number) => new Date(Date.parse(`${WINTER}T00:00:00.000Z`) + hour * HOUR)

    expect(await sendDue(winter(6))).toBe(0)
    expect(await sendDue(winter(7))).toBe(1)
    expect(push.sent[0]!.data).toMatchObject({ day: WINTER })
  })
})

describe('ReminderSendsService.sendDue: the days the clocks change in Europe/London', () => {
  const setUpNgozi = async (morning: string) => {
    await remind(NGOZI, { timeZone: LONDON, morning })
    await phone(NGOZI, NGOZI_TOKEN)
    startedRoutine(NGOZI, { dayOne: LONG_AGO })
  }

  // On 31 March 2030 local time jumps from 01:00 to 02:00 (01:00 UTC). A time in the gap is sent at the first valid instant after it: 02:00 local, which is the 01:00 UTC run.
  // A time after the gap keeps its own UTC instant (02:15 local is 01:15 UTC).
  it.each([
    ['01:00 (the first minute that does not exist)', '01:00', '01:00'],
    ['01:30 (the middle of the gap)', '01:30', '01:00'],
    ['01:59 (the last minute that does not exist)', '01:59', '01:00'],
    ['02:00 (the first minute after the gap)', '02:00', '01:00'],
    ['02:15 (a quarter of an hour after the gap)', '02:15', '01:15'],
  ])('the spring day: a morning time of %s is sent once, at %s UTC and not before', async (_name, morning, firesAtUtc) => {
    await setUpNgozi(morning)
    const before = new Date(Date.parse(`${SPRING_FORWARD}T${firesAtUtc}:00.000Z`) - 15 * MINUTE)

    expect(await everyQuarterHour(`${SPRING_FORWARD}T00:00:00.000Z`, before.toISOString())).toBe(0)
    expect(await sendDue(new Date(`${SPRING_FORWARD}T${firesAtUtc}:00.000Z`))).toBe(1)
    expect(await everyQuarterHour(`${SPRING_FORWARD}T${firesAtUtc}:00.000Z`, `${SPRING_FORWARD}T06:00:00.000Z`)).toBe(0)
    expect(push.sent).toHaveLength(1)
    expect(push.sent[0]!.data).toMatchObject({ day: SPRING_FORWARD, time: 'morning' })
  })

  // The window is 15 minutes of real time from the moment the time is reached, so one that opens just before the jump still reaches the 01:00 UTC run (02:00 local),
  // and a person whose time is 00:50 is not skipped.
  it('the spring day: a time just before the gap whose window spans the jump (00:50) is sent at the 01:00 UTC run, not dropped', async () => {
    await setUpNgozi('00:50')

    expect(await sendDue(new Date(`${SPRING_FORWARD}T00:45:00.000Z`))).toBe(0)
    expect(await sendDue(new Date(`${SPRING_FORWARD}T01:00:00.000Z`))).toBe(1)
  })

  // On 27 October 2030 local time goes back from 02:00 to 01:00 (01:00 UTC), so 01:00 to 01:59 happens twice, an hour apart.
  it.each(['00:30', '01:00', '01:30', '01:45', '02:00', '02:30'])('the autumn day: a morning time of %s is sent exactly once across the whole night\'s runs', async (morning) => {
    await setUpNgozi(morning)

    const count = await everyQuarterHour('2030-10-26T22:00:00.000Z', `${FALL_BACK}T06:00:00.000Z`)

    expect(count).toBe(1)
    expect(push.sent).toHaveLength(1)
    expect(push.sent[0]!.data).toMatchObject({ day: FALL_BACK })
  })

  it('the autumn day: the second 01:30 is not a second reminder, even when the evening setting is the same time', async () => {
    await remind(NGOZI, { timeZone: LONDON, morning: '01:30', evening: '01:30' })
    await phone(NGOZI, NGOZI_TOKEN)
    startedRoutine(NGOZI, { dayOne: LONG_AGO })

    const count = await everyQuarterHour('2030-10-26T22:00:00.000Z', `${FALL_BACK}T06:00:00.000Z`)

    // One morning and one evening: two reminders, not four.
    expect(count).toBe(2)
    expect(push.sent.map((message) => (message.data as { time: string }).time).sort()).toEqual(['evening', 'morning'])
  })
})

describe('ReminderSendsService.sendDue: the morning push', () => {
  it('lists that morning\'s entry titles in the title, in routine order', async () => {
    await amara()

    await sendDue(utc(6))

    expect(titles()).toEqual(['Cleanser, Moisturiser, Sunscreen'])
    expect(push.sent[0]!.to).toBe(AMARA_TOKEN)
    expect(push.sent[0]!.body.length).toBeGreaterThan(0)
  })

  it('enqueues one send-push job for the reminder, carrying the title, the profile\'s local day and the time, and sends no push until the job runs', async () => {
    await amara()

    expect(await service.sendDue(utc(6))).toBe(1)

    expect(jobs.enqueued).toEqual([
      { job: 'send-push', body: { kind: 'routine-reminder', profileId: 'profile-amara-1', day: TODAY, time: 'morning', title: 'Cleanser, Moisturiser, Sunscreen' } },
    ])
    expect(push.sent).toEqual([])
  })

  it('enqueues one job for a profile with two phones, not one per phone', async () => {
    await amara()
    await phone(AMARA, AMARA_SECOND_PHONE)

    await service.sendDue(utc(6))

    expect(jobs.enqueued).toHaveLength(1)
  })

  it('delivers the "Done" action and what it posts: the category, the local day and the time, with a deep link to the routine and nothing else', async () => {
    await amara()

    await sendDue(utc(6))

    expect(push.sent).toEqual([
      {
        to: AMARA_TOKEN,
        title: 'Cleanser, Moisturiser, Sunscreen',
        body: expect.stringMatching(/\S/),
        categoryId: 'routine-reminder',
        data: { kind: 'routine-reminder', url: '/routine', profileId: 'profile-amara-1', day: TODAY, time: 'morning' },
      },
    ])
  })

  it('names the profile\'s LOCAL day in the payload, not the UTC day: 00:30 in Lagos on the 16th is still the 15th in UTC', async () => {
    await amara({ morning: '00:30' }, { dayOne: day(0) })

    await sendDue(utc(23, 30))

    expect(push.sent[0]!.data).toMatchObject({ day: day(1), time: 'morning' })
  })

  it('lists every morning entry every day, whatever the evening does', async () => {
    await amara({}, { evening: [entry('treat', 'Treatment', 'alternate-days')] })

    for (const n of [0, 1, 2, 3]) {
      await sendDue(new Date(utc(6).getTime() + n * DAY))
    }

    expect(titles()).toEqual(Array(4).fill('Cleanser, Moisturiser, Sunscreen'))
  })

  it('sends nothing when the morning has no entries', async () => {
    await amara({}, { morning: [] })

    expect(await sendDue(utc(6))).toBe(0)
    expect(push.sent).toEqual([])
  })
})

describe('ReminderSendsService.sendDue: the evening push', () => {
  const EVENING = utc(20) // 21:00 in Lagos
  const withEvening = (evening: PlanEntry[], daysSinceDayOne: number) => ({ dayOne: day(-daysSinceDayOne), evening })
  const DAILY = entry('cleanse', 'Cleanser', 'pm')
  const ALTERNATE = entry('treat', 'Treatment', 'alternate-days')
  const WEEKLY = entry('treat', 'Treatment', 'weekly')
  const AS_NEEDED = entry('moisturise', 'Moisturiser', 'as-needed')

  it('lists the evening\'s daily entries', async () => {
    await amara({}, withEvening([DAILY, entry('moisturise', 'Moisturiser', 'am-pm')], 3))

    await sendDue(EVENING)

    expect(titles()).toEqual(['Cleanser, Moisturiser'])
    expect(push.sent[0]!.data).toMatchObject({ day: TODAY, time: 'evening' })
  })

  // An alternate-days product is due every other local day counted from day 1: day 1 is due, day 2 is a rest day, day 3 is due.
  it.each([
    [0, true],
    [1, false],
    [2, true],
    [3, false],
    [4, true],
    [5, false],
    [6, true],
    [7, false],
  ])('an alternate-days entry on the day that is %i days after day 1 is listed: %s', async (daysSinceDayOne, listed) => {
    await amara({}, withEvening([DAILY, ALTERNATE], daysSinceDayOne))

    await sendDue(EVENING)

    expect(titles()).toEqual([listed ? 'Cleanser, Treatment' : 'Cleanser'])
  })

  it.each([
    [19, false],
    [20, true],
  ])('counts alternate days from a day 1 in an earlier month: %i days on is listed: %s', async (daysSinceDayOne, listed) => {
    await amara({}, withEvening([DAILY, ALTERNATE], daysSinceDayOne))

    await sendDue(EVENING)

    expect(titles()).toEqual([listed ? 'Cleanser, Treatment' : 'Cleanser'])
  })

  // A weekly entry is due on day 1's weekday: day 1, then 7, 14 and 21 days later.
  it.each([
    [0, true],
    [1, false],
    [3, false],
    [6, false],
    [7, true],
    [8, false],
    [13, false],
    [14, true],
    [21, true],
  ])('a weekly entry on the day that is %i days after day 1 is listed: %s', async (daysSinceDayOne, listed) => {
    await amara({}, withEvening([DAILY, WEEKLY], daysSinceDayOne))

    await sendDue(EVENING)

    expect(titles()).toEqual([listed ? 'Cleanser, Treatment' : 'Cleanser'])
  })

  it('never lists an as-needed entry', async () => {
    await amara({}, withEvening([DAILY, AS_NEEDED], 4))

    await sendDue(EVENING)

    expect(titles()).toEqual(['Cleanser'])
  })

  it('sends nothing when nothing is due that evening: a rest day with only the alternate-days entry, or only as-needed ones', async () => {
    await amara({}, withEvening([ALTERNATE], 1))
    expect(await sendDue(EVENING)).toBe(0)

    plans.set('profile-amara-1', plan(withEvening([AS_NEEDED], 0)))
    expect(await sendDue(EVENING)).toBe(0)

    expect(push.sent).toEqual([])
  })
})

describe('ReminderSendsService.sendDue: the evening push of an entry with an anchor day (an entry being brought back)', () => {
  const EVENING = utc(20) // 21:00 in Lagos, on TODAY
  const DAILY = entry('cleanse', 'Cleanser', 'pm')
  // Day 1 is ten days ago: counted from day 1, an alternate-days entry is due today (10 is even) and a weekly one is not (10 is not a multiple of 7). An anchor moves the count.
  const withAnchored = (anchored: PlanEntry, dayOne = day(-10)) => ({ dayOne, evening: [DAILY, anchored] })

  it.each([
    [-1, false],
    [-2, true],
    [-3, false],
    [-4, true],
    [0, true],
  ])('lists an alternate-days entry whose anchor is %i days from today: %s, counted from the anchor and not from day 1', async (anchorOffset, listed) => {
    await amara({}, withAnchored(entry('treat', 'Treatment', 'alternate-days', day(anchorOffset))))

    await sendDue(EVENING)

    expect(titles()).toEqual([listed ? 'Cleanser, Treatment' : 'Cleanser'])
  })

  it('counts from the anchor where day 1 would say the opposite: day 1 nine days ago makes today an off day, an anchor four days ago an on day', async () => {
    await amara({}, withAnchored(entry('treat', 'Treatment', 'alternate-days', day(-4)), day(-9)))

    await sendDue(EVENING)

    expect(titles()).toEqual(['Cleanser, Treatment'])
  })

  it.each([
    [-7, true],
    [-14, true],
    [-6, false],
    [-8, false],
    [0, true],
  ])('lists a weekly entry whose anchor is %i days from today: %s, whatever day 1 says', async (anchorOffset, listed) => {
    // Day 1 is chosen to say the opposite of the anchor every time: seven days ago is a weekly day, ten days ago is not.
    await amara({}, withAnchored(entry('treat', 'Treatment', 'weekly', day(anchorOffset)), listed ? day(-10) : day(-7)))

    await sendDue(EVENING)

    expect(titles()).toEqual([listed ? 'Cleanser, Treatment' : 'Cleanser'])
  })

  it('still counts an entry with no anchor from day 1, beside one that has one', async () => {
    await amara({}, { dayOne: day(-10), evening: [entry('treat', 'Treatment', 'alternate-days'), entry('moisturise', 'Moisturiser', 'alternate-days', day(-3))] })

    await sendDue(EVENING)

    expect(titles()).toEqual(['Treatment'])
  })

  it('lists a daily entry with an anchor every day, and never an as-needed one', async () => {
    await amara({}, { dayOne: day(-10), evening: [entry('cleanse', 'Cleanser', 'pm', day(-1)), entry('treat', 'Treatment', 'as-needed', day(-2))] })

    await sendDue(EVENING)

    expect(titles()).toEqual(['Cleanser'])
  })
})

describe('ReminderSendsService.sendDue: before day 1, and when reminders are off', () => {
  it('sends nothing while the routine has not been started (no plan)', async () => {
    await remind(AMARA, { timeZone: LAGOS })
    await phone(AMARA, AMARA_TOKEN)

    expect(await sendDue(utc(6))).toBe(0)
    expect(await sendDue(utc(20))).toBe(0)
    expect(push.sent).toEqual([])
  })

  it('sends nothing on the days before day 1, morning or evening, and sends on day 1 itself', async () => {
    await amara({}, { dayOne: day(1) })
    expect(await sendDue(utc(6))).toBe(0)
    expect(await sendDue(utc(20))).toBe(0)

    // The next day is day 1.
    expect(await sendDue(new Date(utc(6).getTime() + DAY))).toBe(1)
    expect(await sendDue(new Date(utc(20).getTime() + DAY))).toBe(1)
    expect(push.sent.map((message) => (message.data as { day: string }).day)).toEqual([day(1), day(1)])
  })

  it('decides "before day 1" on the profile\'s local day: 23:30 in Lagos on the 15th is not yet day 1 when day 1 is the 16th, and 00:30 on the 16th is', async () => {
    await amara({ evening: '23:30', morning: '00:30' }, { dayOne: day(1) })

    expect(await sendDue(utc(22, 30))).toBe(0)
    expect(await sendDue(utc(23, 30))).toBe(1)
    expect(push.sent[0]!.data).toMatchObject({ day: day(1), time: 'morning' })
  })

  it('sends nothing for a profile whose reminders are off, whatever its times and phone', async () => {
    await amara({ enabled: false })

    expect(await sendDue(utc(6))).toBe(0)
    expect(await sendDue(utc(20))).toBe(0)
    expect(push.sent).toEqual([])
  })

  it('sends nothing for a profile that never saved a setting', async () => {
    await phone(AMARA, AMARA_TOKEN)
    startedRoutine(AMARA)

    expect(await sendDue(utc(7))).toBe(0)
    expect(await sendDue(utc(21))).toBe(0)
  })

  it('does not depend on the account\'s scan notification switches: with both off, a reminder still goes', async () => {
    await amara()
    await notificationSettings.upsert('user-amara', { scanFinished: false, scanNeedsYou: false }, utc(0))

    expect(await sendDue(utc(6))).toBe(1)
    expect(push.sent).toHaveLength(1)
  })
})

describe('ReminderSendsService.sendDue: a reminder switched off after it was queued', () => {
  it('is dropped when the job runs, because deliver reads whether reminders are on at the time it sends', async () => {
    await amara()
    expect(await service.sendDue(utc(6))).toBe(1)
    await settings.upsert('profile-amara-1', { enabled: false }, utc(6, 5))

    await drain()

    expect(push.sent).toEqual([])
  })
})

describe('ReminderSendsService.sendDue: the phone', () => {
  it('sends nothing, and does not fail, when the profile has no phone: its settings are kept', async () => {
    await remind(TOLU, { timeZone: NEW_YORK })
    startedRoutine(TOLU)

    expect(await sendDue(utc(11))).toBe(0)
    expect(jobs.enqueued).toEqual([])
    expect(push.sent).toEqual([])
    expect(await settings.get('profile-tolu-1')).toMatchObject({ enabled: true, timeZone: NEW_YORK })
  })

  it('still sends in the same window once the phone registers, because a window with no phone claimed nothing', async () => {
    await remind(TOLU, { timeZone: NEW_YORK })
    startedRoutine(TOLU)
    expect(await sendDue(utc(11))).toBe(0)

    await phone(TOLU, TOLU_TOKEN)

    expect(await sendDue(utc(11, 10))).toBe(1)
    expect(push.sent.map((message) => message.to)).toEqual([TOLU_TOKEN])
  })

  it('sends to every phone of the profile', async () => {
    await amara()
    await phone(AMARA, AMARA_SECOND_PHONE)

    expect(await sendDue(utc(6))).toBe(1)

    expect(push.sent.map((message) => message.to).sort()).toEqual([AMARA_TOKEN, AMARA_SECOND_PHONE].sort())
    expect(new Set(titles()).size).toBe(1)
  })

  it('sends only to the phones of the profile that is due, not to the same account\'s other profile or anyone else\'s', async () => {
    await amara()
    await phone(AMARA_OTHER_PROFILE, AMARA_OTHER_PROFILE_TOKEN)
    await phone(NGOZI, NGOZI_TOKEN)

    await sendDue(utc(6))

    expect(push.sent.map((message) => message.to)).toEqual([AMARA_TOKEN])
  })

  it('does not send to a phone that signed out', async () => {
    await amara()
    await runAs(AMARA, () => notifications.unregister({ deviceId: `device-${AMARA_TOKEN}` }))

    expect(await sendDue(utc(6))).toBe(0)
    expect(push.sent).toEqual([])
  })
})

describe('ReminderSendsService.sendDue: sends are idempotent per profile, local day and time', () => {
  it('sends a reminder once however often the job runs in its window', async () => {
    await amara()

    expect(await sendDue(utc(6))).toBe(1)
    expect(await sendDue(utc(6))).toBe(0)
    expect(await sendDue(utc(6, 14, 59, 999))).toBe(0)

    expect(push.sent).toHaveLength(1)
  })

  it('sends once when two runs overlap', async () => {
    await amara()

    const counts = await Promise.all([sendDue(utc(6)), sendDue(utc(6)), sendDue(utc(6, 1))])

    expect(counts.reduce((total, count) => total + count, 0)).toBe(1)
    expect(push.sent).toHaveLength(1)
  })

  it('sends the same reminder again on the next local day', async () => {
    await amara()

    await sendDue(utc(6))
    await sendDue(new Date(utc(6).getTime() + DAY))

    expect(push.sent.map((message) => (message.data as { day: string }).day)).toEqual([TODAY, day(1)])
  })

  it('sends the morning and the evening of one day separately, and both when their times are the same', async () => {
    await amara({ morning: '07:00', evening: '07:00' })

    expect(await sendDue(utc(6))).toBe(2)

    expect(push.sent.map((message) => (message.data as { time: string }).time).sort()).toEqual(['evening', 'morning'])
  })
})

describe('ReminderSendsService.sendDue: failures and what is logged', () => {
  it('carries on with the other profiles when reading one profile\'s routine fails, and does not throw', async () => {
    await amara()
    await remind(NGOZI, { timeZone: LONDON })
    await phone(NGOZI, NGOZI_TOKEN)
    startedRoutine(NGOZI)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    routineFailsFor = 'profile-amara-1'

    // 06:00 UTC is 07:00 in Lagos and in London: both are due, and Amara's routine cannot be read.
    const count = await sendDue(utc(6))

    expect(count).toBe(1)
    expect(push.sent.map((message) => message.to)).toEqual([NGOZI_TOKEN])
  })

  it('carries on with the other profiles when queueing one reminder fails, and does not throw', async () => {
    await amara()
    await remind(NGOZI, { timeZone: LONDON })
    await phone(NGOZI, NGOZI_TOKEN)
    startedRoutine(NGOZI)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    jobs.failNextWith(new Error('the queue is down'))

    // Amara is first in the settings and her enqueue fails: she is not counted. Ngozi is.
    await expect(sendDue(utc(6))).resolves.toBe(1)

    expect(push.sent.map((message) => message.to)).toEqual([NGOZI_TOKEN])
    // The failed reminder's claim is held for the day (the documented trade-off), so a re-run in the window sends nothing for her.
    expect(await sendDue(utc(6, 5))).toBe(0)
    expect(push.sent.map((message) => message.to)).toEqual([NGOZI_TOKEN])
  })

  it('logs ids and outcomes only: never a token, a title, a body or a time zone', async () => {
    await amara()
    await remind(TOLU, { timeZone: NEW_YORK })
    startedRoutine(TOLU)
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    for (const log of logs) log.mockImplementation(() => undefined)

    // Amara is due and has a phone; Tolu is due (11:00 UTC) later and has none.
    await sendDue(utc(6))
    await sendDue(utc(11))

    const logged = JSON.stringify(logs.flatMap((log) => log.mock.calls))
    for (const secret of [AMARA_TOKEN, TOLU_TOKEN, 'Cleanser', 'Sunscreen', LAGOS, NEW_YORK]) expect(logged).not.toContain(secret)
  })
})

// --- the step-down alert (spec #217, PR 4c) ---

/** Lagos 07:00 (06:00 UTC) on the day `n` days from the test day: the morning window of the usual Amara. */
const morning = (n: number) => new Date(utc(6).getTime() + n * DAY)
/** The messages the run put on a phone, by kind. */
const sentOf = (kind: string) => push.sent.filter((message) => (message.data as { kind: string }).kind === kind)
/** The send-push jobs queued so far (delivery also queues receipt checks, which are not the job's business). */
const queued = () => jobs.enqueued.filter((entry) => entry.job === 'send-push')
const queuedKinds = () => queued().map((entry) => (entry.body as { kind: string }).kind)
const textOf = (message: { title: string; body: string }) => `${message.title}\n${message.body}`

describe('ReminderSendsService.sendDue: the step-down alert', () => {
  /** Amara with reminders ON, the alert switch on (the default) and NOTHING in her morning or evening, so the daily pushes have no entries and the alert is the only thing that can go. */
  const alertsOnly = (changes: StepDownChange[], over: Partial<Plan> = {}, patch: Parameters<FakeRemindersRepository['upsert']>[1] = {}) =>
    amara(patch, { morning: [], evening: [], stepDownChanges: changes, ...over })

  it('sends the alert on a day a step of a step-down begins: the product\'s title and the fixed line, a deep link to the schedule, and the profile and local day in the payload', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY)])

    expect(await sendDue(morning(0))).toBe(1)

    expect(queued()).toEqual([{ job: 'send-push', body: { kind: 'step-down-alert', profileId: 'profile-amara-1', day: TODAY, changes: [{ title: 'Cream', line: EVERY_OTHER_DAY }] } }])
    expect(push.sent).toEqual([
      {
        to: AMARA_TOKEN,
        title: expect.stringMatching(/\S/),
        body: expect.stringMatching(/\S/),
        data: { kind: 'step-down-alert', url: '/routine/step-down', profileId: 'profile-amara-1', day: TODAY },
      },
    ])
    expect(textOf(push.sent[0]!)).toContain('Cream')
    expect(textOf(push.sent[0]!)).toContain(EVERY_OTHER_DAY)
  })

  it('sends it on day 1 itself, the first day of week one: nothing is held back for the second week', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY), change(14, 'Cream', ONCE_A_WEEK)], { dayOne: day(0) })

    expect(await sendDue(morning(0))).toBe(1)

    expect(sentOf('step-down-alert')).toHaveLength(1)
    expect(textOf(push.sent[0]!)).toContain(EVERY_OTHER_DAY)
  })

  it('sends it on the change days only: not the days before, between or after, and each change day is its own alert', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY), change(3, 'Cream', ONCE_A_WEEK), change(6, 'Cream', STOP)], { dayOne: day(-1) })

    const sentOn = []
    for (let n = 0; n <= 8; n++) if ((await sendDue(morning(n))) === 1) sentOn.push(n)

    expect(sentOn).toEqual([0, 3, 6])
    expect(push.sent.map((message) => (message.data as { day: string }).day)).toEqual([day(0), day(3), day(6)])
    expect(textOf(push.sent[1]!)).toContain(ONCE_A_WEEK)
    expect(textOf(push.sent[2]!)).toContain(STOP)
  })

  it('sends nothing when no step of any step-down begins today, even with a step-down under way', async () => {
    await alertsOnly([change(-3, 'Cream', EVERY_OTHER_DAY), change(11, 'Cream', ONCE_A_WEEK)])

    expect(await sendDue(morning(0))).toBe(0)
    expect(queued()).toEqual([])
  })

  it('sends one alert listing both when two step-downs change on the same day, in the plan\'s order, and leaves out one that changes on another day', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY), change(0, 'Gel cleanser', STOP), change(1, 'Serum', ONCE_A_WEEK)])

    expect(await sendDue(morning(0))).toBe(1)

    expect(queued()).toHaveLength(1)
    expect((queued()[0]!.body as { changes: unknown }).changes).toEqual([
      { title: 'Cream', line: EVERY_OTHER_DAY },
      { title: 'Gel cleanser', line: STOP },
    ])
    expect(push.sent).toHaveLength(1)
    const text = textOf(push.sent[0]!)
    for (const part of ['Cream', EVERY_OTHER_DAY, 'Gel cleanser', STOP]) expect(text).toContain(part)
    expect(text).not.toContain('Serum')
    expect(text.indexOf(EVERY_OTHER_DAY)).toBeLessThan(text.indexOf(STOP))
  })

  describe.each([
    ['Lagos', LAGOS, 6],
    ['New York', NEW_YORK, 11],
    ['London in summer', LONDON, 6],
  ])('the morning window of %s', (_name, zone, openHour) => {
    it.each([
      { edge: '1 ms before the window opens', offsetMs: -1, expected: 0 },
      { edge: 'the instant it opens', offsetMs: 0, expected: 1 },
      { edge: '1 ms before it closes', offsetMs: 15 * MINUTE - 1, expected: 1 },
      { edge: 'the instant it closes', offsetMs: 15 * MINUTE, expected: 0 },
    ])('at $edge, sends $expected alert(s)', async ({ offsetMs, expected }) => {
      await remind(AMARA, { morning: '07:00', timeZone: zone })
      await phone(AMARA, AMARA_TOKEN)
      startedRoutine(AMARA, { morning: [], evening: [], stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })

      expect(await sendDue(new Date(utc(openHour).getTime() + offsetMs))).toBe(expected)
    })
  })

  it('does not send it at the evening time, only at the morning time', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY)])

    expect(await sendDue(utc(20))).toBe(0)
    expect(queued()).toEqual([])
  })

  // The change day is the profile's LOCAL day at its morning time. The instants below are one local morning each: the UTC date differs from the local date in all three zones.
  describe.each([
    // Lagos 00:30 on the 16th is 23:30 UTC on the 15th.
    ['Lagos, where the local day is ahead of UTC', LAGOS, '00:30', utc(23, 30), 1, 0],
    // New York 21:00 on the 15th is 01:00 UTC on the 16th.
    ['New York, where the local day is behind UTC', NEW_YORK, '21:00', utc(25), 0, 1],
    // London (BST, UTC+1) 00:30 on the 16th is 23:30 UTC on the 15th.
    ['London in summer', LONDON, '00:30', utc(23, 30), 1, 0],
  ])('the local day in %s', (_name, zone, morningTime, at, localOffset, utcOffset) => {
    it('sends the alert dated by the local day, and not one that is dated by the UTC day', async () => {
      await remind(AMARA, { morning: morningTime, timeZone: zone })
      await phone(AMARA, AMARA_TOKEN)
      startedRoutine(AMARA, { morning: [], evening: [], dayOne: day(-10), stepDownChanges: [change(utcOffset, 'Serum', STOP)] })
      expect(await sendDue(at)).toBe(0)

      startedRoutine(AMARA, { morning: [], evening: [], dayOne: day(-10), stepDownChanges: [change(localOffset, 'Cream', EVERY_OTHER_DAY)] })
      expect(await sendDue(at)).toBe(1)

      expect(push.sent[0]!.data).toMatchObject({ kind: 'step-down-alert', day: day(localOffset) })
      expect(textOf(push.sent[0]!)).toContain('Cream')
    })
  })

  it('sends nothing with reminders off, even with the alerts switch on, and claims nothing: turning reminders on in the same window sends it (story 30)', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY)], {}, { enabled: false, stepDownAlerts: true, missedDaysNudge: true })

    expect(await sendDue(morning(0))).toBe(0)
    expect(queued()).toEqual([])
    expect(push.sent).toEqual([])

    await settings.upsert('profile-amara-1', { enabled: true }, utc(6, 5))

    expect(await sendDue(utc(6, 6))).toBe(1)
    expect(queuedKinds()).toEqual(['step-down-alert'])
  })

  it('sends it beside the daily push with reminders on: two separate pushes', async () => {
    await amara({}, { stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })

    expect(await sendDue(morning(0))).toBe(2)

    expect(queuedKinds().sort()).toEqual(['routine-reminder', 'step-down-alert'])
    expect(sentOf('routine-reminder')[0]!.title).toBe('Cleanser, Moisturiser, Sunscreen')
    expect(textOf(sentOf('step-down-alert')[0]!)).toContain('Cream')
  })

  it('sends none when the alerts switch is off, with reminders on: the daily push still goes, the alert does not', async () => {
    await amara({ stepDownAlerts: false }, { stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })

    expect(await sendDue(morning(0))).toBe(1)

    expect(queuedKinds()).toEqual(['routine-reminder'])
    expect(sentOf('step-down-alert')).toEqual([])
  })

  it('sends it once the alerts switch is turned on again in the same window, because a switch that was off claimed nothing', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY)], {}, { stepDownAlerts: false })
    expect(await sendDue(morning(0))).toBe(0)

    await settings.upsert('profile-amara-1', { stepDownAlerts: true }, utc(6, 2))

    expect(await sendDue(utc(6, 3))).toBe(1)
  })

  it('sends none for a profile whose reminders are off and whose other two switches are off too', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY)], {}, { enabled: false, stepDownAlerts: false, missedDaysNudge: false })

    expect(await sendDue(morning(0))).toBe(0)
    expect(queued()).toEqual([])
  })

  it('sends none before the routine is Started (no plan), however the alert switch is set', async () => {
    await remind(AMARA, { timeZone: LAGOS })
    await phone(AMARA, AMARA_TOKEN)

    expect(await sendDue(morning(0))).toBe(0)
    expect(queued()).toEqual([])
  })

  it('sends none for a change dated before day 1, which the routine never makes but a plan may carry', async () => {
    await alertsOnly([change(-2, 'Cream', EVERY_OTHER_DAY)], { dayOne: day(1) })

    expect(await sendDue(new Date(utc(6).getTime() - 2 * DAY))).toBe(0)
  })

  it('sends only to the profile whose alerts are on and whose step changes: another profile with its alerts off, or no change, gets none', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY)])
    await remind(NGOZI, { timeZone: LONDON, stepDownAlerts: false })
    await phone(NGOZI, NGOZI_TOKEN)
    startedRoutine(NGOZI, { morning: [], evening: [], stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })
    await remind(TOLU, { timeZone: NEW_YORK, morning: '02:00' })
    await phone(TOLU, TOLU_TOKEN)
    startedRoutine(TOLU, { morning: [], evening: [], stepDownChanges: [change(5, 'Cream', EVERY_OTHER_DAY)] })

    // 06:00 UTC is 07:00 in Lagos and London and 02:00 in New York.
    expect(await sendDue(utc(6))).toBe(1)

    expect(push.sent.map((message) => message.to)).toEqual([AMARA_TOKEN])
  })

  it('sends it to every phone of the profile, once, and not to the account\'s other profile or anyone else', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY)])
    await phone(AMARA, AMARA_SECOND_PHONE)
    await phone(AMARA_OTHER_PROFILE, AMARA_OTHER_PROFILE_TOKEN)
    await phone(NGOZI, NGOZI_TOKEN)

    expect(await sendDue(morning(0))).toBe(1)

    expect(queued()).toHaveLength(1)
    expect(push.sent.map((message) => message.to).sort()).toEqual([AMARA_TOKEN, AMARA_SECOND_PHONE].sort())
  })

  it('is dropped at delivery when reminders go off after it was queued, even with the alerts switch still on', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY)])
    expect(await service.sendDue(morning(0))).toBe(1)
    await settings.upsert('profile-amara-1', { enabled: false }, utc(6, 5))

    await drain()

    expect(push.sent).toEqual([])
  })

  it('is dropped at delivery when the alerts switch goes off after it was queued', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY)])
    expect(await service.sendDue(morning(0))).toBe(1)
    await settings.upsert('profile-amara-1', { stepDownAlerts: false }, utc(6, 5))

    await drain()

    expect(push.sent).toEqual([])
  })

  it('sends the alert whatever the account\'s scan notification switches say', async () => {
    await alertsOnly([change(0, 'Cream', EVERY_OTHER_DAY)])
    await notificationSettings.upsert('user-amara', { scanFinished: false, scanNeedsYou: false }, utc(0))

    expect(await sendDue(morning(0))).toBe(1)
    expect(sentOf('step-down-alert')).toHaveLength(1)
  })
})

describe('ReminderSendsService.sendDue: the step-down alert is sent once per profile and local day', () => {
  const changeToday = [change(0, 'Cream', EVERY_OTHER_DAY)]

  it('sends once however often the job runs in the window', async () => {
    await amara({}, { morning: [], evening: [], stepDownChanges: changeToday })

    expect(await sendDue(morning(0))).toBe(1)
    expect(await sendDue(morning(0))).toBe(0)
    expect(await sendDue(utc(6, 14, 59, 999))).toBe(0)

    expect(push.sent).toHaveLength(1)
  })

  it('sends once when runs overlap', async () => {
    await amara({}, { morning: [], evening: [], stepDownChanges: changeToday })

    const counts = await Promise.all([sendDue(morning(0)), sendDue(morning(0)), sendDue(utc(6, 1))])

    expect(counts.reduce((total, count) => total + count, 0)).toBe(1)
    expect(push.sent).toHaveLength(1)
  })

  it('does not send again when the plan gains another change for the same day after the alert went (one alert per day)', async () => {
    await amara({}, { morning: [], evening: [], stepDownChanges: changeToday })
    await sendDue(morning(0))
    startedRoutine(AMARA, { morning: [], evening: [], stepDownChanges: [...changeToday, change(0, 'Gel cleanser', STOP)] })

    expect(await sendDue(utc(6, 5))).toBe(0)
  })

  it('claims nothing while the profile has no phone, so a phone that registers in the same window still gets it', async () => {
    await remind(AMARA, { timeZone: LAGOS })
    startedRoutine(AMARA, { morning: [], evening: [], stepDownChanges: changeToday })

    expect(await sendDue(morning(0))).toBe(0)
    expect(queued()).toEqual([])

    await phone(AMARA, AMARA_TOKEN)

    expect(await sendDue(utc(6, 10))).toBe(1)
    expect(push.sent.map((message) => message.to)).toEqual([AMARA_TOKEN])
  })

  it('keeps its claim when the enqueue fails (logged and swallowed, as for the daily push), so the day is not tried again', async () => {
    await amara({}, { morning: [], evening: [], stepDownChanges: changeToday })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    jobs.failNextWith(new Error('the queue is down'))

    expect(await sendDue(morning(0))).toBe(0)
    expect(await sendDue(utc(6, 5))).toBe(0)

    expect(push.sent).toEqual([])
  })
})

// --- the missed-days nudge (spec #217, PR 4c) ---

describe('ReminderSendsService.sendDue: the missed-days nudge', () => {
  let checkInsClock: Date
  let checkIns: RoutineCheckInsService

  /**
   * The streak is the REAL RoutineCheckInsService over its fake repository, so a run of missed days is reached the way life reaches one: the clock passes mornings, and a check-in made through
   * its own `checkIn` ends the run. Day 1 is read from the plan, as the routine's version gives it.
   */
  beforeEach(() => {
    checkInsClock = utc(12)
    checkIns = new RoutineCheckInsService({
      repository: new FakeRoutineCheckInsRepository(),
      versions: { current: async (profileId: string) => (plans.has(profileId) ? { startedOn: new Date(`${plans.get(profileId)!.dayOne}T00:00:00.000Z`) } : null) } as unknown as Pick<RoutinesRepository, 'current'>,
      reminders,
      inbox: { write: async () => ({ id: 'unused', created: true }) },
      routine: { reminderPlanFor: async () => null },
      now: () => checkInsClock,
    })
    missedStreak = (profileId, today) => checkIns.missedStreak(profileId, today)
  })

  /** Amara in Lagos from day 1 on the test day, reminders on, her nudge switch on by default, and empty morning and evening lists (so only the nudge can go). */
  const nudgeOnly = (patch: Parameters<FakeRemindersRepository['upsert']>[1] = {}, over: Partial<Plan> = {}) => amara(patch, { dayOne: day(0), morning: [], evening: [], ...over })
  /** Amara ticks her morning for the local day `n`, at midday there. */
  const checkInOn = async (n: number) => {
    checkInsClock = new Date(utc(11).getTime() + n * DAY)
    await runAs(AMARA, () => checkIns.checkIn(day(n), 'morning'))
  }
  const nudgesSent = () => sentOf('missed-days-nudge')

  it('sends nothing on the morning after one missed day, and the nudge on the morning after the second (the boundary: 1 and 2)', async () => {
    await nudgeOnly()

    // Day 1 is the test day. On the morning of day 2, one day (day 1) is missed; on day 3, two.
    expect(await sendDue(morning(0))).toBe(0)
    expect(await sendDue(morning(1))).toBe(0)
    expect(nudgesSent()).toEqual([])

    expect(await sendDue(morning(2))).toBe(1)
    expect(nudgesSent()).toHaveLength(1)
  })

  it('sends a push that opens the routine, with the profile in the payload and fixed copy, and queues the profile and the first day of the run', async () => {
    await nudgeOnly()

    await sendDue(morning(2))

    expect(queued()).toEqual([{ job: 'send-push', body: { kind: 'missed-days-nudge', profileId: 'profile-amara-1', since: day(0) } }])
    expect(push.sent).toEqual([
      {
        to: AMARA_TOKEN,
        title: expect.stringMatching(/\S/),
        body: expect.stringMatching(/\S/),
        data: { kind: 'missed-days-nudge', url: '/routine', profileId: 'profile-amara-1' },
      },
    ])
  })

  it('does not send it again on the third and fourth morning of the same run, and not on a re-run of the morning that sent it', async () => {
    await nudgeOnly()

    expect(await sendDue(morning(2))).toBe(1)
    expect(await sendDue(morning(2))).toBe(0)
    expect(await sendDue(morning(3))).toBe(0)
    expect(await sendDue(morning(4))).toBe(0)
    expect(await sendDue(morning(5))).toBe(0)

    expect(nudgesSent()).toHaveLength(1)
  })

  it('sends it on the first morning the job sees a run of three, because the run is two days or more (a cron slot skipped, a phone registered late)', async () => {
    await nudgeOnly()

    expect(await sendDue(morning(3))).toBe(1)
    expect(await sendDue(morning(4))).toBe(0)

    expect(queued()).toEqual([{ job: 'send-push', body: { kind: 'missed-days-nudge', profileId: 'profile-amara-1', since: day(0) } }])
  })

  it('sends a new nudge for a new run after a check-in, and not before that run reaches two days', async () => {
    await nudgeOnly()
    expect(await sendDue(morning(2))).toBe(1)
    expect(await sendDue(morning(3))).toBe(0)
    expect(await sendDue(morning(4))).toBe(0)

    // She ticks off day 5 (the fifth day from day 1 is day(4)), which ends the run: nothing is missed on the morning after, then one day is, then two.
    await checkInOn(4)
    expect(await sendDue(morning(5))).toBe(0)
    expect(await sendDue(morning(6))).toBe(0)
    expect(await sendDue(morning(7))).toBe(1)
    expect(await sendDue(morning(8))).toBe(0)

    expect(queued().map((entry) => (entry.body as { since: string }).since)).toEqual([day(0), day(5)])
    expect(nudgesSent()).toHaveLength(2)
  })

  it('sends none when the nudge switch is off, and queues nothing; a switch turned on again in the same window sends it, because an off switch claimed nothing', async () => {
    await nudgeOnly({ missedDaysNudge: false })
    expect(await sendDue(morning(2))).toBe(0)
    expect(queued()).toEqual([])

    await settings.upsert('profile-amara-1', { missedDaysNudge: true }, utc(6, 2))

    expect(await sendDue(new Date(morning(2).getTime() + 3 * MINUTE))).toBe(1)
  })

  it('sends beside the daily push with reminders on: two separate pushes', async () => {
    await amara({}, { dayOne: day(0) })

    expect(await sendDue(morning(2))).toBe(2)

    expect(queuedKinds().sort()).toEqual(['missed-days-nudge', 'routine-reminder'])
    expect(sentOf('routine-reminder')[0]!.title).toBe('Cleanser, Moisturiser, Sunscreen')
  })

  it('sends nothing with reminders off, even with the nudge switch on, and claims nothing: turning reminders on in the same window sends it (story 30)', async () => {
    await nudgeOnly({ enabled: false, missedDaysNudge: true, stepDownAlerts: true })

    expect(await sendDue(morning(2))).toBe(0)
    expect(queued()).toEqual([])

    await settings.upsert('profile-amara-1', { enabled: true }, utc(6, 2))

    expect(await sendDue(new Date(morning(2).getTime() + 3 * MINUTE))).toBe(1)
    expect(queuedKinds()).toEqual(['missed-days-nudge'])
  })

  it('does not send at the evening time, only at the morning time', async () => {
    await nudgeOnly()

    expect(await sendDue(new Date(utc(20).getTime() + 2 * DAY))).toBe(0)
    expect(queued()).toEqual([])
  })

  it('sends none before the routine is Started', async () => {
    await remind(AMARA, { timeZone: LAGOS })
    await phone(AMARA, AMARA_TOKEN)

    expect(await sendDue(morning(5))).toBe(0)
    expect(queued()).toEqual([])
  })

  it('counts the run by the profile\'s LOCAL day: 00:30 in Lagos on the third day is 23:30 UTC on the second, and the run is already two days', async () => {
    await nudgeOnly({ morning: '00:30' })

    // Lagos local day 2 (day 1 is day(0), missed; day(1) missed) at 00:30 is 23:30 UTC on day(1). A UTC date would count one missed day and send nothing.
    expect(await sendDue(new Date(utc(23, 30).getTime() + DAY))).toBe(1)
    expect(await sendDue(utc(23, 30))).toBe(0)
  })

  it('counts the run by the local day in New York too: 21:00 on the second day is 01:00 UTC on the third, and the run is still one day', async () => {
    await remind(AMARA, { morning: '21:00', timeZone: NEW_YORK })
    await phone(AMARA, AMARA_TOKEN)
    startedRoutine(AMARA, { morning: [], evening: [], dayOne: day(0) })

    // New York local day 1 at 21:00 is 01:00 UTC on day(2). A UTC date would count two missed days and send early.
    expect(await sendDue(new Date(utc(25).getTime() + DAY))).toBe(0)
    expect(await sendDue(new Date(utc(25).getTime() + 2 * DAY))).toBe(1)
  })

  it('sends once when runs overlap', async () => {
    await nudgeOnly()

    const counts = await Promise.all([sendDue(morning(2)), sendDue(morning(2)), sendDue(new Date(morning(2).getTime() + MINUTE))])

    expect(counts.reduce((total, count) => total + count, 0)).toBe(1)
    expect(nudgesSent()).toHaveLength(1)
  })

  it('claims nothing while the profile has no phone, so a phone that registers in the same window still gets it', async () => {
    await remind(AMARA, { timeZone: LAGOS })
    startedRoutine(AMARA, { morning: [], evening: [], dayOne: day(0) })
    expect(await sendDue(morning(2))).toBe(0)
    expect(queued()).toEqual([])

    await phone(AMARA, AMARA_TOKEN)

    expect(await sendDue(new Date(morning(2).getTime() + 10 * MINUTE))).toBe(1)
  })

  it('is dropped at delivery when reminders go off after it was queued, even with the nudge switch still on', async () => {
    await nudgeOnly()
    expect(await service.sendDue(morning(2))).toBe(1)
    await settings.upsert('profile-amara-1', { enabled: false }, utc(6, 5))

    await drain()

    expect(push.sent).toEqual([])
  })

  it('is dropped at delivery when the nudge switch goes off after it was queued', async () => {
    await nudgeOnly()
    expect(await service.sendDue(morning(2))).toBe(1)
    await settings.upsert('profile-amara-1', { missedDaysNudge: false }, utc(6, 5))

    await drain()

    expect(push.sent).toEqual([])
  })

  it('sends the nudge whatever the account\'s scan notification switches say', async () => {
    await nudgeOnly()
    await notificationSettings.upsert('user-amara', { scanFinished: false, scanNeedsYou: false }, utc(0))

    expect(await sendDue(morning(2))).toBe(1)
  })

  describe('by WhatsApp', () => {
    it('is a no-op while the channel is WhatsApp: nothing is queued or sent, and nothing is claimed', async () => {
      await nudgeOnly()
      channels.set('profile-amara-1', 'whatsapp')

      expect(await sendDue(morning(2))).toBe(0)
      expect(queued()).toEqual([])
      expect(push.sent).toEqual([])

      // Nothing was claimed, so the nudge still goes once the channel is push (or, later, once the WhatsApp send exists): the same run, the same window.
      channels.set('profile-amara-1', 'push')
      expect(await sendDue(new Date(morning(2).getTime() + 5 * MINUTE))).toBe(1)
    })

    it('logs the profile\'s id and the channel, and nothing about the person: no token, zone or text', async () => {
      await nudgeOnly()
      channels.set('profile-amara-1', 'whatsapp')
      const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
      for (const log of logs) log.mockImplementation(() => undefined)

      await sendDue(morning(2))

      const logged = JSON.stringify(logs.flatMap((log) => log.mock.calls))
      expect(logged).toContain('profile-amara-1')
      expect(logged).toContain('whatsapp')
      for (const secret of [AMARA_TOKEN, LAGOS, 'Cleanser']) expect(logged).not.toContain(secret)
    })

    it('still sends the daily push and the alert by push: only the nudge follows the channel', async () => {
      await amara({}, { dayOne: day(0), stepDownChanges: [change(2, 'Cream', EVERY_OTHER_DAY)] })
      channels.set('profile-amara-1', 'whatsapp')

      expect(await sendDue(morning(2))).toBe(2)

      expect(queuedKinds().sort()).toEqual(['routine-reminder', 'step-down-alert'])
    })
  })

  it('carries on with the other profiles when reading one profile\'s missed days fails, and does not throw', async () => {
    await nudgeOnly()
    await remind(NGOZI, { timeZone: LONDON })
    await phone(NGOZI, NGOZI_TOKEN)
    startedRoutine(NGOZI, { morning: [], evening: [], dayOne: day(0) })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const real = missedStreak
    missedStreak = async (profileId, today) => {
      if (profileId === 'profile-amara-1') throw new Error('the check-ins could not be read')
      return real(profileId, today)
    }

    // 06:00 UTC is 07:00 in Lagos and in London.
    const count = await sendDue(morning(2))

    expect(count).toBe(1)
    expect(push.sent.map((message) => message.to)).toEqual([NGOZI_TOKEN])
  })
})

// --- one morning, three pushes (spec #217, PR 4c) ---

describe('ReminderSendsService.sendDue: the daily push, the step-down alert and the nudge on one morning', () => {
  let checkIns: RoutineCheckInsService
  beforeEach(() => {
    checkIns = new RoutineCheckInsService({
      repository: new FakeRoutineCheckInsRepository(),
      versions: { current: async (profileId: string) => (plans.has(profileId) ? { startedOn: new Date(`${plans.get(profileId)!.dayOne}T00:00:00.000Z`) } : null) } as unknown as Pick<RoutinesRepository, 'current'>,
      reminders,
      inbox: { write: async () => ({ id: 'unused', created: true }) },
      routine: { reminderPlanFor: async () => null },
      now: () => utc(12),
    })
    missedStreak = (profileId, today) => checkIns.missedStreak(profileId, today)
  })

  /** Day 1 was two mornings ago and both days were missed; a step of a step-down begins today. */
  const allThree = () => amara({}, { dayOne: day(-2), stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })

  it('sends all three as separate pushes, and counts each', async () => {
    await allThree()

    expect(await sendDue(morning(0))).toBe(3)

    expect(queuedKinds().sort()).toEqual(['missed-days-nudge', 'routine-reminder', 'step-down-alert'])
    expect(push.sent.map((message) => (message.data as { kind: string }).kind).sort()).toEqual(['missed-days-nudge', 'routine-reminder', 'step-down-alert'])
  })

  it('sends at most one of each per local day: a re-run sends none, and the next day sends the daily push alone', async () => {
    await allThree()
    await sendDue(morning(0))

    expect(await sendDue(morning(0))).toBe(0)
    expect(await sendDue(utc(6, 5))).toBe(0)

    // Tomorrow: the daily push again; no step changes (it changed today), and the run is the same one, already nudged.
    expect(await sendDue(morning(1))).toBe(1)
    expect(sentOf('routine-reminder')).toHaveLength(2)
    expect(sentOf('step-down-alert')).toHaveLength(1)
    expect(sentOf('missed-days-nudge')).toHaveLength(1)
  })

  it('does not let one failed enqueue stop the others: each is its own claim and its own push', async () => {
    await allThree()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    jobs.failNextWith(new Error('the queue is down'))

    expect(await sendDue(morning(0))).toBe(2)
    expect(push.sent).toHaveLength(2)
  })

  it('sends each kind to the same phones, once per phone', async () => {
    await allThree()
    await phone(AMARA, AMARA_SECOND_PHONE)

    expect(await sendDue(morning(0))).toBe(3)

    expect(push.sent).toHaveLength(6)
    for (const kind of ['routine-reminder', 'step-down-alert', 'missed-days-nudge']) expect(sentOf(kind).map((message) => message.to).sort()).toEqual([AMARA_TOKEN, AMARA_SECOND_PHONE].sort())
  })

  it('logs ids and outcomes only: never a token, a product title, a line, a time zone', async () => {
    await allThree()
    await remind(TOLU, { timeZone: NEW_YORK })
    startedRoutine(TOLU, { morning: [], evening: [], stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    for (const log of logs) log.mockImplementation(() => undefined)

    // Amara is due and has a phone; Tolu is due (11:00 UTC) later and has none.
    await sendDue(morning(0))
    await sendDue(utc(11))

    const logged = JSON.stringify(logs.flatMap((log) => log.mock.calls))
    for (const secret of [AMARA_TOKEN, TOLU_TOKEN, 'Cream', 'From today', LAGOS, NEW_YORK]) expect(logged).not.toContain(secret)
  })
})

// --- missed days count only from the day reminders were turned on (spec #217, PR 4c; the owner's decision) ---

// A row's `enabledOn` (the local day `enabled` last went on; RemindersService stamps it, reminders.service.test.ts) clamps the run: since' = max(missedStreak.since, enabledOn), days' = days from since' to
// yesterday inclusive, nudged at 2 or more and claimed as `nudge:{since'}` on that day. The day reminders were turned on is itself the first day counted. A row with no `enabledOn` is not clamped.
describe('ReminderSendsService.sendDue: the nudge counts from the day reminders were turned on', () => {
  let clock: Date
  let checkIns: RoutineCheckInsService
  beforeEach(() => {
    clock = utc(12)
    checkIns = new RoutineCheckInsService({
      repository: new FakeRoutineCheckInsRepository(),
      versions: { current: async (profileId: string) => (plans.has(profileId) ? { startedOn: new Date(`${plans.get(profileId)!.dayOne}T00:00:00.000Z`) } : null) } as unknown as Pick<RoutinesRepository, 'current'>,
      reminders,
      inbox: { write: async () => ({ id: 'unused', created: true }) },
      routine: { reminderPlanFor: async () => null },
      now: () => clock,
    })
    missedStreak = (profileId, today) => checkIns.missedStreak(profileId, today)
  })

  /** Started ten days before the test day, nothing checked in, reminders turned on at the test day's start (so on day(0)) or whenever `enabledOn` says. Empty lists, so only the nudge can go. */
  const lateOptIn = (enabledOn: string | null = TODAY) => amara({ enabledOn }, { dayOne: day(-10), morning: [], evening: [] })
  const sinces = () => queued().map((entry) => (entry.body as { since: string }).since)

  it('sends no instant nudge to someone who started days ago and turns reminders on now: the first morning and the next are quiet, the second after is the nudge', async () => {
    await lateOptIn()

    // Ten days missed in all, but only the days since they asked count: on the morning of day(1) one (day(0)) is, on day(2) two.
    expect(await sendDue(morning(0))).toBe(0)
    expect(await sendDue(morning(1))).toBe(0)
    expect(queued()).toEqual([])

    expect(await sendDue(morning(2))).toBe(1)
    expect(queued()).toEqual([{ job: 'send-push', body: { kind: 'missed-days-nudge', profileId: 'profile-amara-1', since: TODAY } }])
  })

  it('claims on the clamped day, so the nudge is once for that run and not again on the mornings after', async () => {
    await lateOptIn()

    expect(await sendDue(morning(2))).toBe(1)
    expect(await sendDue(morning(3))).toBe(0)
    expect(await sendDue(morning(4))).toBe(0)

    expect(sinces()).toEqual([TODAY])
  })

  it('does not clamp a run that began after the day reminders were turned on: it is nudged as before, on its own first day', async () => {
    // Reminders on since day(-6) with the routine started on day(-10); a check-in for day(-3) ends the earlier run, so the run that follows begins on day(-2).
    await lateOptIn(day(-6))
    clock = new Date(utc(11).getTime() - 2 * DAY)
    await runAs(AMARA, () => checkIns.checkIn(day(-3), 'morning'))
    clock = utc(12)

    expect(await sendDue(morning(0))).toBe(1)
    expect(sinces()).toEqual([day(-2)])
  })

  it('counts a person who turns reminders off and on again from the new day: the days between are not counted', async () => {
    await lateOptIn(day(0))
    expect(await sendDue(morning(2))).toBe(1)

    // Off at day(3) and on again on day(5), as RemindersService stamps it.
    await settings.upsert('profile-amara-1', { enabled: false }, utc(6, 20, 0, 0))
    await settings.upsert('profile-amara-1', { enabled: true, enabledOn: day(5) }, new Date(morning(5).getTime() - 2 * HOUR))

    expect(await sendDue(morning(5))).toBe(0)
    expect(await sendDue(morning(6))).toBe(0)
    expect(await sendDue(morning(7))).toBe(1)
    expect(sinces()).toEqual([day(0), day(5)])
  })

  it('counts the day reminders were turned on as the first missed day: turned on the day before yesterday, two days are missed on the morning of the third', async () => {
    await lateOptIn(day(-2))

    expect(await sendDue(morning(-1))).toBe(0)
    expect(await sendDue(morning(0))).toBe(1)
    expect(sinces()).toEqual([day(-2)])
  })

  it('does not clamp a row that has no day (only one the service never turned on), so it is counted from the start as before', async () => {
    await lateOptIn(null)

    expect(await sendDue(morning(0))).toBe(1)
    expect(sinces()).toEqual([day(-10)])
  })

  it('leaves the daily push and the step-down alert alone: they do not look at the day reminders were turned on', async () => {
    await amara({ enabledOn: day(3) }, { dayOne: day(-10), stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })

    expect(await sendDue(morning(0))).toBe(2)
    expect(queuedKinds().sort()).toEqual(['routine-reminder', 'step-down-alert'])
  })
})

// The consumer of the cron's profile message (spec #233, PR 8a): one profile's share of sendDue, by the same code, for the slot the message carries.
describe('ReminderSendsService.sendForProfile', () => {
  const AMARA_ID = 'profile-amara-1'

  it('sends the profile what sendDue would at the slot', async () => {
    await amara()

    const count = await service.sendForProfile(AMARA_ID, utc(6))
    await drain()

    expect(count).toBe(1)
    expect(push.sent.map((message) => message.to)).toEqual([AMARA_TOKEN])
  })

  it('sends nothing for a profile with reminders off or with no settings row, and nothing for one with no time due', async () => {
    await amara({ enabled: false })
    expect(await service.sendForProfile(AMARA_ID, utc(6))).toBe(0)
    expect(await service.sendForProfile('profile-nobody', utc(6))).toBe(0)
    await remind(AMARA, { enabled: true, morning: '07:30', timeZone: LAGOS })
    expect(await service.sendForProfile(AMARA_ID, utc(6))).toBe(0)
    await drain()

    expect(push.sent).toEqual([])
  })

  it('sends a slot once: a second message for it claims and sends nothing', async () => {
    await amara()

    expect(await service.sendForProfile(AMARA_ID, utc(6))).toBe(1)
    expect(await service.sendForProfile(AMARA_ID, utc(6))).toBe(0)
    await drain()

    expect(push.sent).toHaveLength(1)
  })

  it('throws when the routine cannot be read, claiming nothing, so the retry sends the reminder', async () => {
    await amara()
    routineFailsFor = AMARA_ID

    await expect(service.sendForProfile(AMARA_ID, utc(6))).rejects.toThrow('the routine could not be read')
    routineFailsFor = null

    expect(await service.sendForProfile(AMARA_ID, utc(6))).toBe(1)
    await drain()
    expect(push.sent).toHaveLength(1)
  })

  it('sends nothing for a slot more than 30 minutes old, logging it and sending nothing: a skipped slot is not made up', async () => {
    await amara()
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(await service.sendForProfile(AMARA_ID, utc(6), new Date(utc(6).getTime() + 30 * MINUTE + 1))).toBe(0)
    await drain()

    expect(push.sent).toEqual([])
    expect(logged).toHaveBeenCalledWith({ job: 'reminder-send', outcome: 'stale-slot', profileId: AMARA_ID })
    // Nothing was claimed: the slot is still there for a message that is on time.
    expect(await service.sendForProfile(AMARA_ID, utc(6), utc(6, 5))).toBe(1)
  })

  it('still sends a slot that is exactly 30 minutes old', async () => {
    await amara()

    expect(await service.sendForProfile(AMARA_ID, utc(6), new Date(utc(6).getTime() + 30 * MINUTE))).toBe(1)
  })

  it('still sends a slot that is ahead of the clock', async () => {
    await amara()

    expect(await service.sendForProfile(AMARA_ID, utc(6), utc(5))).toBe(1)
  })

  it('skips a profile whose stored zone is not one, logging its id, and answers 0 without throwing', async () => {
    await amara({ timeZone: 'Not/AZone' })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(service.sendForProfile(AMARA_ID, utc(6))).resolves.toBe(0)

    expect(logged).toHaveBeenCalledWith({ job: 'reminder-send', outcome: 'profile-skipped', profileId: AMARA_ID })
  })

  it('does not hide another RangeError as a bad zone: an unreadable routine still throws', async () => {
    await amara()
    routineFailsFor = AMARA_ID

    await expect(service.sendForProfile(AMARA_ID, utc(6))).rejects.toThrow('the routine could not be read')
  })
})
