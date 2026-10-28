import { beforeEach, describe, expect, it } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { FakeInboxRepository } from './inbox.repository.fake'
import { InboxService } from './inbox.service'

// The in-app inbox (spec #233, PR 3): the rows the routine writes about itself (a reminder, a step-down day, a pause) and the profile's reads of them. The repository
// is the real fake; the clock is one mutable instant.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the behaviour and the method names, not the constructor or the error classes; they follow RemindersService):
//   new InboxService({ repository, now?, newId? })
//     repository  InboxRepository (see inbox.repository.contract.ts)
//     now         the clock; a row's createdAt and a read's readAt come from it
//   write({ profileId, kind, day, title, body, link, key }): Promise<{ id: string; created: boolean }>
//     By profile id, no session (the 15-minute job and the services that raise events call it). Idempotent on (profile, key): a repeated key answers { id: <the first row's id>, created: false }
//     and changes nothing, whatever title it carries. Every title and body must pass FORBIDDEN_WORDING (routines.wording.ts), and the link must start with '/': otherwise it
//     THROWS (an Error; which class is the implementer's choice) and writes nothing, the key stays free.
//   list({ before?, limit? }): Promise<{ items: InboxItemView[]; next: string | null }>
//     The session profile's rows, newest first. limit defaults to 20 and is capped at 50 (a larger limit gives 50; the ROUTE refuses it with 400, see inbox.routes.test.ts).
//     `before` is the cursor: the id of an item the caller was given (it is what `next` holds, but nothing here reads inside it). next is non-null whenever more items follow this page;
//     whether it is null on an exactly full last page is not pinned. A walk through `next` until null yields every item exactly once. An unknown `before`, and another profile's, is
//     404 INBOX_ITEM_NOT_FOUND.
//     InboxItemView = { id, kind, day, title, body, link, read: boolean, createdAt: Date } and nothing else: no key, no profileId, no readAt.
//   markRead(upTo: string): Promise<{ unread: number }>
//     Session-scoped. upTo is an item id. Marks every unread row created at or before that row read (a row with the same createdAt counts as before), leaves newer ones, and answers the
//     profile's unread count after. Idempotent. An id the profile does not hold (unknown or another profile's) is 404 INBOX_ITEM_NOT_FOUND and marks nothing.
//   markReadById(profileId, id): Promise<void>      By profile id, no session (a push tap). Marks that one row read; an id the profile does not hold changes nothing and does not fail.
//   summaryFor(profileId): Promise<{ unread: number; latest: InboxItemView[] }>     By profile id, no session. unread counts every unread row; latest is the 5 newest rows, read or not.
//   Gates for list and markRead, in order: 401 AUTH_REQUIRED (no session), 403 SIGNUP_REQUIRED (a guest), then the rest.
//   Rows are kept for good: nothing here deletes one.

const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
/** The calendar day `n` days from T0's, as 'YYYY-MM-DD'. */
const day = (n: number) => new Date(T0.getTime() + n * DAY).toISOString().slice(0, 10)

const AMARA_USER = 'user-amara'
const AMARA = 'profile-amara-1'
const TOLU_USER = 'user-tolu'
const TOLU = 'profile-tolu-1'

const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'verified'): Actor => ({ kind: 'user', userId, status, profileId })
const AMARA_ACTOR = actor(AMARA_USER, AMARA)
const TOLU_ACTOR = actor(TOLU_USER, TOLU)
const GUEST = actor('user-guest', 'profile-guest', 'anonymous')
const PUBLIC: Actor = { kind: 'public' }
const SYSTEM: Actor = { kind: 'system', job: 'build-routine' }

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

let clock: Date
let repository: FakeInboxRepository
let service: InboxService

type Write = Parameters<InboxService['write']>[0]
let counter = 0
/** Writes a row for the profile at the current clock. Every field can be overridden; the key is unique unless a test sets it. */
const write = (profileId: string, overrides: Partial<Write> = {}) => {
  const n = counter++
  return runAs(SYSTEM, () => service.write({ profileId, kind: 'reminder', day: day(0), title: `Title ${n}`, body: `Body ${n}`, link: '/routine', key: `key-${n}`, ...overrides }))
}
/** Writes a row `ms` after T0, and answers its id. */
const writeAt = async (profileId: string, ms: number, overrides: Partial<Write> = {}) => {
  clock = new Date(T0.getTime() + ms)
  return (await write(profileId, overrides)).id
}

const list = (who: Actor, query: { before?: string; limit?: number } = {}) => runAs(who, () => service.list(query))
const markRead = (who: Actor, upTo: string) => runAs(who, () => service.markRead(upTo))
const markReadById = (profileId: string, id: string) => runAs(SYSTEM, () => service.markReadById(profileId, id))
const summaryFor = (profileId: string) => runAs(SYSTEM, () => service.summaryFor(profileId))
const idsOf = async (who: Actor, query: { before?: string; limit?: number } = {}) => (await list(who, query)).items.map((item) => item.id)

