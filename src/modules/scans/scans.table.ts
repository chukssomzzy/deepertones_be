import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { users } from '../users/users.table'
import type { ProductCategory } from '../../providers/product-research/product-researcher.provider'

/**
 * One upload of photos. `ip_hash` is an HMAC of the caller's IP (the raw address is never stored), for the per-IP daily
 * quota. `done_at` is set once, by the update that decides this scan's `done` event is the one to send.
 */
export const scans = sqliteTable(
  'scans',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ipHash: text('ip_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    doneAt: integer('done_at', { mode: 'timestamp_ms' }),
  },
  // The IP index leads with ip_hash and ends in created_at, so the per-IP quota reads only the last day's scans.
  // The partial one holds only scans still without a done time (a small, recent set), for the reaper's lost-done repair.
  (t) => [
    index('scans_user_id_idx').on(t.userId),
    index('scans_ip_hash_created_at_idx').on(t.ipHash, t.createdAt),
    index('scans_not_done_created_at_idx').on(t.createdAt).where(sql`${t.doneAt} IS NULL`),
  ],
)

/** One photo of one product, and where it has got to. `product_id` and `formulation_id` point into the catalog, which is not this module's, so they carry no foreign key. */
export const scanItems = sqliteTable(
  'scan_items',
  {
    id: text('id').primaryKey(),
    scanId: text('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    // The scan's owner, kept here so the daily quotas and the guest cleanup need no join.
    userId: text('user_id').notNull(),
    position: integer('position').notNull(),
    state: text('state', {
      enum: ['recognising', 'needs-confirmation', 'matching', 'researching', 'needs-back-photo', 'reading-label', 'analysing', 'ready', 'rejected', 'failed'],
    })
      .notNull()
      .default('recognising'),
    // Why the item is rejected or failed, or why it asks for the back photo again.
    reason: text('reason', {
      enum: ['face-or-person', 'not-a-beauty-product', 'unreadable', 'photo-missing', 'analysis-failed', 'research-busy', 'unavailable', 'label-unreadable'],
    }),
    // Null once the photo is deleted.
    photoKey: text('photo_key'),
    // Null once the photo is deleted (after a read, or an unreadable one). The upload itself stays counted in scan_back_photos.
    backPhotoKey: text('back_photo_key'),
    recognisedBrand: text('recognised_brand'),
    recognisedName: text('recognised_name'),
    recognisedVariant: text('recognised_variant'),
    recognisedCategory: text('recognised_category').$type<ProductCategory>(),
    recognisedConfidence: real('recognised_confidence'),
    productId: text('product_id'),
    formulationId: text('formulation_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('scan_items_scan_id_position_idx').on(t.scanId, t.position),
    index('scan_items_user_id_created_at_idx').on(t.userId, t.createdAt),
    // The reaper looks for items that have sat in a working state for too long.
    index('scan_items_state_updated_at_idx').on(t.state, t.updatedAt),
  ],
)

/**
 * One row per back photo uploaded, kept after the photo is deleted, so the daily quotas count every upload however many
 * the item has had. `ip_hash` is the uploader's own, which may differ from the scan's.
 */
export const scanBackPhotos = sqliteTable(
  'scan_back_photos',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => scanItems.id, { onDelete: 'cascade' }),
    // Kept here, like scan_items.user_id, so the quotas and the guest cleanup need no join.
    userId: text('user_id').notNull(),
    ipHash: text('ip_hash').notNull(),
    uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('scan_back_photos_user_id_uploaded_at_idx').on(t.userId, t.uploadedAt), index('scan_back_photos_ip_hash_uploaded_at_idx').on(t.ipHash, t.uploadedAt)],
)
