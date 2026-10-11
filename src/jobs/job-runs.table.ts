import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const jobRuns = sqliteTable(
  'job_runs',
  {
    job: text('job').notNull(),
    key: text('key').notNull(),
    status: text('status', { enum: ['running', 'done', 'failed'] }).notNull(),
    leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  // updated_at serves the dispatcher's purge.
  (t) => [primaryKey({ columns: [t.job, t.key] }), index('job_runs_updated_at_idx').on(t.updatedAt)],
)