beforeEach(() => {
  clock = T0
  repository = new FakeInboxRepository()
  service = new InboxService({ repository, now: () => clock })
})

describe('InboxService.write', () => {
  it('stores a row for a profile with no session, and the profile reads it back as unread, stamped with the clock', async () => {
    clock = new Date(T0.getTime() + 5 * MINUTE)

    const result = await write(AMARA, { kind: 'step-down', day: day(2), title: 'Step-down day', body: 'From today use it every other day.', link: '/routine?step=treat', key: 'step-down:2030-06-17' })

    expect(result).toEqual({ id: expect.any(String), created: true })
    expect((await list(AMARA_ACTOR)).items).toEqual([
      { id: result.id, kind: 'step-down', day: day(2), title: 'Step-down day', body: 'From today use it every other day.', link: '/routine?step=treat', read: false, createdAt: clock },
    ])
  })

  it('answers the first row\'s id with created false for a repeated key, and changes nothing, whatever the second call carries', async () => {
    const first = await write(AMARA, { key: 'reminder:2030-06-15:07:00', title: 'Morning routine' })
    clock = new Date(T0.getTime() + MINUTE)

    const again = await write(AMARA, { key: 'reminder:2030-06-15:07:00', title: 'A different title', body: 'A different body', link: '/today' })

    expect(again).toEqual({ id: first.id, created: false })
    const { items } = await list(AMARA_ACTOR)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: first.id, title: 'Morning routine', link: '/routine', createdAt: T0 })
  })

  it('keeps keys per profile: another profile writing the same key makes its own row', async () => {
    const amara = await write(AMARA, { key: 'all-done:2030-06-15' })
    const tolu = await write(TOLU, { key: 'all-done:2030-06-15' })

    expect(tolu.created).toBe(true)
    expect(tolu.id).not.toBe(amara.id)
    expect(await idsOf(AMARA_ACTOR)).toEqual([amara.id])
    expect(await idsOf(TOLU_ACTOR)).toEqual([tolu.id])
  })

  it.each([
    ['a title that names a condition', { title: 'You have eczema' }],
    ['a body that names a condition', { body: 'Your skin looks calmer. You have eczema.' }],
    ['a title that promises lighter skin', { title: 'Lighter skin by the weekend' }],
    ['a body that grades the person', { body: 'Your skin score is up this week.' }],
    ['a body that diagnoses', { body: 'We diagnosed the flare.' }],
  ])('refuses %s and writes nothing', async (_name, overrides) => {
    await expect(write(AMARA, { key: 'paused:p1', ...overrides })).rejects.toThrow()

    expect(await summaryFor(AMARA)).toEqual({ unread: 0, latest: [] })
    // The refusal did not use up the key.
    expect(await write(AMARA, { key: 'paused:p1', title: 'Paused for now', body: 'Skip it until it feels calm.' })).toEqual({ id: expect.any(String), created: true })
  })

  it('accepts plain advice that only looks like a diagnosis ("use what you have")', async () => {
    const result = await write(AMARA, { title: 'Keep it simple', body: 'Use what you have, and rinse with water if anything stings.' })

    expect(result.created).toBe(true)
  })

  it.each([
    ['a link without a leading slash', 'routine'],
    ['a full URL', 'https://deepertones.com/routine'],
    ['an empty link', ''],
  ])('refuses %s and writes nothing', async (_name, link) => {
    await expect(write(AMARA, { link })).rejects.toThrow()

    expect(await summaryFor(AMARA)).toEqual({ unread: 0, latest: [] })
  })

  it('keeps a row however old it is: writing years later removes nothing', async () => {
    const old = await writeAt(AMARA, 0)

    const recent = await writeAt(AMARA, 3 * 365 * DAY)

    expect(await idsOf(AMARA_ACTOR, { limit: 50 })).toEqual([recent, old])
  })
})

