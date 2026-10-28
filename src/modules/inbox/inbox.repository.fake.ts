import type { InboxRepository } from './inbox.repository'
import type { InboxItem } from './inbox.types'

/**
 * In-memory InboxRepository for unit tests. Its behaviour is pinned by inboxRepositoryContract, which the D1 class also passes. It does not model the foreign key to
 * profiles; D1 does (see test/integration). Rows with the same createdAt are ordered by id, newest first, so a walk of pages through `before` is stable.
 */
export class FakeInboxRepository implements InboxRepository {
  private rows: InboxItem[] = []

  async insertOnce(row: Parameters<InboxRepository['insertOnce']>[0]): Promise<{ id: string; created: boolean }> {
    const held = this.rows.find((item) => item.profileId === row.profileId && item.key === row.key)
    if (held) return { id: held.id, created: false }
    this.rows.push({ ...row, readAt: null })
    return { id: row.id, created: true }
  }

  async find(profileId: string, id: string): Promise<InboxItem | null> {
    const found = this.rows.find((item) => item.profileId === profileId && item.id === id)
    return found ? { ...found } : null
  }

  async list(profileId: string, query: { before?: { createdAt: Date; id: string }; limit: number }): Promise<InboxItem[]> {
    const { before } = query
    return this.rows
      .filter((item) => item.profileId === profileId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .filter((item) => before === undefined || item.createdAt.getTime() < before.createdAt.getTime() || (item.createdAt.getTime() === before.createdAt.getTime() && item.id < before.id))
      .slice(0, query.limit)
      .map((item) => ({ ...item }))
  }

  async markReadUpTo(profileId: string, upTo: Date, at: Date): Promise<void> {
    for (const item of this.rows) if (item.profileId === profileId && item.readAt === null && item.createdAt.getTime() <= upTo.getTime()) item.readAt = at
  }

  async markRead(profileId: string, id: string, at: Date): Promise<void> {
    const found = this.rows.find((item) => item.profileId === profileId && item.id === id)
    if (found && found.readAt === null) found.readAt = at
  }

  async unreadCount(profileId: string): Promise<number> {
    return this.rows.filter((item) => item.profileId === profileId && item.readAt === null).length
  }
}
