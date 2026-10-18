import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { profileProducts } from './shelf.table'
import type { ShelfEntryRow, ShelfRemovedReason } from './shelf.types'

/** What `remove` found: the profile's active row (now removed), its row already removed (left as it was), or no such row for the profile. */
export type ShelfRemoveResult = 'removed' | 'already-removed' | 'not-found'

export class D1ShelfRepository {
  constructor(private readonly db: Db) {}

  /**
   * The profile's entries that are not removed, the most recently scanned first, at most `limit`. Entries scanned in the same
   * millisecond come back by id, so the order is the same on every read (and in the fake).
   */
  async activeFor(profileId: string, limit: number): Promise<ShelfEntryRow[]> {
    return this.db
      .select()
      .from(profileProducts)
      .where(and(eq(profileProducts.profileId, profileId), isNull(profileProducts.removedAt)))
      .orderBy(desc(profileProducts.lastScannedAt), asc(profileProducts.id))
      .limit(limit)
  }

  /** The profile's entry for this product if it is on the shelf (not removed); a no-label entry is never one. */
  async activeForProduct(profileId: string, productId: string): Promise<ShelfEntryRow | null> {
    const [row] = await this.db
      .select()
      .from(profileProducts)
      .where(and(eq(profileProducts.profileId, profileId), eq(profileProducts.kind, 'product'), eq(profileProducts.productId, productId), isNull(profileProducts.removedAt)))
    return row ?? null
  }

  /** Soft-removes the profile's own entry. Another profile's entry is reported as not found and left alone; an entry already removed keeps its first time and reason. */
  async remove(profileId: string, entryId: string, reason: ShelfRemovedReason | null, at: Date): Promise<ShelfRemoveResult> {
    // One conditional update decides, so two removals racing cannot both overwrite the first one's time and reason.
    const removed = await this.db
      .update(profileProducts)
      .set({ removedAt: at, removedReason: reason })
      .where(and(eq(profileProducts.id, entryId), eq(profileProducts.profileId, profileId), isNull(profileProducts.removedAt)))
      .returning({ id: profileProducts.id })
    if (removed.length > 0) return 'removed'
    const [existing] = await this.db
      .select({ id: profileProducts.id })
      .from(profileProducts)
      .where(and(eq(profileProducts.id, entryId), eq(profileProducts.profileId, profileId)))
    return existing ? 'already-removed' : 'not-found'
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type ShelfRepository = PublicOf<D1ShelfRepository>
