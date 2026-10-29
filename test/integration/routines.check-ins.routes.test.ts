import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { describe, expect, it, vi } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { localDay } from '../../src/lib/local-day'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { InboxService } from '../../src/modules/inbox/inbox.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { ProfilesService } from '../../src/modules/profiles/profiles.service'
import { D1RoutineCheckInsRepository } from '../../src/modules/routines/routines.check-ins.repository'
import { D1RoutinesRepository, type RoutineVersionRow } from '../../src/modules/routines/routines.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'

// POST /api/v1/me/routine/check-ins (spec #217, PR 4a) through the Worker's public surface, as the app uses it: the typed client against the real entrypoint and real
// local D1. What counts as a good day, the gates and the streak arithmetic are pinned in routines.check-ins.service.test.ts with a fixed clock; this file is the route's:
// the wire shape, the status codes, the order of the gates, and that the stored zone and the stored day 1 reach the service. The Worker runs on the real clock, so the
// days here are worked out from it. There is no read route for check-ins in this PR (the streak is read by a later job), so what was stored is observed through
// D1RoutineCheckInsRepository, the class the route writes through.
//
// THE PUBLIC SHAPE PINNED HERE (the brief's):
//   POST /api/v1/me/routine/check-ins   body { day: 'YYYY-MM-DD', time: 'morning' | 'evening' }   200 { day, time }, and the same on a repeat
//   Gates, in order: 401 AUTH_REQUIRED, 403 SIGNUP_REQUIRED (a guest), 409 ROUTINE_NOT_STARTED (no routine in force, or one not Started), then 400 VALIDATION_FAILED for a day that
//   is not today or yesterday in the person's local day (the stored zone, else UTC) or is before day 1, for a body of the wrong shape, and for a time that is not morning or evening.
//   It has no GOAL_REQUIRED or VERDICT_UNAVAILABLE gate: the accounts below have no goal at all.
//   An unsigned caller is 401 before the body is read, as PUT /me/reminders is.

