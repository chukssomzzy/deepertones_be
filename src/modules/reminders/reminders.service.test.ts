import { beforeEach, describe, expect, it } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import type { PhoneNumber } from '../../lib/phone'
import type { UsersService } from '../users/users.service'
import type { User } from '../users/users.types'
import { FakeRemindersRepository } from './reminders.repository.fake'
import { RemindersService } from './reminders.service'

// Reminder settings (spec #217, PR 3): what the routes call, and the one reader other modules use. The users service is a Pick<> fake that answers from one mutable
// `world`; the repository is the real fake.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the behaviour, not the constructor or the method names; they follow NotificationsService):
//   new RemindersService({ repository, users, whatsappEnabled, now? })
//     repository       RemindersRepository (get, upsert; see reminders.repository.contract.ts)
//     users            Pick<UsersService, 'get'>   read for the account's verified phone (the WhatsApp address)
//     whatsappEnabled  boolean   whether WhatsApp is an enabled OTP channel in this environment; the container derives it from OTP_CHANNELS
//   settings(): Promise<ReminderSettingsView>                 the session profile's settings; the defaults when it never saved any
//   update(patch): Promise<ReminderSettingsView>              writes only the fields named (enabled, morning, evening, timeZone, stepDownAlerts, missedDaysNudge), answers all of them
//   zoneFor(profileId): Promise<string | null>                by profile id, no session (a job and the routine service call it); null while no zone is stored
//   ReminderSettingsView = { enabled, morning, evening, timeZone, stepDownAlerts, missedDaysNudge, missedDaysChannel: 'push' | 'whatsapp' } and nothing else
//   Gates, in order: 401 (no session, from requireUser), 403 SIGNUP_REQUIRED for a guest (the same check and code as the routine service), then validation.
//   Validation (ValidationError, code VALIDATION_FAILED, nothing stored): a time must be 24-hour 'HH:MM'; a time zone must be one Intl.DateTimeFormat knows.
//   missedDaysChannel is 'whatsapp' only when whatsappEnabled AND the account's user row has a phone (a phone is only ever stored by verifying a WhatsApp code);
//   otherwise 'push'. It is read-only: never stored, always worked out at the read.

const T0 = new Date('2030-06-15T12:00:00.000Z')

const AMARA_USER = 'user-amara'
const AMARA = 'profile-amara-1'
const AMARA_SECOND = 'profile-amara-2'
const TOLU_USER = 'user-tolu'
const TOLU = 'profile-tolu-1'

const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'verified'): Actor => ({ kind: 'user', userId, status, profileId })
const AMARA_ACTOR = actor(AMARA_USER, AMARA)
const AMARA_ON_SECOND = actor(AMARA_USER, AMARA_SECOND)
const TOLU_ACTOR = actor(TOLU_USER, TOLU)
const GUEST = actor('user-guest', 'profile-guest', 'anonymous')
const PUBLIC: Actor = { kind: 'public' }
const SYSTEM: Actor = { kind: 'system', job: 'build-routine' }

const DEFAULTS = { enabled: false, morning: '07:00', evening: '21:00', timeZone: null, stepDownAlerts: true, missedDaysNudge: true, missedDaysChannel: 'push' }

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

/** The users the world knows: id -> the phone they verified, or null. */
let phones: Map<string, string | null>
let repository: FakeRemindersRepository
let service: RemindersService

const userRow = (id: string): User => ({ id, status: 'verified', email: null, phone: (phones.get(id) ?? null) as PhoneNumber | null, tokenVersion: 0, createdAt: T0, lastSeenAt: T0 })

const makeService = (whatsappEnabled: boolean) =>
  new RemindersService({
    repository,
    users: { get: async (id: string) => userRow(id) } satisfies Pick<UsersService, 'get'>,
    whatsappEnabled,
    now: () => T0,
  })

const settings = (who: Actor) => runAs(who, () => service.settings())
const update = (who: Actor, patch: Parameters<RemindersService['update']>[0]) => runAs(who, () => service.update(patch))
const zoneFor = (profileId: string) => runAs(SYSTEM, () => service.zoneFor(profileId))

beforeEach(() => {
  phones = new Map([
    [AMARA_USER, null],
    [TOLU_USER, '+2348031234567'],
  ])
  repository = new FakeRemindersRepository()
  service = makeService(false)
})

describe('RemindersService.settings', () => {
  it('answers the defaults, and exactly these fields, for a profile that never saved anything', async () => {
    expect(await settings(AMARA_ACTOR)).toEqual(DEFAULTS)
  })

  it('shows what the profile saved, with the other fields at their defaults', async () => {
    await update(AMARA_ACTOR, { enabled: true, morning: '06:30' })

    expect(await settings(AMARA_ACTOR)).toEqual({ ...DEFAULTS, enabled: true, morning: '06:30' })
  })

  it('keeps settings per profile: another profile of the same account, and another account, still read the defaults', async () => {
    await update(AMARA_ACTOR, { enabled: true, timeZone: 'Africa/Lagos' })

    expect(await settings(AMARA_ON_SECOND)).toEqual(DEFAULTS)
    expect(await settings(TOLU_ACTOR)).toEqual(DEFAULTS)
    expect(await settings(AMARA_ACTOR)).toEqual({ ...DEFAULTS, enabled: true, timeZone: 'Africa/Lagos' })
  })
})

