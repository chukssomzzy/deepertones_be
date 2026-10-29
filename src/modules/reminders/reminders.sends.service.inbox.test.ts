import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryPushSender } from '../../providers/push/memory.push'
import type { Frequency, RoutineStep } from '../catalog/catalog.vocabulary'
import { FakeInboxRepository } from '../inbox/inbox.repository.fake'
import { InboxService, type InboxWrite } from '../inbox/inbox.service'
import { FakeNotificationSettingsRepository } from '../notifications/notification-settings.repository.fake'
import { type PushNotificationMessage, sendPushSpec } from '../notifications/notifications.job-specs'
import { NotificationsService } from '../notifications/notifications.service'
import { FakePushTokensRepository } from '../notifications/push-tokens.repository.fake'
import type { ProfilesService } from '../profiles/profiles.service'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import type { StepPause } from '../skin-care/skin-care.types'
import type { UsersService } from '../users/users.service'
import { FakeRemindersRepository } from './reminders.repository.fake'
import { FakeReminderSendsRepository } from './reminders.sends.repository.fake'
import { ReminderSendsService } from './reminders.sends.service'
import { RemindersService } from './reminders.service'

// The inbox rows of the 15-minute job and the pause check-in push (spec #233, PR 8b). The consumer of a profile message (`sendForProfile`) writes, for what is due in the slot, the inbox
// rows of EVERY started profile: reminders off, no phone and no settings row included (they are counted by the defaults, 07:00 and 21:00 in the stored zone, UTC with none). The
// pushes keep their gating, claims and words; a push that is the delivery of a row carries that row's id as `data.inboxId`. The new kind `pause-check-in` is the morning push for
// each check-in after a pause that is due.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the behaviour, not the constructor):
//   new ReminderSendsService({ settings, sends, routine, checkIns, channel, notifications,
//                              inbox,        Pick<InboxService, 'write'>: the writer of the rows; the test hands it a recorder around the real InboxService over its real fake
//                              skinCare })   { checkInsDue(profileId, today): Promise<StepPause[]> }: SkinCareService.checkInsDue's narrow type, which the reminders module owns
//   The rows (kind is the key's first word; `day` is the local day of the slot that wrote the row):
//     key reminder:<day>:morning|evening  kind reminder     title: the entry titles joined ', ' / body: 'Time for your morning routine' or '... evening routine' (the push's words, unchanged)
//     key step-down:<day>               kind step-down    title: 'A change in your routine today' / body: '<title>. <line>' for each change that begins that day, joined by a newline
//     key rest-night:<day>              kind rest-night   the evening slot of a day on which the evening lists entries but none is due (INTERPRETATION: a routine with no evening entry at all has no rest night)
//     key next-change:<day>             kind next-change  the evening slot of the day BEFORE a day on which a step-down step begins (INTERPRETATION: the brief names the key and the family, not the day it is written)
//     key check-in-due:<pauseId>:<checkDay>   kind check-in-due   the morning slot, for each due check-in after a pause
//   The reminder key names the time of day, not the clock time, so a time that changes (or reminders switched off) during the day cannot make a second row for that morning or evening.
//   Rows are written for a started profile from day 1 on, from a slot not older than the stale-slot guard allows, whether or not reminders are on, a phone is registered or the alert switches are on.
//   A push is queued only where it was before; when it is the delivery of a row its `data.inboxId` is that row's id. A failed row write is logged by ids only and stops nothing.
//   pause-check-in push: morning slot only, reminders on (the same enabled-and-phone rules as the daily push), one for each due check-in, claimed as kind `pause-check:<pauseId>:<checkDay>`.

const MIDNIGHT = Date.UTC(2030, 5, 15)
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** A UTC instant on the test day (the 15th of June 2030); `dayOffset` moves it whole days. */
const utc = (hour: number, minute = 0, dayOffset = 0) => new Date(MIDNIGHT + dayOffset * DAY + hour * HOUR + minute * MINUTE)
/** The calendar day `n` days from the test day, as 'YYYY-MM-DD'. */
const day = (n: number) => new Date(MIDNIGHT + n * DAY).toISOString().slice(0, 10)

const LAGOS = 'Africa/Lagos' // UTC+1 all year
const NEW_YORK = 'America/New_York' // UTC-4 in June

const DEVICE_KEY = 'device-key-a'
const AMARA_TOKEN = 'ExponentPushToken[amaraamaraamaraamara]'
const TOLU_TOKEN = 'ExponentPushToken[tolutolutolutolutolu]'
const actor = (userId: string, profileId: string): Actor => ({ kind: 'user', userId, status: 'verified', profileId })
const AMARA = actor('user-amara', 'profile-amara-1')
const TOLU = actor('user-tolu', 'profile-tolu-1')
const profileOf = (who: Actor) => (who.kind === 'user' ? who.profileId : '')

type PlanEntry = { step: RoutineStep; title: string; frequency: Frequency; anchor?: string }
type Plan = { dayOne: string; morning: PlanEntry[]; evening: PlanEntry[]; stepDownChanges: { day: string; title: string; line: string }[] }
const entry = (step: RoutineStep, title: string, frequency: Frequency, anchor?: string): PlanEntry => ({ step, title, frequency, ...(anchor === undefined ? {} : { anchor }) })
const MOISTURISER = entry('moisturise', 'Moisturiser', 'am-pm')
/** Day 1 ten days ago, a morning of three entries and an evening of two daily ones. */
const plan = (over: Partial<Plan> = {}): Plan => ({
  dayOne: day(-10),
  morning: [entry('cleanse', 'Cleanser', 'am'), MOISTURISER, entry('protect', 'Sunscreen', 'am')],
  evening: [entry('cleanse', 'Cleanser', 'pm'), MOISTURISER],
  stepDownChanges: [],
  ...over,
})
const EVERY_OTHER_DAY = 'From today: use it every other day'
const ONCE_A_WEEK = 'From today: use it once a week'
const change = (dayOffset: number, title: string, line: string) => ({ day: day(dayOffset), title, line })

