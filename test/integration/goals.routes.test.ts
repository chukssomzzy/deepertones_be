import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { GOAL_ANSWERS_VERSION } from '../../src/modules/goals/goals.answers'
import { GOALS, type Goal } from '../../src/modules/goals/goals.vocabulary'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'

// The goal routes through the Worker's public surface, as the app uses them: the typed client against the real entrypoint and real
// local D1. Nothing here reaches a real service: OTP codes are read from the ZeptoMail request the delivery job makes, as in
// notifications.routes.test.ts. PR 1 has no AI, so typed words are saved with no goal.

const OTP_QUEUE = 'deepertones-otp-delivery-development'
const ZEPTO_URL = 'https://zeptomail.test/v1.1/email'

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

afterEach(() => {
  vi.unstubAllGlobals()
  queued.length = 0
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per call keeps the rate limits (keyed by IP) from coupling tests to each other.
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshEmail = () => `Goals-${runSalt}-${next()}@Example.com`

type Tokens = { accessToken: string; refreshToken: string }
type PublicUser = { id: string; status: 'anonymous' | 'verified'; email: string | null; phone: string | null }
type Session = { tokens: Tokens; user: PublicUser }
type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; text(): Promise<string>; status: number; headers: Headers }
type Answer = { title: string; howLong: string; helps: string; inTheWay: string; note: string | null }
type GoalBody = { goal: string | null; wantsLighter: boolean; text: string | null; answer: Answer | null; answersVersion: number; updatedAt: string }
type OnboardingBody = { goal: GoalBody | null; safety: null; next: string }

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
    sendCode: (bearer: string, address: string) => v1.auth.otp.send.$post({ json: { channel: 'email', address } }, { headers: headers(bearer) }),
    verifyCode: (bearer: string, address: string, code: string) =>
      v1.auth.otp.verify.$post({ json: { channel: 'email', address, code } }, { headers: headers(bearer) }),
  }
}
type Device = ReturnType<typeof newDevice>

/** A new guest session, the way an app install starts one. */
const newGuest = async () => {
  const device = newDevice()
  const session = await dataOf<Session>(await device.bootstrap())
  return { device, session, accessToken: session.tokens.accessToken, userId: session.user.id }
}

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

const db = createDb(env.DB)
const tokenService = new TokenService({ secret: env.JWT_SECRET })

/** An access token for a second profile of the guest's account, as profile switching will issue one. */
const onSecondProfile = async (userId: string) => {
  const id = crypto.randomUUID()
  await new D1ProfilesRepository(db).insert({ id, userId, displayName: null, isDefault: false, createdAt: new Date() })
  return (await tokenService.issue({ id: userId, status: 'anonymous', tokenVersion: 0 }, id)).accessToken
}

const putGoal = (bearer: string | undefined, json: Record<string, unknown>) => v1.me.goal.$put({ json: json as never }, { headers: headers(bearer) })
const getGoal = (bearer: string | undefined) => v1.me.goal.$get({}, { headers: headers(bearer) })
const getOnboarding = (bearer: string | undefined) => v1.me.onboarding.$get({}, { headers: headers(bearer) })

const chip = async (bearer: string, goal: string) => dataOf<GoalBody>(await putGoal(bearer, { goal }))
const typed = async (bearer: string, text: string) => dataOf<GoalBody>(await putGoal(bearer, { text }))

describe('PUT /api/v1/me/goal with a chip', () => {
  it.each(GOALS.map((goal: Goal): [Goal] => [goal]))('answers 200 with the %s view: its honest answer, no colour note, the copy version and when it was set', async (goal: Goal) => {
    const { accessToken } = await newGuest()
    const before = Date.now()

    const res = await putGoal(accessToken, { goal })

    expect(res.status).toBe(200)
    const body = await dataOf<GoalBody>(res)
    expect(body).toEqual({
      goal,
      wantsLighter: false,
      text: null,
      answer: { title: expect.any(String), howLong: expect.any(String), helps: expect.any(String), inTheWay: expect.any(String), note: null },
      answersVersion: GOAL_ANSWERS_VERSION,
      updatedAt: expect.any(String),
    })
    for (const field of ['title', 'howLong', 'helps', 'inTheWay'] as const) expect(body.answer![field].trim()).not.toBe('')
    const updatedAt = Date.parse(body.updatedAt)
    expect(new Date(updatedAt).toISOString()).toBe(body.updatedAt)
    expect(updatedAt).toBeGreaterThanOrEqual(before)
    expect(updatedAt).toBeLessThanOrEqual(Date.now())
  })

  it('shows the same view from GET afterwards', async () => {
    const { accessToken } = await newGuest()
    const put = await chip(accessToken, 'glow')

    const res = await getGoal(accessToken)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual(put)
  })

  it('changes the goal when the user taps another, and GET shows the new one with its own answer', async () => {
    const { accessToken } = await newGuest()
    const first = await chip(accessToken, 'clear-skin')

    const second = await chip(accessToken, 'even-tone')

    expect(second.goal).toBe('even-tone')
    expect(second.answer).not.toBeNull()
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt))
    expect(await dataOf(await getGoal(accessToken))).toEqual(second)
  })

  it('gives the plain brighter chip no note about colour', async () => {
    const { accessToken } = await newGuest()

    const view = await chip(accessToken, 'brighter')

    expect(view.wantsLighter).toBe(false)
    expect(view.answer!.note).toBeNull()
  })
})

