import type { CheckInRow, CheckInTime, RoutineCheckInsRepository } from './routines.check-ins.repository'

/** In-memory RoutineCheckInsRepository for unit tests. Its behaviour is pinned by routineCheckInsRepositoryContract, which the D1 class also passes. Unlike D1 it has no
 * profiles table, so `record` accepts a profile id that does not exist, and nothing cascades. */
export class FakeRoutineCheckInsRepository implements RoutineCheckInsRepository {
  private rows = new Map<string, CheckInRow>()

  async record(profileId: string, day: string, time: CheckInTime, at: Date): Promise<void> {
    const key = JSON.stringify([profileId, day, time])
    if (!this.rows.has(key)) this.rows.set(key, { profileId, day, time, at: new Date(at) })
  }

  async list(profileId: string, from: string, to: string): Promise<CheckInRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.profileId === profileId && row.day >= from && row.day <= to)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
      .map((row) => ({ ...row, at: new Date(row.at) }))
  }
  async latestDay(profileId: string, from: string, to: string): Promise<string | null> {
    const days = [...this.rows.values()].filter((row) => row.profileId === profileId && row.day >= from && row.day <= to).map((row) => row.day)
    return days.length === 0 ? null : days.reduce((latest, day) => (day > latest ? day : latest))
  }
}
