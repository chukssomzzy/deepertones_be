import { and, asc, count, eq, exists, gte, inArray, isNotNull, isNull, lt, min, notExists, notInArray, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { profiles } from '../profiles/profiles.table'
import { scanBackPhotos, scanItems, scanPhotos, scanRetakes, scans } from './scans.table'
import { profileProducts } from '../shelf/shelf.table'
import { PHOTO_HELD_STATES } from './scans.types'
import type { ItemPatch, ItemState, NewBackPhoto, NewRetake, NewScan, NewScanItem, NewScanPhoto, NewSibling, PhotoPatch, Scan, ScanItem, ScanPhoto } from './scans.types'

export type { ItemPatch, NewBackPhoto, NewRetake, NewScan, NewScanItem, NewScanPhoto, NewSibling, PhotoPatch, Scan, ScanItem, ScanPhoto }

// D1 allows 100 bound parameters per statement; this many ids leave headroom.
const ID_CHUNK = 90

const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK))
  return out
}

/** A scan row as a Scan: rows from before `kind` existed hold NULL, and are product scans. */
const asScan = (row: typeof scans.$inferSelect): Scan => ({ ...row, kind: row.kind ?? 'product' })

/** The earlier of two possibly-missing times. */
const earlier = (a: Date | null, b: Date | null): Date | null => (a && b ? (a < b ? a : b) : (a ?? b))

export class D1ScansRepository {
  constructor(private readonly db: Db) {}

  /**
   * Stores the scan, its photos and all its items, or nothing (one batch). Every photo starts `recognising` with no recognition
   * and nothing skipped; every item starts `recognising` with no reason, recognised fields, product or back photo; both have
   * `updatedAt` equal to `createdAt`, and the scan starts with no done time. Rejects if any id is taken or two photos share a
   * position. One INSERT per row keeps each statement under D1's bound-parameter limit.
   */
  async createScan(scan: NewScan, photos: NewScanPhoto[], items: NewScanItem[]): Promise<void> {
    const statements: BatchItem<'sqlite'>[] = [
      this.db.insert(scans).values({ ...scan, doneAt: null }),
      ...photos.map((photo) => this.db.insert(scanPhotos).values({ ...photo, updatedAt: photo.createdAt })),
      ...items.map((item) => this.db.insert(scanItems).values({ ...item, updatedAt: item.createdAt })),
    ]
    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  }

  async findScan(scanId: string): Promise<Scan | null> {
    const [row] = await this.db.select().from(scans).where(eq(scans.id, scanId))
    return row ? asScan(row) : null
  }

  /** The scan's photos in position order. */
  async photosOf(scanId: string): Promise<ScanPhoto[]> {
    return this.db.select().from(scanPhotos).where(eq(scanPhotos.scanId, scanId)).orderBy(asc(scanPhotos.position))
  }

