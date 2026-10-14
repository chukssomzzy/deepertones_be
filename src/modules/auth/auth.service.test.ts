import { beforeEach, describe, expect, it } from 'vitest'
import { hmacSha256Hex } from '../../lib/crypto'
import { runAs } from '../../lib/context'
import { MemoryEmailSender } from '../../providers/email/memory.email'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryOtpDelivery } from '../../providers/otp-delivery/memory.otp-delivery'
import { FakeOtpRepository } from '../otp/otp.repository.fake'
import { OtpService } from '../otp/otp.service'
import { FakeUsersRepository } from '../users/users.repository.fake'
import { UsersService } from '../users/users.service'
import { AuthService } from './auth.service'
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
let usersService: UsersService
let tokens: TokenService
let n: number

const at = (msAfterT0: number) => {
  clock = new Date(T0.getTime() + msAfterT0)
}

const buildAuth = (deviceIdKey = DEVICE_KEY, repository = users) => {
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
  return { auth: new AuthService({ users: usersSvc, otp, tokens, deviceIdKey, now: () => clock }), usersSvc }
}

beforeEach(() => {
  clock = T0
  n = 0
  users = new FakeUsersRepository()
  tokens = new TokenService({ secret: JWT_SECRET, now: () => clock })
  const built = buildAuth()
  auth = built.auth
  usersService = built.usersSvc
})

let auth: AuthService

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
    const ghost = await tokens.issue({ id: 'no-such-user', status: 'anonymous', tokenVersion: 0 })

    expect(await errorOf(auth.refresh(ghost.refreshToken))).toMatchObject({ code: 'TOKEN_INVALID' })
  })

  it('answers TOKEN_INVALID for garbage and for an access token', async () => {
    const session = await auth.bootstrap('device-1', 'ios')

    expect(await errorOf(auth.refresh('not.a.jwt'))).toMatchObject({ code: 'TOKEN_INVALID' })
    expect(await errorOf(auth.refresh(session.tokens.accessToken))).toMatchObject({ code: 'TOKEN_INVALID' })
  })
})

describe('AuthService.verifyOtp', () => {
  it('promotes the calling guest in place, and its earlier refresh token stops working', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const actor = { kind: 'user', userId: guest.user.id, status: 'anonymous' } as const

    const session = await runAs(actor, async () => {
      await auth.sendOtp({ channel: 'email', address: 'Ada@Example.com' })
      return auth.verifyOtp({ channel: 'email', address: 'Ada@Example.com' }, CODE)
    })

    expect(session.user).toMatchObject({ id: guest.user.id, status: 'verified', email: 'ada@example.com' })
    expect(await errorOf(auth.refresh(guest.tokens.refreshToken))).toMatchObject({ code: 'TOKEN_INVALID' })
    await expect(auth.refresh(session.tokens.refreshToken)).resolves.toMatchObject({ user: { id: guest.user.id } })
  })
})

describe('AuthService.logout', () => {
  it('invalidates the user\'s refresh tokens and returns a fresh guest for the device', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    const actor = { kind: 'user', userId: guest.user.id, status: 'anonymous' } as const

    const fresh = await runAs(actor, () => auth.logout('device-1', 'ios'))

    expect(await errorOf(auth.refresh(guest.tokens.refreshToken))).toMatchObject({ code: 'TOKEN_INVALID' })
    expect(fresh.user.id).not.toBe(guest.user.id)
    expect(fresh.user.status).toBe('anonymous')
  })
})

describe('AuthService account linking and switching', () => {
  const email = (address: string) => ({ channel: 'email', address }) as const

  it('refuses a verified caller an unowned address in sendOtp and verifyOtp, with no code consumed', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    await usersService.promote(guest.user.id, { kind: 'email', email: 'ada@example.com' as never })
    const actor = { kind: 'user', userId: guest.user.id, status: 'anonymous' } as const // stale token: still says guest

    const sendError = await errorOf(runAs(actor, () => auth.sendOtp(email('new@example.com'))))
    const verifyError = await errorOf(runAs(actor, () => auth.verifyOtp(email('new@example.com'), CODE)))

    expect(sendError).toMatchObject({ code: 'ACCOUNT_LINKING_UNAVAILABLE' })
    expect(verifyError).toMatchObject({ code: 'ACCOUNT_LINKING_UNAVAILABLE' })
  })

  it('lets a verified caller sign in again with their own address', async () => {
    const guest = await auth.bootstrap('device-1', 'ios')
    await usersService.promote(guest.user.id, { kind: 'email', email: 'ada@example.com' as never })
    const actor = { kind: 'user', userId: guest.user.id, status: 'verified' } as const

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
    const actor = { kind: 'user', userId: guest.user.id, status: 'anonymous' } as const

    const session = await runAs(actor, async () => {
      await auth.sendOtp(email('ada@example.com'))
      return auth.verifyOtp(email('ada@example.com'), CODE)
    })

    expect(session.user.id).toBe(owner.user.id)
    expect(await errorOf(auth.refresh(guest.tokens.refreshToken))).toMatchObject({ code: 'TOKEN_INVALID' })
  })
})
