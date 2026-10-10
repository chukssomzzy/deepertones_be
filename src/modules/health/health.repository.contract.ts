import { describe, expect, it } from 'vitest'
import type { HealthRepository } from './health.repository'

/**
 * Behaviour every HealthRepository must have. Runs against the fake (unit tier) and
 * against real local D1 (integration tier), so the fake cannot drift from the real thing.
 */
export const healthRepositoryContract = (name: string, make: () => HealthRepository) => {
  describe(`HealthRepository contract: ${name}`, () => {
    it('ping resolves while the database is reachable', async () => {
      await expect(make().ping()).resolves.toBeUndefined()
    })
  })
}