const WORKER_ENV = { ...env, OTP_CHANNELS: 'email' }
const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())
const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })
const v1 = api.api.v1

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per call keeps the rate limits (keyed by IP) from coupling tests to each other.
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshEmail = () => `CheckIns-${runSalt}-${next()}@Example.com`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number }
const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
const errorCodeOf = async (res: Reply) => {
  const body = (await res.json()) as Envelope<unknown>
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
const routines = new D1RoutinesRepository(db)
const checkIns = new D1RoutineCheckInsRepository(db)

/** A new guest session, the way an app install starts one. */
const newGuest = async () => {
  const deviceId = `device-checkins-${runSalt}-${next()}`
  const res = await v1.auth.anonymous.$post({ json: { deviceId, platform: 'ios' } }, { headers: headers() })
  const session = await dataOf<{ tokens: { accessToken: string }; user: { id: string } }>(res)
  return { accessToken: session.tokens.accessToken, userId: session.user.id }
}
/** A signed-up account and an access token for its own default profile. */
const newVerified = async () => {
  const guest = await users.guestForDevice(`seed-checkins-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: freshEmail().toLowerCase() as EmailAddress })
  const profileId = (await profiles.defaultFor(user.id)).id
  return { user, profileId, accessToken: (await tokenService.issue(user, profileId)).accessToken }
}
type Account = Awaited<ReturnType<typeof newVerified>>

/** The calendar day `n` days from `from` ('YYYY-MM-DD'). */
const shift = (from: string, n: number) => new Date(new Date(`${from}T00:00:00.000Z`).getTime() + n * DAY).toISOString().slice(0, 10)

// The routine, put in the way the build and Start leave it: a ready version appended through the repository (as routines.routes.test.ts does), then markStarted, which is
// the write Start makes. `dayOne` is a calendar day; null leaves the routine ready but not Started.
const readyRoutine = async (profileId: string) => {
  const now = new Date()
  const row: RoutineVersionRow = {
    id: crypto.randomUUID(),
    profileId,
    status: 'ready',
    createdAt: new Date(now.getTime() - HOUR),
    steps: [],
    tapers: [],
    expectation: 'Give it 8 to 12 weeks before judging.',
    cautions: [],
    goal: 'glow',
    shelfCounts: { keep: 0, reduce: 0, drop: 0, stop: 0 },
    notInRoutine: [],
    readyAt: new Date(now.getTime() - HOUR),
    startedOn: null,
    servedAt: null,
    model: null,
    promptHash: null,
    catalogVersion: 1,
    rulesVersion: 'rules-1',
    hintsShown: false,
    verdictFingerprint: 'verdict-fp',
    routineFingerprint: 'routine-fp',
    source: 'rules',
    reason: 'first',
    writerRetryDueAt: null,
    writerCalls: 0,
  }
  await routines.append(row)
}
const startedAccount = async (dayOne: string): Promise<Account> => {
  const account = await newVerified()
  await readyRoutine(account.profileId)
  await routines.markStarted(account.profileId, new Date(`${dayOne}T00:00:00.000Z`))
  return account
}
/** An account that has been Started with day 1 ten days back, so only today and yesterday bound a day. */
const longStarted = () => startedAccount(shift(localDay(new Date(), null), -10))

const postCheckIn = (bearer: string | undefined, json: Record<string, unknown>) => v1.me.routine['check-ins'].$post({ json: json as never }, { headers: headers(bearer) })
const putZone = async (account: Account, timeZone: string) => expect((await v1.me.reminders.$put({ json: { timeZone } }, { headers: headers(account.accessToken) })).status).toBe(200)
const storedFor = async (profileId: string) => (await checkIns.list(profileId, '0000-01-01', '9999-12-31')).map((row) => `${row.day} ${row.time}`).sort()

describe('POST /api/v1/me/routine/check-ins', () => {
  it('answers 200 with the day and time, and records the check-in for the account\'s profile', async () => {
    const account = await longStarted()
    const today = localDay(new Date(), null)

    const res = await postCheckIn(account.accessToken, { day: today, time: 'morning' })

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ day: today, time: 'morning' })
    expect(await storedFor(account.profileId)).toEqual([`${today} morning`])
  })

  it('answers 200 again for a repeat of the same check-in, with the same body, and stores it once', async () => {
    const account = await longStarted()
    const today = localDay(new Date(), null)
    const first = await postCheckIn(account.accessToken, { day: today, time: 'evening' })

    const repeat = await postCheckIn(account.accessToken, { day: today, time: 'evening' })

    expect(first.status).toBe(200)
    expect(repeat.status).toBe(200)
    expect(await dataOf(repeat)).toEqual({ day: today, time: 'evening' })
    expect(await storedFor(account.profileId)).toEqual([`${today} evening`])
  })

  it('records the morning and the evening of a day, and yesterday, as separate check-ins', async () => {
    const account = await longStarted()
    const today = localDay(new Date(), null)
    const yesterday = shift(today, -1)

    for (const [day, time] of [[today, 'morning'], [today, 'evening'], [yesterday, 'evening']] as const) {
      expect((await postCheckIn(account.accessToken, { day, time })).status).toBe(200)
    }

    expect(await storedFor(account.profileId)).toEqual([`${yesterday} evening`, `${today} evening`, `${today} morning`])
  })

  it('needs no goal, shelf or verdict: a signed-up account that only Started its routine may check in', async () => {
    const account = await longStarted()

    expect((await postCheckIn(account.accessToken, { day: localDay(new Date(), null), time: 'morning' })).status).toBe(200)
  })

  it('keeps one account\'s check-ins to itself', async () => {
    const amara = await longStarted()
    const tolu = await longStarted()
    const today = localDay(new Date(), null)

    await postCheckIn(amara.accessToken, { day: today, time: 'morning' })

    expect(await storedFor(amara.profileId)).toEqual([`${today} morning`])
    expect(await storedFor(tolu.profileId)).toEqual([])
  })

  it('checks the day against the zone the person stored, not against UTC', async () => {
    // At any moment at least one of these two zones is on a different calendar day from UTC (UTC+14 is ahead from 10:00 UTC, UTC-11 behind until 11:00 UTC), so the
    // answer cannot be the UTC day's.
    const now = new Date()
    const utcToday = localDay(now, null)
    const zone = localDay(now, 'Pacific/Kiritimati') !== utcToday ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago'
    const localToday = localDay(now, zone)
    expect(localToday).not.toBe(utcToday)
    const account = await startedAccount(shift(utcToday, -10))
    await putZone(account, zone)

    const accepted = [localToday, shift(localToday, -1)]
    const refused = [shift(localToday, 1), shift(localToday, -2)]

    for (const day of accepted) expect((await postCheckIn(account.accessToken, { day, time: 'morning' })).status, day).toBe(200)
    for (const day of refused) {
      const res = await postCheckIn(account.accessToken, { day, time: 'morning' })
      expect(res.status, day).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    }
    expect(await storedFor(account.profileId)).toEqual(accepted.map((day) => `${day} morning`).sort())
  })

  it('refuses a day before day 1 with 400 VALIDATION_FAILED when day 1 is today, though yesterday is otherwise in range', async () => {
    const today = localDay(new Date(), null)
    const account = await startedAccount(today)

    const res = await postCheckIn(account.accessToken, { day: shift(today, -1), time: 'morning' })

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    expect(await storedFor(account.profileId)).toEqual([])
  })

  it('accepts day 1 itself, the first day that may be checked in', async () => {
    const yesterday = shift(localDay(new Date(), null), -1)
    const account = await startedAccount(yesterday)

    expect((await postCheckIn(account.accessToken, { day: yesterday, time: 'morning' })).status).toBe(200)
  })

  it.each([
    ['tomorrow', 1],
    ['the day before yesterday', -2],
    ['a week ago', -7],
    ['next week', 7],
  ])('refuses %s with 400 VALIDATION_FAILED, and stores nothing', async (_label, offset) => {
    const account = await longStarted()

    const res = await postCheckIn(account.accessToken, { day: shift(localDay(new Date(), null), offset), time: 'morning' })

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    expect(await storedFor(account.profileId)).toEqual([])
  })

  // Each body is wrong in one way only: the rest of it is today's good check-in, so a 400 can only come from the part that is wrong.
  it.each([
    ['a day that is not a date', (today: string) => ({ day: 'today', time: 'morning' })],
    ['a day without its zero padding', (today: string) => ({ day: `${today.slice(0, 4)}-1-5`, time: 'morning' })],
    ['a day with a time on it', (today: string) => ({ day: `${today}T00:00:00Z`, time: 'morning' })],
    ['a day that is not a string', (today: string) => ({ day: Number(today.replaceAll('-', '')), time: 'morning' })],
    // Out of range as well as not a date: it pins the 400, not that the service checks calendars.
    ['a calendar date that does not exist', (today: string) => ({ day: `${today.slice(0, 4)}-02-30`, time: 'morning' })],
    ['a time of day that is not morning or evening', (today: string) => ({ day: today, time: 'noon' })],
    ['a time of day in capitals', (today: string) => ({ day: today, time: 'Morning' })],
    ['a time of day that is not a string', (today: string) => ({ day: today, time: 7 })],
    ['no time of day', (today: string) => ({ day: today })],
    ['no day', () => ({ time: 'morning' })],
    ['an empty body', () => ({})],
  ])('answers 400 VALIDATION_FAILED for %s, and stores nothing', async (_label, bodyFor) => {
    const account = await longStarted()

    const res = await postCheckIn(account.accessToken, bodyFor(localDay(new Date(), null)))

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    expect(await storedFor(account.profileId)).toEqual([])
  })

  it('answers 401 AUTH_REQUIRED without a bearer token', async () => {
    const res = await postCheckIn(undefined, { day: localDay(new Date(), null), time: 'morning' })

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('answers 401 AUTH_REQUIRED, not 400, to an unsigned caller whose body is also wrong: the session is checked before the body is read', async () => {
    const res = await postCheckIn(undefined, { day: 'today', time: 'noon' })

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('answers 403 SIGNUP_REQUIRED to a guest, and stores nothing', async () => {
    const guest = await newGuest()
    const today = localDay(new Date(), null)

    const res = await postCheckIn(guest.accessToken, { day: today, time: 'morning' })

    expect(res.status).toBe(403)
    expect(await errorCodeOf(res)).toBe('SIGNUP_REQUIRED')
    const profileId = (await profiles.defaultFor(guest.userId)).id
    expect(await storedFor(profileId)).toEqual([])
  })

  it('answers 409 ROUTINE_NOT_STARTED to a signed-up account that has no routine', async () => {
    const account = await newVerified()

    const res = await postCheckIn(account.accessToken, { day: localDay(new Date(), null), time: 'morning' })

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('ROUTINE_NOT_STARTED')
    expect(await storedFor(account.profileId)).toEqual([])
  })

  it('answers 409 ROUTINE_NOT_STARTED to an account whose routine is ready but has not been Started', async () => {
    const account = await newVerified()
    await readyRoutine(account.profileId)

    const res = await postCheckIn(account.accessToken, { day: localDay(new Date(), null), time: 'morning' })

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('ROUTINE_NOT_STARTED')
    expect(await storedFor(account.profileId)).toEqual([])
  })

  it('answers 409 ROUTINE_NOT_STARTED, not 400, when the routine has not Started and the day is also out of range: the gate comes first', async () => {
    const account = await newVerified()
    await readyRoutine(account.profileId)

    const res = await postCheckIn(account.accessToken, { day: shift(localDay(new Date(), null), 5), time: 'morning' })

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('ROUTINE_NOT_STARTED')
  })
})

// The all-done row (spec #233, PR 8b). The check-in that completes the second half of a day (the day then holds both the morning and the evening) writes one inbox row,
// `all-done:<day>`, kind 'all-done', for the day checked in (not necessarily today). Whichever half comes first, one half alone writes nothing, a repeat writes nothing more, and a row
// that cannot be written never fails the check-in. Observed through GET /me/inbox, the read the app uses.
type InboxRow = { id: string; kind: string; day: string; title: string; body: string; link: string; read: boolean }
const inboxOf = async (bearer: string) => (await dataOf<{ items: InboxRow[] }>(await v1.me.inbox.$get({ query: { limit: '50' } as never }, { headers: headers(bearer) }))).items
const allDone = async (bearer: string) => (await inboxOf(bearer)).filter((row) => row.kind === 'all-done')

describe('POST /api/v1/me/routine/check-ins: the all-done row', () => {
  it('writes one row, for the day, when the evening completes a day whose morning was done', async () => {
    const account = await longStarted()
    const today = localDay(new Date(), null)
    await postCheckIn(account.accessToken, { day: today, time: 'morning' })
    expect(await allDone(account.accessToken)).toEqual([])

    expect((await postCheckIn(account.accessToken, { day: today, time: 'evening' })).status).toBe(200)

    const rows = await allDone(account.accessToken)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'all-done', day: today, read: false })
    expect(rows[0]!.title.length).toBeGreaterThan(0)
    expect(rows[0]!.body.length).toBeGreaterThan(0)
    expect(rows[0]!.link).toMatch(/^\/(?!\/)/)
  })

  it('writes it the same when the evening is checked in first and the morning completes the day', async () => {
    const account = await longStarted()
    const today = localDay(new Date(), null)
    await postCheckIn(account.accessToken, { day: today, time: 'evening' })
    expect(await allDone(account.accessToken)).toEqual([])

    await postCheckIn(account.accessToken, { day: today, time: 'morning' })

    expect((await allDone(account.accessToken)).map((row) => row.day)).toEqual([today])
  })

  it('writes it once: a repeat of the completing check-in, and of the first half, make no second row', async () => {
    const account = await longStarted()
    const today = localDay(new Date(), null)
    await postCheckIn(account.accessToken, { day: today, time: 'morning' })
    await postCheckIn(account.accessToken, { day: today, time: 'evening' })

    await postCheckIn(account.accessToken, { day: today, time: 'evening' })
    await postCheckIn(account.accessToken, { day: today, time: 'morning' })

    expect(await allDone(account.accessToken)).toHaveLength(1)
  })

  it('writes nothing for one half alone, and nothing for a morning of one day and an evening of another', async () => {
    const account = await longStarted()
    const today = localDay(new Date(), null)
    const yesterday = shift(today, -1)

    await postCheckIn(account.accessToken, { day: today, time: 'morning' })
    await postCheckIn(account.accessToken, { day: yesterday, time: 'evening' })

    expect(await allDone(account.accessToken)).toEqual([])
  })

  it('writes a row for yesterday when the check-in that completes yesterday is made today', async () => {
    const account = await longStarted()
    const today = localDay(new Date(), null)
    const yesterday = shift(today, -1)
    await postCheckIn(account.accessToken, { day: yesterday, time: 'morning' })

    await postCheckIn(account.accessToken, { day: yesterday, time: 'evening' })

    expect((await allDone(account.accessToken)).map((row) => row.day)).toEqual([yesterday])
  })

  it('writes a row for each day that is completed', async () => {
    const account = await longStarted()
    const today = localDay(new Date(), null)
    const yesterday = shift(today, -1)

    for (const day of [yesterday, today]) for (const time of ['morning', 'evening'] as const) await postCheckIn(account.accessToken, { day, time })

    expect((await allDone(account.accessToken)).map((row) => row.day).sort()).toEqual([yesterday, today])
  })

  it('still records the check-in, answers 200 and logs the failure by the profile id alone, when the row cannot be written', async () => {
    const account = await longStarted()
    const today = localDay(new Date(), null)
    await postCheckIn(account.accessToken, { day: today, time: 'morning' })
    vi.spyOn(InboxService.prototype, 'write').mockRejectedValue(new Error('the database is down for ExponentPushToken[abc]'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await postCheckIn(account.accessToken, { day: today, time: 'evening' })

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ day: today, time: 'evening' })
    expect(await storedFor(account.profileId)).toEqual([`${today} evening`, `${today} morning`])
    expect(JSON.stringify(logged.mock.calls)).toContain(account.profileId)
    expect(JSON.stringify(logged.mock.calls)).not.toContain('ExponentPushToken[abc]')
    vi.restoreAllMocks()
  })
})
