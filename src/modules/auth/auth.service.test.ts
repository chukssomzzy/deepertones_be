import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hmacSha256Hex } from '../../lib/crypto'
import { runAs } from '../../lib/context'
import { signJwt } from '../../lib/jwt'
import { MemoryEmailSender } from '../../providers/email/memory.email'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryOtpDelivery } from '../../providers/otp-delivery/memory.otp-delivery'
import { MemoryPushSender } from '../../providers/push/memory.push'
import { FakeNotificationSettingsRepository } from '../notifications/notification-settings.repository.fake'
import { type SendPushMessage, sendPushSpec } from '../notifications/notifications.job-specs'
import { NotificationsService } from '../notifications/notifications.service'
import { FakePushTokensRepository } from '../notifications/push-tokens.repository.fake'
import { FakeOtpRepository } from '../otp/otp.repository.fake'
import { OtpService } from '../otp/otp.service'
import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import { ProfilesService } from '../profiles/profiles.service'
import { FakeUsersRepository } from '../users/users.repository.fake'
import { UsersService } from '../users/users.service'
import { AuthService, type Session } from './auth.service'
import type { RoutineTrigger } from '../routines/routines.trigger'
import { REFRESH_TTL_SECONDS, TokenService } from './tokens.service'

// The one clock every test hangs off; fixtures are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const DAY = 24 * 60 * 60 * SECOND

const DEVICE_KEY = 'device-key-a'
const CODE = '482913'
const PEPPER = 'test-pepper'
const JWT_SECRET = 'test-jwt-secret'

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

let clock: Date
let users: FakeUsersRepository
let profilesRepo: FakeProfilesRepository
let pushTokens: FakePushTokensRepository
let pushJobs: MemoryJobQueue
let usersService: UsersService
let tokens: TokenService
let n: number

const at = (msAfterT0: number) => {
  clock = new Date(T0.getTime() + msAfterT0)
}

const buildAuth = (deviceIdKey = DEVICE_KEY, repository = users, onRoutineTrigger?: RoutineTrigger) => {
  const usersSvc = new UsersService({ repository, now: () => clock, newId: () => `user-${++n}` })
  const otp = new OtpService({
    repository: new FakeOtpRepository(),
    jobs: new MemoryJobQueue(),
    pepper: PEPPER,
    channels: ['email'],
    email: new MemoryEmailSender(),
    whatsapp: new MemoryOtpDelivery(),
    now: () => clock,
    generateCode: () => CODE,
  })
  const profiles = new ProfilesService({ repository: profilesRepo })
  const notifications = new NotificationsService({ pushTokens, settings: new FakeNotificationSettingsRepository(), push: new MemoryPushSender(), jobs: pushJobs, deviceIdKey, now: () => clock })
  return { auth: new AuthService({ users: usersSvc, profiles, otp, tokens, notifications, deviceIdKey, now: () => clock, ...(onRoutineTrigger ? { onRoutineTrigger } : {}) }), usersSvc, notifications }
}

beforeEach(() => {
  clock = T0
  n = 0
  profilesRepo = new FakeProfilesRepository()
  pushTokens = new FakePushTokensRepository()
  pushJobs = new MemoryJobQueue()
  users = new FakeUsersRepository({ profiles: profilesRepo })
  tokens = new TokenService({ secret: JWT_SECRET, now: () => clock })
  const built = buildAuth()
  auth = built.auth
  usersService = built.usersSvc
  notifications = built.notifications
})

let auth: AuthService
let notifications: NotificationsService

describe('AuthService secrets', () => {
  it('keeps the device id key out of the service when it is spread or listed', () => {
    const { auth } = buildAuth()

    const spread = { ...auth }
    expect(Object.keys(spread)).toContain('tokens')
    expect(Object.values(spread)).not.toContain(DEVICE_KEY)
  })
})

