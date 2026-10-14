import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  // A guest is `anonymous`; verifying an email or phone makes the same row `verified`.
  status: text('status', { enum: ['anonymous', 'verified'] }).notNull().default('anonymous'),
  email: text('email').unique(),
  phone: text('phone').unique(),
  tokenVersion: integer('token_version').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
},
(t) => [index('users_status_last_seen_at_idx').on(t.status, t.lastSeenAt)],
)

/** Maps a hashed device id to the device's current guest. The raw device id is never stored. */
export const devices = sqliteTable(
  'devices',
  {
    deviceHash: text('device_hash').primaryKey(),
    platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('devices_user_id_idx').on(t.userId)],
)
