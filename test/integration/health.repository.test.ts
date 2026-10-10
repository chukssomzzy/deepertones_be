import { env } from 'cloudflare:workers'
import { createDb } from '../../src/lib/db'
import { D1HealthRepository } from '../../src/modules/health/health.repository'
import { healthRepositoryContract } from '../../src/modules/health/health.repository.contract'

// Same contract the fake passes in the unit tier, now against real local D1.
healthRepositoryContract('D1', () => new D1HealthRepository(createDb(env.DB)))