const MORNING_WORDS = { title: 'Cleanser, Moisturiser, Sunscreen', body: 'Time for your morning routine' }
const EVENING_WORDS = { title: 'Cleanser, Moisturiser', body: 'Time for your evening routine' }
const STEP_DOWN_ALERT_TITLE = 'A change in your routine today'

let settings: FakeRemindersRepository
let sends: FakeReminderSendsRepository
let pushTokens: FakePushTokensRepository
let push: MemoryPushSender
let jobs: MemoryJobQueue
let notifications: NotificationsService
let inboxRepository: FakeInboxRepository
let inbox: InboxService
let plans: Map<string, Plan>
let delivered: number
/** The row writes the consumer attempted, as it made them: what the key and the words were. */
let attempted: InboxWrite[]
/** The ids the real inbox answered for each (profile, key), so a push's `inboxId` can be matched to the row it belongs to. */
let idsByKey: Map<string, string>
/** Every claim made, so a test can see what was claimed without reading the fake's insides. */
let claims: { profileId: string; localDay: string; kind: string }[]
let inboxFails: boolean
/** The check-ins after a pause that exist, per profile; the fake answers those whose check day has come, as SkinCareService.checkInsDue does. */
let pauses: Map<string, StepPause[]>
/** The halves of a day the profile has checked in, by `<profileId>|<day>` (RoutineCheckInsService.checkedTimes). */
let checked: Map<string, ('morning' | 'evening')[]>
let service: ReminderSendsService

const pauseRow = (profileId: string, id: string, checkDay: string, step: RoutineStep | null = 'treat'): StepPause => ({
  id,
  profileId,
  step,
  productKey: step === null ? '' : `prod-${id}`,
  productId: step === null ? null : `prod-${id}`,
  productRef: step === null ? { kind: 'none' } : { kind: 'shelf', id: `entry-${id}` },
  ingredientGroup: null,
  state: 'paused',
  pausedOn: day(-3),
  checkDay,
  sameCount: 0,
  sourceLogId: null,
  ladderCode: null,
  ladderStartedOn: null,
  versionId: null,
  createdAt: utc(0),
})

