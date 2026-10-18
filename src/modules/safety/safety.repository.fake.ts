import type { SafetyRepository } from './safety.repository'
import type { SafetyRow } from './safety.types'

/** In-memory SafetyRepository for unit tests. Its behaviour is pinned by safetyRepositoryContract, which the D1 class also passes. */
export class FakeSafetyRepository implements SafetyRepository {
  private rows: SafetyRow[] = []

  async append(row: SafetyRow): Promise<void> {
    this.rows.push({ ...row, choices: [...row.choices] })
  }

  async current(profileId: string): Promise<SafetyRow | null> {
    return (await this.history(profileId))[0] ?? null
  }

  async history(profileId: string): Promise<SafetyRow[]> {
    // Rows that share a time come back in reverse insertion order, as D1's rowid tiebreak does.
    return this.rows
      .filter((row) => row.profileId === profileId)
      .reverse()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({ ...row, choices: [...row.choices] }))
  }
}
