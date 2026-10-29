import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { beforeAll, describe, expect, it } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { localDay } from '../../src/lib/local-day'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1InboxRepository } from '../../src/modules/inbox/inbox.repository'
import { InboxService } from '../../src/modules/inbox/inbox.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { ProfilesService } from '../../src/modules/profiles/profiles.service'
import { D1RoutinesRepository, type RoutineVersionRow } from '../../src/modules/routines/routines.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'
import { applied, NIGERIA, taperRow, withCountry } from './admin.catalog.support'

// GET /api/v1/me/today (spec #233, PR 7) through the Worker's public surface: the real entrypoint and real local D1. What Today is made of (the week, the half of the day,
// what is left out, the done flags, the step-down progress, the check-ins due, the hold, the inbox summary, failing closed) is pinned with a fixed clock and a zone
// in routines.viewer.service.test.ts; this file is the route's: who may ask, the envelope, the keys on the wire, and one happy path over real D1 in which the
// state is reached through the routes that make it (a check-in through POST /me/routine/check-ins, reminders through PUT /me/reminders, an inbox row read through
// POST /me/inbox/read). The Worker runs on the real clock, so the days here are worked out from it, and the half of the day it answers is read from the body.
//
// THE PUBLIC SHAPE PINNED HERE (the full description is at the top of routines.viewer.service.test.ts):
//   GET /api/v1/me/today   200 { started, day, startsOn, week, card, half, current: { done, entries }, other: { done, entries }, allDone, stepDowns, checkInsDue, hold,
//                                bringingBack, remindersOff, inbox: { unread, latest } }
//   The gates of GET /me/routine, in its order: 401 AUTH_REQUIRED with no session, 403 SIGNUP_REQUIRED for a guest, 409 GOAL_REQUIRED for an account with no goal, then 503 VERDICT_UNAVAILABLE
//   while either step-down template of the verdict is not approved. So the accounts below get a goal, safety answers and a shopping country the way routines.routes.test.ts does, and the
//   gate describe runs first, before the templates are approved (one database for the whole file).
// The typed client has no call for the route until it exists, so it is fetched with plain fetch.

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
const freshEmail = () => `Today-${runSalt}-${next()}@Example.com`

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
const inbox = new InboxService({ repository: new D1InboxRepository(db) })

