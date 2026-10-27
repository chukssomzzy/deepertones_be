import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryPushSender } from '../../providers/push/memory.push'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import { FakeNotificationSettingsRepository } from './notification-settings.repository.fake'
import { sendPushSpec } from './notifications.job-specs'
import { NotificationsService } from './notifications.service'
import { FakePushTokensRepository } from './push-tokens.repository.fake'

// The step-down alert and the missed-days nudge as notification kinds (spec #217, PR 4c). They go down the same road as the routine reminder (queued as a `send-push` job, sent by
// `deliver`), but each is gated at delivery by `reminders on AND its own switch`, read when the job runs (story 30: nothing reaches a person who never turned reminders on; the owner's decision),
// and never by the account's scan switches. What decides WHEN one is queued is ReminderSendsService (reminders.sends.service.test.ts).
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the two kinds, the switches and "its own deep link", not the method or field names):
//   service.stepDownAlert({ profileId, day, changes }): Promise<boolean>
//       changes: { title, line }[], at least one: the routine title of each step-down whose step begins on `day` (the profile's local day, 'YYYY-MM-DD') and the fixed line for the step
//       ('From today: use it every other day'). Queues { job: 'send-push', body: { kind: 'step-down-alert', profileId, day, changes } } with no delay, keyed
//       `step-down-alert:${profileId}:${day}`. Answers whether it was queued; a failed enqueue is logged by kind and profile id (never the text) and swallowed.
//   service.missedDaysNudge({ profileId, since }): Promise<boolean>
//       `since` is the first day of the run of missed days. Queues { kind: 'missed-days-nudge', profileId, since }, keyed `missed-days-nudge:${profileId}:${since}`: the key has no
//       day of its own, so a run of missed days is one nudge however many mornings it spans.
//   NotificationsServiceDeps.reminders: Pick<RemindersService, 'enabledFor' | 'stepDownAlertsFor' | 'missedDaysNudgeFor'>      each by profile id, read by `deliver` for its own kind only. The service
//       answers `stepDownAlertsFor` / `missedDaysNudgeFor` as `enabled && its own switch` (reminders.service.test.ts), so `deliver` asks that ONE read for these two kinds; the fake below answers the
//       same way, so a service that also asked `enabledFor` would pass too.
//   deliver(step-down-alert body): every phone of the PROFILE gets one message:
//       { to, title, body, data: { kind: 'step-down-alert', url: '/routine/step-down', profileId, day } }     no categoryId (there is no "Done" on it)
//       title and body together say each change's title and line verbatim, in order; the rest of the copy is fixed.
//   deliver(missed-days-nudge body): { to, title, body, data: { kind: 'missed-days-nudge', url: '/routine', profileId } }; the copy is fixed and says nothing about the person's skin.
//   Both are wanted only while reminders AND the profile's own switch (stepDownAlerts / missedDaysNudge) are on at the time of the send. Tickets, dead tokens and receipts are as for every kind.

const T0 = new Date('2030-06-15T12:00:00.000Z')
/** A calendar day `n` days from T0's day. */
const day = (n: number) => new Date(T0.getTime() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
const TODAY = day(0)
const SINCE = day(-2)
const DEVICE_KEY = 'device-key-a'
const tokenOf = (id: string) => `ExponentPushToken[${id}]`
const TOKEN_A = tokenOf('aaaaaaaaaaaaaaaaaaaaaa')
const TOKEN_B = tokenOf('bbbbbbbbbbbbbbbbbbbbbb')
const TOKEN_C = tokenOf('cccccccccccccccccccccc')
const TOKEN_D = tokenOf('dddddddddddddddddddddd')

const actor = (userId: string, profileId: string): Actor => ({ kind: 'user', userId, status: 'verified', profileId })
const ADA = actor('user-ada', 'profile-ada-1')
const ADA_SECOND_PROFILE = actor('user-ada', 'profile-ada-2')
const BOB = actor('user-bob', 'profile-bob-1')

const CREAM = { title: 'Cream', line: 'From today: use it every other day' }
const GEL_CLEANSER = { title: 'Gel cleanser', line: 'From today: stop using it' }
const ALERT_INPUT = { profileId: 'profile-ada-1', day: TODAY, changes: [CREAM] }
const ALERT = { kind: 'step-down-alert' as const, ...ALERT_INPUT }
const NUDGE_INPUT = { profileId: 'profile-ada-1', since: SINCE }
const NUDGE = { kind: 'missed-days-nudge' as const, ...NUDGE_INPUT }

/** The profile's own switches, as RemindersService answers them by profile id. */
type Switches = { enabled: Set<string>; stepDownAlerts: Set<string>; missedDaysNudge: Set<string> }

let pushTokens: FakePushTokensRepository
let scanSettings: FakeNotificationSettingsRepository
let push: MemoryPushSender
let jobs: MemoryJobQueue
let switches: Switches
let service: NotificationsService
let consoleSpies: ReturnType<typeof vi.spyOn>[]

const make = (withReminders = true) =>
  new NotificationsService({
    pushTokens,
    settings: scanSettings,
    push,
    jobs,
    ...(withReminders
      ? {
          reminders: {
            enabledFor: async (profileId: string) => switches.enabled.has(profileId),
            // As RemindersService answers them: reminders on AND the own switch.
            stepDownAlertsFor: async (profileId: string) => switches.enabled.has(profileId) && switches.stepDownAlerts.has(profileId),
            missedDaysNudgeFor: async (profileId: string) => switches.enabled.has(profileId) && switches.missedDaysNudge.has(profileId),
          },
        }
      : {}),
    deviceIdKey: DEVICE_KEY,
    now: () => T0,
  } as ConstructorParameters<typeof NotificationsService>[0])

const register = (who: Actor, deviceId: string, token: string) => runAs(who, () => service.register({ deviceId, platform: 'ios', token }))
const deliver = (body: Parameters<NotificationsService['deliver']>[0]) => runAs({ kind: 'system', job: 'send-push' }, () => service.deliver(body))
const logged = () => JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls))
/** What the phone shows, title and body together. */
const textOf = (message: { title: string; body: string }) => `${message.title}\n${message.body}`

