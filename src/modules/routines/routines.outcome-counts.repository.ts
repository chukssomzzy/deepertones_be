import { and, eq, inArray } from 'drizzle-orm'
import { queryByIds, type Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import type { SkinTypeLabel } from '../face-scans/face-scans.tables'
import type { Goal } from '../goals/goals.vocabulary'
import type { OutcomeCounts } from './routines.outcomes'
import { routineOutcomeCounts } from './routines.outcome-counts.table'

/** The group counts are kept for. A null skin type is users with no face scan. */
export type OutcomeCountsGroup = { goal: Goal; skinType: SkinTypeLabel | null; country: string }

export class D1OutcomeCountsRepository {
  constructor(private readonly db: Db) {}

  /** The counts of the asked codes that have a row in exactly this group, by code. A code with no row is not in the map. */
  async counts(group: OutcomeCountsGroup, codes: string[]): Promise<Map<string, OutcomeCounts>> {
    // A chunk of ID_CHUNK (90) codes plus the group's 3 parameters stays under the 100 D1 binds per statement.
    const rows = await queryByIds(codes, (chunk) =>
      this.db
        .select()
        .from(routineOutcomeCounts)
        .where(
          and(
            eq(routineOutcomeCounts.goal, group.goal),
            eq(routineOutcomeCounts.skinType, group.skinType ?? ''),
            eq(routineOutcomeCounts.country, group.country),
            inArray(routineOutcomeCounts.code, chunk),
          ),
        ),
    )
    return new Map(rows.map(({ code, n, fainter, flared, flaredOrStopped, fainterAndFlaredOrStopped }) => [code, { n, fainter, flared, flaredOrStopped, fainterAndFlaredOrStopped }]))
  }

  /** Stores the counts for a code in a group, replacing the row already there. */
  async upsert(group: OutcomeCountsGroup, code: string, counts: OutcomeCounts, at: Date): Promise<void> {
    const skinType: SkinTypeLabel | '' = group.skinType ?? ''
    const row = { goal: group.goal, skinType, country: group.country, code, ...counts, updatedAt: at }
    await this.db
      .insert(routineOutcomeCounts)
      .values(row)
      .onConflictDoUpdate({ target: [routineOutcomeCounts.goal, routineOutcomeCounts.skinType, routineOutcomeCounts.country, routineOutcomeCounts.code], set: { ...counts, updatedAt: at } })
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type OutcomeCountsRepository = PublicOf<D1OutcomeCountsRepository>