// The id of the profile a guest got when it was created: the one its tokens should name.
const defaultOf = async (userId: string) => (await profilesRepo.defaultFor(userId))!.id
/** A second profile for the user, as a later feature will make one (there is no way to make one yet). */
const addProfile = async (userId: string, id: string) => {
  await profilesRepo.insert({ id, userId, displayName: null, isDefault: false, createdAt: new Date(T0.getTime() + SECOND) })
  return id
}
/** The signed-in actor a request carries: the user, and the profile the request's access token named (the default unless given). */
const actorOf = async (userId: string, status: 'anonymous' | 'verified' = 'anonymous', profileId?: string) =>
  ({ kind: 'user', userId, status, profileId: profileId ?? (await defaultOf(userId)) }) as const
/** The profile ids named by the two tokens of a session. */
const profilesOf = async (session: Session) => {
  const access = await tokens.verifyAccess(session.tokens.accessToken)
  const refresh = await tokens.verifyRefresh(session.tokens.refreshToken)
  if (!access.ok || !refresh.ok) throw new Error('session tokens did not verify')
  return { access: access.profileId, refresh: refresh.profileId }
}

describe('AuthService.bootstrap', () => {
  it('gives the same guest to the same device and a different one to another device', async () => {
    const first = await auth.bootstrap('device-1', 'ios')
    const again = await auth.bootstrap('device-1', 'ios')
    const other = await auth.bootstrap('device-2', 'android')

    expect(first.user).toMatchObject({ status: 'anonymous', email: null, phone: null })
    expect(again.user.id).toBe(first.user.id)
    expect(other.user.id).not.toBe(first.user.id)
  })

  it('stores only a keyed hash of the device id: HMAC(deviceIdKey, deviceId), never the raw id', async () => {
    const session = await auth.bootstrap('device-1', 'ios')

    const hash = await hmacSha256Hex(DEVICE_KEY, 'device-1')
    expect(hash).not.toBe('device-1')
    expect(await users.findDevice(hash)).toMatchObject({ deviceHash: hash, userId: session.user.id, platform: 'ios' })
    expect(await users.findDevice('device-1')).toBeNull()
  })

  it('maps one device id to different guests under different device id keys', async () => {
    const { auth: other } = buildAuth('device-key-b')

    const a = await auth.bootstrap('device-1', 'ios')
    const b = await other.bootstrap('device-1', 'ios')

    expect(b.user.id).not.toBe(a.user.id)
    expect(await users.findDevice(await hmacSha256Hex('device-key-b', 'device-1'))).toMatchObject({ userId: b.user.id })
  })

  it('never hands a verified account to a device id: a new guest is created instead', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    await usersService.promote(guest.user.id, { kind: 'email', email: 'ada@example.com' as never })

    const again = await auth.bootstrap('device-1', 'ios')

    expect(again.user.id).not.toBe(guest.user.id)
    expect(again.user.status).toBe('anonymous')
  })
})

describe('AuthService.bootstrap: the profile', () => {
  it('names the guest\'s default profile in both tokens', async () => {
    const session = await auth.bootstrap('device-1', 'ios')

    const profile = await profilesRepo.defaultFor(session.user.id)
    expect(profile).not.toBeNull()
    expect(await profilesOf(session)).toEqual({ access: profile!.id, refresh: profile!.id })
  })

  it('names the same profile each time the same device comes back', async () => {
    const first = await auth.bootstrap('device-1', 'ios')
    const again = await auth.bootstrap('device-1', 'ios')

    expect((await profilesOf(again)).access).toBe((await profilesOf(first)).access)
  })

  it('names a different profile for a different device', async () => {
    const first = await auth.bootstrap('device-1', 'ios')
    const other = await auth.bootstrap('device-2', 'ios')

    expect((await profilesOf(other)).access).not.toBe((await profilesOf(first)).access)
  })
})