beforeEach(() => {
  settings = new FakeRemindersRepository()
  const fakeSends = new FakeReminderSendsRepository()
  claims = []
  sends = Object.assign(fakeSends, {
    claim: async (profileId: string, localDay: string, kind: string, at: Date) => {
      const held = await FakeReminderSendsRepository.prototype.claim.call(fakeSends, profileId, localDay, kind, at)
      if (held) claims.push({ profileId, localDay, kind })
      return held
    },
  }) as FakeReminderSendsRepository
  pushTokens = new FakePushTokensRepository()
  push = new MemoryPushSender()
  jobs = new MemoryJobQueue()
  delivered = 0
  let ids = 0
  inboxRepository = new FakeInboxRepository()
  inbox = new InboxService({ repository: inboxRepository, now: () => utc(0), newId: () => `inbox-${++ids}` })
  attempted = []
  idsByKey = new Map()
  inboxFails = false
  const reminders = new RemindersService({
    repository: settings,
    users: { get: async () => { throw new Error('not read') } } as unknown as Pick<UsersService, 'get'>,
    profiles: { find: async () => null } as unknown as Pick<ProfilesService, 'find'>,
    whatsappEnabled: false,
    inbox: { write: async () => ({ id: 'unused', created: true }) },
  })
  notifications = new NotificationsService({ pushTokens, settings: new FakeNotificationSettingsRepository(), push, jobs, reminders, deviceIdKey: DEVICE_KEY, now: () => utc(0) })
  plans = new Map()
  pauses = new Map()
  checked = new Map()
  service = new ReminderSendsService({
    settings,
    sends,
    checkIns: { missedStreak: async () => ({ days: 0, since: null }), checkedTimes: async (profileId: string, checkDay: string) => checked.get(`${profileId}|${checkDay}`) ?? [] },
    channel: { missedDaysChannelFor: async () => 'push' },
    routine: { reminderPlanFor: async (profileId: string) => plans.get(profileId) ?? null },
    notifications,
    inbox: {
      write: async (input: InboxWrite) => {
        attempted.push(input)
        if (inboxFails) throw new Error('the inbox is down for ExponentPushToken[abc] Cleanser')
        const written = await inbox.write(input)
        idsByKey.set(`${input.profileId}|${input.key}`, written.id)
        return written
      },
    },
    skinCare: { checkInsDue: async (profileId: string, today: string) => (pauses.get(profileId) ?? []).filter((pause) => pause.checkDay <= today) },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  // Whatever the consumer wrote or sent, none of it may say what the wording gate forbids.
  const texts = [...attempted.map(({ title, body }) => ({ title, body })), ...push.sent.map(({ title, body }) => ({ title, body }))]
  for (const { title, body } of texts) {
    for (const { code, pattern } of FORBIDDEN_WORDING) {
      expect(pattern.test(title), `title "${title}" trips ${code}`).toBe(false)
      expect(pattern.test(body), `body "${body}" trips ${code}`).toBe(false)
    }
  }
})

/** Reminder settings, saved the way the settings route saves them: reminders on unless the patch says otherwise. */
const remind = (who: Actor, patch: Parameters<FakeRemindersRepository['upsert']>[1] = {}) => settings.upsert(profileOf(who), { enabled: true, ...patch }, utc(0))
const phone = (who: Actor, token: string) => runAs(who, () => notifications.register({ deviceId: `device-${token}`, platform: 'ios', token }))
const startedRoutine = (who: Actor, over: Partial<Plan> = {}) => plans.set(profileOf(who), plan(over))

/** Amara in Lagos: reminders on, a phone and a started routine. */
const amara = async (patch: Parameters<FakeRemindersRepository['upsert']>[1] = {}, over: Partial<Plan> = {}) => {
  await remind(AMARA, { timeZone: LAGOS, ...patch })
  await phone(AMARA, AMARA_TOKEN)
  startedRoutine(AMARA, over)
}

const drain = async () => {
  const pending = jobs.enqueued.slice(delivered)
  delivered = jobs.enqueued.length
  for (const { job, body } of pending) if (job === 'send-push') await runAs({ kind: 'system', job: 'send-push' }, () => notifications.deliver(sendPushSpec.schema.parse(body) as PushNotificationMessage))
}
/** The consumer of one profile message for `slot`, run when the slot is on time, and then the queue it filled delivered. Answers how many pushes it queued. */
const consume = async (who: Actor, slot: Date, now: Date = slot) => {
  const queued = await service.sendForProfile(profileOf(who), slot, now)
  await drain()
  return queued
}

/** The rows the profile holds as the app reads them. Never relied on for order: rows made in one instant have none to depend on. */
const rowsOf = async (who: Actor) => (await runAs(who, () => inbox.list({ limit: 50 }))).items
const keysOf = (who: Actor) => attempted.filter(({ profileId }) => profileId === profileOf(who)).map(({ key }) => key).sort()
/** The id of the row written under the key; throws when none was, so an `inboxId` is never compared with a missing one. */
const idOf = (who: Actor, key: string): string => {
  const id = idsByKey.get(`${profileOf(who)}|${key}`)
  if (id === undefined) throw new Error(`no row was written under ${key}`)
  return id
}
const rowOf = async (who: Actor, key: string) => {
  const id = idOf(who, key)
  return (await rowsOf(who)).find((row) => row.id === id)!
}
const claimKinds = (who: Actor) => claims.filter(({ profileId }) => profileId === profileOf(who)).map(({ kind }) => kind)

describe('the inbox rows of a reminder, a step-down day, a rest night and the next change', () => {
  it('writes the morning reminder row with the words of the push: the entry titles, the fixed morning line and the routine link', async () => {
    await amara()

    await consume(AMARA, utc(6))

    expect(keysOf(AMARA)).toEqual([`reminder:${day(0)}:morning`])
    expect(await rowOf(AMARA, `reminder:${day(0)}:morning`)).toMatchObject({ kind: 'reminder', day: day(0), title: MORNING_WORDS.title, body: MORNING_WORDS.body, link: '/routine', read: false })
    expect(push.sent.map(({ title, body }) => ({ title, body }))).toEqual([MORNING_WORDS])
  })

  it('writes the evening reminder row with the entries due that evening and the fixed evening line', async () => {
    await amara({}, { evening: [entry('cleanse', 'Cleanser', 'pm'), MOISTURISER, entry('treat', 'Retinoid', 'weekly', day(-1))] })

    await consume(AMARA, utc(20))

    // The weekly step began yesterday, so today is not its day: it is left out of the row as it is out of the push.
    expect(keysOf(AMARA)).toEqual([`reminder:${day(0)}:evening`])
    expect(await rowOf(AMARA, `reminder:${day(0)}:evening`)).toMatchObject({ kind: 'reminder', day: day(0), title: EVENING_WORDS.title, body: EVENING_WORDS.body, link: '/routine' })
    expect(push.sent.map(({ title, body }) => ({ title, body }))).toEqual([EVENING_WORDS])
  })

  it('keys the reminder by the time of day and the local day in the profile\'s zone: 06:30 in New York, and 21:00 there which is already the next day in UTC', async () => {
    await remind(TOLU, { timeZone: NEW_YORK, morning: '06:30' })
    await phone(TOLU, TOLU_TOKEN)
    startedRoutine(TOLU)

    await consume(TOLU, utc(10, 30))
    expect(keysOf(TOLU)).toEqual([`reminder:${day(0)}:morning`])

    // 21:00 EDT on the 15th is 01:00 UTC on the 16th: the row is for the 15th.
    await consume(TOLU, utc(1, 0, 1))
    expect(keysOf(TOLU)).toEqual([`reminder:${day(0)}:evening`, `reminder:${day(0)}:morning`])
    expect((await rowOf(TOLU, `reminder:${day(0)}:evening`)).day).toBe(day(0))
  })

  it('keeps one morning row when the morning time changes the same day: the key names the time of day, not the clock time', async () => {
    await amara()
    await consume(AMARA, utc(6))

    // 07:30 in Lagos is 06:30 UTC.
    await remind(AMARA, { timeZone: LAGOS, morning: '07:30' })
    await consume(AMARA, utc(6, 30))

    expect([...new Set(keysOf(AMARA))]).toEqual([`reminder:${day(0)}:morning`])
    expect(await rowsOf(AMARA)).toHaveLength(1)
    expect(push.sent).toHaveLength(1)
  })

  it('writes one step-down row on the day a step begins, with the push\'s words: the fixed title, and each change as its product\'s title, then its line', async () => {
    await amara({}, { stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY), change(0, 'Toner', ONCE_A_WEEK)] })

    await consume(AMARA, utc(6))

    expect(keysOf(AMARA)).toEqual([`reminder:${day(0)}:morning`, `step-down:${day(0)}`])
    expect(await rowOf(AMARA, `step-down:${day(0)}`)).toMatchObject({
      kind: 'step-down',
      day: day(0),
      title: STEP_DOWN_ALERT_TITLE,
      body: `Cream. ${EVERY_OTHER_DAY}\nToner. ${ONCE_A_WEEK}`,
      link: '/routine/step-down',
    })
    const alert = push.sent.find((message) => message.title === STEP_DOWN_ALERT_TITLE)!
    expect(alert.body).toBe(`Cream. ${EVERY_OTHER_DAY}\nToner. ${ONCE_A_WEEK}`)
  })

  it.each([
    ['the day before the step begins', 1],
    ['the day after it began', -1],
  ])('writes no step-down row on %s', async (_name, offset) => {
    await amara({}, { stepDownChanges: [change(offset, 'Cream', EVERY_OTHER_DAY)] })

    await consume(AMARA, utc(6))

    expect(keysOf(AMARA)).toEqual([`reminder:${day(0)}:morning`])
  })

  it('writes no step-down row at the evening time, even on a day a step begins', async () => {
    await amara({}, { stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })

    await consume(AMARA, utc(20))

    expect(keysOf(AMARA)).toEqual([`reminder:${day(0)}:evening`])
  })

  it('writes a rest-night row, and no reminder and no push, on an evening on which the routine lists entries but none is due', async () => {
    // Day 1 was nine days ago, so today is an odd day of the count and an alternate-days entry rests.
    await amara({}, { dayOne: day(-9), evening: [entry('treat', 'Retinoid', 'alternate-days')] })

    await consume(AMARA, utc(20))

    expect(keysOf(AMARA)).toEqual([`rest-night:${day(0)}`])
    expect(await rowOf(AMARA, `rest-night:${day(0)}`)).toMatchObject({ kind: 'rest-night', day: day(0), read: false })
    expect(push.sent).toEqual([])
  })

  it('writes no rest-night row when an entry is due that evening (the reminder takes its place), the evening after, or at the morning time', async () => {
    await amara({}, { dayOne: day(-9), evening: [entry('treat', 'Retinoid', 'alternate-days')] })

    // Tomorrow is the 10th day of the count: the entry is due, so the evening is a reminder.
    await consume(AMARA, utc(20, 0, 1))
    expect(keysOf(AMARA)).toEqual([`reminder:${day(1)}:evening`])

    // The morning of a rest day is the morning's reminder, never a rest night.
    await consume(AMARA, utc(6))
    expect(keysOf(AMARA)).toEqual([`reminder:${day(0)}:morning`, `reminder:${day(1)}:evening`])
  })

  it('writes no rest-night row for a routine with no evening entry at all (INTERPRETATION: there is nothing to rest from)', async () => {
    await amara({}, { evening: [] })

    await consume(AMARA, utc(20))

    expect(keysOf(AMARA)).toEqual([])
    expect(push.sent).toEqual([])
  })

  it('writes the next-change row at the evening time of the day before a step begins, and on no other evening (INTERPRETATION of when)', async () => {
    await amara({}, { stepDownChanges: [change(1, 'Cream', EVERY_OTHER_DAY)] })

    await consume(AMARA, utc(20))
    expect(keysOf(AMARA)).toEqual([`next-change:${day(0)}`, `reminder:${day(0)}:evening`].sort())
    expect(await rowOf(AMARA, `next-change:${day(0)}`)).toMatchObject({ kind: 'next-change', day: day(0), read: false })
    expect((await rowOf(AMARA, `next-change:${day(0)}`)).link).toMatch(/^\/(?!\/)/)

    // Two days ahead is too early, the morning is not the time for it, and the evening of the day itself has its step-down row in the morning.
    await consume(AMARA, utc(20, 0, -1))
    await consume(AMARA, utc(6))
    await consume(AMARA, utc(20, 0, 1))
    expect(keysOf(AMARA).filter((key) => key.startsWith('next-change:'))).toEqual([`next-change:${day(0)}`])
  })

  it.each([
    ['the minute the time is reached', 6, 0, 1],
    ['the last minute of the window (14 minutes in)', 6, 14, 1],
    ['the instant the window has closed (15 minutes in)', 6, 15, 0],
    ['the minute before the time', 5, 59, 0],
  ])('writes the morning row %s only while the time is in the window: %s', async (_name, hour, minute, expected) => {
    await amara()

    await consume(AMARA, utc(hour, minute))

    expect(keysOf(AMARA)).toHaveLength(expected)
  })

  it('writes nothing before day 1, and writes on day 1 itself', async () => {
    await amara({}, { dayOne: day(1) })
    await consume(AMARA, utc(6))
    expect(keysOf(AMARA)).toEqual([])

    startedRoutine(AMARA, { dayOne: day(0) })
    await consume(AMARA, utc(6))
    expect(keysOf(AMARA)).toEqual([`reminder:${day(0)}:morning`])
  })

  it('writes the rows of a slot once: a message delivered again makes no second row and no second push', async () => {
    await amara({}, { stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })

    await consume(AMARA, utc(6))
    const first = (await rowsOf(AMARA)).map(({ id }) => id).sort()
    await consume(AMARA, utc(6))

    expect(first).toHaveLength(2)
    expect((await rowsOf(AMARA)).map(({ id }) => id).sort()).toEqual(first)
    expect(push.sent).toHaveLength(2)
  })

  it('writes the rows of a slot that is exactly 30 minutes old, and none for one a millisecond older', async () => {
    await amara()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await consume(AMARA, utc(6), new Date(utc(6).getTime() + 30 * MINUTE + 1))
    expect(keysOf(AMARA)).toEqual([])

    await consume(AMARA, utc(6), new Date(utc(6).getTime() + 30 * MINUTE))
    expect(keysOf(AMARA)).toEqual([`reminder:${day(0)}:morning`])
  })

  it('keeps one profile\'s rows to that profile', async () => {
    await amara()
    await remind(TOLU, { timeZone: LAGOS })
    await phone(TOLU, TOLU_TOKEN)
    startedRoutine(TOLU, { morning: [entry('cleanse', 'Gentle cleanser', 'am')] })

    await consume(AMARA, utc(6))
    await consume(TOLU, utc(6))

    expect((await rowsOf(AMARA)).map(({ title }) => title)).toEqual([MORNING_WORDS.title])
    expect((await rowsOf(TOLU)).map(({ title }) => title)).toEqual(['Gentle cleanser'])
  })
})

