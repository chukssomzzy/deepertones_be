import type { GoalsRepository } from './goals.repository'
import type { GoalRow } from './goals.types'

/** In-memory GoalsRepository for unit tests. Its behaviour is pinned by goalsRepositoryContract, which the D1 class also passes. */
export class FakeGoalsRepository implements GoalsRepository {
  private rows: GoalRow[] = []

  async append(row: GoalRow): Promise<void> {
    this.rows.push({ ...row })
  }

  async current(profileId: string): Promise<GoalRow | null> {
    return (await this.history(profileId))[0] ?? null
  }

  async history(profileId: string): Promise<GoalRow[]> {
    // Rows that share a time come back in reverse insertion order, as D1's rowid tiebreak does.
    return this.rows
      .filter((row) => row.profileId === profileId)
      .reverse()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({ ...row }))
  }
}
