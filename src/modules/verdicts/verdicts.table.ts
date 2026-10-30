import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { profiles } from '../profiles/profiles.table'
import type { ShelfVerdict } from '../routines/routines.types'
import type { VerdictGroup } from './verdicts.merge'
import type { SavedVerdictProduct, VerdictProvenance } from './verdicts.types'

/**
 * A profile's saved shelf verdict (spec #171), ONE row per profile. `status` is `pending` from the request until a build is saved, then `ready`; a rebuild
 * sets it back to `pending` and leaves the previous build in place, so the last verdict can still be shown. `fingerprint` hashes what the verdict was
 * built from (a different one means the row is stale) and `requested_at` is when the pending request was made (one older than the stale cut-off is taken over).
 *
 * The build columns (`fit`, `products`, `built_at`, `rules_version`, `catalog_version`, `model`, `prompt_hash`, `inputs`) are null, or `[]` for `products`,
 * until the first build is saved. `fit` is `not-ready` when the judge could not answer and the open products are undecided. `inputs` is the provenance: ids,
 * codes and bands, never the words the user typed. `products` does hold a reaction ingredient in the user's own word (in its reason and its fact), because
 * the screen names it; the same word is already stored with the safety answers.
 *
 * `fit_attempts`, `fit_retried` and `fit_retry_due_at` are the state of the fit judge's retries for a `not-ready` verdict: when the next try is due (null
 * when none is), and whether the one more try after the dead letter has been given. A new request resets them. Rows go with their profile (cascade).
 */
export const shelfVerdicts = sqliteTable(
  'shelf_verdicts',
  {
    profileId: text('profile_id')
      .primaryKey()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['pending', 'ready'] }).notNull(),
    fingerprint: text('fingerprint').notNull(),
    requestedAt: integer('requested_at', { mode: 'timestamp_ms' }).notNull(),
    fit: text('fit', { enum: ['ready', 'not-ready'] }),
    products: text('products', { mode: 'json' }).$type<SavedVerdictProduct[]>().notNull(),
    builtAt: integer('built_at', { mode: 'timestamp_ms' }),
    rulesVersion: text('rules_version'),
    catalogVersion: integer('catalog_version'),
    model: text('model'),
    promptHash: text('prompt_hash'),
    inputs: text('inputs', { mode: 'json' }).$type<VerdictProvenance>(),
    fitAttempts: integer('fit_attempts').notNull().default(0),
    fitRetried: integer('fit_retried', { mode: 'boolean' }).notNull().default(false),
    fitRetryDueAt: integer('fit_retry_due_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    // The retry sweep's lookup: only the rows with a retry due, a small set, by due time.
    index('shelf_verdicts_fit_retry_due_idx').on(t.fitRetryDueAt).where(sql`${t.fitRetryDueAt} IS NOT NULL`),
  ],
)

/**
 * What a person told the team about a shelf verdict (spec #259). Nothing in the product reads these rows: the team reads the table, and a report never changes a verdict.
 * A `mistake` is a person saying a product's verdict looks wrong: `group`, `verdict` (the internal verdict action, with the step-down's template id) and `fingerprint` are what they
 * were shown, so it can be reproduced; `basis` is for what the verdict was built on and is null until that is stored. A repeat for the same entry and fingerprint updates the one row
 * (its `note` and `updated_at`), which a partial unique index over `kind = 'mistake'` holds; a rebuilt verdict has another fingerprint and so a new report. A `wrong-match` is
 * written when a person swaps the product their shelf entry was matched to: `old_product_id` and `new_product_id`, and none of the mistake columns; any number may exist.
 * `note` is private to the person and the team: it is never logged and never sent anywhere. `entry_id` is a plain column, not a key, so a report outlives its entry.
 * Rows go with their profile (cascade).
 */
export const verdictReports = sqliteTable(
  'verdict_reports',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    entryId: text('entry_id').notNull(),
    kind: text('kind', { enum: ['mistake', 'wrong-match'] }).notNull(),
    group: text('group').$type<VerdictGroup>(),
    verdict: text('verdict', { mode: 'json' }).$type<ShelfVerdict>(),
    basis: text('basis', { mode: 'json' }).$type<Record<string, unknown>>(),
    fingerprint: text('fingerprint'),
    note: text('note'),
    oldProductId: text('old_product_id'),
    newProductId: text('new_product_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('verdict_reports_mistake_unique').on(t.profileId, t.entryId, t.fingerprint).where(sql`${t.kind} = 'mistake'`)],
)
