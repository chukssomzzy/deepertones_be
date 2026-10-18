import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { profiles } from '../profiles/profiles.table'
import type { SafetyChoice } from './safety.vocabulary'

/**
 * A profile's safety answers, as history: every change appends a row and the newest by `created_at` is the current one, read through the
 * (profile_id, created_at) index. `choices` is a JSON array of the ticked choices in the vocabulary's order. The two texts are what the user
 * typed beside "a product gave me a reaction" and "I use a prescription", trimmed, and null when nothing was typed. They are personal, so
 * they never reach a log. Rows go with their profile (cascade), so guest cleanup needs no cleaner of its own.
 */
export const profileSafety = sqliteTable(
  'profile_safety',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    choices: text('choices', { mode: 'json' }).$type<SafetyChoice[]>().notNull(),
    reactionText: text('reaction_text'),
    prescriptionText: text('prescription_text'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('profile_safety_profile_id_created_at_idx').on(t.profileId, t.createdAt)],
)
