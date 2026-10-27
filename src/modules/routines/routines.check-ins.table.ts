import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { profiles } from '../profiles/profiles.table'
import { CHECK_IN_TIMES } from './routines.check-ins.vocabulary'

/**
 * A profile's check-ins (spec #217): "I did my morning (or evening) routine" for one local day. One row per (profile, day, time), so a repeat is not a second row.
 * `day` is a calendar date, 'YYYY-MM-DD', fixed when the check-in is made: it is the day the person checked in for, so a later change of time zone moves none of them.
 * `at` is when the first check-in for that key was made. Rows go with their profile (cascade), so guest cleanup needs no cleaner of its own.
 */
export const routineCheckIns = sqliteTable(
  'routine_check_ins',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    time: text('time', { enum: CHECK_IN_TIMES }).notNull(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.day, t.time] })],
)