beforeEach(() => {
  pushTokens = new FakePushTokensRepository()
  scanSettings = new FakeNotificationSettingsRepository()
  push = new MemoryPushSender()
  jobs = new MemoryJobQueue()
  // Ada has all three of her own switches on, as a person who turned everything on.
  switches = { enabled: new Set(['profile-ada-1']), stepDownAlerts: new Set(['profile-ada-1']), missedDaysNudge: new Set(['profile-ada-1']) }
  service = make()
  consoleSpies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
})

afterEach(() => {
  // Whatever was sent, none of it may say what the wording gate forbids.
  for (const message of push.sent) {
    for (const { code, pattern } of FORBIDDEN_WORDING) {
      expect(pattern.test(message.title), `title "${message.title}" trips ${code}`).toBe(false)
      expect(pattern.test(message.body), `body "${message.body}" trips ${code}`).toBe(false)
    }
  }
  vi.restoreAllMocks()
})

describe('NotificationsService.stepDownAlert', () => {
  it('queues a step-down-alert push carrying the profile, the local day and the changes, with no delay, and sends nothing yet', async () => {
    expect(await service.stepDownAlert(ALERT_INPUT)).toBe(true)

    expect(jobs.enqueued).toEqual([{ job: 'send-push', body: ALERT }])
    expect(push.sent).toEqual([])
  })

  it('keys the job by profile and day, so a repeat is one alert, whatever it lists, and two days are two', async () => {
    await service.stepDownAlert(ALERT_INPUT)
    await service.stepDownAlert({ ...ALERT_INPUT, changes: [GEL_CLEANSER] })
    await service.stepDownAlert({ ...ALERT_INPUT, day: day(1) })

    expect(jobs.enqueued.map((entry) => sendPushSpec.key(entry.body as never))).toEqual([`step-down-alert:profile-ada-1:${TODAY}`, `step-down-alert:profile-ada-1:${TODAY}`, `step-down-alert:profile-ada-1:${day(1)}`])
  })

  it('swallows a failed enqueue, answers false, and logs the kind and the profile without the product titles or the lines', async () => {
    jobs.failNextWith(new Error('the queue is down'))

    await expect(service.stepDownAlert(ALERT_INPUT)).resolves.toBe(false)

    expect(logged()).toContain('step-down-alert')
    expect(logged()).toContain('profile-ada-1')
    for (const secret of ['Cream', 'From today']) expect(logged()).not.toContain(secret)
  })
})

