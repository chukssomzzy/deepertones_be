import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { GOALS } from '../goals/goals.vocabulary'
import { profiles } from '../profiles/profiles.table'
import type { CautionState, StoredRoutineStep, StoredTaper } from './routines.types'

/** How a build sorted the shelf it was made from: each product in exactly one count. A reduced sunscreen counts as `keep`, as the routine keeps it. */
export type ShelfCounts = { keep: number; reduce: number; drop: number; stop: number }

/**
 * A profile's routine versions (spec #189): one row per build. A build appends a `pending` row, which is filled in once, to `ready`, when the build is done
 * (a build that needs no pending phase may append a `ready` row). A ready row is never changed again, except `served_at`, `started_on` (and the dates of its
 * `tapers`, set with it), `writer_retry_due_at` (cleared when a retry finds nothing to rewrite) and `routine_fingerprint` and `shelf_counts` (set when a rebuild finds nothing
 * to change in the routine, so the routine in force records the inputs it was last checked against and the shelf as it sorts under them). The `ready` row that became ready last (`ready_at`, the time
 * a row was appended ready or completed, not when its build began) is the profile's routine in force; a newer `pending` row is a build asked for and not
 * done. Rows go with their profile (cascade).
 *
 * The routine is `steps` (the stored step list, with grounding kept here and never served), `tapers` (each with the day its step-down began, null until the
 * routine is started) and `expectation`: `[]`, `[]` and null while pending. `cautions` are the skeleton's cautions the build was made under (null while
 * pending): a later read compares them with the person's current safety answers. `goal` is the goal it was built for (null while pending, and on a row
 * written before the column existed), so a rebuild knows whether the goal has changed. `started_on` is day 1 of the routine: the UTC midnight after the person tapped Start (the first step is the morning after the tap), carried forward by later
 * builds; `served_at` is when this version was last returned to the user. `shelf_counts` is how the build sorted the shelf (`keep`, `reduce`, `drop`, `stop`;
 * null while pending, and on a row written before the column until a rebuild fills it in): the plan summary shows it, so it is fixed at build time and matches the routine beside it.
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
    shelfCounts: text('shelf_counts', { mode: 'json' }).$type<ShelfCounts>(),
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

/**
 * A profile's routine build request (spec #189), ONE row per profile: the claim that keeps the same request from being queued twice, and the state of the
 * dead-letter retry. `request_key` is what the request was for (a routine fingerprint, `first`, `review-point:<scanId>`, `writer-retry:<versionId>` or `catalog-retired:<versionId>`; the dead-letter sweep reads the reason back from this prefix) and `requested_at`
 * when it was claimed: a claim older than the stale cut-off is a build that died and is taken over, and a released claim has its time moved to the epoch.
 * `retry_due_at` is when the one more try after a dead letter is due (null when none is) and `retried` whether it has been given. A new claim resets both.
 * Rows go with their profile (cascade).
 */
export const routineRequests = sqliteTable(
  'routine_requests',
  {
    profileId: text('profile_id')
      .primaryKey()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    requestKey: text('request_key').notNull(),
    requestedAt: integer('requested_at', { mode: 'timestamp_ms' }).notNull(),
    retryDueAt: integer('retry_due_at', { mode: 'timestamp_ms' }),
    retried: integer('retried', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    // The dead-letter retry sweep's lookup (PR 3c): only the rows with a retry due, a small set, by due time.
    index('routine_requests_retry_due_idx').on(t.retryDueAt).where(sql`${t.retryDueAt} IS NOT NULL`),
  ],
)
