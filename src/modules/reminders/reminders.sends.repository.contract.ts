import { describe, expect, it } from 'vitest'
import type { ReminderSendsRepository } from './reminders.sends.repository'

// The one clock every fixture hangs off; days are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)
/** The calendar day `n` days from BASE's, as 'YYYY-MM-DD'. */
const day = (n: number) => new Date(BASE.getTime() + n * DAY).toISOString().slice(0, 10)

type Account = { userId: string; profileId: string }

/**
 * What a reminder-sends contract run needs: the repository, and a way to get an account that really exists, the way every account does in life (D1 enforces
 * reminder_sends.profile_id -> profiles). `newAccount` is a user with its default profile.
 *
 * THE CONTRACT THIS FILE PINS (assumed: the brief names the table (reminder_sends, PK (profile_id, local_day, kind)) and "insert-first claim, then send", not the
 * repository's methods; they follow routines.check-ins.repository.contract.ts):
 *   claim(profileId, localDay, kind, at): Promise<boolean>
 *       Tries to insert the row (profileId, localDay, kind, at). true when THIS call inserted it, false when the key was already held (the row stays as it was).
 *       localDay is a calendar date 'YYYY-MM-DD' (the person's local day when the send was due). kind is free text, not an enum, so the step-down alert
 *       ('step-down') and the missed-days nudge ('nudge:{since}', one per streak) can be added by a later PR without a migration: 'morning', 'evening',
 *       'step-down' and 'nudge:2030-06-13' are all fine.
 *       Atomic: of several claims for one key made at the same time, exactly one is true.
 */
export type ReminderSendsContractSetup = {
  repository: ReminderSendsRepository
  newAccount: () => Promise<Account>
}

/** Behaviour every ReminderSendsRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const reminderSendsRepositoryContract = (name: string, make: () => ReminderSendsContractSetup | Promise<ReminderSendsContractSetup>) => {
  describe(`ReminderSendsRepository contract: ${name}`, () => {
    it('claims a key nobody holds', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      expect(await repository.claim(profileId, day(0), 'morning', at(MINUTE))).toBe(true)
    })

    it('refuses a key already held, however much later it is asked and whatever moment it carries', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      await repository.claim(profileId, day(0), 'morning', at(MINUTE))

      expect(await repository.claim(profileId, day(0), 'morning', at(MINUTE))).toBe(false)
      expect(await repository.claim(profileId, day(0), 'morning', at(10 * MINUTE))).toBe(false)
    })

    it('holds one claim per kind: the morning and the evening of one day are two claims', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      expect(await repository.claim(profileId, day(0), 'morning', at(MINUTE))).toBe(true)
      expect(await repository.claim(profileId, day(0), 'evening', at(MINUTE))).toBe(true)
      expect(await repository.claim(profileId, day(0), 'step-down', at(MINUTE))).toBe(true)
    })

    it('holds one claim per local day: the same kind on the next day, and on the day before, is a new claim', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      await repository.claim(profileId, day(0), 'morning', at(MINUTE))

      expect(await repository.claim(profileId, day(1), 'morning', at(MINUTE))).toBe(true)
      expect(await repository.claim(profileId, day(-1), 'morning', at(MINUTE))).toBe(true)
      expect(await repository.claim(profileId, day(0), 'morning', at(MINUTE))).toBe(false)
    })

    it('takes a kind as free text and tells apart kinds that differ only after a colon', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      expect(await repository.claim(profileId, day(0), `nudge:${day(-2)}`, at(MINUTE))).toBe(true)
      expect(await repository.claim(profileId, day(0), `nudge:${day(-3)}`, at(MINUTE))).toBe(true)
      expect(await repository.claim(profileId, day(0), `nudge:${day(-2)}`, at(MINUTE))).toBe(false)
    })

    it('keeps each profile\'s claims apart', async () => {
      const { repository, newAccount } = await make()
      const first = await newAccount()
      const stranger = await newAccount()
      await repository.claim(first.profileId, day(0), 'morning', at(MINUTE))

      expect(await repository.claim(stranger.profileId, day(0), 'morning', at(MINUTE))).toBe(true)
      expect(await repository.claim(first.profileId, day(0), 'morning', at(MINUTE))).toBe(false)
    })

    it('lets exactly one of several claims made at the same time for the same key win', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      const results = await Promise.all(Array.from({ length: 5 }, () => repository.claim(profileId, day(0), 'evening', at(MINUTE))))

      expect(results.filter(Boolean)).toHaveLength(1)
    })
  })
}
