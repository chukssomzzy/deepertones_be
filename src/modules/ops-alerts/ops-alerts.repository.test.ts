import { opsAlertsRepositoryContract } from './ops-alerts.repository.contract'
import { FakeOpsAlertsRepository } from './ops-alerts.repository.fake'

opsAlertsRepositoryContract('fake', () => new FakeOpsAlertsRepository())
