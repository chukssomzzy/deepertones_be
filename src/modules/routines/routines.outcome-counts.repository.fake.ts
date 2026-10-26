import type { OutcomeCountsGroup, OutcomeCountsRepository } from './routines.outcome-counts.repository'
import type { OutcomeCounts } from './routines.outcomes'

/** In-memory OutcomeCountsRepository for unit tests. Its behaviour is pinned by outcomeCountsRepositoryContract, which the D1 class also passes. */
export class FakeOutcomeCountsRepository implements OutcomeCountsRepository {
  private rows = new Map<string, OutcomeCounts>()

  async counts(group: OutcomeCountsGroup, codes: string[]): Promise<Map<string, OutcomeCounts>> {
    const found = new Map<string, OutcomeCounts>()
    for (const code of codes) {
      const row = this.rows.get(this.key(group, code))
      if (row) found.set(code, { ...row })
    }
    return found
  }

  async upsert(group: OutcomeCountsGroup, code: string, counts: OutcomeCounts, _at: Date): Promise<void> {
    this.rows.set(this.key(group, code), { ...counts })
  }

  // A null skin type is '' as in D1; JSON keeps the parts from running into each other.
  private key(group: OutcomeCountsGroup, code: string): string {
    return JSON.stringify([group.goal, group.skinType ?? '', group.country, code])
  }
}