describe('PUT /api/v1/me/goal with typed words', () => {
  it('saves the trimmed words with no goal and no answer, and GET shows them rather than GOAL_NOT_SET', async () => {
    const { accessToken } = await newGuest()

    const res = await putGoal(accessToken, { text: '  make my face clear  ' })

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({
      goal: null,
      wantsLighter: false,
      text: 'make my face clear',
      answer: null,
      answersVersion: GOAL_ANSWERS_VERSION,
      updatedAt: expect.any(String),
    })
    const got = await getGoal(accessToken)
    expect(got.status).toBe(200)
    expect(await dataOf<GoalBody>(got)).toMatchObject({ goal: null, answer: null, text: 'make my face clear' })
  })

  it('keeps the typed words with the chip picked next ("which is closest?"), and not on a chip after that', async () => {
    const { accessToken } = await newGuest()
    await typed(accessToken, 'make my face clear')

    const picked = await chip(accessToken, 'clear-skin')
    const changed = await chip(accessToken, 'glow')

    expect(picked).toMatchObject({ goal: 'clear-skin', text: 'make my face clear' })
    expect(picked.answer).not.toBeNull()
    expect(changed).toMatchObject({ goal: 'glow', text: null })
    expect(await dataOf<GoalBody>(await getGoal(accessToken))).toMatchObject({ goal: 'glow', text: null })
  })

  it('keeps the latest words when the user typed twice before picking', async () => {
    const { accessToken } = await newGuest()
    await typed(accessToken, 'first try')
    await typed(accessToken, 'second try')

    expect(await chip(accessToken, 'even-tone')).toMatchObject({ text: 'second try' })
  })

  it('accepts a single character, and exactly 200 characters once the padding is trimmed', async () => {
    const { accessToken } = await newGuest()
    const longest = 'x'.repeat(200)

    const one = await putGoal(accessToken, { text: 'x' })
    const padded = await putGoal(accessToken, { text: `  ${longest}  ` })

    expect(one.status).toBe(200)
    expect(padded.status).toBe(200)
    expect((await dataOf<GoalBody>(padded)).text).toBe(longest)
  })

  it('takes a plain angle bracket as ordinary text', async () => {
    const { accessToken } = await newGuest()

    const res = await putGoal(accessToken, { text: 'spots < 1cm gone' })

    expect(res.status).toBe(200)
  })
})

describe('PUT /api/v1/me/goal validation', () => {
  it.each([
    ['both a goal and words', { goal: 'glow', text: 'make my face clear' }],
    ['neither a goal nor words', {}],
    ['a goal that is not one of the five', { goal: 'darker' }],
    ['a goal that is not a string', { goal: 4 }],
    ['words that are not a string', { text: 42 }],
    ['empty words', { text: '' }],
    ['words of only spaces', { text: '   ' }],
    ['201 characters', { text: 'x'.repeat(201) }],
    ['201 characters once trimmed, not 200 before', { text: ` ${'x'.repeat(201)} ` }],
  ])('answers 400 VALIDATION_FAILED for %s, and stores nothing', async (_label, json) => {
    const { accessToken } = await newGuest()

    const res = await putGoal(accessToken, json)

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    expect((await getGoal(accessToken)).status).toBe(404)
  })

  it.each([
    ['a link', 'see https://evil.example for my goal'],
    ['a link starting www.', 'www.evil.example'],
    ['markup', 'make my <b>face</b> clear'],
    ['a zero-width space', 'make my face\u200Bclear'],
    ['a control character', 'make my face\u0007clear'],
  ])('answers 400 INVALID_GOAL_TEXT for words with %s, and stores nothing', async (_label, text) => {
    const { accessToken } = await newGuest()

    const res = await putGoal(accessToken, { text })

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('INVALID_GOAL_TEXT')
    expect((await getGoal(accessToken)).status).toBe(404)
  })

  it('leaves the goal already set as it was when a later request is refused', async () => {
    const { accessToken } = await newGuest()
    const set = await chip(accessToken, 'glow')

    const res = await putGoal(accessToken, { text: 'https://evil.example' })

    expect(res.status).toBe(400)
    expect(await dataOf(await getGoal(accessToken))).toEqual(set)
  })
})

