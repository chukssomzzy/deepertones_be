import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { hmacSha256Hex } from '../../src/lib/crypto'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1PushTokensRepository } from '../../src/modules/notifications/notifications.repository'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { ProfilesService } from '../../src/modules/profiles/profiles.service'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'

// The notifications routes through the Worker's public surface, as the app uses them: the typed client against the real
// entrypoint and real local D1. A row is observed through the push tokens repository, because no route lists them. OTP codes
// are read from the ZeptoMail request the delivery job makes, as in auth.test.ts.

const OTP_QUEUE = 'deepertones-otp-delivery-development'
const ZEPTO_URL = 'https://zeptomail.test/v1.1/email'
// The one clock for fixtures: "now" is the real clock the Worker runs on, everything else is an offset from it.
const NOW = Date.now()

// Messages the Worker puts on the OTP queue. Delivery is driven by hand (see codeFor).
const queued: unknown[] = []
const WORKER_ENV = {
  ...env,
  OTP_CHANNELS: 'email',
  ZEPTOMAIL_API_URL: ZEPTO_URL,
  ZEPTOMAIL_API_KEY: 'test-key',
  OTP_DELIVERY_QUEUE: { send: async (body: unknown) => void queued.push(body) } as unknown as Queue,
}

const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) =>
  worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())

const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })
// Every API route lives under /api/v1.
const v1 = api.api.v1
const push = v1.me['push-token']
const prefs = v1.me['notification-settings']

afterEach(() => {
  vi.unstubAllGlobals()
  queued.length = 0
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per device keeps the rate limits (keyed by IP) from coupling tests to each other.
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshEmail = () => `Notifications-${runSalt}-${next()}@Example.com`
const canonical = (email: string) => email.toLowerCase()
// The push token and device id are unique per call: push_tokens.token is UNIQUE and the database is shared by every test in this file.
const freshPushToken = () => `ExponentPushToken[${runSalt}-${next()}]`
const freshDeviceId = () => `device-push-${runSalt}-${next()}`

type Tokens = { accessToken: string; refreshToken: string }
type PublicUser = { id: string; status: 'anonymous' | 'verified'; email: string | null; phone: string | null }
type Session = { tokens: Tokens; user: PublicUser }
type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; text(): Promise<string>; status: number; headers: Headers }

const read = async <T>(res: Reply) => (await res.json()) as Envelope<T>
const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = await read<T>(res)
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
const errorCodeOf = async (res: Reply) => {
  const body = await read<unknown>(res)
  if (body.success) throw new Error(`expected an error, got ${res.status}`)
  return body.error.code
}

const headers = (bearer?: string): Record<string, string> => ({
  'cf-connecting-ip': freshIp(),
  ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
})

/** One app install: its device id and the auth calls it can make. */
const newDevice = () => {
  const deviceId = `device-install-${runSalt}-${next()}`
  const platform = 'ios' as const
  return {
    deviceId,
    platform,
    bootstrap: () => v1.auth.anonymous.$post({ json: { deviceId, platform } }, { headers: headers() }),
    sendCode: (bearer: string, address: string) =>
      v1.auth.otp.send.$post({ json: { channel: 'email', address } }, { headers: headers(bearer) }),
    verifyCode: (bearer: string, address: string, code: string) =>
      v1.auth.otp.verify.$post({ json: { channel: 'email', address, code } }, { headers: headers(bearer) }),
    logout: (bearer: string) => v1.auth.logout.$post({ json: { deviceId, platform } }, { headers: headers(bearer) }),
  }
}
type Device = ReturnType<typeof newDevice>

/** A new guest session, the way an app install starts one. */
const newGuest = async () => {
  const device = newDevice()
  const res = await device.bootstrap()
  const session = await dataOf<Session>(res)
  return { device, session, accessToken: session.tokens.accessToken, userId: session.user.id }
}

/** The id of the profile the session is on, as the app reads it. */
const profileOf = async (accessToken: string) =>
  (await dataOf<{ profile: { id: string } }>(await v1.me.$get({}, { headers: headers(accessToken) }))).profile.id

/** Delivers the queued code email through the Worker's queue handler and reads the code from it. */
const codeFor = async (): Promise<string> => {
  const body = queued.pop()
  if (!body) throw new Error('no OTP delivery was queued')
  const sent: { textbody: string }[] = []
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) !== ZEPTO_URL) throw new Error(`unexpected outbound request to ${String(url)}`)
    sent.push(JSON.parse(init!.body as string))
    return Response.json({ data: [{ code: 'EM_104', message: 'ok' }], message: 'OK', request_id: 'r' })
  })
  const batch = createMessageBatch(OTP_QUEUE, [{ id: 'm', timestamp: new Date(), attempts: 1, body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, WORKER_ENV, ctx)
  expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['m'])
  vi.unstubAllGlobals()
  const code = /\b(\d{6})\b/.exec(sent[0]!.textbody)?.[1]
  if (!code) throw new Error('no code in the email')
  return code
}