describe('NotificationsService.missedDaysNudge', () => {
  it('queues a missed-days-nudge push carrying the profile and the first day of the run, with no delay, and sends nothing yet', async () => {
    expect(await service.missedDaysNudge(NUDGE_INPUT)).toBe(true)

    expect(jobs.enqueued).toEqual([{ job: 'send-push', body: NUDGE }])
    expect(push.sent).toEqual([])
  })

  it('keys the job by profile and the run\'s first day alone, so a run is one nudge however many mornings it spans, and a new run is a new one', async () => {
    await service.missedDaysNudge(NUDGE_INPUT)
    await service.missedDaysNudge(NUDGE_INPUT)
    await service.missedDaysNudge({ ...NUDGE_INPUT, since: day(5) })

    expect(jobs.enqueued.map((entry) => sendPushSpec.key(entry.body as never))).toEqual([
      `missed-days-nudge:profile-ada-1:${SINCE}`,
      `missed-days-nudge:profile-ada-1:${SINCE}`,
      `missed-days-nudge:profile-ada-1:${day(5)}`,
    ])
  })

  it('swallows a failed enqueue, answers false, and logs the kind and the profile', async () => {
    jobs.failNextWith(new Error('the queue is down'))

    await expect(service.missedDaysNudge(NUDGE_INPUT)).resolves.toBe(false)

    expect(logged()).toContain('missed-days-nudge')
    expect(logged()).toContain('profile-ada-1')
  })
})

describe('NotificationsService.deliver: a step-down alert', () => {
  it('sends the product\'s title and the fixed line, a deep link to the step-down schedule, and the profile and day in the payload, with no Done action', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    await deliver(ALERT)

    expect(push.sent).toEqual([
      {
        to: TOKEN_A,
        title: expect.stringMatching(/\S/),
        body: expect.stringMatching(/\S/),
        data: { kind: 'step-down-alert', url: '/routine/step-down', profileId: 'profile-ada-1', day: TODAY },
      },
    ])
    expect(push.sent[0]!.categoryId).toBeUndefined()
    expect(textOf(push.sent[0]!)).toContain('Cream')
    expect(textOf(push.sent[0]!)).toContain('From today: use it every other day')
  })

  it('lists every change in one message when two step-downs change on the same day, in the order given', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    await deliver({ ...ALERT, changes: [CREAM, GEL_CLEANSER] })

    expect(push.sent).toHaveLength(1)
    const text = textOf(push.sent[0]!)
    for (const part of [CREAM.title, CREAM.line, GEL_CLEANSER.title, GEL_CLEANSER.line]) expect(text).toContain(part)
    expect(text.indexOf(CREAM.line)).toBeLessThan(text.indexOf(GEL_CLEANSER.line))
  })

  it('sends to every phone of the profile, and not to the account\'s other profile or to anyone else', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    await register(ADA, 'device-2', TOKEN_B)
    await register(ADA_SECOND_PROFILE, 'device-3', TOKEN_C)
    await register(BOB, 'device-4', TOKEN_D)

    await deliver(ALERT)

    expect(push.sent.map((message) => message.to).sort()).toEqual([TOKEN_A, TOKEN_B].sort())
  })

  it('sends nothing, and does not fail, when the profile has no phone', async () => {
    await register(BOB, 'device-4', TOKEN_D)

    await expect(deliver(ALERT)).resolves.toBeUndefined()

    expect(push.sent).toEqual([])
  })

  it('is sent only while reminders are on AND the alerts switch is on: either missing sends nothing', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    switches.enabled.clear()
    await deliver(ALERT)
    expect(push.sent).toEqual([])

    switches.enabled.add('profile-ada-1')
    switches.stepDownAlerts.clear()
    await deliver(ALERT)
    expect(push.sent).toEqual([])

    switches.stepDownAlerts.add('profile-ada-1')
    await deliver(ALERT)
    expect(push.sent).toHaveLength(1)
  })

  it('drops an alert whose reminders went off after it was queued, because the switches are read when the job runs', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    await service.stepDownAlert(ALERT_INPUT)
    switches.enabled.clear()

    await deliver(jobs.enqueued[0]!.body as typeof ALERT)

    expect(push.sent).toEqual([])
  })

  it('drops an alert whose switch went off after it was queued, because the switch is read when the job runs', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    await service.stepDownAlert(ALERT_INPUT)
    switches.stepDownAlerts.clear()

    await deliver(jobs.enqueued[0]!.body as typeof ALERT)

    expect(push.sent).toEqual([])
  })

  it('does not read the other kinds\' switches: with the nudge off, it is still sent', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    switches.missedDaysNudge.clear()

    await deliver(ALERT)

    expect(push.sent).toHaveLength(1)
  })

  it('is not gated by the account\'s scan switches: with both off, it is still sent', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    await runAs(ADA, () => service.updateSettings({ scanFinished: false, scanNeedsYou: false }))

    await deliver(ALERT)

    expect(push.sent).toHaveLength(1)
  })

  it('sends nothing when the service was built without the reminders dependency (no switch to read, so no message)', async () => {
    service = make(false)
    await register(ADA, 'device-1', TOKEN_A)

    await deliver(ALERT)

    expect(push.sent).toEqual([])
  })

  it('logs the kind and the outcome only: never a token, a title, a line or a link', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    await deliver(ALERT)

    expect(logged()).toContain('step-down-alert')
    for (const secret of [TOKEN_A, 'Cream', 'From today', '/routine']) expect(logged()).not.toContain(secret)
  })
})