describe('AuthService.refresh', () => {
  it('returns a new token pair for the same user, with a refresh token good for another 60 days from now (sliding)', async () => {
    const session = await auth.bootstrap('device-1', 'ios')
    at(30 * DAY)

    const refreshed = await auth.refresh(session.tokens.refreshToken)

    expect(refreshed.user.id).toBe(session.user.id)
    expect(refreshed.tokens.refreshExpiresAt).toEqual(new Date(T0.getTime() + 30 * DAY + REFRESH_TTL_SECONDS * SECOND))
  })

  it('works one second before the refresh token expires (60 days after issue)', async () => {
    const session = await auth.bootstrap('device-1', 'ios')
    at(60 * DAY - SECOND)

    await expect(auth.refresh(session.tokens.refreshToken)).resolves.toMatchObject({ user: { id: session.user.id } })
  })

  it('answers TOKEN_EXPIRED one second after the refresh token expires', async () => {
    const session = await auth.bootstrap('device-1', 'ios')
    at(60 * DAY + SECOND)

    expect(await errorOf(auth.refresh(session.tokens.refreshToken))).toMatchObject({ code: 'TOKEN_EXPIRED' })
  })

  it('answers TOKEN_INVALID after the user\'s token version was bumped (logout everywhere)', async () => {
    const session = await auth.bootstrap('device-1', 'ios')
    await usersService.bumpTokenVersion(session.user.id)

    expect(await errorOf(auth.refresh(session.tokens.refreshToken))).toMatchObject({ code: 'TOKEN_INVALID' })
  })

  it('answers TOKEN_INVALID for a token whose user does not exist', async () => {
    const ghost = await tokens.issue({ id: 'no-such-user', status: 'anonymous', tokenVersion: 0 }, 'no-such-profile')

    expect(await errorOf(auth.refresh(ghost.refreshToken))).toMatchObject({ code: 'TOKEN_INVALID' })
  })

  it('answers TOKEN_INVALID for garbage and for an access token', async () => {
    const session = await auth.bootstrap('device-1', 'ios')

    expect(await errorOf(auth.refresh('not.a.jwt'))).toMatchObject({ code: 'TOKEN_INVALID' })
    expect(await errorOf(auth.refresh(session.tokens.accessToken))).toMatchObject({ code: 'TOKEN_INVALID' })
  })
})

describe('AuthService.refresh: the profile', () => {
  const refreshTokenWith = (userId: string, pid: string | undefined) =>
    signJwt({ sub: userId, ver: 0, typ: 'refresh', ...(pid === undefined ? {} : { pid }) }, { secret: JWT_SECRET, expiresInSeconds: REFRESH_TTL_SECONDS, now: clock })

  it('keeps the profile the refresh token names, in both new tokens, when it is one of the user\'s', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const second = await addProfile(guest.user.id, 'profile-second')
    const issued = await tokens.issue(guest.user, second)

    const refreshed = await auth.refresh(issued.refreshToken)

    expect(await profilesOf(refreshed)).toEqual({ access: second, refresh: second })
  })

  it('keeps the default profile for a session that is on the default', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    await addProfile(guest.user.id, 'profile-second')

    const refreshed = await auth.refresh(guest.tokens.refreshToken)

    expect(await profilesOf(refreshed)).toEqual({ access: await defaultOf(guest.user.id), refresh: await defaultOf(guest.user.id) })
  })

  it.each([
    ['has no profile (a token from before profiles)', (_other: string) => undefined],
    ['names a profile that does not exist', (_other: string) => 'no-such-profile'],
    ['names another user\'s profile', (other: string) => other],
  ])('gives the default profile when the refresh token %s', async (_label, pidFor) => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const stranger = await auth.bootstrap('device-2', 'android')
    const token = await refreshTokenWith(guest.user.id, pidFor(await defaultOf(stranger.user.id)))

    const refreshed = await auth.refresh(token)

    expect(refreshed.user.id).toBe(guest.user.id)
    const expected = await defaultOf(guest.user.id)
    expect(await profilesOf(refreshed)).toEqual({ access: expected, refresh: expected })
  })
})