describe('the inbox rows of a profile that is sent no push', () => {
  // Each is a started profile; at the slot it is due its morning by the times it is counted by. Lagos 07:00 is 06:00 UTC, New York 07:00 is 11:00 UTC, no zone is UTC.
  const PROFILES: [string, (who: Actor) => Promise<void>, Date][] = [
    ['reminders off, in Lagos', async (who) => { await remind(who, { enabled: false, timeZone: LAGOS }); await phone(who, AMARA_TOKEN) }, utc(6)],
    ['reminders off, in New York', async (who) => { await remind(who, { enabled: false, timeZone: NEW_YORK }); await phone(who, AMARA_TOKEN) }, utc(11)],
    ['reminders off, with no zone stored', async (who) => { await remind(who, { enabled: false, timeZone: null }); await phone(who, AMARA_TOKEN) }, utc(7)],
    ['no settings row at all, which is UTC', async (who) => { await phone(who, AMARA_TOKEN) }, utc(7)],
    ['reminders on in Lagos and no phone registered', async (who) => { await remind(who, { timeZone: LAGOS }) }, utc(6)],
  ]

  it.each(PROFILES)('%s: the morning row is written, no push is queued and nothing is claimed', async (_name, setUp, slot) => {
    await setUp(AMARA)
    startedRoutine(AMARA)

    const queued = await consume(AMARA, slot)

    expect(queued).toBe(0)
    expect(keysOf(AMARA)).toEqual([`reminder:${day(0)}:morning`])
    expect(await rowOf(AMARA, `reminder:${day(0)}:morning`)).toMatchObject({ kind: 'reminder', title: MORNING_WORDS.title, body: MORNING_WORDS.body, link: '/routine' })
    expect(push.sent).toEqual([])
    expect(jobs.enqueued).toEqual([])
    expect(claimKinds(AMARA)).toEqual([])
  })

  it('counts a profile with reminders off by the default times and not by the times it stored: 03:00 stored is nothing, 07:00 is the morning', async () => {
    await remind(AMARA, { enabled: false, timeZone: LAGOS, morning: '03:00', evening: '04:00' })
    startedRoutine(AMARA)

    // 03:00 and 04:00 in Lagos are 02:00 and 03:00 UTC.
    await consume(AMARA, utc(2))
    await consume(AMARA, utc(3))
    expect(keysOf(AMARA)).toEqual([])

    await consume(AMARA, utc(6))
    await consume(AMARA, utc(20))
    expect(keysOf(AMARA)).toEqual([`reminder:${day(0)}:evening`, `reminder:${day(0)}:morning`])
  })

  it('writes the step-down row for a profile with reminders off, and for one with reminders on and the step-down alerts switched off, and queues no alert for either', async () => {
    startedRoutine(AMARA, { stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })
    await remind(AMARA, { enabled: false, timeZone: LAGOS })
    await phone(AMARA, AMARA_TOKEN)
    startedRoutine(TOLU, { stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })
    await remind(TOLU, { timeZone: LAGOS, stepDownAlerts: false })
    await phone(TOLU, TOLU_TOKEN)

    await consume(AMARA, utc(6))
    await consume(TOLU, utc(6))

    expect(keysOf(AMARA)).toEqual([`reminder:${day(0)}:morning`, `step-down:${day(0)}`])
    expect(keysOf(TOLU)).toEqual([`reminder:${day(0)}:morning`, `step-down:${day(0)}`])
    // Tolu's daily reminder goes, as it always did; neither profile is sent an alert.
    expect(push.sent.map(({ title }) => title)).toEqual([MORNING_WORDS.title])
    expect(claimKinds(AMARA)).toEqual([])
    expect(claimKinds(TOLU)).toEqual(['morning'])
  })

  it('writes the rest-night row for a profile with reminders off', async () => {
    await remind(AMARA, { enabled: false, timeZone: LAGOS })
    startedRoutine(AMARA, { dayOne: day(-9), evening: [entry('treat', 'Retinoid', 'alternate-days')] })

    await consume(AMARA, utc(20))

    expect(keysOf(AMARA)).toEqual([`rest-night:${day(0)}`])
  })

  it('writes nothing for a profile whose routine is not Started, whatever its settings', async () => {
    await remind(AMARA, { enabled: false, timeZone: LAGOS })

    await consume(AMARA, utc(6))

    expect(keysOf(AMARA)).toEqual([])
  })

  it('writes the row of a profile with no phone, and when its phone registers before the window closes, the push goes carrying that same row\'s id', async () => {
    await remind(AMARA, { timeZone: LAGOS })
    startedRoutine(AMARA)
    await consume(AMARA, utc(6))
    const written = idOf(AMARA, `reminder:${day(0)}:morning`)
    expect(push.sent).toEqual([])

    await phone(AMARA, AMARA_TOKEN)
    await consume(AMARA, utc(6, 10))

    expect(push.sent).toHaveLength(1)
    expect(push.sent[0]!.data).toEqual({ kind: 'routine-reminder', url: '/routine', profileId: 'profile-amara-1', day: day(0), time: 'morning', inboxId: written })
    expect(await rowsOf(AMARA)).toHaveLength(1)
  })
})

