import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1RecommendationsRepository } from '../../src/modules/recommendations/recommendations.repository'
import { shoppingRepositoryContract } from '../../src/modules/recommendations/recommendations.repository.contract'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)

// profile_shopping references profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes
// one, which writes the default profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `shopping-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}
const newProfile = async (userId: string) => {
  const id = crypto.randomUUID()
  await profiles.insert({ id, userId, displayName: null, isDefault: false, createdAt: BASE })
  return id
}

shoppingRepositoryContract('D1', () => ({ repository: new D1RecommendationsRepository(db), newAccount: newGuest, newProfile }))

describe('profile_shopping in D1', () => {
  const row = (profileId: string, over: Partial<Parameters<D1RecommendationsRepository['append']>[0]> = {}) => ({
    id: `shopping-${crypto.randomUUID()}`,
    profileId,
    country: 'NG',
    budgetBand: 'mid' as const,
    createdAt: new Date(BASE.getTime() + MINUTE),
    ...over,
  })

  it('removes a user\'s shopping rows with the user (a guest purged by the cleanup), and leaves other accounts\' rows', async () => {
    const repository = new D1RecommendationsRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.append(row(guest.profileId))
    await repository.append(row(guest.profileId, { country: 'GB', createdAt: new Date(BASE.getTime() + 2 * MINUTE) }))
    await repository.append(row(kept.profileId))

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.history(guest.profileId)).toEqual([])
    expect(await repository.current(guest.profileId)).toBeNull()
    expect(await repository.history(kept.profileId)).toHaveLength(1)
  })

  it('refuses a row for a profile that does not exist', async () => {
    const repository = new D1RecommendationsRepository(db)

    await expect(repository.append(row(crypto.randomUUID()))).rejects.toThrow()
  })
})
