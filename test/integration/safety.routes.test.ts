import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1SafetyRepository } from '../../src/modules/safety/safety.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'

// The safety routes through the Worker's public surface, as the app uses them: the typed client against the real entrypoint and real
// local D1. No model is involved in this step (the goal is picked with a chip, and the safety answers are only stored), so nothing
// outbound is stubbed except the OTP email, whose code is read from the ZeptoMail request the delivery job makes, as in goals.routes.test.ts.

const OTP_QUEUE = 'deepertones-otp-delivery-development'
const ZEPTO_URL = 'https://zeptomail.test/v1.1/email'

// Messages the Worker puts on the OTP queue. Delivery is driven by hand (see codeFor).
const queued: unknown[] = []
// Messages it puts on the parse-safety queue, with the delay each asked for. A real local queue would hand them to whichever test is running by
// then, so the Worker's producer is a recorder (that the job does its work is safety.background.test.ts). `parseQueueDown` makes the next send fail.
const parseQueued: { body: unknown; delaySeconds: number | undefined }[] = []
const parseQueue = {
  failNext: false,
  async send(body: unknown, options?: { delaySeconds?: number }) {
    if (this.failNext) {
      this.failNext = false
      throw new Error('queue is down')
    }
    parseQueued.push({ body, delaySeconds: options?.delaySeconds })
  },
  async sendBatch() {},
}
const WORKER_ENV = {
  ...env,
  OTP_CHANNELS: 'email',
  ZEPTOMAIL_API_URL: ZEPTO_URL,
  ZEPTOMAIL_API_KEY: 'test-key',
  OTP_DELIVERY_QUEUE: { send: async (body: unknown) => void queued.push(body) } as unknown as Queue,
  PARSE_SAFETY_QUEUE: parseQueue as unknown as Queue,
}

const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) =>
  worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())

const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })
// Every API route lives under /api/v1.
const v1 = api.api.v1

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  queued.length = 0
  parseQueued.length = 0
  parseQueue.failNext = false
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per call keeps the rate limits (keyed by IP) from coupling tests to each other.
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshEmail = () => `Safety-${runSalt}-${next()}@Example.com`

type Tokens = { accessToken: string; refreshToken: string }
type PublicUser = { id: string; status: 'anonymous' | 'verified'; email: string | null; phone: string | null }
type Session = { tokens: Tokens; user: PublicUser }
type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string; details?: unknown } }
type Reply = { json(): Promise<unknown>; text(): Promise<string>; status: number; headers: Headers }
type SafetyBody = {
  choices: string[]
  reactionText: string | null
  prescriptionText: string | null
  excludesPregnancyCaution: boolean
  updatedAt: string
}
type OnboardingBody = { goal: { goal: string | null } | null; safety: SafetyBody | null; next: string }

const read = async <T>(res: Reply) => (await res.json()) as Envelope<T>
const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = await read<T>(res)
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
const errorOf = async (res: Reply) => {
  const body = await read<unknown>(res)
  if (body.success) throw new Error(`expected an error, got ${res.status}`)
  return body.error
}
const errorCodeOf = async (res: Reply) => (await errorOf(res)).code

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
const users = new UsersService({ repository: new D1UsersRepository(db) })