describe('the pushes that are the delivery of a row carry its id', () => {
  it('adds inboxId to the daily reminder\'s data, the id of the reminder row, and nothing else changes', async () => {
    await amara()

    await consume(AMARA, utc(6))

    expect(push.sent).toHaveLength(1)
    expect(push.sent[0]!.data).toEqual({ kind: 'routine-reminder', url: '/routine', profileId: 'profile-amara-1', day: day(0), time: 'morning', inboxId: idOf(AMARA, `reminder:${day(0)}:morning`) })
    expect(push.sent[0]!.categoryId).toBe('routine-reminder')
  })

  it('adds inboxId to the evening reminder\'s data, the id of the evening row and not the morning\'s', async () => {
    await amara()

    await consume(AMARA, utc(6))
    await consume(AMARA, utc(20))

    const evening = push.sent.find((message) => message.body === EVENING_WORDS.body)!
    expect(evening.data).toMatchObject({ time: 'evening', inboxId: idOf(AMARA, `reminder:${day(0)}:evening`) })
    expect(idOf(AMARA, `reminder:${day(0)}:evening`)).not.toBe(idOf(AMARA, `reminder:${day(0)}:morning`))
  })

  it('adds inboxId to the step-down alert\'s data, the id of the step-down row', async () => {
    await amara({}, { stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })

    await consume(AMARA, utc(6))

    const alert = push.sent.find((message) => message.title === STEP_DOWN_ALERT_TITLE)!
    expect(alert.data).toEqual({ kind: 'step-down-alert', url: '/routine/step-down', profileId: 'profile-amara-1', day: day(0), inboxId: idOf(AMARA, `step-down:${day(0)}`) })
  })
})