describe('AuthService.verifyOtp', () => {
  it('promotes the calling guest in place, and its earlier refresh token stops working', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const actor = await actorOf(guest.user.id)

    const session = await runAs(actor, async () => {
      await auth.sendOtp({ channel: 'email', address: 'Ada@Example.com' })
      return auth.verifyOtp({ channel: 'email', address: 'Ada@Example.com' }, CODE)
    })

    expect(session.user).toMatchObject({ id: guest.user.id, status: 'verified', email: 'ada@example.com' })
    expect(await errorOf(auth.refresh(guest.tokens.refreshToken))).toMatchObject({ code: 'TOKEN_INVALID' })
    await expect(auth.refresh(session.tokens.refreshToken)).resolves.toMatchObject({ user: { id: guest.user.id } })
  })
})

describe('AuthService.verifyOtp: the profile', () => {
  it('keeps the profile the caller was on when a guest is promoted, even when it is not the default', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const second = await addProfile(guest.user.id, 'profile-second')
    const actor = await actorOf(guest.user.id, 'anonymous', second)

    const session = await runAs(actor, async () => {
      await auth.sendOtp({ channel: 'email', address: 'ada@example.com' })
      return auth.verifyOtp({ channel: 'email', address: 'ada@example.com' }, CODE)
    })

    expect(session.user.id).toBe(guest.user.id)
    expect(await profilesOf(session)).toEqual({ access: second, refresh: second })
  })

  it('signs a guest that switches to an existing account in on that account\'s default profile, not the guest\'s', async () => {
    const owner = await auth.bootstrap('device-owner', 'ios')
    await usersService.promote(owner.user.id, { kind: 'email', email: 'ada@example.com' as never })
    await addProfile(owner.user.id, 'profile-owner-second')
    const guest = await auth.bootstrap('device-1', 'ios')
    const actor = await actorOf(guest.user.id)

    const session = await runAs(actor, async () => {
      await auth.sendOtp({ channel: 'email', address: 'ada@example.com' })
      return auth.verifyOtp({ channel: 'email', address: 'ada@example.com' }, CODE)
    })

    const ownerDefault = await defaultOf(owner.user.id)
    expect(session.user.id).toBe(owner.user.id)
    expect(ownerDefault).not.toBe(actor.profileId)
    expect(await profilesOf(session)).toEqual({ access: ownerDefault, refresh: ownerDefault })
  })
})

describe('AuthService.logout', () => {
  it('invalidates the user\'s refresh tokens and returns a fresh guest for the device', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const actor = await actorOf(guest.user.id)

    const fresh = await runAs(actor, () => auth.logout('device-1', 'ios'))

    expect(await errorOf(auth.refresh(guest.tokens.refreshToken))).toMatchObject({ code: 'TOKEN_INVALID' })
    expect(fresh.user.id).not.toBe(guest.user.id)
    expect(fresh.user.status).toBe('anonymous')
  })
})

describe('AuthService.logout: the profile', () => {
  it('hands the device a fresh guest with a default profile of its own, named in the new tokens', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const actor = await actorOf(guest.user.id)

    const fresh = await runAs(actor, () => auth.logout('device-1', 'ios'))

    const freshDefault = await profilesRepo.defaultFor(fresh.user.id)
    expect(freshDefault).not.toBeNull()
    expect(freshDefault!.id).not.toBe(actor.profileId)
    expect(await profilesOf(fresh)).toEqual({ access: freshDefault!.id, refresh: freshDefault!.id })
  })
})

describe('AuthService.me', () => {
  it('returns the user, the profile the session is on, and all the user\'s profiles with the default first', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const first = await defaultOf(guest.user.id)
    const second = await addProfile(guest.user.id, 'profile-second')

    const onDefault = await runAs(await actorOf(guest.user.id), () => auth.me())
    const onSecond = await runAs(await actorOf(guest.user.id, 'anonymous', second), () => auth.me())

    expect(onDefault.user).toMatchObject({ id: guest.user.id, status: 'anonymous' })
    expect(onDefault.profile).toMatchObject({ id: first, userId: guest.user.id, isDefault: true, displayName: null })
    expect(onDefault.profiles.map((p) => p.id)).toEqual([first, second])
    expect(onSecond.profile).toMatchObject({ id: second, isDefault: false })
    expect(onSecond.profiles.map((p) => p.id)).toEqual([first, second])
  })

  it.each([
    ['does not exist', async (_stranger: string) => 'no-such-profile'],
    ['belongs to another user', async (stranger: string) => defaultOf(stranger)],
  ])('answers TOKEN_EXPIRED, so the app refreshes, when the session\'s profile %s', async (_label, profileFor) => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const stranger = await auth.bootstrap('device-2', 'android')
    const actor = await actorOf(guest.user.id, 'anonymous', await profileFor(stranger.user.id))

    const error = await errorOf(runAs(actor, () => auth.me()))

    expect(error).toMatchObject({ code: 'TOKEN_EXPIRED' })
  })
})