  async findPhoto(photoId: string): Promise<ScanPhoto | null> {
    const [row] = await this.db.select().from(scanPhotos).where(eq(scanPhotos.id, photoId))
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
   * runs first, while the state is still what it was. `retake` is the same for a retaken front photo.
   *
   * A move into `ready` or `unidentified` also puts the item on its profile's shelf, in the same batch and after the update, so
   * the item is on the shelf if and only if it got there (see the shelf section of docs/architecture.md). The shelf write is
   * guarded by the item now holding the patched state and `updatedAt`, so a lost race writes nothing; it is also skipped, with the
   * move still applying, when the scan has no profile or names none. That guard is why `updatedAt` is required on these moves: the
   * method throws before writing anything when it is missing.
   */
  async updateItem(itemId: string, expected: ItemState, patch: ItemPatch, backPhoto?: NewBackPhoto, retake?: NewRetake): Promise<boolean> {
    const update = this.db
      .update(scanItems)
      .set(patch)
      .where(and(eq(scanItems.id, itemId), eq(scanItems.state, expected)))
      .returning({ id: scanItems.id })
    const statements: BatchItem<'sqlite'>[] = []
    if (backPhoto) statements.push(this.db.insert(scanBackPhotos).select(this.uploadIfStill(backPhoto, expected)))
    if (retake) statements.push(this.db.insert(scanRetakes).select(this.uploadIfStill(retake, expected)))
    const shelved = patch.state === 'ready' || patch.state === 'unidentified' ? patch.state : null
    if (shelved && !patch.updatedAt) throw new Error('updatedAt is required when an item moves into ready or unidentified')
    if (statements.length === 0 && !shelved) return (await update).length === 1

    statements.push(update)
    if (shelved) statements.push(this.shelve(itemId, shelved, patch.updatedAt))
    const results = await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
    const updated = shelved ? results[results.length - 2] : results[results.length - 1]
    return (updated as { id: string }[]).length === 1
  }

  /**
   * Stores the model's answer on the photo (one conditional UPDATE) and says whether it did. It applies only while the photo is
   * `recognising` and holds no answer, so of any number of callers exactly one wins and the stored answer is never replaced.
   */
  async storeRecognition(photoId: string, recognition: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(scanPhotos)
      .set({ recognition, updatedAt: at })
      .where(and(eq(scanPhotos.id, photoId), eq(scanPhotos.state, 'recognising'), isNull(scanPhotos.recognition)))
      .returning({ id: scanPhotos.id })
    return rows.length === 1
  }

  /**
   * Files what reading a shelf photo found, in one batch (all or nothing): the photo's patch, the new items, and the placeholder's move.
   * Safe to repeat, so a retried read cannot duplicate or lose a product.
   *
   * - The photo's patch applies only while the photo is `recognising`; a photo already read keeps its first answer.
   * - Each sibling is stored only while the scan holds fewer than `maxItems` items (counted as the statement runs, so the first in the
   *   list wins) and only if no item holds its position, which is no error: a repeat adds nothing. An id that is taken fails the whole batch.
   *   One statement per sibling keeps each under D1's bound-parameter limit.
   * - The placeholder moves out of `from` as `updateItem` does, whatever became of the siblings; the result says whether it did.
   */
  async fanOut(input: {
    photo: { id: string; patch: PhotoPatch }
    // Never into ready or unidentified: only updateItem puts an item on its profile's shelf.
    placeholder: { id: string; from: ItemState; patch: ItemPatch & { state?: Exclude<ItemState, 'ready' | 'unidentified'> } }
    siblings: NewSibling[]
    maxItems: number
  }): Promise<{ placeholderMoved: boolean }> {
    const { photo, placeholder, siblings, maxItems } = input
    const statements: BatchItem<'sqlite'>[] = [
      this.db.update(scanPhotos).set(photo.patch).where(and(eq(scanPhotos.id, photo.id), eq(scanPhotos.state, 'recognising'))),
      ...siblings.map((sibling) => this.db.insert(scanItems).select(this.siblingIfRoom(sibling, maxItems)).onConflictDoNothing({ target: [scanItems.scanId, scanItems.position] })),
      this.db
        .update(scanItems)
        .set(placeholder.patch)
        .where(and(eq(scanItems.id, placeholder.id), eq(scanItems.state, placeholder.from)))
        .returning({ id: scanItems.id }),
    ]
    const results = await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
    return { placeholderMoved: (results[results.length - 1] as { id: string }[]).length === 1 }
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
   * Items that still hold a front photo key although their state no longer needs the photo (anything but `recognising` and
   * `needs-confirmation`), oldest `updated_at` first, at most `limit`. These are the keys a release missed. Read through the partial
   * index on `updated_at` for items with a key, so it never reads the items whose photo is already gone.
   */
  async itemsWithReleasablePhoto(limit: number): Promise<ScanItem[]> {
    return this.db
      .select()
      .from(scanItems)
      .where(and(isNotNull(scanItems.photoKey), notInArray(scanItems.state, [...PHOTO_HELD_STATES])))
      .orderBy(asc(scanItems.updatedAt))
      .limit(limit)
  }

  /**
   * Clears the item's front photo key only while it is still `key` (one conditional UPDATE), and says whether it did. Nothing else
   * changes, `updated_at` included: this is bookkeeping, not a move, and must not look like one to the stale-item sweep or to `watch`.
   */
  async clearItemPhotoKey(itemId: string, key: string): Promise<boolean> {
    const rows = await this.db
      .update(scanItems)
      .set({ photoKey: null })
      .where(and(eq(scanItems.id, itemId), eq(scanItems.photoKey, key)))
      .returning({ id: scanItems.id })
    return rows.length === 1
  }

  /**
   * Photos that still hold a key although none of their items needs it: no item with `photo_id` = the photo is `recognising` or
   * `needs-confirmation`. Oldest `updated_at` first, at most `limit`. Read through the partial index on `updated_at` for photos with
   * a key; the items of each are found through `(scan_id, position)`, at most a scan's cap of them.
   */
  async shelfPhotosToRelease(limit: number): Promise<ScanPhoto[]> {
    const holding = this.db
      .select({ one: sql`1` })
      .from(scanItems)
      .where(and(eq(scanItems.scanId, scanPhotos.scanId), eq(scanItems.photoId, scanPhotos.id), inArray(scanItems.state, [...PHOTO_HELD_STATES])))
    return this.db
      .select()
      .from(scanPhotos)
      .where(and(isNotNull(scanPhotos.photoKey), notExists(holding)))
      .orderBy(asc(scanPhotos.updatedAt))
      .limit(limit)
  }

  /** The same for a scan photo's key. */
  async clearShelfPhotoKey(photoId: string, key: string): Promise<boolean> {
    const rows = await this.db
      .update(scanPhotos)
      .set({ photoKey: null })
      .where(and(eq(scanPhotos.id, photoId), eq(scanPhotos.photoKey, key)))
      .returning({ id: scanPhotos.id })
    return rows.length === 1
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
    const rows = await this.db
      .select()
      .from(scans)
      .where(and(isNull(scans.doneAt), gte(scans.createdAt, createdSince), exists(itemsOfScan()), notExists(itemsOfScan(or(notInArray(scanItems.state, states), gte(scanItems.updatedAt, before))))))
      .orderBy(asc(scans.createdAt))
      .limit(limit)
    return rows.map(asScan)
  }

  /**
   * Photos uploaded by the user at or after `since`: one per item created then, plus one per back photo and one per retake
   * uploaded then (records that survive the photo being deleted, and that every upload adds). `oldest` is the earliest of them,
   * or null when there are none.
   */
  async photosSince(userId: string, since: Date): Promise<{ count: number; oldest: Date | null }> {
    return this.photoCounts(eq(scanItems.userId, userId), eq(scanBackPhotos.userId, userId), eq(scanRetakes.userId, userId), since)
  }

  /**
   * The same count for every scan made from the given IP hash (and every back photo and retake uploaded from it), whoever made
   * them. Only scans made in the window are looked at, through the (ip_hash, created_at) index, however old the address's history is.
   */
  async photosSinceIp(ipHash: string, since: Date): Promise<{ count: number; oldest: Date | null }> {
    const recentFromThisIp = this.db
      .select({ id: scans.id })
      .from(scans)
      .where(and(eq(scans.ipHash, ipHash), gte(scans.createdAt, since)))
    return this.photoCounts(inArray(scanItems.scanId, recentFromThisIp), eq(scanBackPhotos.ipHash, ipHash), eq(scanRetakes.ipHash, ipHash), since)
  }

  /** How many back photos have been uploaded for the item, deleted ones included (their records stay). */
  async countBackPhotos(itemId: string): Promise<number> {
    const [row] = await this.db.select({ count: count() }).from(scanBackPhotos).where(eq(scanBackPhotos.itemId, itemId))
    return row?.count ?? 0
  }

  /** How many retakes have been uploaded for the item, whatever became of their photos (their records stay). */
  async countRetakes(itemId: string): Promise<number> {
    const [row] = await this.db.select({ count: count() }).from(scanRetakes).where(eq(scanRetakes.itemId, itemId))
    return row?.count ?? 0
  }

  /** Every photo key and back-photo key still stored for these users' items, and every key on their scan photos (nulls left out). */
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
      const shelfPhotos = await this.db.select({ photoKey: scanPhotos.photoKey }).from(scanPhotos).where(inArray(scanPhotos.userId, ids))
      for (const row of shelfPhotos) {
        if (row.photoKey !== null) keys.push(row.photoKey)
      }
    }
    return keys
  }

