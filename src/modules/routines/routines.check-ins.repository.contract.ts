import { describe, expect, it } from 'vitest'
import type { RoutineCheckInsRepository } from './routines.check-ins.repository'

// The one clock every fixture hangs off; days and times are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)
/** The calendar day `n` days from BASE's, as 'YYYY-MM-DD'. */
const day = (n: number) => new Date(BASE.getTime() + n * DAY).toISOString().slice(0, 10)

type Account = { userId: string; profileId: string }

/**
 * What a check-in contract run needs: the repository, and a way to get an account that really exists, the way every account does in life (D1 enforces
 * routine_check_ins.profile_id -> profiles). `newAccount` is a user with its default profile.
 *
 * THE CONTRACT THIS FILE PINS (assumed: the brief names the table (routine_check_ins, PK (profile_id, day, time), an `at` timestamp) and the behaviour, not the
 * repository's methods; they follow reminders.repository.contract.ts):
 *   record(profileId, day, time, at): Promise<void>
 *       day is a calendar date 'YYYY-MM-DD' (stored as given: a check-in is for a local day, and no later change of zone moves it); time is 'morning' | 'evening'.
 *       One row per (profile, day, time). Recording a key already held is a no-op that still resolves: the row stays as it was, so the FIRST `at` is kept.
 *   list(profileId, from, to): Promise<{ profileId, day, time, at }[]>
 *       The profile's check-ins whose day is from..to, BOTH ENDS INCLUSIVE ('YYYY-MM-DD' compares as text), in ascending day order. Never another profile's.
 *       Nothing in range is [].
 *   latestDay(profileId, from, to): Promise<string | null>
 *       The latest day the profile has a check-in for within from..to, BOTH ENDS INCLUSIVE, at either time of day. null when there is none in range. Never another profile's.
 */
export type RoutineCheckInsContractSetup = {
  repository: RoutineCheckInsRepository
  newAccount: () => Promise<Account>
}

const keysOf = (rows: { day: string; time: string }[]) => rows.map((row) => `${row.day} ${row.time}`).sort()

