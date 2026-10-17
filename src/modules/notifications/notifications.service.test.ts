import { beforeEach, describe, expect, it } from 'vitest'
import { hmacSha256Hex } from '../../lib/crypto'
import { type Actor, runAs } from '../../lib/context'
import { ValidationError } from '../../lib/errors'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryPushSender } from '../../providers/push/memory.push'
import { FakeNotificationSettingsRepository } from './notification-settings.repository.fake'
import { NotificationsService } from './notifications.service'
import { FakePushTokensRepository } from './push-tokens.repository.fake'

// The one clock every test hangs off; later times are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const DEVICE_KEY = 'device-key-a'

const tokenOf = (id: string) => `ExponentPushToken[${id}]`
const TOKEN_A = tokenOf('aaaaaaaaaaaaaaaaaaaaaa')
const TOKEN_B = tokenOf('bbbbbbbbbbbbbbbbbbbbbb')
const TOKEN_C = tokenOf('cccccccccccccccccccccc')

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'anonymous'): Actor => ({ kind: 'user', userId, status, profileId })

// Two accounts, the first with two profiles.
const ADA = actor('user-ada', 'profile-ada-1')
const ADA_SECOND_PROFILE = actor('user-ada', 'profile-ada-2')
const BOB = actor('user-bob', 'profile-bob-1')

let clock: Date
let pushTokens: FakePushTokensRepository
let settings: FakeNotificationSettingsRepository
let service: NotificationsService

const hashOf = (deviceId: string) => hmacSha256Hex(DEVICE_KEY, deviceId)
const register = (who: Actor, deviceId: string, token: string, platform: 'ios' | 'android' = 'ios') =>
  runAs(who, () => service.register({ deviceId, platform, token }))

beforeEach(() => {
  clock = T0
  pushTokens = new FakePushTokensRepository()
  settings = new FakeNotificationSettingsRepository()
  service = new NotificationsService({ pushTokens, settings, push: new MemoryPushSender(), jobs: new MemoryJobQueue(), deviceIdKey: DEVICE_KEY, now: () => clock })
})

describe('NotificationsService secrets', () => {
  it('keeps the device id key out of the service when it is spread or listed', () => {
    const spread = { ...service }

    expect(Object.keys(spread)).toContain('pushTokens')
    expect(Object.values(spread)).not.toContain(DEVICE_KEY)
    expect(JSON.stringify(spread)).not.toContain(DEVICE_KEY)
  })
})

