import { env } from 'cloudflare:workers'
import { createDb } from '../../src/lib/db'
import { D1AiUsageRepository } from '../../src/modules/ai-usage/ai-usage.repository'
import { aiUsageRepositoryContract } from '../../src/modules/ai-usage/ai-usage.repository.contract'

aiUsageRepositoryContract('D1', () => new D1AiUsageRepository(createDb(env.DB)))
