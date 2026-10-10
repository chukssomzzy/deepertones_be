import type { HealthRepository } from './health.repository'

/** In-memory stand-in for unit tests. Flip `up` to simulate an outage. */
export class FakeHealthRepository implements HealthRepository {
  up = true

  async ping(): Promise<void> {
    if (!this.up) throw new Error('database unreachable')
  }
}
