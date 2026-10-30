import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { profiles } from '../profiles/profiles.table'

// Both tables cascade from `profiles` (a face belongs to a profile, not to an account), so the guest cleanup needs no cleaner of its own. `user_id` on the consent
// is kept as `face_consents` keeps it.

/** One consent per profile to share a before-and-after card of the face photos, kept when it is withdrawn so the app can show that it was. Giving again overwrites the row. */
export const faceShareConsents = sqliteTable(
  'face_share_consents',
  {
    profileId: text('profile_id')
      .primaryKey()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    version: integer('version').notNull(),
    givenAt: integer('given_at', { mode: 'timestamp_ms' }).notNull(),
    withdrawnAt: integer('withdrawn_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('face_share_consents_user_id_idx').on(t.userId)],
)

/**
 * One card a profile shared: which two scans it showed and the consent version it was shared under. Every share is kept. The scan ids are plain text, not
 * foreign keys: deleting a face scan must not erase the record that a card of it was shared. The card itself is never stored.
 */
export const faceShares = sqliteTable(
  'face_shares',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    beforeScanId: text('before_scan_id').notNull(),
    afterScanId: text('after_scan_id').notNull(),
    consentVersion: integer('consent_version').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('face_shares_profile_id_created_at_idx').on(t.profileId, t.createdAt)],
)
