import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { profiles } from '../profiles/profiles.table'

/**
 * One profile's reminder settings. No row means the defaults (reminders off, 07:00 and 21:00, no zone, both alerts on); the row is written by the
 * first change. Times are 24-hour 'HH:MM' in the profile's own zone, which is an IANA name or null while the phone has not reported one.
 * The row goes with its profile (cascade), so guest cleanup needs no cleaner of its own.
 */
export const reminderSettings = sqliteTable('reminder_settings', {
  profileId: text('profile_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  morning: text('morning').notNull().default('07:00'),
  evening: text('evening').notNull().default('21:00'),
  timeZone: text('time_zone'),
  stepDownAlerts: integer('step_down_alerts', { mode: 'boolean' }).notNull().default(true),
  missedDaysNudge: integer('missed_days_nudge', { mode: 'boolean' }).notNull().default(true),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
