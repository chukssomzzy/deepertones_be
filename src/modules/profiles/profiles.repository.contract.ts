import { describe, expect, it } from 'vitest'
import type { ProfilesRepository } from './profiles.repository'
import type { Profile } from './profiles.types'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

/**
 * What a contract run needs: the repository, and a way to get a user that already has its default profile, the way every
 * user does in life (D1 enforces profiles.user_id -> users.id, and the default is written together with the user). The
 * default's id, owner, name and time are known to the test, not read back from the repository under test.
 */
export type ProfilesContractSetup = {
  repository: ProfilesRepository
  newUser: () => Promise<{ userId: string; defaultProfile: Profile }>
}

const profileOf = (userId: string, over: Partial<Profile> = {}): Profile => ({
  id: crypto.randomUUID(),
  userId,
  displayName: null,
  isDefault: false,
  createdAt: BASE,
  ...over,
})

/** Behaviour every ProfilesRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const profilesRepositoryContract = (name: string, make: () => ProfilesContractSetup | Promise<ProfilesContractSetup>) => {
  describe(`ProfilesRepository contract: ${name}`, () => {
    describe('findById', () => {
      it('returns the profile as it was stored', async () => {
        const { repository, newUser } = await make()
        const { defaultProfile } = await newUser()

        const found = await repository.findById(defaultProfile.id)

        expect(found).toMatchObject({
          id: defaultProfile.id,
          userId: defaultProfile.userId,
          displayName: null,
          isDefault: true,
        })
        expect(found!.createdAt.getTime()).toBe(defaultProfile.createdAt.getTime())
      })

      it('returns null for an unknown id', async () => {
        const { repository } = await make()

        expect(await repository.findById(crypto.randomUUID())).toBeNull()
      })
    })

    describe('defaultFor', () => {
      it('returns the user\'s default profile', async () => {
        const { repository, newUser } = await make()
        const { userId, defaultProfile } = await newUser()

        expect(await repository.defaultFor(userId)).toMatchObject({ id: defaultProfile.id, userId, isDefault: true })
      })

      it('returns the default, not another profile of the same user', async () => {
        const { repository, newUser } = await make()
        const { userId, defaultProfile } = await newUser()
        await repository.insert(profileOf(userId, { createdAt: at(-MINUTE) }))
        await repository.insert(profileOf(userId, { createdAt: at(MINUTE) }))

        expect((await repository.defaultFor(userId))!.id).toBe(defaultProfile.id)
      })

      it('returns each user their own default', async () => {
        const { repository, newUser } = await make()
        const a = await newUser()
        const b = await newUser()

        expect((await repository.defaultFor(a.userId))!.id).toBe(a.defaultProfile.id)
        expect((await repository.defaultFor(b.userId))!.id).toBe(b.defaultProfile.id)
      })

      it('returns null for a user with no profile', async () => {
        const { repository } = await make()

        expect(await repository.defaultFor(crypto.randomUUID())).toBeNull()
      })
    })

    describe('ofUser', () => {
      it('lists the default first, then the others oldest first, whatever order they were inserted in', async () => {
        const { repository, newUser } = await make()
        const { userId, defaultProfile } = await newUser()
        const later = profileOf(userId, { createdAt: at(2 * MINUTE) })
        const earlier = profileOf(userId, { createdAt: at(-MINUTE) }) // older than the default, which is still listed first
        const middle = profileOf(userId, { createdAt: at(MINUTE) })
        await repository.insert(later)
        await repository.insert(earlier)
        await repository.insert(middle)

        const listed = await repository.ofUser(userId)

        expect(listed.map((p) => p.id)).toEqual([defaultProfile.id, earlier.id, middle.id, later.id])
      })

      it('holds only that user\'s profiles', async () => {
        const { repository, newUser } = await make()
        const mine = await newUser()
        const theirs = await newUser()
        await repository.insert(profileOf(theirs.userId))

        const listed = await repository.ofUser(mine.userId)

        expect(listed.map((p) => p.id)).toEqual([mine.defaultProfile.id])
      })

      it('is empty for a user with no profile', async () => {
        const { repository } = await make()

        expect(await repository.ofUser(crypto.randomUUID())).toEqual([])
      })
    })

    describe('insert', () => {
      it('stores a profile with its name and flags, for findById to return as given', async () => {
        const { repository, newUser } = await make()
        const { userId } = await newUser()
        const named = profileOf(userId, { displayName: 'Ada', createdAt: at(5 * MINUTE) })

        await repository.insert(named)

        const found = await repository.findById(named.id)
        expect(found).toMatchObject({ id: named.id, userId, displayName: 'Ada', isDefault: false })
        expect(found!.createdAt.getTime()).toBe(at(5 * MINUTE).getTime())
      })

      it('accepts any number of non-default profiles for a user', async () => {
        const { repository, newUser } = await make()
        const { userId } = await newUser()

        await repository.insert(profileOf(userId))
        await repository.insert(profileOf(userId))

        expect(await repository.ofUser(userId)).toHaveLength(3)
      })

      it('refuses a second default for the same user, and keeps the first', async () => {
        const { repository, newUser } = await make()
        const { userId, defaultProfile } = await newUser()
        const second = profileOf(userId, { isDefault: true })

        await expect(repository.insert(second)).rejects.toThrow()

        expect(await repository.findById(second.id)).toBeNull()
        expect((await repository.ofUser(userId)).map((p) => p.id)).toEqual([defaultProfile.id])
        expect((await repository.defaultFor(userId))!.id).toBe(defaultProfile.id)
      })
    })
  })
}
