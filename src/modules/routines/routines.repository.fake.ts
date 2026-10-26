import type { CompletedRoutineBuild, RoutineRequestRetry, RoutineRequestRow, RoutineVersionRow, RoutinesRepository } from './routines.repository'

/** In-memory RoutinesRepository for unit tests. Its behaviour is pinned by routinesRepositoryContract, which the D1 class also passes. Unlike D1 it has no
 * profiles table, so append accepts a profile id that does not exist. */
export class FakeRoutinesRepository implements RoutinesRepository {
  private rows = new Map<string, RoutineVersionRow>()
  private requests = new Map<string, RoutineRequestRow>()

  async append(row: RoutineVersionRow): Promise<void> {
    if (this.rows.has(row.id)) throw new Error(`routine version ${row.id} already exists`)
    this.rows.set(row.id, structuredClone(row))
  }

  async latest(profileId: string): Promise<RoutineVersionRow | null> {
    return this.newest(profileId, () => true)
  }

  async current(profileId: string): Promise<RoutineVersionRow | null> {
    return this.newestReady(profileId, (row) => row.status === 'ready')
  }

  async clearWriterRetry(id: string): Promise<void> {
    const row = this.rows.get(id)
    if (row) this.rows.set(id, { ...row, writerRetryDueAt: null })
  }

  async markServed(id: string, at: Date): Promise<void> {
    const row = this.rows.get(id)
    if (row) this.rows.set(id, { ...row, servedAt: new Date(at) })
  }

  async markStarted(profileId: string, on: Date): Promise<void> {
    for (const [id, row] of this.rows) {
      if (row.profileId !== profileId || row.startedOn !== null) continue
      this.rows.set(id, { ...row, startedOn: new Date(on), tapers: row.tapers.map((taper) => ({ ...taper, startedOn: new Date(taper.startedOn ?? on) })) })
    }
  }

  async lastServedBefore(profileId: string, excludeId: string): Promise<RoutineVersionRow | null> {
    return this.newestReady(profileId, (row) => row.status === 'ready' && row.servedAt !== null && row.id !== excludeId)
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

  async claim(profileId: string, key: string, now: Date, staleBefore: Date): Promise<boolean> {
    const held = this.requests.get(profileId)
    if (held && held.requestedAt.getTime() > staleBefore.getTime()) return false
    this.requests.set(profileId, { profileId, requestKey: key, requestedAt: new Date(now), retryDueAt: null, retried: false })
    return true
  }

  async release(profileId: string, requestedAt: Date): Promise<void> {
    const held = this.requests.get(profileId)
    if (held && held.requestedAt.getTime() === requestedAt.getTime()) this.requests.set(profileId, { ...held, requestedAt: new Date(0) })
  }

  async findRequest(profileId: string): Promise<RoutineRequestRow | null> {
    const held = this.requests.get(profileId)
    return held ? structuredClone(held) : null
  }

  async setRequestRetry(profileId: string, { retried, retryDueAt }: RoutineRequestRetry): Promise<void> {
    const held = this.requests.get(profileId)
    if (held) this.requests.set(profileId, { ...held, retried, retryDueAt: retryDueAt ? new Date(retryDueAt) : null })
  }

  // Newest is the latest creation time, then the larger id, as in D1.
  private newest(profileId: string, keep: (row: RoutineVersionRow) => boolean): RoutineVersionRow | null {
    const [row] = [...this.rows.values()]
      .filter((r) => r.profileId === profileId && keep(r))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    return row ? structuredClone(row) : null
  }

  // Ready order, as in D1: the version that became ready last (a row with no readyAt counts from its creation), then the larger id.
  private newestReady(profileId: string, keep: (row: RoutineVersionRow) => boolean): RoutineVersionRow | null {
    const readyAt = (row: RoutineVersionRow) => (row.readyAt ?? row.createdAt).getTime()
    const [row] = [...this.rows.values()]
      .filter((r) => r.profileId === profileId && keep(r))
      .sort((a, b) => readyAt(b) - readyAt(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    return row ? structuredClone(row) : null
  }
}
