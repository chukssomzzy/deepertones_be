import { requireUser } from '../../lib/context'
import { ForbiddenError, ValidationError } from '../../lib/errors'
import { localDay } from '../../lib/local-day'
import type { InboxService } from '../inbox/inbox.service'
import type { ProfilesService } from '../profiles/profiles.service'
import type { UsersService } from '../users/users.service'
import type { RemindersRepository } from './reminders.repository'
import type { ReminderSettings, ReminderSettingsPatch } from './reminders.types'

export type RemindersServiceDeps = {
  repository: RemindersRepository
  /** Read for the account's verified phone, which is its WhatsApp address. */
  users: Pick<UsersService, 'get'>
  /** Read to get from a profile id to the account whose phone decides the nudge's channel. */
  profiles: Pick<ProfilesService, 'find'>
  /** Whether WhatsApp is an enabled OTP channel in this environment; the container derives it from OTP_CHANNELS. */
  whatsappEnabled: boolean
  /** Where turning reminders off tells the person (the `reminders-off` inbox row). */
  inbox: Pick<InboxService, 'write'>
  now?: () => Date
}

/** The settings as the app sees them. `missedDaysChannel` is read-only: worked out at each read, never stored. */
export type ReminderSettingsView = Pick<ReminderSettings, 'enabled' | 'morning' | 'evening' | 'timeZone' | 'stepDownAlerts' | 'missedDaysNudge'> & {
  missedDaysChannel: 'push' | 'whatsapp'
}

/**
 * A profile's reminder settings (spec #217): when to be reminded, in which time zone, and which alerts are wanted. The zone is also read by other modules
 * (`zoneFor`) to find where a person's local day begins. Nothing is sent from here.
 */
export class RemindersService {
  private static readonly TIME = /^([01]\d|2[0-3]):[0-5]\d$/
  private static readonly MAX_ZONE_LENGTH = 64
  // A fixed offset is not a place: it would be wrong for half the year wherever clocks change. Runtimes differ on whether Intl takes these.
  private static readonly FIXED_OFFSET = /^(?:(?:UTC|GMT)\s*)?[+-]/i

  private static readonly DEFAULTS: Omit<ReminderSettingsView, 'missedDaysChannel'> = {
    enabled: false,
    morning: '07:00',
    evening: '21:00',
    timeZone: null,
    stepDownAlerts: true,
    missedDaysNudge: true,
  }

  private readonly repository: RemindersRepository
  private readonly users: RemindersServiceDeps['users']
  private readonly profiles: RemindersServiceDeps['profiles']
  private readonly whatsappEnabled: boolean
  private readonly inbox: RemindersServiceDeps['inbox']
  private readonly now: () => Date

  constructor(deps: RemindersServiceDeps) {
    this.repository = deps.repository
    this.users = deps.users
    this.profiles = deps.profiles
    this.whatsappEnabled = deps.whatsappEnabled
    this.inbox = deps.inbox
    this.now = deps.now ?? (() => new Date())
  }

  /** The session profile's settings; the defaults until it saves any, and reading writes nothing. A guest is 403 `SIGNUP_REQUIRED`. */
  async settings(): Promise<ReminderSettingsView> {
    const { userId, profileId } = RemindersService.signedUp()
    return this.viewOf(userId, await this.repository.get(profileId))
  }

  /**
   * Changes only the settings named and answers with all of them. 403 `SIGNUP_REQUIRED` for a guest, before this method looks at the values. Over HTTP the
   * route's body schema runs first (wrong types, an unknown field, an empty body: 400), so a guest sending a malformed body gets that 400, not the 403. Then 400
   * `VALIDATION_FAILED` for a time that is not 24-hour 'HH:MM' or a zone Intl does not know (a refused call stores nothing). The zone is stored under
   * its canonical name; a null zone clears it.
   *
   * A change from on to off writes one inbox row, `reminders-off:{day}`, for the local day in the zone the row has after the change (so a zone named in the same call counts); turning them
   * off again, or off when they were never on, writes nothing. The row is not the update: if it cannot be written the update stands, and the failure is logged by the profile id alone.
   */
  async update(patch: ReminderSettingsPatch): Promise<ReminderSettingsView> {
    const { userId, profileId } = RemindersService.signedUp()
    const checked = RemindersService.checked(patch)
    const wasOn = checked.enabled === false && ((await this.repository.get(profileId))?.enabled ?? false)
    const now = this.now()
    const saved = await this.repository.upsert(profileId, await this.withEnabledOn(profileId, checked), now)
    if (wasOn) await this.writeRemindersOff(profileId, localDay(now, saved.timeZone))
    return this.viewOf(userId, saved)
  }

  /** The profile's stored time zone by profile id, with no session (a job and the routine service call it); null while none is stored. */
  async zoneFor(profileId: string): Promise<string | null> {
    return (await this.repository.get(profileId))?.timeZone ?? null
  }

  /** The zone and the on switch together, from one read, by profile id with no session (Today reads both): no zone and off with no row, and for an unknown profile. */
  async zoneAndEnabledFor(profileId: string): Promise<{ zone: string | null; enabled: boolean }> {
    const row = await this.repository.get(profileId)
    return { zone: row?.timeZone ?? null, enabled: row?.enabled ?? false }
  }

