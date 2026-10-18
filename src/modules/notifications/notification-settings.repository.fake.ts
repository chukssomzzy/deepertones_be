import type { NotificationSettingsRepository } from './notifications.repository'
import type { NotificationSettings, NotificationSettingsPatch } from './notifications.types'

/** In-memory NotificationSettingsRepository for unit tests. Its behaviour is pinned by notificationSettingsRepositoryContract, which the D1 class also passes. */
export class FakeNotificationSettingsRepository implements NotificationSettingsRepository {
  private rows = new Map<string, NotificationSettings>()

  async get(userId: string): Promise<NotificationSettings | null> {
    const row = this.rows.get(userId)
    return row ? { ...row } : null
  }

  /** Writes only the fields in `patch` (a new row starts with both on) and returns the whole row. */
  async upsert(userId: string, patch: NotificationSettingsPatch, at: Date): Promise<NotificationSettings> {
    const current = this.rows.get(userId) ?? { userId, scanFinished: true, scanNeedsYou: true, updatedAt: at }
    const next: NotificationSettings = {
      userId,
      scanFinished: patch.scanFinished ?? current.scanFinished,
      scanNeedsYou: patch.scanNeedsYou ?? current.scanNeedsYou,
      updatedAt: at,
    }
    this.rows.set(userId, next)
    return { ...next }
  }
}