/** send + deliver + verify, the way a person signs in. Returns the verify response. */
const signIn = async (device: Device, bearer: string, address: string) => {
  const sent = await device.sendCode(bearer, address)
  expect(sent.status).toBe(200)
  return device.verifyCode(bearer, address, await codeFor())
}

// Set-up shortcuts for accounts that already exist. They use the same services the Worker uses.
const db = createDb(env.DB)
const users = new UsersService({ repository: new D1UsersRepository(db) })
const profiles = new ProfilesService({ repository: new D1ProfilesRepository(db) })
const tokenService = new TokenService({ secret: env.JWT_SECRET })
const pushTokens = new D1PushTokensRepository(db)

const seedVerifiedUser = async (email: string) => {
  const guest = await users.guestForDevice(`seed-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: canonical(email) as EmailAddress })
  return user
}
/** Access token for the user's own default profile. */
const accessFor = async (user: Awaited<ReturnType<typeof seedVerifiedUser>>) =>
  (await tokenService.issue(user, (await profiles.defaultFor(user.id)).id)).accessToken

const hashOf = (deviceId: string) => hmacSha256Hex(env.DEVICE_ID_KEY, deviceId)
const rowFor = async (deviceId: string) => pushTokens.find(await hashOf(deviceId))

const register = (bearer: string | undefined, deviceId: string, token: string, platform: 'ios' | 'android' = 'ios') =>
  push.$put({ json: { deviceId, platform, token } }, { headers: headers(bearer) })
const unregister = (bearer: string | undefined, deviceId: string) =>
  push.$delete({ json: { deviceId } }, { headers: headers(bearer) })

describe('PUT /api/v1/me/push-token', () => {
  it('registers the phone for the session\'s account and profile and answers 204 with no body', async () => {
    const { accessToken, userId } = await newGuest()
    const deviceId = freshDeviceId()
    const token = freshPushToken()

    const res = await register(accessToken, deviceId, token, 'android')

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    const row = await rowFor(deviceId)
    expect(row).toMatchObject({ token, platform: 'android', userId, profileId: await profileOf(accessToken) })
    // Only a keyed hash of the device id is stored, never the id itself.
    expect(await pushTokens.find(deviceId)).toBeNull()
  })

  it('puts the phone on the profile the session names, not on the account\'s default', async () => {
    const { userId } = await newGuest()
    const second = crypto.randomUUID()
    await new D1ProfilesRepository(db).insert({ id: second, userId, displayName: null, isDefault: false, createdAt: new Date(NOW) })
    const onSecond = await tokenService.issue({ id: userId, status: 'anonymous', tokenVersion: 0 }, second)
    const deviceId = freshDeviceId()

    const res = await register(onSecond.accessToken, deviceId, freshPushToken())

    expect(res.status).toBe(204)
    expect(await rowFor(deviceId)).toMatchObject({ userId, profileId: second })
  })

  it('moves a phone to the new account when another account registers from the same device', async () => {
    const guest = await newGuest()
    const owner = await seedVerifiedUser(freshEmail())
    const ownerAccess = await accessFor(owner)
    const deviceId = freshDeviceId()
    await register(guest.accessToken, deviceId, freshPushToken())

    const token = freshPushToken()
    const res = await register(ownerAccess, deviceId, token)

    expect(res.status).toBe(204)
    expect(await rowFor(deviceId)).toMatchObject({ token, userId: owner.id, profileId: (await profiles.defaultFor(owner.id)).id })
    expect(await pushTokens.forUser(guest.userId)).toEqual([])
  })

  it('moves a token to the device that registers it, so one token is held by one device', async () => {
    const first = await newGuest()
    const second = await newGuest()
    const token = freshPushToken()
    const firstDevice = freshDeviceId()
    const secondDevice = freshDeviceId()
    await register(first.accessToken, firstDevice, token)

    const res = await register(second.accessToken, secondDevice, token)

    expect(res.status).toBe(204)
    expect(await rowFor(firstDevice)).toBeNull()
    expect(await rowFor(secondDevice)).toMatchObject({ token, userId: second.userId })
  })

  it('answers 400 PUSH_TOKEN_INVALID for a token that is not an Expo push token, and stores nothing', async () => {
    const { accessToken } = await newGuest()
    const deviceId = freshDeviceId()

    const res = await register(accessToken, deviceId, 'not-an-expo-token')

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('PUSH_TOKEN_INVALID')
    expect(await rowFor(deviceId)).toBeNull()
  })

  it('accepts the shortest device id (16 characters) and the longest token (256 characters)', async () => {
    const { accessToken } = await newGuest()
    const deviceId = `${runSalt}-${next()}-`.padEnd(16, 'x')
    const prefix = `ExponentPushToken[${runSalt}${next()}`
    const token = `${prefix}${'a'.repeat(255 - prefix.length)}]`
    expect(deviceId).toHaveLength(16)
    expect(token).toHaveLength(256)

    const res = await register(accessToken, deviceId, token)

    expect(res.status).toBe(204)
    expect(await rowFor(deviceId)).toMatchObject({ token })
  })

  it.each([
    ['a device id of 15 characters', { deviceId: 'x'.repeat(15), platform: 'ios', token: 'ExponentPushToken[abc]' }],
    ['an unknown platform', { deviceId: 'x'.repeat(20), platform: 'web', token: 'ExponentPushToken[abc]' }],
    ['a token over 256 characters', { deviceId: 'x'.repeat(20), platform: 'ios', token: `ExponentPushToken[${'a'.repeat(238)}]` }],
    ['no token', { deviceId: 'x'.repeat(20), platform: 'ios' }],
    ['a token that is not a string', { deviceId: 'x'.repeat(20), platform: 'ios', token: 42 }],
  ])('answers 400 VALIDATION_FAILED for %s', async (_label, json) => {
    const { accessToken } = await newGuest()

    const res = await push.$put({ json: json as never }, { headers: headers(accessToken) })

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
  })

  it('answers 401 AUTH_REQUIRED without a bearer token, and stores nothing', async () => {
    const deviceId = freshDeviceId()

    const res = await register(undefined, deviceId, freshPushToken())

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    expect(await rowFor(deviceId)).toBeNull()
  })
})

describe('DELETE /api/v1/me/push-token', () => {
  it('removes the caller\'s phone and answers 204, and answers 204 again when it is already gone', async () => {
    const { accessToken } = await newGuest()
    const deviceId = freshDeviceId()
    await register(accessToken, deviceId, freshPushToken())

    const first = await unregister(accessToken, deviceId)
    const again = await unregister(accessToken, deviceId)

    expect(first.status).toBe(204)
    expect(await first.text()).toBe('')
    expect(again.status).toBe(204)
    expect(await rowFor(deviceId)).toBeNull()
  })

  it('answers 204 for a device that never registered', async () => {
    const { accessToken } = await newGuest()

    const res = await unregister(accessToken, freshDeviceId())

    expect(res.status).toBe(204)
  })

  it('leaves a phone that belongs to another account, and still answers 204', async () => {
    const owner = await newGuest()
    const stranger = await newGuest()
    const deviceId = freshDeviceId()
    const token = freshPushToken()
    await register(owner.accessToken, deviceId, token)

    const res = await unregister(stranger.accessToken, deviceId)

    expect(res.status).toBe(204)
    expect(await rowFor(deviceId)).toMatchObject({ token, userId: owner.userId })
  })

  it('answers 400 VALIDATION_FAILED for a device id under 16 characters', async () => {
    const { accessToken } = await newGuest()

    const res = await unregister(accessToken, 'x'.repeat(15))

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
  })

  it('answers 401 AUTH_REQUIRED without a bearer token', async () => {
    const res = await unregister(undefined, freshDeviceId())

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })
})

describe('notification settings', () => {
  const getSettings = (bearer?: string) => prefs.$get({}, { headers: headers(bearer) })
  const patchSettings = (bearer: string | undefined, json: Record<string, unknown>) =>
    prefs.$patch({ json: json as never }, { headers: headers(bearer) })

  it('GET answers both notifications on for an account that never changed anything', async () => {
    const { accessToken } = await newGuest()

    const res = await getSettings(accessToken)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ scanFinished: true, scanNeedsYou: true })
  })

  it('PATCH changes one switch, answers the full settings, and GET then shows them', async () => {
    const { accessToken } = await newGuest()

    const res = await patchSettings(accessToken, { scanFinished: false })

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ scanFinished: false, scanNeedsYou: true })
    expect(await dataOf(await getSettings(accessToken))).toEqual({ scanFinished: false, scanNeedsYou: true })
  })

  it('PATCH merges a second change into the first, and can turn a switch back on', async () => {
    const { accessToken } = await newGuest()
    await patchSettings(accessToken, { scanFinished: false })

    const both = await dataOf(await patchSettings(accessToken, { scanNeedsYou: false }))
    const back = await dataOf(await patchSettings(accessToken, { scanFinished: true }))

    expect(both).toEqual({ scanFinished: false, scanNeedsYou: false })
    expect(back).toEqual({ scanFinished: true, scanNeedsYou: false })
  })

  it('keeps settings per account', async () => {
    const changed = await newGuest()
    const other = await newGuest()
    await patchSettings(changed.accessToken, { scanFinished: false, scanNeedsYou: false })

    expect(await dataOf(await getSettings(other.accessToken))).toEqual({ scanFinished: true, scanNeedsYou: true })
  })

  it.each([
    ['an empty body', {}],
    ['a switch that is not a boolean', { scanFinished: 'no' }],
  ])('PATCH answers 400 VALIDATION_FAILED for %s', async (_label, json) => {
    const { accessToken } = await newGuest()

    const res = await patchSettings(accessToken, json)

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
  })

  it('answers 401 AUTH_REQUIRED without a bearer token', async () => {
    const got = await getSettings()
    const write = await patchSettings(undefined, { scanFinished: false })

    expect(got.status).toBe(401)
    expect(await errorCodeOf(got)).toBe('AUTH_REQUIRED')
    expect(write.status).toBe(401)
    expect(await errorCodeOf(write)).toBe('AUTH_REQUIRED')
  })
})

describe('push tokens when someone signs out or in', () => {
  it('logout deletes every push token of the account, on all its phones, and no other account\'s', async () => {
    const owner = await seedVerifiedUser(freshEmail())
    const ownerAccess = await accessFor(owner)
    const stranger = await newGuest()
    const phone1 = freshDeviceId()
    const phone2 = freshDeviceId()
    const strangerPhone = freshDeviceId()
    await register(ownerAccess, phone1, freshPushToken())
    await register(ownerAccess, phone2, freshPushToken())
    await register(stranger.accessToken, strangerPhone, freshPushToken())

    const res = await newDevice().logout(ownerAccess)

    expect(res.status).toBe(200)
    expect(await rowFor(phone1)).toBeNull()
    expect(await rowFor(phone2)).toBeNull()
    expect(await pushTokens.forUser(owner.id)).toEqual([])
    expect(await rowFor(strangerPhone)).toMatchObject({ userId: stranger.userId })
  })

  it('a phone can register again under the guest that logout hands it', async () => {
    const owner = await seedVerifiedUser(freshEmail())
    const ownerAccess = await accessFor(owner)
    const device = newDevice()
    const phone = freshDeviceId()
    const token = freshPushToken()
    await register(ownerAccess, phone, token)

    const fresh = await dataOf<Session>(await device.logout(ownerAccess))
    const res = await register(fresh.tokens.accessToken, phone, token)

    expect(res.status).toBe(204)
    expect(await rowFor(phone)).toMatchObject({ token, userId: fresh.user.id })
  })

  it('a guest signing in to an existing account loses its push token, and the account keeps its own', async () => {
    const owner = await seedVerifiedUser(freshEmail())
    const ownerAccess = await accessFor(owner)
    const ownerPhone = freshDeviceId()
    await register(ownerAccess, ownerPhone, freshPushToken())
    const guest = await newGuest()
    const guestPhone = freshDeviceId()
    await register(guest.accessToken, guestPhone, freshPushToken())

    const res = await signIn(guest.device, guest.accessToken, owner.email!)

    expect(res.status).toBe(200)
    expect((await dataOf<Session>(res)).user.id).toBe(owner.id)
    expect(await rowFor(guestPhone)).toBeNull()
    expect(await pushTokens.forUser(guest.userId)).toEqual([])
    expect(await rowFor(ownerPhone)).toMatchObject({ userId: owner.id })
  })

  it('a guest promoted in place keeps its push token', async () => {
    const guest = await newGuest()
    const phone = freshDeviceId()
    const token = freshPushToken()
    await register(guest.accessToken, phone, token)

    const res = await signIn(guest.device, guest.accessToken, freshEmail())

    expect(res.status).toBe(200)
    expect((await dataOf<Session>(res)).user.id).toBe(guest.userId)
    expect(await rowFor(phone)).toMatchObject({ token, userId: guest.userId })
  })

  it('a verified user signing in again with their own address keeps their push tokens', async () => {
    const owner = await seedVerifiedUser(freshEmail())
    const ownerAccess = await accessFor(owner)
    const phone = freshDeviceId()
    await register(ownerAccess, phone, freshPushToken())

    const res = await signIn(newDevice(), ownerAccess, owner.email!)

    expect(res.status).toBe(200)
    expect(await rowFor(phone)).toMatchObject({ userId: owner.id })
  })
})
