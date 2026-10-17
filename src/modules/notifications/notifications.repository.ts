import { and, eq, ne } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { notificationSettings, pushTokens } from './notifications.table'
import type { NotificationSettings, NotificationSettingsPatch, PushToken } from './notifications.types'

export class D1PushTokensRepository {
  constructor(private readonly db: Db) {}

  /**
   * Gives the device this row, in ONE batch: any OTHER row that holds the same token is deleted first (the token column is
   * unique, and a token belongs to one phone), then the device's row is inserted or, when it exists, moved to the new token,
   * platform, account, profile and time. `createdAt` is kept when a row is updated. A failed write rolls the delete back.
   */
  async upsert(row: PushToken): Promise<void> {
    await this.db.batch([
      this.db.delete(pushTokens).where(and(eq(pushTokens.token, row.token), ne(pushTokens.deviceHash, row.deviceHash))),
      this.db
        .insert(pushTokens)
        .values(row)
        .onConflictDoUpdate({
          target: pushTokens.deviceHash,
          set: { token: row.token, platform: row.platform, userId: row.userId, profileId: row.profileId, updatedAt: row.updatedAt },
        }),
    ])
  }

  async find(deviceHash: string): Promise<PushToken | null> {
    const [row] = await this.db.select().from(pushTokens).where(eq(pushTokens.deviceHash, deviceHash))
    return row ?? null
  }

  /** Deletes the device's row only when it belongs to `userId`; true when a row went. */
  async deleteForDevice(deviceHash: string, userId: string): Promise<boolean> {
    const gone = await this.db
      .delete(pushTokens)
      .where(and(eq(pushTokens.deviceHash, deviceHash), eq(pushTokens.userId, userId)))
      .returning({ deviceHash: pushTokens.deviceHash })
    return gone.length > 0
  }

  /** Deletes every row of the user, on all its profiles, and returns how many went. */
  async deleteForUser(userId: string): Promise<number> {
    const gone = await this.db.delete(pushTokens).where(eq(pushTokens.userId, userId)).returning({ deviceHash: pushTokens.deviceHash })
    return gone.length
  }

  async forProfile(profileId: string): Promise<PushToken[]> {
    return this.db.select().from(pushTokens).where(eq(pushTokens.profileId, profileId))
  }

  async forUser(userId: string): Promise<PushToken[]> {
    return this.db.select().from(pushTokens).where(eq(pushTokens.userId, userId))
  }
}

export class D1NotificationSettingsRepository {
  constructor(private readonly db: Db) {}

  async get(userId: string): Promise<NotificationSettings | null> {
    const [row] = await this.db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId))
    return row ?? null
  }

  /**
   * Writes only the switches `patch` names (a new row starts with both on) and returns the whole row. One statement, so a
   * second change made at the same time cannot be lost by reading the row first.
   */
  async upsert(userId: string, patch: NotificationSettingsPatch, at: Date): Promise<NotificationSettings> {
    const changes = {
      ...(patch.scanFinished === undefined ? {} : { scanFinished: patch.scanFinished }),
      ...(patch.scanNeedsYou === undefined ? {} : { scanNeedsYou: patch.scanNeedsYou }),
    }
    const [row] = await this.db
      .insert(notificationSettings)
      .values({ userId, ...changes, updatedAt: at })
      .onConflictDoUpdate({ target: notificationSettings.userId, set: { ...changes, updatedAt: at } })
      .returning()
    return row!
  }
}

// The D1 classes are the source of truth; services and fakes use these types.
export type PushTokensRepository = PublicOf<D1PushTokensRepository>
export type NotificationSettingsRepository = PublicOf<D1NotificationSettingsRepository>
