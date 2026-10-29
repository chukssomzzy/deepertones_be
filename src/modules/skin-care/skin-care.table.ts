import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { EscalationReason, IngredientGroup, RoutineStep } from '../catalog/catalog.vocabulary'
import { profiles } from '../profiles/profiles.table'
import type { SkinOutcome } from './skin-care.outcomes'
import type { HoldCloseHow, HowBad, Noticing, PauseState, SkinCareProductRef, Where } from './skin-care.vocabulary'

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

/**
 * A pause on one step of the routine (spec #233). `product_key` is what the pause is for: the catalog product id of the step's product, else the id of the shelf entry (a product
 * with no label has no catalog product), so a pause outlives the product's move from a recommendation to the person's own shelf. The "nothing to pause" check-in is a row with no
 * step, `product_key` '' and no product. `ingredient_group` is the active group frozen when the pause was made (the ladder to bring the step back on is chosen by it).
 * `paused_on` and `check_day` are calendar dates ('YYYY-MM-DD'), fixed when set, so a later change of time zone moves none of them. `source_log_id` is the log that caused
 * the pause, kept as plain text (not a key). `ladder_*` are filled when the step is brought back, and `version_id` is the routine version the pause was last checked against.
 * A step has at most one open pause for a product (`paused` or `bringing-back`), and a profile at most one open pause with no step: two partial unique indexes (an index over
 * COALESCE(step, '') would do both in one, but drizzle-kit cannot write an index expression with a comma). Rows go with their profile (cascade).
 */
export const stepPauses = sqliteTable(
  'step_pauses',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    step: text('step').$type<RoutineStep>(),
    productKey: text('product_key').notNull(),
    productId: text('product_id'),
    productRef: text('product_ref', { mode: 'json' }).$type<SkinCareProductRef>().notNull(),
    ingredientGroup: text('ingredient_group').$type<IngredientGroup>(),
    state: text('state').$type<PauseState>().notNull(),
    pausedOn: text('paused_on').notNull(),
    checkDay: text('check_day').notNull(),
    sameCount: integer('same_count').notNull(),
    sourceLogId: text('source_log_id'),
    ladderCode: text('ladder_code'),
    ladderStartedOn: text('ladder_started_on'),
    versionId: text('version_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('step_pauses_open_step_product_unique').on(t.profileId, t.step, t.productKey).where(sql`${t.step} IS NOT NULL AND ${t.state} IN ('paused', 'bringing-back')`),
    uniqueIndex('step_pauses_open_stepless_unique').on(t.profileId).where(sql`${t.step} IS NULL AND ${t.state} IN ('paused', 'bringing-back')`),
    index('step_pauses_profile_created_idx').on(t.profileId, t.createdAt),
  ],
)

/**
 * An escalation hold (spec #233): a professional outcome keeps the active steps out of the routine until the person closes it. A profile has at most one open hold (a partial unique
 * index over `profile_id` where `closed_at` is null), so opening is idempotent; closed holds stay as history. `opened_on` is the person's local calendar day ('YYYY-MM-DD'), fixed when
 * the hold is opened. `source_log_id` is the log that caused it, kept as plain text (not a key). Rows go with their profile (cascade).
 */
export const escalationHolds = sqliteTable(
  'escalation_holds',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    reason: text('reason').$type<EscalationReason>().notNull(),
    sourceLogId: text('source_log_id'),
    openedOn: text('opened_on').notNull(),
    openedAt: integer('opened_at', { mode: 'timestamp_ms' }).notNull(),
    closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
    closedHow: text('closed_how').$type<HoldCloseHow>(),
  },
  (t) => [uniqueIndex('escalation_holds_open_profile_unique').on(t.profileId).where(sql`${t.closedAt} IS NULL`)],
)
