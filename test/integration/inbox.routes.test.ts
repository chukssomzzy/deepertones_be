import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { describe, expect, it } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { D1InboxRepository } from '../../src/modules/inbox/inbox.repository'
import { InboxService } from '../../src/modules/inbox/inbox.service'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { ProfilesService } from '../../src/modules/profiles/profiles.service'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'

// The inbox routes (spec #233, PR 3) through the Worker's public surface, as the app uses them: the typed client against the real entrypoint and real local D1.
// Nothing writes an inbox row over HTTP (the routine writes them), so a test seeds rows through InboxService.write, the call the routine and the 15-minute job make,
// with a clock it controls; everything else is observed through the routes themselves.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief gives the shapes; the limits and the not-found code are the assumptions):
//   GET  /api/v1/me/inbox?before=&limit=   200 { items: [{ id, kind, day, title, body, link, read, createdAt }], next: string | null }, newest first. createdAt is an ISO string.
//        limit is a whole number 1..50 (default 20); 0, 51 and a non-number are 400 VALIDATION_FAILED. `before` is the `next` of a page. A `before` that is no row of the
//        caller's is 404 INBOX_ITEM_NOT_FOUND. No item has a `key` or a `profileId`.
//   POST /api/v1/me/inbox/read { upTo }    200 { unread }. upTo is an item id; a missing, empty or non-string one is 400 VALIDATION_FAILED, one the caller does not hold
//        404 INBOX_ITEM_NOT_FOUND.
//   Both: 401 AUTH_REQUIRED with no session (before the body is looked at, as PUT /me/reminders), 403 SIGNUP_REQUIRED for a guest.

const WORKER_ENV = { ...env, OTP_CHANNELS: 'email' }

// The one clock the seeded rows hang off; later rows are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const day = (n: number) => new Date(BASE.getTime() + n * DAY).toISOString().slice(0, 10)

const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())

const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })
const v1 = api.api.v1
const inbox = v1.me.inbox

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per call keeps the rate limits (keyed by IP) from coupling tests to each other.
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshEmail = () => `Inbox-${runSalt}-${next()}@Example.com`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number }
type Item = { id: string; kind: string; day: string; title: string; body: string; link: string; read: boolean; createdAt: string }
type Page = { items: Item[]; next: string | null }

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

let clock = BASE
const inboxService = new InboxService({ repository: new D1InboxRepository(db), now: () => clock })

/** A new guest session, the way an app install starts one. */
const newGuest = async () => {
  const deviceId = `device-install-${runSalt}-${next()}`
  const res = await v1.auth.anonymous.$post({ json: { deviceId, platform: 'ios' } }, { headers: headers() })
  const session = await dataOf<{ tokens: { accessToken: string }; user: { id: string } }>(res)
  return { accessToken: session.tokens.accessToken, userId: session.user.id }
}

