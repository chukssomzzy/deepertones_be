import { describe, expect, it } from 'vitest'
import { SKIN_OUTCOME_RULES_VERSION } from './skin-care.outcomes'
import type { SkinCareRepository } from './skin-care.repository'
import type { NewSkinLog } from './skin-care.types'

// The one clock every fixture hangs off; later times are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

type Account = { userId: string; profileId: string }

/**
 * What a skin-log contract run needs: the repository, and a way to get an account that really exists, the way every account does in life (D1 enforces
 * skin_logs.profile_id -> profiles).
 *
 * THE CONTRACT THIS FILE PINS (assumed: the brief names the table and three methods, not their signatures; they follow routines.check-ins.repository.ts):
 *   src/modules/skin-care/skin-care.types.ts
 *     NewSkinLog = { id, profileId, noticing: Noticing[], where: Where[], howBad: HowBad | null, note: string | null, localDay: string, outcome: SkinOutcome['kind'],
 *                    reason: EscalationReason | null, rulesVersion: typeof SKIN_OUTCOME_RULES_VERSION, createdAt: Date }
 *     SkinLog    = NewSkinLog & { overridden: boolean }
 *   append(log: NewSkinLog): Promise<SkinLog>
 *       The caller (the service) makes the id and the time, so a log is stored as given; the row comes back whole, with overridden false. A second log with an id already
 *       held is refused (rejects) and leaves the first alone. `localDay` is a calendar date 'YYYY-MM-DD' stored as given. The two lists keep their order and may be empty.
 *   recent(profileId, limit): Promise<SkinLog[]>
 *       The profile's newest `limit` logs, newest `createdAt` first, whole (the note included: hiding it is the service's job). Never another profile's. [] when none.
 *   markOverridden(profileId, id): Promise<boolean>
 *       Sets `overridden` on that profile's log with that id and resolves true. A log that is not that profile's, or an id nobody holds, changes nothing and resolves false.
 *       Nothing else on the row changes, and no other log is touched.
 */
export type SkinCareContractSetup = {
  repository: SkinCareRepository
  newAccount: () => Promise<Account>
}

// Every test shares one database in the D1 tier, and an id is a primary key, so a test's ids carry its profile's id: `labelled(profileId, 'target')` is
// 'target:<profile id>', and `labelsOf` reads the labels back.
const idOf = (profileId: string, label: string) => `${label}:${profileId}`
const labelsOf = (rows: { id: string }[]) => rows.map((row) => row.id.split(':')[0])

const logFor = (profileId: string, over: Partial<NewSkinLog> = {}): NewSkinLog => ({
  id: crypto.randomUUID(),
  profileId,
  noticing: ['stinging-or-burning'],
  where: ['cheeks'],
  howBad: 'mild',
  note: null,
  localDay: '2030-06-15',
  outcome: 'pause',
  reason: null,
  rulesVersion: SKIN_OUTCOME_RULES_VERSION,
  createdAt: at(MINUTE),
  ...over,
})
const labelled = (profileId: string, label: string, over: Partial<NewSkinLog> = {}): NewSkinLog => logFor(profileId, { ...over, id: idOf(profileId, label) })