describe('InboxService.list', () => {
  it('lists the session profile\'s rows newest first and no other profile\'s', async () => {
    const oldest = await writeAt(AMARA, 0)
    const newest = await writeAt(AMARA, 2 * MINUTE)
    const middle = await writeAt(AMARA, MINUTE)
    await writeAt(TOLU, 3 * MINUTE)

    expect(await list(AMARA_ACTOR)).toMatchObject({ items: [{ id: newest }, { id: middle }, { id: oldest }], next: null })
  })

  it('answers no items and no cursor for a profile with an empty inbox', async () => {
    expect(await list(AMARA_ACTOR)).toEqual({ items: [], next: null })
  })

  it('returns 20 items when no limit is given and a cursor to the rest, and the walk ends with every row exactly once', async () => {
    const written: string[] = []
    for (let i = 0; i < 21; i++) written.push(await writeAt(AMARA, i * MINUTE))
    const newestFirst = [...written].reverse()

    const first = await list(AMARA_ACTOR)
    expect(first.items.map((item) => item.id)).toEqual(newestFirst.slice(0, 20))
    expect(first.next).not.toBeNull()

    const second = await list(AMARA_ACTOR, { before: first.next! })
    expect(second.items.map((item) => item.id)).toEqual(newestFirst.slice(20))
    expect(second.next).toBeNull()
  })

  it('caps the page at 50, and a limit of exactly 50 is allowed', async () => {
    for (let i = 0; i < 60; i++) await writeAt(AMARA, i * MINUTE)

    expect((await list(AMARA_ACTOR, { limit: 50 })).items).toHaveLength(50)
    const asked = await list(AMARA_ACTOR, { limit: 100 })
    expect(asked.items).toHaveLength(50)
    expect(asked.next).not.toBeNull()
  })

  it('pages by a given limit and walks every row exactly once in newest-first order, even when rows share one instant', async () => {
    // The 15-minute job writes several rows for a profile at one instant, so a cursor must not skip or repeat on a tie.
    const ids: string[] = []
    for (const offset of [0, 0, 0, MINUTE, MINUTE, 2 * MINUTE, 2 * MINUTE, 2 * MINUTE, 2 * MINUTE]) ids.push(await writeAt(AMARA, offset))
    const everything = await idsOf(AMARA_ACTOR, { limit: 50 })
    expect([...everything].sort()).toEqual([...ids].sort())
    // Newest first: the four written at +2 minutes lead, then the two at +1, then the three at the start.
    expect(new Set(everything.slice(0, 4))).toEqual(new Set(ids.slice(5)))
    expect(new Set(everything.slice(4, 6))).toEqual(new Set(ids.slice(3, 5)))
    expect(new Set(everything.slice(6))).toEqual(new Set(ids.slice(0, 3)))

    for (const limit of [1, 2, 4]) {
      const walked: string[] = []
      let cursor: string | undefined
      for (let pages = 0; pages < 20; pages++) {
        const page = await list(AMARA_ACTOR, { before: cursor, limit })
        expect(page.items.length).toBeLessThanOrEqual(limit)
        walked.push(...page.items.map((item) => item.id))
        if (page.next === null) break
        cursor = page.next
      }
      expect(walked).toEqual(everything)
    }
  })

  it('shows a row as read once it has been marked read', async () => {
    const older = await writeAt(AMARA, 0)
    const newer = await writeAt(AMARA, MINUTE)

    await markRead(AMARA_ACTOR, older)

    expect((await list(AMARA_ACTOR)).items.map((item) => [item.id, item.read])).toEqual([[newer, false], [older, true]])
  })

  it('answers 404 INBOX_ITEM_NOT_FOUND for a cursor that is no row of the profile\'s, another profile\'s row included', async () => {
    await writeAt(AMARA, 0)
    const strangers = await writeAt(TOLU, MINUTE)

    expect(await errorOf(list(AMARA_ACTOR, { before: strangers }))).toMatchObject({ name: 'NotFoundError', code: 'INBOX_ITEM_NOT_FOUND' })
    expect(await errorOf(list(AMARA_ACTOR, { before: crypto.randomUUID() }))).toMatchObject({ name: 'NotFoundError', code: 'INBOX_ITEM_NOT_FOUND' })
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED and a caller with no session with 401 AUTH_REQUIRED', async () => {
    await writeAt(AMARA, 0)

    expect(await errorOf(list(GUEST))).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(await errorOf(list(PUBLIC))).toMatchObject({ name: 'UnauthorizedError', code: 'AUTH_REQUIRED' })
  })
})

