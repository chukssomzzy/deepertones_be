import { env } from 'cloudflare:workers'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1ShelfRepository } from '../../src/modules/shelf/shelf.repository'
import { shelfRepositoryContract } from '../../src/modules/shelf/shelf.repository.contract'
import { profileProducts } from '../../src/modules/shelf/shelf.table'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')

const db = createDb(env.DB)
const users = new D1UsersRepository(db)

// profile_products references profiles, and D1 enforces it, so each contract profile is a real guest's default profile (made the way
// the app makes one, in the same batch as the user).
const newProfile = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `shelf-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return profileId
}

shelfRepositoryContract('D1', () => ({
  repository: new D1ShelfRepository(db),
  newProfile,
  put: async (row) => {
    await db.insert(profileProducts).values(row)
  },
  stored: (profileId) => db.select().from(profileProducts).where(eq(profileProducts.profileId, profileId)).orderBy(asc(profileProducts.id)),
}))

describe('profile_products in D1', () => {
  it('goes with its profile\'s user (a guest purged by the cleanup), and leaves other profiles\' rows', async () => {
    const repository = new D1ShelfRepository(db)
    const userId = crypto.randomUUID()
    const profileId = crypto.randomUUID()
    await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `shelf-purge-${userId}`, platform: 'ios' }, profile: { id: profileId } })
    const kept = await newProfile()
    for (const owner of [profileId, kept]) {
      await db.insert(profileProducts).values({
        id: crypto.randomUUID(), profileId: owner, kind: 'no-label', productId: null, formulationId: null,
        scanId: crypto.randomUUID(), itemId: crypto.randomUUID(), addedAt: BASE, lastScannedAt: BASE, removedAt: null, removedReason: null,
      })
    }

    expect(await users.deleteUsers([userId])).toBe(1)

    expect(await repository.activeFor(profileId, 200)).toEqual([])
    expect(await repository.activeFor(kept, 200)).toHaveLength(1)
  })
})