/** An account that signed up some time ago and owns an address: made the way auth.test.ts makes one (promote a guest), so the OTP cooldown of that address is not in play. */
const seedVerifiedUser = async (email: string) => {
  const guest = await users.guestForDevice(`seed-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: email.toLowerCase() as EmailAddress })
  return user
}

/** An access token for a second profile of the guest's account, as profile switching will issue one. */
const onSecondProfile = async (userId: string) => {
  const id = crypto.randomUUID()
  await new D1ProfilesRepository(db).insert({ id, userId, displayName: null, isDefault: false, createdAt: new Date() })
  return (await tokenService.issue({ id: userId, status: 'anonymous', tokenVersion: 0 }, id)).accessToken
}

const putSafety = (bearer: string | undefined, json: Record<string, unknown>) => v1.me.safety.$put({ json: json as never }, { headers: headers(bearer) })
const getSafety = (bearer: string | undefined) => v1.me.safety.$get({}, { headers: headers(bearer) })
const getOnboarding = (bearer: string | undefined) => v1.me.onboarding.$get({}, { headers: headers(bearer) })
const putGoal = (bearer: string, json: Record<string, unknown>) => v1.me.goal.$put({ json: json as never }, { headers: headers(bearer) })

const answer = async (bearer: string, json: Record<string, unknown>) => dataOf<SafetyBody>(await putSafety(bearer, json))
const pickGoal = async (bearer: string, goal: string) => {
  const res = await putGoal(bearer, { goal })
  expect(res.status).toBe(200)
}

describe('PUT /api/v1/me/safety', () => {
  it('answers 200 with exactly the five keys of the view, and the time it was saved as an ISO date', async () => {
    const { accessToken } = await newGuest()
    const before = Date.now()

    const res = await putSafety(accessToken, { choices: ['pregnant'] })

    expect(res.status).toBe(200)
    const body = await dataOf<SafetyBody>(res)
    expect(body).toEqual({
      choices: ['pregnant'],
      reactionText: null,
      prescriptionText: null,
      excludesPregnancyCaution: true,
      updatedAt: expect.any(String),
    })
    const updatedAt = Date.parse(body.updatedAt)
    expect(new Date(updatedAt).toISOString()).toBe(body.updatedAt)
    expect(updatedAt).toBeGreaterThanOrEqual(before)
    expect(updatedAt).toBeLessThanOrEqual(Date.now())
  })

  it('shows the same view from GET afterwards', async () => {
    const { accessToken } = await newGuest()
    const put = await answer(accessToken, { choices: ['reaction', 'prescription'], reactionText: 'Caro White', prescriptionText: 'clobetasol' })

    const res = await getSafety(accessToken)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual(put)
  })

  it('accepts "none" on its own, with no texts and no pregnancy caution', async () => {
    const { accessToken } = await newGuest()

    const body = await answer(accessToken, { choices: ['none'] })

    expect(body).toMatchObject({ choices: ['none'], reactionText: null, prescriptionText: null, excludesPregnancyCaution: false })
  })

  it('accepts pregnant and breastfeeding together, and asks for the pregnancy caution', async () => {
    const { accessToken } = await newGuest()

    const body = await answer(accessToken, { choices: ['pregnant', 'breastfeeding'] })

    expect(body).toMatchObject({ choices: ['pregnant', 'breastfeeding'], excludesPregnancyCaution: true })
  })

  it.each([
    [['breastfeeding'], true],
    [['reaction'], false],
    [['prescription'], false],
  ])('answers excludesPregnancyCaution for %j as %s', async (choices, expected) => {
    const { accessToken } = await newGuest()

    expect((await answer(accessToken, { choices })).excludesPregnancyCaution).toBe(expected)
  })

  it('saves the reaction words trimmed ("Caro White and fragrance"), and GET shows them', async () => {
    const { accessToken } = await newGuest()

    const body = await answer(accessToken, { choices: ['reaction'], reactionText: '  Caro White and fragrance  ' })

    expect(body.reactionText).toBe('Caro White and fragrance')
    expect(body.prescriptionText).toBeNull()
    expect(await dataOf<SafetyBody>(await getSafety(accessToken))).toMatchObject({ reactionText: 'Caro White and fragrance' })
  })

  it('saves the prescription words trimmed', async () => {
    const { accessToken } = await newGuest()

    const body = await answer(accessToken, { choices: ['prescription'], prescriptionText: '  hydroquinone cream  ' })

    expect(body.prescriptionText).toBe('hydroquinone cream')
    expect(body.reactionText).toBeNull()
  })

  it.each([
    ['left out', {}],
    ['an empty string', { reactionText: '' }],
    ['only spaces', { reactionText: '   ' }],
  ])('keeps the ticked reaction with no words (null) when the text is %s', async (_label, extra) => {
    const { accessToken } = await newGuest()

    const res = await putSafety(accessToken, { choices: ['reaction'], ...extra })

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toMatchObject({ choices: ['reaction'], reactionText: null })
    expect(await dataOf(await getSafety(accessToken))).toMatchObject({ choices: ['reaction'], reactionText: null })
  })

  it('accepts empty or blank text fields for choices that are not ticked, as no text, but still refuses real words without their choice', async () => {
    const { accessToken } = await newGuest()

    const blank = await putSafety(accessToken, { choices: ['pregnant'], reactionText: '', prescriptionText: '   ' })
    const words = await putSafety(accessToken, { choices: ['pregnant'], reactionText: '  ', prescriptionText: 'clobetasol' })

    expect(blank.status).toBe(200)
    expect(await dataOf(blank)).toMatchObject({ choices: ['pregnant'], reactionText: null, prescriptionText: null })
    expect(words.status).toBe(400)
    expect(await errorCodeOf(words)).toBe('INVALID_SAFETY_ANSWER')
    expect(await dataOf(await getSafety(accessToken))).toMatchObject({ choices: ['pregnant'], prescriptionText: null })
  })

  it.each([
    ['a line break', 'Caro White\nshea butter'],
    ['a Windows line break', 'Caro White\r\nshea butter'],
    ['a tab', 'Caro White\tshea butter'],
    ['a blank line and indent', 'Caro White\n\n   shea butter'],
  ])('accepts a list written over several lines (%s) and answers it with every run of whitespace as one space', async (_label, text) => {
    const { accessToken } = await newGuest()

    const res = await putSafety(accessToken, { choices: ['reaction', 'prescription'], reactionText: `  ${text}  `, prescriptionText: text })

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toMatchObject({ reactionText: 'Caro White shea butter', prescriptionText: 'Caro White shea butter' })
    expect(await dataOf(await getSafety(accessToken))).toMatchObject({ reactionText: 'Caro White shea butter', prescriptionText: 'Caro White shea butter' })
  })

  it('counts the 300-character limit on the words as typed, line breaks included, before they are made one space', async () => {
    const { accessToken } = await newGuest()
    const manyLines = (length: number) => `${'x\n'.repeat((length - 1) / 2)}x`

    const atLimit = await putSafety(accessToken, { choices: ['reaction'], reactionText: manyLines(299) })
    const over = await putSafety(accessToken, { choices: ['reaction'], reactionText: manyLines(301) })

    expect(manyLines(299)).toHaveLength(299)
    expect(manyLines(301)).toHaveLength(301)
    expect(atLimit.status).toBe(200)
    expect(over.status).toBe(400)
    expect(await errorCodeOf(over)).toBe('VALIDATION_FAILED')
  })

  it('answers 400 INVALID_SAFETY_ANSWER, not INVALID_SAFETY_TEXT, for a link in words whose choice is not ticked', async () => {
    const { accessToken } = await newGuest()

    const res = await putSafety(accessToken, { choices: ['pregnant'], reactionText: 'https://x.example' })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('INVALID_SAFETY_ANSWER')
    expect(error.details).toEqual({ field: 'reactionText' })
  })

  it('collapses a choice sent six times to one', async () => {
    const { accessToken } = await newGuest()

    const res = await putSafety(accessToken, { choices: ['pregnant', 'pregnant', 'pregnant', 'pregnant', 'pregnant', 'pregnant'] })

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toMatchObject({ choices: ['pregnant'], excludesPregnancyCaution: true })
  })

  it('accepts exactly 20 choices when they are repeats, and refuses 21', async () => {
    const { accessToken } = await newGuest()

    const twenty = await putSafety(accessToken, { choices: Array(20).fill('pregnant') })
    const twentyOne = await putSafety(accessToken, { choices: Array(21).fill('pregnant') })

    expect(twenty.status).toBe(200)
    expect((await dataOf<SafetyBody>(twenty)).choices).toEqual(['pregnant'])
    expect(twentyOne.status).toBe(400)
    expect(await errorCodeOf(twentyOne)).toBe('VALIDATION_FAILED')
  })

  it('returns the choices in the app\'s order whatever order they were sent in, and once each', async () => {
    const { accessToken } = await newGuest()

    const body = await answer(accessToken, { choices: ['prescription', 'pregnant', 'reaction', 'pregnant'], reactionText: 'x', prescriptionText: 'y' })

    expect(body.choices).toEqual(['pregnant', 'reaction', 'prescription'])
    expect((await dataOf<SafetyBody>(await getSafety(accessToken))).choices).toEqual(['pregnant', 'reaction', 'prescription'])
  })

  it('takes a plain angle bracket as ordinary text', async () => {
    const { accessToken } = await newGuest()

    const res = await putSafety(accessToken, { choices: ['reaction'], reactionText: 'stung when pH < 5' })

    expect(res.status).toBe(200)
  })

  it('accepts a text of exactly 300 characters once the padding is trimmed', async () => {
    const { accessToken } = await newGuest()
    const longest = 'x'.repeat(300)

    const res = await putSafety(accessToken, { choices: ['reaction', 'prescription'], reactionText: `  ${longest}  `, prescriptionText: longest })

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toMatchObject({ reactionText: longest, prescriptionText: longest })
  })

  it('accepts the four real choices together, and refuses all five because "none" cannot join the rest', async () => {
    const { accessToken } = await newGuest()

    const ok = await putSafety(accessToken, { choices: ['pregnant', 'breastfeeding', 'reaction', 'prescription'] })
    const refused = await putSafety(accessToken, { choices: ['pregnant', 'breastfeeding', 'reaction', 'prescription', 'none'] })

    expect(ok.status).toBe(200)
    expect(refused.status).toBe(400)
    expect(await errorCodeOf(refused)).toBe('INVALID_SAFETY_ANSWER')
  })
})

describe('PUT /api/v1/me/safety refusing a contradictory answer', () => {
  it.each([
    ['"none" with pregnant', { choices: ['none', 'pregnant'] }, 'choices'],
    ['"none" with a reaction', { choices: ['reaction', 'none'] }, 'choices'],
    ['reaction words without the reaction choice', { choices: ['pregnant'], reactionText: 'Caro White' }, 'reactionText'],
    ['prescription words without the prescription choice', { choices: ['reaction'], prescriptionText: 'clobetasol' }, 'prescriptionText'],
    ['reaction words with "none"', { choices: ['none'], reactionText: 'Caro White' }, 'reactionText'],
    ['prescription words with "none"', { choices: ['none'], prescriptionText: 'clobetasol' }, 'prescriptionText'],
  ])('answers 400 INVALID_SAFETY_ANSWER naming the field for %s, and stores nothing', async (_label, json, field) => {
    const { accessToken } = await newGuest()

    const res = await putSafety(accessToken, json)

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('INVALID_SAFETY_ANSWER')
    expect(error.details).toEqual({ field })
    expect((await getSafety(accessToken)).status).toBe(404)
  })

  it('leaves the answer already saved as it was when a later request is refused', async () => {
    const { accessToken } = await newGuest()
    const saved = await answer(accessToken, { choices: ['pregnant'] })

    const res = await putSafety(accessToken, { choices: ['none', 'pregnant'] })

    expect(res.status).toBe(400)
    expect(await dataOf(await getSafety(accessToken))).toEqual(saved)
  })
})

describe('PUT /api/v1/me/safety refusing unsafe words', () => {
  it.each([
    ['a link', 'see https://evil.example'],
    ['a link starting www.', 'www.evil.example'],
    ['markup', 'Caro <b>White</b>'],
    ['a zero-width space', 'Caro​White'],
    ['a control character', 'Caro\u0007White'],
  ])('answers 400 INVALID_SAFETY_TEXT for reaction words with %s, and stores nothing', async (_label, reactionText) => {
    const { accessToken } = await newGuest()

    const res = await putSafety(accessToken, { choices: ['reaction'], reactionText })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('INVALID_SAFETY_TEXT')
    expect(error.details).toEqual({ field: 'reactionText' })
    expect((await getSafety(accessToken)).status).toBe(404)
  })

  it('answers 400 INVALID_SAFETY_TEXT for prescription words with a link', async () => {
    const { accessToken } = await newGuest()

    const res = await putSafety(accessToken, { choices: ['prescription'], prescriptionText: 'https://evil.example' })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('INVALID_SAFETY_TEXT')
    expect(error.details).toEqual({ field: 'prescriptionText' })
  })
})

describe('PUT /api/v1/me/safety validation', () => {
  it.each([
    ['no choices at all', { choices: [] }],
    ['the choices left out', {}],
    ['choices that are not a list', { choices: 'pregnant' }],
    ['a choice that is not one of the five', { choices: ['allergic'] }],
    ['a choice that is not a string', { choices: [4] }],
    ['21 choices, repeats or not', { choices: Array(21).fill('pregnant') }],
    ['reaction words that are not a string', { choices: ['reaction'], reactionText: 42 }],
    ['prescription words that are not a string', { choices: ['prescription'], prescriptionText: ['clobetasol'] }],
    ['301 characters of reaction words', { choices: ['reaction'], reactionText: 'x'.repeat(301) }],
    ['301 characters of prescription words', { choices: ['prescription'], prescriptionText: 'x'.repeat(301) }],
    ['301 characters once trimmed, not 300 before', { choices: ['reaction'], reactionText: ` ${'x'.repeat(301)} ` }],
    ['a key the answer does not have', { choices: ['pregnant'], pregnant: true }],
    ['a key that looks like a text field', { choices: ['reaction'], reactionText: 'x', notes: 'more words' }],
  ])('answers 400 VALIDATION_FAILED for %s, and stores nothing', async (_label, json) => {
    const { accessToken } = await newGuest()

    const res = await putSafety(accessToken, json)

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    expect((await getSafety(accessToken)).status).toBe(404)
  })
})

describe('GET /api/v1/me/safety', () => {
  it('answers 404 SAFETY_NOT_SET before an answer was saved', async () => {
    const { accessToken } = await newGuest()

    const res = await getSafety(accessToken)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('SAFETY_NOT_SET')
  })

  it('changes the answer by appending: GET shows the newest, and "none" can replace a pregnancy', async () => {
    const { accessToken } = await newGuest()
    const first = await answer(accessToken, { choices: ['pregnant'] })

    const second = await answer(accessToken, { choices: ['none'] })

    expect(second.choices).toEqual(['none'])
    expect(second.excludesPregnancyCaution).toBe(false)
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt))
    expect(await dataOf(await getSafety(accessToken))).toEqual(second)
  })

  it('does not keep the words of an earlier answer when the next one names none', async () => {
    const { accessToken } = await newGuest()
    await answer(accessToken, { choices: ['reaction'], reactionText: 'Caro White' })

    await answer(accessToken, { choices: ['reaction'] })

    expect(await dataOf(await getSafety(accessToken))).toMatchObject({ choices: ['reaction'], reactionText: null })
  })

  it('keeps one account\'s answers from another', async () => {
    const amara = await newGuest()
    const tolu = await newGuest()
    await answer(amara.accessToken, { choices: ['pregnant'] })

    const res = await getSafety(tolu.accessToken)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('SAFETY_NOT_SET')
    expect((await dataOf<OnboardingBody>(await getOnboarding(tolu.accessToken))).safety).toBeNull()
  })

  it('keeps one profile\'s answers from another profile of the same account', async () => {
    const amara = await newGuest()
    await answer(amara.accessToken, { choices: ['pregnant'] })
    const second = await onSecondProfile(amara.userId)

    const res = await getSafety(second)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('SAFETY_NOT_SET')
    expect(await dataOf<SafetyBody>(await getSafety(amara.accessToken))).toMatchObject({ choices: ['pregnant'] })
  })

  it('keeps an answer saved on a second profile on that profile', async () => {
    const amara = await newGuest()
    const second = await onSecondProfile(amara.userId)

    await answer(second, { choices: ['breastfeeding'] })

    expect((await getSafety(amara.accessToken)).status).toBe(404)
    expect(await dataOf<SafetyBody>(await getSafety(second))).toMatchObject({ choices: ['breastfeeding'] })
  })
})

describe('GET /api/v1/me/onboarding with the safety answers', () => {
  it('moves from goal to safety to shelf as the goal and then the safety answer are given', async () => {
    const { accessToken } = await newGuest()
    expect(await dataOf(await getOnboarding(accessToken))).toEqual({ goal: null, safety: null, next: 'goal' })

    await pickGoal(accessToken, 'even-tone')
    const atSafety = await dataOf<OnboardingBody>(await getOnboarding(accessToken))
    expect(atSafety).toMatchObject({ goal: { goal: 'even-tone' }, safety: null, next: 'safety' })

    const saved = await answer(accessToken, { choices: ['pregnant', 'reaction'], reactionText: 'Caro White' })

    const atShelf = await getOnboarding(accessToken)
    expect(atShelf.status).toBe(200)
    expect(await dataOf(atShelf)).toEqual({ goal: atSafety.goal, safety: saved, next: 'shelf' })
  })

  it('counts "none of these" as an answer, so the next step is the shelf', async () => {
    const { accessToken } = await newGuest()
    await pickGoal(accessToken, 'glow')

    await answer(accessToken, { choices: ['none'] })

    expect((await dataOf<OnboardingBody>(await getOnboarding(accessToken))).next).toBe('shelf')
  })

  it('stays on the goal step when the safety question was answered first, and still shows that answer', async () => {
    const { accessToken } = await newGuest()
    const saved = await answer(accessToken, { choices: ['breastfeeding'] })

    expect(await dataOf(await getOnboarding(accessToken))).toEqual({ goal: null, safety: saved, next: 'goal' })
  })

  it('shows the newest safety answer after it is changed', async () => {
    const { accessToken } = await newGuest()
    await pickGoal(accessToken, 'glow')
    await answer(accessToken, { choices: ['pregnant'] })
    const changed = await answer(accessToken, { choices: ['none'] })

    expect((await dataOf<OnboardingBody>(await getOnboarding(accessToken))).safety).toEqual(changed)
  })

  it('asks for safety on a second profile that has a goal but no answer, while the first profile is at the shelf', async () => {
    const amara = await newGuest()
    await pickGoal(amara.accessToken, 'glow')
    await answer(amara.accessToken, { choices: ['none'] })
    const second = await onSecondProfile(amara.userId)
    await pickGoal(second, 'glow')

    expect((await dataOf<OnboardingBody>(await getOnboarding(second))).next).toBe('safety')
    expect((await dataOf<OnboardingBody>(await getOnboarding(amara.accessToken))).next).toBe('shelf')
  })
})

describe('a guest who signs up', () => {
  it('keeps the safety answers when the guest is promoted in place, and the first run still ends at the shelf', async () => {
    const guest = await newGuest()
    await pickGoal(guest.accessToken, 'brighter')
    const saved = await answer(guest.accessToken, { choices: ['breastfeeding'] })

    const res = await signIn(guest.device, guest.accessToken, freshEmail())

    expect(res.status).toBe(200)
    const session = await dataOf<Session>(res)
    expect(session.user.id).toBe(guest.userId)
    expect(session.user.status).toBe('verified')
    const after = session.tokens.accessToken
    expect(await dataOf(await getSafety(after))).toEqual(saved)
    expect((await dataOf<OnboardingBody>(await getOnboarding(after))).next).toBe('shelf')
  })
})

describe('a guest who signs in to an existing account', () => {
  it('does not give the guest\'s answers to the account, which is asked again, and leaves the guest\'s own answers where they were', async () => {
    const owner = await seedVerifiedUser(freshEmail())
    const guest = await newGuest()
    await pickGoal(guest.accessToken, 'glow')
    const guestsAnswer = await answer(guest.accessToken, { choices: ['pregnant'] })

    const res = await signIn(guest.device, guest.accessToken, owner.email!.toUpperCase())

    expect(res.status).toBe(200)
    const session = await dataOf<Session>(res)
    expect(session.user.id).toBe(owner.id)
    const asOwner = session.tokens.accessToken
    const got = await getSafety(asOwner)
    expect(got.status).toBe(404)
    expect(await errorCodeOf(got)).toBe('SAFETY_NOT_SET')
    expect(await dataOf(await getOnboarding(asOwner))).toEqual({ goal: null, safety: null, next: 'goal' })
    // The guest row is left behind, not deleted (as auth.test.ts shows for /me): what the guest said is still its own.
    expect(await dataOf(await getSafety(guest.accessToken))).toEqual(guestsAnswer)
  })
})

describe('the safety routes without a session', () => {
  it('answers 401 AUTH_REQUIRED from PUT and GET', async () => {
    const put = await putSafety(undefined, { choices: ['none'] })
    const got = await getSafety(undefined)

    for (const res of [put, got]) {
      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    }
  })

  it('answers 401 TOKEN_INVALID for a token that is not ours', async () => {
    const res = await getSafety('not-a-token')

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('TOKEN_INVALID')
  })
})

describe('the safety answers and logs', () => {
  it('never puts the words in a log, saved, read or refused', async () => {
    const { accessToken } = await newGuest()
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))

    await putSafety(accessToken, { choices: ['reaction'], reactionText: 'Caro White QZ7' })
    await getSafety(accessToken)
    await putSafety(accessToken, { choices: ['reaction'], reactionText: 'Caro White QZ7 https://evil.example' })
    await putSafety(accessToken, { choices: ['pregnant'], reactionText: 'Caro White QZ7' })

    for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('QZ7')
  })
})

// The parse itself is safety.background.test.ts. Here: what saving and reading do to the queue. The parse state is not in the view (the API shape does not
// change), so the saved row is read back from D1 through the id the message carries.
describe('PUT /api/v1/me/safety and the parse it queues', () => {
  const safetyRows = new D1SafetyRepository(db)
  const profileIdOf = async (bearer: string) => (await dataOf<{ profile: { id: string } }>(await v1.me.$get({}, { headers: headers(bearer) }))).profile.id
  const queuedIds = () => parseQueued.map((message) => (message.body as { safetyId: string }).safetyId)

  it('queues one parse-safety message, carrying only the id of the row it saved, for the reaction words "Caro White and fragrance"', async () => {
    const { accessToken } = await newGuest()

    const res = await putSafety(accessToken, { choices: ['reaction'], reactionText: 'Caro White and fragrance' })

    expect(res.status).toBe(200)
    expect(parseQueued).toHaveLength(1)
    expect(Object.keys(parseQueued[0]!.body as object)).toEqual(['safetyId'])
    expect(parseQueued[0]!.delaySeconds ?? 0).toBe(0)
    const saved = await safetyRows.find(queuedIds()[0]!)
    expect(saved).toMatchObject({ profileId: await profileIdOf(accessToken), reactionText: 'Caro White and fragrance', parseState: 'pending' })
  })

  it('queues one for prescription words, and one, not two, for an answer with both', async () => {
    const { accessToken } = await newGuest()

    await putSafety(accessToken, { choices: ['prescription'], prescriptionText: 'Dermovate' })
    expect(parseQueued).toHaveLength(1)

    parseQueued.length = 0
    const other = await newGuest()
    await putSafety(other.accessToken, { choices: ['reaction', 'prescription'], reactionText: 'fragrance', prescriptionText: 'Dermovate' })
    expect(parseQueued).toHaveLength(1)
  })

  it.each([
    ['no words', { choices: ['pregnant', 'reaction', 'prescription'] }],
    ['blank words', { choices: ['reaction'], reactionText: '   ' }],
    ['"none of these"', { choices: ['none'] }],
    ['an answer refused for words without their choice', { choices: ['pregnant'], reactionText: 'Caro White' }],
    ['an answer refused for a link', { choices: ['reaction'], reactionText: 'see https://evil.example' }],
  ])('queues nothing for %s', async (_label, json) => {
    const { accessToken } = await newGuest()

    await putSafety(accessToken, json)

    expect(parseQueued).toEqual([])
  })

  it('holds the parse of a second answer with words, saved within the hour, back by about an hour', async () => {
    const { accessToken } = await newGuest()
    await putSafety(accessToken, { choices: ['reaction'], reactionText: 'Caro White and fragrance' })

    await putSafety(accessToken, { choices: ['reaction'], reactionText: 'Movate cream' })

    expect(parseQueued).toHaveLength(2)
    expect(parseQueued[0]!.delaySeconds ?? 0).toBe(0)
    const held = parseQueued[1]!.delaySeconds!
    expect(held).toBeGreaterThan(3590)
    expect(held).toBeLessThanOrEqual(3600)
    expect(queuedIds()[1]).not.toBe(queuedIds()[0])
  })

  it('does not hold back the parse of another account saved in the same hour', async () => {
    const amara = await newGuest()
    const tolu = await newGuest()
    await putSafety(amara.accessToken, { choices: ['reaction'], reactionText: 'Caro White' })

    await putSafety(tolu.accessToken, { choices: ['reaction'], reactionText: 'Movate cream' })

    expect(parseQueued.map((message) => message.delaySeconds ?? 0)).toEqual([0, 0])
  })

  it('saves the answer and answers 200 with the usual view when the queue is down, leaving the row pending', async () => {
    const { accessToken } = await newGuest()
    parseQueue.failNext = true

    const res = await putSafety(accessToken, { choices: ['reaction'], reactionText: 'Caro White and fragrance' })

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toMatchObject({ choices: ['reaction'], reactionText: 'Caro White and fragrance' })
    expect(await dataOf(await getSafety(accessToken))).toMatchObject({ reactionText: 'Caro White and fragrance' })
    expect(parseQueued).toEqual([])
    expect(await safetyRows.current(await profileIdOf(accessToken))).toMatchObject({ parseState: 'pending' })
  })

  it('does not add the parse to the view: still exactly the five keys', async () => {
    const { accessToken } = await newGuest()

    const body = await answer(accessToken, { choices: ['reaction'], reactionText: 'Caro White and fragrance' })

    expect(Object.keys(body).sort()).toEqual(['choices', 'excludesPregnancyCaution', 'prescriptionText', 'reactionText', 'updatedAt'])
  })
})

describe('GET /api/v1/me/safety repairing a parse that never ran', () => {
  const safetyRows = new D1SafetyRepository(db)
  const MINUTE = 60 * 1000

  /**
   * An answer whose queue message was lost long ago: still pending, and due `agoMs` before now. The real clock cannot be moved, and a
   * save always dates a row now, so the aged row is written as a lost-message save would have left it by now.
   */
  const lostAnswer = async (agoMs: number) => {
    const { accessToken, userId } = await newGuest()
    const profileId = (await dataOf<{ profile: { id: string } }>(await v1.me.$get({}, { headers: headers(accessToken) }))).profile.id
    const id = `safety-${crypto.randomUUID()}`
    const dueAt = new Date(Date.now() - agoMs)
    await safetyRows.append({
      id,
      profileId,
      choices: ['reaction'],
      reactionText: 'Caro White and fragrance',
      prescriptionText: null,
      parseState: 'pending',
      parseDueAt: dueAt,
      createdAt: dueAt,
    })
    return { accessToken, userId, id }
  }

  it('queues the parse again, with no delay, when the answer is still pending more than 10 minutes after it was due', async () => {
    const { accessToken, id } = await lostAnswer(11 * MINUTE)

    const res = await getSafety(accessToken)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toMatchObject({ choices: ['reaction'], reactionText: 'Caro White and fragrance' })
    expect(parseQueued.map((message) => message.body)).toEqual([{ safetyId: id }])
    expect(parseQueued[0]!.delaySeconds ?? 0).toBe(0)
  })

  it('queues nothing while the answer is within 10 minutes of its due time', async () => {
    const { accessToken } = await lostAnswer(9 * MINUTE)

    const res = await getSafety(accessToken)

    expect(res.status).toBe(200)
    expect(parseQueued).toEqual([])
  })

  it('queues nothing for an answer whose parse is finished, however long ago', async () => {
    const { accessToken, id } = await lostAnswer(3 * 60 * MINUTE)
    await safetyRows.setParseState(id, 'done')

    await getSafety(accessToken)

    expect(parseQueued).toEqual([])
  })

  it('still answers 200 with the answer when the queue is down', async () => {
    const { accessToken } = await lostAnswer(11 * MINUTE)
    parseQueue.failNext = true

    const res = await getSafety(accessToken)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toMatchObject({ reactionText: 'Caro White and fragrance' })
  })
})
