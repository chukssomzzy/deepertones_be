import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { PermanentJobError } from '../../jobs/job'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryPushSender } from '../../providers/push/memory.push'
import { PushUnavailableError } from '../../providers/push/push.provider'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import { FakeNotificationSettingsRepository } from './notification-settings.repository.fake'
import { checkPushReceiptsSpec, sendPushSpec } from './notifications.job-specs'
import { NotificationsService } from './notifications.service'
import { FakePushTokensRepository } from './push-tokens.repository.fake'

// The routine reminder as a notification kind (spec #217, PR 4b1): the daily "do your routine" push, which goes down the same road as every other push (queued as a
// `send-push` job, then sent by `deliver`, which handles retries, dead tokens and receipts). What decides WHEN one is queued is ReminderSendsService (PR 4b2).
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the kind and its body, not the method names):
//   service.routineReminder({ profileId, day, time, title }): Promise<void>
//       queues { job: 'send-push', body: { kind: 'routine-reminder', profileId, day, time, title } } with no delay, keyed `routine-reminder:${profileId}:${day}:${time}`.
//       `day` is the profile's local day 'YYYY-MM-DD'; `time` is 'morning' | 'evening'; `title` is the text the phone shows (the entry titles, already past the wording gate).
//       The body has no userId: the reminder belongs to the profile. A failed enqueue is logged (no title) and swallowed, like every notification.
//   service.hasPhone(profileId): Promise<boolean>        whether any phone is registered for the profile; the send job reads it before it claims a send
//   NotificationsServiceDeps.reminders?: Pick<RemindersService, 'enabledFor'>      read by `deliver` for this kind only
//   deliver(routine-reminder body): the phones of the PROFILE (whatever account row the phone is under) get one message each:
//       { to, title: body.title, body: <fixed copy>, categoryId: 'routine-reminder', data: { kind: 'routine-reminder', url: '/routine', profileId, day, time } }
//       Wanted when the profile's reminders are on at the time of the send (reminders.enabledFor), NOT when the account's scan switches say so: those never gate a reminder.
//       Tickets, dead tokens and receipts are as for every other kind.

const T0 = new Date('2030-06-15T12:00:00.000Z')
const TODAY = T0.toISOString().slice(0, 10)
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

const TITLE = 'Cleanser, Moisturiser, Sunscreen'
const REMINDER = { profileId: 'profile-ada-1', day: TODAY, time: 'morning' as const, title: TITLE }
const BODY = { kind: 'routine-reminder' as const, ...REMINDER }

let pushTokens: FakePushTokensRepository
let scanSettings: FakeNotificationSettingsRepository
let push: MemoryPushSender
let jobs: MemoryJobQueue
let remindersOn: Set<string>
let service: NotificationsService
let consoleSpies: ReturnType<typeof vi.spyOn>[]

const register = (who: Actor, deviceId: string, token: string) => runAs(who, () => service.register({ deviceId, platform: 'ios', token }))
const deliver = (body: Parameters<NotificationsService['deliver']>[0] = BODY) => runAs({ kind: 'system', job: 'send-push' }, () => service.deliver(body))
const logged = () => JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls))

beforeEach(() => {
  pushTokens = new FakePushTokensRepository()
  scanSettings = new FakeNotificationSettingsRepository()
  push = new MemoryPushSender()
  jobs = new MemoryJobQueue()
  remindersOn = new Set(['profile-ada-1'])
  service = new NotificationsService({
    pushTokens,
    settings: scanSettings,
    push,
    jobs,
    reminders: { enabledFor: async (profileId: string) => remindersOn.has(profileId) },
    deviceIdKey: DEVICE_KEY,
    now: () => T0,
  })
  consoleSpies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NotificationsService.routineReminder', () => {
  it('queues a routine-reminder push carrying the profile, the local day, the time and the title, with no delay, and sends nothing yet', async () => {
    expect(await service.routineReminder(REMINDER)).toBe(true)

    expect(jobs.enqueued).toEqual([{ job: 'send-push', body: BODY }])
    expect(push.sent).toEqual([])
  })

  it('keys the job by profile, day and time, so a repeat is one notification and the morning and evening are two', async () => {
    await service.routineReminder(REMINDER)
    await service.routineReminder({ ...REMINDER, time: 'evening' })
    await service.routineReminder({ ...REMINDER, day: '2030-06-16' })
    await service.routineReminder({ ...REMINDER, profileId: 'profile-ada-2' })

    const keys = jobs.enqueued.map((entry) => sendPushSpec.key(entry.body as never))
    expect(keys).toEqual([
      `routine-reminder:profile-ada-1:${TODAY}:morning`,
      `routine-reminder:profile-ada-1:${TODAY}:evening`,
      'routine-reminder:profile-ada-1:2030-06-16:morning',
      `routine-reminder:profile-ada-2:${TODAY}:morning`,
    ])
  })

  it('swallows a failed enqueue and logs it without the title', async () => {
    jobs.failNextWith(new Error('the queue is down'))

    await expect(service.routineReminder(REMINDER)).resolves.toBe(false)

    expect(logged()).toContain('routine-reminder')
    expect(logged()).not.toContain('Cleanser')
  })
})

