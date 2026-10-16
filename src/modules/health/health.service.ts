import { describeUnexpectedError } from '../../lib/safe-error'
import type { HealthRepository } from './health.repository'
import type { HealthReport } from './health.types'

export class HealthService {
  constructor(
    private readonly repository: HealthRepository,
    private readonly environment: string,
  ) {}

  async check(): Promise<HealthReport> {
    const database = await this.repository.ping().then(
      () => 'ok' as const,
      (error: unknown) => {
        console.error({ check: 'database', error: describeUnexpectedError(error) })
        return 'down' as const
      },
    )

    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      environment: this.environment,
      checks: { database },
    }
  }
}