describe('AuthService account linking and switching', () => {
  const email = (address: string) => ({ channel: 'email', address }) as const

  it('refuses a verified caller an unowned address in sendOtp and verifyOtp, with no code consumed', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    await usersService.promote(guest.user.id, { kind: 'email', email: 'ada@example.com' as never })
    const actor = await actorOf(guest.user.id) // stale token: still says guest

    const sendError = await errorOf(runAs(actor, () => auth.sendOtp(email('new@example.com'))))
    const verifyError = await errorOf(runAs(actor, () => auth.verifyOtp(email('new@example.com'), CODE)))

    expect(sendError).toMatchObject({ code: 'ACCOUNT_LINKING_UNAVAILABLE' })
    expect(verifyError).toMatchObject({ code: 'ACCOUNT_LINKING_UNAVAILABLE' })
  })

  it('lets a verified caller sign in again with their own address', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    await usersService.promote(guest.user.id, { kind: 'email', email: 'ada@example.com' as never })
    const actor = await actorOf(guest.user.id, 'verified')

    const session = await runAs(actor, async () => {
      await auth.sendOtp(email('ada@example.com'))
      return auth.verifyOtp(email('ada@example.com'), CODE)
    })

    expect(session.user.id).toBe(guest.user.id)
  })

  it('retires the refresh token of a guest that switches to an existing account', async () => {
    const owner = await auth.bootstrap('device-owner', 'ios')
    await usersService.promote(owner.user.id, { kind: 'email', email: 'ada@example.com' as never })
    const guest = await auth.bootstrap('device-1', 'ios')
    const actor = await actorOf(guest.user.id)

    const session = await runAs(actor, async () => {
      await auth.sendOtp(email('ada@example.com'))
      return auth.verifyOtp(email('ada@example.com'), CODE)
    })

    expect(session.user.id).toBe(owner.user.id)
    expect(await errorOf(auth.refresh(guest.tokens.refreshToken))).toMatchObject({ code: 'TOKEN_INVALID' })
  })
})

