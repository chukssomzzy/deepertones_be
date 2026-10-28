import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import { FakeUsersRepository } from '../users/users.repository.fake'
import { inboxRepositoryContract } from './inbox.repository.contract'
import { FakeInboxRepository } from './inbox.repository.fake'

const BASE = new Date('2030-06-15T12:00:00.000Z')

// Accounts are made the way the product makes them: by creating a guest, which writes its default profile. The D1 twin
// (test/integration/inbox.repository.test.ts) does the same against real tables.
inboxRepositoryContract('fake', () => {
  const profiles = new FakeProfilesRepository()
  const users = new FakeUsersRepository({ profiles })
  return {
    repository: new FakeInboxRepository(),
    newAccount: async () => {
      const userId = crypto.randomUUID()
      const profileId = crypto.randomUUID()
      await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
      return { userId, profileId }
    },
  }
})