describe('RemindersService.update', () => {
  it('changes only the fields named, answers all of them, and a later read shows the same', async () => {
    const first = await update(AMARA_ACTOR, { enabled: true })
    const second = await update(AMARA_ACTOR, { evening: '22:30', stepDownAlerts: false })

    expect(first).toEqual({ ...DEFAULTS, enabled: true })
    expect(second).toEqual({ ...DEFAULTS, enabled: true, evening: '22:30', stepDownAlerts: false })
    expect(await settings(AMARA_ACTOR)).toEqual(second)
  })

  it('writes every settable field in one call, and can turn a switch back on', async () => {
    const all = { enabled: true, morning: '05:45', evening: '23:15', timeZone: 'Europe/London', stepDownAlerts: false, missedDaysNudge: false }
    expect(await update(AMARA_ACTOR, all)).toEqual({ ...all, missedDaysChannel: 'push' })

    expect(await update(AMARA_ACTOR, { enabled: false, missedDaysNudge: true })).toEqual({ ...all, enabled: false, missedDaysNudge: true, missedDaysChannel: 'push' })
  })

  it('allows a PUT of only the time zone (the phone updates it when it changes), leaving reminders off', async () => {
    expect(await update(AMARA_ACTOR, { timeZone: 'Africa/Lagos' })).toEqual({ ...DEFAULTS, timeZone: 'Africa/Lagos' })

    expect(await update(AMARA_ACTOR, { timeZone: 'America/New_York' })).toEqual({ ...DEFAULTS, timeZone: 'America/New_York' })
  })

  it('does not touch another profile\'s settings', async () => {
    await update(TOLU_ACTOR, { enabled: true, morning: '08:00' })

    await update(AMARA_ACTOR, { enabled: true, morning: '06:00' })

    expect(await settings(TOLU_ACTOR)).toEqual({ ...DEFAULTS, enabled: true, morning: '08:00', missedDaysChannel: 'push' })
  })
})

describe('RemindersService.update: validation', () => {
  it.each(['00:00', '07:00', '12:34', '23:59'])('accepts %s as a time, both ends of the day included', async (time) => {
    expect(await update(AMARA_ACTOR, { morning: time, evening: time })).toMatchObject({ morning: time, evening: time })
  })

  it.each([
    ['24:00, one past the last hour', '24:00'],
    ['23:60, one past the last minute', '23:60'],
    ['an hour with one digit', '7:00'],
    ['a minute with one digit', '07:5'],
    ['seconds', '07:00:00'],
    ['12-hour time', '7:00 PM'],
    ['no colon', '0700'],
    ['an empty string', ''],
    ['words', 'morning'],
  ])('refuses %s as a time with VALIDATION_FAILED, for the morning and for the evening', async (_label, time) => {
    for (const field of ['morning', 'evening'] as const) {
      const error = await errorOf(update(AMARA_ACTOR, { [field]: time }))
      expect(error).toMatchObject({ name: 'ValidationError', code: 'VALIDATION_FAILED' })
    }
  })

  it.each([
    ['a city with no region', 'Lagos'],
    ['a zone that does not exist', 'Mars/Phobos'],
    ['an empty string', ''],
    ['text that is not a zone at all', 'Africa/Lagos; DROP TABLE users'],
  ])('refuses %s as a time zone with VALIDATION_FAILED', async (_label, zone) => {
    const error = await errorOf(update(AMARA_ACTOR, { timeZone: zone }))

    expect(error).toMatchObject({ name: 'ValidationError', code: 'VALIDATION_FAILED' })
  })

  it.each(['Africa/Lagos', 'Europe/London', 'America/New_York'])('accepts %s as a time zone', async (zone) => {
    expect(await update(AMARA_ACTOR, { timeZone: zone })).toMatchObject({ timeZone: zone })
  })

  it.each([
    ['africa/lagos', 'Africa/Lagos'],
    ['EUROPE/LONDON', 'Europe/London'],
    ['america/new_york', 'America/New_York'],
  ])('stores %s under its canonical name %s', async (given, canonical) => {
    expect(await update(AMARA_ACTOR, { timeZone: given })).toMatchObject({ timeZone: canonical })
    expect(await zoneFor(AMARA)).toBe(canonical)
  })

  it.each([
    ['an offset with a colon', '+01:00'],
    ['a negative offset', '-05:00'],
    ['UTC with an offset', 'UTC+1'],
    ['GMT with an offset', 'GMT-5'],
  ])('refuses a fixed offset (%s) as a time zone with VALIDATION_FAILED', async (_label, zone) => {
    const error = await errorOf(update(AMARA_ACTOR, { timeZone: zone }))

    expect(error).toMatchObject({ name: 'ValidationError', code: 'VALIDATION_FAILED' })
    expect(await zoneFor(AMARA)).toBeNull()
  })

  it('clears the zone with null, leaving the other settings', async () => {
    await update(AMARA_ACTOR, { enabled: true, timeZone: 'Africa/Lagos' })

    expect(await update(AMARA_ACTOR, { timeZone: null })).toEqual({ ...DEFAULTS, enabled: true })
    expect(await zoneFor(AMARA)).toBeNull()
  })

  it('stores nothing from a call that is refused, even the valid fields in it', async () => {
    await update(AMARA_ACTOR, { timeZone: 'Africa/Lagos', morning: '06:00' })

    await errorOf(update(AMARA_ACTOR, { enabled: true, evening: '22:00', timeZone: 'Mars/Phobos' }))
    await errorOf(update(AMARA_ACTOR, { enabled: true, morning: '25:00' }))

    expect(await settings(AMARA_ACTOR)).toEqual({ ...DEFAULTS, timeZone: 'Africa/Lagos', morning: '06:00' })
    expect(await zoneFor(AMARA)).toBe('Africa/Lagos')
  })
})