describe('AuthService and push tokens', () => {
  const email = (address: string) => ({ channel: 'email', address }) as const
  const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'
  const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]'
  const TOKEN_C = 'ExponentPushToken[cccccccccccccccccccccc]'

  /** A phone registering its token the way the app does, as the given signed-in actor. */
  const registerPhone = (actor: Awaited<ReturnType<typeof actorOf>>, deviceId: string, token: string, platform: 'ios' | 'android' = 'ios') =>
    runAs(actor, () => notifications.register({ deviceId, platform, token }))
  const tokensOf = async (userId: string) => (await pushTokens.forUser(userId)).map((row) => row.token).sort()

  /** A verified account that owns `address`, as it is after a past sign-in. */
  const verifiedOwner = async (address: string) => {
    const owner = await auth.bootstrap('device-owner', 'ios')
    await usersService.promote(owner.user.id, { kind: 'email', email: address as never })
    return owner.user.id
  }

  it('logout deletes every push token of the account, on all its profiles and devices, and no other account\'s', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const second = await addProfile(guest.user.id, 'profile-second')
    const stranger = await auth.bootstrap('device-2', 'android')
    await registerPhone(await actorOf(guest.user.id), 'device-phone-1', TOKEN_A)
    await registerPhone(await actorOf(guest.user.id, 'anonymous', second), 'device-phone-2', TOKEN_B)
    await registerPhone(await actorOf(stranger.user.id), 'device-phone-3', TOKEN_C)

    await runAs(await actorOf(guest.user.id), () => auth.logout('device-1', 'ios'))

    expect(await tokensOf(guest.user.id)).toEqual([])
    expect(await tokensOf(stranger.user.id)).toEqual([TOKEN_C])
  })

  it('a guest signing in to an existing account loses its push tokens, and the account keeps its own', async () => {
    const ownerId = await verifiedOwner('ada@example.com')
    await registerPhone(await actorOf(ownerId, 'verified'), 'device-owner-phone', TOKEN_A)
    const guest = await auth.bootstrap('device-1', 'ios')
    const actor = await actorOf(guest.user.id)
    await registerPhone(actor, 'device-phone-1', TOKEN_B)

    const session = await runAs(actor, async () => {
      await auth.sendOtp(email('ada@example.com'))
      return auth.verifyOtp(email('ada@example.com'), CODE)
    })

    expect(session.user.id).toBe(ownerId)
    expect(await tokensOf(guest.user.id)).toEqual([])
    expect(await tokensOf(ownerId)).toEqual([TOKEN_A])
  })

  it('a guest that is promoted in place keeps its push token on the same account and profile', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const actor = await actorOf(guest.user.id)
    await registerPhone(actor, 'device-phone-1', TOKEN_A)

    await runAs(actor, async () => {
      await auth.sendOtp(email('ada@example.com'))
      return auth.verifyOtp(email('ada@example.com'), CODE)
    })

    expect(await pushTokens.forUser(guest.user.id)).toMatchObject([{ token: TOKEN_A, userId: guest.user.id, profileId: actor.profileId }])
  })

  it('a verified user signing in again with their own address keeps their push tokens', async () => {
    const ownerId = await verifiedOwner('ada@example.com')
    const actor = await actorOf(ownerId, 'verified')
    await registerPhone(actor, 'device-phone-1', TOKEN_A)
    await registerPhone(actor, 'device-phone-2', TOKEN_B)

    const session = await runAs(actor, async () => {
      await auth.sendOtp(email('ada@example.com'))
      return auth.verifyOtp(email('ada@example.com'), CODE)
    })

    expect(session.user.id).toBe(ownerId)
    expect(await tokensOf(ownerId)).toEqual([TOKEN_A, TOKEN_B])
  })

  it('a code that fails leaves the guest\'s push token alone', async () => {
    const ownerId = await verifiedOwner('ada@example.com')
    const guest = await auth.bootstrap('device-1', 'ios')
    const actor = await actorOf(guest.user.id)
    await registerPhone(actor, 'device-phone-1', TOKEN_A)

    const error = await errorOf(
      runAs(actor, async () => {
        await auth.sendOtp(email('ada@example.com'))
        return auth.verifyOtp(email('ada@example.com'), '000000')
      }),
    )

    expect(error.code).toBeDefined()
    expect(await tokensOf(guest.user.id)).toEqual([TOKEN_A])
    expect(await tokensOf(ownerId)).toEqual([])
  })
})

