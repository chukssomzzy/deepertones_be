import { describe, expect, it } from 'vitest'
import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import { FakeUsersRepository } from '../users/users.repository.fake'
import { escalationHoldsRepositoryContract } from './skin-care.holds.repository.contract'
import { FakeEscalationHoldsRepository } from './skin-care.holds.repository.fake'
import { HOLD_CLOSE_HOW } from './skin-care.vocabulary'

const BASE = new Date('2030-06-15T12:00:00.000Z')

// Accounts are made the way the product makes them: by creating a guest, which writes its default profile. The D1 twin
// (test/integration/skin-care.holds.repository.test.ts) does the same against real tables.
escalationHoldsRepositoryContract('fake', () => {
  const users = new FakeUsersRepository({ profiles: new FakeProfilesRepository() })
  return {
    repository: new FakeEscalationHoldsRepository(),
    newAccount: async () => {
      const userId = crypto.randomUUID()
      const profileId = crypto.randomUUID()
      await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
      return { userId, profileId }
    },
  }
})

describe('HOLD_CLOSE_HOW', () => {
  it('names the two ways a person ends a hold: "I\'ve been seen" and "It\'s settled"', () => {
    expect([...HOLD_CLOSE_HOW]).toEqual(['seen', 'settled'])
  })
})