describe('NotificationsService.register', () => {
  it('stores the token under HMAC(deviceIdKey, deviceId), never the raw device id, for the caller\'s account and profile', async () => {
    await register(ADA, 'device-install-0001', TOKEN_A, 'android')

    const hash = await hashOf('device-install-0001')
    expect(hash).not.toBe('device-install-0001')
    expect(await pushTokens.find(hash)).toMatchObject({
      deviceHash: hash,
      token: TOKEN_A,
      platform: 'android',
      userId: 'user-ada',
      profileId: 'profile-ada-1',
    })
    expect(await pushTokens.find('device-install-0001')).toBeNull()
  })

  it('stamps the row with the current time, and a later registration with the later time', async () => {
    await register(ADA, 'device-install-0001', TOKEN_A)
    const hash = await hashOf('device-install-0001')
    expect((await pushTokens.find(hash))!.updatedAt).toEqual(T0)

    clock = new Date(T0.getTime() + MINUTE)
    await register(ADA, 'device-install-0001', TOKEN_B)

    expect((await pushTokens.find(hash))!.updatedAt).toEqual(new Date(T0.getTime() + MINUTE))
  })

  it('takes the profile from the session, so the same device follows a profile switch', async () => {
    await register(ADA, 'device-install-0001', TOKEN_A)
    await register(ADA_SECOND_PROFILE, 'device-install-0001', TOKEN_A)

    const hash = await hashOf('device-install-0001')
    expect(await pushTokens.find(hash)).toMatchObject({ userId: 'user-ada', profileId: 'profile-ada-2' })
    expect(await pushTokens.forProfile('profile-ada-1')).toEqual([])
  })

  it('moves a device\'s row to the caller\'s account and profile when another account registers the same device', async () => {
    await register(ADA, 'device-install-0001', TOKEN_A)

    await register(BOB, 'device-install-0001', TOKEN_B, 'android')

    const hash = await hashOf('device-install-0001')
    expect(await pushTokens.find(hash)).toMatchObject({ token: TOKEN_B, platform: 'android', userId: 'user-bob', profileId: 'profile-bob-1' })
    expect(await pushTokens.forUser('user-ada')).toEqual([])
    expect(await pushTokens.forUser('user-bob')).toHaveLength(1)
  })

  it('keeps one row when the same device registers the same token twice', async () => {
    await register(ADA, 'device-install-0001', TOKEN_A)
    await register(ADA, 'device-install-0001', TOKEN_A)

    expect(await pushTokens.forUser('user-ada')).toHaveLength(1)
  })

  it('moves a token that another device held to the registering device: one row per token', async () => {
    await register(ADA, 'device-install-0001', TOKEN_A)

    await register(BOB, 'device-install-0002', TOKEN_A)

    expect(await pushTokens.find(await hashOf('device-install-0001'))).toBeNull()
    expect(await pushTokens.find(await hashOf('device-install-0002'))).toMatchObject({ token: TOKEN_A, userId: 'user-bob' })
    expect(await pushTokens.forUser('user-ada')).toEqual([])
  })

  it('leaves the account\'s other devices alone when one registers', async () => {
    await register(ADA, 'device-install-0001', TOKEN_A)
    await register(ADA, 'device-install-0002', TOKEN_B)

    expect((await pushTokens.forUser('user-ada')).map((row) => row.token).sort()).toEqual([TOKEN_A, TOKEN_B])
  })

  it.each([
    ['is not an Expo token', 'not-a-token'],
    ['is empty', ''],
    ['has whitespace in it', 'ExponentPushToken[abc def]'],
    ['is one character over the 256 limit', `ExponentPushToken[${'a'.repeat(238)}]`],
  ])('refuses a token that %s with 400 PUSH_TOKEN_INVALID and stores nothing', async (_label, token) => {
    const error = await errorOf(register(ADA, 'device-install-0001', token))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toMatchObject({ code: 'PUSH_TOKEN_INVALID' })
    expect(await pushTokens.find(await hashOf('device-install-0001'))).toBeNull()
  })

  it('accepts a token of exactly 256 characters', async () => {
    const token = `ExponentPushToken[${'a'.repeat(237)}]`
    expect(token).toHaveLength(256)

    await register(ADA, 'device-install-0001', token)

    expect(await pushTokens.find(await hashOf('device-install-0001'))).toMatchObject({ token })
  })

  it('does not disturb the existing row when the new token is invalid', async () => {
    await register(ADA, 'device-install-0001', TOKEN_A)

    await errorOf(register(BOB, 'device-install-0001', 'not-a-token'))

    expect(await pushTokens.find(await hashOf('device-install-0001'))).toMatchObject({ token: TOKEN_A, userId: 'user-ada' })
  })

  it('answers AUTH_REQUIRED without a signed-in caller', async () => {
    const error = await errorOf(runAs({ kind: 'public' }, () => service.register({ deviceId: 'device-install-0001', platform: 'ios', token: TOKEN_A })))

    expect(error).toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(await pushTokens.find(await hashOf('device-install-0001'))).toBeNull()
  })
})

describe('NotificationsService.unregister', () => {
  it('deletes the caller\'s own device row', async () => {
    await register(ADA, 'device-install-0001', TOKEN_A)

    await runAs(ADA, () => service.unregister({ deviceId: 'device-install-0001' }))

    expect(await pushTokens.find(await hashOf('device-install-0001'))).toBeNull()
  })

  it('leaves a device row that belongs to someone else, without an error', async () => {
    await register(ADA, 'device-install-0001', TOKEN_A)

    await runAs(BOB, () => service.unregister({ deviceId: 'device-install-0001' }))

    expect(await pushTokens.find(await hashOf('device-install-0001'))).toMatchObject({ userId: 'user-ada', token: TOKEN_A })
  })

  it('is idempotent: a device with no row is not an error, and unregistering twice is fine', async () => {
    await runAs(ADA, () => service.unregister({ deviceId: 'device-install-0001' }))
    await register(ADA, 'device-install-0001', TOKEN_A)
    await runAs(ADA, () => service.unregister({ deviceId: 'device-install-0001' }))
    await runAs(ADA, () => service.unregister({ deviceId: 'device-install-0001' }))

    expect(await pushTokens.find(await hashOf('device-install-0001'))).toBeNull()
  })

  it('deletes only the named device', async () => {
    await register(ADA, 'device-install-0001', TOKEN_A)
    await register(ADA, 'device-install-0002', TOKEN_B)

    await runAs(ADA, () => service.unregister({ deviceId: 'device-install-0001' }))

    expect((await pushTokens.forUser('user-ada')).map((row) => row.token)).toEqual([TOKEN_B])
  })

  it('answers AUTH_REQUIRED without a signed-in caller', async () => {
    const error = await errorOf(runAs({ kind: 'public' }, () => service.unregister({ deviceId: 'device-install-0001' })))

    expect(error).toMatchObject({ code: 'AUTH_REQUIRED' })
  })
})