const newGuest = async () => {
  const res = await v1.auth.anonymous.$post({ json: { deviceId: `device-today-${runSalt}-${next()}`, platform: 'ios' } }, { headers: headers() })
  return (await dataOf<{ tokens: { accessToken: string } }>(res)).tokens.accessToken
}
/** A signed-up account and an access token for its own default profile. */
const newVerified = async () => {
  const guest = await users.guestForDevice(`seed-today-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: freshEmail().toLowerCase() as EmailAddress })
  const profileId = (await profiles.defaultFor(user.id)).id
  return { user, profileId, accessToken: (await tokenService.issue(user, profileId)).accessToken }
}
type Account = Awaited<ReturnType<typeof newVerified>>

/** A signed-up account with a goal, safety answers and a shopping country, as routines.routes.test.ts makes one: it passes the routine's gates once the templates are approved. */
const newReady = async (): Promise<Account> => {
  const made = await newVerified()
  const h = () => headers(made.accessToken)
  expect((await v1.me.goal.$put({ json: { goal: 'glow' } as never }, { headers: h() })).status).toBe(200)
  expect((await v1.me.safety.$put({ json: { choices: ['none'] } as never }, { headers: h() })).status).toBe(200)
  expect((await v1.me.shopping.$put({ json: { country: 'NG' } as never }, { headers: h() })).status).toBe(200)
  return made
}

/** The calendar day `n` days from `from` ('YYYY-MM-DD'). */
const shift = (from: string, n: number) => new Date(new Date(`${from}T00:00:00.000Z`).getTime() + n * DAY).toISOString().slice(0, 10)

// The routine, put in the way the build and Start leave it: a ready version appended through the repository, then markStarted. Cleanse and moisturise are used morning and evening,
// the treatment in the evening only and the sunscreen in the morning only; every step is "use what you have", so no catalog product is needed.
const startedAccount = async (dayOne: string): Promise<Account> => {
  const made = await newReady()
  const now = new Date()
  const step = (name: RoutineVersionRow['steps'][number]['step'], frequency: RoutineVersionRow['steps'][number]['frequency']): RoutineVersionRow['steps'][number] => ({
    step: name,
    product: { kind: 'none' },
    frequency,
    reason: `Reason for ${name}.`,
    grounding: [],
    gotIt: false,
    fixedFrom: null,
    changedOn: null,
  })
  await routines.append({
    id: crypto.randomUUID(),
    profileId: made.profileId,
    status: 'ready',
    createdAt: new Date(now.getTime() - HOUR),
    steps: [step('cleanse', 'am-pm'), step('treat', 'pm'), step('moisturise', 'am-pm'), step('protect', 'am')],
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
  })
  await routines.markStarted(made.profileId, new Date(`${dayOne}T00:00:00.000Z`))
  return made
}
/** An account whose day 1 was ten days ago: today is day 11, in week 2. */
const longStarted = () => startedAccount(shift(localDay(new Date(), null), -10))

const getToday = (bearer?: string) => fetchWorker('http://deepertones.test/api/v1/me/today', { headers: headers(bearer) })
const todayOf = async (account: Account) => dataOf<Record<string, any>>(await getToday(account.accessToken))
const postCheckIn = (account: Account, json: Record<string, unknown>) => v1.me.routine['check-ins'].$post({ json: json as never }, { headers: headers(account.accessToken) })
const putReminders = (account: Account, json: Record<string, unknown>) => v1.me.reminders.$put({ json: json as never }, { headers: headers(account.accessToken) })

const stepsOf = (list: { entries: { step: string }[] }) => list.entries.map((entry) => entry.step)
/** The morning or evening list of a body, whichever of `current` and `other` it is. */
const listOf = (today: Record<string, any>, half: 'morning' | 'evening') => (today.half === half ? today.current : today.other)

const WEEK_TWO = { title: 'Week two, for the integration test', text: 'The second week is about keeping going.' }

beforeAll(async () => {
  // Nigeria is an active country, so a shopping country can be set (a routine is read for the country the profile shops in).
  await applied((workbook) => withCountry(workbook, NIGERIA))
})

// These run first, while no step-down template is approved (the database is the file's, and the describe below approves them).
describe('GET /api/v1/me/today: who may ask', () => {
  it('answers 401 AUTH_REQUIRED without a token', async () => {
    const res = await getToday()

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('answers a guest with 403 SIGNUP_REQUIRED: the routine is saved with an account', async () => {
    const res = await getToday(await newGuest())

    expect(res.status).toBe(403)
    expect(await errorCodeOf(res)).toBe('SIGNUP_REQUIRED')
  })

  it('answers a signed-up account with no goal with 409 GOAL_REQUIRED, before the 503 (no template is approved yet): a hold or a due check-in does not show until there is a goal', async () => {
    const { accessToken } = await newVerified()

    const res = await getToday(accessToken)

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('GOAL_REQUIRED')
  })

  it('answers 503 VERDICT_UNAVAILABLE to an account with a goal while no step-down template is approved, as GET /me/routine does', async () => {
    const { accessToken } = await newReady()

    const res = await getToday(accessToken)

    expect(res.status).toBe(503)
    expect(await errorCodeOf(res)).toBe('VERDICT_UNAVAILABLE')
  })
})

describe('GET /api/v1/me/today: a signed-up account', () => {
  beforeAll(async () => {
    // The team's approved step-down templates (both are needed to pass the gate), and a distinct card for week 2.
    await applied((workbook) => {
      workbook.tapers.rows.push(taperRow({ kind: 'steroid' }), taperRow({ kind: 'lightening-agent' }))
      // The base card of band 2 is already there (the first import added the bands): its words are changed, so this test can tell it from the others.
      workbook.weeks.rows = workbook.weeks.rows.map((row) => (row.band === '2' && (row.goal ?? null) === null && (row.step_down ?? 'no') === 'no' ? { ...row, ...WEEK_TWO } : row))
    })
  })

  it('answers 200 with the not-started body for an account with a goal and no routine yet, with every key on the wire', async () => {
    const { accessToken } = await newReady()

    const res = await getToday(accessToken)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({
      started: false,
      day: localDay(new Date(), null),
      startsOn: null,
      week: null,
      card: null,
      half: expect.stringMatching(/^(morning|evening)$/),
      current: { done: false, entries: [] },
      other: { done: false, entries: [] },
      allDone: false,
      stepDowns: [],
      checkInsDue: [],
      hold: null,
      bringingBack: [],
      paused: [],
      remindersOff: true,
      inbox: { unread: 0, latest: [] },
    })
  })

  it('answers the week, its reviewed card, the day\'s two halves of the routine and the banner, read from real D1', async () => {
    const account = await longStarted()

    const res = await getToday(account.accessToken)
    const today = await dataOf<Record<string, any>>(res)

    expect(res.status).toBe(200)
    expect(today).toMatchObject({ started: true, day: localDay(new Date(), null), startsOn: shift(localDay(new Date(), null), -10), week: 2, card: WEEK_TWO, allDone: false, hold: null, checkInsDue: [], stepDowns: [], bringingBack: [], remindersOff: true })
    expect(['morning', 'evening']).toContain(today.half)
    // Cleanse and moisturise are morning and evening, the treatment is the evening's, the sunscreen the morning's; none is on a rest day, none is paused.
    expect(stepsOf(listOf(today, 'morning'))).toEqual(['cleanse', 'moisturise', 'protect'])
    expect(stepsOf(listOf(today, 'evening'))).toEqual(['cleanse', 'treat', 'moisturise'])
    expect(listOf(today, 'morning').entries[0]).toMatchObject({ step: 'cleanse', status: 'active', product: { kind: 'none' } })
    expect([today.current.done, today.other.done]).toEqual([false, false])
  })

  it('has exactly the documented keys, and nothing internal in an entry', async () => {
    const today = await todayOf(await longStarted())

    expect(Object.keys(today).sort()).toEqual(['allDone', 'bringingBack', 'card', 'checkInsDue', 'current', 'day', 'half', 'hold', 'inbox', 'other', 'paused', 'remindersOff', 'started', 'startsOn', 'stepDowns', 'week'])
    const entry = today.current.entries[0] ?? today.other.entries[0]
    for (const internal of ['grounding', 'fixedFrom', 'gotIt', 'changedOn']) expect(entry).not.toHaveProperty(internal)
  })

  it('shows the half the person ticked off as done once they have posted the check-in for it, and not the other', async () => {
    const account = await longStarted()
    const before = await todayOf(account)
    const ticked = before.half
    expect((await postCheckIn(account, { day: before.day, time: ticked })).status).toBe(200)

    const after = await todayOf(account)

    expect([after.current.done, after.other.done, after.allDone]).toEqual(before.half === after.half ? [true, false, false] : [false, true, false])
  })

  it('is all done once both halves are ticked off', async () => {
    const account = await longStarted()
    const { day } = await todayOf(account)
    for (const time of ['morning', 'evening']) expect((await postCheckIn(account, { day, time })).status).toBe(200)

    expect(await todayOf(account)).toMatchObject({ allDone: true, current: { done: true }, other: { done: true } })
  })

  it('stops saying reminders are off once they are switched on', async () => {
    const account = await longStarted()
    expect((await todayOf(account)).remindersOff).toBe(true)

    expect((await putReminders(account, { enabled: true, timeZone: 'UTC' })).status).toBe(200)

    expect((await todayOf(account)).remindersOff).toBe(false)
  })

  it('shows the inbox summary: the unread count and the newest rows, and the count falls when the person reads them through POST /me/inbox/read', async () => {
    const account = await longStarted()
    const row = await inbox.write({ profileId: account.profileId, kind: 'step-down-day', day: localDay(new Date(), null), title: 'Time for your evening routine', body: 'Your plan for tonight is ready.', link: '/routine', key: `today-test:${runSalt}:${next()}` })

    const unread = await todayOf(account)

    expect(unread.inbox.unread).toBe(1)
    expect(unread.inbox.latest).toEqual([{ id: row.id, kind: 'step-down-day', day: localDay(new Date(), null), title: 'Time for your evening routine', body: 'Your plan for tonight is ready.', link: '/routine', read: false, createdAt: expect.any(String) }])

    const read = await v1.me.inbox.read.$post({ json: { upTo: row.id } }, { headers: headers(account.accessToken) })
    expect(read.status).toBe(200)

    const after = await todayOf(account)
    expect(after.inbox.unread).toBe(0)
    expect(after.inbox.latest.map((item: any) => [item.id, item.read])).toEqual([[row.id, true]])
  })

  it('answers the day Start was tapped (day 1 is tomorrow) with started true, the day it starts, and no week, card or entries', async () => {
    const tomorrow = shift(localDay(new Date(), null), 1)
    const account = await startedAccount(tomorrow)

    expect(await todayOf(account)).toMatchObject({ started: true, startsOn: tomorrow, week: null, card: null, current: { entries: [] }, other: { entries: [] } })
  })
})
