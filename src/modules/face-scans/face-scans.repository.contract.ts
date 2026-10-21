import { describe, expect, it } from 'vitest'
import type { FaceScansRepository } from './face-scans.repository'
import type { NewFacePhoto, NewFaceScan } from './face-scans.types'

// The one clock every fixture hangs off; later times are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

type Account = { userId: string; profileId: string }

/**
 * What a face-scans contract run needs: the repository, and a way to get an account that really exists, the way every account does in life
 * (D1 enforces that every face table cascades from profiles). `newAccount` is a user with its default profile; `newProfile` adds another
 * profile to that user.
 */
export type FaceScansContractSetup = {
  repository: FaceScansRepository
  newAccount: () => Promise<Account>
  newProfile: (userId: string) => Promise<string>
}

const freshId = () => crypto.randomUUID()

const newScan = (account: Account, over: Partial<NewFaceScan> = {}): NewFaceScan => ({
  id: freshId(),
  userId: account.userId,
  profileId: account.profileId,
  goalAtScan: 'glow',
  createdAt: BASE,
  ...over,
})

/** The key a face photo is stored under (see photo-store.provider.ts), so the keys the repository hands back are ones the bucket would take. */
const keyOf = (scan: NewFaceScan, position: NewFacePhoto['position'], environment = 'test') =>
  `faces/${environment}/${scan.userId}/${scan.profileId}/${scan.id}/${position}.jpg`

const newPhoto = (scan: NewFaceScan, position: NewFacePhoto['position'], over: Partial<NewFacePhoto> = {}): NewFacePhoto => ({
  faceScanId: scan.id,
  userId: scan.userId,
  position,
  photoKey: keyOf(scan, position),
  createdAt: scan.createdAt,
  ...over,
})

/**
 * Behaviour every FaceScansRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier).
 * Assumptions the D1 tables must meet: face_consents, face_scans and face_scan_photos reference profiles (so `newAccount` makes real accounts),
 * there is one consent row per profile, and a face scan has at most one photo per position.
 */
