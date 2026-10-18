import { describe, expect, it } from 'vitest'
import type { GoalsRepository } from './goals.repository'
import type { GoalRow } from './goals.types'

// The one clock every fixture hangs off; later times are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

type Account = { userId: string; profileId: string }

/**
 * What a goals contract run needs: the repository, and a way to get an account that really exists, the way every account does in
 * life (D1 enforces profile_goals.profile_id -> profiles). `newAccount` is a user with its default profile; `newProfile` adds
 * another profile to that user.
 */
export type GoalsContractSetup = {
  repository: GoalsRepository
  newAccount: () => Promise<Account>
  newProfile: (userId: string) => Promise<string>
}

// Ids are unique per call: the D1 run shares one database across every test in its file.
const rowOf = (profileId: string, over: Partial<GoalRow> = {}): GoalRow => ({
  id: `goal-${crypto.randomUUID()}`,
  profileId,
  text: null,
  goal: 'glow',
  wantsLighter: false,
  answersVersion: 1,
  createdAt: BASE,
  ...over,
})

const idsOf = (rows: GoalRow[]) => rows.map((row) => row.id)

/** Behaviour every GoalsRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const goalsRepositoryContract = (name: string, make: () => GoalsContractSetup | Promise<GoalsContractSetup>) => {
  describe(`GoalsRepository contract: ${name}`, () => {
    describe('append and current', () => {
      it('has no current goal for a profile that never set one', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()

        expect(await repository.current(account.profileId)).toBeNull()
      })

      it('returns an appended chip row as it was given', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { goal: 'fade-dark-marks', text: 'fade my dark spots', wantsLighter: true, answersVersion: 3, createdAt: at(MINUTE) })

        await repository.append(row)

        const found = await repository.current(profileId)
        expect(found).toMatchObject({ id: row.id, profileId, goal: 'fade-dark-marks', text: 'fade my dark spots', wantsLighter: true, answersVersion: 3 })
        expect(found!.createdAt.getTime()).toBe(at(MINUTE).getTime())
      })

      it('keeps a row with no goal (typed words nobody sorted yet) with its text, and false as false', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { goal: null, text: 'make my face clear', wantsLighter: false })

        await repository.append(row)

        expect(await repository.current(profileId)).toMatchObject({ id: row.id, goal: null, text: 'make my face clear', wantsLighter: false })
      })

      it('makes the newest row by time the current one, even when it was appended before an older one', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const newest = rowOf(profileId, { goal: 'glow', createdAt: at(10 * MINUTE) })
        const older = rowOf(profileId, { goal: 'clear-skin', createdAt: at(MINUTE) })

        await repository.append(newest)
        await repository.append(older)

        expect((await repository.current(profileId))!.id).toBe(newest.id)
      })

      it('makes the row appended later the current one when two rows share the same time', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const earlier = rowOf(profileId, { goal: 'clear-skin', createdAt: at(MINUTE) })
        const later = rowOf(profileId, { goal: 'glow', createdAt: at(MINUTE) })

        await repository.append(earlier)
        await repository.append(later)

        expect((await repository.current(profileId))!.id).toBe(later.id)
      })

      it('changes the current goal when a newer row is appended', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(rowOf(profileId, { goal: 'clear-skin', createdAt: at(MINUTE) }))
        const later = rowOf(profileId, { goal: 'even-tone', createdAt: at(2 * MINUTE) })

        await repository.append(later)

        expect(await repository.current(profileId)).toMatchObject({ id: later.id, goal: 'even-tone' })
      })
    })

    describe('history', () => {
      it('is empty for a profile that never set a goal', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()

        expect(await repository.history(account.profileId)).toEqual([])
      })

      it('keeps every row ever appended, newest first', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = rowOf(profileId, { goal: 'clear-skin', createdAt: at(MINUTE) })
        const second = rowOf(profileId, { goal: null, text: 'something else', createdAt: at(2 * MINUTE) })
        const third = rowOf(profileId, { goal: 'glow', createdAt: at(3 * MINUTE) })

        // Appended out of time order on purpose: the order comes from created_at.
        await repository.append(second)
        await repository.append(third)
        await repository.append(first)

        expect(idsOf(await repository.history(profileId))).toEqual([third.id, second.id, first.id])
      })
    })

    describe('ties', () => {
      it('lists the row appended later first when two rows share the same time', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = rowOf(profileId, { goal: 'clear-skin', createdAt: at(MINUTE) })
        const second = rowOf(profileId, { goal: null, text: 'words', createdAt: at(MINUTE) })
        const third = rowOf(profileId, { goal: 'glow', createdAt: at(MINUTE) })

        await repository.append(first)
        await repository.append(second)
        await repository.append(third)

        expect(idsOf(await repository.history(profileId))).toEqual([third.id, second.id, first.id])
      })
    })

    describe('profiles', () => {
      it('keeps one profile\'s goals out of another account\'s current and history', async () => {
        const { repository, newAccount } = await make()
        const ada = await newAccount()
        const bo = await newAccount()
        const adas = rowOf(ada.profileId, { goal: 'glow', createdAt: at(MINUTE) })
        await repository.append(adas)

        expect(await repository.current(bo.profileId)).toBeNull()
        expect(await repository.history(bo.profileId)).toEqual([])
        expect(idsOf(await repository.history(ada.profileId))).toEqual([adas.id])
      })

      it('keeps two profiles of one account apart, each with its own newest goal', async () => {
        const { repository, newAccount, newProfile } = await make()
        const { userId, profileId } = await newAccount()
        const second = await newProfile(userId)
        const first = rowOf(profileId, { goal: 'clear-skin', createdAt: at(5 * MINUTE) })
        const other = rowOf(second, { goal: 'brighter', createdAt: at(MINUTE) })
        await repository.append(first)
        await repository.append(other)

        expect((await repository.current(profileId))!.id).toBe(first.id)
        expect((await repository.current(second))!.id).toBe(other.id)
        expect(idsOf(await repository.history(second))).toEqual([other.id])
      })
    })
  })
}