  /**
   * Gives each scan that has no profile its owner's default profile, oldest scan first, and says how many it changed (one UPDATE).
   * At most `limit` scans are changed. A scan whose owner has no default is not a candidate, so it does not use up the limit and
   * stays without a profile until a later call finds its owner has one. The candidates are read as `profile_id IS NULL` through
   * the `(profile_id, created_at)` index, so a sweep never reads the scans that have a profile.
   *
   * Reads `profiles`, another module's table: the scans written by the old Worker before the profiles rollout have no profile, and
   * no service call can say which scans those are.
   */
  async adoptOrphanScans(limit: number): Promise<number> {
    const defaultOfOwner = () =>
      this.db.select({ id: profiles.id }).from(profiles).where(and(eq(profiles.userId, scans.userId), eq(profiles.isDefault, true)))
    const candidates = this.db
      .select({ id: scans.id })
      .from(scans)
      .where(and(isNull(scans.profileId), exists(defaultOfOwner())))
      .orderBy(asc(scans.createdAt))
      .limit(limit)
    const rows = await this.db
      .update(scans)
      .set({ profileId: sql`(${defaultOfOwner()})` })
      .where(and(isNull(scans.profileId), inArray(scans.id, candidates)))
      .returning({ id: scans.id })
    return rows.length
  }

