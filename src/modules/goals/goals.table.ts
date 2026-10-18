import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { profiles } from '../profiles/profiles.table'
import { GOALS } from './goals.vocabulary'

/**
 * A profile's goal, as history: every change appends a row and the newest by `created_at` is the current one, read through the
 * (profile_id, created_at) index. `goal` is null for typed words nobody sorted into one of the goals yet. The answer the app shows is
 * not stored: it is worked out from `goal` and `wants_lighter` when read. `answers_version` records which copy version the user
 * saw when they saved. Rows go with their profile (cascade), so guest cleanup needs no cleaner of its own.
 */
export const profileGoals = sqliteTable(
  'profile_goals',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    text: text('text'),
    goal: text('goal', { enum: GOALS }),
    wantsLighter: integer('wants_lighter', { mode: 'boolean' }).notNull(),
    answersVersion: integer('answers_version').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('profile_goals_profile_id_created_at_idx').on(t.profileId, t.createdAt)],
)
