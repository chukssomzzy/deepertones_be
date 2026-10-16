import { aiUsageRepositoryContract } from './ai-usage.repository.contract'
import { FakeAiUsageRepository } from './ai-usage.repository.fake'

aiUsageRepositoryContract('fake', () => new FakeAiUsageRepository())
