import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import worker, { type AppType } from '../../src/index'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { ProfilesService } from '../../src/modules/profiles/profiles.service'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'

// The Worker's public surface, as the app uses it: the typed client against the real entrypoint and
// real local D1. OTP codes are read from the ZeptoMail request the delivery job makes.

const OTP_QUEUE = 'deepertones-otp-delivery-development'
const ZEPTO_URL = 'https://zeptomail.test/v1.1/email'
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
// The one clock for hand-made tokens: "now" is the real clock the Worker runs on, fixtures are offsets.
const NOW = Date.now()

// Messages the Worker puts on the OTP queue. Delivery is driven by hand (see codeFor), as in otp.background.test.ts.
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

// Miniflare's rate-limit windows are aligned to the wall clock (epoch = floor(now / 60 s)), so a test that
// spends part of a budget and straddles a minute boundary sees its counter reset and never reaches 429.
// Rate-limit tests call this first: it waits for the next window when fewer than SAFE_WINDOW_MS remain.
const RATE_WINDOW_MS = 60 * 1000
const SAFE_WINDOW_MS = 20 * 1000
const RATE_TEST_TIMEOUT_MS = RATE_WINDOW_MS + 30 * 1000
const startOfRateWindow = async () => {
  const remaining = RATE_WINDOW_MS - (Date.now() % RATE_WINDOW_MS)
  if (remaining < SAFE_WINDOW_MS) await new Promise((resolve) => setTimeout(resolve, remaining + 50))
}
const freshEmail = () => `Auth-${runSalt}-${next()}@Example.com`
const canonical = (email: string) => email.toLowerCase()

type Tokens = { accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string }
type PublicUser = { id: string; status: 'anonymous' | 'verified'; email: string | null; phone: string | null }
type Session = { tokens: Tokens; user: PublicUser }
type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }

/** The parsed envelope plus the response, so a test can read headers as well as the body. */
type Reply = { json(): Promise<unknown>; status: number; headers: Headers }
const read = async <T>(res: Reply) => ({ res, body: (await res.json()) as Envelope<T> })

const sessionOf = async (res: Reply): Promise<Session> => {
  const { body } = await read<Session>(res)
  if (!body.success) throw new Error(`expected a session, got ${res.status} ${body.error.code}`)
  return body.data
}

const errorCodeOf = async (res: Reply) => {
  const { body } = await read<unknown>(res)
  if (body.success) throw new Error(`expected an error, got ${res.status}`)
  return body.error.code
}