  /** Whether the profile has reminders on, by profile id with no session (the notification send reads it); false with no row, and for an unknown profile. */
  async enabledFor(profileId: string): Promise<boolean> {
    return (await this.repository.get(profileId))?.enabled ?? false
  }

  /** Whether the profile wants step-down alerts: reminders on and the alerts switch on. By profile id with no session; false with no row, and for an unknown profile. */
  async stepDownAlertsFor(profileId: string): Promise<boolean> {
    const row = await this.repository.get(profileId)
    return (row?.enabled && row.stepDownAlerts) ?? false
  }

  /** Whether the profile wants the missed-days nudge: reminders on and the nudge switch on. By profile id with no session; false with no row, and for an unknown profile. */
  async missedDaysNudgeFor(profileId: string): Promise<boolean> {
    const row = await this.repository.get(profileId)
    return (row?.enabled && row.missedDaysNudge) ?? false
  }

  /** The channel the nudge goes by for the profile's account, by the rule the view's `missedDaysChannel` follows; a push for a profile that does not exist. */
  async missedDaysChannelFor(profileId: string): Promise<'push' | 'whatsapp'> {
    const profile = await this.profiles.find(profileId)
    return profile === null ? 'push' : this.channelFor(profile.userId)
  }

  /**
   * Stamps `enabledOn` (the local day, in the zone the row will have) when the patch turns reminders on from off or no row, which is what the missed-days nudge counts from. A patch
   * that leaves them on, or does not name `enabled`, keeps the stored day, so a zone-only change moves nothing; turning them off and on again stamps the new day.
   */
  private async withEnabledOn(profileId: string, patch: ReminderSettingsPatch): Promise<ReminderSettingsPatch> {
    if (patch.enabled !== true) return patch
    const current = await this.repository.get(profileId)
    if (current?.enabled) return patch
    const zone = patch.timeZone === undefined ? (current?.timeZone ?? null) : patch.timeZone
    return { ...patch, enabledOn: localDay(this.now(), zone) }
  }

  // Copy awaiting the owner's sign-off.
  private async writeRemindersOff(profileId: string, day: string): Promise<void> {
    try {
      await this.inbox.write({
        profileId,
        kind: 'reminders-off',
        day,
        title: 'Reminders are off',
        body: 'You will not get reminders until you turn them back on. Your routine is still here.',
        link: '/routine',
        key: `reminders-off:${day}`,
      })
    } catch {
      console.error({ outcome: 'reminders-off-inbox-write-failed', profileId })
    }
  }

  private static signedUp() {
    const user = requireUser()
    if (user.status !== 'verified') throw new ForbiddenError('SIGNUP_REQUIRED', 'Sign up to set reminders')
    return user
  }

  private static checked(patch: ReminderSettingsPatch): ReminderSettingsPatch {
    for (const field of ['morning', 'evening'] as const) {
      const time = patch[field]
      if (time !== undefined && !RemindersService.TIME.test(time)) throw new ValidationError('VALIDATION_FAILED', `${field} must be a 24-hour time like 07:30`)
    }
    if (patch.timeZone === undefined || patch.timeZone === null) return patch
    return { ...patch, timeZone: RemindersService.canonicalZone(patch.timeZone) }
  }

  /** The zone's canonical IANA name ('africa/lagos' is 'Africa/Lagos'). Anything Intl does not resolve, and any fixed offset, is refused. */
  private static canonicalZone(zone: string): string {
    const refused = new ValidationError('VALIDATION_FAILED', 'timeZone must be an IANA time zone like Africa/Lagos')
    if (zone === '' || zone.length > RemindersService.MAX_ZONE_LENGTH || RemindersService.FIXED_OFFSET.test(zone)) throw refused
    let canonical: string
    try {
      canonical = new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone
    } catch {
      throw refused
    }
    if (RemindersService.FIXED_OFFSET.test(canonical)) throw refused
    return canonical
  }

  private async viewOf(userId: string, row: ReminderSettings | null): Promise<ReminderSettingsView> {
    const { DEFAULTS } = RemindersService
    return {
      enabled: row?.enabled ?? DEFAULTS.enabled,
      morning: row?.morning ?? DEFAULTS.morning,
      evening: row?.evening ?? DEFAULTS.evening,
      timeZone: row?.timeZone ?? DEFAULTS.timeZone,
      stepDownAlerts: row?.stepDownAlerts ?? DEFAULTS.stepDownAlerts,
      missedDaysNudge: row?.missedDaysNudge ?? DEFAULTS.missedDaysNudge,
      missedDaysChannel: await this.channelFor(userId),
    }
  }

  /** WhatsApp only when it is an enabled channel here and the account has a phone (a phone is only ever stored by verifying a WhatsApp code); otherwise a push. */
  private async channelFor(userId: string): Promise<'push' | 'whatsapp'> {
    if (!this.whatsappEnabled) return 'push'
    return (await this.users.get(userId)).phone === null ? 'push' : 'whatsapp'
  }
}
