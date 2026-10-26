import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { SkinTypeLabel } from '../face-scans/face-scans.tables'
import type { Goal } from '../goals/goals.vocabulary'

/**
 * What happened to users who had a product in their routine at the review point (spec #189, #152): one row per goal, skin type, shopping country and catalog
 * product code, with the five counts `OutcomeCounts` describes. `skin_type` is '' for users with no face scan (never null, so it can be part of the key).
 * No foreign keys: the counts are about groups, not accounts or profiles. Nothing writes it yet; a later collector will.
 */
export const routineOutcomeCounts = sqliteTable(
  'routine_outcome_counts',
  {
    goal: text('goal').$type<Goal>().notNull(),
    skinType: text('skin_type').$type<SkinTypeLabel | ''>().notNull().default(''),
    country: text('country').notNull(),
    code: text('code').notNull(),
    n: integer('n').notNull().default(0),
    fainter: integer('fainter').notNull().default(0),
    flared: integer('flared').notNull().default(0),
    flaredOrStopped: integer('flared_or_stopped').notNull().default(0),
    fainterAndFlaredOrStopped: integer('fainter_and_flared_or_stopped').notNull().default(0),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.goal, t.skinType, t.country, t.code] })],
)
