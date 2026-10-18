import { lt } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { opsAlertClaims } from './ops-alerts.table'
import type { OpsAlertKind } from './ops-alerts.types'

export class D1OpsAlertsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Whether THIS caller is the one that alerts for `kind` in the window starting at `windowStart`. ONE guarded upsert, so simultaneous
   * callers cannot both win (a read followed by a write would let both through): it stores the window only if it is newer than the
   * one stored. The repository does not know how long a window is; an older or equal window loses.
   */
  async claim(kind: OpsAlertKind, windowStart: Date): Promise<boolean> {
    const won = await this.db
      .insert(opsAlertClaims)
      .values({ kind, windowStart })
      .onConflictDoUpdate({ target: opsAlertClaims.kind, set: { windowStart }, setWhere: lt(opsAlertClaims.windowStart, windowStart) })
      .returning({ kind: opsAlertClaims.kind })
    return won.length === 1
  }
}

// The D1 class is the source of truth; the service and the fake use this type.
export type OpsAlertsRepository = PublicOf<D1OpsAlertsRepository>
