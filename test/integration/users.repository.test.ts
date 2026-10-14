import { env } from 'cloudflare:workers'
import { createDb } from '../../src/lib/db'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { usersRepositoryContract } from '../../src/modules/users/users.repository.contract'

usersRepositoryContract('D1', () => new D1UsersRepository(createDb(env.DB)))
