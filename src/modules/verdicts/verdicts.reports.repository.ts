import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import type { VerdictGroup } from './verdicts.merge'
import type { ShelfVerdict } from '../routines/routines.types'
import { verdictReports } from './verdicts.table'

export type VerdictReport = typeof verdictReports.$inferSelect

export type NewMistakeReport = { id: string; profileId: string; entryId: string; group: VerdictGroup; verdict: ShelfVerdict; basis: null; fingerprint: string; note: string | null }
export type NewWrongMatchReport = { id: string; profileId: string; entryId: string; oldProductId: string; newProductId: string }

export class D1VerdictReportsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Stores the mistake report, or updates the one already held for this profile, entry and fingerprint (its note and updated time; the offered id, group and verdict are not used).
   * `created` is whether the row is the one offered: RETURNING answers the existing row's id on the update path, so two reports at once leave one row and exactly one `created`.
   * The conflict clause names the partial unique index (its `targetWhere` must match the index's), so an id already held, or a profile that does not exist, still rejects.
   */
  async upsertMistake(report: NewMistakeReport, now: Date): Promise<{ id: string; created: boolean }> {
    const [row] = await this.db
      .insert(verdictReports)
      .values({ ...report, kind: 'mistake', oldProductId: null, newProductId: null, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [verdictReports.profileId, verdictReports.entryId, verdictReports.fingerprint],
        targetWhere: sql`${verdictReports.kind} = 'mistake'`,
        set: { note: sql`excluded.note`, updatedAt: sql`excluded.updated_at` },
      })
      .returning({ id: verdictReports.id })
    if (!row) throw new Error(`verdict report for profile ${report.profileId} was not written`)
    return { id: row.id, created: row.id === report.id }
  }

  /** A plain insert: a person may swap the same entry's product more than once, and each swap is a report. */
  async recordWrongMatch(report: NewWrongMatchReport, now: Date): Promise<void> {
    await this.db.insert(verdictReports).values({ ...report, kind: 'wrong-match', group: null, verdict: null, basis: null, fingerprint: null, note: null, createdAt: now, updatedAt: now })
  }

  /** The row whole, or null. Only the contract tests read it: the product shows no report back. */
  async find(id: string): Promise<VerdictReport | null> {
    const [row] = await this.db.select().from(verdictReports).where(eq(verdictReports.id, id)).limit(1)
    return row ?? null
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type VerdictReportsRepository = PublicOf<D1VerdictReportsRepository>