/** Behaviour every SkinCareRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const skinCareRepositoryContract = (name: string, make: () => SkinCareContractSetup | Promise<SkinCareContractSetup>) => {
  describe(`SkinCareRepository contract: ${name}`, () => {
    it('stores a log whole and answers it with overridden false', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      const log = logFor(profileId, {
        noticing: ['new-redness', 'itching'],
        where: ['nose', 'chin-and-jaw'],
        howBad: 'noticeable',
        note: 'It started after the new serum.',
        localDay: '2030-06-16',
        outcome: 'pause',
        createdAt: at(5 * MINUTE),
      })

      const stored = await repository.append(log)

      expect(stored).toMatchObject({ ...log, overridden: false })
      expect(stored.createdAt.getTime()).toBe(at(5 * MINUTE).getTime())
      const [read, ...rest] = await repository.recent(profileId, 10)
      expect(rest).toEqual([])
      expect(read).toMatchObject({ ...log, overridden: false })
      expect(read!.createdAt.getTime()).toBe(at(5 * MINUTE).getTime())
    })

    it('keeps the order of the two lists, and an empty list, a missing level and a missing note as they were given', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      await repository.append(labelled(profileId, 'ordered', { noticing: ['new-breakouts', 'itching', 'tightness-or-dryness'], where: ['neck', 'cheeks', 'forehead'] }))
      await repository.append(labelled(profileId, 'good-day', { noticing: ['nothing-unusual'], where: [], howBad: null, note: null, outcome: 'logged', createdAt: at(2 * MINUTE) }))

      const rows = new Map((await repository.recent(profileId, 10)).map((row) => [labelsOf([row])[0], row]))
      expect(rows.get('ordered')).toMatchObject({ noticing: ['new-breakouts', 'itching', 'tightness-or-dryness'], where: ['neck', 'cheeks', 'forehead'] })
      expect(rows.get('good-day')).toMatchObject({ noticing: ['nothing-unusual'], where: [], howBad: null, note: null, outcome: 'logged', reason: null })
    })

    it('stores the reason of a professional outcome, and the rules version that decided it', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      await repository.append(logFor(profileId, { noticing: ['swelling'], howBad: 'noticeable', outcome: 'professional', reason: 'swelling' }))

      expect((await repository.recent(profileId, 1))[0]).toMatchObject({ outcome: 'professional', reason: 'swelling', rulesVersion: SKIN_OUTCOME_RULES_VERSION })
    })

    it('stores a note of the longest length the service allows (500 characters), and one with line breaks and quotes, as written', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      const longest = 'a'.repeat(500)
      const awkward = 'Line one\nLine two, "quoted" and \'single\' and 100% sure; DROP TABLE skin_logs;--'

      await repository.append(logFor(profileId, { note: longest, createdAt: at(MINUTE) }))
      await repository.append(logFor(profileId, { note: awkward, createdAt: at(2 * MINUTE) }))

      expect((await repository.recent(profileId, 10)).map((row) => row.note)).toEqual([awkward, longest])
    })

    it('answers the newest logs first, by when they were made and not by when they were stored', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      await repository.append(labelled(profileId, 'middle', { createdAt: at(2 * MINUTE) }))
      await repository.append(labelled(profileId, 'newest', { createdAt: at(3 * MINUTE) }))
      await repository.append(labelled(profileId, 'oldest', { createdAt: at(MINUTE) }))

      expect(labelsOf(await repository.recent(profileId, 10))).toEqual(['newest', 'middle', 'oldest'])
    })

    it('answers logs made in the same millisecond in a stable order, the highest id first', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      for (const label of ['b', 'c', 'a']) await repository.append(labelled(profileId, label, { createdAt: at(MINUTE) }))
      await repository.append(labelled(profileId, 'older', { createdAt: at(0) }))

      // The ids are 'a:<profile>', 'b:<profile>' and 'c:<profile>', which sort as a, b, c.
      expect(labelsOf(await repository.recent(profileId, 10))).toEqual(['c', 'b', 'a', 'older'])
      expect(labelsOf(await repository.recent(profileId, 2))).toEqual(['c', 'b'])
    })

    it('stops at the limit, keeping the newest, and answers every log when the limit is the count or more', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      for (const [index, label] of ['a', 'b', 'c'].entries()) await repository.append(labelled(profileId, label, { createdAt: at((index + 1) * MINUTE) }))

      expect(labelsOf(await repository.recent(profileId, 1))).toEqual(['c'])
      expect(labelsOf(await repository.recent(profileId, 2))).toEqual(['c', 'b'])
      expect(labelsOf(await repository.recent(profileId, 3))).toEqual(['c', 'b', 'a'])
      expect(labelsOf(await repository.recent(profileId, 4))).toEqual(['c', 'b', 'a'])
    })

    it('answers no logs for a profile that never logged', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()

      expect(await repository.recent(profileId, 20)).toEqual([])
    })

    it('keeps each profile\'s logs apart', async () => {
      const { repository, newAccount } = await make()
      const mine = (await newAccount()).profileId
      const other = (await newAccount()).profileId
      await repository.append(labelled(mine, 'mine'))
      await repository.append(labelled(other, 'other', { createdAt: at(2 * MINUTE) }))

      expect(labelsOf(await repository.recent(mine, 20))).toEqual(['mine'])
      expect(labelsOf(await repository.recent(other, 20))).toEqual(['other'])
    })

    it('refuses a second log with an id already held, and leaves the first as it was', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      await repository.append(labelled(profileId, 'same', { note: 'first' }))

      await expect(repository.append(labelled(profileId, 'same', { note: 'second', createdAt: at(2 * MINUTE) }))).rejects.toThrow()

      const rows = await repository.recent(profileId, 10)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.note).toBe('first')
    })

    it('marks one log overridden and changes nothing else, on it or on any other log', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      const target = labelled(profileId, 'target', { note: 'tapped by mistake', createdAt: at(MINUTE) })
      await repository.append(target)
      await repository.append(labelled(profileId, 'neighbour', { createdAt: at(2 * MINUTE) }))

      expect(await repository.markOverridden(profileId, target.id)).toBe(true)

      const rows = new Map((await repository.recent(profileId, 10)).map((row) => [labelsOf([row])[0], row]))
      expect(rows.get('target')).toMatchObject({ ...target, overridden: true })
      expect(rows.get('target')!.createdAt.getTime()).toBe(at(MINUTE).getTime())
      expect(rows.get('neighbour')!.overridden).toBe(false)
    })

    it('keeps a log overridden when it is marked again', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      const target = logFor(profileId)
      await repository.append(target)
      await repository.markOverridden(profileId, target.id)

      await repository.markOverridden(profileId, target.id)

      expect((await repository.recent(profileId, 1))[0]!.overridden).toBe(true)
    })

    it('does not mark another profile\'s log, and says so', async () => {
      const { repository, newAccount } = await make()
      const owner = (await newAccount()).profileId
      const stranger = (await newAccount()).profileId
      const theirs = logFor(owner)
      await repository.append(theirs)

      expect(await repository.markOverridden(stranger, theirs.id)).toBe(false)

      expect((await repository.recent(owner, 1))[0]!.overridden).toBe(false)
    })

    it('marks nothing for an id nobody holds, and says so', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      await repository.append(logFor(profileId))

      expect(await repository.markOverridden(profileId, crypto.randomUUID())).toBe(false)

      expect((await repository.recent(profileId, 1))[0]!.overridden).toBe(false)
    })
  })
}
