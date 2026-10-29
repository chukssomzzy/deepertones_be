import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1FaceSharesRepository } from '../../src/modules/face-shares/face-shares.repository'
import { faceSharesRepositoryContract } from '../../src/modules/face-shares/face-shares.repository.contract'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)

// Both face-share tables reference profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes one,
// which writes the default profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `face-share-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}
const newProfile = async (userId: string) => {
  const id = crypto.randomUUID()
  await profiles.insert({ id, userId, displayName: null, isDefault: false, createdAt: BASE })
  return id
}

faceSharesRepositoryContract('D1', () => ({ repository: new D1FaceSharesRepository(db), newAccount: newGuest, newProfile }))

/** A consent and a share for the account, written through the repository. */
const withShareData = async (account: { userId: string; profileId: string }, repository = new D1FaceSharesRepository(db)) => {
  await repository.giveConsent({ profileId: account.profileId, userId: account.userId, version: 1, at: new Date(BASE.getTime() + MINUTE) })
  await repository.record({ id: crypto.randomUUID(), profileId: account.profileId, beforeScanId: crypto.randomUUID(), afterScanId: crypto.randomUUID(), consentVersion: 1, createdAt: new Date(BASE.getTime() + 2 * MINUTE) })
}

describe('the face share tables in D1', () => {
  const repository = new D1FaceSharesRepository(db)

  it('removes a profile\'s consent and shares with the profile, and leaves the account\'s other profile and other accounts', async () => {
    const account = await newGuest()
    const otherProfile = await newProfile(account.userId)
    const stranger = await newGuest()
    await withShareData(account)
    await withShareData({ userId: account.userId, profileId: otherProfile })
    await withShareData(stranger)

    await env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(account.profileId).run()

    expect(await repository.consentOf(account.profileId)).toBeNull()
    expect(await repository.sharesOf(account.profileId)).toEqual([])
    expect(await repository.consentOf(otherProfile)).not.toBeNull()
    expect(await repository.sharesOf(otherProfile)).toHaveLength(1)
    expect(await repository.consentOf(stranger.profileId)).not.toBeNull()
    expect(await repository.sharesOf(stranger.profileId)).toHaveLength(1)
  })

  it('removes the consent and shares of every profile of a user with the user (a guest purged by the cleanup), and leaves other accounts\'', async () => {
    const guest = await newGuest()
    const second = await newProfile(guest.userId)
    const kept = await newGuest()
    await withShareData(guest)
    await withShareData({ userId: guest.userId, profileId: second })
    await withShareData(kept)

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    for (const profileId of [guest.profileId, second]) {
      expect(await repository.consentOf(profileId)).toBeNull()
      expect(await repository.sharesOf(profileId)).toEqual([])
    }
    expect(await repository.consentOf(kept.profileId)).not.toBeNull()
    expect(await repository.sharesOf(kept.profileId)).toHaveLength(1)
  })

  it('refuses a consent or a share for a profile that does not exist', async () => {
    const ghost = crypto.randomUUID()

    await expect(repository.giveConsent({ profileId: ghost, userId: crypto.randomUUID(), version: 1, at: BASE })).rejects.toThrow()
    await expect(repository.record({ id: crypto.randomUUID(), profileId: ghost, beforeScanId: 'a', afterScanId: 'b', consentVersion: 1, createdAt: BASE })).rejects.toThrow()
  })
})
