import { FakeJobRunsRepository } from './job-runs.repository.fake'
import { jobRunsRepositoryContract } from './job-runs.repository.contract'

jobRunsRepositoryContract('fake', () => new FakeJobRunsRepository())
