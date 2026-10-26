import type { CompletedRoutineBuild, RoutineVersionRow, RoutinesRepository } from './routines.repository'

/** In-memory RoutinesRepository for unit tests. Its behaviour is pinned by routinesRepositoryContract, which the D1 class also passes. Unlike D1 it has no
 * profiles table, so append accepts a profile id that does not exist. */
export class FakeRoutinesRepository implements RoutinesRepository {
  private rows = new Map<string, RoutineVersionRow>()

  async append(row: RoutineVersionRow): Promise<void> {
    if (this.rows.has(row.id)) throw new Error(`routine version ${row.id} already exists`)
    this.rows.set(row.id, structuredClone(row))
  }

  async latest(profileId: string): Promise<RoutineVersionRow | null> {
    return this.newest(profileId, () => true)
  }

  async current(profileId: string): Promise<RoutineVersionRow | null> {
    return this.newest(profileId, (row) => row.status === 'ready')
  }

  async markServed(id: string, at: Date): Promise<void> {
    const row = this.rows.get(id)
    if (row) this.rows.set(id, { ...row, servedAt: new Date(at) })
  }

  async complete(id: string, built: CompletedRoutineBuild): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.status !== 'pending') return false
    this.rows.set(id, { ...row, ...structuredClone(built), status: 'ready' })
    return true
  }

  async writerBuildsSince(profileId: string, since: Date): Promise<number> {
    return [...this.rows.values()].filter((row) => row.profileId === profileId && row.writerCalls > 0 && row.createdAt.getTime() >= since.getTime()).length
  }

  // Newest is the latest creation time, then the larger id, as in D1.
  private newest(profileId: string, keep: (row: RoutineVersionRow) => boolean): RoutineVersionRow | null {
    const [row] = [...this.rows.values()]
      .filter((r) => r.profileId === profileId && keep(r))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    return row ? structuredClone(row) : null
  }
}
