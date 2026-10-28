import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { EscalationReason } from '../catalog/catalog.vocabulary'
import { profiles } from '../profiles/profiles.table'
import type { SkinOutcome } from './skin-care.outcomes'
import type { HowBad, Noticing, Where } from './skin-care.vocabulary'

/**
 * A profile's skin logs (spec #233): what they noticed, where, how bad, and an optional note. The note is only stored and shown back on the professional screen; no rule reads it.
 * `local_day` is a calendar date ('YYYY-MM-DD'), fixed when the log is made, so a later change of time zone moves none of them. `outcome` is the kind the fixed rules came to
 * and `reason` is set only for a professional one; `rules_version` is the version of those rules. `overridden` is set when the person undoes the pause the log caused: the log stays.
 * The two lists keep the order given. Rows go with their profile (cascade), so guest cleanup needs no cleaner of its own.
 */
export const skinLogs = sqliteTable(
  'skin_logs',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    noticing: text('noticing', { mode: 'json' }).$type<Noticing[]>().notNull(),
    where: text('where', { mode: 'json' }).$type<Where[]>().notNull(),
    howBad: text('how_bad').$type<HowBad>(),
    note: text('note'),
    localDay: text('local_day').notNull(),
    outcome: text('outcome').$type<SkinOutcome['kind']>().notNull(),
    reason: text('reason').$type<EscalationReason>(),
    rulesVersion: integer('rules_version').notNull(),
    overridden: integer('overridden', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('skin_logs_profile_created_idx').on(t.profileId, t.createdAt)],
)
