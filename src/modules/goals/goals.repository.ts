import { desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { profileGoals } from './goals.table'
import type { GoalRow } from './goals.types'

export class D1GoalsRepository {
  // Rows can share a created_at (the clock has millisecond resolution), and then the one appended later must still win. `rowid` grows
  // with each insert into this table, so it breaks the tie the same way every time; without it SQLite may return either row.
  private static readonly NEWEST_FIRST = [desc(profileGoals.createdAt), sql`rowid desc`] as const

  constructor(private readonly db: Db) {}

  /** Adds a row to the profile's history. Rejects a profile that does not exist. */
  async append(row: GoalRow): Promise<void> {
    await this.db.insert(profileGoals).values(row)
  }

  /** The profile's newest row by time, or null when it never set a goal. */
  async current(profileId: string): Promise<GoalRow | null> {
    const [row] = await this.db
      .select()
      .from(profileGoals)
      .where(eq(profileGoals.profileId, profileId))
      .orderBy(...D1GoalsRepository.NEWEST_FIRST)
      .limit(1)
    return row ?? null
  }

  /** Every row the profile ever saved, newest first. */
  async history(profileId: string): Promise<GoalRow[]> {
    return this.db.select().from(profileGoals).where(eq(profileGoals.profileId, profileId)).orderBy(...D1GoalsRepository.NEWEST_FIRST)
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type GoalsRepository = PublicOf<D1GoalsRepository>
