import type { SkinCareRepository } from './skin-care.repository'
import type { NewSkinLog, SkinLog } from './skin-care.types'

const copyOf = (row: SkinLog): SkinLog => ({ ...row, noticing: [...row.noticing], where: [...row.where], createdAt: new Date(row.createdAt) })

/**
 * In-memory SkinCareRepository for unit tests. Its behaviour is pinned by skinCareRepositoryContract, which the D1 class also passes. Unlike D1 it has no profiles
 * table, so `append` accepts a profile id that does not exist, and nothing cascades.
 */
export class FakeSkinCareRepository implements SkinCareRepository {
  private rows = new Map<string, SkinLog>()

  async append(log: NewSkinLog): Promise<SkinLog> {
    if (this.rows.has(log.id)) throw new Error(`skin log ${log.id} already exists`)
    const row: SkinLog = { ...log, overridden: false }
    this.rows.set(log.id, copyOf(row))
    return copyOf(row)
  }

  async recent(profileId: string, limit: number): Promise<SkinLog[]> {
    return [...this.rows.values()]
      .filter((row) => row.profileId === profileId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, limit)
      .map(copyOf)
  }

  async markOverridden(profileId: string, id: string): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.profileId !== profileId) return false
    row.overridden = true
    return true
  }
}
