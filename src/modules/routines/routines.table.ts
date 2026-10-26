import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { GOALS } from '../goals/goals.vocabulary'
import { profiles } from '../profiles/profiles.table'
import type { CautionState, StoredRoutineStep, StoredTaper } from './routines.types'

/**
 * A profile's routine versions (spec #189): one row per build. A build appends a `pending` row, which is filled in once, to `ready`, when the build is done
 * (a build that needs no pending phase may append a `ready` row). A ready row is never changed again, except `served_at`, `started_on` (and the dates of its
 * `tapers`, set with it) and `writer_retry_due_at` (cleared when a retry finds nothing to rewrite). The `ready` row that became ready last (`ready_at`, the time
 * a row was appended ready or completed, not when its build began) is the profile's routine in force; a newer `pending` row is a build asked for and not
 * done. Rows go with their profile (cascade).
 *
 * The routine is `steps` (the stored step list, with grounding kept here and never served), `tapers` (each with the day its step-down began, null until the
 * routine is started) and `expectation`: `[]`, `[]` and null while pending. `cautions` are the skeleton's cautions the build was made under (null while
 * pending): a later read compares them with the person's current safety answers. `goal` is the goal it was built for (null while pending, and on a row
 * written before the column existed), so a rebuild knows whether the goal has changed. `started_on` is when the routine was started, carried forward by later
 * builds; `served_at` is when this version was last returned to the user.
 *
 * The rest records the build. `source` is who wrote the words (`writer`, or the `rules` alone), null while pending, and `reason` why it was built. `model` and
 * `prompt_hash` name the writer when it was called, even if every try failed and the rules wrote the routine, and are null when it was not called. A got-it copy is the one exception: it keeps the source, model and prompt hash of the version it copies, with
 * `writer_calls` 0. `rules_version`, `catalog_version`, `verdict_fingerprint` and `routine_fingerprint` say what it was built from and what it
 * came out as, and `hints_shown` whether the writer saw outcome hints. `writer_calls` is how many writer calls the build made (0 to 3), which the daily limit
 * counts. `writer_retry_due_at` is when a rules-built version is due another try by the writer, or null.
 */
export const routineVersions = sqliteTable(
  'routine_versions',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['pending', 'ready'] }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    steps: text('steps', { mode: 'json' }).$type<StoredRoutineStep[]>().notNull(),
    tapers: text('tapers', { mode: 'json' }).$type<StoredTaper[]>().notNull(),
    expectation: text('expectation'),
    cautions: text('cautions', { mode: 'json' }).$type<CautionState[]>(),
    goal: text('goal', { enum: GOALS }),
    readyAt: integer('ready_at', { mode: 'timestamp_ms' }),
    startedOn: integer('started_on', { mode: 'timestamp_ms' }),
    servedAt: integer('served_at', { mode: 'timestamp_ms' }),
    model: text('model'),
    promptHash: text('prompt_hash'),
    catalogVersion: integer('catalog_version'),
    rulesVersion: text('rules_version').notNull(),
    hintsShown: integer('hints_shown', { mode: 'boolean' }).notNull(),
    verdictFingerprint: text('verdict_fingerprint').notNull(),
    routineFingerprint: text('routine_fingerprint'),
    source: text('source', { enum: ['writer', 'rules'] }),
    reason: text('reason', {
      enum: ['first', 'shelf', 'goal', 'safety', 'verdict', 'review-point', 'catalog-retired', 'sold-here', 'got-it', 'writer-retry'],
    }).notNull(),
    writerRetryDueAt: integer('writer_retry_due_at', { mode: 'timestamp_ms' }),
    writerCalls: integer('writer_calls').notNull().default(0),
  },
  (t) => [
    // "The newest version of a profile", and the daily count of builds that called the writer.
    index('routine_versions_profile_created_idx').on(t.profileId, t.createdAt),
    // The writer-retry sweep's lookup (PR 3): only the rows with a retry due, a small set, by due time.
    index('routine_versions_writer_retry_due_idx').on(t.writerRetryDueAt).where(sql`${t.writerRetryDueAt} IS NOT NULL`),
  ],
)
