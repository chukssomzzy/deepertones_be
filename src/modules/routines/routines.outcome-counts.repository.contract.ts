import { describe, expect, it } from 'vitest'
import { GOALS, type Goal } from '../goals/goals.vocabulary'
import type { SkinTypeLabel } from '../face-scans/face-scans.tables'
import type { OutcomeCounts } from './routines.outcomes'

// Outcome counts (spec #189, PR 3a): per (goal, skin type, country, product code), what happened to users who had the product in their routine at the review
// point. Behaviour every OutcomeCountsRepository must have; it runs against the fake (unit tier) and real local D1 (integration tier).
//
// Assumed shapes (what this file pins):
//   counts(group, codes)           resolves to a Map<code, OutcomeCounts> holding exactly the asked codes that have a row in exactly that group
//                                  (goal, skinType, country). A code with no row is absent from the map. An empty codes list gives an empty map and
//                                  asks nothing. More codes than one D1 statement can bind (100) must work.
//   upsert(group, code, counts, at)  test-only here (a later collector writes in life): stores the five counts for that key, replacing a row already
//                                  there, with `at` as updated_at. Resolves to undefined.
//   A null skin type is the group "no scan": stored as '' and matched as '', never matching a real skin type.

export type CountsGroup = { goal: Goal; skinType: SkinTypeLabel | null; country: string }

export type OutcomeCountsRepositoryUnderTest = {
  counts: (group: CountsGroup, codes: string[]) => Promise<Map<string, OutcomeCounts>>
  upsert: (group: CountsGroup, code: string, counts: OutcomeCounts, at: Date) => Promise<void>
}

const BASE = new Date('2030-06-15T12:00:00.000Z')
const [GOAL, OTHER_GOAL] = [GOALS[0], GOALS[1] ?? GOALS[0]]

// Every count different, so a swapped column shows. They obey the counting rules (fainter and stopped overlap in `both` users, flared within stopped).
const countsA: OutcomeCounts = { n: 40, fainter: 21, flared: 3, flaredOrStopped: 5, fainterAndFlaredOrStopped: 2 }
const countsB: OutcomeCounts = { n: 77, fainter: 30, flared: 9, flaredOrStopped: 11, fainterAndFlaredOrStopped: 4 }
const countsC: OutcomeCounts = { n: 31, fainter: 8, flared: 1, flaredOrStopped: 2, fainterAndFlaredOrStopped: 1 }

// D1 keeps its rows between tests of a file, so each test works in a country of its own and cannot see another test's rows.
const freshCountry = () => `T-${crypto.randomUUID()}`

// D1 binds at most 100 variables in a statement.
const MORE_THAN_ONE_STATEMENT = 250

