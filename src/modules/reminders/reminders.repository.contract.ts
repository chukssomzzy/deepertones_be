import { describe, expect, it } from 'vitest'
import type { RemindersRepository } from './reminders.repository'

// The one clock every fixture hangs off; later times are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

type Account = { userId: string; profileId: string }

/**
 * What a reminder-settings contract run needs: the repository, and a way to get an account that really exists, the way every account does in
 * life (D1 enforces reminder_settings.profile_id -> profiles). `newAccount` is a user with its default profile; `newProfile` adds another profile
 * to that user.
 *
 * THE CONTRACT THIS FILE PINS (assumed: the brief names the module, not the repository's methods; they follow NotificationSettingsRepository):
 *   get(profileId): Promise<ReminderSettings | null>      null while the profile never saved a setting
 *   upsert(profileId, patch, at): Promise<ReminderSettings>   writes only the fields in `patch`, a new row starting from the defaults, and returns the whole row
 *   ReminderSettings = { profileId, enabled, morning, evening, timeZone, stepDownAlerts, missedDaysNudge, updatedAt }
 *   the defaults of a new row: enabled false, morning '07:00', evening '21:00', timeZone null, stepDownAlerts true, missedDaysNudge true
 *   listEnabled(): Promise<ReminderSettings[]>             every row whose `enabled` is true, whole (PR 4b's send job reads it, once per run), in no particular order; a disabled
 *                                                          profile and one with no row are not in it
 *   One row per profile (not per user): two profiles of one account keep their own settings.
 */
export type RemindersContractSetup = {
  repository: RemindersRepository
  newAccount: () => Promise<Account>
  newProfile: (userId: string) => Promise<string>
}

const DEFAULTS = { enabled: false, morning: '07:00', evening: '21:00', timeZone: null, stepDownAlerts: true, missedDaysNudge: true }

