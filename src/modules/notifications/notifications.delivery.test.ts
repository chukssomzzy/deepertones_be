import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { hmacSha256Hex } from '../../lib/crypto'
import { type Actor, runAs } from '../../lib/context'
import { PermanentJobError } from '../../jobs/job'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryPushSender } from '../../providers/push/memory.push'
import { type PushMessage, PushUnavailableError } from '../../providers/push/push.provider'
import { FakeNotificationSettingsRepository } from './notification-settings.repository.fake'
import { REJECTED_PHOTO_REASONS } from '../../providers/perfect-corp/perfect-corp.provider'
import { checkPushReceiptsSpec, sendPushSpec } from './notifications.job-specs'
import { NotificationsService } from './notifications.service'
import { FakePushTokensRepository } from './push-tokens.repository.fake'

// The one clock every test hangs off; later times are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')

const MINUTE = 60 * 1000
// When the sign-in under test happened. A phone row created before it may be alerted; one created at or after it is the signing-in phone.
const SIGN_IN_AT = new Date(T0.getTime() + 10 * MINUTE)

const DEVICE_KEY = 'device-key-a'

// Distinctive on purpose: the log assertions search for these strings.
const tokenOf = (id: string) => `ExponentPushToken[${id}]`
const TOKEN_A = tokenOf('aaaaaaaaaaaaaaaaaaaaaa')
const TOKEN_B = tokenOf('bbbbbbbbbbbbbbbbbbbbbb')
const TOKEN_C = tokenOf('cccccccccccccccccccccc')
const TOKEN_D = tokenOf('dddddddddddddddddddddd')
// SHA-256 of TOKEN_A computed outside this code base (`printf %s "$TOKEN_A" | shasum -a 256`), so tokenHash has an independent source.
const TOKEN_A_SHA256 = 'cf71de5bba2417f0fe447baf3d7386d99ae2cfbd0fc7ba43f04b3964f9073c3a'

const actor = (userId: string, profileId: string): Actor => ({ kind: 'user', userId, status: 'anonymous', profileId })

// Two accounts, the first with two profiles.
const ADA = actor('user-ada', 'profile-ada-1')
const ADA_SECOND_PROFILE = actor('user-ada', 'profile-ada-2')
const BOB = actor('user-bob', 'profile-bob-1')

type SendPushBody = z.infer<typeof sendPushSpec.schema>
type CheckReceiptsBody = z.infer<typeof checkPushReceiptsSpec.schema>

