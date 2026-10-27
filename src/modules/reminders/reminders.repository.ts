import { eq } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { reminderSettings } from './reminders.table'
import type { ReminderSettings, ReminderSettingsPatch } from './reminders.types'

export class D1RemindersRepository {
  constructor(private readonly db: Db) {}

  async get(profileId: string): Promise<ReminderSettings | null> {
    const [row] = await this.db.select().from(reminderSettings).where(eq(reminderSettings.profileId, profileId))
    return row ?? null
  }

  /** Every row whose `enabled` is true, whole: the send job's one read per run. A profile with reminders off, or with no row, is not in it. */
  async listEnabled(): Promise<ReminderSettings[]> {
    return this.db.select().from(reminderSettings).where(eq(reminderSettings.enabled, true))
  }

  /**
   * Writes only the fields `patch` names (a new row starts from the defaults) and returns the whole row. One statement, so a second change made at the
   * same time cannot be lost by reading the row first.
   */
  async upsert(profileId: string, patch: ReminderSettingsPatch, at: Date): Promise<ReminderSettings> {
    const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as ReminderSettingsPatch
    const [row] = await this.db
      .insert(reminderSettings)
      .values({ profileId, ...changes, updatedAt: at })
      .onConflictDoUpdate({ target: reminderSettings.profileId, set: { ...changes, updatedAt: at } })
      .returning()
    return row!
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type RemindersRepository = PublicOf<D1RemindersRepository>
