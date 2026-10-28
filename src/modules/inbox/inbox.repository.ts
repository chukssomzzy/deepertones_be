import { and, desc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { inboxItems } from './inbox.table'
import type { InboxItem, NewInboxItem } from './inbox.types'

export class D1InboxRepository {
  constructor(private readonly db: Db) {}

  /**
   * Holds the row under its (profile, key). `created` is true when this call inserted it; false when the key was held already, and then `id` is the holder's and the row
   * stays as it was. One INSERT ... ON CONFLICT DO NOTHING, so of several writes made at the same time exactly one is created. Rejects a profile that does not exist.
   */
  async insertOnce(row: NewInboxItem): Promise<{ id: string; created: boolean }> {
    const inserted = await this.db.insert(inboxItems).values(row).onConflictDoNothing().returning({ id: inboxItems.id })
    if (inserted.length > 0) return { id: row.id, created: true }
    const [held] = await this.db
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .where(and(eq(inboxItems.profileId, row.profileId), eq(inboxItems.key, row.key)))
    return { id: held!.id, created: false }
  }

  async find(profileId: string, id: string): Promise<InboxItem | null> {
    const [row] = await this.db.select().from(inboxItems).where(and(eq(inboxItems.profileId, profileId), eq(inboxItems.id, id)))
    return row ?? null
  }

  /** Newest first; rows made at the same instant follow id descending, so the order is one and the same on every call. `before` is a row as this method gave it: the page starts right after it. */
  async list(profileId: string, query: { before?: { createdAt: Date; id: string }; limit: number }): Promise<InboxItem[]> {
    const { before } = query
    const after = before && or(lt(inboxItems.createdAt, before.createdAt), and(eq(inboxItems.createdAt, before.createdAt), lt(inboxItems.id, before.id)))
    return this.db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.profileId, profileId), after))
      .orderBy(desc(inboxItems.createdAt), desc(inboxItems.id))
      .limit(query.limit)
  }

  /** Marks the profile's unread rows created at or before `upTo` read at `at`. A row already read keeps its time, so a row is never unread. */
  async markReadUpTo(profileId: string, upTo: Date, at: Date): Promise<void> {
    await this.db
      .update(inboxItems)
      .set({ readAt: at })
      .where(and(eq(inboxItems.profileId, profileId), isNull(inboxItems.readAt), lte(inboxItems.createdAt, upTo)))
  }

  /** Marks one unread row read. An id the profile does not hold (another profile's included) changes nothing. */
  async markRead(profileId: string, id: string, at: Date): Promise<void> {
    await this.db
      .update(inboxItems)
      .set({ readAt: at })
      .where(and(eq(inboxItems.profileId, profileId), eq(inboxItems.id, id), isNull(inboxItems.readAt)))
  }

  async unreadCount(profileId: string): Promise<number> {
    const [row] = await this.db
      .select({ unread: sql<number>`count(*)` })
      .from(inboxItems)
      .where(and(eq(inboxItems.profileId, profileId), isNull(inboxItems.readAt)))
    return row!.unread
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type InboxRepository = PublicOf<D1InboxRepository>
