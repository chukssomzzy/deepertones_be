import { env } from 'cloudflare:workers'
import { createDb } from '../../src/lib/db'
import { scansRepositoryContract } from '../../src/modules/scans/scans.repository.contract'
import { D1ScansRepository } from '../../src/modules/scans/scans.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')

// scans.user_id references users, and D1 enforces it, so each contract user is a real guest (made the way the app makes one).
scansRepositoryContract('D1', () => {
  const db = createDb(env.DB)
  const users = new D1UsersRepository(db)
  return {
    repository: new D1ScansRepository(db),
    newUser: async () => {
      const id = crypto.randomUUID()
      await users.createGuestForDevice({ user: { id, createdAt: BASE }, device: { deviceHash: `scans-contract-${id}`, platform: 'ios' }, profile: { id: crypto.randomUUID() } })
      return id
    },
  }
})
