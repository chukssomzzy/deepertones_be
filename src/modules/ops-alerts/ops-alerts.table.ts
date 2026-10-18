import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The newest window (its start) an alert of each kind was raised for: ONE row per kind, replaced by a newer window. A kind's alert
 * is queued only by the caller whose guarded upsert advances the window, so many callers in one window make one email.
 */
export const opsAlertClaims = sqliteTable('ops_alert_claims', {
  kind: text('kind').primaryKey(),
  windowStart: integer('window_start', { mode: 'timestamp_ms' }).notNull(),
})
