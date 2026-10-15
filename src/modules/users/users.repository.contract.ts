import { describe, expect, it } from 'vitest'
import type { EmailAddress } from '../../lib/email-address'
import type { PhoneNumber } from '../../lib/phone'
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

/** Behaviour every UsersRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const usersRepositoryContract = (name: string, make: () => UsersRepository | Promise<UsersRepository>) => {
  const guest = async (repo: UsersRepository, deviceHash = freshHash(), createdAt = BASE) => {
    const id = crypto.randomUUID()
    const user = await repo.createGuestForDevice({ user: { id, createdAt }, device: { deviceHash, platform: 'ios' } })
    return { id, deviceHash, user }
  }

  describe(`UsersRepository contract: ${name}`, () => {
    it('createGuestForDevice returns an anonymous user with no contact details and version 0', async () => {
      const repo = await make()
      const { id, user } = await guest(repo)

      expect(user).toMatchObject({ id, status: 'anonymous', email: null, phone: null, tokenVersion: 0 })
      expect(user.createdAt.getTime()).toBe(BASE.getTime())
      expect(user.lastSeenAt.getTime()).toBe(BASE.getTime())
    })

    it('createGuestForDevice stores the user and links the device to it', async () => {
      const repo = await make()
      const { id, deviceHash } = await guest(repo)

      expect(await repo.findById(id)).toMatchObject({ id, status: 'anonymous' })
      expect(await repo.findDevice(deviceHash)).toMatchObject({ deviceHash, platform: 'ios', userId: id })
    })

    it('createGuestForDevice re-points an existing device to the new guest', async () => {
      const repo = await make()
      const first = await guest(repo)
      const second = await guest(repo, first.deviceHash, at(MINUTE))

      expect(second.id).not.toBe(first.id)
      expect((await repo.findDevice(first.deviceHash))!.userId).toBe(second.id)
      expect(await repo.findById(first.id)).not.toBeNull()
    })

    it('findById returns null for an unknown id', async () => {
      const repo = await make()

      expect(await repo.findById(crypto.randomUUID())).toBeNull()
    })

    it('findDevice returns null for an unknown device', async () => {
      const repo = await make()

      expect(await repo.findDevice(freshHash())).toBeNull()
    })

    it('findByIdentifier finds nobody for an unused email or phone', async () => {
      const repo = await make()

      expect(await repo.findByIdentifier(freshEmail())).toBeNull()
      expect(await repo.findByIdentifier(freshPhone())).toBeNull()
    })

    it('promote with an email verifies the guest, stores the email, bumps the version and sets lastSeenAt', async () => {
      const repo = await make()
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
      const repo = await make()
      const { id } = await guest(repo)
      const who = freshPhone() as Extract<UserIdentifier, { kind: 'phone' }>

      const result = await repo.promote(id, who, at(MINUTE))

      expect(result.outcome).toBe('promoted')
      expect(await repo.findById(id)).toMatchObject({ status: 'verified', phone: who.phone, email: null, tokenVersion: 1 })
    })

    it('stores the email exactly as the caller passed it', async () => {
      const repo = await make()
      const { id } = await guest(repo)
      const email = parseCanonical()

      await repo.promote(id, { kind: 'email', email }, at(MINUTE))

      expect((await repo.findById(id))!.email).toBe(email)
    })

    it('findByIdentifier finds the user who owns the email or phone', async () => {
      const repo = await make()
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
      const repo = await make()
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
      const repo = await make()
      const owner = await guest(repo)
      const other = await guest(repo)
      const phone = freshPhone()
      await repo.promote(owner.id, phone, at(MINUTE))

      expect(await repo.promote(other.id, phone, at(2 * MINUTE))).toEqual({ outcome: 'taken' })

      expect(await repo.findById(other.id)).toMatchObject({ status: 'anonymous', phone: null, tokenVersion: 0 })
    })

    it('promote answers not-guest for a user who is already verified, and changes nothing', async () => {
      const repo = await make()
      const { id } = await guest(repo)
      const first = freshEmail()
      await repo.promote(id, first, at(MINUTE))

      expect(await repo.promote(id, freshPhone(), at(2 * MINUTE))).toEqual({ outcome: 'not-guest' })

      expect(await repo.findById(id)).toMatchObject({ status: 'verified', phone: null, tokenVersion: 1 })
    })

    it('promote answers not-guest for an unknown user', async () => {
      const repo = await make()

      expect(await repo.promote(crypto.randomUUID(), freshEmail(), BASE)).toEqual({ outcome: 'not-guest' })
    })

    it('bumpTokenVersion returns the new version each time', async () => {
      const repo = await make()
      const { id } = await guest(repo)

      expect(await repo.bumpTokenVersion(id)).toBe(1)
      expect(await repo.bumpTokenVersion(id)).toBe(2)
      expect((await repo.findById(id))!.tokenVersion).toBe(2)
    })

    it('bumpTokenVersion continues from the version promote left', async () => {
      const repo = await make()
      const { id } = await guest(repo)
      await repo.promote(id, freshEmail(), at(MINUTE))

      expect(await repo.bumpTokenVersion(id)).toBe(2)
    })

    it('bumpTokenVersion returns null for an unknown user', async () => {
      const repo = await make()

      expect(await repo.bumpTokenVersion(crypto.randomUUID())).toBeNull()
    })

    it('touch sets lastSeenAt', async () => {
      const repo = await make()
      const { id } = await guest(repo)

      await repo.touch(id, at(7 * MINUTE))

      expect((await repo.findById(id))!.lastSeenAt.getTime()).toBe(at(7 * MINUTE).getTime())
    })

    it('touchDevice sets the device\'s lastSeenAt', async () => {
      const repo = await make()
      const { deviceHash } = await guest(repo)

      await repo.touchDevice(deviceHash, at(3 * MINUTE))

      expect((await repo.findDevice(deviceHash))!.lastSeenAt.getTime()).toBe(at(3 * MINUTE).getTime())
    })

    it('touchDevice ignores an unknown device', async () => {
      const repo = await make()

      await expect(repo.touchDevice(freshHash(), BASE)).resolves.toBeUndefined()
    })

    it('unlinkDevices removes only that user\'s devices and returns how many', async () => {
      const repo = await make()
      const mine = await guest(repo)
      const theirs = await guest(repo)

      const removed = await repo.unlinkDevices(mine.id)

      expect(removed).toBe(1)
      expect(await repo.findDevice(mine.deviceHash)).toBeNull()
      expect(await repo.findDevice(theirs.deviceHash)).toMatchObject({ userId: theirs.id })
      expect(await repo.unlinkDevices(mine.id)).toBe(0)
    })

    it('unlinkDevices returns 0 for a user with no devices', async () => {
      const repo = await make()

      expect(await repo.unlinkDevices(crypto.randomUUID())).toBe(0)
    })
  })
}

// A canonical (already lower-cased) email, as parseEmailAddress would hand the repository.
const parseCanonical = () => `canon-${runSalt}-${counter++}@example.com` as EmailAddress
