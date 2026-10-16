import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { signJwt } from '../../src/lib/jwt'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { markedJpeg } from '../../src/modules/scans/scans.photos.fake'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'

// Profiles through the Worker's public surface, as the app sees them: the typed client against the real entrypoint and
// real local D1. Every account has one default profile from the moment it exists; the active profile travels in the
// session tokens as the `pid` claim and is shown by GET /me. There is no route to make a second profile, so the tests that
// need one insert it through the profiles repository, the way a future "add profile" feature would.
// (Which scans a profile may see, and the shared daily quota, are in scans.routes.test.ts, next to the scan helpers.)

const OTP_QUEUE = 'deepertones-otp-delivery-development'
const ZEPTO_URL = 'https://zeptomail.test/v1.1/email'
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
// The one clock for fixtures: "now" is the real clock the Worker runs on, everything else is an offset from it.
const NOW = Date.now()
const ACCESS_TTL_SECONDS = 15 * 60
const REFRESH_TTL_SECONDS = 60 * 24 * 60 * 60

// Messages the Worker puts on its queues. OTP delivery is driven by hand (see codeFor); scan jobs are only recorded.
const queued: unknown[] = []
const WORKER_ENV = {
  ...env,
  OTP_CHANNELS: 'email',
  ZEPTOMAIL_API_URL: ZEPTO_URL,
  ZEPTOMAIL_API_KEY: 'test-key',
  OTP_DELIVERY_QUEUE: { send: async (body: unknown) => void queued.push(body) } as unknown as Queue,
  SCAN_ITEMS_QUEUE: { send: async () => {} } as unknown as Queue,
}

const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) =>
  worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())

const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })

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
const freshEmail = () => `Profiles-${runSalt}-${next()}@Example.com`
const canonical = (email: string) => email.toLowerCase()

type Tokens = { accessToken: string; refreshToken: string }
type PublicUser = { id: string; status: 'anonymous' | 'verified'; email: string | null; phone: string | null }
type Session = { tokens: Tokens; user: PublicUser }
type ProfileView = { id: string; displayName: string | null; isDefault: boolean; createdAt: string }
type MeView = { user: PublicUser; profile: ProfileView; profiles: ProfileView[] }
type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number; headers: Headers }

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
const sessionOf = (res: Reply) => dataOf<Session>(res)

/** The claims of a JWT as the app could read them: decoded, not verified. */
const claimsOf = (jwt: string): Record<string, unknown> => {
  const payload = jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(payload))
}
const pidOf = (jwt: string) => claimsOf(jwt).pid

/** One app install: its device id, its IP, and the calls it can make. */
const newDevice = (ip = freshIp()) => {
  const deviceId = `device-profiles-${runSalt}-${next()}`
  const platform = 'ios' as const
  const headers = (bearer?: string): Record<string, string> => ({
    'cf-connecting-ip': ip,
    ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
  })
  return {
    deviceId,
    headers,
    bootstrap: () => api.auth.anonymous.$post({ json: { deviceId, platform } }, { headers: headers() }),
    sendCode: (bearer: string, address: string) =>
      api.auth.otp.send.$post({ json: { channel: 'email', address } }, { headers: headers(bearer) }),
    verifyCode: (bearer: string, address: string, code: string) =>
      api.auth.otp.verify.$post({ json: { channel: 'email', address, code } }, { headers: headers(bearer) }),
    refresh: (refreshToken: string) => api.auth.refresh.$post({ json: { refreshToken } }, { headers: headers() }),
    logout: (bearer: string) => api.auth.logout.$post({ json: { deviceId, platform } }, { headers: headers(bearer) }),
    me: (bearer: string) => api.me.$get({}, { headers: headers(bearer) }),
    createScan: (bearer: string) =>
      api.scans.$post({ form: { photos: [new File([markedJpeg(next()).bytes], 'p.jpg', { type: 'image/jpeg' })] } }, { headers: headers(bearer) }),
    getScan: (bearer: string, scanId: string) => api.scans[':scanId'].$get({ param: { scanId } }, { headers: headers(bearer) }),
  }
}
type Device = ReturnType<typeof newDevice>

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
  const code = /\b(\d{4})\b/.exec(sent[0]!.textbody)?.[1]
  if (!code) throw new Error('no code in the email')
  return code
}