/** Behaviour every RoutineCheckInsRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const routineCheckInsRepositoryContract = (name: string, make: () => RoutineCheckInsContractSetup | Promise<RoutineCheckInsContractSetup>) => {
  describe(`RoutineCheckInsRepository contract: ${name}`, () => {
    it('lists nothing for a profile that never checked in', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      expect(await repository.list(profileId, day(-30), day(30))).toEqual([])
    })

    it('lists a recorded check-in with its profile, day, time and the moment it was made', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      await repository.record(profileId, day(0), 'morning', at(MINUTE))

      const [row, ...rest] = await repository.list(profileId, day(0), day(0))
      expect(rest).toEqual([])
      expect(row).toMatchObject({ profileId, day: day(0), time: 'morning' })
      expect(row!.at.getTime()).toBe(at(MINUTE).getTime())
    })

    it('stores a repeat of the same (profile, day, time) once, keeping the first moment, and still resolves', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      await repository.record(profileId, day(0), 'evening', at(MINUTE))

      await expect(repository.record(profileId, day(0), 'evening', at(2 * MINUTE))).resolves.toBeUndefined()

      const rows = await repository.list(profileId, day(-1), day(1))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.at.getTime()).toBe(at(MINUTE).getTime())
    })

    it('keeps the morning and the evening of one day as two check-ins', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      await repository.record(profileId, day(0), 'morning', at(MINUTE))
      await repository.record(profileId, day(0), 'evening', at(2 * MINUTE))

      expect(keysOf(await repository.list(profileId, day(0), day(0)))).toEqual([`${day(0)} evening`, `${day(0)} morning`])
    })

    it('keeps the same time of two days as two check-ins', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      await repository.record(profileId, day(0), 'morning', at(MINUTE))
      await repository.record(profileId, day(1), 'morning', at(DAY))

      expect(keysOf(await repository.list(profileId, day(0), day(1)))).toEqual([`${day(0)} morning`, `${day(1)} morning`])
    })

    it('includes the check-ins on both end days of the range and leaves out the day before and the day after', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      for (const n of [-1, 0, 1, 2, 3]) await repository.record(profileId, day(n), 'morning', at(MINUTE))

      const rows = await repository.list(profileId, day(0), day(2))

      expect(keysOf(rows)).toEqual([`${day(0)} morning`, `${day(1)} morning`, `${day(2)} morning`])
    })

    it('answers a range of a single day with that day only', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      for (const n of [0, 1, 2]) await repository.record(profileId, day(n), 'evening', at(MINUTE))

      expect(keysOf(await repository.list(profileId, day(1), day(1)))).toEqual([`${day(1)} evening`])
    })

    it('lists in ascending day order, however they were recorded', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      for (const n of [3, 0, 2, 1]) await repository.record(profileId, day(n), 'morning', at(MINUTE))

      const rows = await repository.list(profileId, day(0), day(3))

      expect(rows.map((row) => row.day)).toEqual([day(0), day(1), day(2), day(3)])
    })

    it('reads days across a month boundary as calendar days, not as a count of hours', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      // BASE is mid-June: 15 days on is 2030-06-30 and 16 days on is 2030-07-01.
      await repository.record(profileId, day(15), 'morning', at(MINUTE))
      await repository.record(profileId, day(16), 'morning', at(MINUTE))

      expect(keysOf(await repository.list(profileId, day(15), day(16)))).toEqual([`${day(15)} morning`, `${day(16)} morning`])
      expect(day(16).slice(5, 7)).toBe('07')
    })

    it('keeps each profile\'s check-ins to itself, even for the same day and time', async () => {
      const { repository, newAccount } = await make()
      const amara = await newAccount()
      const tolu = await newAccount()
      await repository.record(amara.profileId, day(0), 'morning', at(MINUTE))
      await repository.record(tolu.profileId, day(0), 'morning', at(2 * MINUTE))
      await repository.record(tolu.profileId, day(1), 'evening', at(3 * MINUTE))

      const forAmara = await repository.list(amara.profileId, day(-5), day(5))
      const forTolu = await repository.list(tolu.profileId, day(-5), day(5))

      expect(keysOf(forAmara)).toEqual([`${day(0)} morning`])
      expect(forAmara[0]!.at.getTime()).toBe(at(MINUTE).getTime())
      expect(keysOf(forTolu)).toEqual([`${day(0)} morning`, `${day(1)} evening`])
    })

    it('answers null from latestDay when the profile has no check-in in range', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      await repository.record(profileId, day(5), 'morning', at(MINUTE))

      expect(await repository.latestDay(profileId, day(0), day(4))).toBeNull()
      expect(await repository.latestDay((await newAccount()).profileId, day(-30), day(30))).toBeNull()
    })

    it('answers the latest day in range from latestDay, however they were recorded', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      for (const n of [2, 4, 1, 3]) await repository.record(profileId, day(n), 'morning', at(MINUTE))

      expect(await repository.latestDay(profileId, day(0), day(10))).toBe(day(4))
    })

    it('includes both end days in latestDay and leaves out the days beyond them', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      for (const n of [-1, 0, 2, 3]) await repository.record(profileId, day(n), 'morning', at(MINUTE))

      expect(await repository.latestDay(profileId, day(0), day(2))).toBe(day(2))
      expect(await repository.latestDay(profileId, day(-1), day(1))).toBe(day(0))
      expect(await repository.latestDay(profileId, day(0), day(0))).toBe(day(0))
      expect(await repository.latestDay(profileId, day(1), day(1))).toBeNull()
    })

    it('ignores other profiles in latestDay', async () => {
      const { repository, newAccount } = await make()
      const amara = await newAccount()
      const tolu = await newAccount()
      await repository.record(amara.profileId, day(1), 'morning', at(MINUTE))
      await repository.record(tolu.profileId, day(3), 'morning', at(MINUTE))

      expect(await repository.latestDay(amara.profileId, day(0), day(5))).toBe(day(1))
      expect(await repository.latestDay(tolu.profileId, day(0), day(5))).toBe(day(3))
    })

    it('answers the same from latestDay for a day ticked at one time as at both', async () => {
      const { repository, newAccount } = await make()
      const morning = await newAccount()
      const evening = await newAccount()
      const both = await newAccount()
      await repository.record(morning.profileId, day(2), 'morning', at(MINUTE))
      await repository.record(evening.profileId, day(2), 'evening', at(MINUTE))
      await repository.record(both.profileId, day(2), 'morning', at(MINUTE))
      await repository.record(both.profileId, day(2), 'evening', at(2 * MINUTE))

      for (const { profileId } of [morning, evening, both]) expect(await repository.latestDay(profileId, day(0), day(5))).toBe(day(2))
    })
  })
}