/** A signed-up account, and an access token for its own default profile. */
const newVerified = async () => {
  const guest = await users.guestForDevice(`seed-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: freshEmail().toLowerCase() as EmailAddress })
  const profileId = (await profiles.defaultFor(user.id)).id
  return { user, profileId, accessToken: (await tokenService.issue(user, profileId)).accessToken }
}

/** Writes a row for the profile `ms` after BASE, the way the routine does, and answers its id. */
const seed = async (profileId: string, ms: number, overrides: Partial<Parameters<InboxService['write']>[0]> = {}) => {
  clock = new Date(BASE.getTime() + ms)
  const n = next()
  return (await inboxService.write({ profileId, kind: 'reminder', day: day(0), title: `Title ${n}`, body: `Body ${n}`, link: '/routine', key: `key-${runSalt}-${n}`, ...overrides })).id
}

const getInbox = (bearer?: string, query: Record<string, string> = {}) => inbox.$get({ query: query as never }, { headers: headers(bearer) })
const postRead = (bearer: string | undefined, json: Record<string, unknown>) => inbox.read.$post({ json: json as never }, { headers: headers(bearer) })
const idsOf = (page: Page) => page.items.map((item) => item.id)

describe('GET /api/v1/me/inbox', () => {
  it('answers an empty page and no cursor for an account with nothing in its inbox', async () => {
    const { accessToken } = await newVerified()

    const res = await getInbox(accessToken)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ items: [], next: null })
  })

  it('answers each row with exactly these fields, newest first, createdAt as an ISO time, and never the key or the profile id', async () => {
    const { accessToken, profileId } = await newVerified()
    const oldest = await seed(profileId, 0, { kind: 'step-down', day: day(2), title: 'Step-down day', body: 'From today use it every other day.', link: '/routine?step=treat', key: `step-down:${runSalt}` })
    const newest = await seed(profileId, 5 * MINUTE, { kind: 'rest-night', day: day(3), title: 'Rest night', body: 'Nothing to apply tonight.', link: '/routine', key: `rest-night:${runSalt}` })

    const page = await dataOf<Page>(await getInbox(accessToken))

    expect(page).toEqual({
      items: [
        { id: newest, kind: 'rest-night', day: day(3), title: 'Rest night', body: 'Nothing to apply tonight.', link: '/routine', read: false, createdAt: new Date(BASE.getTime() + 5 * MINUTE).toISOString() },
        { id: oldest, kind: 'step-down', day: day(2), title: 'Step-down day', body: 'From today use it every other day.', link: '/routine?step=treat', read: false, createdAt: BASE.toISOString() },
      ],
      next: null,
    })
  })

  it('shows only the caller\'s own rows', async () => {
    const mine = await newVerified()
    const other = await newVerified()
    const own = await seed(mine.profileId, 0)
    await seed(other.profileId, MINUTE)

    expect(idsOf(await dataOf<Page>(await getInbox(mine.accessToken)))).toEqual([own])
  })

  it('answers 20 rows when no limit is given, with a cursor to the rest, and the cursor leads to the last one', async () => {
    const { accessToken, profileId } = await newVerified()
    const written: string[] = []
    for (let i = 0; i < 21; i++) written.push(await seed(profileId, i * MINUTE))
    const newestFirst = [...written].reverse()

    const first = await dataOf<Page>(await getInbox(accessToken))
    expect(idsOf(first)).toEqual(newestFirst.slice(0, 20))
    expect(first.next).not.toBeNull()

    const second = await dataOf<Page>(await getInbox(accessToken, { before: first.next! }))
    expect(idsOf(second)).toEqual(newestFirst.slice(20))
    expect(second.next).toBeNull()
  })

  it('pages by `limit`, and following `next` until it is null yields every row exactly once, even rows written at one instant', async () => {
    const { accessToken, profileId } = await newVerified()
    const ids: string[] = []
    for (const offset of [0, 0, 0, MINUTE, MINUTE, 2 * MINUTE, 2 * MINUTE]) ids.push(await seed(profileId, offset))
    const everything = idsOf(await dataOf<Page>(await getInbox(accessToken, { limit: '50' })))
    expect([...everything].sort()).toEqual([...ids].sort())

    const walked: string[] = []
    let cursor: string | null = null
    for (let pages = 0; pages < 10; pages++) {
      const page: Page = await dataOf<Page>(await getInbox(accessToken, { limit: '2', ...(cursor === null ? {} : { before: cursor }) }))
      expect(page.items.length).toBeLessThanOrEqual(2)
      walked.push(...idsOf(page))
      cursor = page.next
      if (cursor === null) break
    }
    expect(cursor).toBeNull()
    expect(walked).toEqual(everything)
  })

  it('accepts a limit of exactly 50', async () => {
    const { accessToken } = await newVerified()

    expect((await getInbox(accessToken, { limit: '50' })).status).toBe(200)
    expect((await getInbox(accessToken, { limit: '1' })).status).toBe(200)
  })

  it.each([
    ['0', '0'],
    ['51', '51'],
    ['a negative number', '-1'],
    ['a fraction', '2.5'],
    ['text', 'many'],
  ])('answers 400 VALIDATION_FAILED for a limit of %s', async (_label, limit) => {
    const { accessToken } = await newVerified()

    const res = await getInbox(accessToken, { limit })

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
  })

  it('answers 404 INBOX_ITEM_NOT_FOUND for a cursor that is no row of the caller\'s, another account\'s row included', async () => {
    const mine = await newVerified()
    const other = await newVerified()
    await seed(mine.profileId, 0)
    const strangers = await seed(other.profileId, MINUTE)

    const own = await getInbox(mine.accessToken, { before: strangers })
    const unknown = await getInbox(mine.accessToken, { before: crypto.randomUUID() })

    expect(own.status).toBe(404)
    expect(await errorCodeOf(own)).toBe('INBOX_ITEM_NOT_FOUND')
    expect(unknown.status).toBe(404)
    expect(await errorCodeOf(unknown)).toBe('INBOX_ITEM_NOT_FOUND')
  })

  it('answers 403 SIGNUP_REQUIRED to a guest', async () => {
    const { accessToken } = await newGuest()

    const res = await getInbox(accessToken)

    expect(res.status).toBe(403)
    expect(await errorCodeOf(res)).toBe('SIGNUP_REQUIRED')
  })

  it('answers 401 AUTH_REQUIRED without a bearer token', async () => {
    const res = await getInbox()

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })
})

describe('POST /api/v1/me/inbox/read', () => {
  it('marks the row and everything older read, leaves newer rows unread, and answers the unread count', async () => {
    const { accessToken, profileId } = await newVerified()
    const oldest = await seed(profileId, 0)
    const target = await seed(profileId, MINUTE)
    const newest = await seed(profileId, 2 * MINUTE)

    const res = await postRead(accessToken, { upTo: target })

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ unread: 1 })
    const page = await dataOf<Page>(await getInbox(accessToken))
    expect(page.items.map((item) => [item.id, item.read])).toEqual([[newest, false], [target, true], [oldest, true]])
  })

  it('is idempotent: the same call again answers the same count and changes nothing', async () => {
    const { accessToken, profileId } = await newVerified()
    await seed(profileId, 0)
    const target = await seed(profileId, MINUTE)
    await seed(profileId, 2 * MINUTE)
    await postRead(accessToken, { upTo: target })

    const again = await postRead(accessToken, { upTo: target })

    expect(again.status).toBe(200)
    expect(await dataOf(again)).toEqual({ unread: 1 })
  })

  it('answers zero unread once the newest row is marked', async () => {
    const { accessToken, profileId } = await newVerified()
    await seed(profileId, 0)
    const newest = await seed(profileId, MINUTE)

    expect(await dataOf(await postRead(accessToken, { upTo: newest }))).toEqual({ unread: 0 })
  })

  it('never touches another account\'s rows, and refuses their row id with 404 INBOX_ITEM_NOT_FOUND', async () => {
    const mine = await newVerified()
    const other = await newVerified()
    const own = await seed(mine.profileId, 5 * MINUTE)
    const strangers = await seed(other.profileId, 0)

    await postRead(mine.accessToken, { upTo: own })
    const refused = await postRead(mine.accessToken, { upTo: strangers })

    expect(refused.status).toBe(404)
    expect(await errorCodeOf(refused)).toBe('INBOX_ITEM_NOT_FOUND')
    expect((await dataOf<Page>(await getInbox(other.accessToken))).items.map((item) => item.read)).toEqual([false])
  })

  it('answers 404 INBOX_ITEM_NOT_FOUND for a row that does not exist', async () => {
    const { accessToken } = await newVerified()

    const res = await postRead(accessToken, { upTo: crypto.randomUUID() })

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('INBOX_ITEM_NOT_FOUND')
  })

  it.each([
    ['no upTo', {}],
    ['an empty upTo', { upTo: '' }],
    ['an upTo that is not a string', { upTo: 7 }],
    ['an upTo of null', { upTo: null }],
  ])('answers 400 VALIDATION_FAILED for %s', async (_label, json) => {
    const { accessToken } = await newVerified()

    const res = await postRead(accessToken, json)

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
  })

  it('answers 403 SIGNUP_REQUIRED to a guest, and marks nothing', async () => {
    const { accessToken } = await newGuest()

    const res = await postRead(accessToken, { upTo: crypto.randomUUID() })

    expect(res.status).toBe(403)
    expect(await errorCodeOf(res)).toBe('SIGNUP_REQUIRED')
  })

  it('answers 401 AUTH_REQUIRED without a bearer token, and before the body is checked', async () => {
    const withBody = await postRead(undefined, { upTo: crypto.randomUUID() })
    const withoutBody = await fetchWorker('http://deepertones.test/api/v1/me/inbox/read', { method: 'POST', headers: headers() })

    expect(withBody.status).toBe(401)
    expect(await errorCodeOf(withBody)).toBe('AUTH_REQUIRED')
    expect(withoutBody.status).toBe(401)
    expect(await errorCodeOf(withoutBody)).toBe('AUTH_REQUIRED')
  })
})

// POST /api/v1/me/inbox/{id}/read (spec #233, PR 8b): the tap on a push. The push carries `data.inboxId`, and the app posts it here. Unlike `POST /inbox/read { upTo }` it marks that one row
// and nothing older. 200 for a row the caller holds (read again is 200 too), 401 AUTH_REQUIRED with no session, 403 SIGNUP_REQUIRED for a guest, 404 INBOX_ITEM_NOT_FOUND for an id that is
// another profile's or nobody's (and that profile's row is left as it was). The typed client has no call for a route that did not exist, so these go by plain fetch. The body of a 200 is not pinned.
const postTap = (bearer: string | undefined, id: string) => fetchWorker(`http://deepertones.test/api/v1/me/inbox/${encodeURIComponent(id)}/read`, { method: 'POST', headers: headers(bearer) })

describe('POST /api/v1/me/inbox/{id}/read', () => {
  it('marks that row read and no other: an older unread row stays unread, which is what sets it apart from marking up to a row', async () => {
    const { accessToken, profileId } = await newVerified()
    const older = await seed(profileId, 0)
    const tapped = await seed(profileId, MINUTE)
    const newer = await seed(profileId, 2 * MINUTE)

    const res = await postTap(accessToken, tapped)

    expect(res.status).toBe(200)
    const page = await dataOf<Page>(await getInbox(accessToken))
    expect(page.items.map((item) => [item.id, item.read])).toEqual([[newer, false], [tapped, true], [older, false]])
  })

  it('is idempotent: tapping the same push again is 200 and changes nothing', async () => {
    const { accessToken, profileId } = await newVerified()
    const tapped = await seed(profileId, 0)
    await postTap(accessToken, tapped)

    const again = await postTap(accessToken, tapped)

    expect(again.status).toBe(200)
    expect((await dataOf<Page>(await getInbox(accessToken))).items.map((item) => item.read)).toEqual([true])
  })

  it('answers 404 INBOX_ITEM_NOT_FOUND for another account\'s row, and leaves that row unread', async () => {
    const mine = await newVerified()
    const other = await newVerified()
    const strangers = await seed(other.profileId, 0)

    const res = await postTap(mine.accessToken, strangers)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('INBOX_ITEM_NOT_FOUND')
    expect((await dataOf<Page>(await getInbox(other.accessToken))).items.map((item) => item.read)).toEqual([false])
  })

  it('answers 404 INBOX_ITEM_NOT_FOUND for an id nobody holds', async () => {
    const { accessToken } = await newVerified()

    const res = await postTap(accessToken, crypto.randomUUID())

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('INBOX_ITEM_NOT_FOUND')
  })

  it('answers 403 SIGNUP_REQUIRED to a guest', async () => {
    const { accessToken } = await newGuest()

    const res = await postTap(accessToken, crypto.randomUUID())

    expect(res.status).toBe(403)
    expect(await errorCodeOf(res)).toBe('SIGNUP_REQUIRED')
  })

  it('answers 401 AUTH_REQUIRED without a bearer token', async () => {
    const res = await postTap(undefined, crypto.randomUUID())

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })
})
