import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import { FakeUsersRepository } from '../users/users.repository.fake'
import { FakeRoutineCheckInsRepository } from './routines.check-ins.repository.fake'
import { routineCheckInsRepositoryContract } from './routines.check-ins.repository.contract'

const BASE = new Date('2030-06-15T12:00:00.000Z')

// Accounts are made the way the product makes them: by creating a guest, which writes its default profile. The D1 twin
// (test/integration/routines.check-ins.repository.test.ts) does the same against real tables.
routineCheckInsRepositoryContract('fake', () => {
  const users = new FakeUsersRepository({ profiles: new FakeProfilesRepository() })
  return {
    repository: new FakeRoutineCheckInsRepository(),
    newAccount: async () => {
      const userId = crypto.randomUUID()
      const profileId = crypto.randomUUID()
      await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
      return { userId, profileId }
    },
  }
})
