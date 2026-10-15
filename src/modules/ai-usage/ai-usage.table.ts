import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * One row per request to the AI API, in the life of its reservation: `reserved` (money set aside at the worst case),
 * then `settled` (what it really cost) or `released` (nothing was billed). The usage columns are null until settled.
 */
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: text('id').primaryKey(),
    job: text('job').notNull(),
    model: text('model').notNull(),
    status: text('status', { enum: ['reserved', 'settled', 'released'] }).notNull(),
    estimateMicros: integer('estimate_micros').notNull(),
    costMicros: integer('cost_micros'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    webSearches: integer('web_searches'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    settledAt: integer('settled_at', { mode: 'timestamp_ms' }),
  },
  // The day's total and the cost report both read a range of created_at.
  (t) => [index('ai_usage_created_at_idx').on(t.createdAt)],
)
