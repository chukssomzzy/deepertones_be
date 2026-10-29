import { PermanentJobError } from '../../jobs/job'
import { hmacSha256Hex, sha256Hex } from '../../lib/crypto'
import { requireUser } from '../../lib/context'
import { ValidationError } from '../../lib/errors'
import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import type { RejectedPhotoReason } from '../../providers/perfect-corp/perfect-corp.provider'
import { type PushMessage, type PushSender, PushUnavailableError, isExpoPushToken } from '../../providers/push/push.provider'
import type { RemindersService } from '../reminders/reminders.service'
import { deepLinkFor } from './deep-links'
import { pauseCheckInText, routineReminderText, stepDownAlertText } from './notifications.copy'
import { type CheckPushReceiptsMessage, type PushNotificationMessage, checkPushReceiptsSpec, sendPushSpec } from './notifications.job-specs'
import type { NotificationSettingsRepository, PushTokensRepository } from './notifications.repository'
import type { NotificationSettings, NotificationSettingsPatch, PushToken } from './notifications.types'

export type NotificationsServiceDeps = {
  pushTokens: PushTokensRepository
  settings: NotificationSettingsRepository
  push: PushSender
  jobs: JobQueue
  /** Read at send time for the routine reminder, the step-down alert and the missed-days nudge, which the profile's own reminder switches gate (the account's scan switches never do). Without it none is sent. */
  reminders?: Pick<RemindersService, 'enabledFor' | 'stepDownAlertsFor' | 'missedDaysNudgeFor'>
  /** Keys the HMAC of device ids. It must be the key AuthService uses, so a push token row joins to the `devices` row of the same phone. */
  deviceIdKey: string
  now?: () => Date
  /** Makes the id of a sign-in event; a test injects a counter. */
  newId?: () => string
}

/** The switches as the app sees them. */
export type ScanNotificationSettings = Pick<NotificationSettings, 'scanFinished' | 'scanNeedsYou'>

/**
 * Which phones may be notified, and which notifications an account wants. A phone is a row keyed by the keyed hash of its device
 * id; the account and profile come from the session, so the app never says whose phone it is.
 */
export class NotificationsService {
  // Expo needs a while to hand a message to Apple or Google before it has a receipt to give.
  private static readonly RECEIPT_DELAY_SECONDS = 15 * 60

  // Generic by decision, like every push: no word about the skin, the light on it, or a score.
  private static readonly RETAKE_TEXT: Record<RejectedPhotoReason, string> = {
    'too-dark': 'Find more light and take it again',
    'turn-to-camera': 'Face the camera and take it again',
    'move-closer': 'Move a little closer and take it again',
    'face-not-centred': 'Centre your face in the frame and take it again',
    'no-face': "We couldn't find a face. Take it again",
    'image-size': 'Take it again at full size',
  }

  private readonly pushTokens: PushTokensRepository
  private readonly settingsRepository: NotificationSettingsRepository
  private readonly push: PushSender
  private readonly jobs: JobQueue
  private readonly reminders: NotificationsServiceDeps['reminders']
  private readonly now: () => Date
  private readonly newId: () => string
  // `#`, not `private`: it is the device id HMAC key, and a runtime-private field stays out of spreads and JSON.stringify.
  readonly #deviceIdKey: string

