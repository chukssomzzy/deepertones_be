import { env } from 'cloudflare:workers'
import { createDb } from '../../src/lib/db'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { usersRepositoryContract } from '../../src/modules/users/users.repository.contract'

usersRepositoryContract('D1', () => {
  const db = createDb(env.DB)
  return { repository: new D1UsersRepository(db), profiles: new D1ProfilesRepository(db) }
})
