import type { PushTokensRepository } from './notifications.repository'
import type { PushToken } from './notifications.types'

/**
 * In-memory PushTokensRepository for unit tests. Its behaviour is pinned by pushTokensRepositoryContract, which the D1 class also
 * passes. It does not model the foreign keys to users and profiles or their cascade; D1 does (see test/integration).
 */
export class FakePushTokensRepository implements PushTokensRepository {
  private rows = new Map<string, PushToken>()

  /** Assigns the device's row, and removes any OTHER row that holds the same token, so a token lives in one row. */
  async upsert(row: PushToken): Promise<void> {
    for (const [deviceHash, held] of this.rows) {
      if (held.token === row.token && deviceHash !== row.deviceHash) this.rows.delete(deviceHash)
    }
    const existing = this.rows.get(row.deviceHash)
    this.rows.set(row.deviceHash, { ...row, createdAt: existing?.createdAt ?? row.createdAt })
  }

  async find(deviceHash: string): Promise<PushToken | null> {
    const row = this.rows.get(deviceHash)
    return row ? { ...row } : null
  }

  /** Deletes the device's row only when it belongs to `userId`; true when a row went. */
  async deleteForDevice(deviceHash: string, userId: string): Promise<boolean> {
    const row = this.rows.get(deviceHash)
    if (!row || row.userId !== userId) return false
    this.rows.delete(deviceHash)
    return true
  }

  async deleteForUser(userId: string): Promise<number> {
    let count = 0
    for (const [deviceHash, row] of this.rows) {
      if (row.userId === userId) {
        this.rows.delete(deviceHash)
        count++
      }
    }
    return count
  }

  async forProfile(profileId: string): Promise<PushToken[]> {
    return [...this.rows.values()].filter((row) => row.profileId === profileId).map((row) => ({ ...row }))
  }

  async forUser(userId: string): Promise<PushToken[]> {
    return [...this.rows.values()].filter((row) => row.userId === userId).map((row) => ({ ...row }))
  }
}
