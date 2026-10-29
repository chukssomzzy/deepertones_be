import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { escalationHolds } from './skin-care.table'
import type { EscalationHold, NewEscalationHold } from './skin-care.types'
import type { HoldCloseHow } from './skin-care.vocabulary'

export class D1EscalationHoldsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Opens the hold and answers it whole. A profile has one open hold: when it already has one, nothing is written and that hold is answered (its own id and times, not the ones
   * offered). The conflict clause names the partial unique index, so two opens at once leave one row and both answer it, while an id already held, or a profile that does not exist, still rejects.
   * It is `DO UPDATE SET id = id`, a no-op, because drizzle's `onConflictDoNothing` writes its `where` after `DO NOTHING` (invalid SQLite), and only `onConflictDoUpdate` has `targetWhere`.
   */
  async open(hold: NewEscalationHold): Promise<EscalationHold> {
    await this.db
      .insert(escalationHolds)
      .values(hold)
      .onConflictDoUpdate({ target: escalationHolds.profileId, targetWhere: sql`${escalationHolds.closedAt} IS NULL`, set: { id: sql`${escalationHolds.id}` } })
    const open = await this.openFor(hold.profileId)
    if (!open) throw new Error(`escalation hold for profile ${hold.profileId} was closed before it could be read back`)
    return open
  }

  /** The profile's open hold, whole, or null. */
  async openFor(profileId: string): Promise<EscalationHold | null> {
    const [row] = await this.db.select().from(escalationHolds).where(and(eq(escalationHolds.profileId, profileId), isNull(escalationHolds.closedAt))).limit(1)
    return row ?? null
  }

  /** Closes the profile's hold if it is still open (a compare-and-set on `closed_at`). False for a hold already closed, another profile's hold and an id nobody holds. */
  async close(profileId: string, holdId: string, how: HoldCloseHow, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(escalationHolds)
      .set({ closedAt: at, closedHow: how })
      .where(and(eq(escalationHolds.id, holdId), eq(escalationHolds.profileId, profileId), isNull(escalationHolds.closedAt)))
      .returning({ id: escalationHolds.id })
    return rows.length > 0
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type EscalationHoldsRepository = PublicOf<D1EscalationHoldsRepository>
