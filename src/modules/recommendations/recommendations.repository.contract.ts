import { describe, expect, it } from 'vitest'
import type { RecommendationsRepository } from './recommendations.repository'
import type { ShoppingRow } from './recommendations.types'

// The one clock every fixture hangs off; later times are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

type Account = { userId: string; profileId: string }

/**
 * What a shopping contract run needs: the repository, and a way to get an account that really exists, the way every account does in life
 * (D1 enforces profile_shopping.profile_id -> profiles). `newAccount` is a user with its default profile; `newProfile` adds another
 * profile to that user.
 */
export type ShoppingContractSetup = {
  repository: RecommendationsRepository
  newAccount: () => Promise<Account>
  newProfile: (userId: string) => Promise<string>
}

// Ids are unique per call: the D1 run shares one database across every test in its file.
const rowOf = (profileId: string, over: Partial<ShoppingRow> = {}): ShoppingRow => ({
  id: `shopping-${crypto.randomUUID()}`,
  profileId,
  country: 'NG',
  budgetBand: 'mid',
  createdAt: BASE,
  ...over,
})

const idsOf = (rows: ShoppingRow[]) => rows.map((row) => row.id)

/** Behaviour every RecommendationsRepository (the shopping history) must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const shoppingRepositoryContract = (name: string, make: () => ShoppingContractSetup | Promise<ShoppingContractSetup>) => {
  describe(`RecommendationsRepository shopping contract: ${name}`, () => {
    describe('append and current', () => {
      it('has no current shopping fact for a profile that never set one', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()

        expect(await repository.current(account.profileId)).toBeNull()
      })

      it('returns an appended row as it was given, a band included', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { country: 'GB', budgetBand: 'high', createdAt: at(MINUTE) })

        await repository.append(row)

        const found = await repository.current(profileId)
        expect(found).toMatchObject({ id: row.id, profileId, country: 'GB', budgetBand: 'high' })
        expect(found!.createdAt.getTime()).toBe(at(MINUTE).getTime())
      })

      it('keeps no band as null, not as a value', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        await repository.append(rowOf(profileId, { budgetBand: null }))

        expect((await repository.current(profileId))!.budgetBand).toBeNull()
      })

      it('makes the newest row by time the current one, even when it was appended before an older one', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const newest = rowOf(profileId, { country: 'GB', createdAt: at(10 * MINUTE) })
        const older = rowOf(profileId, { country: 'NG', createdAt: at(MINUTE) })

        await repository.append(newest)
        await repository.append(older)

        expect((await repository.current(profileId))!.id).toBe(newest.id)
      })

      it('makes the row appended later the current one when two rows share the same time', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const earlier = rowOf(profileId, { country: 'NG', createdAt: at(MINUTE) })
        const later = rowOf(profileId, { country: 'GB', createdAt: at(MINUTE) })

        await repository.append(earlier)
        await repository.append(later)

        expect((await repository.current(profileId))!.id).toBe(later.id)
      })
    })

    describe('history', () => {
      it('is empty for a profile that never set one', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()

        expect(await repository.history(account.profileId)).toEqual([])
      })

      it('keeps every row ever appended, newest first', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = rowOf(profileId, { country: 'NG', createdAt: at(MINUTE) })
        const second = rowOf(profileId, { country: 'GB', createdAt: at(2 * MINUTE) })
        const third = rowOf(profileId, { country: 'NG', budgetBand: null, createdAt: at(3 * MINUTE) })

        // Appended out of time order on purpose: the order comes from created_at.
        await repository.append(second)
        await repository.append(third)
        await repository.append(first)

        expect(idsOf(await repository.history(profileId))).toEqual([third.id, second.id, first.id])
      })

      it('lists the row appended later first when rows share the same time', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = rowOf(profileId, { createdAt: at(MINUTE) })
        const second = rowOf(profileId, { country: 'GB', createdAt: at(MINUTE) })

        await repository.append(first)
        await repository.append(second)

        expect(idsOf(await repository.history(profileId))).toEqual([second.id, first.id])
      })
    })

    describe('profiles', () => {
      it('keeps one account\'s shopping facts out of another account\'s current and history', async () => {
        const { repository, newAccount } = await make()
        const ada = await newAccount()
        const bo = await newAccount()
        const adas = rowOf(ada.profileId, { createdAt: at(MINUTE) })
        await repository.append(adas)

        expect(await repository.current(bo.profileId)).toBeNull()
        expect(await repository.history(bo.profileId)).toEqual([])
        expect(idsOf(await repository.history(ada.profileId))).toEqual([adas.id])
      })

      it('keeps two profiles of one account apart, each with its own newest fact', async () => {
        const { repository, newAccount, newProfile } = await make()
        const { userId, profileId } = await newAccount()
        const second = await newProfile(userId)
        const first = rowOf(profileId, { country: 'NG', createdAt: at(5 * MINUTE) })
        const other = rowOf(second, { country: 'GB', createdAt: at(MINUTE) })
        await repository.append(first)
        await repository.append(other)

        expect((await repository.current(profileId))!.id).toBe(first.id)
        expect((await repository.current(second))!.id).toBe(other.id)
        expect(idsOf(await repository.history(second))).toEqual([other.id])
      })
    })
  })
}