describe('the pause check-in push', () => {
  const CHECK_KEY = (pauseId: string, checkDay: string) => `check-in-due:${pauseId}:${checkDay}`
  const pausePushes = () => push.sent.filter((message) => (message.data as { kind?: string } | undefined)?.kind === 'pause-check-in')
  const pause = (who: Actor, id: string, checkDay: string, step: RoutineStep | null = 'treat') => pauses.set(profileOf(who), [...(pauses.get(profileOf(who)) ?? []), pauseRow(profileOf(who), id, checkDay, step)])

  it('sends one push at the morning time for a check-in that is due, carrying the id of its check-in-due row and claiming pause-check:<pauseId>:<checkDay>', async () => {
    await amara({}, { morning: [entry('treat', 'Retinoid', 'am')] })
    pause(AMARA, 'pause-1', day(0))

    const queued = await consume(AMARA, utc(6))

    // The daily reminder and the check-in push.
    expect(queued).toBe(2)
    expect(pausePushes()).toHaveLength(1)
    expect(pausePushes()[0]!.data).toMatchObject({ kind: 'pause-check-in', profileId: 'profile-amara-1', inboxId: idOf(AMARA, CHECK_KEY('pause-1', day(0))) })
    expect(claimKinds(AMARA)).toContain(`pause-check:pause-1:${day(0)}`)
    expect(await rowOf(AMARA, CHECK_KEY('pause-1', day(0)))).toMatchObject({ kind: 'check-in-due', day: day(0), read: false })
  })

  it('opens the same in-app path from the push and from its row, and keeps the step\'s title off the lock screen', async () => {
    await amara({}, { morning: [entry('treat', 'Retinoid', 'am')] })
    pause(AMARA, 'pause-1', day(0))

    await consume(AMARA, utc(6))

    const row = await rowOf(AMARA, CHECK_KEY('pause-1', day(0)))
    const sent = pausePushes()[0]!
    expect(row.link).toMatch(/^\/(?!\/)/)
    expect((sent.data as { url: string }).url).toBe(row.link)
    expect(`${sent.title} ${sent.body}`).not.toContain('Retinoid')
  })

  it('is due on its check day and not the day before', async () => {
    await amara()
    pause(AMARA, 'pause-1', day(1))

    await consume(AMARA, utc(6))
    expect(pausePushes()).toEqual([])
    expect(keysOf(AMARA).filter((key) => key.startsWith('check-in-due:'))).toEqual([])

    await consume(AMARA, utc(6, 0, 1))
    expect(pausePushes()).toHaveLength(1)
    expect(keysOf(AMARA)).toContain(CHECK_KEY('pause-1', day(1)))
  })

  it('is due the first morning the job sees it after the check day, and counts the profile\'s local day: New York is a day behind UTC at 01:00', async () => {
    await remind(TOLU, { timeZone: NEW_YORK })
    await phone(TOLU, TOLU_TOKEN)
    startedRoutine(TOLU)
    pause(TOLU, 'pause-ny', day(-2))

    await consume(TOLU, utc(11))

    expect(pausePushes()).toHaveLength(1)
    expect(keysOf(TOLU)).toContain(CHECK_KEY('pause-ny', day(-2)))
  })

  it('does not send at the evening time', async () => {
    await amara()
    pause(AMARA, 'pause-1', day(0))

    await consume(AMARA, utc(20))

    expect(pausePushes()).toEqual([])
    expect(keysOf(AMARA).filter((key) => key.startsWith('check-in-due:'))).toEqual([])
  })

  it('goes once per check day: the next morning, with the check-in still unanswered, makes one more idempotent write attempt, and no second row and no second push', async () => {
    await amara()
    pause(AMARA, 'pause-1', day(0))

    await consume(AMARA, utc(6))
    await consume(AMARA, utc(6, 0, 1))

    expect(pausePushes()).toHaveLength(1)
    expect(keysOf(AMARA).filter((key) => key.startsWith('check-in-due:'))).toEqual([CHECK_KEY('pause-1', day(0)), CHECK_KEY('pause-1', day(0))])
    expect((await rowsOf(AMARA)).filter((row) => row.kind === 'check-in-due')).toHaveLength(1)
  })

  it('heals a row lost to a failed write: the write fails on the first delivery, the push goes without it, and the next delivery writes the row with no second push', async () => {
    await amara()
    pause(AMARA, 'pause-1', day(0))
    inboxFails = true
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await consume(AMARA, utc(6))
    expect(pausePushes()).toHaveLength(1)
    expect(pausePushes()[0]!.data).not.toHaveProperty('inboxId')
    expect((await rowsOf(AMARA)).filter((row) => row.kind === 'check-in-due')).toEqual([])

    inboxFails = false
    await consume(AMARA, utc(6, 5))

    expect(pausePushes()).toHaveLength(1)
    expect(await rowOf(AMARA, CHECK_KEY('pause-1', day(0)))).toMatchObject({ kind: 'check-in-due', day: day(0) })
  })

  it('writes the row the next morning when its claim is already held and no row exists, and sends no second push', async () => {
    await amara()
    pause(AMARA, 'pause-1', day(0))
    await sends.claim(profileOf(AMARA), day(0), `pause-check:pause-1:${day(0)}`, utc(0))

    await consume(AMARA, utc(6, 0, 1))

    expect(pausePushes()).toEqual([])
    expect(await rowOf(AMARA, CHECK_KEY('pause-1', day(0)))).toMatchObject({ kind: 'check-in-due', read: false })
  })

  it('goes again when the check day moves (an answer of about the same), with a row of its own', async () => {
    await amara()
    pause(AMARA, 'pause-1', day(0))
    await consume(AMARA, utc(6))

    pauses.set(profileOf(AMARA), [pauseRow(profileOf(AMARA), 'pause-1', day(3))])
    await consume(AMARA, utc(6, 0, 3))

    expect(pausePushes()).toHaveLength(2)
    expect(keysOf(AMARA).filter((key) => key.startsWith('check-in-due:'))).toEqual([CHECK_KEY('pause-1', day(0)), CHECK_KEY('pause-1', day(3))])
    expect(claimKinds(AMARA)).toEqual(expect.arrayContaining([`pause-check:pause-1:${day(0)}`, `pause-check:pause-1:${day(3)}`]))
    expect(idOf(AMARA, CHECK_KEY('pause-1', day(3)))).not.toBe(idOf(AMARA, CHECK_KEY('pause-1', day(0))))
  })

  it('sends one push for each check-in that is due, the check-in with no step among them, each with its own row', async () => {
    await amara()
    pause(AMARA, 'pause-step', day(0))
    pause(AMARA, 'pause-stepless', day(-1), null)

    await consume(AMARA, utc(6))

    expect(pausePushes()).toHaveLength(2)
    expect(keysOf(AMARA).filter((key) => key.startsWith('check-in-due:'))).toEqual([CHECK_KEY('pause-stepless', day(-1)), CHECK_KEY('pause-step', day(0))].sort())
    const inboxIds = pausePushes().map((message) => (message.data as { inboxId: string }).inboxId)
    expect(new Set(inboxIds).size).toBe(2)
  })

  it('writes the check-in-due row for a profile with reminders off and sends it no push and claims nothing', async () => {
    await remind(AMARA, { enabled: false, timeZone: LAGOS })
    await phone(AMARA, AMARA_TOKEN)
    startedRoutine(AMARA)
    pause(AMARA, 'pause-1', day(0))

    await consume(AMARA, utc(6))

    expect(keysOf(AMARA)).toContain(CHECK_KEY('pause-1', day(0)))
    expect(push.sent).toEqual([])
    expect(claimKinds(AMARA)).toEqual([])
  })

  it('writes the row for a profile with reminders on and no phone, sends nothing, claims nothing, and still sends when the phone registers in the window', async () => {
    await remind(AMARA, { timeZone: LAGOS })
    startedRoutine(AMARA)
    pause(AMARA, 'pause-1', day(0))

    await consume(AMARA, utc(6))
    expect(keysOf(AMARA)).toContain(CHECK_KEY('pause-1', day(0)))
    expect(claimKinds(AMARA)).toEqual([])

    await phone(AMARA, AMARA_TOKEN)
    await consume(AMARA, utc(6, 10))

    expect(pausePushes()).toHaveLength(1)
    expect(pausePushes()[0]!.data).toMatchObject({ inboxId: idOf(AMARA, CHECK_KEY('pause-1', day(0))) })
  })

  it('is dropped when reminders are switched off between the queueing and the sending, as the daily reminder is', async () => {
    await amara()
    pause(AMARA, 'pause-1', day(0))

    await service.sendForProfile(profileOf(AMARA), utc(6), utc(6))
    // The check-in push is on the queue; reminders are then switched off before it is delivered.
    expect(jobs.enqueued.some(({ body }) => (body as { kind?: string }).kind === 'pause-check-in')).toBe(true)
    await remind(AMARA, { enabled: false, timeZone: LAGOS })
    await drain()

    expect(push.sent).toEqual([])
  })

  it('does not send a check-in push to another profile\'s phone', async () => {
    await amara()
    await remind(TOLU, { timeZone: LAGOS })
    await phone(TOLU, TOLU_TOKEN)
    startedRoutine(TOLU)
    pause(AMARA, 'pause-1', day(0))

    await consume(TOLU, utc(6))
    await consume(AMARA, utc(6))

    expect(pausePushes().map((message) => message.to)).toEqual([AMARA_TOKEN])
    expect(keysOf(TOLU).filter((key) => key.startsWith('check-in-due:'))).toEqual([])
  })
})