describe('RemindersService: who may use it', () => {
  it('refuses a guest with 403 SIGNUP_REQUIRED, to read and to write, and stores nothing', async () => {
    const read = await errorOf(settings(GUEST))
    const write = await errorOf(update(GUEST, { enabled: true, timeZone: 'Africa/Lagos' }))

    expect(read).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(write).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(await zoneFor('profile-guest')).toBeNull()
  })

  it('refuses a guest before it looks at the input: a bad time from a guest is still SIGNUP_REQUIRED', async () => {
    expect(await errorOf(update(GUEST, { morning: '99:99' }))).toMatchObject({ code: 'SIGNUP_REQUIRED' })
  })

  it('answers 401 AUTH_REQUIRED to a caller with no session', async () => {
    expect(await errorOf(settings(PUBLIC))).toMatchObject({ name: 'UnauthorizedError', code: 'AUTH_REQUIRED' })
    expect(await errorOf(update(PUBLIC, { enabled: true }))).toMatchObject({ name: 'UnauthorizedError', code: 'AUTH_REQUIRED' })
  })
})

describe('RemindersService: missedDaysChannel', () => {
  // The channel back to the person for "you have missed some days": WhatsApp when it can be used, otherwise a push.
  it.each([
    ['WhatsApp is enabled here and the account has a verified phone', true, TOLU_ACTOR, 'whatsapp'],
    ['WhatsApp is enabled here but the account has no verified phone', true, AMARA_ACTOR, 'push'],
    ['the account has a verified phone but WhatsApp is not enabled here', false, TOLU_ACTOR, 'push'],
    ['WhatsApp is not enabled here and the account has no phone', false, AMARA_ACTOR, 'push'],
  ])('is decided when %s', async (_label, whatsappEnabled, who, channel) => {
    service = makeService(whatsappEnabled)

    expect(await settings(who)).toMatchObject({ missedDaysChannel: channel })
    expect(await update(who, { missedDaysNudge: false })).toMatchObject({ missedDaysChannel: channel })
  })

  it('follows the account\'s phone as it changes, since it is worked out at each read and never stored', async () => {
    service = makeService(true)
    expect(await settings(AMARA_ACTOR)).toMatchObject({ missedDaysChannel: 'push' })

    phones.set(AMARA_USER, '+2348039999999')

    expect(await settings(AMARA_ACTOR)).toMatchObject({ missedDaysChannel: 'whatsapp' })
  })

  it('is the same for every profile of the account', async () => {
    service = makeService(true)
    phones.set(AMARA_USER, '+2348039999999')

    expect(await settings(AMARA_ACTOR)).toMatchObject({ missedDaysChannel: 'whatsapp' })
    expect(await settings(AMARA_ON_SECOND)).toMatchObject({ missedDaysChannel: 'whatsapp' })
  })
})

describe('RemindersService.zoneFor', () => {
  it('is null for a profile that never saved anything', async () => {
    expect(await zoneFor(AMARA)).toBeNull()
  })

  it('is null while the profile has saved settings but no zone', async () => {
    await update(AMARA_ACTOR, { enabled: true })

    expect(await zoneFor(AMARA)).toBeNull()
  })

  it('answers the zone the profile saved, by profile id and with no session, and follows a change of zone', async () => {
    await update(AMARA_ACTOR, { timeZone: 'Africa/Lagos' })
    expect(await zoneFor(AMARA)).toBe('Africa/Lagos')

    await update(AMARA_ACTOR, { timeZone: 'Europe/London' })

    expect(await zoneFor(AMARA)).toBe('Europe/London')
  })

  it('keeps zones per profile', async () => {
    await update(AMARA_ACTOR, { timeZone: 'Africa/Lagos' })
    await update(AMARA_ON_SECOND, { timeZone: 'America/New_York' })

    expect(await zoneFor(AMARA)).toBe('Africa/Lagos')
    expect(await zoneFor(AMARA_SECOND)).toBe('America/New_York')
    expect(await zoneFor(TOLU)).toBeNull()
  })

  it('is null for a profile that does not exist', async () => {
    expect(await zoneFor('profile-nobody')).toBeNull()
  })
})