  /** Deletes the users' back-photo and retake records, items, scan photos and scans in one batch. Safe to repeat; an empty list or unknown users delete nothing. */
  async deleteForUsers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return
    const statements: BatchItem<'sqlite'>[] = chunks(userIds).flatMap((ids) => [
      this.db.delete(scanBackPhotos).where(inArray(scanBackPhotos.userId, ids)),
      this.db.delete(scanRetakes).where(inArray(scanRetakes.userId, ids)),
      this.db.delete(scanItems).where(inArray(scanItems.userId, ids)),
      this.db.delete(scanPhotos).where(inArray(scanPhotos.userId, ids)),
      this.db.delete(scans).where(inArray(scans.userId, ids)),
    ])
    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  }

  /** The upload row as a SELECT that yields it only while its item is still in `expected`, for an INSERT ... SELECT. */
  private uploadIfStill(upload: NewBackPhoto | NewRetake, expected: ItemState) {
    return sql`select ${upload.id}, ${upload.itemId}, ${upload.userId}, ${upload.ipHash}, ${upload.uploadedAt.getTime()}
        where exists (select 1 from ${scanItems} where ${scanItems.id} = ${upload.itemId} and ${scanItems.state} = ${expected})`
  }

  /**
   * The shelf write for an item that has just moved to `state` at `at`: one INSERT ... SELECT that selects nothing unless the item holds
   * that state and time (so only the winner of the guarded update writes), and its scan names a profile that exists. A product row for the
   * same profile and product is updated to this item (latest wins; a removed row is restored; `added_at` stays); a no-label row for an
   * item already on the shelf is left alone. A `ready` item with no product is not shelved.
   */
  private shelve(itemId: string, state: 'ready' | 'unidentified', at: Date) {
    const product = state === 'ready'
    const row = sql`select ${crypto.randomUUID()}, ${profiles.id}, ${product ? 'product' : 'no-label'}, ${product ? sql`${scanItems.productId}` : sql`null`}, ${product ? sql`${scanItems.formulationId}` : sql`null`},
        ${scans.id}, ${scanItems.id}, ${at.getTime()}, ${at.getTime()}, null, null
        from ${scanItems} join ${scans} on ${scans.id} = ${scanItems.scanId} join ${profiles} on ${profiles.id} = ${scans.profileId}
        where ${scanItems.id} = ${itemId} and ${scanItems.state} = ${state} and ${scanItems.updatedAt} = ${at.getTime()}${product ? sql` and ${scanItems.productId} is not null` : sql``}`
    const insert = this.db.insert(profileProducts).select(row)
    return product
      ? insert.onConflictDoUpdate({
          target: [profileProducts.profileId, profileProducts.productId],
          targetWhere: sql`${profileProducts.productId} is not null`,
          set: {
            formulationId: sql`excluded.formulation_id`,
            scanId: sql`excluded.scan_id`,
            itemId: sql`excluded.item_id`,
            lastScannedAt: sql`excluded.last_scanned_at`,
            removedAt: null,
            removedReason: null,
          },
        })
      : insert.onConflictDoNothing() // only the item index can clash: a no-label row has no product
  }

  /** The sibling as a SELECT that yields it only while its scan holds fewer than `maxItems` items, for an INSERT ... SELECT (one value per column, in the table's order). */
  private siblingIfRoom(s: NewSibling, maxItems: number) {
    return sql`select ${s.id}, ${s.scanId}, ${s.userId}, ${s.position}, ${s.photoId}, ${s.state}, null, ${s.photoKey}, null,
        ${s.recognisedBrand}, ${s.recognisedName}, ${s.recognisedVariant}, ${s.recognisedForm}, ${s.recognisedCategory}, ${s.recognisedConfidence},
        null, null, null, null, null, null, ${s.createdAt.getTime()}, ${s.createdAt.getTime()}
        where (select count(*) from ${scanItems} where ${scanItems.scanId} = ${s.scanId}) < ${maxItems}`
  }

  private async photoCounts(
    ownedItems: ReturnType<typeof eq>,
    ownedBackPhotos: ReturnType<typeof eq>,
    ownedRetakes: ReturnType<typeof eq>,
    since: Date,
  ): Promise<{ count: number; oldest: Date | null }> {
    const [[front], [back], [retaken]] = await this.db.batch([
      this.db
        .select({ count: count(), oldest: min(scanItems.createdAt) })
        .from(scanItems)
        .where(and(ownedItems, gte(scanItems.createdAt, since))),
      this.db
        .select({ count: count(), oldest: min(scanBackPhotos.uploadedAt) })
        .from(scanBackPhotos)
        .where(and(ownedBackPhotos, gte(scanBackPhotos.uploadedAt, since))),
      this.db
        .select({ count: count(), oldest: min(scanRetakes.uploadedAt) })
        .from(scanRetakes)
        .where(and(ownedRetakes, gte(scanRetakes.uploadedAt, since))),
    ])
    return { count: front!.count + back!.count + retaken!.count, oldest: earlier(earlier(front!.oldest, back!.oldest), retaken!.oldest) }
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type ScansRepository = PublicOf<D1ScansRepository>
