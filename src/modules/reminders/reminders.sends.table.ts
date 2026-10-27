import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { profiles } from '../profiles/profiles.table'

/**
 * The reminders the send job has claimed (spec #217): one row per (profile, local day, kind), written before the push is queued, so a run that repeats or overlaps
 * another sends nothing twice. `local_day` is the profile's calendar day 'YYYY-MM-DD' when the reminder was due. `kind` is free text, not an enum ('morning' and
 * 'evening' today), so the step-down alert and the missed-days nudge can add theirs without a migration. `sent_at` is when the claim was made. Rows go with their
 * profile (cascade), so guest cleanup needs no cleaner of its own.
 */
export const reminderSends = sqliteTable(
  'reminder_sends',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    localDay: text('local_day').notNull(),
    kind: text('kind').notNull(),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.localDay, t.kind] })],
)
