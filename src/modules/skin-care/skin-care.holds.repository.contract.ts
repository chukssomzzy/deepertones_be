import { describe, expect, it } from 'vitest'
import { ESCALATION_REASONS } from '../catalog/catalog.vocabulary'
import type { EscalationHoldsRepository } from './skin-care.holds.repository'
import type { EscalationHold, NewEscalationHold } from './skin-care.types'
import { HOLD_CLOSE_HOW } from './skin-care.vocabulary'

// The one clock every fixture hangs off; later times are offsets from it. Days are calendar dates 'YYYY-MM-DD' anchored to the same day.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)
const dayAt = (offsetDays: number) => at(offsetDays * DAY).toISOString().slice(0, 10)

type Account = { userId: string; profileId: string }

/**
 * What an escalation-holds contract run needs: the repository, and a way to get an account that really exists, the way every account does in life (D1 enforces
 * escalation_holds.profile_id -> profiles).
 *
 * THE CONTRACT THIS FILE PINS (assumed: the brief names the table, its columns and the four behaviours, not the method names or the types; they follow skin-care.pauses.repository.ts):
 *   src/modules/skin-care/skin-care.types.ts
 *     EscalationHold = {
 *       id, profileId,
 *       reason: EscalationReason,            one of ESCALATION_REASONS (catalog.vocabulary.ts)
 *       sourceLogId: string | null,          the skin log that sent the person to a professional; plain text, NOT a foreign key (a contract run holds no logs)
 *       openedOn: string,                    the person's local calendar day 'YYYY-MM-DD', frozen when the hold is opened: it is stored as given and never derived from openedAt
 *       openedAt: Date,
 *       closedAt: Date | null,               null while the hold is open
 *       closedHow: HoldCloseHow | null,      one of HOLD_CLOSE_HOW ('seen' | 'settled') from skin-care.vocabulary.ts; null while the hold is open
 *     }
 *     NewEscalationHold = Omit<EscalationHold, 'closedAt' | 'closedHow'>   (the caller makes the id and the times; a new hold is open)
 *   open(hold: NewEscalationHold): Promise<EscalationHold>
 *       A profile has at most ONE open hold (a partial unique index over profile_id where closed_at IS NULL). Opening stores the hold as given, open, and answers it whole.
 *       Opening while the profile already has an open hold is idempotent: it writes nothing and answers the EXISTING open hold (its own id, reason, source log and times, not the
 *       ones offered). Two opens at once for one profile come out the same way: one row, both calls answer it. Profiles are independent. Rejects an id already held (the first row stays) and, in D1, a profile that does not exist.
 *   openFor(profileId): Promise<EscalationHold | null>
 *       The profile's open hold, whole, or null.
 *   close(profileId: string, holdId: string, how: HoldCloseHow, at: Date): Promise<boolean>
 *       A compare-and-set on still-open: sets closedAt = at and closedHow = how and answers true once. Answers false, and changes nothing, for a hold already closed (whoever closed
 *       it, however it was closed), another profile's hold, and an id nobody holds. A closed hold leaves openFor, and a new one may be opened.
 */
export type EscalationHoldsContractSetup = {
  repository: EscalationHoldsRepository
  newAccount: () => Promise<Account>
}

const holdFor = (profileId: string, over: Partial<NewEscalationHold> = {}): NewEscalationHold => ({
  id: crypto.randomUUID(),
  profileId,
  reason: 'swelling',
  sourceLogId: null,
  openedOn: dayAt(0),
  openedAt: at(MINUTE),
  ...over,
})

/** The hold as it reads once opened. */
const openHold = (hold: NewEscalationHold): EscalationHold => ({ ...hold, closedAt: null, closedHow: null })

