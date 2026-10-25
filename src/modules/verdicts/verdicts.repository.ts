import { and, asc, eq, lte, ne, or, sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { shelfVerdicts } from './verdicts.table'

export type ShelfVerdictRow = typeof shelfVerdicts.$inferSelect

/** What a build saves: every column of the row but its profile, its status and when it was requested. A saved row is always ready. */
export type SavedVerdict = Omit<ShelfVerdictRow, 'profileId' | 'status' | 'requestedAt' | 'fit' | 'builtAt' | 'inputs'> & {
  [K in 'fit' | 'builtAt' | 'inputs']: NonNullable<ShelfVerdictRow[K]>
}

/** The state of the fit judge's retries for one row. */
export type FitState = Pick<ShelfVerdictRow, 'fitAttempts' | 'fitRetried' | 'fitRetryDueAt'>

export class D1VerdictsRepository {
  constructor(private readonly db: Db) {}

  /** The profile's saved verdict, or null when it never asked for one. */
  async find(profileId: string): Promise<ShelfVerdictRow | null> {
    const [row] = await this.db.select().from(shelfVerdicts).where(eq(shelfVerdicts.profileId, profileId)).limit(1)
    return row ?? null
  }

  /**
   * Claims a build of `fingerprint` for the profile: a new row, a ready row built from something else, or a pending row whose request is `staleBefore` or older
   * (its build died). One statement, so parallel requests cannot both win. The row becomes pending with this fingerprint and time and its fit retries reset;
   * the previous build stays. False when nothing was claimed: a ready row with the same fingerprint, or a pending request still fresh. Rejects a profile that
   * does not exist.
   */
  async requestBuild(profileId: string, fingerprint: string, now: Date, staleBefore: Date): Promise<boolean> {
    const claimed = await this.db
      .insert(shelfVerdicts)
      .values({ profileId, status: 'pending', fingerprint, requestedAt: now, products: [] })
      .onConflictDoUpdate({
        target: shelfVerdicts.profileId,
        set: { status: 'pending', fingerprint, requestedAt: now, fitAttempts: 0, fitRetried: false, fitRetryDueAt: null },
        // <=, not <: a request made exactly at the cut-off is already stale.
        setWhere: or(
          and(eq(shelfVerdicts.status, 'ready'), ne(shelfVerdicts.fingerprint, fingerprint)),
          and(eq(shelfVerdicts.status, 'pending'), lte(shelfVerdicts.requestedAt, staleBefore)),
        ),
      })
      .returning({ profileId: shelfVerdicts.profileId })
    return claimed.length === 1
  }

  /**
   * Gives back the claim made at exactly `requestedAt` (the build it claimed could not be queued): the pending row's request moves to the epoch, so the next
   * `requestBuild` finds it stale and claims at once. One statement; a row claimed since by another request, a ready row and a missing row are left alone.
   */
  async releaseClaim(profileId: string, requestedAt: Date): Promise<void> {
    await this.db
      .update(shelfVerdicts)
      .set({ requestedAt: new Date(0) })
      .where(and(eq(shelfVerdicts.profileId, profileId), eq(shelfVerdicts.status, 'pending'), eq(shelfVerdicts.requestedAt, requestedAt)))
  }

  /** Stores a build and makes the row ready, whatever fingerprint it carries. An UPDATE only: a profile with no row is ignored, never created. */
  async save(profileId: string, built: SavedVerdict): Promise<void> {
    await this.db
      .update(shelfVerdicts)
      .set({ ...built, status: 'ready' })
      .where(eq(shelfVerdicts.profileId, profileId))
  }

  /** Sets the three fit retry columns, changing nothing else of the row. A profile with no row is ignored. */
  async setFitState(profileId: string, { fitAttempts, fitRetried, fitRetryDueAt }: FitState): Promise<void> {
    await this.db.update(shelfVerdicts).set({ fitAttempts, fitRetried, fitRetryDueAt }).where(eq(shelfVerdicts.profileId, profileId))
  }

  /**
   * Up to `limit` rows of any profile whose fit retry is due at `now` or earlier, the longest overdue first and ties by profile id. The null test is written
   * as a literal, not a bound value, so that SQLite can use the partial index on rows with a retry due (`shelf_verdicts_fit_retry_due_idx`).
   */
  async fitDue(now: Date, limit: number): Promise<ShelfVerdictRow[]> {
    return this.db
      .select()
      .from(shelfVerdicts)
      .where(and(sql`${shelfVerdicts.fitRetryDueAt} IS NOT NULL`, lte(shelfVerdicts.fitRetryDueAt, now)))
      .orderBy(asc(shelfVerdicts.fitRetryDueAt), asc(shelfVerdicts.profileId))
      .limit(limit)
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type VerdictsRepository = PublicOf<D1VerdictsRepository>
