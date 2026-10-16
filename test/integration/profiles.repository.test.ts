import { env } from 'cloudflare:workers'
import { createDb } from '../../src/lib/db'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { profilesRepositoryContract } from '../../src/modules/profiles/profiles.repository.contract'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')

// profiles.user_id references users, and D1 enforces it, so each contract user is a real guest (made the way the app makes one,
// which writes the default profile in the same batch).
profilesRepositoryContract('D1', () => {
  const db = createDb(env.DB)
  const users = new D1UsersRepository(db)
  return {
    repository: new D1ProfilesRepository(db),
    newUser: async () => {
      const userId = crypto.randomUUID()
      const profileId = crypto.randomUUID()
      await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `profiles-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
      return { userId, defaultProfile: { id: profileId, userId, displayName: null, isDefault: true, createdAt: BASE } }
    },
  }
})
