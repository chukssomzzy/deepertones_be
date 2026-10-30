import { describe, expect, it } from 'vitest'
import type { FaceSharesRepository } from './face-shares.repository'

// The one clock every fixture hangs off; later times are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

type Account = { userId: string; profileId: string }

/**
 * What a face-shares contract run needs: the repository, and a way to get an account that really exists, the way every account does in life
 * (D1 enforces that both face-share tables cascade from profiles). `newAccount` is a user with its default profile; `newProfile` adds another
 * profile to that user.
 *
 * THE CONTRACT THIS FILE PINS (assumed: the brief names the tables and `record(...)`, not the other methods; the consent half is the face-photo
 * consent's repository, method for method, on face_share_consents):
 *   FaceShareConsent = { profileId, userId, version, givenAt: Date, withdrawnAt: Date | null }     one row per profile, like face_consents (user_id kept, as there)
 *   GiveFaceShareConsent = { profileId, userId, version, at: Date }
 *   consentOf(profileId): Promise<FaceShareConsent | null>      null if never given; a withdrawn consent is still here with its withdrawal time
 *   giveConsent(consent): Promise<void>                         one row per profile: giving again replaces version and time and clears any withdrawal
 *   withdrawConsent(profileId, at): Promise<void>               stamps `at`, keeps the row; the first withdrawal's time stands; no consent means no row is made
 *   FaceShare = { id, profileId, beforeScanId, afterScanId, consentVersion, createdAt: Date }     one row of face_shares
 *   NewFaceShare = FaceShare                                                                       the caller (C2) supplies the id and the time
 *   record(share: NewFaceShare): Promise<void>                  inserts a share. Shares are NOT one per profile: every one is kept.
 *   sharesOf(profileId): Promise<FaceShare[]>                   ASSUMED, the test's only way to see what `record` wrote (nothing else reads shares yet): the profile's
 *                                                               shares, oldest first (createdAt ascending)
 * before_scan_id and after_scan_id are plain text, not foreign keys (the brief names an FK only for profile_id), so the setup needs no real scans.
 */
export type FaceSharesContractSetup = {
  repository: FaceSharesRepository
  newAccount: () => Promise<Account>
  newProfile: (userId: string) => Promise<string>
}

let counter = 0
/** A share for the profile. Every field can be overridden; the id and the scan ids are unique unless a test sets them. */
const share = (profileId: string, over: Partial<Parameters<FaceSharesRepository['record']>[0]> = {}) => {
  const n = counter++
  return { id: crypto.randomUUID(), profileId, beforeScanId: `before-scan-${n}`, afterScanId: `after-scan-${n}`, consentVersion: 1, createdAt: BASE, ...over }
}

