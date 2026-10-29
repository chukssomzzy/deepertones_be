import { describe, expect, it } from 'vitest'
import type { VerdictReportsRepository } from './verdicts.reports.repository'

// The reports a person sends about a shelf verdict (spec #259, PR B1): a "mistake" about a product's verdict, and a "wrong-match" the shelf swap records. Behaviour every
// VerdictReportsRepository must have; it runs against the fake (unit tier) and real local D1 (integration tier).
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the table, its columns and the two writes, not the method signatures; they follow skin-care.holds.repository.ts):
//   upsertMistake(report, now): Promise<{ id: string; created: boolean }>
//       report = { id, profileId, entryId, group, verdict, basis: null, fingerprint, note: string | null }; the caller makes the id and passes the time.
//       A report is unique per (profileId, entryId, fingerprint) among `mistake` reports (a PARTIAL unique index where kind = 'mistake'). The first one stores a row with
//       kind 'mistake', createdAt = updatedAt = now, no old or new product, and answers { id: <the offered id>, created: true }. A repeat for the same triple writes no row:
//       it sets the row's note to the offered note (null included) and its updatedAt to the new `now`, keeps its id, createdAt, group, verdict and fingerprint, and answers
//       { id: <the EXISTING id>, created: false }. A different fingerprint (the verdict was rebuilt), entry or profile is a different report. Two upserts of one triple at
//       once come out the same way: one row, one answers created, the other not. Rejects an id already held by another row and, in D1, a profile that does not exist.
//   recordWrongMatch(report, now): Promise<void>
//       report = { id, profileId, entryId, oldProductId, newProductId }. A plain insert: kind 'wrong-match', group, verdict, basis, fingerprint and note null, createdAt = updatedAt = now.
//       No uniqueness: the same entry may be recorded twice. It never collides with a mistake report on the same entry.
//   find(id): Promise<VerdictReport | null>
//       The row whole: { id, profileId, entryId, kind, group, verdict, basis, fingerprint, note, oldProductId, newProductId, createdAt, updatedAt }, or null. This read exists so the
//       contract (and nothing else) can see what a write did; the product has no triage screen (the team reads the table).
// Times are Dates (the table stores milliseconds).

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

const FP_1 = 'fingerprint-1'
const FP_2 = 'fingerprint-2'

type Mistake = Parameters<VerdictReportsRepository['upsertMistake']>[0]
type WrongMatch = Parameters<VerdictReportsRepository['recordWrongMatch']>[0]

export type VerdictReportsContractSetup = {
  repository: VerdictReportsRepository
  /** A user with its default profile, made the way the product makes one (D1 enforces verdict_reports.profile_id -> profiles). */
  newAccount: () => Promise<{ userId: string; profileId: string }>
}

const mistakeFor = (profileId: string, over: Partial<Mistake> = {}): Mistake => ({
  id: crypto.randomUUID(),
  profileId,
  entryId: 'entry-1',
  group: 'helping',
  verdict: { kind: 'keep' },
  basis: null,
  fingerprint: FP_1,
  note: 'This cream is not what I use',
  ...over,
})

const wrongMatchFor = (profileId: string, over: Partial<WrongMatch> = {}): WrongMatch => ({
  id: crypto.randomUUID(),
  profileId,
  entryId: 'entry-1',
  oldProductId: 'product-old',
  newProductId: 'product-new',
  ...over,
})

