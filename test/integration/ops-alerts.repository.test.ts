import { env } from 'cloudflare:workers'
import { createDb } from '../../src/lib/db'
import { D1OpsAlertsRepository } from '../../src/modules/ops-alerts/ops-alerts.repository'
import { opsAlertsRepositoryContract } from '../../src/modules/ops-alerts/ops-alerts.repository.contract'

opsAlertsRepositoryContract('D1', () => new D1OpsAlertsRepository(createDb(env.DB)))
