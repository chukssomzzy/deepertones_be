import { and, count, desc, eq, gt, gte } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { routineVersions } from './routines.table'

export type RoutineVersionRow = typeof routineVersions.$inferSelect

/** What a build fills a pending row with: everything the pending row did not know yet. `source` is always set once a build is done. */
export type CompletedRoutineBuild = Pick<
  RoutineVersionRow,
  'steps' | 'tapers' | 'expectation' | 'model' | 'promptHash' | 'catalogVersion' | 'routineFingerprint' | 'hintsShown' | 'writerRetryDueAt' | 'writerCalls'
> & { source: NonNullable<RoutineVersionRow['source']> }

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
    return row ?? null
  }

  /** The profile's newest `ready` version (the routine in force), or null. */
  async current(profileId: string): Promise<RoutineVersionRow | null> {
    const [row] = await this.db
      .select()
      .from(routineVersions)
      .where(and(eq(routineVersions.profileId, profileId), eq(routineVersions.status, 'ready')))
      .orderBy(desc(routineVersions.createdAt), desc(routineVersions.id))
      .limit(1)
    return row ?? null
  }

  /** Sets when the version was last returned to the user, changing nothing else of it. A version nobody has is ignored. */
  async markServed(id: string, at: Date): Promise<void> {
    await this.db.update(routineVersions).set({ servedAt: at }).where(eq(routineVersions.id, id))
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
