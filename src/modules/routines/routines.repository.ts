import { and, asc, count, desc, eq, gt, gte, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { routineRequests, routineVersions } from './routines.table'

export type RoutineVersionRow = typeof routineVersions.$inferSelect

export type RoutineRequestRow = typeof routineRequests.$inferSelect

/** The dead-letter retry of one profile's build request. */
export type RoutineRequestRetry = Pick<RoutineRequestRow, 'retried' | 'retryDueAt'>

/** What a build fills a pending row with: everything the pending row did not know yet. `source` is always set once a build is done. */
export type CompletedRoutineBuild = Pick<
  RoutineVersionRow,
  'steps' | 'tapers' | 'expectation' | 'cautions' | 'goal' | 'model' | 'promptHash' | 'catalogVersion' | 'routineFingerprint' | 'hintsShown' | 'writerRetryDueAt' | 'writerCalls'
> & { source: NonNullable<RoutineVersionRow['source']>; readyAt: Date }

// A JSON column keeps a step-down's start date as text, so every row read turns it back into a Date.
const revived = (row: RoutineVersionRow): RoutineVersionRow => ({
  ...row,
  tapers: row.tapers.map((taper) => ({ ...taper, startedOn: taper.startedOn === null ? null : new Date(taper.startedOn) })),
})

// A version no other ready version of its profile has replaced: the profile's routine in force, in `readyOrder`. Raw SQL, because the subquery names the outer row
// (`routine_versions`) and drizzle leaves the table off a column of a single-table select.
const inForce = sql`not exists (
  select 1 from routine_versions newer
  where newer.profile_id = routine_versions.profile_id and newer.status = 'ready'
    and (coalesce(newer.ready_at, newer.created_at) > coalesce(routine_versions.ready_at, routine_versions.created_at)
      or (coalesce(newer.ready_at, newer.created_at) = coalesce(routine_versions.ready_at, routine_versions.created_at) and newer.id > routine_versions.id)))`

// The order ready versions are in force: the one that became ready last. A row with no `ready_at` counts from its creation.
const readyOrder = [desc(sql`coalesce(${routineVersions.readyAt}, ${routineVersions.createdAt})`), desc(routineVersions.id)] as const

export class D1RoutinesRepository {
  constructor(private readonly db: Db) {}

  /** Stores a new version, `pending` or already `ready`. Rows are never replaced: an id already used, or a profile that does not exist, rejects. */
  async append(row: RoutineVersionRow): Promise<void> {
    await this.db.insert(routineVersions).values(row)
  }

  /** The profile's newest version, whatever its status, or null. Newest is the latest creation time, then the larger id. */
  async latest(profileId: string): Promise<RoutineVersionRow | null> {
    const [row] = await this.db
      .select()
      .from(routineVersions)
      .where(eq(routineVersions.profileId, profileId))
      .orderBy(desc(routineVersions.createdAt), desc(routineVersions.id))
      .limit(1)
    return row ? revived(row) : null
  }

  /** The profile's `ready` version that became ready last (the routine in force), or null. */
  async current(profileId: string): Promise<RoutineVersionRow | null> {
    const [row] = await this.db
      .select()
      .from(routineVersions)
      .where(and(eq(routineVersions.profileId, profileId), eq(routineVersions.status, 'ready')))
      .orderBy(...readyOrder)
      .limit(1)
    return row ? revived(row) : null
  }

  /** The profile's newest `ready` version that was served, apart from the one named (every served version but that one, not "older than it"), or null. */
  async lastServedBefore(profileId: string, excludeId: string): Promise<RoutineVersionRow | null> {
    const [row] = await this.db
      .select()
      .from(routineVersions)
      .where(and(eq(routineVersions.profileId, profileId), eq(routineVersions.status, 'ready'), isNotNull(routineVersions.servedAt), ne(routineVersions.id, excludeId)))
      .orderBy(...readyOrder)
      .limit(1)
    return row ? revived(row) : null
  }

  /** Clears when the version was due another try by the writer, changing nothing else of it. A version nobody has is ignored. */
  async clearWriterRetry(id: string): Promise<void> {
    await this.db.update(routineVersions).set({ writerRetryDueAt: null }).where(eq(routineVersions.id, id))
  }

  /** Sets when the version was last returned to the user, changing nothing else of it. A version nobody has is ignored. */
  async markServed(id: string, at: Date): Promise<void> {
    await this.db.update(routineVersions).set({ servedAt: at }).where(eq(routineVersions.id, id))
  }

  /**
   * Starts every version of the profile that has no start date (a pending one too, so a build under way carries it) on `on`, and dates the step-downs of those
   * versions that have no date yet the same day. A start date already set is never moved, so asking again changes nothing.
   */
  async markStarted(profileId: string, on: Date): Promise<void> {
    const rows = await this.db
      .select({ id: routineVersions.id, tapers: routineVersions.tapers })
      .from(routineVersions)
      .where(and(eq(routineVersions.profileId, profileId), isNull(routineVersions.startedOn)))
    if (rows.length === 0) return
    const statements: BatchItem<'sqlite'>[] = rows.map(({ id, tapers }) =>
      this.db
        .update(routineVersions)
        .set({ startedOn: on, tapers: tapers.map((taper) => ({ ...taper, startedOn: taper.startedOn === null ? on : new Date(taper.startedOn) })) })
        .where(and(eq(routineVersions.id, id), isNull(routineVersions.startedOn))),
    )
    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  }

  /**
   * Fills a pending version with its finished build, making it `ready`, and says whether it did. It does so once: an unknown id, or a version that is
   * already `ready`, returns false and is left as it was.
   */
  async complete(id: string, built: CompletedRoutineBuild): Promise<boolean> {
    const updated = await this.db
      .update(routineVersions)
      .set({ ...built, status: 'ready' })
      .where(and(eq(routineVersions.id, id), eq(routineVersions.status, 'pending')))
      .returning({ id: routineVersions.id })
    return updated.length > 0
  }

  /** How many of the profile's versions were created at `since` or later and made writer calls (whatever their source, status or reason): the daily limit's count. */
  async writerBuildsSince(profileId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ builds: count() })
      .from(routineVersions)
      .where(and(eq(routineVersions.profileId, profileId), gt(routineVersions.writerCalls, 0), gte(routineVersions.createdAt, since)))
    return row?.builds ?? 0
  }

  /**
   * Claims a build request for the profile: a new row, or one whose claim is `staleBefore` or older (its build died or was released), taken over with the key
   * and time rewritten and the dead-letter retry reset. One statement, so parallel claims cannot both win. False when nothing was claimed: a claim still fresh,
   * whatever its key. Rejects a profile that does not exist.
   */
  async claim(profileId: string, key: string, now: Date, staleBefore: Date): Promise<boolean> {
    const claimed = await this.db
      .insert(routineRequests)
      .values({ profileId, requestKey: key, requestedAt: now })
      .onConflictDoUpdate({
        target: routineRequests.profileId,
        set: { requestKey: key, requestedAt: now, retried: false, retryDueAt: null },
        // <=, not <: a claim made exactly at the cut-off is already stale.
        setWhere: lte(routineRequests.requestedAt, staleBefore),
      })
      .returning({ profileId: routineRequests.profileId })
    return claimed.length === 1
  }

  /**
   * Gives back the claim made at exactly `requestedAt`: its time moves to the epoch, so the next `claim` finds it stale and wins at once. One statement; a claim
   * taken since by another request and a missing row are left alone, and the dead-letter retry is kept.
   */
  async release(profileId: string, requestedAt: Date): Promise<void> {
    await this.db
      .update(routineRequests)
      .set({ requestedAt: new Date(0) })
      .where(and(eq(routineRequests.profileId, profileId), eq(routineRequests.requestedAt, requestedAt)))
  }

  /** The profile's build request, or null when it never asked for one. */
  async findRequest(profileId: string): Promise<RoutineRequestRow | null> {
    const [row] = await this.db.select().from(routineRequests).where(eq(routineRequests.profileId, profileId)).limit(1)
    return row ?? null
  }

  /** Sets the two dead-letter retry columns, changing nothing else of the request. A profile with no request is ignored, never created. */
  async setRequestRetry(profileId: string, { retried, retryDueAt }: RoutineRequestRetry): Promise<void> {
    await this.db.update(routineRequests).set({ retried, retryDueAt }).where(eq(routineRequests.profileId, profileId))
  }

  /** The requests whose dead-letter retry is due at `now` or earlier, the longest overdue first, at most `limit`. A request with no retry due is never returned. */
  async dueRequests(now: Date, limit: number): Promise<RoutineRequestRow[]> {
    return this.db
      .select()
      .from(routineRequests)
      .where(and(isNotNull(routineRequests.retryDueAt), lte(routineRequests.retryDueAt, now)))
      .orderBy(asc(routineRequests.retryDueAt), asc(routineRequests.profileId))
      .limit(limit)
  }

  /** The routine in force of each profile whose writer retry is due at `now` or earlier, the longest overdue first, at most `limit`. A version a newer ready one replaced is never returned. */
  async writerRetriesDue(now: Date, limit: number): Promise<RoutineVersionRow[]> {
    const rows = await this.db
      .select()
      .from(routineVersions)
      .where(and(eq(routineVersions.status, 'ready'), isNotNull(routineVersions.writerRetryDueAt), lte(routineVersions.writerRetryDueAt, now), inForce))
      .orderBy(asc(routineVersions.writerRetryDueAt), asc(routineVersions.id))
      .limit(limit)
    return rows.map(revived)
  }

  /**
   * The routine in force of each profile that recommends a product the catalog retired after the version was built: one of its steps holds a recommended product
   * (`json_each` over `steps`) whose `recommended_products` row is `retired` in a catalog version later than the version's own. Each version once, at most `limit`.
   */
  async retiredCodeVersions(limit: number): Promise<RoutineVersionRow[]> {
    const rows = await this.db
      .select()
      .from(routineVersions)
      .where(
        and(
          eq(routineVersions.status, 'ready'),
          inForce,
          sql`exists (
            select 1 from json_each(routine_versions.steps) step
            join recommended_products retired on retired.code = json_extract(step.value, '$.product.code')
            where json_extract(step.value, '$.product.kind') = 'candidate' and retired.status = 'retired' and retired.updated_in_version > routine_versions.catalog_version)`,
        ),
      )
      .limit(limit)
    return rows.map(revived)
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type RoutinesRepository = PublicOf<D1RoutinesRepository>
