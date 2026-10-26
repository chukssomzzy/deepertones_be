import type { EmailAddress } from '../../lib/email-address'
import { FakeUsersRepository } from '../users/users.repository.fake'
import { FakeProfilesRepository } from './profiles.repository.fake'
import { profilesRepositoryContract } from './profiles.repository.contract'

const BASE = new Date('2030-06-15T12:00:00.000Z')

// A user comes with its default profile, written the way the product writes it: by creating the guest. The D1 twin
// (test/integration/profiles.repository.test.ts) does the same against real tables.
profilesRepositoryContract('fake', () => {
  const repository = new FakeProfilesRepository()
  const users = new FakeUsersRepository({ profiles: repository })
  return {
    repository,
    verify: async (userId) => {
      await users.promote(userId, { kind: 'email', email: `${userId}@example.com` as EmailAddress }, BASE)
    },
    newUser: async () => {
      const userId = crypto.randomUUID()
      const profileId = crypto.randomUUID()
      await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `profiles-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
      return { userId, defaultProfile: { id: profileId, userId, displayName: null, isDefault: true, createdAt: BASE } }
    },
  }
})
