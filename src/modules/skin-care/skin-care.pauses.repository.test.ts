import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import { FakeUsersRepository } from '../users/users.repository.fake'
import { stepPausesRepositoryContract } from './skin-care.pauses.repository.contract'
import { FakeStepPausesRepository } from './skin-care.pauses.repository.fake'

const BASE = new Date('2030-06-15T12:00:00.000Z')

// Accounts are made the way the product makes them: by creating a guest, which writes its default profile. The D1 twin
// (test/integration/skin-care.pauses.repository.test.ts) does the same against real tables.
stepPausesRepositoryContract('fake', () => {
  const users = new FakeUsersRepository({ profiles: new FakeProfilesRepository() })
  return {
    repository: new FakeStepPausesRepository(),
    newAccount: async () => {
      const userId = crypto.randomUUID()
      const profileId = crypto.randomUUID()
      await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
      return { userId, profileId }
    },
  }
})