/** One app install: its device id, its IP, and the calls it can make. */
const newDevice = (ip = freshIp()) => {
  const deviceId = `device-install-${runSalt}-${next()}`
  const platform = 'ios' as const
  const headers = (bearer?: string): Record<string, string> => ({
    'cf-connecting-ip': ip,
    ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
  })
  return {
    deviceId,
    platform,
    ip,
    headers,
    bootstrap: () => api.auth.anonymous.$post({ json: { deviceId, platform } }, { headers: headers() }),
    sendCode: (bearer: string, address: string) =>
      api.auth.otp.send.$post({ json: { channel: 'email', address } }, { headers: headers(bearer) }),
    verifyCode: (bearer: string, address: string, code: string) =>
      api.auth.otp.verify.$post({ json: { channel: 'email', address, code } }, { headers: headers(bearer) }),
    refresh: (refreshToken: string, bearer?: string) =>
      api.auth.refresh.$post({ json: { refreshToken } }, { headers: headers(bearer) }),
    logout: (bearer: string) => api.auth.logout.$post({ json: { deviceId, platform } }, { headers: headers(bearer) }),
    me: (bearer?: string) => api.me.$get({}, { headers: headers(bearer) }),
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

// Set-up shortcuts for accounts that already exist. They use the same services the Worker uses (a
// second code for one address inside the 60 s OTP cooldown cannot be requested in a test).
const users = new UsersService({ repository: new D1UsersRepository(createDb(env.DB)) })
const tokenService = new TokenService({ secret: env.JWT_SECRET })

const seedVerifiedUser = async (email: string) => {
  const guest = await users.guestForDevice(`seed-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: canonical(email) as EmailAddress })
  return user
}
const profiles = new ProfilesService({ repository: new D1ProfilesRepository(createDb(env.DB)) })
// Tokens for the user's own default profile, so they work against routes that read the profile.
const tokensFor = async (user: Awaited<ReturnType<typeof seedVerifiedUser>>) => tokenService.issue(user, (await profiles.defaultFor(user.id)).id)

describe('POST /auth/anonymous', () => {
  it('returns the same guest for the same device id, and a different guest for another device', async () => {
    const a = newDevice()
    const b = newDevice()

    const first = await sessionOf(await a.bootstrap())
    const again = await sessionOf(await a.bootstrap())
    const other = await sessionOf(await b.bootstrap())

    expect(first.user).toEqual({ id: expect.any(String), status: 'anonymous', email: null, phone: null })
    expect(again.user.id).toBe(first.user.id)
    expect(other.user.id).not.toBe(first.user.id)
  })

  it('returns a token pair with ISO expiry times 15 minutes and 60 days out', async () => {
    const { tokens } = await sessionOf(await newDevice().bootstrap())

    expect(tokens.accessToken).toEqual(expect.any(String))
    expect(tokens.refreshToken).not.toBe(tokens.accessToken)
    expect(Date.parse(tokens.accessExpiresAt) - NOW).toBeGreaterThan(14 * MINUTE)
    expect(Date.parse(tokens.accessExpiresAt) - NOW).toBeLessThan(16 * MINUTE)
    expect(Date.parse(tokens.refreshExpiresAt) - NOW).toBeGreaterThan(60 * DAY - MINUTE)
    expect(Date.parse(tokens.refreshExpiresAt) - NOW).toBeLessThan(60 * DAY + MINUTE)
  })

  it('rejects a missing device id and an unknown platform with 400 VALIDATION_FAILED', async () => {
    const headers = { 'cf-connecting-ip': freshIp() }

    const noDevice = await api.auth.anonymous.$post({ json: { deviceId: '', platform: 'ios' } }, { headers })
    const badPlatform = await api.auth.anonymous.$post({ json: { deviceId: 'x', platform: 'web' as 'ios' } }, { headers })

    expect(noDevice.status).toBe(400)
    expect(await errorCodeOf(noDevice)).toBe('VALIDATION_FAILED')
    expect(badPlatform.status).toBe(400)
  })
})

describe('GET /me', () => {
  it('returns the guest for a valid access token', async () => {
    const device = newDevice()
    const session = await sessionOf(await device.bootstrap())

    const res = await device.me(session.tokens.accessToken)

    expect(res.status).toBe(200)
    const { body } = await read<PublicUser>(res)
    expect(body).toMatchObject({ success: true, data: { user: { id: session.user.id, status: 'anonymous', email: null, phone: null } } })
  })

  it('answers 401 AUTH_REQUIRED without a token', async () => {
    const res = await newDevice().me()

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('answers 401 TOKEN_INVALID for a garbage bearer token', async () => {
    const res = await newDevice().me('not.a.jwt')

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('TOKEN_INVALID')
  })

  it('answers 401 TOKEN_EXPIRED for an access token past its 15 minutes', async () => {
    const device = newDevice()
    const session = await sessionOf(await device.bootstrap())
    const old = await new TokenService({ secret: env.JWT_SECRET, now: () => new Date(NOW - 16 * MINUTE) }).issue(
      {
        id: session.user.id,
        status: 'anonymous',
        tokenVersion: 0,
      },
      (await profiles.defaultFor(session.user.id)).id,
    )

    const res = await device.me(old.accessToken)

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('TOKEN_EXPIRED')
  })

  it('refuses a refresh token used as a bearer with 401 TOKEN_INVALID', async () => {
    const device = newDevice()
    const session = await sessionOf(await device.bootstrap())

    const res = await device.me(session.tokens.refreshToken)

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('TOKEN_INVALID')
  })
})

describe('promoting a guest by OTP', () => {
  it('verifies the same user in place with the canonical email, invalidates the old refresh token, and never lets the device id unlock the verified account', async () => {
    const device = newDevice()
    const guest = await sessionOf(await device.bootstrap())
    const address = freshEmail()

    const res = await signIn(device, guest.tokens.accessToken, address)

    expect(res.status).toBe(200)
    const verified = await sessionOf(res)
    expect(verified.user).toEqual({ id: guest.user.id, status: 'verified', email: canonical(address), phone: null })
    const me = await read<PublicUser>(await device.me(verified.tokens.accessToken))
    expect(me.body).toMatchObject({ success: true, data: { user: { id: guest.user.id, status: 'verified' } } })

    const stale = await device.refresh(guest.tokens.refreshToken)
    expect(stale.status).toBe(401)
    expect(await errorCodeOf(stale)).toBe('TOKEN_INVALID')

    const fresh = await sessionOf(await device.bootstrap())
    expect(fresh.user.id).not.toBe(guest.user.id)
    expect(fresh.user.status).toBe('anonymous')
  })

  it('signs a guest in as the existing owner of an address, leaves the guest row alone, and unlinks its device', async () => {
    const owner = await seedVerifiedUser(freshEmail())
    const device = newDevice()
    const guest = await sessionOf(await device.bootstrap())

    const res = await signIn(device, guest.tokens.accessToken, owner.email!.toUpperCase())

    expect(res.status).toBe(200)
    const session = await sessionOf(res)
    expect(session.user).toEqual({ id: owner.id, status: 'verified', email: owner.email, phone: null })

    const guestStill = await read<PublicUser>(await device.me(guest.tokens.accessToken))
    expect(guestStill.body).toMatchObject({ success: true, data: { user: { id: guest.user.id, status: 'anonymous' } } })

    const afterwards = await sessionOf(await device.bootstrap())
    expect(afterwards.user.id).not.toBe(guest.user.id)
    expect(afterwards.user.id).not.toBe(owner.id)
    expect(afterwards.user.status).toBe('anonymous')
  })

  it('lets a verified user sign in again with their own email, getting their own session (no 409)', async () => {
    const owner = await seedVerifiedUser(freshEmail())
    const device = newDevice()
    const { accessToken } = await tokensFor(owner)

    const res = await signIn(device, accessToken, owner.email!)

    expect(res.status).toBe(200)
    expect((await sessionOf(res)).user).toMatchObject({ id: owner.id, status: 'verified', email: owner.email })
  })

  it('requires a bearer token to send and to verify a code', async () => {
    const device = newDevice()

    const send = await device.sendCode(undefined as unknown as string, freshEmail())
    const verify = await device.verifyCode(undefined as unknown as string, freshEmail(), '123456')

    expect(send.status).toBe(401)
    expect(await errorCodeOf(send)).toBe('AUTH_REQUIRED')
    expect(verify.status).toBe(401)
    expect(await errorCodeOf(verify)).toBe('AUTH_REQUIRED')
  })

  it('returns the challenge id and expiry on send, and passes OTP errors through', async () => {
    const device = newDevice()
    const { tokens } = await sessionOf(await device.bootstrap())
    const address = freshEmail()

    const sent = await device.sendCode(tokens.accessToken, address)
    const cooldown = await device.sendCode(tokens.accessToken, address)
    const invalid = await device.sendCode(tokens.accessToken, 'not-an-email')

    expect(sent.status).toBe(200)
    expect((await read<{ challengeId: string; expiresAt: string }>(sent)).body).toMatchObject({
      success: true,
      data: { challengeId: expect.any(String), expiresAt: expect.any(String) },
    })
    expect(cooldown.status).toBe(429)
    expect(await errorCodeOf(cooldown)).toBe('OTP_COOLDOWN')
    expect(invalid.status).toBe(400)
    expect(await errorCodeOf(invalid)).toBe('INVALID_EMAIL')
  })
})

describe('POST /auth/refresh', () => {
  it('returns a new token pair for the same user', async () => {
    const device = newDevice()
    const session = await sessionOf(await device.bootstrap())

    const res = await device.refresh(session.tokens.refreshToken)

    expect(res.status).toBe(200)
    const refreshed = await sessionOf(res)
    expect(refreshed.user.id).toBe(session.user.id)
    expect(refreshed.tokens.accessToken).toEqual(expect.any(String))
    const me = await read<PublicUser>(await device.me(refreshed.tokens.accessToken))
    expect(me.body).toMatchObject({ success: true, data: { user: { id: session.user.id } } })
  })

  it('is not blocked by an expired or garbage Authorization header', async () => {
    const device = newDevice()
    const session = await sessionOf(await device.bootstrap())
    const expired = await new TokenService({ secret: env.JWT_SECRET, now: () => new Date(NOW - DAY) }).issue(
      {
        id: session.user.id,
        status: 'anonymous',
        tokenVersion: 0,
      },
      (await profiles.defaultFor(session.user.id)).id,
    )

    const withExpired = await device.refresh(session.tokens.refreshToken, expired.accessToken)
    const withGarbage = await device.refresh(session.tokens.refreshToken, 'garbage')

    expect(withExpired.status).toBe(200)
    expect(withGarbage.status).toBe(200)
  })

  it('answers 401 TOKEN_INVALID for garbage, for an access token, and for an unknown user', async () => {
    const device = newDevice()
    const session = await sessionOf(await device.bootstrap())
    const ghost = await tokenService.issue({ id: crypto.randomUUID(), status: 'anonymous', tokenVersion: 0 }, 'any-profile')

    for (const token of ['not.a.jwt', session.tokens.accessToken, ghost.refreshToken]) {
      const res = await device.refresh(token)
      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('TOKEN_INVALID')
    }
  })

  it('answers 401 TOKEN_EXPIRED for a refresh token past its 60 days', async () => {
    const device = newDevice()
    const session = await sessionOf(await device.bootstrap())
    const old = await new TokenService({ secret: env.JWT_SECRET, now: () => new Date(NOW - 61 * DAY) }).issue(
      {
        id: session.user.id,
        status: 'anonymous',
        tokenVersion: 0,
      },
      (await profiles.defaultFor(session.user.id)).id,
    )

    const res = await device.refresh(old.refreshToken)

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('TOKEN_EXPIRED')
  })
})

describe('POST /auth/logout', () => {
  it('returns a fresh guest for the device and signs the user out on every device', async () => {
    const owner = await seedVerifiedUser(freshEmail())
    const device1 = newDevice()
    const device2 = newDevice()
    const guest = await sessionOf(await device1.bootstrap())
    const onDevice1 = await sessionOf(await signIn(device1, guest.tokens.accessToken, owner.email!))
    const onDevice2 = await tokensFor((await users.get(owner.id))) // the owner is also signed in on a second device

    const res = await device1.logout(onDevice1.tokens.accessToken)

    expect(res.status).toBe(200)
    const fresh = await sessionOf(res)
    expect(fresh.user.id).not.toBe(owner.id)
    expect(fresh.user).toMatchObject({ status: 'anonymous', email: null, phone: null })
    const me = await read<PublicUser>(await device1.me(fresh.tokens.accessToken))
    expect(me.body).toMatchObject({ success: true, data: { user: { id: fresh.user.id } } })

    for (const refreshToken of [onDevice1.tokens.refreshToken, onDevice2.refreshToken]) {
      const stale = await device1.refresh(refreshToken)
      expect(stale.status).toBe(401)
      expect(await errorCodeOf(stale)).toBe('TOKEN_INVALID')
    }
  })

  it('requires a bearer token', async () => {
    const res = await api.auth.logout.$post(
      { json: { deviceId: 'x'.repeat(16), platform: 'ios' } },
      { headers: { 'cf-connecting-ip': freshIp() } },
    )

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })
})

// Needs the `ratelimits` bindings in wrangler.jsonc (bootstrap: 10 per 60 s per IP) and Miniflare's
// rate-limit simulation. The counter lives in the local runtime and keeps its window in real time.
describe('rate limits', () => {
  it('answers 429 RATE_LIMITED with Retry-After after 10 bootstraps in a minute from one IP, while another IP still works', async () => {
    await startOfRateWindow()
    const ip = freshIp()
    const statuses: number[] = []
    let limited: Reply | undefined
    for (let i = 0; i < 12; i++) {
      const res = await newDevice(ip).bootstrap()
      statuses.push(res.status)
      if (res.status === 429 && !limited) limited = res
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200))
    expect(statuses.slice(10)).toEqual([429, 429])
    expect(Number(limited!.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')

    expect((await newDevice().bootstrap()).status).toBe(200)
  }, RATE_TEST_TIMEOUT_MS)
})

describe('OpenAPI', () => {
  it('declares a bearerAuth http bearer scheme that only the protected routes use', async () => {
    const res = await fetchWorker('http://deepertones.test/openapi.json')
    expect(res.status).toBe(200)
    const doc = (await res.json()) as {
      components: { securitySchemes: Record<string, unknown> }
      paths: Record<string, Record<string, { security?: Record<string, unknown>[] }>>
    }

    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })
    const uses = (path: string, method: string) =>
      (doc.paths[path]?.[method]?.security ?? []).some((requirement) => 'bearerAuth' in requirement)
    expect(uses('/auth/otp/send', 'post')).toBe(true)
    expect(uses('/auth/otp/verify', 'post')).toBe(true)
    expect(uses('/auth/logout', 'post')).toBe(true)
    expect(uses('/me', 'get')).toBe(true)
    expect(doc.paths['/auth/anonymous']?.post).toBeDefined()
    expect(doc.paths['/auth/refresh']?.post).toBeDefined()
    expect(uses('/auth/anonymous', 'post')).toBe(false)
    expect(uses('/auth/refresh', 'post')).toBe(false)
  })
})

describe('review fixes', () => {
  it('rate limits /auth/logout with the bootstrap budget: 429 RATE_LIMITED after 10 from one IP', async () => {
    await startOfRateWindow()
    const device = newDevice()
    const { tokens } = await sessionOf(await device.bootstrap())

    const statuses: number[] = []
    let limited: Awaited<ReturnType<typeof device.logout>> | undefined
    for (let i = 0; i < 10; i++) {
      const res = await device.logout(tokens.accessToken)
      statuses.push(res.status)
      if (res.status === 429 && !limited) limited = res
    }

    // The bootstrap above already used one of the 10.
    expect(statuses.slice(0, 9)).toEqual(Array(9).fill(200))
    expect(statuses[9]).toBe(429)
    expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
    expect(Number(limited!.headers.get('Retry-After'))).toBeGreaterThan(0)
  }, RATE_TEST_TIMEOUT_MS)

  it('refuses a verified caller an address nobody owns, before any code is sent or consumed', async () => {
    const owner = await seedVerifiedUser(freshEmail())
    const device = newDevice()
    const { accessToken } = await tokensFor(owner)

    const send = await device.sendCode(accessToken, freshEmail())
    const verify = await device.verifyCode(accessToken, freshEmail(), '123456')

    expect(send.status).toBe(409)
    expect(await errorCodeOf(send)).toBe('ACCOUNT_LINKING_UNAVAILABLE')
    expect(queued).toHaveLength(0)
    expect(verify.status).toBe(409)
    expect(await errorCodeOf(verify)).toBe('ACCOUNT_LINKING_UNAVAILABLE')
  })

  it('lets a verified caller switch to an address another account owns', async () => {
    const me = await seedVerifiedUser(freshEmail())
    const other = await seedVerifiedUser(freshEmail())
    const device = newDevice()
    const { accessToken } = await tokensFor(me)

    const res = await signIn(device, accessToken, other.email!)

    expect(res.status).toBe(200)
    expect((await sessionOf(res)).user.id).toBe(other.id)
  })

  it('retires the refresh token of a guest that signed in as an existing owner', async () => {
    const owner = await seedVerifiedUser(freshEmail())
    const device = newDevice()
    const guest = await sessionOf(await device.bootstrap())

    expect((await signIn(device, guest.tokens.accessToken, owner.email!)).status).toBe(200)

    const stale = await device.refresh(guest.tokens.refreshToken)
    expect(stale.status).toBe(401)
    expect(await errorCodeOf(stale)).toBe('TOKEN_INVALID')
  })

  it('rejects a short device id and a malformed code with 400 VALIDATION_FAILED', async () => {
    const device = newDevice()
    const { tokens } = await sessionOf(await device.bootstrap())

    const short = await api.auth.anonymous.$post(
      { json: { deviceId: 'x'.repeat(15), platform: 'ios' } },
      { headers: device.headers() },
    )
    const badCodes = []
    for (const code of ['12345', '1234567', 'abcdef', '12 456']) {
      badCodes.push(await device.verifyCode(tokens.accessToken, freshEmail(), code))
    }

    expect(short.status).toBe(400)
    expect(await errorCodeOf(short)).toBe('VALIDATION_FAILED')
    for (const res of badCodes) {
      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    }
  })
})
