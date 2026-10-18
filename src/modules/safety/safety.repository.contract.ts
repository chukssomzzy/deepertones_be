import { describe, expect, it } from 'vitest'
import type { SafetyRepository } from './safety.repository'
import type { SafetyRow } from './safety.types'

// The one clock every fixture hangs off; later times are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

type Account = { userId: string; profileId: string }

/**
 * What a safety contract run needs: the repository, and a way to get an account that really exists, the way every account does in
 * life (D1 enforces profile_safety.profile_id -> profiles). `newAccount` is a user with its default profile; `newProfile` adds
 * another profile to that user.
 */
export type SafetyContractSetup = {
  repository: SafetyRepository
  newAccount: () => Promise<Account>
  newProfile: (userId: string) => Promise<string>
}

// Ids are unique per call: the D1 run shares one database across every test in its file.
const rowOf = (profileId: string, over: Partial<SafetyRow> = {}): SafetyRow => ({
  id: `safety-${crypto.randomUUID()}`,
  profileId,
  choices: ['none'],
  reactionText: null,
  prescriptionText: null,
  createdAt: BASE,
  ...over,
})

const idsOf = (rows: SafetyRow[]) => rows.map((row) => row.id)

/**
 * Behaviour every SafetyRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). Putting the choices
 * in the vocabulary's order, and keeping each once, is the service's rule: the repository gives back what it was given.
 */
export const safetyRepositoryContract = (name: string, make: () => SafetyContractSetup | Promise<SafetyContractSetup>) => {
  describe(`SafetyRepository contract: ${name}`, () => {
    describe('append and current', () => {
      it('has no current answer for a profile that never set one', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()

        expect(await repository.current(account.profileId)).toBeNull()
      })

      it('returns an appended row as it was given, with the choices as an array', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['pregnant', 'reaction', 'prescription'], reactionText: 'Caro White and fragrance', prescriptionText: 'clobetasol', createdAt: at(MINUTE) })

        await repository.append(row)

        const found = await repository.current(profileId)
        expect(found).toMatchObject({ id: row.id, profileId, choices: ['pregnant', 'reaction', 'prescription'], reactionText: 'Caro White and fragrance', prescriptionText: 'clobetasol' })
        expect(Array.isArray(found!.choices)).toBe(true)
        expect(found!.createdAt.getTime()).toBe(at(MINUTE).getTime())
      })

      it('keeps a ticked choice with no text, and null as null', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['reaction'], reactionText: null, prescriptionText: null })

        await repository.append(row)

        expect(await repository.current(profileId)).toMatchObject({ id: row.id, choices: ['reaction'], reactionText: null, prescriptionText: null })
      })

      it('gives back every choice a row can hold, in the order it was given', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['pregnant', 'breastfeeding', 'reaction', 'prescription'], reactionText: 'a', prescriptionText: 'b' })

        await repository.append(row)

        expect((await repository.current(profileId))!.choices).toEqual(['pregnant', 'breastfeeding', 'reaction', 'prescription'])
      })

      it('makes the newest row by time the current one, even when it was appended before an older one', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const newest = rowOf(profileId, { choices: ['pregnant'], createdAt: at(10 * MINUTE) })
        const older = rowOf(profileId, { choices: ['none'], createdAt: at(MINUTE) })

        await repository.append(newest)
        await repository.append(older)

        expect((await repository.current(profileId))!.id).toBe(newest.id)
      })

      it('makes the row appended later the current one when two rows share the same time', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const earlier = rowOf(profileId, { choices: ['none'], createdAt: at(MINUTE) })
        const later = rowOf(profileId, { choices: ['pregnant'], createdAt: at(MINUTE) })

        await repository.append(earlier)
        await repository.append(later)

        expect((await repository.current(profileId))!.id).toBe(later.id)
      })

      it('changes the current answer when a newer row is appended', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(rowOf(profileId, { choices: ['none'], createdAt: at(MINUTE) }))
        const later = rowOf(profileId, { choices: ['breastfeeding'], createdAt: at(2 * MINUTE) })

        await repository.append(later)

        expect(await repository.current(profileId)).toMatchObject({ id: later.id, choices: ['breastfeeding'] })
      })
    })

    describe('history', () => {
      it('is empty for a profile that never set an answer', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()

        expect(await repository.history(account.profileId)).toEqual([])
      })

      it('keeps every row ever appended, newest first', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = rowOf(profileId, { choices: ['none'], createdAt: at(MINUTE) })
        const second = rowOf(profileId, { choices: ['reaction'], reactionText: 'fragrance', createdAt: at(2 * MINUTE) })
        const third = rowOf(profileId, { choices: ['pregnant'], createdAt: at(3 * MINUTE) })

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
        const first = rowOf(profileId, { choices: ['none'], createdAt: at(MINUTE) })
        const second = rowOf(profileId, { choices: ['reaction'], createdAt: at(MINUTE) })
        const third = rowOf(profileId, { choices: ['pregnant'], createdAt: at(MINUTE) })

        await repository.append(first)
        await repository.append(second)
        await repository.append(third)

        expect(idsOf(await repository.history(profileId))).toEqual([third.id, second.id, first.id])
      })
    })

    describe('profiles', () => {
      it('keeps one profile\'s answers out of another account\'s current and history', async () => {
        const { repository, newAccount } = await make()
        const ada = await newAccount()
        const bo = await newAccount()
        const adas = rowOf(ada.profileId, { choices: ['pregnant'], createdAt: at(MINUTE) })
        await repository.append(adas)

        expect(await repository.current(bo.profileId)).toBeNull()
        expect(await repository.history(bo.profileId)).toEqual([])
        expect(idsOf(await repository.history(ada.profileId))).toEqual([adas.id])
      })

      it('keeps two profiles of one account apart, each with its own newest answer', async () => {
        const { repository, newAccount, newProfile } = await make()
        const { userId, profileId } = await newAccount()
        const second = await newProfile(userId)
        const first = rowOf(profileId, { choices: ['pregnant'], createdAt: at(5 * MINUTE) })
        const other = rowOf(second, { choices: ['none'], createdAt: at(MINUTE) })
        await repository.append(first)
        await repository.append(other)

        expect((await repository.current(profileId))!.id).toBe(first.id)
        expect((await repository.current(second))!.id).toBe(other.id)
        expect(idsOf(await repository.history(second))).toEqual([other.id])
      })
    })
  })
}