describe('NotificationsService settings', () => {
  it('has both notifications on for an account that never changed anything, without storing a row', async () => {
    const current = await runAs(ADA, () => service.settings())

    expect(current).toMatchObject({ scanFinished: true, scanNeedsYou: true })
    expect(await settings.get('user-ada')).toBeNull()
  })

  it('turns one off and keeps the other, and a later read shows it', async () => {
    const updated = await runAs(ADA, () => service.updateSettings({ scanFinished: false }))

    expect(updated).toMatchObject({ scanFinished: false, scanNeedsYou: true })
    expect(await runAs(ADA, () => service.settings())).toMatchObject({ scanFinished: false, scanNeedsYou: true })
  })

  it('merges a second change into the first', async () => {
    await runAs(ADA, () => service.updateSettings({ scanFinished: false }))

    const updated = await runAs(ADA, () => service.updateSettings({ scanNeedsYou: false }))

    expect(updated).toMatchObject({ scanFinished: false, scanNeedsYou: false })
  })

  it('turns a notification back on', async () => {
    await runAs(ADA, () => service.updateSettings({ scanFinished: false, scanNeedsYou: false }))

    const updated = await runAs(ADA, () => service.updateSettings({ scanNeedsYou: true }))

    expect(updated).toMatchObject({ scanFinished: false, scanNeedsYou: true })
  })

  it('returns the full settings for an empty patch', async () => {
    await runAs(ADA, () => service.updateSettings({ scanNeedsYou: false }))

    expect(await runAs(ADA, () => service.updateSettings({}))).toMatchObject({ scanFinished: true, scanNeedsYou: false })
  })

  it('is per account: another account keeps the defaults, and one account\'s profiles share the settings', async () => {
    await runAs(ADA, () => service.updateSettings({ scanFinished: false }))

    expect(await runAs(BOB, () => service.settings())).toMatchObject({ scanFinished: true, scanNeedsYou: true })
    expect(await runAs(ADA_SECOND_PROFILE, () => service.settings())).toMatchObject({ scanFinished: false })
  })

  it('stamps a change with the current time', async () => {
    clock = new Date(T0.getTime() + MINUTE)

    await runAs(ADA, () => service.updateSettings({ scanFinished: false }))

    expect((await settings.get('user-ada'))!.updatedAt).toEqual(new Date(T0.getTime() + MINUTE))
  })

  it('answers AUTH_REQUIRED without a signed-in caller', async () => {
    const read = await errorOf(runAs({ kind: 'public' }, () => service.settings()))
    const write = await errorOf(runAs({ kind: 'public' }, () => service.updateSettings({ scanFinished: false })))

    expect(read).toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(write).toMatchObject({ code: 'AUTH_REQUIRED' })
  })
})

describe('NotificationsService token drops on sign-out and sign-in', () => {
  beforeEach(async () => {
    await register(ADA, 'device-install-0001', TOKEN_A)
    await register(ADA_SECOND_PROFILE, 'device-install-0002', TOKEN_B)
    await register(BOB, 'device-install-0003', TOKEN_C)
  })

  it('accountSignedOut deletes every push token of the account, on every profile, and no one else\'s', async () => {
    await runAs(ADA, () => service.accountSignedOut('user-ada'))

    expect(await pushTokens.forUser('user-ada')).toEqual([])
    expect((await pushTokens.forUser('user-bob')).map((row) => row.token)).toEqual([TOKEN_C])
  })

  it('guestSignedIn deletes the guest\'s push tokens and no one else\'s', async () => {
    await runAs(ADA, () => service.guestSignedIn('user-ada'))

    expect(await pushTokens.forUser('user-ada')).toEqual([])
    expect((await pushTokens.forUser('user-bob')).map((row) => row.token)).toEqual([TOKEN_C])
  })

  it('both are fine for an account with no tokens', async () => {
    await runAs(BOB, () => service.accountSignedOut('user-nobody'))
    await runAs(BOB, () => service.guestSignedIn('user-nobody'))

    expect(await pushTokens.forUser('user-bob')).toHaveLength(1)
  })
})
