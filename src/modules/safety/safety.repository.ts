import { desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { profileSafety } from './safety.table'
import type { SafetyRow } from './safety.types'

export class D1SafetyRepository {
  // Rows can share a created_at (the clock has millisecond resolution), and then the one appended later must still win. `rowid` grows
  // with each insert into this table, so it breaks the tie the same way every time; without it SQLite may return either row.
  private static readonly NEWEST_FIRST = [desc(profileSafety.createdAt), sql`rowid desc`] as const

  constructor(private readonly db: Db) {}

  /** Adds a row to the profile's history. Rejects a profile that does not exist. */
  async append(row: SafetyRow): Promise<void> {
    await this.db.insert(profileSafety).values(row)
  }

  /** The profile's newest row by time, or null when it never answered. */
  async current(profileId: string): Promise<SafetyRow | null> {
    const [row] = await this.db
      .select()
      .from(profileSafety)
      .where(eq(profileSafety.profileId, profileId))
      .orderBy(...D1SafetyRepository.NEWEST_FIRST)
      .limit(1)
    return row ?? null
  }

  /** Every row the profile ever saved, newest first. */
  async history(profileId: string): Promise<SafetyRow[]> {
    return this.db.select().from(profileSafety).where(eq(profileSafety.profileId, profileId)).orderBy(...D1SafetyRepository.NEWEST_FIRST)
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type SafetyRepository = PublicOf<D1SafetyRepository>