describe('NotificationsService.deliver: a missed-days nudge', () => {
  it('sends fixed copy, a deep link to the routine and the profile in the payload, with no Done action and no product named', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    await deliver(NUDGE)

    expect(push.sent).toEqual([
      {
        to: TOKEN_A,
        title: expect.stringMatching(/\S/),
        body: expect.stringMatching(/\S/),
        data: { kind: 'missed-days-nudge', url: '/routine', profileId: 'profile-ada-1' },
      },
    ])
    expect(push.sent[0]!.categoryId).toBeUndefined()
  })

  it('has the same copy for every run: nothing in it comes from the run\'s date', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    await deliver(NUDGE)
    await deliver({ ...NUDGE, since: day(20) })

    expect(push.sent).toHaveLength(2)
    expect(textOf(push.sent[0]!)).toBe(textOf(push.sent[1]!))
  })

  it('is kind and blames no one: it says none of the words that scold', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    await deliver(NUDGE)

    expect(textOf(push.sent[0]!)).not.toMatch(/\b(?:forgot|forget|failed|failure|lazy|skipped|neglect\w*|slack\w*|behind|should have|didn'?t|haven'?t)\b/i)
  })

  it('sends to every phone of the profile, and not to the account\'s other profile or to anyone else', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    await register(ADA, 'device-2', TOKEN_B)
    await register(ADA_SECOND_PROFILE, 'device-3', TOKEN_C)
    await register(BOB, 'device-4', TOKEN_D)

    await deliver(NUDGE)

    expect(push.sent.map((message) => message.to).sort()).toEqual([TOKEN_A, TOKEN_B].sort())
  })

  it('is sent only while reminders are on AND the nudge switch is on: either missing sends nothing', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    switches.enabled.clear()
    await deliver(NUDGE)
    expect(push.sent).toEqual([])

    switches.enabled.add('profile-ada-1')
    switches.missedDaysNudge.clear()
    await deliver(NUDGE)
    expect(push.sent).toEqual([])

    switches.missedDaysNudge.add('profile-ada-1')
    await deliver(NUDGE)
    expect(push.sent).toHaveLength(1)
  })

  it('drops a nudge whose reminders went off after it was queued, because the switches are read when the job runs', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    await service.missedDaysNudge(NUDGE_INPUT)
    switches.enabled.clear()

    await deliver(jobs.enqueued[0]!.body as typeof NUDGE)

    expect(push.sent).toEqual([])
  })

  it('drops a nudge whose switch went off after it was queued, because the switch is read when the job runs', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    await service.missedDaysNudge(NUDGE_INPUT)
    switches.missedDaysNudge.clear()

    await deliver(jobs.enqueued[0]!.body as typeof NUDGE)

    expect(push.sent).toEqual([])
  })

  it('does not read the other kinds\' switches: with the step-down alerts off, it is still sent', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    switches.stepDownAlerts.clear()

    await deliver(NUDGE)

    expect(push.sent).toHaveLength(1)
  })

  it('is not gated by the account\'s scan switches: with both off, it is still sent', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    await runAs(ADA, () => service.updateSettings({ scanFinished: false, scanNeedsYou: false }))

    await deliver(NUDGE)

    expect(push.sent).toHaveLength(1)
  })

  it('sends nothing when the service was built without the reminders dependency', async () => {
    service = make(false)
    await register(ADA, 'device-1', TOKEN_A)

    await deliver(NUDGE)

    expect(push.sent).toEqual([])
  })

  it('logs the kind and the outcome only: never a token, a link or the run\'s date', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    await deliver(NUDGE)

    expect(logged()).toContain('missed-days-nudge')
    for (const secret of [TOKEN_A, '/routine', SINCE]) expect(logged()).not.toContain(secret)
  })
})

describe('the switches of the other kinds are not widened by these two', () => {
  it('still sends a routine reminder only while reminders are on, and a scan push only by the scan switch, whatever the alert and nudge switches say', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    switches.enabled.clear()

    await deliver({ kind: 'routine-reminder', profileId: 'profile-ada-1', day: TODAY, time: 'morning', title: 'Cleanser' })
    expect(push.sent).toEqual([])

    await deliver({ kind: 'scan-finished', userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', readyCount: 1 })
    expect(push.sent).toHaveLength(1)
  })
})
