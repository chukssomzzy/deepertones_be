import { and, asc, count, eq, exists, gte, inArray, isNull, lt, min, notExists, notInArray, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { scanBackPhotos, scanItems, scans } from './scans.table'
import type { ItemPatch, ItemState, NewBackPhoto, NewScan, NewScanItem, Scan, ScanItem } from './scans.types'

export type { ItemPatch, NewBackPhoto, NewScan, NewScanItem, Scan, ScanItem }

// D1 allows 100 bound parameters per statement; this many ids leave headroom.
const ID_CHUNK = 90

const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK))
  return out
}

/** The earlier of two possibly-missing times. */
const earlier = (a: Date | null, b: Date | null): Date | null => (a && b ? (a < b ? a : b) : (a ?? b))

export class D1ScansRepository {
  constructor(private readonly db: Db) {}

  /**
   * Stores the scan and all its items, or nothing (one batch). Every item starts `recognising` with no reason,
   * recognised fields, product or back photo, and `updatedAt` equal to `createdAt`; the scan starts with no done time.
   * Rejects if any id is taken. One INSERT per item keeps each statement under D1's bound-parameter limit.
   */
  async createScan(scan: NewScan, items: NewScanItem[]): Promise<void> {
    const statements: BatchItem<'sqlite'>[] = [
      this.db.insert(scans).values({ ...scan, doneAt: null }),
      ...items.map((item) => this.db.insert(scanItems).values({ ...item, updatedAt: item.createdAt })),
    ]
    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  }

  async findScan(scanId: string): Promise<Scan | null> {
    const [row] = await this.db.select().from(scans).where(eq(scans.id, scanId))
    return row ?? null
  }

  /** The scan's items in position order. */
  async itemsOf(scanId: string): Promise<ScanItem[]> {
    return this.db.select().from(scanItems).where(eq(scanItems.scanId, scanId)).orderBy(asc(scanItems.position))
  }

  async findItem(itemId: string): Promise<ScanItem | null> {
    const [row] = await this.db.select().from(scanItems).where(eq(scanItems.id, itemId))
    return row ?? null
  }

  /**
   * Applies the patch only while the item is still in the `expected` state, and says whether it did (one conditional
   * UPDATE, so of two simultaneous callers exactly one wins). A field the patch leaves out is unchanged; one it sets to
   * null is cleared. Nothing changes when the state differs or the item is unknown.
   *
   * `backPhoto` is the upload this move records for the daily quotas. It goes in the same batch as the update and is
   * written only if the item is in the `expected` state, so it is recorded exactly when the update applies: the insert
   * runs first, while the state is still what it was.
   */
  async updateItem(itemId: string, expected: ItemState, patch: ItemPatch, backPhoto?: NewBackPhoto): Promise<boolean> {
    const update = this.db
      .update(scanItems)
      .set(patch)
      .where(and(eq(scanItems.id, itemId), eq(scanItems.state, expected)))
      .returning({ id: scanItems.id })
    if (!backPhoto) return (await update).length === 1

    const record = this.db.insert(scanBackPhotos).select(
      sql`select ${backPhoto.id}, ${backPhoto.itemId}, ${backPhoto.userId}, ${backPhoto.ipHash}, ${backPhoto.uploadedAt.getTime()}
        where exists (select 1 from ${scanItems} where ${scanItems.id} = ${itemId} and ${scanItems.state} = ${expected})`,
    )
    const [, rows] = await this.db.batch([record, update])
    return rows.length === 1
  }

  /** Sets the scan's done time unless it has one (one conditional UPDATE), and says whether it did: of any number of callers exactly one gets true. */
  async markScanDone(scanId: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(scans)
      .set({ doneAt: at })
      .where(and(eq(scans.id, scanId), isNull(scans.doneAt)))
      .returning({ id: scans.id })
    return rows.length === 1
  }

  /**
   * Takes back the done time `at` that a caller set with markScanDone (one conditional UPDATE), and says whether it did. It
   * applies only while the scan's done time is still exactly `at`, so it never undoes a mark another call made.
   */
  async clearScanDone(scanId: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(scans)
      .set({ doneAt: null })
      .where(and(eq(scans.id, scanId), eq(scans.doneAt, at)))
      .returning({ id: scans.id })
    return rows.length === 1
  }

