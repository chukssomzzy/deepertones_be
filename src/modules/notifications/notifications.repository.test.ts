import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import { FakeUsersRepository } from '../users/users.repository.fake'
import { FakeNotificationSettingsRepository } from './notification-settings.repository.fake'
import { notificationSettingsRepositoryContract, pushTokensRepositoryContract } from './notifications.repository.contract'
import { FakePushTokensRepository } from './push-tokens.repository.fake'

const BASE = new Date('2030-06-15T12:00:00.000Z')

// Accounts are made the way the product makes them: by creating a guest, which writes its default profile. The D1 twin
// (test/integration/notifications.repository.test.ts) does the same against real tables.
pushTokensRepositoryContract('fake', () => {
  const profiles = new FakeProfilesRepository()
  const users = new FakeUsersRepository({ profiles })
  return {
    repository: new FakePushTokensRepository(),
    newAccount: async () => {
      const userId = crypto.randomUUID()
      const profileId = crypto.randomUUID()
      await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
      return { userId, profileId }
    },
    newProfile: async (userId) => {
      const id = crypto.randomUUID()
      await profiles.insert({ id, userId, displayName: null, isDefault: false, createdAt: BASE })
      return id
    },
  }
})

notificationSettingsRepositoryContract('fake', () => {
  const users = new FakeUsersRepository()
  return {
    repository: new FakeNotificationSettingsRepository(),
    newUser: async () => {
      const userId = crypto.randomUUID()
      await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `contract-${userId}`, platform: 'ios' }, profile: { id: crypto.randomUUID() } })
      return userId
    },
  }
})
