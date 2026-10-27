import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { describe, expect, it } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { parsePhoneNumber } from '../../src/lib/phone'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { ProfilesService } from '../../src/modules/profiles/profiles.service'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'

// The reminder settings routes (spec #217, PR 3) through the Worker's public surface, as the app uses them: the typed client against the real entrypoint and real
// local D1. Everything is observed through the routes themselves. The channel rule's WhatsApp branch needs WhatsApp enabled as an OTP channel, which no environment
// has yet (OTP_CHANNELS is "email"), so it is pinned in reminders.service.test.ts; here the channel can only be seen staying 'push'.

const NOW = Date.now()
const WORKER_ENV = { ...env, OTP_CHANNELS: 'email' }

const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())

const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })
const v1 = api.api.v1
const reminders = v1.me.reminders

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per call keeps the rate limits (keyed by IP) from coupling tests to each other.
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshEmail = () => `Reminders-${runSalt}-${next()}@Example.com`
// An MTN Nigeria prefix (803) with seven random digits: a valid number, and one nobody else in this database holds.
const freshPhone = () => `+234803${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number }
type Reminders = {
  enabled: boolean
  morning: string
  evening: string
  timeZone: string | null
  stepDownAlerts: boolean
  missedDaysNudge: boolean
  missedDaysChannel: 'push' | 'whatsapp'
}

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

// Set-up shortcuts for accounts that already exist. They use the same services the Worker uses.
const db = createDb(env.DB)
const users = new UsersService({ repository: new D1UsersRepository(db) })
const profiles = new ProfilesService({ repository: new D1ProfilesRepository(db) })
const tokenService = new TokenService({ secret: env.JWT_SECRET })

/** A new guest session, the way an app install starts one. */
const newGuest = async () => {
  const deviceId = `device-install-${runSalt}-${next()}`
  const res = await v1.auth.anonymous.$post({ json: { deviceId, platform: 'ios' } }, { headers: headers() })
  const session = await dataOf<{ tokens: { accessToken: string }; user: { id: string } }>(res)
  return { accessToken: session.tokens.accessToken, userId: session.user.id }
}

const seedVerifiedUser = async () => {
  const guest = await users.guestForDevice(`seed-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: freshEmail().toLowerCase() as EmailAddress })
  return user
}
/** A signed-up account, and an access token for its own default profile. */
const newVerified = async () => {
  const user = await seedVerifiedUser()
  const profileId = (await profiles.defaultFor(user.id)).id
  return { user, profileId, accessToken: (await tokenService.issue(user, profileId)).accessToken }
}

const getReminders = (bearer?: string) => reminders.$get({}, { headers: headers(bearer) })
const putReminders = (bearer: string | undefined, json: Record<string, unknown>) => reminders.$put({ json: json as never }, { headers: headers(bearer) })

const DEFAULTS: Reminders = { enabled: false, morning: '07:00', evening: '21:00', timeZone: null, stepDownAlerts: true, missedDaysNudge: true, missedDaysChannel: 'push' }

