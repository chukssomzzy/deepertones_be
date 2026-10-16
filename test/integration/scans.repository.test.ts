import { env } from 'cloudflare:workers'
import { createDb } from '../../src/lib/db'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { scansRepositoryContract } from '../../src/modules/scans/scans.repository.contract'
import { D1ScansRepository } from '../../src/modules/scans/scans.repository'
import { users as usersTable } from '../../src/modules/users/users.table'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')

// scans.user_id references users, and D1 enforces it, so each contract user is a real guest (made the way the app makes one).
scansRepositoryContract('D1', () => {
  const db = createDb(env.DB)
  const users = new D1UsersRepository(db)
  const profiles = new D1ProfilesRepository(db)
  return {
    repository: new D1ScansRepository(db),
    newUser: async () => {
      const id = crypto.randomUUID()
      await users.createGuestForDevice({ user: { id, createdAt: BASE }, device: { deviceHash: `scans-contract-${id}`, platform: 'ios' }, profile: { id: crypto.randomUUID() } })
      return id
    },
    // A user the old Worker made: a row with no profile (createGuestForDevice always writes one).
    newUserWithoutProfile: async () => {
      const id = crypto.randomUUID()
      await db.insert(usersTable).values({ id, createdAt: BASE, lastSeenAt: BASE })
      return id
    },
    giveDefaultProfile: async (userId) => {
      const id = crypto.randomUUID()
      await profiles.insert({ id, userId, displayName: null, isDefault: true, createdAt: BASE })
      return id
    },
  }
})
