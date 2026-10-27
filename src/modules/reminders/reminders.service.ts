import { requireUser } from '../../lib/context'
import { ForbiddenError, ValidationError } from '../../lib/errors'
import type { UsersService } from '../users/users.service'
import type { RemindersRepository } from './reminders.repository'
import type { ReminderSettings, ReminderSettingsPatch } from './reminders.types'

export type RemindersServiceDeps = {
  repository: RemindersRepository
  /** Read for the account's verified phone, which is its WhatsApp address. */
  users: Pick<UsersService, 'get'>
  /** Whether WhatsApp is an enabled OTP channel in this environment; the container derives it from OTP_CHANNELS. */
  whatsappEnabled: boolean
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
  private readonly whatsappEnabled: boolean
  private readonly now: () => Date

  constructor(deps: RemindersServiceDeps) {
    this.repository = deps.repository
    this.users = deps.users
    this.whatsappEnabled = deps.whatsappEnabled
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
   */
  async update(patch: ReminderSettingsPatch): Promise<ReminderSettingsView> {
    const { userId, profileId } = RemindersService.signedUp()
    const checked = RemindersService.checked(patch)
    return this.viewOf(userId, await this.repository.upsert(profileId, checked, this.now()))
  }

  /** The profile's stored time zone by profile id, with no session (a job and the routine service call it); null while none is stored. */
  async zoneFor(profileId: string): Promise<string | null> {
    return (await this.repository.get(profileId))?.timeZone ?? null
  }

  /** Whether the profile has reminders on, by profile id with no session (the notification send reads it); false with no row, and for an unknown profile. */
  async enabledFor(profileId: string): Promise<boolean> {
    return (await this.repository.get(profileId))?.enabled ?? false
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
