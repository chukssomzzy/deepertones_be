import { describe, expect, it } from 'vitest'
import type { InboxRepository } from './inbox.repository'

// The one clock every fixture hangs off; later times are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)
/** The calendar day `n` days from BASE's, as 'YYYY-MM-DD'. */
const day = (n: number) => new Date(BASE.getTime() + n * DAY).toISOString().slice(0, 10)

type Account = { userId: string; profileId: string }

/**
 * What an inbox contract run needs: the repository, and a way to get an account that really exists, the way every account does in life (D1 enforces
 * inbox_items.profile_id -> profiles). `newAccount` is a user with its default profile.
 *
 * THE CONTRACT THIS FILE PINS (assumed: the brief names the table and the service, not the repository's methods; they follow reminders.sends and routines.check-ins):
 *   InboxItem = { id, profileId, kind, localDay, title, body, link, key, readAt: Date | null, createdAt: Date }     the whole stored row (the service hides key and profileId)
 *   NewInboxItem = Omit<InboxItem, 'readAt'>                                                                    a row starts unread; the caller supplies the id and the time
 *   insertOnce(row: NewInboxItem): Promise<{ id: string; created: boolean }>
 *       Inserts the row unless the profile already holds the key. created is true when THIS call inserted it, false when the key was held (the stored row is left as it was,
 *       and `id` is the id of the row that holds the key). Atomic: of several inserts for one (profile, key) made at the same time, exactly one is created and all answer the same id.
 *       Rejects a profile that does not exist (D1 only; the fake does not model the foreign key).
 *   find(profileId, id): Promise<InboxItem | null>        null for an id the profile does not hold, including another profile's row
 *   list(profileId, { before?, limit }): Promise<InboxItem[]>
 *       The profile's rows, newest first (createdAt descending; rows with the same createdAt keep ONE stable order, the same on every call), at most `limit`.
 *       `before` is a row as list gave it ({ createdAt, id }): the page starts right after that row in list order. A walk of pages through `before` yields every row exactly once.
 *   markReadUpTo(profileId, upTo: Date, at: Date): Promise<void>
 *       Marks the profile's UNREAD rows with createdAt <= upTo (the boundary is inclusive) read, readAt = at. A row already read keeps its readAt. Touches no other profile.
 *   markRead(profileId, id, at): Promise<void>
 *       Marks that one row read (readAt = at) when the profile holds it and it is unread. Any other id, and another profile's row, changes nothing and does not fail.
 *   unreadCount(profileId): Promise<number>               the profile's rows with readAt null
 * Rows are kept for good: there is no delete here (they go only with the profile, by the foreign key's cascade, which the D1 test pins).
 */
export type InboxContractSetup = {
  repository: InboxRepository
  newAccount: () => Promise<Account>
}

let counter = 0
/** A new row for the profile. Every field can be overridden; the id and key are unique unless a test sets them. */
const row = (profileId: string, overrides: Partial<Parameters<InboxRepository['insertOnce']>[0]> = {}) => {
  const n = counter++
  return {
    id: crypto.randomUUID(),
    profileId,
    kind: 'reminder',
    localDay: day(0),
    title: `Title ${n}`,
    body: `Body ${n}`,
    link: '/routine',
    key: `key-${n}`,
    createdAt: at(0),
    ...overrides,
  }
}

const idsOf = (items: { id: string }[]) => items.map((item) => item.id)