/** Behaviour every EscalationHoldsRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const escalationHoldsRepositoryContract = (name: string, make: () => EscalationHoldsContractSetup | Promise<EscalationHoldsContractSetup>) => {
  describe(`EscalationHoldsRepository contract: ${name}`, () => {
    describe('open', () => {
      it('stores an open hold whole, every column, and answers it the same through open and openFor', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const hold = holdFor(profileId, { reason: 'near-eyes', sourceLogId: `log-${profileId}`, openedOn: dayAt(-1), openedAt: at(5 * MINUTE) })

        const stored = await repository.open(hold)

        expect(stored).toEqual({ ...hold, closedAt: null, closedHow: null })
        expect(await repository.openFor(profileId)).toEqual(openHold(hold))
      })

      it('keeps the local day it was given, whatever instant it was opened at', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        // Opened at BASE (12:00 UTC on day 0) for a person whose local day is still the day before: the frozen day is not derived from the instant.
        const hold = holdFor(profileId, { openedOn: dayAt(-1), openedAt: BASE })

        await repository.open(hold)

        expect(await repository.openFor(profileId)).toMatchObject({ openedOn: dayAt(-1), openedAt: BASE })
      })

      it('keeps a hold with no source log, with the source log null', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        await repository.open(holdFor(profileId, { sourceLogId: null }))

        expect(await repository.openFor(profileId)).toMatchObject({ sourceLogId: null })
      })

      it.each(ESCALATION_REASONS)('stores the reason %s and reads it back', async (reason) => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        await repository.open(holdFor(profileId, { reason }))

        expect(await repository.openFor(profileId)).toMatchObject({ reason })
      })

      it('refuses an id already held, and leaves the first hold as it was', async () => {
        const { repository, newAccount } = await make()
        const first = (await newAccount()).profileId
        const second = (await newAccount()).profileId
        const held = holdFor(first, { id: `same-${first}` })
        await repository.open(held)

        // A different profile offers the same id: the id is a primary key, so this is not the idempotent case (that one is the same profile).
        await expect(repository.open(holdFor(second, { id: held.id, reason: 'near-eyes' }))).rejects.toThrow()

        expect(await repository.openFor(first)).toEqual(openHold(held))
        expect(await repository.openFor(second)).toBeNull()
      })
    })

    describe('one open hold per profile', () => {
      it('answers the existing open hold, and writes nothing, when a second is opened while one is open', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = holdFor(profileId, { reason: 'swelling', sourceLogId: 'log-first', openedOn: dayAt(0), openedAt: at(MINUTE) })
        const second = holdFor(profileId, { reason: 'near-eyes', sourceLogId: 'log-second', openedOn: dayAt(1), openedAt: at(2 * MINUTE) })
        await repository.open(first)

        const answered = await repository.open(second)

        expect(answered).toEqual(openHold(first))
        expect(await repository.openFor(profileId)).toEqual(openHold(first))
      })

      it('leaves the second offered id unused: closing the first lets that same id be opened afterwards', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = holdFor(profileId)
        const second = holdFor(profileId, { reason: 'near-eyes', openedAt: at(2 * MINUTE) })
        await repository.open(first)
        await repository.open(second)
        await repository.close(profileId, first.id, 'seen', at(3 * MINUTE))

        // If the idempotent call had written the second row, its id would now be taken.
        const reopened = await repository.open(second)

        expect(reopened).toEqual(openHold(second))
        expect(await repository.openFor(profileId)).toEqual(openHold(second))
      })

      it('gives one row for two opens made at once: both calls answer the same hold, the one that is open', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const a = holdFor(profileId, { reason: 'swelling' })
        const b = holdFor(profileId, { reason: 'near-eyes' })

        const [fromA, fromB] = await Promise.all([repository.open(a), repository.open(b)])

        expect(fromA.id).toBe(fromB.id)
        expect([a.id, b.id]).toContain(fromA.id)
        expect(fromA).toEqual(fromB)
        expect(await repository.openFor(profileId)).toEqual(fromA)
      })

      it('keeps profiles independent: each has its own open hold, and one profile\'s hold never answers for another', async () => {
        const { repository, newAccount } = await make()
        const mine = (await newAccount()).profileId
        const other = (await newAccount()).profileId
        const myHold = holdFor(mine, { reason: 'swelling' })
        const theirHold = holdFor(other, { reason: 'near-eyes' })

        const fromMine = await repository.open(myHold)
        const fromTheirs = await repository.open(theirHold)

        expect(fromMine).toEqual(openHold(myHold))
        expect(fromTheirs).toEqual(openHold(theirHold))
        expect(await repository.openFor(mine)).toEqual(openHold(myHold))
        expect(await repository.openFor(other)).toEqual(openHold(theirHold))
      })

      it('lets a new hold be opened once the open one is closed, and answers the new one', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = holdFor(profileId, { reason: 'swelling' })
        const second = holdFor(profileId, { reason: 'near-eyes', openedOn: dayAt(2), openedAt: at(2 * DAY) })
        await repository.open(first)
        await repository.close(profileId, first.id, 'settled', at(DAY))

        const answered = await repository.open(second)

        expect(answered).toEqual(openHold(second))
        expect(await repository.openFor(profileId)).toEqual(openHold(second))
      })

      it('allows any number of closed holds, one after another', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        for (const [index, how] of [...HOLD_CLOSE_HOW, ...HOLD_CLOSE_HOW].entries()) {
          const hold = holdFor(profileId, { openedAt: at((index + 1) * DAY) })
          expect(await repository.open(hold)).toEqual(openHold(hold))
          expect(await repository.close(profileId, hold.id, how, at((index + 1) * DAY + MINUTE))).toBe(true)
        }

        expect(await repository.openFor(profileId)).toBeNull()
      })
    })

    describe('openFor', () => {
      it('answers null for a profile that never had a hold, and never another profile\'s hold', async () => {
        const { repository, newAccount } = await make()
        const mine = (await newAccount()).profileId
        const other = (await newAccount()).profileId
        await repository.open(holdFor(other))

        expect(await repository.openFor(mine)).toBeNull()
        expect(await repository.openFor(crypto.randomUUID())).toBeNull()
      })

      it('answers null once the hold is closed', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const hold = holdFor(profileId)
        await repository.open(hold)

        await repository.close(profileId, hold.id, 'seen', at(2 * MINUTE))

        expect(await repository.openFor(profileId)).toBeNull()
      })
    })

    describe('close', () => {
      it.each(HOLD_CLOSE_HOW)('closes an open hold as %s and answers true', async (how) => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const hold = holdFor(profileId)
        await repository.open(hold)

        expect(await repository.close(profileId, hold.id, how, at(2 * MINUTE))).toBe(true)

        expect(await repository.openFor(profileId)).toBeNull()
      })

      it('answers true once: a second close, with the same answer or the other one, is false', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const hold = holdFor(profileId)
        await repository.open(hold)

        expect(await repository.close(profileId, hold.id, 'seen', at(2 * MINUTE))).toBe(true)
        expect(await repository.close(profileId, hold.id, 'seen', at(3 * MINUTE))).toBe(false)
        expect(await repository.close(profileId, hold.id, 'settled', at(4 * MINUTE))).toBe(false)
      })

      it('answers false for another profile\'s hold and leaves that hold open', async () => {
        const { repository, newAccount } = await make()
        const owner = (await newAccount()).profileId
        const stranger = (await newAccount()).profileId
        const hold = holdFor(owner)
        await repository.open(hold)

        expect(await repository.close(stranger, hold.id, 'seen', at(2 * MINUTE))).toBe(false)

        expect(await repository.openFor(owner)).toEqual(openHold(hold))
      })

      it('answers false for an id nobody holds and leaves the open hold open', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const hold = holdFor(profileId)
        await repository.open(hold)

        expect(await repository.close(profileId, crypto.randomUUID(), 'settled', at(2 * MINUTE))).toBe(false)

        expect(await repository.openFor(profileId)).toEqual(openHold(hold))
      })

      it('answers false for an old closed hold and does not close the newer hold opened since', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const old = holdFor(profileId)
        const newer = holdFor(profileId, { reason: 'near-eyes', openedAt: at(DAY) })
        await repository.open(old)
        await repository.close(profileId, old.id, 'seen', at(MINUTE * 2))
        await repository.open(newer)

        expect(await repository.close(profileId, old.id, 'settled', at(DAY + MINUTE))).toBe(false)

        expect(await repository.openFor(profileId)).toEqual(openHold(newer))
      })

      it('closes only the profile\'s own hold: another profile\'s open hold stays open', async () => {
        const { repository, newAccount } = await make()
        const mine = (await newAccount()).profileId
        const other = (await newAccount()).profileId
        const myHold = holdFor(mine)
        const theirHold = holdFor(other, { reason: 'near-eyes' })
        await repository.open(myHold)
        await repository.open(theirHold)

        expect(await repository.close(mine, myHold.id, 'seen', at(2 * MINUTE))).toBe(true)

        expect(await repository.openFor(mine)).toBeNull()
        expect(await repository.openFor(other)).toEqual(openHold(theirHold))
      })

      it('lets only one of two closes made at once win', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const hold = holdFor(profileId)
        await repository.open(hold)

        const results = await Promise.all([repository.close(profileId, hold.id, 'seen', at(2 * MINUTE)), repository.close(profileId, hold.id, 'settled', at(2 * MINUTE))])

        expect(results.filter(Boolean)).toHaveLength(1)
        expect(await repository.openFor(profileId)).toBeNull()
      })
    })
  })
}
