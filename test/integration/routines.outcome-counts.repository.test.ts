import { env } from 'cloudflare:workers'
import { createDb } from '../../src/lib/db'
import { outcomeCountsRepositoryContract } from '../../src/modules/routines/routines.outcome-counts.repository.contract'
import { D1OutcomeCountsRepository } from '../../src/modules/routines/routines.outcome-counts.repository'

// routine_outcome_counts has no foreign keys (counts are about groups, not accounts), so the contract needs no account.
outcomeCountsRepositoryContract('D1', () => new D1OutcomeCountsRepository(createDb(env.DB)))
