import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { skinLogs } from './skin-care.table'
import type { EscalationReason } from '../catalog/catalog.vocabulary'
import type { NewSkinLog, SkinLog } from './skin-care.types'

export class D1SkinCareRepository {
  constructor(private readonly db: Db) {}

  /** Stores the log as given and answers the row, `overridden` false. Rejects an id already held and a profile that does not exist. */
  async append(log: NewSkinLog): Promise<SkinLog> {
    const [row] = await this.db.insert(skinLogs).values(log).returning()
    return row!
  }

  /** The profile's newest `limit` logs, newest first (logs made in the same millisecond by id, highest first, so the order is stable), whole. Served by the (profile, created_at) index. */
  async recent(profileId: string, limit: number): Promise<SkinLog[]> {
    return this.db.select().from(skinLogs).where(eq(skinLogs.profileId, profileId)).orderBy(desc(skinLogs.createdAt), desc(skinLogs.id)).limit(limit)
  }

  /** Sets the outcome and reason a stored log says it came to (when the action it started could not be made). False for another profile's log and for an id nobody holds. */
  async setOutcome(profileId: string, id: string, outcome: SkinLog['outcome'], reason: EscalationReason | null): Promise<boolean> {
    const rows = await this.db.update(skinLogs).set({ outcome, reason }).where(and(eq(skinLogs.id, id), eq(skinLogs.profileId, profileId))).returning({ id: skinLogs.id })
    return rows.length > 0
  }

  /** Marks the profile's log overridden. False for another profile's log and for an id nobody holds; true again if it was already marked. */
  async markOverridden(profileId: string, id: string): Promise<boolean> {
    const rows = await this.db.update(skinLogs).set({ overridden: true }).where(and(eq(skinLogs.id, id), eq(skinLogs.profileId, profileId))).returning({ id: skinLogs.id })
    return rows.length > 0
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type SkinCareRepository = PublicOf<D1SkinCareRepository>
