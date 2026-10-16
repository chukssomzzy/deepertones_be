import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { users } from '../users/users.table'

/**
 * One person's face inside an account. Every user has exactly one default profile, written in the same batch as the
 * user (see D1UsersRepository.createGuestForDevice); the partial unique index is what keeps it to one.
 */
export const profiles = sqliteTable(
  'profiles',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: text('display_name'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('profiles_user_id_default_idx').on(t.userId).where(sql`${t.isDefault} = 1`),
    index('profiles_user_id_idx').on(t.userId),
  ],
)