/** Behaviour every RemindersRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const remindersRepositoryContract = (name: string, make: () => RemindersContractSetup | Promise<RemindersContractSetup>) => {
  describe(`RemindersRepository contract: ${name}`, () => {
    it('has no row for a profile that never saved a setting', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      expect(await repository.get(profileId)).toBeNull()
    })

    it('creates the row from a partial patch, every other field at its default, and returns the whole row', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      const saved = await repository.upsert(profileId, { enabled: true }, at(MINUTE))

      expect(saved).toMatchObject({ profileId, ...DEFAULTS, enabled: true })
      expect(saved.updatedAt.getTime()).toBe(at(MINUTE).getTime())
      const read = await repository.get(profileId)
      expect(read).toMatchObject({ profileId, ...DEFAULTS, enabled: true })
      expect(read!.updatedAt.getTime()).toBe(at(MINUTE).getTime())
    })

    it('creates a row holding only a time zone (the phone reports its zone before anything else is set)', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      const saved = await repository.upsert(profileId, { timeZone: 'Africa/Lagos' }, at(MINUTE))

      expect(saved).toMatchObject({ ...DEFAULTS, timeZone: 'Africa/Lagos' })
    })

    it('merges a later patch into the stored row instead of resetting the fields it does not name', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      await repository.upsert(profileId, { enabled: true, morning: '06:30', timeZone: 'Africa/Lagos' }, at(MINUTE))

      const saved = await repository.upsert(profileId, { evening: '22:15', missedDaysNudge: false }, at(2 * MINUTE))

      expect(saved).toMatchObject({ enabled: true, morning: '06:30', evening: '22:15', timeZone: 'Africa/Lagos', stepDownAlerts: true, missedDaysNudge: false })
      expect(saved.updatedAt.getTime()).toBe(at(2 * MINUTE).getTime())
      expect(await repository.get(profileId)).toMatchObject({ enabled: true, morning: '06:30', evening: '22:15', timeZone: 'Africa/Lagos', stepDownAlerts: true, missedDaysNudge: false })
    })

    it('writes every field from a patch that names them all', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      const saved = await repository.upsert(
        profileId,
        { enabled: true, morning: '05:45', evening: '23:59', timeZone: 'Europe/London', stepDownAlerts: false, missedDaysNudge: false },
        at(MINUTE),
      )

      expect(saved).toMatchObject({ enabled: true, morning: '05:45', evening: '23:59', timeZone: 'Europe/London', stepDownAlerts: false, missedDaysNudge: false })
    })

    it('turns a switch back on and changes a zone', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      await repository.upsert(profileId, { enabled: true, stepDownAlerts: false, timeZone: 'Africa/Lagos' }, at(MINUTE))

      const saved = await repository.upsert(profileId, { stepDownAlerts: true, enabled: false, timeZone: 'America/New_York' }, at(2 * MINUTE))

      expect(saved).toMatchObject({ enabled: false, stepDownAlerts: true, timeZone: 'America/New_York' })
    })

    it('keeps each profile\'s settings apart, including two profiles of the same account', async () => {
      const { repository, newAccount, newProfile } = await make()
      const { userId, profileId: first } = await newAccount()
      const second = await newProfile(userId)
      const stranger = (await newAccount()).profileId

      await repository.upsert(first, { enabled: true, timeZone: 'Africa/Lagos' }, at(MINUTE))

      expect(await repository.get(second)).toBeNull()
      expect(await repository.get(stranger)).toBeNull()
      expect(await repository.get(first)).toMatchObject({ enabled: true, timeZone: 'Africa/Lagos' })
      expect(await repository.upsert(second, { morning: '08:00' }, at(2 * MINUTE))).toMatchObject({ ...DEFAULTS, morning: '08:00' })
      expect(await repository.get(first)).toMatchObject({ enabled: true, morning: '07:00', timeZone: 'Africa/Lagos' })
    })

    it('lists only the profiles that have reminders on, each row whole', async () => {
      const { repository, newAccount } = await make()
      const on = (await newAccount()).profileId
      const alsoOn = (await newAccount()).profileId
      const off = (await newAccount()).profileId
      const switchedOff = (await newAccount()).profileId
      await newAccount()
      await repository.upsert(on, { enabled: true, morning: '06:30', timeZone: 'Africa/Lagos' }, at(MINUTE))
      await repository.upsert(alsoOn, { enabled: true, stepDownAlerts: false }, at(MINUTE))
      await repository.upsert(off, { morning: '08:00', timeZone: 'Europe/London' }, at(MINUTE))
      await repository.upsert(switchedOff, { enabled: true }, at(MINUTE))
      await repository.upsert(switchedOff, { enabled: false }, at(2 * MINUTE))

      const listed = await repository.listEnabled()

      const mine = listed.filter((row) => [on, alsoOn, off, switchedOff].includes(row.profileId))
      expect(mine.map((row) => row.profileId).sort()).toEqual([on, alsoOn].sort())
      expect(mine.find((row) => row.profileId === on)).toMatchObject({ ...DEFAULTS, enabled: true, morning: '06:30', timeZone: 'Africa/Lagos' })
      expect(mine.find((row) => row.profileId === alsoOn)).toMatchObject({ ...DEFAULTS, enabled: true, stepDownAlerts: false })
    })

    it('answers an empty patch with the stored values (or the defaults when there is no row), and does not fail', async () => {
      const { repository, newAccount } = await make()
      const fresh = (await newAccount()).profileId
      const changed = (await newAccount()).profileId
      await repository.upsert(changed, { morning: '06:00' }, at(MINUTE))

      expect(await repository.upsert(fresh, {}, at(2 * MINUTE))).toMatchObject({ profileId: fresh, ...DEFAULTS })
      expect(await repository.upsert(changed, {}, at(2 * MINUTE))).toMatchObject({ ...DEFAULTS, morning: '06:00' })
    })
  })
}