describe('NotificationsService.hasPhone', () => {
  it('is true for a profile with a phone and false for one without, whatever its account\'s other profiles hold', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    expect(await service.hasPhone('profile-ada-1')).toBe(true)
    expect(await service.hasPhone('profile-ada-2')).toBe(false)
    expect(await service.hasPhone('profile-bob-1')).toBe(false)
  })

  it('is false again once the phone signs out', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    await runAs(ADA, () => service.unregister({ deviceId: 'device-1' }))

    expect(await service.hasPhone('profile-ada-1')).toBe(false)
  })
})

describe('NotificationsService.deliver: a routine reminder', () => {
  it('sends the title, the Done category and the payload the Done action posts, with a deep link to the routine', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    await deliver()

    expect(push.sent).toEqual([
      {
        to: TOKEN_A,
        title: TITLE,
        body: expect.stringMatching(/\S/),
        categoryId: 'routine-reminder',
        data: { kind: 'routine-reminder', url: '/routine', profileId: 'profile-ada-1', day: TODAY, time: 'morning' },
      },
    ])
  })

  it('carries the evening in the payload when it is the evening\'s reminder', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    await deliver({ ...BODY, time: 'evening', title: 'Cleanser' })

    expect(push.sent[0]!.data).toMatchObject({ day: TODAY, time: 'evening' })
    expect(push.sent[0]!.title).toBe('Cleanser')
  })

  it('has a body that passes the wording gate', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    await deliver()

    for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(push.sent[0]!.body), code).toBe(false)
  })

  it('sends to every phone of the profile, and not to the account\'s other profile or to anyone else', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    await register(ADA, 'device-2', TOKEN_B)
    await register(ADA_SECOND_PROFILE, 'device-3', TOKEN_C)
    await register(BOB, 'device-4', TOKEN_D)

    await deliver()

    expect(push.sent.map((message) => message.to).sort()).toEqual([TOKEN_A, TOKEN_B].sort())
  })

  it('sends nothing, and does not fail, when the profile has no phone', async () => {
    await register(BOB, 'device-4', TOKEN_D)

    await expect(deliver()).resolves.toBeUndefined()

    expect(push.sent).toEqual([])
  })

  it('sends nothing when the profile\'s reminders are off at the time of the send, even though they were on when it was queued', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    remindersOn.clear()

    await deliver()

    expect(push.sent).toEqual([])
  })

  it('is not gated by the account\'s scan switches: with both off, it is still sent', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    await runAs(ADA, () => service.updateSettings({ scanFinished: false, scanNeedsYou: false }))

    await deliver()

    expect(push.sent).toHaveLength(1)
  })

  it('does not turn reminders off for a scan push: a scan-finished push is still gated by the scan switch only', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    remindersOn.clear()

    await deliver({ kind: 'scan-finished', userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', readyCount: 1 })

    expect(push.sent).toHaveLength(1)
  })

  it('deletes a dead token and queues the receipt check for an accepted one, as for every kind', async () => {
    await register(ADA, 'device-1', TOKEN_A)
    await register(ADA, 'device-2', TOKEN_B)
    push.ticketFor(TOKEN_B, { status: 'error', reason: 'device-not-registered' })

    await deliver()

    expect(await service.hasPhone('profile-ada-1')).toBe(true)
    expect(await pushTokens.forProfile('profile-ada-1')).toHaveLength(1)
    expect(jobs.enqueued.filter((entry) => entry.job === checkPushReceiptsSpec.name)).toHaveLength(1)
  })

  it('fails the job to be tried again when the push service is unavailable, and for good when our own setup is wrong', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    push.failNextWith(new PushUnavailableError('down'))
    await expect(deliver()).rejects.toBeInstanceOf(PushUnavailableError)

    push.failNextWith(new Error('bad credentials'))
    await expect(deliver()).rejects.toBeInstanceOf(PermanentJobError)
  })

  it('logs the kind and the outcome only: never a token, the title or a link', async () => {
    await register(ADA, 'device-1', TOKEN_A)

    await deliver()

    expect(logged()).toContain('routine-reminder')
    for (const secret of [TOKEN_A, 'Cleanser', '/routine']) expect(logged()).not.toContain(secret)
  })
})