export const verdictReportsRepositoryContract = (name: string, make: () => VerdictReportsContractSetup | Promise<VerdictReportsContractSetup>) => {
  describe(`VerdictReportsRepository contract: ${name}`, () => {
    describe('upsertMistake: a new report', () => {
      it('stores the report whole, as a mistake with no product swap and no basis, stamped with the time given, and answers its id as created', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const report = mistakeFor(profileId, { entryId: 'entry-7', group: 'conflicting', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' }, fingerprint: FP_2, note: 'It is not clashing' })

        expect(await repository.upsertMistake(report, at(MINUTE))).toEqual({ id: report.id, created: true })

        expect(await repository.find(report.id)).toEqual({
          id: report.id,
          profileId,
          entryId: 'entry-7',
          kind: 'mistake',
          group: 'conflicting',
          verdict: { kind: 'reduce', maxFrequency: 'alternate-days' },
          basis: null,
          fingerprint: FP_2,
          note: 'It is not clashing',
          oldProductId: null,
          newProductId: null,
          createdAt: at(MINUTE),
          updatedAt: at(MINUTE),
        })
      })

      it('keeps a step-down verdict with the step-down it names, so a stop is reproduced as the person saw it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const report = mistakeFor(profileId, { group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' } })

        await repository.upsertMistake(report, BASE)

        expect(await repository.find(report.id)).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' } })
      })

      it('keeps a report with no note, with the note null', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const report = mistakeFor(profileId, { note: null })

        await repository.upsertMistake(report, BASE)

        expect(await repository.find(report.id)).toMatchObject({ note: null })
      })

      it('stores the time to the millisecond', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const report = mistakeFor(profileId)

        await repository.upsertMistake(report, at(MINUTE + 123))

        const row = await repository.find(report.id)
        expect(row!.createdAt.getTime()).toBe(BASE.getTime() + MINUTE + 123)
        expect(row!.updatedAt.getTime()).toBe(BASE.getTime() + MINUTE + 123)
      })

      it('has no row for an id nobody holds', async () => {
        const { repository } = await make()

        expect(await repository.find(crypto.randomUUID())).toBeNull()
      })

      it('refuses an id already held by another report, and leaves the first as it was', async () => {
        const { repository, newAccount } = await make()
        const first = (await newAccount()).profileId
        const second = (await newAccount()).profileId
        const held = mistakeFor(first, { note: 'first' })
        await repository.upsertMistake(held, BASE)

        await expect(repository.upsertMistake(mistakeFor(second, { id: held.id, note: 'second' }), at(MINUTE))).rejects.toThrow()

        expect(await repository.find(held.id)).toMatchObject({ profileId: first, note: 'first' })
      })
    })

    describe('upsertMistake: the same entry and the same verdict again', () => {
      it('updates the note and the updated time, keeps the first id and creation time, and answers created false with the first id (not the id offered)', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = mistakeFor(profileId, { note: 'first thoughts' })
        await repository.upsertMistake(first, at(MINUTE))
        const again = mistakeFor(profileId, { note: 'second thoughts' })

        expect(await repository.upsertMistake(again, at(5 * MINUTE))).toEqual({ id: first.id, created: false })

        expect(await repository.find(first.id)).toEqual({
          id: first.id,
          profileId,
          entryId: first.entryId,
          kind: 'mistake',
          group: first.group,
          verdict: first.verdict,
          basis: null,
          fingerprint: first.fingerprint,
          note: 'second thoughts',
          oldProductId: null,
          newProductId: null,
          createdAt: at(MINUTE),
          updatedAt: at(5 * MINUTE),
        })
        // The id the repeat offered was never used.
        expect(await repository.find(again.id)).toBeNull()
      })

      it('sets the note to null when the repeat has none (the repeat is the latest word)', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = mistakeFor(profileId, { note: 'a note' })
        await repository.upsertMistake(first, BASE)

        await repository.upsertMistake(mistakeFor(profileId, { note: null }), at(MINUTE))

        expect(await repository.find(first.id)).toMatchObject({ note: null, updatedAt: at(MINUTE) })
      })

      it('answers created false each time it is repeated, and the row stays one', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = mistakeFor(profileId)
        await repository.upsertMistake(first, BASE)

        const second = await repository.upsertMistake(mistakeFor(profileId), at(MINUTE))
        const third = await repository.upsertMistake(mistakeFor(profileId), at(2 * MINUTE))

        expect(second).toEqual({ id: first.id, created: false })
        expect(third).toEqual({ id: first.id, created: false })
      })

      it('lets exactly one of two parallel reports of one entry and verdict be the new one, and both answer the same id', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const a = mistakeFor(profileId, { note: 'a' })
        const b = mistakeFor(profileId, { note: 'b' })

        const answers = await Promise.all([repository.upsertMistake(a, BASE), repository.upsertMistake(b, BASE)])

        expect(answers.filter((answer) => answer.created)).toHaveLength(1)
        expect(answers[1]!.id).toBe(answers[0]!.id)
        // Only the winner's id exists.
        const kept = answers[0]!.id
        const lost = kept === a.id ? b.id : a.id
        expect(await repository.find(kept)).not.toBeNull()
        expect(await repository.find(lost)).toBeNull()
      })
    })

    describe('upsertMistake: a different report', () => {
      it('is a new report once the verdict has been rebuilt (another fingerprint) for the same entry, and the first report is left as it was', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = mistakeFor(profileId, { fingerprint: FP_1, note: 'before the rebuild' })
        await repository.upsertMistake(first, BASE)
        const rebuilt = mistakeFor(profileId, { fingerprint: FP_2, note: 'after the rebuild' })

        expect(await repository.upsertMistake(rebuilt, at(MINUTE))).toEqual({ id: rebuilt.id, created: true })

        expect(await repository.find(first.id)).toMatchObject({ fingerprint: FP_1, note: 'before the rebuild', updatedAt: BASE })
        expect(await repository.find(rebuilt.id)).toMatchObject({ fingerprint: FP_2, note: 'after the rebuild' })
      })

      it('is a new report for another entry of the same verdict', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.upsertMistake(mistakeFor(profileId, { entryId: 'entry-1' }), BASE)
        const other = mistakeFor(profileId, { entryId: 'entry-2' })

        expect(await repository.upsertMistake(other, at(MINUTE))).toEqual({ id: other.id, created: true })
      })

      it('is a new report for another profile with the same entry id and fingerprint, and each keeps its own note', async () => {
        const { repository, newAccount } = await make()
        const amara = (await newAccount()).profileId
        const tolu = (await newAccount()).profileId
        const first = mistakeFor(amara, { note: 'Amara\'s note' })
        const second = mistakeFor(tolu, { note: 'Tolu\'s note' })

        expect(await repository.upsertMistake(first, BASE)).toEqual({ id: first.id, created: true })
        expect(await repository.upsertMistake(second, BASE)).toEqual({ id: second.id, created: true })

        expect(await repository.find(first.id)).toMatchObject({ profileId: amara, note: 'Amara\'s note' })
        expect(await repository.find(second.id)).toMatchObject({ profileId: tolu, note: 'Tolu\'s note' })
      })
    })

    describe('recordWrongMatch', () => {
      it('stores a wrong-match report whole: the old and new product, and no group, verdict, basis, fingerprint or note', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const report = wrongMatchFor(profileId, { entryId: 'entry-9', oldProductId: 'product-wrong', newProductId: 'product-right' })

        await repository.recordWrongMatch(report, at(MINUTE))

        expect(await repository.find(report.id)).toEqual({
          id: report.id,
          profileId,
          entryId: 'entry-9',
          kind: 'wrong-match',
          group: null,
          verdict: null,
          basis: null,
          fingerprint: null,
          note: null,
          oldProductId: 'product-wrong',
          newProductId: 'product-right',
          createdAt: at(MINUTE),
          updatedAt: at(MINUTE),
        })
      })

      it('is a plain insert: the same entry recorded twice is two reports', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = wrongMatchFor(profileId)
        const second = wrongMatchFor(profileId)

        await repository.recordWrongMatch(first, BASE)
        await repository.recordWrongMatch(second, at(MINUTE))

        expect(await repository.find(first.id)).toMatchObject({ kind: 'wrong-match' })
        expect(await repository.find(second.id)).toMatchObject({ kind: 'wrong-match', createdAt: at(MINUTE) })
      })

      it('never collides with, nor is merged into, a mistake report on the same entry: the unique index covers mistakes only', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const mistake = mistakeFor(profileId)
        await repository.upsertMistake(mistake, BASE)
        const wrong = wrongMatchFor(profileId, { entryId: mistake.entryId })

        await repository.recordWrongMatch(wrong, at(MINUTE))
        // A mistake on the same entry and verdict is still the same mistake report, and a second wrong-match is still a fresh row.
        const repeat = await repository.upsertMistake(mistakeFor(profileId), at(2 * MINUTE))
        await repository.recordWrongMatch(wrongMatchFor(profileId, { entryId: mistake.entryId }), at(3 * MINUTE))

        expect(repeat).toEqual({ id: mistake.id, created: false })
        expect(await repository.find(mistake.id)).toMatchObject({ kind: 'mistake', note: mistake.note })
        expect(await repository.find(wrong.id)).toMatchObject({ kind: 'wrong-match', fingerprint: null })
      })

      it('lets a mistake be reported after a wrong-match on the same entry as a new report', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.recordWrongMatch(wrongMatchFor(profileId), BASE)
        const mistake = mistakeFor(profileId)

        expect(await repository.upsertMistake(mistake, at(MINUTE))).toEqual({ id: mistake.id, created: true })
      })

      it('refuses an id already held, and leaves the first report as it was', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = wrongMatchFor(profileId, { newProductId: 'product-first' })
        await repository.recordWrongMatch(first, BASE)

        await expect(repository.recordWrongMatch(wrongMatchFor(profileId, { id: first.id, newProductId: 'product-second' }), at(MINUTE))).rejects.toThrow()

        expect(await repository.find(first.id)).toMatchObject({ newProductId: 'product-first' })
      })
    })
  })
}
