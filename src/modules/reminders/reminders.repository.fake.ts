import type { RemindersRepository } from './reminders.repository'
import type { ReminderSettings, ReminderSettingsPatch } from './reminders.types'

/** In-memory RemindersRepository for unit tests. Its behaviour is pinned by remindersRepositoryContract, which the D1 class also passes. */
export class FakeRemindersRepository implements RemindersRepository {
  private rows = new Map<string, ReminderSettings>()

  async get(profileId: string): Promise<ReminderSettings | null> {
    const row = this.rows.get(profileId)
    return row ? { ...row } : null
  }

  /** Writes only the fields in `patch` (a new row starts from the defaults) and returns the whole row. */
  async upsert(profileId: string, patch: ReminderSettingsPatch, at: Date): Promise<ReminderSettings> {
    const current: ReminderSettings = this.rows.get(profileId) ?? {
      profileId,
      enabled: false,
      morning: '07:00',
      evening: '21:00',
      timeZone: null,
      stepDownAlerts: true,
      missedDaysNudge: true,
      updatedAt: at,
    }
    const next: ReminderSettings = {
      profileId,
      enabled: patch.enabled ?? current.enabled,
      morning: patch.morning ?? current.morning,
      evening: patch.evening ?? current.evening,
      // null is a value here (it clears the zone), unlike the other fields, where only `undefined` means "not named".
      timeZone: patch.timeZone === undefined ? current.timeZone : patch.timeZone,
      stepDownAlerts: patch.stepDownAlerts ?? current.stepDownAlerts,
      missedDaysNudge: patch.missedDaysNudge ?? current.missedDaysNudge,
      updatedAt: at,
    }
    this.rows.set(profileId, next)
    return { ...next }
  }

  /** Every row whose `enabled` is true. */
  async listEnabled(): Promise<ReminderSettings[]> {
    return [...this.rows.values()].filter((row) => row.enabled).map((row) => ({ ...row }))
  }
}
