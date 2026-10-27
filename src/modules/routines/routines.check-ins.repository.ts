import { and, asc, desc, eq, gte, lte } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { routineCheckIns } from './routines.check-ins.table'

export type CheckInRow = typeof routineCheckIns.$inferSelect

export type CheckInTime = CheckInRow['time']

export class D1RoutineCheckInsRepository {
  constructor(private readonly db: Db) {}

  /** Stores the check-in; one already held for the same (profile, day, time) is left as it is, so the first `at` is kept. Rejects a profile that does not exist. */
  async record(profileId: string, day: string, time: CheckInTime, at: Date): Promise<void> {
    await this.db.insert(routineCheckIns).values({ profileId, day, time, at }).onConflictDoNothing()
  }

  /** The profile's check-ins for the days `from` to `to`, both included ('YYYY-MM-DD' sorts as text), earliest day first. */
  async list(profileId: string, from: string, to: string): Promise<CheckInRow[]> {
    return this.db
      .select()
      .from(routineCheckIns)
      .where(and(eq(routineCheckIns.profileId, profileId), gte(routineCheckIns.day, from), lte(routineCheckIns.day, to)))
      .orderBy(asc(routineCheckIns.day), asc(routineCheckIns.time))
  }

  /** The latest day the profile checked in for within `from` to `to` (both included), at either time, or null when none. Served by the primary key. */
  async latestDay(profileId: string, from: string, to: string): Promise<string | null> {
    const [row] = await this.db
      .select({ day: routineCheckIns.day })
      .from(routineCheckIns)
      .where(and(eq(routineCheckIns.profileId, profileId), gte(routineCheckIns.day, from), lte(routineCheckIns.day, to)))
      .orderBy(desc(routineCheckIns.day))
      .limit(1)
    return row?.day ?? null
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type RoutineCheckInsRepository = PublicOf<D1RoutineCheckInsRepository>
