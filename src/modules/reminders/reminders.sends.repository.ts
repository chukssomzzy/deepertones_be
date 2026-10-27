import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { reminderSends } from './reminders.sends.table'

export class D1ReminderSendsRepository {
  constructor(private readonly db: Db) {}

  /** Holds the key (profile, local day, kind): true when this call inserted it, false when it was held already (the row stays as it was). Rejects a profile that does not exist. */
  async claim(profileId: string, localDay: string, kind: string, at: Date): Promise<boolean> {
    const rows = await this.db.insert(reminderSends).values({ profileId, localDay, kind, sentAt: at }).onConflictDoNothing().returning({ kind: reminderSends.kind })
    return rows.length > 0
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type ReminderSendsRepository = PublicOf<D1ReminderSendsRepository>
