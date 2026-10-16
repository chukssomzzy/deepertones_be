import { describe, expect, it } from 'vitest'
import type { EmailAddress } from '../../lib/email-address'
import type { PhoneNumber } from '../../lib/phone'
import type { ProfilesRepository } from '../profiles/profiles.repository'
import type { UsersRepository } from './users.repository'
import type { UserIdentifier } from './users.types'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)
const MINUTE = 60 * 1000

// Each call yields a value no other test (or earlier run against a shared D1) uses.
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
const freshEmail = (): UserIdentifier => ({ kind: 'email', email: `user-${runSalt}-${counter++}@example.com` as EmailAddress })
const freshPhone = (): UserIdentifier => ({ kind: 'phone', phone: `+234809${runSalt}${String(counter++).padStart(2, '0')}` as PhoneNumber })
const freshHash = () => `device-${crypto.randomUUID()}`

/** What a contract run needs: the users repository, and a profiles repository that reads the same storage (profiles are written and removed by the users repository). */
export type UsersContractSetup = { repository: UsersRepository; profiles: ProfilesRepository }

/** Behaviour every UsersRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const usersRepositoryContract = (name: string, make: () => UsersContractSetup | Promise<UsersContractSetup>) => {
  const guest = async (repo: UsersRepository, deviceHash = freshHash(), createdAt = BASE, profileId = crypto.randomUUID()) => {
    const id = crypto.randomUUID()
    const user = await repo.createGuestForDevice({ user: { id, createdAt }, device: { deviceHash, platform: 'ios' }, profile: { id: profileId } })
    return { id, deviceHash, user, profileId }
  }

  describe(`UsersRepository contract: ${name}`, () => {
    it('createGuestForDevice returns an anonymous user with no contact details and version 0', async () => {
      const { repository: repo } = await make()
      const { id, user } = await guest(repo)

      expect(user).toMatchObject({ id, status: 'anonymous', email: null, phone: null, tokenVersion: 0 })
      expect(user.createdAt.getTime()).toBe(BASE.getTime())
      expect(user.lastSeenAt.getTime()).toBe(BASE.getTime())
    })

    it('createGuestForDevice stores the user and links the device to it', async () => {
      const { repository: repo } = await make()
      const { id, deviceHash } = await guest(repo)

      expect(await repo.findById(id)).toMatchObject({ id, status: 'anonymous' })
      expect(await repo.findDevice(deviceHash)).toMatchObject({ deviceHash, platform: 'ios', userId: id })
    })

    it('createGuestForDevice re-points an existing device to the new guest', async () => {
      const { repository: repo } = await make()
      const first = await guest(repo)
      const second = await guest(repo, first.deviceHash, at(MINUTE))

      expect(second.id).not.toBe(first.id)
      expect((await repo.findDevice(first.deviceHash))!.userId).toBe(second.id)
      expect(await repo.findById(first.id)).not.toBeNull()
    })

    describe('the default profile of a new guest', () => {
      it('is exactly one, a default with no name, made at the moment the user was', async () => {
        const { repository, profiles } = await make()
        const created = at(7 * MINUTE)
        const { id, user, profileId } = await guest(repository, freshHash(), created)

        const owned = await profiles.ofUser(id)

        expect(owned).toHaveLength(1)
        expect(owned[0]).toMatchObject({ id: profileId, userId: id, displayName: null, isDefault: true })
        expect(owned[0]!.createdAt.getTime()).toBe(created.getTime())
        expect(owned[0]!.createdAt.getTime()).toBe(user.createdAt.getTime())
        expect(await profiles.defaultFor(id)).toMatchObject({ id: profileId })
        expect(await profiles.findById(profileId)).toMatchObject({ userId: id, isDefault: true })
      })

      it('belongs to that guest alone: a second guest gets a profile of their own', async () => {
        const { repository, profiles } = await make()
        const first = await guest(repository)
        const second = await guest(repository)

        expect((await profiles.defaultFor(first.id))!.id).toBe(first.profileId)
        expect((await profiles.defaultFor(second.id))!.id).toBe(second.profileId)
        expect(await profiles.ofUser(first.id)).toHaveLength(1)
      })

      it('is made again for a device that is re-pointed to a new guest, and the earlier guest keeps theirs', async () => {
        const { repository, profiles } = await make()
        const first = await guest(repository)
        const second = await guest(repository, first.deviceHash, at(MINUTE))

        expect((await profiles.defaultFor(second.id))!.id).toBe(second.profileId)
        expect((await profiles.defaultFor(first.id))!.id).toBe(first.profileId)
      })

      it('is not made, and neither is the user nor the device link, when the profile cannot be stored', async () => {
        const { repository, profiles } = await make()
        const taken = await guest(repository)
        const newId = crypto.randomUUID()
        const deviceHash = freshHash()

        // The profile id is already someone else's profile: the write has to fail as a whole.
        await expect(
          repository.createGuestForDevice({ user: { id: newId, createdAt: BASE }, device: { deviceHash, platform: 'ios' }, profile: { id: taken.profileId } }),
        ).rejects.toThrow()

        expect(await repository.findById(newId)).toBeNull()
        expect(await repository.findDevice(deviceHash)).toBeNull()
        expect(await profiles.ofUser(newId)).toEqual([])
        expect((await profiles.findById(taken.profileId))!.userId).toBe(taken.id)
      })
    })

    it('findById returns null for an unknown id', async () => {
      const { repository: repo } = await make()

      expect(await repo.findById(crypto.randomUUID())).toBeNull()
    })

    it('findDevice returns null for an unknown device', async () => {
      const { repository: repo } = await make()

      expect(await repo.findDevice(freshHash())).toBeNull()
    })

    it('findByIdentifier finds nobody for an unused email or phone', async () => {
      const { repository: repo } = await make()

      expect(await repo.findByIdentifier(freshEmail())).toBeNull()
      expect(await repo.findByIdentifier(freshPhone())).toBeNull()
    })

    it('promote with an email verifies the guest, stores the email, bumps the version and sets lastSeenAt', async () => {
      const { repository: repo } = await make()
      const { id } = await guest(repo)
      const who = freshEmail() as Extract<UserIdentifier, { kind: 'email' }>

      const result = await repo.promote(id, who, at(5 * MINUTE))

      expect(result.outcome).toBe('promoted')
      if (result.outcome !== 'promoted') return
      expect(result.user).toMatchObject({ id, status: 'verified', email: who.email, phone: null, tokenVersion: 1 })
      expect(result.user.lastSeenAt.getTime()).toBe(at(5 * MINUTE).getTime())
      expect(await repo.findById(id)).toMatchObject({ status: 'verified', email: who.email, tokenVersion: 1 })
    })

    it('promote with a phone verifies the guest and stores the phone', async () => {
      const { repository: repo } = await make()
      const { id } = await guest(repo)
      const who = freshPhone() as Extract<UserIdentifier, { kind: 'phone' }>

      const result = await repo.promote(id, who, at(MINUTE))

      expect(result.outcome).toBe('promoted')
      expect(await repo.findById(id)).toMatchObject({ status: 'verified', phone: who.phone, email: null, tokenVersion: 1 })
    })

    it('stores the email exactly as the caller passed it', async () => {
      const { repository: repo } = await make()
      const { id } = await guest(repo)
      const email = parseCanonical()

      await repo.promote(id, { kind: 'email', email }, at(MINUTE))

      expect((await repo.findById(id))!.email).toBe(email)
    })

    it('findByIdentifier finds the user who owns the email or phone', async () => {
      const { repository: repo } = await make()
      const a = await guest(repo)
      const b = await guest(repo)
      const email = freshEmail()
      const phone = freshPhone()
      await repo.promote(a.id, email, at(MINUTE))
      await repo.promote(b.id, phone, at(MINUTE))

      expect((await repo.findByIdentifier(email))!.id).toBe(a.id)
      expect((await repo.findByIdentifier(phone))!.id).toBe(b.id)
    })

    it('promote answers taken when another user already has the email, and changes nothing', async () => {
      const { repository: repo } = await make()
      const owner = await guest(repo)
      const other = await guest(repo)
      const email = freshEmail()
      await repo.promote(owner.id, email, at(MINUTE))

      expect(await repo.promote(other.id, email, at(2 * MINUTE))).toEqual({ outcome: 'taken' })

      expect(await repo.findById(other.id)).toMatchObject({ status: 'anonymous', email: null, tokenVersion: 0 })
      expect((await repo.findById(other.id))!.lastSeenAt.getTime()).toBe(BASE.getTime())
      expect((await repo.findByIdentifier(email))!.id).toBe(owner.id)
    })

    it('promote answers taken when another user already has the phone, and changes nothing', async () => {
      const { repository: repo } = await make()
      const owner = await guest(repo)
      const other = await guest(repo)
      const phone = freshPhone()
      await repo.promote(owner.id, phone, at(MINUTE))

      expect(await repo.promote(other.id, phone, at(2 * MINUTE))).toEqual({ outcome: 'taken' })

      expect(await repo.findById(other.id)).toMatchObject({ status: 'anonymous', phone: null, tokenVersion: 0 })
    })

    it('promote answers not-guest for a user who is already verified, and changes nothing', async () => {
      const { repository: repo } = await make()
      const { id } = await guest(repo)
      const first = freshEmail()
      await repo.promote(id, first, at(MINUTE))

      expect(await repo.promote(id, freshPhone(), at(2 * MINUTE))).toEqual({ outcome: 'not-guest' })

      expect(await repo.findById(id)).toMatchObject({ status: 'verified', phone: null, tokenVersion: 1 })
    })

    it('promote answers not-guest for an unknown user', async () => {
      const { repository: repo } = await make()

      expect(await repo.promote(crypto.randomUUID(), freshEmail(), BASE)).toEqual({ outcome: 'not-guest' })
    })

    it('bumpTokenVersion returns the new version each time', async () => {
      const { repository: repo } = await make()
      const { id } = await guest(repo)

      expect(await repo.bumpTokenVersion(id)).toBe(1)
      expect(await repo.bumpTokenVersion(id)).toBe(2)
      expect((await repo.findById(id))!.tokenVersion).toBe(2)
    })

    it('bumpTokenVersion continues from the version promote left', async () => {
      const { repository: repo } = await make()
      const { id } = await guest(repo)
      await repo.promote(id, freshEmail(), at(MINUTE))

      expect(await repo.bumpTokenVersion(id)).toBe(2)
    })

    it('bumpTokenVersion returns null for an unknown user', async () => {
      const { repository: repo } = await make()

      expect(await repo.bumpTokenVersion(crypto.randomUUID())).toBeNull()
    })

    it('touch sets lastSeenAt', async () => {
      const { repository: repo } = await make()
      const { id } = await guest(repo)

      await repo.touch(id, at(7 * MINUTE))

      expect((await repo.findById(id))!.lastSeenAt.getTime()).toBe(at(7 * MINUTE).getTime())
    })

    it('touchDevice sets the device\'s lastSeenAt', async () => {
      const { repository: repo } = await make()
      const { deviceHash } = await guest(repo)

      await repo.touchDevice(deviceHash, at(3 * MINUTE))

      expect((await repo.findDevice(deviceHash))!.lastSeenAt.getTime()).toBe(at(3 * MINUTE).getTime())
    })

    it('touchDevice ignores an unknown device', async () => {
      const { repository: repo } = await make()

      await expect(repo.touchDevice(freshHash(), BASE)).resolves.toBeUndefined()
    })

    it('unlinkDevices removes only that user\'s devices and returns how many', async () => {
      const { repository: repo } = await make()
      const mine = await guest(repo)
      const theirs = await guest(repo)

      const removed = await repo.unlinkDevices(mine.id)

      expect(removed).toBe(1)
      expect(await repo.findDevice(mine.deviceHash)).toBeNull()
      expect(await repo.findDevice(theirs.deviceHash)).toMatchObject({ userId: theirs.id })
      expect(await repo.unlinkDevices(mine.id)).toBe(0)
    })

    it('unlinkDevices returns 0 for a user with no devices', async () => {
      const { repository: repo } = await make()

      expect(await repo.unlinkDevices(crypto.randomUUID())).toBe(0)
    })

    describe('guest cleanup', () => {
      const DAY = 24 * 60 * MINUTE
      // Everything below happens well before BASE, so guests other tests leave at BASE never match.
      const CUTOFF = at(-30 * DAY)
      const beforeCutoff = (extraMs: number) => new Date(CUTOFF.getTime() - extraMs)

      // A guest last seen at `seenAt`; unlinked (no device points at it) unless `linked`.
      const guestSeen = async (repo: UsersRepository, seenAt: Date, linked = false) => {
        const g = await guest(repo, freshHash(), seenAt)
        await repo.touch(g.id, seenAt)
        if (!linked) await repo.unlinkDevices(g.id)
        return g
      }

      it('unreachableGuestIds includes a guest with no device last seen before the cutoff', async () => {
        const { repository: repo } = await make()
        const old = await guestSeen(repo, beforeCutoff(DAY))

        expect(await repo.unreachableGuestIds(CUTOFF, 100)).toContain(old.id)
      })

      it('unreachableGuestIds excludes a guest a device still points at, however old', async () => {
        const { repository: repo } = await make()
        const linked = await guestSeen(repo, beforeCutoff(DAY), true)

        expect(await repo.unreachableGuestIds(CUTOFF, 100)).not.toContain(linked.id)
      })

      it('unreachableGuestIds excludes an unlinked guest seen at or after the cutoff', async () => {
        const { repository: repo } = await make()
        const atCutoff = await guestSeen(repo, CUTOFF)
        const recent = await guestSeen(repo, new Date(CUTOFF.getTime() + 1))

        const ids = await repo.unreachableGuestIds(CUTOFF, 100)

        expect(ids).not.toContain(atCutoff.id)
        expect(ids).not.toContain(recent.id)
      })

      it('unreachableGuestIds includes a guest seen one millisecond before the cutoff', async () => {
        const { repository: repo } = await make()
        const justOld = await guestSeen(repo, beforeCutoff(1))

        expect(await repo.unreachableGuestIds(CUTOFF, 100)).toContain(justOld.id)
      })

      it('unreachableGuestIds never includes a verified user, even old and unlinked', async () => {
        const { repository: repo } = await make()
        const g = await guest(repo)
        await repo.promote(g.id, freshEmail(), beforeCutoff(DAY))
        await repo.unlinkDevices(g.id)

        expect(await repo.unreachableGuestIds(CUTOFF, 100)).not.toContain(g.id)
      })

      it('unreachableGuestIds returns at most limit ids, oldest first', async () => {
        const { repository: repo } = await make()
        // Older than anything another test seeds, so these are the oldest rows in the table.
        const oldest = await guestSeen(repo, beforeCutoff(900 * DAY))
        const second = await guestSeen(repo, beforeCutoff(899 * DAY))
        await guestSeen(repo, beforeCutoff(898 * DAY))

        expect(await repo.unreachableGuestIds(CUTOFF, 2)).toEqual([oldest.id, second.id])
      })

      it('deleteUsers removes exactly the given guests and returns how many', async () => {
        const { repository: repo } = await make()
        const a = await guestSeen(repo, beforeCutoff(DAY))
        const b = await guestSeen(repo, beforeCutoff(DAY))
        const kept = await guestSeen(repo, beforeCutoff(DAY))

        expect(await repo.deleteUsers([a.id, b.id])).toBe(2)

        expect(await repo.findById(a.id)).toBeNull()
        expect(await repo.findById(b.id)).toBeNull()
        expect(await repo.findById(kept.id)).not.toBeNull()
      })

      it('deleteUsers also removes the devices pointing at the deleted guests', async () => {
        const { repository: repo } = await make()
        const g = await guestSeen(repo, beforeCutoff(DAY), true)

        await repo.deleteUsers([g.id])

        expect(await repo.findDevice(g.deviceHash)).toBeNull()
      })

      it('deleteUsers also removes the profiles of the deleted guests, and only theirs', async () => {
        const { repository, profiles } = await make()
        const gone = await guestSeen(repository, beforeCutoff(DAY))
        const kept = await guestSeen(repository, beforeCutoff(DAY))

        await repository.deleteUsers([gone.id])

        expect(await profiles.findById(gone.profileId)).toBeNull()
        expect(await profiles.ofUser(gone.id)).toEqual([])
        expect(await profiles.findById(kept.profileId)).toMatchObject({ userId: kept.id })
      })

      it('deleteUsers leaves the profile of a verified user it refused to delete', async () => {
        const { repository, profiles } = await make()
        const verified = await guest(repository)
        await repository.promote(verified.id, freshEmail(), at(MINUTE))

        await repository.deleteUsers([verified.id])

        expect(await profiles.findById(verified.profileId)).toMatchObject({ userId: verified.id, isDefault: true })
      })

      it('deleteUsers never deletes a verified user, even when its id is passed', async () => {
        const { repository: repo } = await make()
        const g = await guest(repo)
        await repo.promote(g.id, freshEmail(), at(MINUTE))
        const anon = await guestSeen(repo, beforeCutoff(DAY))

        expect(await repo.deleteUsers([g.id, anon.id])).toBe(1)

        expect(await repo.findById(g.id)).toMatchObject({ status: 'verified' })
        expect(await repo.findById(anon.id)).toBeNull()
      })

      it('deleteUsers with no ids deletes nothing and returns 0', async () => {
        const { repository: repo } = await make()

        expect(await repo.deleteUsers([])).toBe(0)
      })
    })
  })
}

// A canonical (already lower-cased) email, as parseEmailAddress would hand the repository.
const parseCanonical = () => `canon-${runSalt}-${counter++}@example.com` as EmailAddress
