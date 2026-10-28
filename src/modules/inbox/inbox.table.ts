import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { profiles } from '../profiles/profiles.table'

/**
 * What the routine tells a profile about itself (spec #233): one row per event, in the app's inbox and, where the reminder gating allows, as a push. Rows are kept for good and
 * go only with their profile (cascade), so guest cleanup needs no cleaner of its own. `kind` is free text, like `reminder_sends.kind`, so a new event needs no migration.
 * `local_day` is the profile's calendar day 'YYYY-MM-DD' the row is about. `key` makes a write idempotent per profile ('reminder:2030-06-15:07:00'); the API never shows it.
 * `link` is an in-app path the app opens. `read_at` is null until the profile has seen the row.
 */
export const inboxItems = sqliteTable(
  'inbox_items',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    localDay: text('local_day').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    link: text('link').notNull(),
    key: text('key').notNull(),
    readAt: integer('read_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('inbox_items_profile_key_unique').on(t.profileId, t.key), index('inbox_items_profile_created_idx').on(t.profileId, sql`${t.createdAt} desc`)],
)