export const outcomeCountsRepositoryContract = (name: string, setup: () => OutcomeCountsRepositoryUnderTest) => {
  describe(`OutcomeCountsRepository contract (${name})`, () => {
    it('returns the counts stored for a code, all five of them unchanged', async () => {
      const repository = setup()
      const group: CountsGroup = { goal: GOAL, skinType: 'oily', country: freshCountry() }
      await repository.upsert(group, 'SERUM-1', countsA, BASE)

      const found = await repository.counts(group, ['SERUM-1'])

      expect([...found.keys()]).toEqual(['SERUM-1'])
      expect(found.get('SERUM-1')).toEqual(countsA)
    })

    it('returns only the asked codes, leaving out other codes of the group and asked codes with no row', async () => {
      const repository = setup()
      const group: CountsGroup = { goal: GOAL, skinType: 'dry', country: freshCountry() }
      await repository.upsert(group, 'SERUM-1', countsA, BASE)
      await repository.upsert(group, 'SERUM-2', countsB, BASE)
      await repository.upsert(group, 'CREAM-9', countsC, BASE)

      const found = await repository.counts(group, ['SERUM-1', 'CREAM-9', 'NO-ROW'])

      expect([...found.keys()].sort()).toEqual(['CREAM-9', 'SERUM-1'])
      expect(found.get('SERUM-1')).toEqual(countsA)
      expect(found.get('CREAM-9')).toEqual(countsC)
    })

    it('stores a replacement for a key instead of adding a second row', async () => {
      const repository = setup()
      const group: CountsGroup = { goal: GOAL, skinType: 'normal', country: freshCountry() }
      await repository.upsert(group, 'SERUM-1', countsA, BASE)
      await repository.upsert(group, 'SERUM-1', countsB, new Date(BASE.getTime() + 1000))

      const found = await repository.counts(group, ['SERUM-1'])

      expect(found.size).toBe(1)
      expect(found.get('SERUM-1')).toEqual(countsB)
    })

    it('keeps users with no scan (null skin type) apart from every real skin type, in both directions', async () => {
      const repository = setup()
      const country = freshCountry()
      const noScan: CountsGroup = { goal: GOAL, skinType: null, country }
      const combination: CountsGroup = { goal: GOAL, skinType: 'combination', country }
      await repository.upsert(noScan, 'SERUM-1', countsA, BASE)
      await repository.upsert(combination, 'SERUM-1', countsB, BASE)

      expect((await repository.counts(noScan, ['SERUM-1'])).get('SERUM-1')).toEqual(countsA)
      expect((await repository.counts(combination, ['SERUM-1'])).get('SERUM-1')).toEqual(countsB)
    })

    it('finds a no-scan row only for a no-scan question', async () => {
      const repository = setup()
      const country = freshCountry()
      await repository.upsert({ goal: GOAL, skinType: null, country }, 'SERUM-1', countsA, BASE)

      for (const skinType of ['oily', 'dry', 'combination', 'normal'] as const) {
        expect((await repository.counts({ goal: GOAL, skinType, country }, ['SERUM-1'])).size).toBe(0)
      }
    })

    it('never leaks counts from another goal, skin type or country', async () => {
      const repository = setup()
      const country = freshCountry()
      const asked: CountsGroup = { goal: GOAL, skinType: 'oily', country }
      await repository.upsert({ goal: OTHER_GOAL, skinType: 'oily', country }, 'LEAK-GOAL', countsB, BASE)
      await repository.upsert({ goal: GOAL, skinType: 'dry', country }, 'LEAK-SKIN', countsB, BASE)
      await repository.upsert({ goal: GOAL, skinType: 'oily', country: `${country}-other` }, 'LEAK-COUNTRY', countsB, BASE)
      await repository.upsert(asked, 'MINE', countsA, BASE)

      const found = await repository.counts(asked, ['LEAK-GOAL', 'LEAK-SKIN', 'LEAK-COUNTRY', 'MINE'])

      expect([...found.keys()]).toEqual(['MINE'])
    })

    it('gives the same code its own counts in each group', async () => {
      const repository = setup()
      const country = freshCountry()
      await repository.upsert({ goal: GOAL, skinType: 'oily', country }, 'SERUM-1', countsA, BASE)
      await repository.upsert({ goal: GOAL, skinType: 'oily', country: `${country}-b` }, 'SERUM-1', countsC, BASE)

      expect((await repository.counts({ goal: GOAL, skinType: 'oily', country }, ['SERUM-1'])).get('SERUM-1')).toEqual(countsA)
      expect((await repository.counts({ goal: GOAL, skinType: 'oily', country: `${country}-b` }, ['SERUM-1'])).get('SERUM-1')).toEqual(countsC)
    })

    it('answers for more codes than one statement can bind, finding every one that has a row', async () => {
      const repository = setup()
      const group: CountsGroup = { goal: GOAL, skinType: 'oily', country: freshCountry() }
      const codes = Array.from({ length: MORE_THAN_ONE_STATEMENT }, (_, i) => `CODE-${i}`)
      for (const [i, code] of codes.entries()) await repository.upsert(group, code, { ...countsA, n: 40 + i }, BASE)

      const found = await repository.counts(group, [...codes, 'NO-ROW-1', 'NO-ROW-2'])

      expect(found.size).toBe(MORE_THAN_ONE_STATEMENT)
      // The first, a middle one, and the last: a chunk boundary must not drop or mix up rows.
      expect(found.get('CODE-0')?.n).toBe(40)
      expect(found.get('CODE-100')?.n).toBe(140)
      expect(found.get(`CODE-${MORE_THAN_ONE_STATEMENT - 1}`)?.n).toBe(40 + MORE_THAN_ONE_STATEMENT - 1)
    })

    it('returns an empty map for an empty list of codes', async () => {
      const repository = setup()
      const group: CountsGroup = { goal: GOAL, skinType: 'oily', country: freshCountry() }
      await repository.upsert(group, 'SERUM-1', countsA, BASE)

      const found = await repository.counts(group, [])

      expect(found).toBeInstanceOf(Map)
      expect(found.size).toBe(0)
    })
  })
}