/** Behaviour every FaceSharesRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const faceSharesRepositoryContract = (name: string, make: () => FaceSharesContractSetup | Promise<FaceSharesContractSetup>) => {
  describe(`FaceSharesRepository contract: ${name}`, () => {
    describe('consent', () => {
      it('has no consent for a profile that never gave one', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        expect(await repository.consentOf(profileId)).toBeNull()
      })

      it('stores the version and the time it was given, with nothing withdrawn', async () => {
        const { repository, newAccount } = await make()
        const { userId, profileId } = await newAccount()

        await repository.giveConsent({ profileId, userId, version: 1, at: at(MINUTE) })

        const found = await repository.consentOf(profileId)
        expect(found).toMatchObject({ profileId, userId, version: 1, withdrawnAt: null })
        expect(found!.givenAt.getTime()).toBe(at(MINUTE).getTime())
      })

      it('gives again over the same row: the new time and version replace the old, and there is still one consent', async () => {
        const { repository, newAccount } = await make()
        const { userId, profileId } = await newAccount()
        await repository.giveConsent({ profileId, userId, version: 1, at: at(MINUTE) })

        await repository.giveConsent({ profileId, userId, version: 2, at: at(2 * MINUTE) })

        const found = await repository.consentOf(profileId)
        expect(found).toMatchObject({ version: 2, withdrawnAt: null })
        expect(found!.givenAt.getTime()).toBe(at(2 * MINUTE).getTime())
      })

      it('stamps the time of a withdrawal and keeps the row, the version and when it was given', async () => {
        const { repository, newAccount } = await make()
        const { userId, profileId } = await newAccount()
        await repository.giveConsent({ profileId, userId, version: 1, at: at(MINUTE) })

        await repository.withdrawConsent(profileId, at(5 * MINUTE))

        const found = await repository.consentOf(profileId)
        expect(found).toMatchObject({ profileId, userId, version: 1 })
        expect(found!.givenAt.getTime()).toBe(at(MINUTE).getTime())
        expect(found!.withdrawnAt!.getTime()).toBe(at(5 * MINUTE).getTime())
      })

      it('keeps the first time when a consent is withdrawn twice', async () => {
        const { repository, newAccount } = await make()
        const { userId, profileId } = await newAccount()
        await repository.giveConsent({ profileId, userId, version: 1, at: at(MINUTE) })
        await repository.withdrawConsent(profileId, at(5 * MINUTE))

        await repository.withdrawConsent(profileId, at(9 * MINUTE))

        expect((await repository.consentOf(profileId))!.withdrawnAt!.getTime()).toBe(at(5 * MINUTE).getTime())
      })

      it('clears the withdrawal when consent is given again, and moves the given time', async () => {
        const { repository, newAccount } = await make()
        const { userId, profileId } = await newAccount()
        await repository.giveConsent({ profileId, userId, version: 1, at: at(MINUTE) })
        await repository.withdrawConsent(profileId, at(5 * MINUTE))

        await repository.giveConsent({ profileId, userId, version: 1, at: at(8 * MINUTE) })

        const found = await repository.consentOf(profileId)
        expect(found!.withdrawnAt).toBeNull()
        expect(found!.givenAt.getTime()).toBe(at(8 * MINUTE).getTime())
      })

      it('withdraws nothing for a profile that never gave consent, and does not make a row for it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        await expect(repository.withdrawConsent(profileId, at(MINUTE))).resolves.toBeUndefined()

        expect(await repository.consentOf(profileId)).toBeNull()
      })

      it('keeps a consent with the profile that gave it: another profile of the same account has none, and withdrawing one leaves the other', async () => {
        const { repository, newAccount, newProfile } = await make()
        const { userId, profileId } = await newAccount()
        const second = await newProfile(userId)
        await repository.giveConsent({ profileId, userId, version: 1, at: at(MINUTE) })
        expect(await repository.consentOf(second)).toBeNull()
        await repository.giveConsent({ profileId: second, userId, version: 1, at: at(2 * MINUTE) })

        await repository.withdrawConsent(profileId, at(3 * MINUTE))

        expect((await repository.consentOf(profileId))!.withdrawnAt).not.toBeNull()
        expect((await repository.consentOf(second))!.withdrawnAt).toBeNull()
      })

      it('is separate from the shares: withdrawing the consent leaves what was already shared on record', async () => {
        const { repository, newAccount } = await make()
        const { userId, profileId } = await newAccount()
        await repository.giveConsent({ profileId, userId, version: 1, at: at(MINUTE) })
        await repository.record(share(profileId, { createdAt: at(2 * MINUTE) }))

        await repository.withdrawConsent(profileId, at(3 * MINUTE))

        expect(await repository.sharesOf(profileId)).toHaveLength(1)
      })
    })

    describe('shares', () => {
      it('has no shares for a profile that never shared', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        expect(await repository.sharesOf(profileId)).toEqual([])
      })

      it('records a share with every column as given', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const recorded = share(profileId, { consentVersion: 3, createdAt: at(4 * MINUTE) })

        await repository.record(recorded)

        const [found, ...rest] = await repository.sharesOf(profileId)
        expect(rest).toEqual([])
        expect(found).toMatchObject({ id: recorded.id, profileId, beforeScanId: recorded.beforeScanId, afterScanId: recorded.afterScanId, consentVersion: 3 })
        expect(found!.createdAt.getTime()).toBe(at(4 * MINUTE).getTime())
      })

      it('keeps every share: two for the same profile and the same pair of scans are two rows, oldest first', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const later = share(profileId, { beforeScanId: 'scan-a', afterScanId: 'scan-b', createdAt: at(2 * MINUTE) })
        const earlier = share(profileId, { beforeScanId: 'scan-a', afterScanId: 'scan-b', createdAt: at(MINUTE) })

        await repository.record(later)
        await repository.record(earlier)

        expect((await repository.sharesOf(profileId)).map((found) => found.id)).toEqual([earlier.id, later.id])
      })

      it('keeps a share with the profile that made it: another profile of the same account sees none', async () => {
        const { repository, newAccount, newProfile } = await make()
        const { userId, profileId } = await newAccount()
        const second = await newProfile(userId)
        const mine = share(profileId)

        await repository.record(mine)

        expect((await repository.sharesOf(profileId)).map((found) => found.id)).toEqual([mine.id])
        expect(await repository.sharesOf(second)).toEqual([])
      })
    })
  })
}
