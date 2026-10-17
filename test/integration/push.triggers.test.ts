import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { ProfilesService } from '../../src/modules/profiles/profiles.service'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'

// What a code sign-in does to the push system, end to end through the Worker: a guest registers its push token and signs in to an
// existing account; the alert the Worker queues is then run through its real queue handler with only Expo stubbed at fetch.
// OTP codes are read from the ZeptoMail request the delivery job makes, as in auth.test.ts.
const OTP_QUEUE = 'deepertones-otp-delivery-development'
const SEND_QUEUE = 'deepertones-push-delivery-development'
const ZEPTO_URL = 'https://zeptomail.test/v1.1/email'
const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send'

// Messages the Worker puts on the queues. OTP delivery is driven by hand (see codeFor); the push queues record what the Worker
// queues, since a real local queue would hand a message to whichever test is running by then.
const otpQueued: unknown[] = []
const pushQueued: unknown[] = []
const WORKER_ENV = {
  ...env,
  OTP_CHANNELS: 'email',
  ZEPTOMAIL_API_URL: ZEPTO_URL,
  ZEPTOMAIL_API_KEY: 'test-key',
  OTP_DELIVERY_QUEUE: { send: async (body: unknown) => void otpQueued.push(body) } as unknown as Queue,
  PUSH_DELIVERY_QUEUE: { send: async (body: unknown) => void pushQueued.push(body), sendBatch: async () => {} } as unknown as Queue,
  PUSH_RECEIPTS_QUEUE: { send: async () => {}, sendBatch: async () => {} } as unknown as Queue,
} as typeof env

const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) =>
  worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())

const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })
const v1 = api.api.v1
const push = v1.me['push-token']

afterEach(() => {
  vi.unstubAllGlobals()
  otpQueued.length = 0
  pushQueued.length = 0
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per request keeps the rate limits (keyed by IP) from coupling tests to each other.
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshEmail = () => `PushTriggers-${runSalt}-${next()}@Example.com`
const canonical = (email: string) => email.toLowerCase()
// The push token and device id are unique per call: push_tokens.token is UNIQUE and the database is shared by every test in this file.
const freshPushToken = () => `ExponentPushToken[${runSalt}-${next()}]`
const freshDeviceId = () => `device-push-${runSalt}-${next()}`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number }
type Session = { tokens: { accessToken: string }; user: { id: string } }
const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
const headers = (bearer?: string): Record<string, string> => ({
  'cf-connecting-ip': freshIp(),
  ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
})

/** A new guest session, the way an app install starts one. */
const newGuest = async () => {
  const deviceId = `device-install-${runSalt}-${next()}`
  const session = await dataOf<Session>(await v1.auth.anonymous.$post({ json: { deviceId, platform: 'ios' } }, { headers: headers() }))
  return { accessToken: session.tokens.accessToken, userId: session.user.id }
}
const registerPhone = (bearer: string, token: string, platform: 'ios' | 'android') =>
  push.$put({ json: { deviceId: freshDeviceId(), platform, token } }, { headers: headers(bearer) })

/** Delivers the queued code email through the Worker's queue handler and reads the code from it. */
const codeFor = async (): Promise<string> => {
  const body = otpQueued.pop()
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
const signIn = async (bearer: string, address: string) => {
  const sent = await v1.auth.otp.send.$post({ json: { channel: 'email', address } }, { headers: headers(bearer) })
  expect(sent.status).toBe(200)
  return v1.auth.otp.verify.$post({ json: { channel: 'email', address, code: await codeFor() } }, { headers: headers(bearer) })
}

// Set-up shortcuts for accounts that already exist. They use the same services the Worker uses.
const db = createDb(env.DB)
const users = new UsersService({ repository: new D1UsersRepository(db) })
const profiles = new ProfilesService({ repository: new D1ProfilesRepository(db) })
const tokenService = new TokenService({ secret: env.JWT_SECRET })
const seedVerifiedUser = async (email: string) => {
  const guest = await users.guestForDevice(`seed-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: canonical(email) as EmailAddress })
  return user
}
const accessFor = async (user: Awaited<ReturnType<typeof seedVerifiedUser>>) =>
  (await tokenService.issue(user, (await profiles.defaultFor(user.id)).id)).accessToken

type ExpoMessage = { to: string; title: string; body: string; data: Record<string, unknown> }
const expoSends: ExpoMessage[][] = []
const stubExpo = () => {
  expoSends.length = 0
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) !== EXPO_SEND_URL) throw new Error(`unexpected outbound request to ${String(url)}`)
    const messages = JSON.parse(init!.body as string) as ExpoMessage[]
    expoSends.push(messages)
    return Response.json({ data: messages.map(() => ({ status: 'ok', id: `ticket-${crypto.randomUUID()}` })) })
  })
}
const runSendQueue = async (body: unknown) => {
  const batch = createMessageBatch(SEND_QUEUE, [{ id: 'm', timestamp: new Date(), attempts: 1, body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, WORKER_ENV, ctx)
  return getQueueResult(batch, ctx)
}

describe('a guest signing in to an existing account', () => {
  it('sends one new-sign-in push, to the account\'s other phone only, never to the phone that signed in', async () => {
    const owner = await seedVerifiedUser(freshEmail())
    const ownerToken = freshPushToken()
    expect((await registerPhone(await accessFor(owner), ownerToken, 'ios')).status).toBe(204)
    const guest = await newGuest()
    const guestToken = freshPushToken()
    expect((await registerPhone(guest.accessToken, guestToken, 'android')).status).toBe(204)

    const verified = await signIn(guest.accessToken, owner.email!)
    expect(verified.status).toBe(200)
    expect((await dataOf<Session>(verified)).user.id).toBe(owner.id)

    expect(pushQueued).toHaveLength(1)
    expect(pushQueued[0]).toMatchObject({ kind: 'new-sign-in', userId: owner.id, platform: 'android' })
    stubExpo()
    const result = await runSendQueue(pushQueued[0])

    expect(result.explicitAcks).toEqual(['m'])
    expect(expoSends).toHaveLength(1)
    expect(expoSends[0]).toEqual([
      {
        to: ownerToken,
        title: 'New sign-in to your Deeper Tones account',
        body: 'on an Android phone, just now',
        sound: 'default',
        data: { url: '/settings/security', kind: 'new-sign-in' },
      },
    ])
    expect(JSON.stringify(expoSends)).not.toContain(guestToken)
  })

  it('queues no alert when the guest is promoted in place by a new address', async () => {
    const guest = await newGuest()
    expect((await registerPhone(guest.accessToken, freshPushToken(), 'ios')).status).toBe(204)

    const verified = await signIn(guest.accessToken, freshEmail())

    expect(verified.status).toBe(200)
    expect((await dataOf<Session>(verified)).user.id).toBe(guest.userId)
    expect(pushQueued).toEqual([])
  })
})
