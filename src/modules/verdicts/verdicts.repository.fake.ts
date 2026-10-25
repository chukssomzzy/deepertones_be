import type { FitState, SavedVerdict, ShelfVerdictRow, VerdictsRepository } from './verdicts.repository'

/** In-memory VerdictsRepository for unit tests. Its behaviour is pinned by verdictsRepositoryContract, which the D1 class also passes. Unlike D1 it
 * has no profiles table, so requestBuild accepts a profile id that does not exist (D1 rejects it on the foreign key). */
export class FakeVerdictsRepository implements VerdictsRepository {
  private rows = new Map<string, ShelfVerdictRow>()

  async find(profileId: string): Promise<ShelfVerdictRow | null> {
    const row = this.rows.get(profileId)
    return row ? structuredClone(row) : null
  }

  async requestBuild(profileId: string, fingerprint: string, now: Date, staleBefore: Date): Promise<boolean> {
    const row = this.rows.get(profileId)
    const claimable = !row || (row.status === 'ready' && row.fingerprint !== fingerprint) || (row.status === 'pending' && row.requestedAt.getTime() <= staleBefore.getTime())
    if (!claimable) return false
    this.rows.set(profileId, {
      profileId,
      // A rebuild keeps the previous build in place.
      fit: null,
      products: [],
      builtAt: null,
      rulesVersion: null,
      catalogVersion: null,
      model: null,
      promptHash: null,
      inputs: null,
      ...row,
      status: 'pending',
      fingerprint,
      requestedAt: new Date(now),
      fitAttempts: 0,
      fitRetried: false,
      fitRetryDueAt: null,
    })
    return true
  }

  async releaseClaim(profileId: string, requestedAt: Date): Promise<void> {
    const row = this.rows.get(profileId)
    if (row && row.status === 'pending' && row.requestedAt.getTime() === requestedAt.getTime()) this.rows.set(profileId, { ...row, requestedAt: new Date(0) })
  }

  async save(profileId: string, built: SavedVerdict): Promise<void> {
    const row = this.rows.get(profileId)
    if (row) this.rows.set(profileId, { ...row, ...structuredClone(built), status: 'ready' })
  }

  async setFitState(profileId: string, { fitAttempts, fitRetried, fitRetryDueAt }: FitState): Promise<void> {
    const row = this.rows.get(profileId)
    if (row) this.rows.set(profileId, { ...row, fitAttempts, fitRetried, fitRetryDueAt: fitRetryDueAt && new Date(fitRetryDueAt) })
  }

  async fitDue(now: Date, limit: number): Promise<ShelfVerdictRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.fitRetryDueAt !== null && row.fitRetryDueAt.getTime() <= now.getTime())
      .sort((a, b) => a.fitRetryDueAt!.getTime() - b.fitRetryDueAt!.getTime() || (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0))
      .slice(0, limit)
      .map((row) => structuredClone(row))
  }
}