describe('InboxService.markRead', () => {
  it('marks the row and every unread row created at or before it read, leaves newer rows unread, and answers the unread count after', async () => {
    const oldest = await writeAt(AMARA, 0)
    const target = await writeAt(AMARA, MINUTE)
    const newest = await writeAt(AMARA, 2 * MINUTE)

    expect(await markRead(AMARA_ACTOR, target)).toEqual({ unread: 1 })

    expect((await list(AMARA_ACTOR)).items.map((item) => [item.id, item.read])).toEqual([[newest, false], [target, true], [oldest, true]])
  })

  it('counts a row written at the same instant as the row marked as before it', async () => {
    const first = await writeAt(AMARA, 0)
    const second = await writeAt(AMARA, 0)
    const later = await writeAt(AMARA, 1)

    expect(await markRead(AMARA_ACTOR, first)).toEqual({ unread: 1 })

    const read = Object.fromEntries((await list(AMARA_ACTOR)).items.map((item) => [item.id, item.read]))
    expect(read).toEqual({ [first]: true, [second]: true, [later]: false })
  })

  it('is idempotent: marking again changes nothing, and marking an older row never unreads a newer one', async () => {
    const oldest = await writeAt(AMARA, 0)
    const newest = await writeAt(AMARA, MINUTE)
    expect(await markRead(AMARA_ACTOR, newest)).toEqual({ unread: 0 })

    expect(await markRead(AMARA_ACTOR, newest)).toEqual({ unread: 0 })
    expect(await markRead(AMARA_ACTOR, oldest)).toEqual({ unread: 0 })

    expect((await list(AMARA_ACTOR)).items.map((item) => item.read)).toEqual([true, true])
  })

  it('never touches another profile\'s rows, even ones created earlier', async () => {
    const mine = await writeAt(AMARA, MINUTE)
    await writeAt(TOLU, 0)
    await writeAt(TOLU, MINUTE)

    await markRead(AMARA_ACTOR, mine)

    expect((await list(TOLU_ACTOR)).items.map((item) => item.read)).toEqual([false, false])
    expect(await summaryFor(TOLU)).toMatchObject({ unread: 2 })
  })

  it('answers 404 INBOX_ITEM_NOT_FOUND for a row the profile does not hold and marks nothing, another profile\'s row included', async () => {
    await writeAt(AMARA, 0)
    const strangers = await writeAt(TOLU, MINUTE)

    expect(await errorOf(markRead(AMARA_ACTOR, strangers))).toMatchObject({ name: 'NotFoundError', code: 'INBOX_ITEM_NOT_FOUND' })
    expect(await errorOf(markRead(AMARA_ACTOR, crypto.randomUUID()))).toMatchObject({ name: 'NotFoundError', code: 'INBOX_ITEM_NOT_FOUND' })

    expect(await summaryFor(AMARA)).toMatchObject({ unread: 1 })
    expect(await summaryFor(TOLU)).toMatchObject({ unread: 1 })
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED and a caller with no session with 401 AUTH_REQUIRED', async () => {
    const id = await writeAt(AMARA, 0)

    expect(await errorOf(markRead(GUEST, id))).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(await errorOf(markRead(PUBLIC, id))).toMatchObject({ name: 'UnauthorizedError', code: 'AUTH_REQUIRED' })
    expect(await summaryFor(AMARA)).toMatchObject({ unread: 1 })
  })
})

describe('InboxService.markReadById', () => {
  it('marks that one row read, by profile id with no session, and not the older rows', async () => {
    const older = await writeAt(AMARA, 0)
    const tapped = await writeAt(AMARA, MINUTE)

    await markReadById(AMARA, tapped)

    expect((await list(AMARA_ACTOR)).items.map((item) => [item.id, item.read])).toEqual([[tapped, true], [older, false]])
  })

  it('leaves another profile\'s row unread and does not fail for an id the profile does not hold', async () => {
    const strangers = await writeAt(TOLU, 0)

    await markReadById(AMARA, strangers)
    await markReadById(AMARA, crypto.randomUUID())

    expect(await summaryFor(TOLU)).toMatchObject({ unread: 1 })
  })
})

describe('InboxService.summaryFor', () => {
  it('answers nothing unread and no rows for an empty inbox', async () => {
    expect(await summaryFor(AMARA)).toEqual({ unread: 0, latest: [] })
  })

  it('counts every unread row but lists only the 5 newest, read or not', async () => {
    const ids: string[] = []
    for (let i = 0; i < 7; i++) ids.push(await writeAt(AMARA, i * MINUTE))
    await writeAt(TOLU, 8 * MINUTE)
    await markReadById(AMARA, ids[6]!)

    const summary = await summaryFor(AMARA)

    expect(summary.unread).toBe(6)
    expect(summary.latest.map((item) => item.id)).toEqual([ids[6], ids[5], ids[4], ids[3], ids[2]])
    expect(summary.latest.map((item) => item.read)).toEqual([true, false, false, false, false])
  })

  it('shows each row in the same shape the list does, with no key and no profile id', async () => {
    await writeAt(AMARA, 0, { kind: 'rest-night', day: day(1), title: 'Rest night', body: 'Nothing to apply tonight.', link: '/routine', key: 'rest-night:2030-06-16' })

    const { latest } = await summaryFor(AMARA)

    expect(latest).toEqual([{ id: expect.any(String), kind: 'rest-night', day: day(1), title: 'Rest night', body: 'Nothing to apply tonight.', link: '/routine', read: false, createdAt: T0 }])
    expect(latest).toEqual((await list(AMARA_ACTOR)).items)
  })
})
