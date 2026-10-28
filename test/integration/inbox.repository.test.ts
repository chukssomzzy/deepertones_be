import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1InboxRepository } from '../../src/modules/inbox/inbox.repository'
import { inboxRepositoryContract } from '../../src/modules/inbox/inbox.repository.contract'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)

// inbox_items references profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes one, which writes the default
// profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `inbox-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}
const newProfile = async (userId: string) => {
  const id = crypto.randomUUID()
  await profiles.insert({ id, userId, displayName: null, isDefault: false, createdAt: BASE })
  return id
}

inboxRepositoryContract('D1', () => ({ repository: new D1InboxRepository(db), newAccount: newGuest }))

describe('inbox_items in D1', () => {
  const input = (profileId: string, key: string) => ({ id: crypto.randomUUID(), profileId, kind: 'reminder', localDay: '2030-06-15', title: 'Morning', body: 'Time for your morning routine.', link: '/routine', key, createdAt: BASE })

  it('removes a user\'s rows with the user (a guest purged by the cleanup), and leaves other accounts\' rows', async () => {
    const repository = new D1InboxRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.insertOnce(input(guest.profileId, 'reminder:2030-06-15:07:00'))
    await repository.insertOnce(input(kept.profileId, 'reminder:2030-06-15:07:00'))

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.list(guest.profileId, { limit: 10 })).toEqual([])
    expect(await repository.unreadCount(guest.profileId)).toBe(0)
    expect(await repository.list(kept.profileId, { limit: 10 })).toHaveLength(1)
  })

  it('removes a profile\'s rows with the profile, and leaves the account\'s other profiles', async () => {
    const repository = new D1InboxRepository(db)
    const account = await newGuest()
    const second = await newProfile(account.userId)
    await repository.insertOnce(input(account.profileId, 'all-done:2030-06-15'))
    await repository.insertOnce(input(second, 'all-done:2030-06-15'))

    // There is no product path that deletes a profile yet; this is the schema's ON DELETE CASCADE.
    await env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(second).run()

    expect(await repository.list(second, { limit: 10 })).toEqual([])
    expect(await repository.list(account.profileId, { limit: 10 })).toHaveLength(1)
  })

  it('refuses a row for a profile that does not exist', async () => {
    const repository = new D1InboxRepository(db)

    await expect(repository.insertOnce(input(crypto.randomUUID(), 'all-done:2030-06-15'))).rejects.toThrow()
  })
})
