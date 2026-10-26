import { and, count, desc, eq, gt, gte, isNotNull, isNull, ne } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { routineVersions } from './routines.table'

export type RoutineVersionRow = typeof routineVersions.$inferSelect

/** What a build fills a pending row with: everything the pending row did not know yet. `source` is always set once a build is done. */
export type CompletedRoutineBuild = Pick<
  RoutineVersionRow,
  'steps' | 'tapers' | 'expectation' | 'cautions' | 'goal' | 'model' | 'promptHash' | 'catalogVersion' | 'routineFingerprint' | 'hintsShown' | 'writerRetryDueAt' | 'writerCalls'
> & { source: NonNullable<RoutineVersionRow['source']> }

// A JSON column keeps a step-down's start date as text, so every row read turns it back into a Date.
const revived = (row: RoutineVersionRow): RoutineVersionRow => ({
  ...row,
  tapers: row.tapers.map((taper) => ({ ...taper, startedOn: taper.startedOn === null ? null : new Date(taper.startedOn) })),
})

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

  /** The profile's newest `ready` version (the routine in force), or null. */
  async current(profileId: string): Promise<RoutineVersionRow | null> {
    const [row] = await this.db
      .select()
      .from(routineVersions)
      .where(and(eq(routineVersions.profileId, profileId), eq(routineVersions.status, 'ready')))
      .orderBy(desc(routineVersions.createdAt), desc(routineVersions.id))
      .limit(1)
    return row ? revived(row) : null
  }

  /** The profile's newest `ready` version that was served, apart from the one named (every served version but that one, not "older than it"), or null. */
  async lastServedBefore(profileId: string, excludeId: string): Promise<RoutineVersionRow | null> {
    const [row] = await this.db
      .select()
      .from(routineVersions)
      .where(and(eq(routineVersions.profileId, profileId), eq(routineVersions.status, 'ready'), isNotNull(routineVersions.servedAt), ne(routineVersions.id, excludeId)))
      .orderBy(desc(routineVersions.createdAt), desc(routineVersions.id))
      .limit(1)
    return row ? revived(row) : null
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
}

// The D1 class is the source of truth; services and fakes use this type.
export type RoutinesRepository = PublicOf<D1RoutinesRepository>