describe('AuthService.verifyOtp: the new sign-in alert', () => {
  const email = (address: string) => ({ channel: 'email', address }) as const
  const TOKEN_OWNER = 'ExponentPushToken[oooooooooooooooooooooo]'
  const TOKEN_GUEST = 'ExponentPushToken[gggggggggggggggggggggg]'
  const alerts = () => pushJobs.enqueued.map((e) => e.body as SendPushMessage)

  const verifiedOwner = async (address: string) => {
    const owner = await auth.bootstrap('device-owner', 'ios')
    await usersService.promote(owner.user.id, { kind: 'email', email: address as never })
    return owner.user.id
  }
  const signIn = (actor: Awaited<ReturnType<typeof actorOf>>, address: string, code = CODE) =>
    runAs(actor, async () => {
      await auth.sendOtp(email(address))
      return auth.verifyOtp(email(address), code)
    })

  it('alerts the account signed in to, once, with the platform of the guest\'s phone and the instant of the sign-in', async () => {
    const ownerId = await verifiedOwner('ada@example.com')
    const guest = await auth.bootstrap('device-1', 'ios')
    const actor = await actorOf(guest.user.id)
    // The guest's phone is an Android one; the owner's own phone is an iPhone, so the platform can only have come from the guest's row.
    await runAs(await actorOf(ownerId, 'verified'), () => notifications.register({ deviceId: 'device-owner-phone', platform: 'ios', token: TOKEN_OWNER }))
    await runAs(actor, () => notifications.register({ deviceId: 'device-guest-phone', platform: 'android', token: TOKEN_GUEST }))
    at(7 * SECOND)

    await signIn(actor, 'ada@example.com')

    expect(alerts()).toEqual([{ kind: 'new-sign-in', userId: ownerId, platform: 'android', eventId: expect.any(String), at: T0.getTime() + 7 * SECOND }])
    expect(pushJobs.enqueued[0]!.job).toBe('send-push')
    expect(sendPushSpec.key(alerts()[0]!)).toBe(`new-sign-in:${(alerts()[0] as { eventId: string }).eventId}`)
  })

  it('alerts with no platform when the guest had no phone registered', async () => {
    const ownerId = await verifiedOwner('ada@example.com')
    const guest = await auth.bootstrap('device-1', 'ios')

    await signIn(await actorOf(guest.user.id), 'ada@example.com')

    expect(alerts()).toEqual([{ kind: 'new-sign-in', userId: ownerId, platform: null, eventId: expect.any(String), at: T0.getTime() }])
  })

  it('alerts again, as a separate notification, for a second sign-in to the same account', async () => {
    await verifiedOwner('ada@example.com')
    const first = await auth.bootstrap('device-1', 'ios')
    const second = await auth.bootstrap('device-2', 'ios')

    await signIn(await actorOf(first.user.id), 'ada@example.com')
    // Past the cooldown between codes to one address.
    at(10 * 60 * SECOND)
    await signIn(await actorOf(second.user.id), 'ada@example.com')

    const keys = alerts().map((body) => sendPushSpec.key(body))
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
  })

  it('does not alert when a guest is promoted in place', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const actor = await actorOf(guest.user.id)
    await runAs(actor, () => notifications.register({ deviceId: 'device-guest-phone', platform: 'ios', token: TOKEN_GUEST }))

    await signIn(actor, 'ada@example.com')

    expect(alerts()).toEqual([])
  })

  it('does not alert when a verified user signs in again with their own address', async () => {
    const ownerId = await verifiedOwner('ada@example.com')

    await signIn(await actorOf(ownerId, 'verified'), 'ada@example.com')

    expect(alerts()).toEqual([])
  })

  it('does not alert when the code is wrong', async () => {
    await verifiedOwner('ada@example.com')
    const guest = await auth.bootstrap('device-1', 'ios')

    const error = await errorOf(signIn(await actorOf(guest.user.id), 'ada@example.com', '000000'))

    expect(error.code).toBeDefined()
    expect(alerts()).toEqual([])
  })

  it('still signs the guest in to the account when the alert cannot be queued', async () => {
    const ownerId = await verifiedOwner('ada@example.com')
    const guest = await auth.bootstrap('device-1', 'ios')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    pushJobs.failNextWith(new Error('queue is down'))

    const session = await signIn(await actorOf(guest.user.id), 'ada@example.com')

    expect(session.user.id).toBe(ownerId)
    logged.mockRestore()
  })
})