describe('GET /api/v1/me/reminders', () => {
  it('answers the defaults, and exactly these fields, for an account that never saved anything', async () => {
    const { accessToken } = await newVerified()

    const res = await getReminders(accessToken)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual(DEFAULTS)
  })

  it('answers 403 SIGNUP_REQUIRED to a guest', async () => {
    const { accessToken } = await newGuest()

    const res = await getReminders(accessToken)

    expect(res.status).toBe(403)
    expect(await errorCodeOf(res)).toBe('SIGNUP_REQUIRED')
  })

  it('answers 401 AUTH_REQUIRED without a bearer token', async () => {
    const res = await getReminders()

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('keeps WhatsApp out of it while WhatsApp is not an enabled channel, even for an account that verified a phone', async () => {
    const guest = await users.guestForDevice(`seed-${runSalt}-${next()}`, 'ios')
    const { user } = await users.promote(guest.id, { kind: 'phone', phone: parsePhoneNumber(freshPhone()) })
    const accessToken = (await tokenService.issue(user, (await profiles.defaultFor(user.id)).id)).accessToken

    expect(await dataOf(await getReminders(accessToken))).toMatchObject({ missedDaysChannel: 'push' })
  })
})

describe('PUT /api/v1/me/reminders', () => {
  it('changes the fields named, answers all of them, and GET then shows the same', async () => {
    const { accessToken } = await newVerified()

    const res = await putReminders(accessToken, { enabled: true, morning: '06:30', timeZone: 'Africa/Lagos' })

    expect(res.status).toBe(200)
    const expected = { ...DEFAULTS, enabled: true, morning: '06:30', timeZone: 'Africa/Lagos' }
    expect(await dataOf(res)).toEqual(expected)
    expect(await dataOf(await getReminders(accessToken))).toEqual(expected)
  })

  it('merges a second change into the first, and can turn a switch back off', async () => {
    const { accessToken } = await newVerified()
    await putReminders(accessToken, { enabled: true, stepDownAlerts: false })

    const second = await dataOf(await putReminders(accessToken, { evening: '22:15' }))
    const third = await dataOf(await putReminders(accessToken, { enabled: false, stepDownAlerts: true }))

    expect(second).toEqual({ ...DEFAULTS, enabled: true, stepDownAlerts: false, evening: '22:15' })
    expect(third).toEqual({ ...DEFAULTS, enabled: false, stepDownAlerts: true, evening: '22:15' })
  })

  it('accepts a PUT of only the time zone, leaving reminders off, and a later zone replaces it', async () => {
    const { accessToken } = await newVerified()

    const first = await putReminders(accessToken, { timeZone: 'Europe/London' })
    const second = await putReminders(accessToken, { timeZone: 'America/New_York' })

    expect(first.status).toBe(200)
    expect(await dataOf(first)).toEqual({ ...DEFAULTS, timeZone: 'Europe/London' })
    expect(await dataOf(second)).toEqual({ ...DEFAULTS, timeZone: 'America/New_York' })
  })

  it('accepts the first and the last minute of the day for a time', async () => {
    const { accessToken } = await newVerified()

    expect(await dataOf(await putReminders(accessToken, { morning: '00:00', evening: '23:59' }))).toMatchObject({ morning: '00:00', evening: '23:59' })
  })

  it('keeps settings per profile: a session on the account\'s other profile reads the defaults, and another account is untouched', async () => {
    const owner = await newVerified()
    const other = await newVerified()
    const second = crypto.randomUUID()
    await new D1ProfilesRepository(db).insert({ id: second, userId: owner.user.id, displayName: null, isDefault: false, createdAt: new Date(NOW) })
    const onSecond = (await tokenService.issue(owner.user, second)).accessToken

    await putReminders(owner.accessToken, { enabled: true, timeZone: 'Africa/Lagos' })

    expect(await dataOf(await getReminders(onSecond))).toEqual(DEFAULTS)
    expect(await dataOf(await getReminders(other.accessToken))).toEqual(DEFAULTS)
    expect(await dataOf(await getReminders(owner.accessToken))).toEqual({ ...DEFAULTS, enabled: true, timeZone: 'Africa/Lagos' })
  })

  it.each([
    ['24:00 for a time', { morning: '24:00' }],
    ['23:60 for a time', { evening: '23:60' }],
    ['a one-digit hour', { morning: '7:00' }],
    ['a time with seconds', { evening: '21:00:00' }],
    ['12-hour time', { morning: '7:00 PM' }],
    ['a time that is not a string', { morning: 700 }],
    ['a time zone that does not exist', { timeZone: 'Mars/Phobos' }],
    ['a city with no region as a time zone', { timeZone: 'Lagos' }],
    ['an empty time zone', { timeZone: '' }],
    ['a time zone that is not a string', { timeZone: 1 }],
    ['a switch that is not a boolean', { enabled: 'yes' }],
    ['a nudge switch that is not a boolean', { missedDaysNudge: 'no' }],
  ])('answers 400 VALIDATION_FAILED for %s', async (_label, json) => {
    const { accessToken } = await newVerified()

    const res = await putReminders(accessToken, json)

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
  })

  it('stores nothing from a refused request, even the valid fields in it', async () => {
    const { accessToken } = await newVerified()
    await putReminders(accessToken, { morning: '06:00', timeZone: 'Africa/Lagos' })

    const refused = await putReminders(accessToken, { enabled: true, evening: '22:00', timeZone: 'Mars/Phobos' })

    expect(refused.status).toBe(400)
    expect(await dataOf(await getReminders(accessToken))).toEqual({ ...DEFAULTS, morning: '06:00', timeZone: 'Africa/Lagos' })
  })

  it('answers 403 SIGNUP_REQUIRED to a guest, and stores nothing', async () => {
    const { accessToken } = await newGuest()

    const res = await putReminders(accessToken, { enabled: true, timeZone: 'Africa/Lagos' })

    expect(res.status).toBe(403)
    expect(await errorCodeOf(res)).toBe('SIGNUP_REQUIRED')
  })

  it('answers 401 AUTH_REQUIRED without a bearer token', async () => {
    const res = await putReminders(undefined, { enabled: true })

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })
})
