import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryPushSender } from '../../providers/push/memory.push'
import type { Frequency, RoutineStep } from '../catalog/catalog.vocabulary'
import { sendPushSpec } from '../notifications/notifications.job-specs'
import { FakeNotificationSettingsRepository } from '../notifications/notification-settings.repository.fake'
import { NotificationsService } from '../notifications/notifications.service'
import { FakePushTokensRepository } from '../notifications/push-tokens.repository.fake'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import type { UsersService } from '../users/users.service'
import { FakeRemindersRepository } from './reminders.repository.fake'
import { FakeReminderSendsRepository } from './reminders.sends.repository.fake'
import { ReminderSendsService } from './reminders.sends.service'
import { RemindersService } from './reminders.service'

// The 15-minute reminder send job (spec #217, PR 4b2): which profiles are due a reminder right now, and the push each one gets. Daily push only; the step-down alert and
// the missed-days nudge are PR 4c. The reminder goes down the same road as every other push: sendDue enqueues one `send-push` job per due reminder
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

type PlanEntry = { step: RoutineStep; title: string; frequency: Frequency }
type Plan = { dayOne: string; morning: PlanEntry[]; evening: PlanEntry[] }
const entry = (step: RoutineStep, title: string, frequency: Frequency): PlanEntry => ({ step, title, frequency })

const CLEANSER = entry('cleanse', 'Cleanser', 'am')
const MOISTURISER = entry('moisturise', 'Moisturiser', 'am-pm')
const SUNSCREEN = entry('protect', 'Sunscreen', 'am')
/** Day 1 ten days ago, the usual morning, and an evening of two daily entries. */
const plan = (over: Partial<Plan> = {}): Plan => ({
  dayOne: day(-10),
  morning: [CLEANSER, MOISTURISER, SUNSCREEN],
  evening: [entry('cleanse', 'Cleanser', 'pm'), MOISTURISER],
  ...over,
})

let settings: FakeRemindersRepository
let sends: FakeReminderSendsRepository
let pushTokens: FakePushTokensRepository
let notificationSettings: FakeNotificationSettingsRepository
let push: MemoryPushSender
let jobs: MemoryJobQueue
let notifications: NotificationsService
let plans: Map<string, Plan>
/** A profile whose routine cannot be read (the read throws). */
let routineFailsFor: string | null
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
  const reminders = new RemindersService({ repository: settings, users: { get: async () => { throw new Error('not read') } } as unknown as Pick<UsersService, 'get'>, whatsappEnabled: false })
  notifications = new NotificationsService({ pushTokens, settings: notificationSettings, push, jobs, reminders, deviceIdKey: DEVICE_KEY, now: () => utc(0) })
  plans = new Map()
  routineFailsFor = null
  service = new ReminderSendsService({
    settings,
    sends,
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
  for (const { job, body } of pending) if (job === 'send-push') await runAs({ kind: 'system', job: 'send-push' }, () => notifications.deliver(sendPushSpec.schema.parse(body)))
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