/** Behaviour every InboxRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const inboxRepositoryContract = (name: string, make: () => InboxContractSetup | Promise<InboxContractSetup>) => {
  describe(`InboxRepository contract: ${name}`, () => {
    it('stores a row unread and finds it whole by its id', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      const input = row(profileId, { kind: 'step-down', localDay: day(3), title: 'Step-down day', body: 'From today use it every other day.', link: '/routine?step=treat', key: 'step-down:2030-06-18', createdAt: at(MINUTE) })

      const result = await repository.insertOnce(input)

      expect(result).toEqual({ id: input.id, created: true })
      expect(await repository.find(profileId, input.id)).toEqual({ ...input, readAt: null })
    })

    it('answers the existing row\'s id and leaves it as it was when the profile already holds the key', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      const first = row(profileId, { key: 'reminder:2030-06-15:07:00', title: 'Morning', createdAt: at(MINUTE) })
      await repository.insertOnce(first)

      const again = await repository.insertOnce(row(profileId, { key: 'reminder:2030-06-15:07:00', title: 'Changed', createdAt: at(2 * MINUTE) }))

      expect(again).toEqual({ id: first.id, created: false })
      expect(await repository.find(profileId, first.id)).toMatchObject({ title: 'Morning', createdAt: at(MINUTE) })
      expect(await repository.list(profileId, { limit: 10 })).toHaveLength(1)
    })

    it('holds a key per profile: two profiles may use the same key', async () => {
      const { repository, newAccount } = await make()
      const first = (await newAccount()).profileId
      const second = (await newAccount()).profileId

      const a = await repository.insertOnce(row(first, { key: 'all-done:2030-06-15' }))
      const b = await repository.insertOnce(row(second, { key: 'all-done:2030-06-15' }))

      expect(a.created).toBe(true)
      expect(b.created).toBe(true)
      expect(b.id).not.toBe(a.id)
    })

    it('lets exactly one of several inserts made at the same time for one key win, and every call answers the winner\'s id', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      const results = await Promise.all(Array.from({ length: 5 }, () => repository.insertOnce(row(profileId, { key: 'escalation:hold-1' }))))

      expect(results.filter((result) => result.created)).toHaveLength(1)
      const winner = results.find((result) => result.created)!
      expect(results.map((result) => result.id)).toEqual(Array(5).fill(winner.id))
      expect(await repository.list(profileId, { limit: 10 })).toHaveLength(1)
    })

    it('does not find another profile\'s row', async () => {
      const { repository, newAccount } = await make()
      const mine = (await newAccount()).profileId
      const stranger = (await newAccount()).profileId
      const input = row(mine)
      await repository.insertOnce(input)

      expect(await repository.find(stranger, input.id)).toBeNull()
      expect(await repository.find(mine, crypto.randomUUID())).toBeNull()
    })

    it('lists a profile\'s rows newest first, and only its own', async () => {
      const { repository, newAccount } = await make()
      const mine = (await newAccount()).profileId
      const stranger = (await newAccount()).profileId
      const oldest = row(mine, { createdAt: at(0) })
      const middle = row(mine, { createdAt: at(MINUTE) })
      const newest = row(mine, { createdAt: at(2 * MINUTE) })
      for (const input of [middle, newest, oldest, row(stranger, { createdAt: at(3 * MINUTE) })]) await repository.insertOnce(input)

      const listed = await repository.list(mine, { limit: 10 })

      expect(idsOf(listed)).toEqual([newest.id, middle.id, oldest.id])
      expect(await repository.list((await newAccount()).profileId, { limit: 10 })).toEqual([])
    })

    it('lists at most `limit` rows', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      for (let i = 0; i < 4; i++) await repository.insertOnce(row(profileId, { createdAt: at(i * MINUTE) }))

      expect(await repository.list(profileId, { limit: 3 })).toHaveLength(3)
      expect(await repository.list(profileId, { limit: 4 })).toHaveLength(4)
      expect(await repository.list(profileId, { limit: 5 })).toHaveLength(4)
    })

    it('walks pages through `before` with every row exactly once and in list order, including rows written at the same instant', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      // The 15-minute job writes several rows for one profile at one instant, so ties are the normal case, not the corner.
      for (const offset of [0, 0, 0, MINUTE, MINUTE, 2 * MINUTE, 2 * MINUTE, 2 * MINUTE, 2 * MINUTE]) await repository.insertOnce(row(profileId, { createdAt: at(offset) }))
      const everything = await repository.list(profileId, { limit: 50 })
      expect(everything).toHaveLength(9)
      expect(everything.map((item) => item.createdAt.getTime())).toEqual([...everything.map((item) => item.createdAt.getTime())].sort((a, b) => b - a))
      expect(idsOf(await repository.list(profileId, { limit: 50 }))).toEqual(idsOf(everything))

      for (const size of [1, 2, 4]) {
        const walked: string[] = []
        let page = await repository.list(profileId, { limit: size })
        while (page.length > 0) {
          walked.push(...idsOf(page))
          const last = page[page.length - 1]!
          page = await repository.list(profileId, { before: { createdAt: last.createdAt, id: last.id }, limit: size })
        }
        expect(walked).toEqual(idsOf(everything))
      }
    })

    it('marks the unread rows created at or before a time read, the boundary included, and leaves newer rows unread', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      const older = row(profileId, { createdAt: at(-MINUTE) })
      const tiedA = row(profileId, { createdAt: at(0) })
      const tiedB = row(profileId, { createdAt: at(0) })
      const newer = row(profileId, { createdAt: at(1) })
      for (const input of [older, tiedA, tiedB, newer]) await repository.insertOnce(input)

      await repository.markReadUpTo(profileId, at(0), at(10 * MINUTE))

      expect((await repository.find(profileId, older.id))!.readAt).toEqual(at(10 * MINUTE))
      expect((await repository.find(profileId, tiedA.id))!.readAt).toEqual(at(10 * MINUTE))
      expect((await repository.find(profileId, tiedB.id))!.readAt).toEqual(at(10 * MINUTE))
      expect((await repository.find(profileId, newer.id))!.readAt).toBeNull()
      expect(await repository.unreadCount(profileId)).toBe(1)
    })

    it('keeps the time a row was first read when it is marked again, and never unreads a row', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      const first = row(profileId, { createdAt: at(0) })
      const second = row(profileId, { createdAt: at(MINUTE) })
      await repository.insertOnce(first)
      await repository.insertOnce(second)
      await repository.markReadUpTo(profileId, at(MINUTE), at(5 * MINUTE))

      await repository.markReadUpTo(profileId, at(MINUTE), at(9 * MINUTE))
      await repository.markReadUpTo(profileId, at(0), at(9 * MINUTE))

      expect((await repository.find(profileId, first.id))!.readAt).toEqual(at(5 * MINUTE))
      expect((await repository.find(profileId, second.id))!.readAt).toEqual(at(5 * MINUTE))
      expect(await repository.unreadCount(profileId)).toBe(0)
    })

    it('touches no other profile when it marks rows read', async () => {
      const { repository, newAccount } = await make()
      const mine = (await newAccount()).profileId
      const stranger = (await newAccount()).profileId
      const strangers = row(stranger, { createdAt: at(0) })
      await repository.insertOnce(row(mine, { createdAt: at(0) }))
      await repository.insertOnce(strangers)

      await repository.markReadUpTo(mine, at(DAY), at(MINUTE))

      expect(await repository.unreadCount(mine)).toBe(0)
      expect(await repository.unreadCount(stranger)).toBe(1)
      expect((await repository.find(stranger, strangers.id))!.readAt).toBeNull()
    })

    it('marks one row read by its id and no other, keeps its first read time, and ignores an id the profile does not hold', async () => {
      const { repository, newAccount } = await make()
      const mine = (await newAccount()).profileId
      const stranger = (await newAccount()).profileId
      const older = row(mine, { createdAt: at(0) })
      const target = row(mine, { createdAt: at(MINUTE) })
      const strangers = row(stranger, { createdAt: at(MINUTE) })
      for (const input of [older, target, strangers]) await repository.insertOnce(input)

      await repository.markRead(mine, target.id, at(5 * MINUTE))
      await repository.markRead(mine, target.id, at(9 * MINUTE))
      await repository.markRead(mine, strangers.id, at(9 * MINUTE))
      await repository.markRead(mine, crypto.randomUUID(), at(9 * MINUTE))

      expect((await repository.find(mine, target.id))!.readAt).toEqual(at(5 * MINUTE))
      expect((await repository.find(mine, older.id))!.readAt).toBeNull()
      expect((await repository.find(stranger, strangers.id))!.readAt).toBeNull()
    })

    it('counts only the profile\'s own unread rows', async () => {
      const { repository, newAccount } = await make()
      const mine = (await newAccount()).profileId
      const stranger = (await newAccount()).profileId
      expect(await repository.unreadCount(mine)).toBe(0)
      const read = row(mine, { createdAt: at(0) })
      await repository.insertOnce(read)
      await repository.insertOnce(row(mine, { createdAt: at(MINUTE) }))
      await repository.insertOnce(row(mine, { createdAt: at(2 * MINUTE) }))
      await repository.insertOnce(row(stranger, { createdAt: at(MINUTE) }))
      await repository.markRead(mine, read.id, at(3 * MINUTE))

      expect(await repository.unreadCount(mine)).toBe(2)
      expect(await repository.unreadCount(stranger)).toBe(1)
    })
  })
}
