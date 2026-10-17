import { hmacSha256Hex } from '../../lib/crypto'
import { requireUser } from '../../lib/context'
import { ValidationError } from '../../lib/errors'
import { isExpoPushToken } from '../../providers/push/push.provider'
import type { NotificationSettingsRepository, PushTokensRepository } from './notifications.repository'
import type { NotificationSettings, NotificationSettingsPatch, PushToken } from './notifications.types'

export type NotificationsServiceDeps = {
  pushTokens: PushTokensRepository
  settings: NotificationSettingsRepository
  /** Keys the HMAC of device ids. It must be the key AuthService uses, so a push token row joins to the `devices` row of the same phone. */
  deviceIdKey: string
  now?: () => Date
}

/** The switches as the app sees them. */
export type ScanNotificationSettings = Pick<NotificationSettings, 'scanFinished' | 'scanNeedsYou'>

/**
 * Which phones may be notified, and which notifications an account wants. A phone is a row keyed by the keyed hash of its device
 * id; the account and profile come from the session, so the app never says whose phone it is.
 */
export class NotificationsService {
  private readonly pushTokens: PushTokensRepository
  private readonly settingsRepository: NotificationSettingsRepository
  private readonly now: () => Date
  // `#`, not `private`: it is the device id HMAC key, and a runtime-private field stays out of spreads and JSON.stringify.
  readonly #deviceIdKey: string

  constructor(deps: NotificationsServiceDeps) {
    this.pushTokens = deps.pushTokens
    this.settingsRepository = deps.settings
    this.#deviceIdKey = deps.deviceIdKey
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Stores the phone's push token for the session's account and profile. A phone that registers again is moved: to the new
   * token, or to another account or profile, and a token another phone held now belongs to this one. Call it after every sign-in,
   * logout, profile switch and token refresh.
   */
  async register(input: { deviceId: string; platform: PushToken['platform']; token: string }): Promise<void> {
    const { userId, profileId } = requireUser()
    if (!isExpoPushToken(input.token)) throw new ValidationError('PUSH_TOKEN_INVALID', 'That is not an Expo push token')
    const now = this.now()
    await this.pushTokens.upsert({
      deviceHash: await hmacSha256Hex(this.#deviceIdKey, input.deviceId),
      token: input.token,
      platform: input.platform,
      userId,
      profileId,
      createdAt: now,
      updatedAt: now,
    })
  }

  /** Removes the caller's own phone. A phone with no row, or one that belongs to another account, is not an error: it is left as it is. */
  async unregister(input: { deviceId: string }): Promise<void> {
    const { userId } = requireUser()
    await this.pushTokens.deleteForDevice(await hmacSha256Hex(this.#deviceIdKey, input.deviceId), userId)
  }

  /** The account's switches; both are on until one is changed, and reading writes nothing. */
  async settings(): Promise<ScanNotificationSettings> {
    const { userId } = requireUser()
    return NotificationsService.switchesOf(await this.settingsRepository.get(userId))
  }

  /** Changes only the switches named and answers with all of them. Settings belong to the account, so every profile shares them. */
  async updateSettings(patch: NotificationSettingsPatch): Promise<ScanNotificationSettings> {
    const { userId } = requireUser()
    return NotificationsService.switchesOf(await this.settingsRepository.upsert(userId, patch, this.now()))
  }

  /**
   * Logout signs the whole account out, on every phone, so every one of its push tokens goes. Each phone registers again under
   * the guest it is handed next. Takes the id so AuthService, which already read the actor, does not make this read it twice.
   */
  async accountSignedOut(userId: string): Promise<void> {
    await this.pushTokens.deleteForUser(userId)
  }

  /**
   * A guest signed in to an existing account and is left behind. Its push token rows go, so that phone stops receiving the
   * guest's notifications; it registers again under the account it signed in to. (Verify carries no device id, so the guest's
   * rows are the only way to name this phone.) Not called when the guest is promoted in place: that account keeps its rows.
   */
  async guestSignedIn(userId: string): Promise<void> {
    await this.pushTokens.deleteForUser(userId)
  }

  private static switchesOf(row: ScanNotificationSettings | null): ScanNotificationSettings {
    return { scanFinished: row?.scanFinished ?? true, scanNeedsYou: row?.scanNeedsYou ?? true }
  }
}
