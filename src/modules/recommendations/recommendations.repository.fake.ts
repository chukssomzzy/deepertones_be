import type { RecommendationsRepository } from './recommendations.repository'
import type { ShoppingRow } from './recommendations.types'

/** In-memory RecommendationsRepository for unit tests. Its behaviour is pinned by shoppingRepositoryContract, which the D1 class also passes. */
export class FakeRecommendationsRepository implements RecommendationsRepository {
  private rows: ShoppingRow[] = []

  async append(row: ShoppingRow): Promise<void> {
    this.rows.push({ ...row })
  }

  async current(profileId: string): Promise<ShoppingRow | null> {
    return (await this.history(profileId))[0] ?? null
  }

  async history(profileId: string): Promise<ShoppingRow[]> {
    // Rows that share a time come back in reverse insertion order, as D1's rowid tiebreak does.
    return this.rows
      .filter((row) => row.profileId === profileId)
      .reverse()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({ ...row }))
  }
}