describe('the all-done row of a rest night', () => {
  const REST = { dayOne: day(-9), evening: [entry('treat', 'Retinoid', 'alternate-days')] }
  const checkMorning = (who: Actor, onDay: string) => checked.set(`${profileOf(who)}|${onDay}`, ['morning'])
  const allDone = () => keysOf(AMARA).filter((key) => key.startsWith('all-done:'))

  it('writes one all-done row at the evening slot of a rest night on which the morning is checked in', async () => {
    await amara({}, REST)
    checkMorning(AMARA, day(0))

    await consume(AMARA, utc(20))

    expect(keysOf(AMARA)).toEqual([`all-done:${day(0)}`, `rest-night:${day(0)}`])
    expect(await rowOf(AMARA, `all-done:${day(0)}`)).toMatchObject({ kind: 'all-done', day: day(0), link: '/routine' })
  })

  it('writes none when the morning is not checked in, or on an evening with an entry due', async () => {
    await amara({}, REST)
    await consume(AMARA, utc(20))
    expect(allDone()).toEqual([])

    // Tomorrow's evening has the entry due: a normal day needs both halves, which the check-in writes.
    checkMorning(AMARA, day(1))
    await consume(AMARA, utc(20, 0, 1))
    expect(allDone()).toEqual([])
  })

  it('writes the row for a profile with reminders off, and sends it no push', async () => {
    await remind(AMARA, { enabled: false, timeZone: LAGOS })
    startedRoutine(AMARA, REST)
    checkMorning(AMARA, day(0))

    await consume(AMARA, utc(20))

    expect(allDone()).toEqual([`all-done:${day(0)}`])
    expect(push.sent).toEqual([])
  })
})

