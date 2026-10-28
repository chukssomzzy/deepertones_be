import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import { FakeUsersRepository } from '../users/users.repository.fake'
import { skinCareRepositoryContract } from './skin-care.repository.contract'
import { FakeSkinCareRepository } from './skin-care.repository.fake'

const BASE = new Date('2030-06-15T12:00:00.000Z')

// Accounts are made the way the product makes them: by creating a guest, which writes its default profile. The D1 twin
// (test/integration/skin-care.repository.test.ts) does the same against real tables.
skinCareRepositoryContract('fake', () => {
  const users = new FakeUsersRepository({ profiles: new FakeProfilesRepository() })
  return {
    repository: new FakeSkinCareRepository(),
    newAccount: async () => {
      const userId = crypto.randomUUID()
      const profileId = crypto.randomUUID()
      await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
      return { userId, profileId }
    },
  }
})