  constructor(deps: NotificationsServiceDeps) {
    this.pushTokens = deps.pushTokens
    this.settingsRepository = deps.settings
    this.push = deps.push
    this.jobs = deps.jobs
    this.reminders = deps.reminders
    this.#deviceIdKey = deps.deviceIdKey
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
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
   * Answers with the platform of the phone it deleted, for the sign-in alert's text; the most recently updated row's if the guest
   * had several, null if it had none.
   */
  async guestSignedIn(userId: string): Promise<PushToken['platform'] | null> {
    // Read before the delete on purpose: the rows are gone afterwards, and the alert wants the platform of the phone that signed in.
    const rows = await this.pushTokens.forUser(userId)
    await this.pushTokens.deleteForUser(userId)
    let latest: PushToken | undefined
    for (const row of rows) if (!latest || row.updatedAt.getTime() > latest.updatedAt.getTime()) latest = row
    return latest?.platform ?? null
  }

  /** Queues "your scan is ready" for the scan's profile. A failed enqueue is logged and swallowed: it must never fail the scan step. */
  async scanFinished(input: { userId: string; profileId: string; scanId: string; readyCount: number }): Promise<void> {
    await this.enqueue({ kind: 'scan-finished', ...input })
  }

  /**
   * Queues "your scan needs you" for the scan's profile, linking to `itemId`. `ask` counts the times this item asks again after
   * an unreadable back photo. A failed enqueue is logged and swallowed.
   */
  async scanNeedsYou(input: { userId: string; profileId: string; scanId: string; itemId: string; need: 'back-photo' | 'confirm' | 'identify'; ask?: number }): Promise<void> {
    await this.enqueue({ kind: 'scan-needs-you', ...input })
  }

  /** Queues "your face scan is ready" for the face scan's profile. A failed enqueue is logged and swallowed. */
  async faceScanReady(input: { userId: string; profileId: string; faceScanId: string }): Promise<void> {
    await this.enqueue({ kind: 'face-scan-ready', ...input })
  }

  /**
   * Queues "your face photo needs a retake" for the face scan's profile. `at` is when the scan went to needs-retake (the `updatedAt`
   * written), which makes each rejection of one scan its own notification. A failed enqueue is logged and swallowed.
   */
  async faceScanNeedsRetake(input: { userId: string; profileId: string; faceScanId: string; reason: RejectedPhotoReason; at: number }): Promise<void> {
    await this.enqueue({ kind: 'face-scan-needs-retake', ...input })
  }

  /** Queues "time for your check-in" for the profile whose chase reached its review point, keyed by the chase's day-one scan. A failed enqueue is logged and swallowed. */
  async faceCheckInDue(input: { userId: string; profileId: string; dayOneScanId: string }): Promise<void> {
    await this.enqueue({ kind: 'face-check-in-due', ...input })
  }

  /**
   * Queues the daily routine reminder for the profile: `day` is its local day and `time` the reminder's, which is what the "Done" action posts to the check-in
   * route; `title` is the entry titles, already past the wording gate. It belongs to the profile, so the body names no account. A failed enqueue is logged (without
   * the title) and swallowed. Answers whether it was queued, so the send job counts only what went out.
   */
  async routineReminder(input: { profileId: string; day: string; time: 'morning' | 'evening'; title: string; inboxId?: string }): Promise<boolean> {
    return this.enqueue({ kind: 'routine-reminder', ...input })
  }

  /**
   * Queues the step-down alert for the profile: `day` is its local day and `changes` the step-downs whose step begins that day (each a routine title and the step's fixed
   * line), at least one. One alert a day however many it lists. A failed enqueue is logged (without the text) and swallowed. Answers whether it was queued.
   */
  async stepDownAlert(input: { profileId: string; day: string; changes: { title: string; line: string }[]; inboxId?: string }): Promise<boolean> {
    return this.enqueue({ kind: 'step-down-alert', ...input })
  }

  /**
   * Queues the missed-days nudge for the profile: `since` is the first day of the run of missed days, which keys it, so a run is one nudge and a new run another. A failed
   * enqueue is logged and swallowed. Answers whether it was queued.
   */
  async missedDaysNudge(input: { profileId: string; since: string }): Promise<boolean> {
    return this.enqueue({ kind: 'missed-days-nudge', ...input })
  }

  /**
   * Queues the push for a check-in after a pause that is due: `checkDay` is the pause's check day, which keys it, so a check-in is one push for each check day and a pause whose check day
   * moves (an answer of about the same) is another. The words are the same for every pause. A failed enqueue is logged and swallowed. Answers whether it was queued.
   */
  async pauseCheckIn(input: { profileId: string; pauseId: string; checkDay: string; inboxId?: string }): Promise<boolean> {
    return this.enqueue({ kind: 'pause-check-in', ...input })
  }

  /** Whether any phone is registered for the profile, whatever account row it sits under. The reminder job reads it before it claims a send. */
  async hasPhone(profileId: string): Promise<boolean> {
    return (await this.pushTokens.forProfile(profileId)).length > 0
  }

  /**
   * Queues the security alert for the account's phones. Without an `eventId` each call is its own event and is sent; a caller
   * that passes one (the sign-in's own id) makes a repeated call for the same sign-in the same notification. `at` (default now)
   * is when the sign-in happened: a phone whose row was created at or after it is the phone that signed in, and is not alerted.
   * A failed enqueue is logged and swallowed.
   */
  async newSignIn(input: { userId: string; platform: PushToken['platform'] | null; eventId?: string; at?: number }): Promise<void> {
    await this.enqueue({
      kind: 'new-sign-in',
      userId: input.userId,
      platform: input.platform,
      eventId: input.eventId ?? this.newId(),
      at: input.at ?? this.now().getTime(),
    })
  }

  /**
   * The send job's body. Reads the account's switch and the phones now, so a change since the event is respected, then sends one
   * message per phone. At most once: a rate-limited or failed message is not tried again, since a retry would resend the others.
   * Only a failure of the whole call is retried (PushUnavailableError, rethrown); one that cannot pass fails the job for good.
   */
  async deliver(body: PushNotificationMessage): Promise<void> {
    if (!(await this.wanted(body))) return
    const phones = await this.phonesFor(body)
    if (phones.length === 0) return
    const content = NotificationsService.contentOf(body)

    // Hashed before the send, so nothing after it can throw outside the guards below.
    const tokenHashes = await Promise.all(phones.map((phone) => sha256Hex(phone.token)))

    let tickets
    try {
      tickets = await this.push.send(phones.map((phone) => ({ to: phone.token, ...content })))
    } catch (error) {
      throw NotificationsService.refusal('The push could not be sent', error)
    }

    const accepted: CheckPushReceiptsMessage['receipts'] = []
    const dead: PushToken[] = []
    let misconfigured = 0
    let notSent = 0
    for (const [index, ticket] of tickets.entries()) {
      const phone = phones[index]!
      if (ticket.status === 'ok') accepted.push({ ticketId: ticket.id, deviceHash: phone.deviceHash, tokenHash: tokenHashes[index]! })
      else if (ticket.reason === 'device-not-registered') dead.push(phone)
      else if (ticket.reason === 'misconfigured') misconfigured++
      else notSent++
    }

    // The messages have gone out, so nothing below may throw: the job's retry would send them again.
    const logPush = (outcome: string, count: number) => NotificationsService.log({ job: sendPushSpec.name, kind: body.kind, outcome, count })
    if (accepted.length > 0) logPush('sent', accepted.length)
    if (notSent > 0) logPush('not-sent', notSent)
    if (misconfigured > 0) logPush('misconfigured', misconfigured)
    try {
      for (const phone of dead) await this.pushTokens.deleteIfToken(phone.deviceHash, phone.token)
      if (dead.length > 0) logPush('dead-token-deleted', dead.length)
    } catch {
      logPush('dead-token-delete-failed', dead.length)
    }
    if (accepted.length > 0) {
      try {
        await this.jobs.enqueue(checkPushReceiptsSpec, { receipts: accepted }, { delaySeconds: NotificationsService.RECEIPT_DELAY_SECONDS })
      } catch {
        logPush('receipt-enqueue-failed', accepted.length)
      }
    }
    // Every message refused for our own setup: retrying cannot help, so the job fails for good (and is logged by the dispatcher).
    if (misconfigured === tickets.length) throw new PermanentJobError('Expo refused every push: check the push credentials')
  }

  /**
   * The receipt job's body. Deletes each phone whose receipt says its token is dead, but only while the device still holds the
   * token the push went to (its hash is in the message): a phone that registered again since is left alone. A receipt Expo
   * does not have yet is skipped; repeating the check is safe.
   */
  async checkReceipts(body: CheckPushReceiptsMessage): Promise<void> {
    let receipts
    try {
      receipts = await this.push.receipts(body.receipts.map((receipt) => receipt.ticketId))
    } catch (error) {
      throw NotificationsService.refusal('The push receipts could not be read', error)
    }

    let deleted = 0
    let misconfigured = 0
    for (const { ticketId, deviceHash, tokenHash } of body.receipts) {
      const receipt = receipts[ticketId]
      if (receipt?.status !== 'error') continue
      if (receipt.reason === 'misconfigured') misconfigured++
      if (receipt.reason !== 'device-not-registered') continue
      const row = await this.pushTokens.find(deviceHash)
      if (row && (await sha256Hex(row.token)) === tokenHash && (await this.pushTokens.deleteIfToken(deviceHash, row.token))) deleted++
    }
    if (deleted > 0) NotificationsService.log({ job: checkPushReceiptsSpec.name, outcome: 'dead-token-deleted', count: deleted })
    if (misconfigured > 0) NotificationsService.log({ job: checkPushReceiptsSpec.name, outcome: 'misconfigured', count: misconfigured })
  }

  /** Never throws: the scan step or the sign-in that triggered this must not fail because a push could not be queued. Answers whether it was queued. */
  private async enqueue(body: PushNotificationMessage): Promise<boolean> {
    try {
      await this.jobs.enqueue(sendPushSpec, body)
      return true
    } catch {
      // Ids and outcome only, and no error text: this line must carry nothing about the account or the phone.
      console.error({ outcome: 'push-enqueue-failed', kind: body.kind, ...('scanId' in body ? { scanId: body.scanId } : {}), ...('faceScanId' in body ? { faceScanId: body.faceScanId } : {}), ...('dayOneScanId' in body ? { dayOneScanId: body.dayOneScanId } : {}), ...(body.kind === 'routine-reminder' || body.kind === 'step-down-alert' || body.kind === 'missed-days-nudge' || body.kind === 'pause-check-in' ? { profileId: body.profileId } : {}) })
      return false
    }
  }

  /** Whether the account wants this notification. The sign-in alert has no switch. Read at send time. */
  private async wanted(body: PushNotificationMessage): Promise<boolean> {
    if (body.kind === 'new-sign-in') return true
    // The profile's own reminder switches, read now: a push switched off since it was queued is dropped. The account's scan switches have no say. The alert and the nudge need reminders on
    // as well as their own switch; RemindersService answers both in the one read.
    if (body.kind === 'routine-reminder' || body.kind === 'pause-check-in') return (await this.reminders?.enabledFor(body.profileId)) ?? false
    if (body.kind === 'step-down-alert') return (await this.reminders?.stepDownAlertsFor(body.profileId)) ?? false
    if (body.kind === 'missed-days-nudge') return (await this.reminders?.missedDaysNudgeFor(body.profileId)) ?? false
    const switches = NotificationsService.switchesOf(await this.settingsRepository.get(body.userId))
    switch (body.kind) {
      case 'scan-finished':
      case 'face-scan-ready':
        return switches.scanFinished
      case 'scan-needs-you':
      case 'face-scan-needs-retake':
      case 'face-check-in-due':
        return switches.scanNeedsYou
    }
  }

  /** Scan and face scan notifications go to the phones on the scan's profile, narrowed to the account; a routine reminder, step-down alert, missed-days nudge and pause check-in go to every phone of the profile; the sign-in alert goes to every phone of the account. */
  private async phonesFor(body: PushNotificationMessage): Promise<PushToken[]> {
    // A row created at or after the sign-in belongs to the phone that signed in (it registers once it has a session), so it is not alerted.
    if (body.kind === 'new-sign-in') return (await this.pushTokens.forUser(body.userId)).filter((phone) => phone.createdAt.getTime() < body.at)
    // A reminder, alert or nudge belongs to the profile, whatever account row its phones sit under.
    if (body.kind === 'routine-reminder' || body.kind === 'step-down-alert' || body.kind === 'missed-days-nudge' || body.kind === 'pause-check-in') return this.pushTokens.forProfile(body.profileId)
    // The profile's phones, narrowed to the account the message names.
    return (await this.pushTokens.forProfile(body.profileId)).filter((phone) => phone.userId === body.userId)
  }

  /** What the phone shows. Generic by decision: it appears on a lock screen, so no product names. */
  private static contentOf(body: PushNotificationMessage): Pick<PushMessage, 'title' | 'body' | 'data' | 'categoryId'> {
    switch (body.kind) {
      case 'scan-finished':
        return {
          title: 'Your scan is ready',
          body: body.readyCount === 0 ? 'Open the app to see what we found' : `${body.readyCount} ${body.readyCount === 1 ? 'product' : 'products'} analysed`,
          data: { url: deepLinkFor(body.kind, { scanId: body.scanId }), kind: body.kind, scanId: body.scanId, profileId: body.profileId },
        }
      case 'scan-needs-you': {
        const text = {
          'back-photo': 'We need a photo of the back of a product',
          confirm: 'Please confirm a product we were not sure about',
          identify: "We couldn't read a product. Tell us what it is",
        }[body.need]
        return {
          title: 'Your scan needs you',
          body: text,
          data: { url: deepLinkFor(body.kind, { scanId: body.scanId, itemId: body.itemId }), kind: body.kind, scanId: body.scanId, itemId: body.itemId, profileId: body.profileId },
        }
      }
      case 'face-scan-ready':
        return {
          title: 'Your face scan is ready',
          body: 'Open the app to see what we noticed',
          data: { url: deepLinkFor(body.kind, { faceScanId: body.faceScanId }), kind: body.kind, faceScanId: body.faceScanId, profileId: body.profileId },
        }
      case 'face-scan-needs-retake':
        return {
          title: 'Your face photo needs a retake',
          body: NotificationsService.RETAKE_TEXT[body.reason],
          data: { url: deepLinkFor(body.kind, { faceScanId: body.faceScanId }), kind: body.kind, faceScanId: body.faceScanId, reason: body.reason, profileId: body.profileId },
        }
      case 'face-check-in-due':
        return {
          title: 'Time for your check-in',
          body: 'Take a face scan to see how your skin is doing on your goal.',
          data: { url: deepLinkFor(body.kind, {}), kind: body.kind, profileId: body.profileId, dayOneScanId: body.dayOneScanId },
        }
      case 'routine-reminder':
        // The title lists the entries; the body is fixed, per time of day. `categoryId` is what makes the phone show the "Done" action, which posts `day` and `time` to the check-in route.
        return {
          ...routineReminderText(body.time, body.title),
          categoryId: 'routine-reminder',
          data: { kind: body.kind, url: deepLinkFor(body.kind, {}), profileId: body.profileId, day: body.day, time: body.time, ...NotificationsService.inboxIdOf(body) },
        }
      case 'step-down-alert':
        // Fixed copy around the routine's own words: each change is its product's plain routine title and the step's fixed line, both past the wording gate. No "Done" action: there is nothing to tick.
        return {
          ...stepDownAlertText(body.changes),
          data: { kind: body.kind, url: deepLinkFor(body.kind, {}), profileId: body.profileId, day: body.day, ...NotificationsService.inboxIdOf(body) },
        }
      case 'pause-check-in':
        // Generic: the lock screen never names the step. The pause's id is for the app, which opens the check-in from Today.
        return {
          ...pauseCheckInText(),
          data: { kind: body.kind, url: deepLinkFor(body.kind, {}), profileId: body.profileId, pauseId: body.pauseId, ...NotificationsService.inboxIdOf(body) },
        }
      case 'missed-days-nudge':
        // Kind and about nothing the person did: the same words for every run, with no date and no count.
        return {
          title: 'Pick up where you left off',
          body: 'Your routine is here whenever you are ready.',
          data: { kind: body.kind, url: deepLinkFor(body.kind, {}), profileId: body.profileId },
        }
      case 'new-sign-in': {
        const where = body.platform === 'ios' ? 'on an iPhone, ' : body.platform === 'android' ? 'on an Android phone, ' : ''
        return {
          title: 'New sign-in to your Deeper Tones account',
          body: `${where}just now`,
          data: { url: deepLinkFor(body.kind, {}), kind: body.kind },
        }
      }
    }
  }

  /** The inbox row this push is the delivery of, left out of `data` when the row could not be written. The app posts it to the tap route. */
  private static inboxIdOf({ inboxId }: { inboxId?: string }): { inboxId?: string } {
    return inboxId === undefined ? {} : { inboxId }
  }

  /** A temporary outage passes through as it is, so the job retries; anything else is our own setup and fails the job for good. */
  private static refusal(what: string, error: unknown): Error {
    // The message is ours and static (the dispatcher logs a PermanentJobError's text); the cause is only ever logged by name.
    return error instanceof PushUnavailableError ? error : new PermanentJobError(what, { cause: error })
  }

  /** Every push log line: the job, the kind when there is one, an outcome and a count. Never a token, text, link or id. */
  private static log(entry: { job: string; kind?: string; outcome: string; count: number }): void {
    console.log(entry)
  }

  private static switchesOf(row: ScanNotificationSettings | null): ScanNotificationSettings {
    return { scanFinished: row?.scanFinished ?? true, scanNeedsYou: row?.scanNeedsYou ?? true }
  }
}