  /** Items in any of `states` last updated before `before` (not at it), oldest first, at most `limit`. */
  async staleItems(states: ItemState[], before: Date, limit: number): Promise<ScanItem[]> {
    if (states.length === 0) return []
    return this.db
      .select()
      .from(scanItems)
      .where(and(inArray(scanItems.state, states), lt(scanItems.updatedAt, before)))
      .orderBy(asc(scanItems.updatedAt))
      .limit(limit)
  }

  /**
   * Scans with no done time, created at or after `createdSince`, whose items are all in one of `states` and were all last
   * updated before `before` (not at it), oldest scan first, at most `limit`. A scan with no items is never listed. These
   * are the scans whose `done` was lost. `createdSince` keeps the read to recent scans, through the partial index on
   * `created_at` for scans with no done time.
   */
  async settledScansNotDone(states: ItemState[], before: Date, createdSince: Date, limit: number): Promise<Scan[]> {
    if (states.length === 0) return []
    const itemsOfScan = (...conditions: (SQL | undefined)[]) =>
      this.db
        .select({ one: sql`1` })
        .from(scanItems)
        .where(and(eq(scanItems.scanId, scans.id), ...conditions))
    return this.db
      .select()
      .from(scans)
      .where(and(isNull(scans.doneAt), gte(scans.createdAt, createdSince), exists(itemsOfScan()), notExists(itemsOfScan(or(notInArray(scanItems.state, states), gte(scanItems.updatedAt, before))))))
      .orderBy(asc(scans.createdAt))
      .limit(limit)
  }

  /**
   * Photos uploaded by the user at or after `since`: one per item created then, plus one per back photo uploaded then
   * (a record that survives the back photo being deleted, and that every upload adds). `oldest` is the earliest of them,
   * or null when there are none.
   */
  async photosSince(userId: string, since: Date): Promise<{ count: number; oldest: Date | null }> {
    return this.photoCounts(eq(scanItems.userId, userId), eq(scanBackPhotos.userId, userId), since)
  }

  /**
   * The same count for every scan made from the given IP hash (and every back photo uploaded from it), whoever made
   * them. Only scans made in the window are looked at, through the (ip_hash, created_at) index, however old the address's history is.
   */
  async photosSinceIp(ipHash: string, since: Date): Promise<{ count: number; oldest: Date | null }> {
    const recentFromThisIp = this.db
      .select({ id: scans.id })
      .from(scans)
      .where(and(eq(scans.ipHash, ipHash), gte(scans.createdAt, since)))
    return this.photoCounts(inArray(scanItems.scanId, recentFromThisIp), eq(scanBackPhotos.ipHash, ipHash), since)
  }

  /** Every photo key and back-photo key still stored for these users' items (nulls left out). */
  async photoKeysForUsers(userIds: string[]): Promise<string[]> {
    const keys: string[] = []
    for (const ids of chunks(userIds)) {
      const rows = await this.db
        .select({ photoKey: scanItems.photoKey, backPhotoKey: scanItems.backPhotoKey })
        .from(scanItems)
        .where(inArray(scanItems.userId, ids))
      for (const row of rows) {
        if (row.photoKey !== null) keys.push(row.photoKey)
        if (row.backPhotoKey !== null) keys.push(row.backPhotoKey)
      }
    }
    return keys
  }

  /** Deletes the users' back-photo records, items and scans in one batch. Safe to repeat; an empty list or unknown users delete nothing. */
  async deleteForUsers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return
    const statements: BatchItem<'sqlite'>[] = chunks(userIds).flatMap((ids) => [
      this.db.delete(scanBackPhotos).where(inArray(scanBackPhotos.userId, ids)),
      this.db.delete(scanItems).where(inArray(scanItems.userId, ids)),
      this.db.delete(scans).where(inArray(scans.userId, ids)),
    ])
    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  }

  private async photoCounts(ownedItems: ReturnType<typeof eq>, ownedUploads: ReturnType<typeof eq>, since: Date): Promise<{ count: number; oldest: Date | null }> {
    const [[front], [back]] = await this.db.batch([
      this.db
        .select({ count: count(), oldest: min(scanItems.createdAt) })
        .from(scanItems)
        .where(and(ownedItems, gte(scanItems.createdAt, since))),
      this.db
        .select({ count: count(), oldest: min(scanBackPhotos.uploadedAt) })
        .from(scanBackPhotos)
        .where(and(ownedUploads, gte(scanBackPhotos.uploadedAt, since))),
    ])
    return { count: front!.count + back!.count, oldest: earlier(front!.oldest, back!.oldest) }
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type ScansRepository = PublicOf<D1ScansRepository>