/** send + deliver + verify, the way a person signs in. Returns the verify response. */
const signIn = async (device: Device, bearer: string, address: string) => {
  const sent = await device.sendCode(bearer, address)
  expect(sent.status).toBe(200)
  return device.verifyCode(bearer, address, await codeFor())
}

// Set-up shortcuts for what the product has no route for.
const db = createDb(env.DB)
const users = new UsersService({ repository: new D1UsersRepository(db) })
const usersRepository = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)
const tokenService = new TokenService({ secret: env.JWT_SECRET })

/** A verified account that already exists, as someone who signed up on another phone would have. */
const seedVerifiedUser = async (email: string) => {
  const guest = await users.guestForDevice(`seed-profiles-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: canonical(email) as EmailAddress })
  return user
}

/** A second profile on an existing account (there is no route for it yet), made the way a future "add profile" would. */
const addProfile = async (userId: string) => {
  const profile = { id: crypto.randomUUID(), userId, displayName: null, isDefault: false, createdAt: new Date(NOW + MINUTE) }
  await profiles.insert(profile)
  return profile
}

// Tokens as an app installed before profiles existed would still hold them: no `pid` claim. Signed with the real secret.
const oldAccessToken = (userId: string, version = 0) =>
  signJwt({ sub: userId, ver: version, st: 'anonymous', typ: 'access' }, { secret: env.JWT_SECRET, expiresInSeconds: ACCESS_TTL_SECONDS, now: new Date(NOW) })
const refreshTokenWith = (claims: Record<string, unknown>) =>
  signJwt({ typ: 'refresh', ...claims }, { secret: env.JWT_SECRET, expiresInSeconds: REFRESH_TTL_SECONDS, now: new Date(NOW) })

describe('a new guest', () => {
  it('has a default profile from the first launch: its tokens carry the profile id', async () => {
    const device = newDevice()

    const { tokens, user } = await sessionOf(await device.bootstrap())

    const me = await dataOf<MeView>(await device.me(tokens.accessToken))
    expect(pidOf(tokens.accessToken)).toEqual(expect.any(String))
    expect(pidOf(tokens.accessToken)).toBe(me.profile.id)
    expect(pidOf(tokens.refreshToken)).toBe(me.profile.id)
    expect(me.user.id).toBe(user.id)
  })

  it('answers GET /me with the user, the active profile and the list of profiles', async () => {
    const device = newDevice()
    const { tokens, user } = await sessionOf(await device.bootstrap())

    const res = await device.me(tokens.accessToken)

    expect(res.status).toBe(200)
    const me = await dataOf<MeView>(res)
    expect(me.user).toEqual({ id: user.id, status: 'anonymous', email: null, phone: null })
    const profile = { id: pidOf(tokens.accessToken), displayName: null, isDefault: true, createdAt: expect.any(String) }
    expect(me.profile).toEqual(profile)
    expect(me.profiles).toEqual([profile])
    expect(Math.abs(Date.parse(me.profile.createdAt) - NOW)).toBeLessThan(5 * MINUTE)
  })

  it('gets the same profile when the same device starts a session again, and another profile on another device', async () => {
    const a = newDevice()
    const b = newDevice()

    const first = await sessionOf(await a.bootstrap())
    const again = await sessionOf(await a.bootstrap())
    const other = await sessionOf(await b.bootstrap())

    expect(pidOf(again.tokens.accessToken)).toBe(pidOf(first.tokens.accessToken))
    expect(pidOf(other.tokens.accessToken)).not.toBe(pidOf(first.tokens.accessToken))
  })

  it('gets a profile of its own after signing out everywhere, for the fresh guest', async () => {
    const device = newDevice()
    const first = await sessionOf(await device.bootstrap())

    const fresh = await sessionOf(await device.logout(first.tokens.accessToken))

    const me = await dataOf<MeView>(await device.me(fresh.tokens.accessToken))
    expect(me.user.id).toBe(fresh.user.id)
    expect(me.user.id).not.toBe(first.user.id)
    expect(me.profile.id).toBe(pidOf(fresh.tokens.accessToken))
    expect(me.profile.id).not.toBe(pidOf(first.tokens.accessToken))
    expect(me.profile.isDefault).toBe(true)
  })
})

describe('GET /me with a profile', () => {
  it('shows the profile named in the token as the active one, and lists the default profile first', async () => {
    const device = newDevice()
    const { user, tokens } = await sessionOf(await device.bootstrap())
    const second = await addProfile(user.id)
    const { accessToken } = await tokenService.issue({ id: user.id, status: 'anonymous', tokenVersion: 0 }, second.id)

    const me = await dataOf<MeView>(await device.me(accessToken))

    expect(me.profile).toEqual({ id: second.id, displayName: null, isDefault: false, createdAt: new Date(second.createdAt).toISOString() })
    expect(me.profiles.map((p) => [p.id, p.isDefault])).toEqual([[pidOf(tokens.accessToken), true], [second.id, false]])
  })

  it('answers 401 TOKEN_EXPIRED to an access token from before profiles existed (no pid)', async () => {
    const device = newDevice()
    const { user } = await sessionOf(await device.bootstrap())

    const res = await device.me(await oldAccessToken(user.id))

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('TOKEN_EXPIRED')
  })

  it('answers 401 TOKEN_EXPIRED when the token names a profile that is not the user\'s own', async () => {
    const mine = newDevice()
    const theirs = newDevice()
    const me = await sessionOf(await mine.bootstrap())
    const them = await sessionOf(await theirs.bootstrap())
    const { accessToken } = await tokenService.issue({ id: me.user.id, status: 'anonymous', tokenVersion: 0 }, pidOf(them.tokens.accessToken) as string)

    const res = await mine.me(accessToken)

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('TOKEN_EXPIRED')
  })
})

describe('POST /auth/refresh with a profile', () => {
  it('keeps the profile: the new tokens carry the same pid', async () => {
    const device = newDevice()
    const session = await sessionOf(await device.bootstrap())

    const refreshed = await sessionOf(await device.refresh(session.tokens.refreshToken))

    expect(pidOf(refreshed.tokens.accessToken)).toBe(pidOf(session.tokens.accessToken))
    expect(pidOf(refreshed.tokens.refreshToken)).toBe(pidOf(session.tokens.accessToken))
  })

  it('keeps a profile that is not the default, when it belongs to the user', async () => {
    const device = newDevice()
    const { user } = await sessionOf(await device.bootstrap())
    const second = await addProfile(user.id)
    const { refreshToken } = await tokenService.issue({ id: user.id, status: 'anonymous', tokenVersion: 0 }, second.id)

    const refreshed = await sessionOf(await device.refresh(refreshToken))

    expect(pidOf(refreshed.tokens.accessToken)).toBe(second.id)
    expect(pidOf(refreshed.tokens.refreshToken)).toBe(second.id)
    expect((await dataOf<MeView>(await device.me(refreshed.tokens.accessToken))).profile.id).toBe(second.id)
  })

  it('gives a refresh token from before profiles existed (no pid) the default profile, and the new access token works', async () => {
    const device = newDevice()
    const { user, tokens } = await sessionOf(await device.bootstrap())
    const old = await refreshTokenWith({ sub: user.id, ver: 0 })

    const refreshed = await sessionOf(await device.refresh(old))

    expect(pidOf(refreshed.tokens.accessToken)).toBe(pidOf(tokens.accessToken))
    expect(pidOf(refreshed.tokens.refreshToken)).toBe(pidOf(tokens.accessToken))
    const me = await dataOf<MeView>(await device.me(refreshed.tokens.accessToken))
    expect(me.profile.id).toBe(pidOf(tokens.accessToken))
  })

  it('moves an app from before profiles existed over without logging it out: expired access token, then refresh, then /me', async () => {
    const device = newDevice()
    const { user, tokens } = await sessionOf(await device.bootstrap())

    expect((await device.me(await oldAccessToken(user.id))).status).toBe(401)
    const refreshed = await sessionOf(await device.refresh(await refreshTokenWith({ sub: user.id, ver: 0 })))

    const me = await device.me(refreshed.tokens.accessToken)
    expect(me.status).toBe(200)
    expect((await dataOf<MeView>(me)).profile.id).toBe(pidOf(tokens.accessToken))
  })

  it('falls back to the caller\'s own default profile when the token names another user\'s profile', async () => {
    const mine = newDevice()
    const theirs = newDevice()
    const me = await sessionOf(await mine.bootstrap())
    const them = await sessionOf(await theirs.bootstrap())
    const foreign = await refreshTokenWith({ sub: me.user.id, ver: 0, pid: pidOf(them.tokens.accessToken) })

    const refreshed = await sessionOf(await mine.refresh(foreign))

    expect(refreshed.user.id).toBe(me.user.id)
    expect(pidOf(refreshed.tokens.accessToken)).toBe(pidOf(me.tokens.accessToken))
    expect(pidOf(refreshed.tokens.refreshToken)).toBe(pidOf(me.tokens.accessToken))
  })

  it('falls back to the caller\'s own default profile when the token names a profile that does not exist', async () => {
    const device = newDevice()
    const me = await sessionOf(await device.bootstrap())
    const unknown = await refreshTokenWith({ sub: me.user.id, ver: 0, pid: crypto.randomUUID() })

    const refreshed = await sessionOf(await device.refresh(unknown))

    expect(pidOf(refreshed.tokens.accessToken)).toBe(pidOf(me.tokens.accessToken))
  })
})

describe('a guest that verifies', () => {
  it('keeps the same profile, and can still read the scan it made as a guest', async () => {
    const device = newDevice()
    const guest = await sessionOf(await device.bootstrap())
    const profileBefore = (await dataOf<MeView>(await device.me(guest.tokens.accessToken))).profile
    const scan = await dataOf<{ id: string }>(await device.createScan(guest.tokens.accessToken))

    const verified = await sessionOf(await signIn(device, guest.tokens.accessToken, freshEmail()))

    expect(verified.user).toMatchObject({ id: guest.user.id, status: 'verified' })
    expect(pidOf(verified.tokens.accessToken)).toBe(profileBefore.id)
    expect(pidOf(verified.tokens.refreshToken)).toBe(profileBefore.id)
    const me = await dataOf<MeView>(await device.me(verified.tokens.accessToken))
    expect(me.profile).toEqual(profileBefore)
    expect(me.profiles).toEqual([profileBefore])
    const shown = await device.getScan(verified.tokens.accessToken, scan.id)
    expect(shown.status).toBe(200)
    expect((await dataOf<{ id: string }>(shown)).id).toBe(scan.id)
  })

  it('lands in the existing account\'s own default profile when it signs in to that account, not in the guest\'s', async () => {
    const owner = await seedVerifiedUser(freshEmail())
    const ownerProfile = (await profiles.defaultFor(owner.id))!
    const device = newDevice()
    const guest = await sessionOf(await device.bootstrap())
    const guestProfileId = pidOf(guest.tokens.accessToken)

    const session = await sessionOf(await signIn(device, guest.tokens.accessToken, owner.email!))

    expect(session.user.id).toBe(owner.id)
    expect(guestProfileId).not.toBe(ownerProfile.id)
    expect(pidOf(session.tokens.accessToken)).toBe(ownerProfile.id)
    expect(pidOf(session.tokens.refreshToken)).toBe(ownerProfile.id)
    const me = await dataOf<MeView>(await device.me(session.tokens.accessToken))
    expect(me.user.id).toBe(owner.id)
    expect(me.profile.id).toBe(ownerProfile.id)
    expect(me.profiles.map((p) => p.id)).toEqual([ownerProfile.id])
  })
})

describe('the daily guest cleanup', () => {
  const seenAgo = (days: number) => new Date(NOW - days * DAY)

  it('deletes the profile of a guest it purges, and keeps the profile of a guest it does not', async () => {
    const stale = newDevice()
    const recent = newDevice()
    const staleSession = await sessionOf(await stale.bootstrap())
    const recentSession = await sessionOf(await recent.bootstrap())
    const stalePid = pidOf(staleSession.tokens.accessToken) as string
    const recentPid = pidOf(recentSession.tokens.accessToken) as string
    // A guest the app has abandoned for over 90 days (its device is linked to a newer guest), and one abandoned only 10 days ago.
    await usersRepository.touch(staleSession.user.id, seenAgo(120))
    await usersRepository.unlinkDevices(staleSession.user.id)
    await usersRepository.touch(recentSession.user.id, seenAgo(10))
    await usersRepository.unlinkDevices(recentSession.user.id)
    expect(await profiles.findById(stalePid)).not.toBeNull()

    const ctx = createExecutionContext()
    await worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron: '17 3 * * *' }), env, ctx)
    await waitOnExecutionContext(ctx)

    expect(await usersRepository.findById(staleSession.user.id)).toBeNull()
    expect(await profiles.findById(stalePid)).toBeNull()
    expect(await profiles.ofUser(staleSession.user.id)).toEqual([])
    expect(await usersRepository.findById(recentSession.user.id)).not.toBeNull()
    expect(await profiles.findById(recentPid)).not.toBeNull()
  })
})
