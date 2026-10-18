import type { ShelfRemoveResult, ShelfRepository } from './shelf.repository'
import type { FakeShelfStore } from './shelf.store.fake'
import type { ShelfEntryRow, ShelfRemovedReason } from './shelf.types'

/** In-memory ShelfRepository for unit tests, over the store the scans fake writes. Its behaviour is pinned by shelfRepositoryContract, which the D1 class also passes. */
export class FakeShelfRepository implements ShelfRepository {
  constructor(private readonly store: FakeShelfStore) {}

  async activeFor(profileId: string, limit: number): Promise<ShelfEntryRow[]> {
    // Same-time entries come back by id, as D1's order does.
    return this.store.rows
      .filter((row) => row.profileId === profileId && row.removedAt === null)
      .sort((a, b) => b.lastScannedAt.getTime() - a.lastScannedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit)
      .map((row) => ({ ...row }))
  }

  async activeForProduct(profileId: string, productId: string): Promise<ShelfEntryRow | null> {
    const row = this.store.rows.find((candidate) => candidate.profileId === profileId && candidate.kind === 'product' && candidate.productId === productId && candidate.removedAt === null)
    return row ? { ...row } : null
  }

  async remove(profileId: string, entryId: string, reason: ShelfRemovedReason | null, at: Date): Promise<ShelfRemoveResult> {
    const row = this.store.rows.find((candidate) => candidate.id === entryId && candidate.profileId === profileId)
    if (!row) return 'not-found'
    if (row.removedAt !== null) return 'already-removed'
    row.removedAt = at
    row.removedReason = reason
    return 'removed'
  }
}