const finished = (over: Record<string, unknown> = {}) =>
  ({ kind: 'scan-finished', userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', readyCount: 3, ...over }) as SendPushBody
const needsYou = (over: Record<string, unknown> = {}) =>
  ({ kind: 'scan-needs-you', userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', itemId: 'item-1', need: 'back-photo', ...over }) as SendPushBody
const signIn = (over: Record<string, unknown> = {}) =>
  ({ kind: 'new-sign-in', userId: 'user-ada', platform: 'ios', eventId: 'event-1', at: SIGN_IN_AT.getTime(), ...over }) as SendPushBody

const faceReady = (over: Record<string, unknown> = {}) =>
  ({ kind: 'face-scan-ready', userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1', ...over }) as SendPushBody
const faceRetake = (over: Record<string, unknown> = {}) =>
  ({ kind: 'face-scan-needs-retake', userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1', reason: 'too-dark', at: T0.getTime(), ...over }) as SendPushBody

const checkInDue = (over: Record<string, unknown> = {}) =>
  ({ kind: 'face-check-in-due', userId: 'user-ada', profileId: 'profile-ada-1', dayOneScanId: 'day-one-1', ...over }) as SendPushBody
const CHECK_IN_DUE_INPUT = { userId: 'user-ada', profileId: 'profile-ada-1', dayOneScanId: 'day-one-1' }

/** A sender whose `send` can do something after Expo has answered but before the service sees the tickets: a phone registering mid-send. */
class RacingSender extends MemoryPushSender {
  duringSend?: () => Promise<void>
  async send(messages: PushMessage[]) {
    const tickets = await super.send(messages)
    await this.duringSend?.()
    return tickets
  }
}

const sha256Hex = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, '0')).join('')

let pushTokens: FakePushTokensRepository
let settings: FakeNotificationSettingsRepository
let push: RacingSender
let jobs: MemoryJobQueue
let service: NotificationsService
let eventIds: number
let clock: Date

const hashOf = (deviceId: string) => hmacSha256Hex(DEVICE_KEY, deviceId)
const register = (who: Actor, deviceId: string, token: string, platform: 'ios' | 'android' = 'ios') =>
  runAs(who, () => service.register({ deviceId, platform, token }))
const setSettings = (who: Actor, patch: { scanFinished?: boolean; scanNeedsYou?: boolean }) => runAs(who, () => service.updateSettings(patch))

// The dispatcher runs a handler as a system actor.
const deliver = (body: SendPushBody) => runAs({ kind: 'system', job: 'send-push' }, () => service.deliver(body))
const checkReceipts = (body: CheckReceiptsBody) => runAs({ kind: 'system', job: 'check-push-receipts' }, () => service.checkReceipts(body))

const sentTo = () => push.sent.map((message) => message.to).sort()
const receiptJobs = () => jobs.enqueued.filter((entry) => entry.job === 'check-push-receipts')
const receiptsBody = () => receiptJobs()[0]!.body as CheckReceiptsBody
const thrown = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

let consoleSpies: ReturnType<typeof vi.spyOn>[]
/** Everything the code under test logged, whichever console method it used. */
const logged = () => consoleSpies.flatMap((spy) => spy.mock.calls.map((args: unknown[]) => (args.length === 1 ? args[0] : args)))

const makeService = (over: { newId?: () => string } = {}) =>
  new NotificationsService({
    pushTokens,
    settings,
    push,
    jobs,
    deviceIdKey: DEVICE_KEY,
    newId: over.newId ?? (() => `event-${++eventIds}`),
    now: () => clock,
  })

beforeEach(() => {
  eventIds = 0
  clock = T0
  pushTokens = new FakePushTokensRepository()
  settings = new FakeNotificationSettingsRepository()
  push = new RacingSender()
  jobs = new MemoryJobQueue()
  service = makeService()
  consoleSpies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NotificationsService enqueueing', () => {
  it('queues a scan-finished push carrying only ids and the count, keyed by the scan', async () => {
    await service.scanFinished({ userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', readyCount: 3 })

    expect(jobs.enqueued).toHaveLength(1)
    expect(jobs.enqueued[0]).toMatchObject({ job: 'send-push', body: finished() })
    expect(jobs.enqueued[0]!.delaySeconds).toBeUndefined()
    expect(sendPushSpec.key(jobs.enqueued[0]!.body as SendPushBody)).toBe('scan-finished:scan-1')
    expect(push.sent).toEqual([])
  })

  it('queues a scan-needs-you push for a back photo, keyed by scan and need, not by item', async () => {
    await service.scanNeedsYou({ userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', itemId: 'item-1', need: 'back-photo' })
    await service.scanNeedsYou({ userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', itemId: 'item-2', need: 'back-photo' })

    expect(jobs.enqueued[0]).toMatchObject({ job: 'send-push', body: needsYou() })
    const keys = jobs.enqueued.map((entry) => sendPushSpec.key(entry.body as SendPushBody))
    expect(keys).toEqual(['scan-needs-you:scan-1:back-photo', 'scan-needs-you:scan-1:back-photo'])
  })

  it('queues a scan-needs-you push to confirm under its own key, so a back-photo ask and a confirmation are two notifications', async () => {
    await service.scanNeedsYou({ userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', itemId: 'item-3', need: 'confirm' })

    expect(jobs.enqueued[0]).toMatchObject({ job: 'send-push', body: needsYou({ itemId: 'item-3', need: 'confirm' }) })
    expect(sendPushSpec.key(jobs.enqueued[0]!.body as SendPushBody)).toBe('scan-needs-you:scan-1:confirm')
  })

  it('queues a scan-needs-you push to identify under its own key, so it is a notification apart from a back-photo ask and a confirmation', async () => {
    await service.scanNeedsYou({ userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', itemId: 'item-4', need: 'identify' })

    expect(jobs.enqueued[0]).toMatchObject({ job: 'send-push', body: needsYou({ itemId: 'item-4', need: 'identify' }) })
    expect(sendPushSpec.key(jobs.enqueued[0]!.body as SendPushBody)).toBe('scan-needs-you:scan-1:identify')
  })

  it.each([
    ['no ask', undefined, 'scan-needs-you:scan-1:back-photo'],
    ['ask 0', 0, 'scan-needs-you:scan-1:back-photo'],
    ['ask 1, the first re-ask', 1, 'scan-needs-you:scan-1:item-1:ask-1'],
    ['ask 2', 2, 'scan-needs-you:scan-1:item-1:ask-2'],
  ])('keys a back-photo push with %s as %s', async (_name, ask, key) => {
    await service.scanNeedsYou({ userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', itemId: 'item-1', need: 'back-photo', ...(ask === undefined ? {} : { ask }) })

    expect(sendPushSpec.key(jobs.enqueued[0]!.body as SendPushBody)).toBe(key)
  })

  it('queues a face-scan-ready push carrying only ids, keyed by the face scan, with no delay', async () => {
    await service.faceScanReady({ userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1' })

    expect(jobs.enqueued).toHaveLength(1)
    expect(jobs.enqueued[0]).toMatchObject({ job: 'send-push', body: faceReady() })
    expect(jobs.enqueued[0]!.delaySeconds).toBeUndefined()
    expect(sendPushSpec.key(jobs.enqueued[0]!.body as SendPushBody)).toBe('face-scan-ready:face-1')
    expect(push.sent).toEqual([])
  })

  it('queues a face-check-in-due push carrying only ids, keyed by the chase\'s day-one scan, with no delay', async () => {
    await service.faceCheckInDue(CHECK_IN_DUE_INPUT)

    expect(jobs.enqueued).toHaveLength(1)
    expect(jobs.enqueued[0]).toMatchObject({ job: 'send-push', body: checkInDue() })
    expect(jobs.enqueued[0]!.delaySeconds).toBeUndefined()
    expect(sendPushSpec.key(jobs.enqueued[0]!.body as SendPushBody)).toBe('face-check-in-due:day-one-1')
    expect(push.sent).toEqual([])
  })

  it('queues a face-scan-needs-retake push with the reason and the instant it was stamped with, keyed by the face scan and that instant', async () => {
    await service.faceScanNeedsRetake({ userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1', reason: 'no-face', at: T0.getTime() })

    expect(jobs.enqueued).toHaveLength(1)
    expect(jobs.enqueued[0]).toMatchObject({ job: 'send-push', body: faceRetake({ reason: 'no-face' }) })
    expect(jobs.enqueued[0]!.delaySeconds).toBeUndefined()
    expect(sendPushSpec.key(jobs.enqueued[0]!.body as SendPushBody)).toBe(`face-scan-needs-retake:face-1:${T0.getTime()}`)
  })

  it('stamps a needs-retake push with the time the caller passes, not the time of the enqueue', async () => {
    clock = new Date(T0.getTime() + 5 * MINUTE)

    await service.faceScanNeedsRetake({ userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1', reason: 'too-dark', at: T0.getTime() })

    expect((jobs.enqueued[0]!.body as { at: number }).at).toBe(T0.getTime())
  })

  it('queues one needs-retake push for each rejection of the same face scan, under keys that differ by the instant', async () => {
    await service.faceScanNeedsRetake({ userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1', reason: 'too-dark', at: T0.getTime() })
    await service.faceScanNeedsRetake({ userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1', reason: 'too-dark', at: T0.getTime() + MINUTE })

    const keys = jobs.enqueued.map((entry) => sendPushSpec.key(entry.body as SendPushBody))
    expect(keys).toEqual([`face-scan-needs-retake:face-1:${T0.getTime()}`, `face-scan-needs-retake:face-1:${T0.getTime() + MINUTE}`])
  })

  it('queues a new-sign-in push with a fresh event id each time, keyed by that id, stamped with the time of the sign-in', async () => {
    await service.newSignIn({ userId: 'user-ada', platform: 'ios' })
    clock = SIGN_IN_AT
    await service.newSignIn({ userId: 'user-ada', platform: null })

    expect(jobs.enqueued.map((entry) => entry.body)).toEqual([
      signIn({ eventId: 'event-1', platform: 'ios', at: T0.getTime() }),
      signIn({ eventId: 'event-2', platform: null, at: SIGN_IN_AT.getTime() }),
    ])
    expect(jobs.enqueued.map((entry) => sendPushSpec.key(entry.body as SendPushBody))).toEqual(['new-sign-in:event-1', 'new-sign-in:event-2'])
  })

  it('uses the event id the caller passes in the key, so a repeated call for the same sign-in is the same notification', async () => {
    await service.newSignIn({ userId: 'user-ada', platform: 'ios', eventId: 'session-42' })
    await service.newSignIn({ userId: 'user-ada', platform: 'ios', eventId: 'session-42' })

    expect(jobs.enqueued.map((entry) => entry.body)).toEqual([signIn({ eventId: 'session-42', at: T0.getTime() }), signIn({ eventId: 'session-42', at: T0.getTime() })])
    expect(jobs.enqueued.map((entry) => sendPushSpec.key(entry.body as SendPushBody))).toEqual(['new-sign-in:session-42', 'new-sign-in:session-42'])
    expect(eventIds).toBe(0)
  })

  it('stamps the sign-in with the time the caller passes, not the time of the enqueue', async () => {
    clock = new Date(SIGN_IN_AT.getTime() + 5 * MINUTE)

    await service.newSignIn({ userId: 'user-ada', platform: 'android', at: SIGN_IN_AT.getTime() })

    expect(jobs.enqueued[0]!.body).toEqual(signIn({ eventId: 'event-1', platform: 'android', at: SIGN_IN_AT.getTime() }))
  })

  it('makes a distinct, non-empty event id per sign-in when no id source is injected', async () => {
    const plain = new NotificationsService({ pushTokens, settings, push, jobs, deviceIdKey: DEVICE_KEY })

    await plain.newSignIn({ userId: 'user-ada', platform: 'android' })
    await plain.newSignIn({ userId: 'user-ada', platform: 'android' })

    const [first, second] = jobs.enqueued.map((entry) => (entry.body as { eventId: string }).eventId)
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(first).not.toBe(second)
  })

  it.each([
    ['scan-finished', () => service.scanFinished({ userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', readyCount: 3 })],
    ['scan-needs-you', () => service.scanNeedsYou({ userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', itemId: 'item-1', need: 'confirm' })],
    ['new-sign-in', () => service.newSignIn({ userId: 'user-ada', platform: 'ios' })],
    ['face-scan-ready', () => service.faceScanReady({ userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1' })],
    ['face-scan-needs-retake', () => service.faceScanNeedsRetake({ userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1', reason: 'no-face', at: T0.getTime() })],
    ['face-check-in-due', () => service.faceCheckInDue(CHECK_IN_DUE_INPUT)],
  ])('logs a failed %s enqueue without throwing, so the scan or the sign-in carries on', async (kind, enqueue) => {
    jobs.failNextWith(new Error('queue is down'))

    await expect(enqueue()).resolves.toBeUndefined()

    expect(jobs.enqueued).toEqual([])
    expect(logged()).toContainEqual(expect.objectContaining({ outcome: 'push-enqueue-failed', kind }))
  })

  it('logs a failed enqueue with the kind and scan id only: no account, profile or item id, and no error text', async () => {
    jobs.failNextWith(new Error('queue is down for user-ada'))

    await service.scanNeedsYou({ userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', itemId: 'item-1', need: 'confirm' })

    const failure = logged().find((entry) => (entry as { outcome?: string }).outcome === 'push-enqueue-failed') as Record<string, unknown>
    expect(Object.keys(failure).filter((key) => !['outcome', 'kind', 'scanId'].includes(key))).toEqual([])
    expect(JSON.stringify(logged())).not.toMatch(/user-ada|profile-ada|item-1/)
  })

  it.each([
    ['face-scan-ready', () => service.faceScanReady({ userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1' })],
    ['face-scan-needs-retake', () => service.faceScanNeedsRetake({ userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1', reason: 'no-face', at: T0.getTime() })],
    ['face-check-in-due', () => service.faceCheckInDue(CHECK_IN_DUE_INPUT)],
  ])('logs a failed %s enqueue with no account, profile or error text', async (_kind, enqueue) => {
    jobs.failNextWith(new Error('queue is down for user-ada'))

    await expect(enqueue()).resolves.toBeUndefined()

    const failure = logged().find((entry) => (entry as { outcome?: string }).outcome === 'push-enqueue-failed') as Record<string, unknown>
    expect(failure).toBeDefined()
    expect(JSON.stringify(logged())).not.toMatch(/user-ada|profile-ada|queue is down|too-dark|no-face/)
  })
})

describe('NotificationsService.deliver: who is told', () => {
  it('sends a finished scan to the phones on the scan\'s profile and to no other phone', async () => {
    await register(ADA, 'ada-phone-1', TOKEN_A)
    await register(ADA, 'ada-phone-2', TOKEN_B, 'android')
    await register(ADA_SECOND_PROFILE, 'ada-tablet', TOKEN_C)
    await register(BOB, 'bob-phone', TOKEN_D)

    await deliver(finished())

    expect(sentTo()).toEqual([TOKEN_A, TOKEN_B])
  })

  it('does not send to a phone that is on the profile of the scan but belongs to another account than the message names', async () => {
    await register(ADA, 'ada-phone', TOKEN_A)

    await deliver(finished({ userId: 'user-bob' }))

    expect(push.sent).toEqual([])
  })

  it('follows a profile switch: a phone that moved to the other profile before the send is not told', async () => {
    await register(ADA, 'ada-phone', TOKEN_A)
    await register(ADA_SECOND_PROFILE, 'ada-phone', TOKEN_A)

    await deliver(finished())

    expect(push.sent).toEqual([])
  })

  it('sends a needs-you push to the scan\'s profile only', async () => {
    await register(ADA, 'ada-phone-1', TOKEN_A)
    await register(ADA_SECOND_PROFILE, 'ada-tablet', TOKEN_B)

    await deliver(needsYou())

    expect(sentTo()).toEqual([TOKEN_A])
  })

  it('sends a ready face scan to the phones on the face scan\'s profile and to no other phone', async () => {
    await register(ADA, 'ada-phone-1', TOKEN_A)
    await register(ADA, 'ada-phone-2', TOKEN_B, 'android')
    await register(ADA_SECOND_PROFILE, 'ada-tablet', TOKEN_C)
    await register(BOB, 'bob-phone', TOKEN_D)

    await deliver(faceReady())

    expect(sentTo()).toEqual([TOKEN_A, TOKEN_B])
    expect(push.sent.map((message) => message.title)).toEqual(['Your face scan is ready', 'Your face scan is ready'])
  })

  it('sends a needs-retake push to the face scan\'s profile only', async () => {
    await register(ADA, 'ada-phone-1', TOKEN_A)
    await register(ADA_SECOND_PROFILE, 'ada-tablet', TOKEN_B)
    await register(BOB, 'bob-phone', TOKEN_C)

    await deliver(faceRetake())

    expect(sentTo()).toEqual([TOKEN_A])
    expect(push.sent.map((message) => message.title)).toEqual(['Your face photo needs a retake'])
  })

  it.each([
    ['face-scan-ready', () => faceReady({ userId: 'user-bob' })],
    ['face-scan-needs-retake', () => faceRetake({ userId: 'user-bob' })],
  ])('does not send %s to a phone on the face scan\'s profile that belongs to another account than the message names', async (_kind, body) => {
    await register(ADA, 'ada-phone', TOKEN_A)

    await deliver(body())

    expect(push.sent).toEqual([])
  })

  it('does not tell a phone that moved to the other profile before the face scan push was sent', async () => {
    await register(ADA, 'ada-phone', TOKEN_A)
    await register(ADA_SECOND_PROFILE, 'ada-phone', TOKEN_A)

    await deliver(faceReady())
    await deliver(faceRetake())

    expect(push.sent).toEqual([])
  })

  it('sends a check-in-due push to the phones on the profile\'s own account and profile and to no other phone', async () => {
    await register(ADA, 'ada-phone-1', TOKEN_A)
    await register(ADA, 'ada-phone-2', TOKEN_B, 'android')
    await register(ADA_SECOND_PROFILE, 'ada-tablet', TOKEN_C)
    await register(BOB, 'bob-phone', TOKEN_D)

    await deliver(checkInDue())

    expect(sentTo()).toEqual([TOKEN_A, TOKEN_B])
  })

  it('does not send check-in-due to a phone on the profile that belongs to another account than the message names, or to a phone that moved to the other profile', async () => {
    await register(ADA, 'ada-phone', TOKEN_A)
    await register(ADA_SECOND_PROFILE, 'ada-phone', TOKEN_A)

    await deliver(checkInDue())
    await deliver(checkInDue({ userId: 'user-bob' }))

    expect(push.sent).toEqual([])
  })

  it('sends a new-sign-in alert to every phone of the account, on any profile, and to no other account\'s', async () => {
    await register(ADA, 'ada-phone-1', TOKEN_A)
    await register(ADA_SECOND_PROFILE, 'ada-tablet', TOKEN_B)
    await register(BOB, 'bob-phone', TOKEN_C)

    await deliver(signIn())

    expect(sentTo()).toEqual([TOKEN_A, TOKEN_B])
  })

  describe('the sign-in alert and the phone that signed in', () => {
    const registerAt = async (when: Date, who: Actor, deviceId: string, token: string) => {
      clock = when
      await register(who, deviceId, token)
    }
    const before = (ms: number) => new Date(SIGN_IN_AT.getTime() - ms)
    const after = (ms: number) => new Date(SIGN_IN_AT.getTime() + ms)

    it('does not alert a phone that registered for the account after the sign-in, which is the phone that signed in', async () => {
      await registerAt(before(MINUTE), ADA, 'ada-old-phone', TOKEN_A)
      await registerAt(after(MINUTE), ADA, 'ada-new-phone', TOKEN_B)

      await deliver(signIn())

      expect(sentTo()).toEqual([TOKEN_A])
    })

    it('alerts a phone created before the sign-in even though it registered again since, since only its first registration counts', async () => {
      await registerAt(before(MINUTE), ADA, 'ada-old-phone', TOKEN_A)
      await registerAt(after(MINUTE), ADA, 'ada-old-phone', TOKEN_B)

      await deliver(signIn())

      expect(sentTo()).toEqual([TOKEN_B])
    })

    it('draws the line at the instant of the sign-in: a row created 1 ms before is alerted, one created at that instant is not', async () => {
      await registerAt(before(1), ADA, 'ada-phone-before', TOKEN_A)
      await registerAt(SIGN_IN_AT, ADA, 'ada-phone-at', TOKEN_B)
      await registerAt(after(1), ADA, 'ada-phone-after', TOKEN_C)

      await deliver(signIn())

      expect(sentTo()).toEqual([TOKEN_A])
    })

    it('does not alert the phone that signed in after it was a guest and registered again under the account', async () => {
      const guest = actor('user-guest', 'profile-guest-1')
      await registerAt(before(2 * MINUTE), ADA, 'ada-other-phone', TOKEN_A)
      await registerAt(before(5 * MINUTE), guest, 'signing-in-phone', TOKEN_B)
      await service.guestSignedIn('user-guest')
      await registerAt(after(MINUTE), ADA, 'signing-in-phone', TOKEN_B)

      await deliver(signIn())

      expect(sentTo()).toEqual([TOKEN_A])
    })

    it('alerts nobody, and sends nothing, when the account\'s only phone is the one that signed in', async () => {
      await registerAt(after(MINUTE), ADA, 'signing-in-phone', TOKEN_A)

      await deliver(signIn())

      expect(push.sent).toEqual([])
      expect(jobs.enqueued).toEqual([])
    })

    it('does not apply the time to a scan notification: a phone registered after the scan finished is still told', async () => {
      await registerAt(after(MINUTE), ADA, 'ada-phone', TOKEN_A)

      await deliver(finished())

      expect(sentTo()).toEqual([TOKEN_A])
    })
  })

  it('sends nothing, and queues no receipt check, when nobody has a phone registered', async () => {
    await deliver(finished())
    await deliver(needsYou())
    await deliver(signIn())

    expect(push.sent).toEqual([])
    expect(jobs.enqueued).toEqual([])
  })

  it('resolves phones at send time: a phone signed out between the event and the send is not told', async () => {
    await register(ADA, 'ada-phone', TOKEN_A)
    await service.accountSignedOut('user-ada')

    await deliver(finished())
    await deliver(signIn())

    expect(push.sent).toEqual([])
  })
})

describe('NotificationsService.deliver: settings', () => {
  beforeEach(async () => {
    await register(ADA, 'ada-phone', TOKEN_A)
  })

  it('sends both scan notifications when the account never changed a setting', async () => {
    await deliver(finished())
    await deliver(needsYou())

    expect(push.sent).toHaveLength(2)
  })

  it('skips a finished-scan push when scanFinished is off, and still sends needs-you', async () => {
    await setSettings(ADA, { scanFinished: false })

    await deliver(finished())
    expect(push.sent).toEqual([])
    await deliver(needsYou())

    expect(push.sent).toHaveLength(1)
    expect((push.sent[0]!.data as { kind: string }).kind).toBe('scan-needs-you')
  })

  it('skips a needs-you push when scanNeedsYou is off, and still sends finished', async () => {
    await setSettings(ADA, { scanNeedsYou: false })

    await deliver(needsYou())
    expect(push.sent).toEqual([])
    await deliver(finished())

    expect(push.sent).toHaveLength(1)
    expect((push.sent[0]!.data as { kind: string }).kind).toBe('scan-finished')
  })

  it('puts an identify push behind the same scanNeedsYou switch: off sends nothing, on sends it', async () => {
    await setSettings(ADA, { scanNeedsYou: false })
    await deliver(needsYou({ need: 'identify' }))
    expect(push.sent).toEqual([])

    await setSettings(ADA, { scanNeedsYou: true })
    await deliver(needsYou({ need: 'identify' }))

    expect(push.sent).toHaveLength(1)
    expect(push.sent[0]).toMatchObject({ title: 'Your scan needs you', body: "We couldn't read a product. Tell us what it is" })
  })

  it('reads the switch when it sends, so turning it off after the event queued still stops the push', async () => {
    await service.scanFinished({ userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', readyCount: 2 })
    await setSettings(ADA, { scanFinished: false })

    await deliver(jobs.enqueued[0]!.body as SendPushBody)

    expect(push.sent).toEqual([])
  })

  it('sends both face scan notifications when the account never changed a setting', async () => {
    await deliver(faceReady())
    await deliver(faceRetake())

    expect(push.sent.map((message) => (message.data as { kind: string }).kind)).toEqual(['face-scan-ready', 'face-scan-needs-retake'])
  })

  it('puts a ready face scan behind the scanFinished switch: off sends nothing, on sends it, and needs-retake is not affected', async () => {
    await setSettings(ADA, { scanFinished: false })
    await deliver(faceReady())
    expect(push.sent).toEqual([])
    await deliver(faceRetake())
    expect(push.sent.map((message) => (message.data as { kind: string }).kind)).toEqual(['face-scan-needs-retake'])

    await setSettings(ADA, { scanFinished: true })
    await deliver(faceReady())

    expect(push.sent.map((message) => (message.data as { kind: string }).kind)).toEqual(['face-scan-needs-retake', 'face-scan-ready'])
  })

  it('puts a needs-retake face scan behind the scanNeedsYou switch: off sends nothing, on sends it, and ready is not affected', async () => {
    await setSettings(ADA, { scanNeedsYou: false })
    await deliver(faceRetake())
    expect(push.sent).toEqual([])
    await deliver(faceReady())
    expect(push.sent.map((message) => (message.data as { kind: string }).kind)).toEqual(['face-scan-ready'])

    await setSettings(ADA, { scanNeedsYou: true })
    await deliver(faceRetake())

    expect(push.sent.map((message) => (message.data as { kind: string }).kind)).toEqual(['face-scan-ready', 'face-scan-needs-retake'])
  })

  it('puts a check-in-due push behind the scanNeedsYou switch: off sends nothing, on sends it, and the ready face scan push is not affected', async () => {
    await setSettings(ADA, { scanNeedsYou: false })
    await deliver(checkInDue())
    expect(push.sent).toEqual([])
    await deliver(faceReady())
    expect(push.sent.map((message) => (message.data as { kind: string }).kind)).toEqual(['face-scan-ready'])

    await setSettings(ADA, { scanNeedsYou: true })
    await deliver(checkInDue())

    expect(push.sent.map((message) => (message.data as { kind: string }).kind)).toEqual(['face-scan-ready', 'face-check-in-due'])
  })

  it('sends check-in-due when only scanFinished is off: the other switch does not gate it', async () => {
    await setSettings(ADA, { scanFinished: false })

    await deliver(checkInDue())

    expect(push.sent.map((message) => (message.data as { kind: string }).kind)).toEqual(['face-check-in-due'])
  })

  it('sends check-in-due to an account that never touched its settings, because the switches default to on', async () => {
    await deliver(checkInDue())

    expect(push.sent).toHaveLength(1)
  })

  it('reads the switch when it sends, so turning scanNeedsYou off after the check-in push queued still stops it', async () => {
    await service.faceCheckInDue(CHECK_IN_DUE_INPUT)
    await setSettings(ADA, { scanNeedsYou: false })

    for (const entry of jobs.enqueued) await deliver(entry.body as SendPushBody)

    expect(push.sent).toEqual([])
  })

  it('takes the check-in switch from the account the message names, not from another account', async () => {
    await setSettings(BOB, { scanNeedsYou: false })

    await deliver(checkInDue())

    expect(push.sent).toHaveLength(1)
  })

  it('reads the face scan switches when it sends, so turning one off after the event queued still stops the push', async () => {
    await service.faceScanReady({ userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1' })
    await service.faceScanNeedsRetake({ userId: 'user-ada', profileId: 'profile-ada-1', faceScanId: 'face-1', reason: 'too-dark', at: T0.getTime() })
    await setSettings(ADA, { scanFinished: false, scanNeedsYou: false })

    for (const entry of jobs.enqueued) await deliver(entry.body as SendPushBody)

    expect(push.sent).toEqual([])
  })

  it('takes the face scan switches from the account the message names, not from another account', async () => {
    await setSettings(BOB, { scanFinished: false, scanNeedsYou: false })

    await deliver(faceReady())
    await deliver(faceRetake())

    expect(push.sent.map((message) => message.title)).toEqual(['Your face scan is ready', 'Your face photo needs a retake'])
  })

  it('sends the new-sign-in alert even when both switches are off', async () => {
    await setSettings(ADA, { scanFinished: false, scanNeedsYou: false })

    await deliver(signIn())

    expect(sentTo()).toEqual([TOKEN_A])
  })

  it('takes the account\'s switches from the account the message names, not from another account', async () => {
    await setSettings(BOB, { scanFinished: false })

    await deliver(finished())

    expect(sentTo()).toEqual([TOKEN_A])
  })
})

describe('NotificationsService.deliver: what the phone shows', () => {
  beforeEach(async () => {
    await register(ADA, 'ada-phone', TOKEN_A)
  })

  it.each([
    [3, '3 products analysed'],
    [2, '2 products analysed'],
    [1, '1 product analysed'],
    [0, 'Open the app to see what we found'],
  ])('says "%s ready" as the body "%s", with a title that names no product', async (readyCount, body) => {
    await deliver(finished({ readyCount }))

    expect(push.sent).toEqual([
      {
        to: TOKEN_A,
        title: 'Your scan is ready',
        body,
        data: { url: '/scans/scan-1', kind: 'scan-finished', scanId: 'scan-1', profileId: 'profile-ada-1' },
      },
    ])
  })

  it.each([
    ['back-photo', 'We need a photo of the back of a product'],
    ['confirm', 'Please confirm a product we were not sure about'],
    ['identify', "We couldn't read a product. Tell us what it is"],
  ])('asks for %s in generic words and links to the exact item', async (need, body) => {
    await deliver(needsYou({ need, scanId: 'scan-7', itemId: 'item-9' }))

    expect(push.sent).toEqual([
      {
        to: TOKEN_A,
        title: 'Your scan needs you',
        body,
        data: { url: '/scans/scan-7/items/item-9', kind: 'scan-needs-you', scanId: 'scan-7', itemId: 'item-9', profileId: 'profile-ada-1' },
      },
    ])
  })

  it.each([
    ['ios', 'on an iPhone, just now'],
    ['android', 'on an Android phone, just now'],
    [null, 'just now'],
  ])('tells a sign-in from %s as "%s", with only the url and kind as data', async (platform, body) => {
    await deliver(signIn({ platform }))

    expect(push.sent).toEqual([
      { to: TOKEN_A, title: 'New sign-in to your Deeper Tones account', body, data: { url: '/settings/security', kind: 'new-sign-in' } },
    ])
  })

  it('tells a check-in is due in a plain line and links to a new face scan, with only ids in the data', async () => {
    await deliver(checkInDue({ dayOneScanId: 'day-one-7' }))

    expect(push.sent).toHaveLength(1)
    const [message] = push.sent
    expect(message!.to).toBe(TOKEN_A)
    expect(message!.title).toEqual(expect.any(String))
    expect(message!.title.trim()).not.toBe('')
    expect(message!.body).toEqual(expect.any(String))
    expect(message!.body.trim()).not.toBe('')
    expect(message!.data).toEqual({ url: '/scans/faces/new', kind: 'face-check-in-due', profileId: 'profile-ada-1', dayOneScanId: 'day-one-7' })
  })

  it('tells a ready face scan in generic words and links to the face scan', async () => {
    await deliver(faceReady({ faceScanId: 'face-7' }))

    expect(push.sent).toEqual([
      {
        to: TOKEN_A,
        title: 'Your face scan is ready',
        body: 'Open the app to see what we noticed',
        data: { url: '/scans/faces/face-7', kind: 'face-scan-ready', faceScanId: 'face-7', profileId: 'profile-ada-1' },
      },
    ])
  })

  it.each([
    ['too-dark', 'Find more light and take it again'],
    ['turn-to-camera', 'Face the camera and take it again'],
    ['move-closer', 'Move a little closer and take it again'],
    ['face-not-centred', 'Centre your face in the frame and take it again'],
    ['no-face', "We couldn't find a face. Take it again"],
    ['image-size', 'Take it again at full size'],
  ])('asks for a retake for %s as "%s" and links to the retake screen of the face scan', async (reason, body) => {
    await deliver(faceRetake({ faceScanId: 'face-7', reason }))

    expect(push.sent).toEqual([
      {
        to: TOKEN_A,
        title: 'Your face photo needs a retake',
        body,
        data: { url: '/scans/faces/face-7/retake', kind: 'face-scan-needs-retake', faceScanId: 'face-7', reason, profileId: 'profile-ada-1' },
      },
    ])
  })

  it('has a body for every reason a photo can be refused with, and no two reasons share one', async () => {
    for (const reason of REJECTED_PHOTO_REASONS) await deliver(faceRetake({ reason }))

    const bodies = push.sent.map((message) => message.body)
    expect(bodies).toHaveLength(REJECTED_PHOTO_REASONS.length)
    expect(new Set(bodies).size).toBe(REJECTED_PHOTO_REASONS.length)
  })

  it('URL-encodes the face scan id in the links it sends', async () => {
    await deliver(faceReady({ faceScanId: 'a b/c' }))
    await deliver(faceRetake({ faceScanId: 'a b/c' }))

    expect(push.sent.map((message) => (message.data as { url: string }).url)).toEqual(['/scans/faces/a%20b%2Fc', '/scans/faces/a%20b%2Fc/retake'])
  })

  it('URL-encodes the ids in the link it sends', async () => {
    await deliver(finished({ scanId: 'a b/c' }))

    expect((push.sent[0]!.data as { url: string }).url).toBe('/scans/a%20b%2Fc')
  })

  it('sends one message per phone, each to its own token', async () => {
    await register(ADA, 'ada-phone-2', TOKEN_B, 'android')

    await deliver(finished())

    expect(sentTo()).toEqual([TOKEN_A, TOKEN_B])
    expect(new Set(push.sent.map((message) => message.body))).toEqual(new Set(['3 products analysed']))
  })
})

describe('NotificationsService.deliver: tickets', () => {
  beforeEach(async () => {
    await register(ADA, 'ada-phone-1', TOKEN_A)
    await register(ADA, 'ada-phone-2', TOKEN_B, 'android')
  })

  it('queues one receipt check, 15 minutes later, for every accepted message, naming the device and the hash of the token and never the token', async () => {
    push.ticketFor(TOKEN_A, { status: 'ok', id: 'ticket-a' })
    push.ticketFor(TOKEN_B, { status: 'ok', id: 'ticket-b' })

    await deliver(finished())

    expect(receiptJobs()).toHaveLength(1)
    expect(jobs.enqueued.filter((entry) => entry.job === 'check-push-receipts' && entry.delaySeconds === 900)).toHaveLength(1)
    const receipts = receiptsBody().receipts
    expect(receipts).toHaveLength(2)
    expect(receipts).toEqual(
      expect.arrayContaining([
        { ticketId: 'ticket-a', deviceHash: await hashOf('ada-phone-1'), tokenHash: TOKEN_A_SHA256 },
        { ticketId: 'ticket-b', deviceHash: await hashOf('ada-phone-2'), tokenHash: await sha256Hex(TOKEN_B) },
      ]),
    )
    expect(JSON.stringify(jobs.enqueued)).not.toContain('ExponentPushToken')
    expect(JSON.stringify(jobs.enqueued)).not.toContain('ada-phone')
  })

  it('queues no receipt check when no message was accepted', async () => {
    push.ticketFor(TOKEN_A, { status: 'error', reason: 'rate-limited' })
    push.ticketFor(TOKEN_B, { status: 'error', reason: 'other' })

    await deliver(finished())

    expect(receiptJobs()).toEqual([])
  })

  it('checks receipts only for the messages that were accepted', async () => {
    push.ticketFor(TOKEN_A, { status: 'ok', id: 'ticket-a' })
    push.ticketFor(TOKEN_B, { status: 'error', reason: 'other' })

    await deliver(finished())

    expect(receiptsBody().receipts.map((receipt: CheckReceiptsBody['receipts'][number]) => receipt.ticketId)).toEqual(['ticket-a'])
  })

  it('deletes a phone Expo says is dead, at once, and keeps the other phone', async () => {
    push.ticketFor(TOKEN_A, { status: 'error', reason: 'device-not-registered' })
    push.ticketFor(TOKEN_B, { status: 'ok', id: 'ticket-b' })

    await deliver(finished())

    expect(await pushTokens.find(await hashOf('ada-phone-1'))).toBeNull()
    expect(await pushTokens.find(await hashOf('ada-phone-2'))).toMatchObject({ token: TOKEN_B })
    expect(receiptsBody().receipts.map((receipt: CheckReceiptsBody['receipts'][number]) => receipt.ticketId)).toEqual(['ticket-b'])
  })

  it('keeps a phone that registered a new token while the send was in flight, since the dead token is no longer its own', async () => {
    push.ticketFor(TOKEN_A, { status: 'error', reason: 'device-not-registered' })
    push.duringSend = async () => {
      await register(ADA, 'ada-phone-1', TOKEN_C)
    }

    await deliver(finished())

    expect(await pushTokens.find(await hashOf('ada-phone-1'))).toMatchObject({ token: TOKEN_C })
  })

  it('keeps a phone whose message was throttled or failed for another reason, and does not send again', async () => {
    push.ticketFor(TOKEN_A, { status: 'error', reason: 'rate-limited' })
    push.ticketFor(TOKEN_B, { status: 'error', reason: 'unavailable' })

    await expect(deliver(finished())).resolves.toBeUndefined()

    expect(push.sent).toHaveLength(2)
    expect(await pushTokens.forUser('user-ada')).toHaveLength(2)
  })

  it('logs a misconfigured ticket and carries on with the other phone, without failing the job', async () => {
    push.ticketFor(TOKEN_A, { status: 'error', reason: 'misconfigured' })
    push.ticketFor(TOKEN_B, { status: 'ok', id: 'ticket-b' })

    await expect(deliver(finished())).resolves.toBeUndefined()

    expect(logged()).toContainEqual(expect.objectContaining({ job: 'send-push', kind: 'scan-finished', outcome: expect.any(String), count: 1 }))
    expect(receiptsBody().receipts.map((receipt: CheckReceiptsBody['receipts'][number]) => receipt.ticketId)).toEqual(['ticket-b'])
    expect(await pushTokens.find(await hashOf('ada-phone-1'))).toMatchObject({ token: TOKEN_A })
  })

  it('does not fail the job when misconfigured is only part of the story: one misconfigured and one dead', async () => {
    push.ticketFor(TOKEN_A, { status: 'error', reason: 'misconfigured' })
    push.ticketFor(TOKEN_B, { status: 'error', reason: 'device-not-registered' })

    await expect(deliver(finished())).resolves.toBeUndefined()
  })

  it('fails the job permanently when every message was misconfigured, since retrying cannot fix our credentials', async () => {
    push.ticketFor(TOKEN_A, { status: 'error', reason: 'misconfigured' })
    push.ticketFor(TOKEN_B, { status: 'error', reason: 'misconfigured' })

    expect(await thrown(deliver(finished()))).toBeInstanceOf(PermanentJobError)
    expect(receiptJobs()).toEqual([])
  })

  it('fails the job permanently when the only message was misconfigured', async () => {
    await pushTokens.deleteForUser('user-ada')
    await register(ADA, 'ada-phone-solo', TOKEN_C)
    push.ticketFor(TOKEN_C, { status: 'error', reason: 'misconfigured' })

    expect(await thrown(deliver(finished()))).toBeInstanceOf(PermanentJobError)
  })

  describe('when something fails after the messages have gone out', () => {
    it('resolves, so the job is not retried and the messages not sent again, when deleting a dead phone fails', async () => {
      push.ticketFor(TOKEN_A, { status: 'error', reason: 'device-not-registered' })
      push.ticketFor(TOKEN_B, { status: 'ok', id: 'ticket-b' })
      vi.spyOn(pushTokens, 'deleteIfToken').mockRejectedValue(new Error('D1 is down'))

      await expect(deliver(finished())).resolves.toBeUndefined()

      expect(sentTo()).toEqual([TOKEN_A, TOKEN_B])
      expect(logged()).toContainEqual(expect.objectContaining({ job: 'send-push', kind: 'scan-finished', outcome: 'dead-token-delete-failed' }))
    })

    it('still queues the receipt check for the accepted phone when deleting a dead phone fails', async () => {
      push.ticketFor(TOKEN_A, { status: 'error', reason: 'device-not-registered' })
      push.ticketFor(TOKEN_B, { status: 'ok', id: 'ticket-b' })
      vi.spyOn(pushTokens, 'deleteIfToken').mockRejectedValue(new Error('D1 is down'))

      await deliver(finished())

      expect(receiptsBody().receipts.map((receipt: CheckReceiptsBody['receipts'][number]) => receipt.ticketId)).toEqual(['ticket-b'])
    })

    it('resolves, so the job is not retried and the messages not sent again, when queueing the receipt check fails', async () => {
      push.ticketFor(TOKEN_A, { status: 'ok', id: 'ticket-a' })
      push.ticketFor(TOKEN_B, { status: 'ok', id: 'ticket-b' })
      jobs.failNextWith(new Error('queue is down'))

      await expect(deliver(finished())).resolves.toBeUndefined()

      expect(sentTo()).toEqual([TOKEN_A, TOKEN_B])
      expect(receiptJobs()).toEqual([])
      expect(logged()).toContainEqual(expect.objectContaining({ job: 'send-push', kind: 'scan-finished', outcome: 'receipt-enqueue-failed', count: 2 }))
    })

    it('logs those failures with the job, kind, outcome and count only, and nothing of the error', async () => {
      push.ticketFor(TOKEN_A, { status: 'error', reason: 'device-not-registered' })
      push.ticketFor(TOKEN_B, { status: 'ok', id: 'ticket-b' })
      vi.spyOn(pushTokens, 'deleteIfToken').mockRejectedValue(new Error('D1 is down for ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'))
      jobs.failNextWith(new Error('queue is down for user-ada'))

      await deliver(finished())

      const failures = logged().filter((entry) => /failed/.test((entry as { outcome: string }).outcome))
      expect(failures.map((entry) => (entry as { outcome: string }).outcome).sort()).toEqual(['dead-token-delete-failed', 'receipt-enqueue-failed'])
      for (const entry of failures) expect(Object.keys(entry as object).filter((key) => !['job', 'kind', 'outcome', 'count'].includes(key))).toEqual([])
      expect(JSON.stringify(logged())).not.toMatch(/D1 is down|queue is down|ExponentPushToken|user-ada/)
    })
  })

  it('rethrows an unavailable Expo as it came, so the job retries; nothing was sent and nothing was queued', async () => {
    const outage = new PushUnavailableError('Expo unavailable')
    push.failNextWith(outage)

    expect(await thrown(deliver(finished()))).toBe(outage)

    expect(push.sent).toEqual([])
    expect(jobs.enqueued).toEqual([])
    expect(await pushTokens.forUser('user-ada')).toHaveLength(2)
  })

  it('then sends on the retry', async () => {
    push.failNextWith(new PushUnavailableError('Expo unavailable'))
    await thrown(deliver(finished()))

    await deliver(finished())

    expect(sentTo()).toEqual([TOKEN_A, TOKEN_B])
  })

  it('fails the job permanently when sending fails for any other reason, since our own setup is wrong', async () => {
    push.failNextWith(new Error('Expo rejected the request (HTTP 401, codes none)'))

    expect(await thrown(deliver(finished()))).toBeInstanceOf(PermanentJobError)

    expect(receiptJobs()).toEqual([])
  })
})

describe('NotificationsService.checkReceipts', () => {
  // Reached the way life reaches it: a send, whose receipt-check job carries the body.
  const sendAndCollectReceipts = async () => {
    await register(ADA, 'ada-phone-1', TOKEN_A)
    await register(ADA, 'ada-phone-2', TOKEN_B, 'android')
    push.ticketFor(TOKEN_A, { status: 'ok', id: 'ticket-a' })
    push.ticketFor(TOKEN_B, { status: 'ok', id: 'ticket-b' })
    await deliver(finished())
    return receiptsBody()
  }

  it('deletes the phone Expo reports dead and keeps the one whose receipt is ok', async () => {
    const body = await sendAndCollectReceipts()
    push.receiptFor('ticket-a', { status: 'error', reason: 'device-not-registered' })

    await checkReceipts(body)

    expect(await pushTokens.find(await hashOf('ada-phone-1'))).toBeNull()
    expect(await pushTokens.find(await hashOf('ada-phone-2'))).toMatchObject({ token: TOKEN_B })
  })

  it('asks Expo for exactly the ticket ids it was given', async () => {
    const body = await sendAndCollectReceipts()
    const receipts = vi.spyOn(push, 'receipts')

    await checkReceipts(body)

    expect(receipts).toHaveBeenCalledTimes(1)
    expect([...receipts.mock.calls[0]![0]].sort()).toEqual(['ticket-a', 'ticket-b'])
  })

  it('keeps a phone that registered a new token since the send, so the old token\'s death costs it nothing', async () => {
    const body = await sendAndCollectReceipts()
    await register(ADA, 'ada-phone-1', TOKEN_C)
    push.receiptFor('ticket-a', { status: 'error', reason: 'device-not-registered' })

    await checkReceipts(body)

    expect(await pushTokens.find(await hashOf('ada-phone-1'))).toMatchObject({ token: TOKEN_C })
  })

  it('does not delete a phone whose device hash matches but whose token no longer hashes to the one that was sent to', async () => {
    const body = await sendAndCollectReceipts()
    const forged = { receipts: body.receipts.map((receipt: CheckReceiptsBody['receipts'][number]) => ({ ...receipt, tokenHash: '0'.repeat(64) })) }
    push.receiptFor('ticket-a', { status: 'error', reason: 'device-not-registered' })

    await checkReceipts(forged)

    expect(await pushTokens.forUser('user-ada')).toHaveLength(2)
  })

  it('does not delete a phone for a receipt that is dead on a different ticket, since the ticket names the phone', async () => {
    const body = await sendAndCollectReceipts()
    push.receiptFor('ticket-b', { status: 'error', reason: 'device-not-registered' })

    await checkReceipts(body)

    expect(await pushTokens.find(await hashOf('ada-phone-1'))).toMatchObject({ token: TOKEN_A })
    expect(await pushTokens.find(await hashOf('ada-phone-2'))).toBeNull()
  })

  it.each(['rate-limited', 'unavailable', 'other'] as const)('keeps the phone and does not fail when the receipt says %s', async (reason) => {
    const body = await sendAndCollectReceipts()
    push.receiptFor('ticket-a', { status: 'error', reason })

    await expect(checkReceipts(body)).resolves.toBeUndefined()

    expect(await pushTokens.forUser('user-ada')).toHaveLength(2)
  })

  it('logs a misconfigured receipt, keeps the phone and does not fail', async () => {
    const body = await sendAndCollectReceipts()
    push.receiptFor('ticket-a', { status: 'error', reason: 'misconfigured' })

    await expect(checkReceipts(body)).resolves.toBeUndefined()

    expect(logged()).toContainEqual(expect.objectContaining({ job: 'check-push-receipts', outcome: expect.any(String), count: 1 }))
    expect(await pushTokens.forUser('user-ada')).toHaveLength(2)
  })

  it('ignores a ticket Expo has no receipt for yet', async () => {
    const body = await sendAndCollectReceipts()
    const unknown = { receipts: [...body.receipts, { ticketId: 'ticket-never-issued', deviceHash: await hashOf('ada-phone-1'), tokenHash: TOKEN_A_SHA256 }] }

    await expect(checkReceipts(unknown)).resolves.toBeUndefined()

    expect(await pushTokens.forUser('user-ada')).toHaveLength(2)
  })

  it('does not fail when the phone is already gone', async () => {
    const body = await sendAndCollectReceipts()
    push.receiptFor('ticket-a', { status: 'error', reason: 'device-not-registered' })
    await service.accountSignedOut('user-ada')

    await expect(checkReceipts(body)).resolves.toBeUndefined()
  })

  it('rethrows an unavailable Expo as it came, so the job retries, and deletes nothing', async () => {
    const body = await sendAndCollectReceipts()
    push.receiptFor('ticket-a', { status: 'error', reason: 'device-not-registered' })
    const outage = new PushUnavailableError('Expo unavailable')
    push.failNextReceiptsWith(outage)

    expect(await thrown(checkReceipts(body))).toBe(outage)
    expect(await pushTokens.forUser('user-ada')).toHaveLength(2)

    await checkReceipts(body)
    expect(await pushTokens.find(await hashOf('ada-phone-1'))).toBeNull()
  })
})

describe('NotificationsService push logs', () => {
  it('carry only the job, kind, outcome and count, never a token, text, link or id', async () => {
    await register(ADA, 'ada-phone-1', TOKEN_A)
    await register(ADA, 'ada-phone-2', TOKEN_B)
    await register(ADA, 'ada-phone-3', TOKEN_C)
    await register(ADA, 'ada-phone-4', TOKEN_D)
    push.ticketFor(TOKEN_A, { status: 'error', reason: 'device-not-registered' })
    push.ticketFor(TOKEN_B, { status: 'error', reason: 'misconfigured' })
    push.ticketFor(TOKEN_C, { status: 'error', reason: 'rate-limited' })
    push.ticketFor(TOKEN_D, { status: 'ok', id: 'ticket-d' })
    await deliver(finished())
    push.receiptFor('ticket-d', { status: 'error', reason: 'misconfigured' })
    await checkReceipts(receiptsBody())
    push.failNextWith(new PushUnavailableError('Expo unavailable for ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'))
    await thrown(deliver(needsYou()))
    jobs.failNextWith(new Error('queue is down'))
    await service.scanFinished({ userId: 'user-ada', profileId: 'profile-ada-1', scanId: 'scan-1', readyCount: 3 })

    const entries = logged()
    expect(entries.length).toBeGreaterThan(0)
    const text = JSON.stringify(entries)
    for (const secret of [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D, 'ExponentPushToken', 'Your scan', 'analysed', 'We need', '/scans/', '/settings', 'ticket-d', 'ada-phone', await hashOf('ada-phone-1'), 'user-ada', 'profile-ada']) {
      expect(text, `a log line mentions ${secret}`).not.toContain(secret)
    }
    for (const entry of entries) {
      expect(typeof entry).toBe('object')
      const allowed = (entry as { outcome?: string }).outcome === 'push-enqueue-failed' ? ['outcome', 'kind', 'scanId'] : ['job', 'kind', 'outcome', 'count']
      expect(Object.keys(entry as object).filter((key) => !allowed.includes(key))).toEqual([])
    }
  })
})

// Names a condition, speaks to the person as having something, talks about lightness, or carries a number. Case-insensitive. This mirrors the face
// tables' ban list (face-scans.tables.test.ts), which is not exported, with the colour words the brief names. A push appears on a lock screen.
const BANNED: [string, RegExp][] = [
  ['acne', /\bacne\b/i],
  ['melasma', /melasma/i],
  ['rosacea', /rosacea/i],
  ['eczema', /eczema/i],
  ['dermatitis', /dermatitis/i],
  ['psoriasis', /psoriasis/i],
  ['hyperpigment', /hyperpigment/i],
  ['you have', /you have/i],
  ['diagnos', /diagnos/i],
  ['disease', /disease/i],
  ['condition', /condition/i],
  ['lighter', /lighter/i],
  ['lighten', /lighten/i],
  ['darker', /darker/i],
  ['fairer', /fairer/i],
  ['whiter', /whiter/i],
  ['bleach', /bleach/i],
  ['dull', /\bdull/i],
  ['bright', /\bbright/i],
  ['fair', /\bfair\b/i],
  ['pale', /\bpale\b/i],
  ['a digit', /\d/],
  ['score', /score/i],
]

describe('the face scan push words', () => {
  const caught = (text: string) => BANNED.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)

  it('has a ban list that catches what it is meant to (so a typo in it cannot pass everything)', () => {
    expect(caught('You HAVE Melasma')).toEqual(expect.arrayContaining(['melasma', 'you have']))
    expect(caught('Skin looks LIGHTER')).toEqual(['lighter'])
    expect(caught('Skin looks darker')).toEqual(['darker'])
    expect(caught('Your score is 62')).toEqual(expect.arrayContaining(['score', 'a digit']))
    expect(caught('Open the app to see what we noticed')).toEqual([])
  })

  it('puts no condition word, "you have", lightness word or digit in any title or body a face scan push shows', async () => {
    await register(ADA, 'ada-phone', TOKEN_A)
    await deliver(faceReady())
    await deliver(checkInDue())
    for (const reason of REJECTED_PHOTO_REASONS) await deliver(faceRetake({ reason }))

    expect(push.sent).toHaveLength(2 + REJECTED_PHOTO_REASONS.length)
    for (const message of push.sent) {
      expect(message.title).toEqual(expect.any(String))
      expect(message.body).toEqual(expect.any(String))
      for (const [name, pattern] of BANNED) {
        expect(pattern.test(message.title), `"${message.title}" must not contain ${name}`).toBe(false)
        expect(pattern.test(message.body), `"${message.body}" must not contain ${name}`).toBe(false)
      }
    }
  })
})
