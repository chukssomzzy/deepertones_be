import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { verdictsRepositoryContract } from '../../src/modules/verdicts/verdicts.repository.contract'
import { D1VerdictsRepository } from '../../src/modules/verdicts/verdicts.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

const db = createDb(env.DB)
const users = new D1UsersRepository(db)

// shelf_verdicts references profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes one, which writes the
// default profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `verdicts-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}

verdictsRepositoryContract('D1', () => ({ repository: new D1VerdictsRepository(db), newAccount: newGuest }))

describe('shelf_verdicts in D1', () => {
  const stale = new Date(BASE.getTime() - HOUR)

  it('removes a user\'s verdict with the user (a guest purged by the cleanup), and leaves other accounts\' verdicts', async () => {
    const repository = new D1VerdictsRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.requestBuild(guest.profileId, 'fingerprint-1', BASE, stale)
    await repository.requestBuild(kept.profileId, 'fingerprint-1', BASE, stale)

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.find(guest.profileId)).toBeNull()
    expect(await repository.find(kept.profileId)).not.toBeNull()
  })

  it('keeps the verdict when the guest signs up, because the account and its profile are promoted in place', async () => {
    const repository = new D1VerdictsRepository(db)
    const guest = await newGuest()
    await repository.requestBuild(guest.profileId, 'fingerprint-1', BASE, stale)

    const { outcome } = await users.promote(guest.userId, { kind: 'email', email: `verdict-${crypto.randomUUID()}@example.com` as EmailAddress }, new Date(BASE.getTime() + HOUR))

    expect(outcome).toBe('promoted')
    expect(await repository.find(guest.profileId)).toMatchObject({ profileId: guest.profileId, status: 'pending', fingerprint: 'fingerprint-1' })
  })

  it('refuses a request for a profile that does not exist', async () => {
    const repository = new D1VerdictsRepository(db)

    await expect(repository.requestBuild(crypto.randomUUID(), 'fingerprint-1', BASE, stale)).rejects.toThrow()
  })

  it('lets exactly one of 20 parallel requests for one profile win', async () => {
    const repository = new D1VerdictsRepository(db)
    const guest = await newGuest()

    const answers = await Promise.all(Array.from({ length: 20 }, () => repository.requestBuild(guest.profileId, 'fingerprint-1', BASE, stale)))

    expect(answers.filter(Boolean)).toHaveLength(1)
    expect(await repository.find(guest.profileId)).toMatchObject({ status: 'pending', fingerprint: 'fingerprint-1' })
  })

  it('stores the request time and the retry due time to the millisecond', async () => {
    const repository = new D1VerdictsRepository(db)
    const guest = await newGuest()
    const requestedAt = new Date(BASE.getTime() + 123)
    const due = new Date(BASE.getTime() + HOUR + 456)
    await repository.requestBuild(guest.profileId, 'fingerprint-1', requestedAt, stale)

    await repository.setFitState(guest.profileId, { fitAttempts: 3, fitRetried: false, fitRetryDueAt: due })

    const row = await repository.find(guest.profileId)
    expect(row!.requestedAt.getTime()).toBe(requestedAt.getTime())
    expect(row!.fitRetryDueAt!.getTime()).toBe(due.getTime())
  })
})
