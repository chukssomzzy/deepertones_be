import type { OpsAlertsRepository } from './ops-alerts.repository'
import type { OpsAlertKind } from './ops-alerts.types'

/** In-memory OpsAlertsRepository for unit tests. Behaviour is pinned by opsAlertsRepositoryContract. It checks and stores without awaiting in between, as the one statement on D1 does. */
export class FakeOpsAlertsRepository implements OpsAlertsRepository {
  private readonly windows = new Map<OpsAlertKind, number>()

  async claim(kind: OpsAlertKind, windowStart: Date): Promise<boolean> {
    const stored = this.windows.get(kind)
    if (stored !== undefined && stored >= windowStart.getTime()) return false
    this.windows.set(kind, windowStart.getTime())
    return true
  }
}