export const faceScansRepositoryContract = (name: string, make: () => FaceScansContractSetup | Promise<FaceScansContractSetup>) => {
  describe(`FaceScansRepository contract: ${name}`, () => {
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
    })

    describe('createFaceScan and reading back', () => {
      it('stores a scan that is analysing, with its owner, profile, goal and time, and no reason', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const scan = newScan(account, { goalAtScan: 'fade-dark-marks', createdAt: at(MINUTE) })

        await repository.createFaceScan(scan, [newPhoto(scan, 'front')])

        const found = await repository.findFaceScan(scan.id)
        expect(found).toMatchObject({ id: scan.id, userId: account.userId, profileId: account.profileId, state: 'analysing', reason: null, goalAtScan: 'fade-dark-marks' })
        expect(found!.createdAt.getTime()).toBe(at(MINUTE).getTime())
        expect(found!.updatedAt.getTime()).toBe(at(MINUTE).getTime())
      })

      it('stores its photos by position, and gives them back front, right, left whatever order they were written in', async () => {
        const { repository, newAccount } = await make()
        const scan = newScan(await newAccount())

        await repository.createFaceScan(scan, [newPhoto(scan, 'left'), newPhoto(scan, 'front'), newPhoto(scan, 'right')])

        const photos = await repository.photosOf(scan.id)
        expect(photos.map((photo) => photo.position)).toEqual(['front', 'right', 'left'])
        expect(photos.map((photo) => photo.photoKey)).toEqual([keyOf(scan, 'front'), keyOf(scan, 'right'), keyOf(scan, 'left')])
        expect(photos.every((photo) => photo.faceScanId === scan.id && photo.userId === scan.userId)).toBe(true)
      })

      it('stores a scan with only its front photo', async () => {
        const { repository, newAccount } = await make()
        const scan = newScan(await newAccount())

        await repository.createFaceScan(scan, [newPhoto(scan, 'front')])

        expect((await repository.photosOf(scan.id)).map((photo) => photo.position)).toEqual(['front'])
      })

      it('finds no scan and no photos for an id that was never stored', async () => {
        const { repository } = await make()

        expect(await repository.findFaceScan(freshId())).toBeNull()
        expect(await repository.photosOf(freshId())).toEqual([])
      })

      it('writes the scan and its photos together: two photos in one position store neither the photos nor the scan', async () => {
        const { repository, newAccount } = await make()
        const scan = newScan(await newAccount())

        await expect(repository.createFaceScan(scan, [newPhoto(scan, 'front'), newPhoto(scan, 'front', { photoKey: keyOf(scan, 'front').replace('.jpg', '-2.jpg') })])).rejects.toThrow()

        expect(await repository.findFaceScan(scan.id)).toBeNull()
        expect(await repository.photosOf(scan.id)).toEqual([])
      })

      it('refuses a scan id that is already stored, and leaves the first scan and its photos as they were', async () => {
        const { repository, newAccount } = await make()
        const scan = newScan(await newAccount())
        await repository.createFaceScan(scan, [newPhoto(scan, 'front')])

        await expect(repository.createFaceScan({ ...scan, goalAtScan: 'brighter' }, [newPhoto(scan, 'right')])).rejects.toThrow()

        expect((await repository.findFaceScan(scan.id))!.goalAtScan).toBe('glow')
        expect((await repository.photosOf(scan.id)).map((photo) => photo.position)).toEqual(['front'])
      })
    })

    // Two requests for the same profile and goal can both read "no scan yet" and both write one. So the write is conditional: the caller says which
    // scan was the profile's latest (that has not failed) when it decided, `expectLatestId` (null for none), and the scan is stored only if that is still
    // so, in the same atomic step. It answers true when stored and false when not, storing nothing (no scan, no photos). There is deliberately no
    // uniqueness on (profile, goal): going back to an earlier goal is allowed once a scan under another goal has come between.
    describe('createFaceScan with expectLatestId', () => {
      it('stores the scan and answers true when the profile has no scan and none was expected', async () => {
        const { repository, newAccount } = await make()
        const scan = newScan(await newAccount())

        expect(await repository.createFaceScan(scan, [newPhoto(scan, 'front')], { expectLatestId: null })).toBe(true)

        expect((await repository.latestForProfile(scan.profileId))!.id).toBe(scan.id)
        expect(await repository.photosOf(scan.id)).toHaveLength(1)
      })

      it('stores the scan and answers true when the expected scan is still the profile\'s latest', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const first = newScan(account, { createdAt: at(MINUTE) })
        await repository.createFaceScan(first, [newPhoto(first, 'front')])
        const second = newScan(account, { createdAt: at(2 * MINUTE), goalAtScan: 'brighter' })

        expect(await repository.createFaceScan(second, [newPhoto(second, 'front')], { expectLatestId: first.id })).toBe(true)

        expect((await repository.latestForProfile(account.profileId))!.id).toBe(second.id)
      })

      it('answers false and stores nothing when none was expected but the profile already has a scan', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const first = newScan(account, { createdAt: at(MINUTE) })
        await repository.createFaceScan(first, [newPhoto(first, 'front')])
        const late = newScan(account, { createdAt: at(2 * MINUTE) })

        expect(await repository.createFaceScan(late, [newPhoto(late, 'front'), newPhoto(late, 'right')], { expectLatestId: null })).toBe(false)

        expect(await repository.findFaceScan(late.id)).toBeNull()
        expect(await repository.photosOf(late.id)).toEqual([])
        expect(await repository.keysOfFaceScan(late.id)).toEqual([])
        expect((await repository.latestForProfile(account.profileId))!.id).toBe(first.id)
      })

      it('answers false and stores nothing when a different scan came in since: the caller saw a latest that is no longer the latest', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const seen = newScan(account, { createdAt: at(MINUTE) })
        const since = newScan(account, { createdAt: at(2 * MINUTE), goalAtScan: 'brighter' })
        await repository.createFaceScan(seen, [newPhoto(seen, 'front')])
        await repository.createFaceScan(since, [newPhoto(since, 'front')])
        const late = newScan(account, { createdAt: at(3 * MINUTE) })

        expect(await repository.createFaceScan(late, [newPhoto(late, 'front')], { expectLatestId: seen.id })).toBe(false)

        expect(await repository.findFaceScan(late.id)).toBeNull()
        expect((await repository.latestForProfile(account.profileId))!.id).toBe(since.id)
      })

      it('does not count a failed scan as the latest: with only failed scans none is expected, and the failed one is not what to expect', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const failed = newScan(account, { createdAt: at(MINUTE) })
        await repository.createFaceScan(failed, [newPhoto(failed, 'front')])
        await repository.updateFaceScan(failed.id, 'analysing', { state: 'failed', reason: 'unavailable', updatedAt: at(2 * MINUTE) })
        const wrong = newScan(account, { createdAt: at(3 * MINUTE) })
        const right = newScan(account, { createdAt: at(3 * MINUTE) })

        expect(await repository.createFaceScan(wrong, [newPhoto(wrong, 'front')], { expectLatestId: failed.id })).toBe(false)
        expect(await repository.createFaceScan(right, [newPhoto(right, 'front')], { expectLatestId: null })).toBe(true)
      })

      it('looks only at the profile\'s own scans: another profile\'s latest does not stand in the way', async () => {
        const { repository, newAccount, newProfile } = await make()
        const account = await newAccount()
        const other = await newProfile(account.userId)
        const theirs = newScan({ userId: account.userId, profileId: other })
        await repository.createFaceScan(theirs, [newPhoto(theirs, 'front')])
        const mine = newScan(account)

        expect(await repository.createFaceScan(mine, [newPhoto(mine, 'front')], { expectLatestId: null })).toBe(true)
      })

      it('allows a scan under a goal the profile scanned before, once another scan has come between (no uniqueness on profile and goal)', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const glow = newScan(account, { createdAt: at(MINUTE), goalAtScan: 'glow' })
        const brighter = newScan(account, { createdAt: at(2 * MINUTE), goalAtScan: 'brighter' })
        const glowAgain = newScan(account, { createdAt: at(3 * MINUTE), goalAtScan: 'glow' })
        expect(await repository.createFaceScan(glow, [newPhoto(glow, 'front')], { expectLatestId: null })).toBe(true)
        expect(await repository.createFaceScan(brighter, [newPhoto(brighter, 'front')], { expectLatestId: glow.id })).toBe(true)

        expect(await repository.createFaceScan(glowAgain, [newPhoto(glowAgain, 'front')], { expectLatestId: brighter.id })).toBe(true)

        expect((await repository.latestForProfile(account.profileId))!.id).toBe(glowAgain.id)
      })

      it('stores nothing and still rejects for a duplicate photo position, whether or not the expectation holds', async () => {
        const { repository, newAccount } = await make()
        const scan = newScan(await newAccount())

        await expect(repository.createFaceScan(scan, [newPhoto(scan, 'front'), newPhoto(scan, 'front', { photoKey: keyOf(scan, 'front').replace('.jpg', '-2.jpg') })], { expectLatestId: null })).rejects.toThrow()

        expect(await repository.findFaceScan(scan.id)).toBeNull()
      })

      // The point of it all: two writes that both saw "no scan yet" and are in flight together. Exactly one lands.
      it('lets exactly one of two simultaneous writes that both expected no scan succeed, and stores only the winner\'s scan and photos', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const a = newScan(account, { createdAt: at(MINUTE) })
        const b = newScan(account, { createdAt: at(MINUTE) })

        const results = await Promise.all([
          repository.createFaceScan(a, [newPhoto(a, 'front'), newPhoto(a, 'right')], { expectLatestId: null }),
          repository.createFaceScan(b, [newPhoto(b, 'front'), newPhoto(b, 'right')], { expectLatestId: null }),
        ])

        expect(results.filter(Boolean)).toHaveLength(1)
        const [winner, loser] = results[0] ? [a, b] : [b, a]
        expect((await repository.latestForProfile(account.profileId))!.id).toBe(winner.id)
        expect(await repository.photosOf(winner.id)).toHaveLength(2)
        expect(await repository.findFaceScan(loser.id)).toBeNull()
        expect(await repository.photosOf(loser.id)).toEqual([])
      })

      it('lets exactly one of five simultaneous writes succeed', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const scans = Array.from({ length: 5 }, () => newScan(account, { createdAt: at(MINUTE) }))

        const results = await Promise.all(scans.map((scan) => repository.createFaceScan(scan, [newPhoto(scan, 'front')], { expectLatestId: null })))

        expect(results.filter(Boolean)).toHaveLength(1)
        const stored = await Promise.all(scans.map((scan) => repository.findFaceScan(scan.id)))
        expect(stored.filter((row) => row !== null)).toHaveLength(1)
      })

      it('lets simultaneous writes for different profiles each succeed', async () => {
        const { repository, newAccount } = await make()
        const one = newScan(await newAccount())
        const two = newScan(await newAccount())

        const results = await Promise.all([
          repository.createFaceScan(one, [newPhoto(one, 'front')], { expectLatestId: null }),
          repository.createFaceScan(two, [newPhoto(two, 'front')], { expectLatestId: null }),
        ])

        expect(results).toEqual([true, true])
      })
    })

    describe('latestForProfile', () => {
      it('has none for a profile with no face scan', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        expect(await repository.latestForProfile(profileId)).toBeNull()
      })

      it('is the newest scan of the profile by time, however the scans were written', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const newest = newScan(account, { createdAt: at(10 * MINUTE), goalAtScan: 'brighter' })
        const oldest = newScan(account, { createdAt: at(MINUTE), goalAtScan: 'glow' })
        const middle = newScan(account, { createdAt: at(5 * MINUTE), goalAtScan: 'clear-skin' })
        for (const scan of [newest, oldest, middle]) await repository.createFaceScan(scan, [newPhoto(scan, 'front')])

        expect((await repository.latestForProfile(account.profileId))!.id).toBe(newest.id)
      })

      it('goes to the scan written last when two share a time, the same way every time', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const first = newScan(account, { createdAt: at(MINUTE) })
        const second = newScan(account, { createdAt: at(MINUTE) })
        await repository.createFaceScan(first, [newPhoto(first, 'front')])
        await repository.createFaceScan(second, [newPhoto(second, 'front')])

        expect((await repository.latestForProfile(account.profileId))!.id).toBe(second.id)
        expect((await repository.latestForProfile(account.profileId))!.id).toBe(second.id)
      })

      it('belongs to the profile: the account\'s other profile, and other accounts, do not see it', async () => {
        const { repository, newAccount, newProfile } = await make()
        const mine = await newAccount()
        const other = await newAccount()
        const second = await newProfile(mine.userId)
        const scan = newScan(mine)
        await repository.createFaceScan(scan, [newPhoto(scan, 'front')])

        expect((await repository.latestForProfile(mine.profileId))!.id).toBe(scan.id)
        expect(await repository.latestForProfile(second)).toBeNull()
        expect(await repository.latestForProfile(other.profileId)).toBeNull()
      })

      // A scan that failed gave the profile nothing to look at, so it neither stops a new scan under the same goal nor stands as "the last scan".
      it('passes over a scan that failed, to the newest scan that has not', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const good = newScan(account, { createdAt: at(MINUTE), goalAtScan: 'glow' })
        const failed = newScan(account, { createdAt: at(5 * MINUTE), goalAtScan: 'brighter' })
        await repository.createFaceScan(good, [newPhoto(good, 'front')])
        await repository.createFaceScan(failed, [newPhoto(failed, 'front')])
        await repository.updateFaceScan(failed.id, 'analysing', { state: 'failed', reason: 'unavailable', updatedAt: at(6 * MINUTE) })

        expect((await repository.latestForProfile(account.profileId))!.id).toBe(good.id)
      })

      it('has none for a profile whose only scan failed', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const failed = newScan(account)
        await repository.createFaceScan(failed, [newPhoto(failed, 'front')])
        await repository.updateFaceScan(failed.id, 'analysing', { state: 'failed', reason: 'unavailable', updatedAt: at(MINUTE) })

        expect(await repository.latestForProfile(account.profileId)).toBeNull()
      })

      it.each(['analysing', 'needs-retake', 'ready'] as const)('counts a scan that is %s', async (state) => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const scan = newScan(account)
        await repository.createFaceScan(scan, [newPhoto(scan, 'front')])
        if (state !== 'analysing') await repository.updateFaceScan(scan.id, 'analysing', { state, updatedAt: at(MINUTE) })

        expect((await repository.latestForProfile(account.profileId))!.id).toBe(scan.id)
      })
    })

    describe('updateFaceScan', () => {
      it('moves a scan out of the state it was in, with a reason and a new updated time, and says it did', async () => {
        const { repository, newAccount } = await make()
        const scan = newScan(await newAccount())
        await repository.createFaceScan(scan, [newPhoto(scan, 'front')])

        const moved = await repository.updateFaceScan(scan.id, 'analysing', { state: 'failed', reason: 'unavailable', updatedAt: at(2 * MINUTE) })

        expect(moved).toBe(true)
        const found = await repository.findFaceScan(scan.id)
        expect(found).toMatchObject({ state: 'failed', reason: 'unavailable' })
        expect(found!.updatedAt.getTime()).toBe(at(2 * MINUTE).getTime())
        expect(found!.createdAt.getTime()).toBe(BASE.getTime())
      })

      it('changes nothing and says so when the scan is not in the state the caller expected', async () => {
        const { repository, newAccount } = await make()
        const scan = newScan(await newAccount())
        await repository.createFaceScan(scan, [newPhoto(scan, 'front')])

        const moved = await repository.updateFaceScan(scan.id, 'ready', { state: 'failed', reason: 'unavailable', updatedAt: at(2 * MINUTE) })

        expect(moved).toBe(false)
        expect(await repository.findFaceScan(scan.id)).toMatchObject({ state: 'analysing', reason: null })
      })

      it('says false for a scan that does not exist', async () => {
        const { repository } = await make()

        expect(await repository.updateFaceScan(freshId(), 'analysing', { state: 'failed', reason: 'unavailable', updatedAt: at(MINUTE) })).toBe(false)
      })
    })

    describe('keysOfFaceScan and deleteFaceScan', () => {
      it('gives the keys of the scan\'s photos, and no other scan\'s', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const scan = newScan(account)
        const other = newScan(account)
        await repository.createFaceScan(scan, [newPhoto(scan, 'front'), newPhoto(scan, 'right')])
        await repository.createFaceScan(other, [newPhoto(other, 'front')])

        expect((await repository.keysOfFaceScan(scan.id)).sort()).toEqual([keyOf(scan, 'front'), keyOf(scan, 'right')].sort())
      })

      it('gives no keys for a scan that does not exist', async () => {
        const { repository } = await make()

        expect(await repository.keysOfFaceScan(freshId())).toEqual([])
      })

      it('deletes the scan and its photos and leaves the profile\'s other scans alone', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const scan = newScan(account, { createdAt: at(MINUTE) })
        const kept = newScan(account, { createdAt: at(2 * MINUTE) })
        await repository.createFaceScan(scan, [newPhoto(scan, 'front'), newPhoto(scan, 'left')])
        await repository.createFaceScan(kept, [newPhoto(kept, 'front')])

        await repository.deleteFaceScan(scan.id)

        expect(await repository.findFaceScan(scan.id)).toBeNull()
        expect(await repository.photosOf(scan.id)).toEqual([])
        expect(await repository.keysOfFaceScan(scan.id)).toEqual([])
        expect(await repository.findFaceScan(kept.id)).not.toBeNull()
        expect(await repository.photosOf(kept.id)).toHaveLength(1)
        expect((await repository.latestForProfile(account.profileId))!.id).toBe(kept.id)
      })

      it('is not an error to delete a scan that is already gone', async () => {
        const { repository } = await make()

        await expect(repository.deleteFaceScan(freshId())).resolves.toBeUndefined()
      })

      it('leaves the profile\'s consent alone', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const scan = newScan(account)
        await repository.giveConsent({ profileId: account.profileId, userId: account.userId, version: 1, at: at(MINUTE) })
        await repository.createFaceScan(scan, [newPhoto(scan, 'front')])

        await repository.deleteFaceScan(scan.id)

        expect(await repository.consentOf(account.profileId)).not.toBeNull()
      })
    })

    describe('photoKeysForUsers and deleteForUsers (the guest cleanup)', () => {
      const twoAccounts = async () => {
        const { repository, newAccount, newProfile } = await make()
        const mine = await newAccount()
        const theirs = await newAccount()
        const secondProfile = await newProfile(mine.userId)
        const scans = {
          mine: newScan(mine, { createdAt: at(MINUTE) }),
          mineSecond: newScan({ userId: mine.userId, profileId: secondProfile }, { createdAt: at(2 * MINUTE) }),
          theirs: newScan(theirs),
        }
        await repository.createFaceScan(scans.mine, [newPhoto(scans.mine, 'front'), newPhoto(scans.mine, 'left')])
        await repository.createFaceScan(scans.mineSecond, [newPhoto(scans.mineSecond, 'front')])
        await repository.createFaceScan(scans.theirs, [newPhoto(scans.theirs, 'front')])
        await repository.giveConsent({ profileId: mine.profileId, userId: mine.userId, version: 1, at: at(MINUTE) })
        await repository.giveConsent({ profileId: theirs.profileId, userId: theirs.userId, version: 1, at: at(MINUTE) })
        return { repository, mine, theirs, scans }
      }

      it('gives the photo keys of every profile of those users, and nobody else\'s', async () => {
        const { repository, mine, scans } = await twoAccounts()

        const keys = await repository.photoKeysForUsers([mine.userId])

        expect(keys.sort()).toEqual([keyOf(scans.mine, 'front'), keyOf(scans.mine, 'left'), keyOf(scans.mineSecond, 'front')].sort())
      })

      it('gives the keys of several users together', async () => {
        const { repository, mine, theirs } = await twoAccounts()

        expect(await repository.photoKeysForUsers([mine.userId, theirs.userId])).toHaveLength(4)
      })

      it('gives no keys for no users, for a user with no face scan, and for ids it has never seen', async () => {
        const { repository, newAccount } = await make()
        const { userId } = await newAccount()

        expect(await repository.photoKeysForUsers([])).toEqual([])
        expect(await repository.photoKeysForUsers([userId])).toEqual([])
        expect(await repository.photoKeysForUsers([freshId()])).toEqual([])
      })

      it('deletes those users\' scans, photos and consent, and nobody else\'s', async () => {
        const { repository, mine, theirs, scans } = await twoAccounts()

        await repository.deleteForUsers([mine.userId])

        expect(await repository.findFaceScan(scans.mine.id)).toBeNull()
        expect(await repository.findFaceScan(scans.mineSecond.id)).toBeNull()
        expect(await repository.photosOf(scans.mine.id)).toEqual([])
        expect(await repository.latestForProfile(mine.profileId)).toBeNull()
        expect(await repository.consentOf(mine.profileId)).toBeNull()
        expect(await repository.findFaceScan(scans.theirs.id)).not.toBeNull()
        expect(await repository.photosOf(scans.theirs.id)).toHaveLength(1)
        expect(await repository.consentOf(theirs.profileId)).not.toBeNull()
      })

      it('does nothing for no users, and is safe to repeat', async () => {
        const { repository, mine, scans } = await twoAccounts()

        await repository.deleteForUsers([])
        expect(await repository.findFaceScan(scans.mine.id)).not.toBeNull()
        await repository.deleteForUsers([mine.userId])
        await expect(repository.deleteForUsers([mine.userId])).resolves.toBeUndefined()

        expect(await repository.findFaceScan(scans.mine.id)).toBeNull()
      })

      // D1 binds at most 100 parameters to a statement, and a cleanup run may be given a few hundred guests.
      it('takes more users at once than D1 can bind to one statement', async () => {
        const { repository, mine, scans } = await twoAccounts()
        const many = [...Array.from({ length: 250 }, () => freshId()), mine.userId]

        expect((await repository.photoKeysForUsers(many)).sort()).toEqual([keyOf(scans.mine, 'front'), keyOf(scans.mine, 'left'), keyOf(scans.mineSecond, 'front')].sort())
        await repository.deleteForUsers(many)

        expect(await repository.findFaceScan(scans.mine.id)).toBeNull()
        expect(await repository.findFaceScan(scans.theirs.id)).not.toBeNull()
      })
    })
  })
}