describe('GET /api/v1/me/goal', () => {
  it('answers 404 GOAL_NOT_SET before a goal was set', async () => {
    const { accessToken } = await newGuest()

    const res = await getGoal(accessToken)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('GOAL_NOT_SET')
  })

  it('keeps one account\'s goal from another', async () => {
    const amara = await newGuest()
    const tolu = await newGuest()
    await chip(amara.accessToken, 'glow')

    expect((await getGoal(tolu.accessToken)).status).toBe(404)
    expect((await dataOf<OnboardingBody>(await getOnboarding(tolu.accessToken))).goal).toBeNull()
  })

  it('keeps one profile\'s goal from another profile of the same account', async () => {
    const amara = await newGuest()
    await chip(amara.accessToken, 'glow')
    const second = await onSecondProfile(amara.userId)

    const res = await getGoal(second)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('GOAL_NOT_SET')
    expect(await dataOf<GoalBody>(await getGoal(amara.accessToken))).toMatchObject({ goal: 'glow' })
  })

  it('keeps a goal set on a second profile on that profile', async () => {
    const amara = await newGuest()
    const second = await onSecondProfile(amara.userId)

    await chip(second, 'even-tone')

    expect((await getGoal(amara.accessToken)).status).toBe(404)
    expect(await dataOf<GoalBody>(await getGoal(second))).toMatchObject({ goal: 'even-tone' })
  })
})

describe('GET /api/v1/me/onboarding', () => {
  it('sends a new guest to the goal step, with no goal and no safety answer', async () => {
    const { accessToken } = await newGuest()

    const res = await getOnboarding(accessToken)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ goal: null, safety: null, next: 'goal' })
  })

  it('keeps asking for the goal after only words were typed, and carries those words', async () => {
    const { accessToken } = await newGuest()
    const saved = await typed(accessToken, 'make my face clear')

    expect(await dataOf(await getOnboarding(accessToken))).toEqual({ goal: saved, safety: null, next: 'goal' })
  })

  it('moves on to safety once a goal is set, with the goal in the reply', async () => {
    const { accessToken } = await newGuest()
    const saved = await chip(accessToken, 'fade-dark-marks')

    const res = await getOnboarding(accessToken)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ goal: saved, safety: null, next: 'safety' })
  })

  it('moves on to safety once the pick after unclear words is made', async () => {
    const { accessToken } = await newGuest()
    await typed(accessToken, 'something about my skin')
    expect((await dataOf<OnboardingBody>(await getOnboarding(accessToken))).next).toBe('goal')

    await chip(accessToken, 'even-tone')

    expect((await dataOf<OnboardingBody>(await getOnboarding(accessToken))).next).toBe('safety')
  })
})

describe('a guest who signs up', () => {
  it('keeps the goal when the guest is promoted in place', async () => {
    const guest = await newGuest()
    const saved = await chip(guest.accessToken, 'brighter')

    const res = await signIn(guest.device, guest.accessToken, freshEmail())

    expect(res.status).toBe(200)
    const session = await dataOf<Session>(res)
    expect(session.user.id).toBe(guest.userId)
    expect(session.user.status).toBe('verified')
    const after = session.tokens.accessToken
    expect(await dataOf(await getGoal(after))).toEqual(saved)
    expect((await dataOf<OnboardingBody>(await getOnboarding(after))).next).toBe('safety')
  })
})

describe('the goal routes without a session', () => {
  it('answers 401 AUTH_REQUIRED from PUT, GET and onboarding', async () => {
    const put = await putGoal(undefined, { goal: 'glow' })
    const putWords = await putGoal(undefined, { text: 'make my face clear' })
    const got = await getGoal(undefined)
    const onboarding = await getOnboarding(undefined)

    for (const res of [put, putWords, got, onboarding]) {
      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    }
  })

  it('answers 401 TOKEN_INVALID for a token that is not ours', async () => {
    const res = await getGoal('not-a-token')

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('TOKEN_INVALID')
  })
})
