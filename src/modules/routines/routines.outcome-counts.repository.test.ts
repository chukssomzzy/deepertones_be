import { FakeOutcomeCountsRepository } from './routines.outcome-counts.repository.fake'
import { outcomeCountsRepositoryContract } from './routines.outcome-counts.repository.contract'

outcomeCountsRepositoryContract('fake', () => new FakeOutcomeCountsRepository())