// The routine's first build (spec #189, PR 3c): a guest who verifies is promoted in place, and that is the moment the profile's routine is first asked for.
// The host only knows the trigger as `onRoutineTrigger?: RoutineTrigger` (routines.trigger.ts, a leaf file): it never imports the routines service. The hook is
// called as (profileId, 'first', 'first'): the profile the promoted session is on, the reason, and the request key; and a failing hook changes nothing for the caller.
describe('AuthService.verifyOtp: the routine trigger', () => {
  const email = (address: string) => ({ channel: 'email', address }) as const
  let trigger: ReturnType<typeof vi.fn<RoutineTrigger>>
  let triggered: AuthService
  let triggeredUsers: UsersService

  const signIn = (actor: Awaited<ReturnType<typeof actorOf>>, address: string, code = CODE) =>
    runAs(actor, async () => {
      await triggered.sendOtp(email(address))
      return triggered.verifyOtp(email(address), code)
    })

  beforeEach(() => {
    trigger = vi.fn<RoutineTrigger>(async () => undefined)
    const built = buildAuth(DEVICE_KEY, users, trigger)
    triggered = built.auth
    triggeredUsers = built.usersSvc
  })

  it('asks for the first routine of the profile the guest was on, for reason first with the key first, when the guest is promoted in place', async () => {
    const guest = await triggered.bootstrap('device-1', 'ios')

    const session = await signIn(await actorOf(guest.user.id), 'ada@example.com')

    expect(session.user.status).toBe('verified')
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveBeenCalledWith(await defaultOf(guest.user.id), 'first', 'first')
  })

  it('names the profile the caller was on when it is not the default one, because that is the profile the promoted session stays on', async () => {
    const guest = await triggered.bootstrap('device-1', 'ios')
    const second = await addProfile(guest.user.id, 'profile-second')

    const session = await signIn(await actorOf(guest.user.id, 'anonymous', second), 'ada@example.com')

    expect(await profilesOf(session)).toEqual({ access: second, refresh: second })
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveBeenCalledWith(second, 'first', 'first')
    expect(second).not.toBe(await defaultOf(guest.user.id))
  })

  it('does not ask when a guest signs in as an existing account: that account\'s routine is already its own', async () => {
    const owner = await triggered.bootstrap('device-owner', 'ios')
    await triggeredUsers.promote(owner.user.id, { kind: 'email', email: 'ada@example.com' as never })
    const guest = await triggered.bootstrap('device-1', 'ios')

    await signIn(await actorOf(guest.user.id), 'ada@example.com')

    expect(trigger).not.toHaveBeenCalled()
  })

  it('does not ask when a verified user signs in again with their own address', async () => {
    const owner = await triggered.bootstrap('device-owner', 'ios')
    await triggeredUsers.promote(owner.user.id, { kind: 'email', email: 'ada@example.com' as never })

    await signIn(await actorOf(owner.user.id, 'verified'), 'ada@example.com')

    expect(trigger).not.toHaveBeenCalled()
  })

  it('does not ask when the code is wrong, since nobody was promoted', async () => {
    const guest = await triggered.bootstrap('device-1', 'ios')

    const error = await errorOf(signIn(await actorOf(guest.user.id), 'ada@example.com', '000000'))

    expect(error.code).toBeDefined()
    expect(trigger).not.toHaveBeenCalled()
  })

  it.each([
    ['rejects', () => Promise.reject(new Error('the routine queue is down'))],
    ['throws at once', () => {
      throw new Error('the routine queue is down')
    }],
  ])('still promotes the guest and answers with the new session when the hook %s', async (_how, fail) => {
    const guest = await triggered.bootstrap('device-1', 'ios')
    trigger.mockImplementation(fail)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const session = await signIn(await actorOf(guest.user.id), 'ada@example.com')

    expect(trigger).toHaveBeenCalledTimes(1)
    expect(session.user).toMatchObject({ id: guest.user.id, status: 'verified', email: 'ada@example.com' })
    await expect(triggered.refresh(session.tokens.refreshToken)).resolves.toMatchObject({ user: { id: guest.user.id } })
  })

  it('works with no hook wired at all, as before', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')

    const session = await runAs(await actorOf(guest.user.id), async () => {
      await auth.sendOtp(email('ada@example.com'))
      return auth.verifyOtp(email('ada@example.com'), CODE)
    })

    expect(session.user.status).toBe('verified')
  })
})