describe('a row that cannot be written', () => {
  it('is logged by ids and never blocks the daily reminder or its claim: the push goes without an inboxId and is not sent twice', async () => {
    await amara()
    inboxFails = true
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(consume(AMARA, utc(6))).resolves.toBe(1)

    expect(push.sent).toHaveLength(1)
    expect(push.sent[0]!.data).toEqual({ kind: 'routine-reminder', url: '/routine', profileId: 'profile-amara-1', day: day(0), time: 'morning' })
    expect(claimKinds(AMARA)).toEqual(['morning'])
    const logText = JSON.stringify(logged.mock.calls)
    expect(logText).toContain('profile-amara-1')
    // Not the row's words, the push token, nor the error's text.
    expect(logText).not.toContain('Cleanser')
    expect(logText).not.toContain('ExponentPushToken')
    expect(logText).not.toContain('the inbox is down')

    inboxFails = false
    await consume(AMARA, utc(6, 5))
    expect(push.sent).toHaveLength(1)
  })

  it('does not block the step-down alert or the pause check-in push', async () => {
    await amara({}, { stepDownChanges: [change(0, 'Cream', EVERY_OTHER_DAY)] })
    pauses.set(profileOf(AMARA), [pauseRow(profileOf(AMARA), 'pause-1', day(0))])
    inboxFails = true
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(consume(AMARA, utc(6))).resolves.toBe(3)

    expect(push.sent.map(({ data }) => (data as { kind: string }).kind).sort()).toEqual(['pause-check-in', 'routine-reminder', 'step-down-alert'])
    expect(push.sent.every(({ data }) => !('inboxId' in (data as object)))).toBe(true)
  })

  it('does not make the consumer throw for a profile that is sent no push, so the queue does not retry it for a row', async () => {
    await remind(AMARA, { enabled: false, timeZone: LAGOS })
    startedRoutine(AMARA)
    inboxFails = true
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(consume(AMARA, utc(6))).resolves.toBe(0)

    expect(JSON.stringify(logged.mock.calls)).toContain('profile-amara-1')
  })
})
