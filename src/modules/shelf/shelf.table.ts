import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { profiles } from '../profiles/profiles.table'

/**
 * One product a profile uses: its shelf. A row is written by the same batch that moves a scan item into `ready` (kind `product`) or
 * `unidentified` (kind `no-label`), so an item is on the shelf if and only if it reached one of those states. A product row is one per
 * (profile, product): scanning the product again updates the row to the latest item (latest wins: formulation, source scan and item, and
 * `last_scanned_at` move on; `added_at` keeps the first time). A no-label row is one per item, has no product or formulation, and the
 * source item holds the user's answers. Removing is soft: `removed_at` (null while on the shelf) and an optional `removed_reason` are
 * set, and a later scan of the product clears them. `scan_id` and `item_id` are the source with no foreign keys, as scans can outlive
 * or be cleaned apart from the shelf. Rows go with their profile (cascade), so guest cleanup needs no cleaner of its own.
 *
 * Two catalog facts readers depend on. A named label that adopts an unnamed product's list deletes the unnamed product (see
 * ProductCatalogService.productSummary, which reads through the formulation for this reason), so (a) `product_id` can dangle afterwards:
 * read a product through `formulation_id`; and (b) a rescan after the adoption arrives under a different product id, so the dedupe can
 * leave a second row for one physical product. Both are accepted for now.
 */
export const profileProducts = sqliteTable(
  'profile_products',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['product', 'no-label'] }).notNull(),
    productId: text('product_id'),
    formulationId: text('formulation_id'),
    scanId: text('scan_id').notNull(),
    itemId: text('item_id').notNull(),
    addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull(),
    lastScannedAt: integer('last_scanned_at', { mode: 'timestamp_ms' }).notNull(),
    removedAt: integer('removed_at', { mode: 'timestamp_ms' }),
    removedReason: text('removed_reason', { enum: ['finished', 'stopped', 'not-mine'] }),
  },
  // The first unique index is the product dedupe and the upsert's conflict target; the second makes a repeated no-label move a no-op.
  (t) => [
    uniqueIndex('profile_products_profile_id_product_id_uniq').on(t.profileId, t.productId).where(sql`${t.productId} IS NOT NULL`),
    uniqueIndex('profile_products_item_id_no_label_uniq').on(t.itemId).where(sql`${t.productId} IS NULL`),
    index('profile_products_profile_id_last_scanned_at_idx').on(t.profileId, t.lastScannedAt),
  ],
)
