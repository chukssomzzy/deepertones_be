import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { profiles } from '../profiles/profiles.table'
import { users } from '../users/users.table'

/**
 * One row per phone: the Expo push token it registered, and the account and profile it is on. The key is the same keyed hash of
 * the device id the `devices` table uses, so a phone is one row however often it re-registers. A token lives in one row only.
 * Rows go with their user or profile (cascade), so guest cleanup needs no cleaner of its own.
 */
export const pushTokens = sqliteTable(
  'push_tokens',
  {
    deviceHash: text('device_hash').primaryKey(),
    token: text('token').notNull().unique(),
    platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('push_tokens_user_id_idx').on(t.userId), index('push_tokens_profile_id_idx').on(t.profileId)],
)

/** An account's two scan notification switches. No row means both are on; the row is written by the first change. */
export const notificationSettings = sqliteTable('notification_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  scanFinished: integer('scan_finished', { mode: 'boolean' }).notNull().default(true),
  scanNeedsYou: integer('scan_needs_you', { mode: 'boolean' }).notNull().default(true),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
