import { describe, expect, it } from 'vitest'
import { availability, country, product, validWorkbook } from '../catalog/workbook.fixture'
import {
  applyHumanChecks,
  type CaseInput,
  type CaseScore,
  draftedValuesOf,
  formatCaseLine,
  formatGateLine,
  formatOverruledLines,
  formatUnverifiableLine,
  isWrongCurrency,
  percent,
  scoreDraftCase,
  summariseDraft,
  type Verdict,
} from './draft-score'
import type { HumanCheck } from './draft-human-checks'

// The pure half of `npm run eval:catalog -- --mode draft`: what was drafted (read back from the drafted workbook), what a judge said about each
// value, and the scores and gate computed from the two. Every verdict here is a fake; nothing calls the API. Expected numbers are worked out by hand
// from the fixtures, not recomputed with the scorer's own rules.

const NG = { code: 'NG', currency: 'NGN' }
const GB = { code: 'GB', currency: 'GBP' }
const GH = { code: 'GH', currency: 'GHS' }

const PAGE = 'https://shop.example/p/some-product'

// --- verdicts ----------------------------------------------------------------------------------------------------------------------------------

const verdict = (over: Partial<Verdict> = {}): Verdict => ({ fetched: true, exactProduct: 'yes', supports: 'yes', currencyShown: null, ...over })
const GROUNDED = verdict()
const CONTRADICTED = verdict({ supports: 'no' })
const WRONG_PRODUCT = verdict({ exactProduct: 'no' })
const UNVERIFIABLE = verdict({ fetched: false, exactProduct: 'unclear', supports: 'unclear' })

// --- case inputs -------------------------------------------------------------------------------------------------------------------------------

type Cell = CaseInput['cells'][number]
type Price = CaseInput['prices'][number]

const cell = (column: Cell['column'], value: Cell['value'], v: Verdict = GROUNDED): Cell => ({ column, value, sourceUrl: PAGE, verdict: v })
const price = (countryCode: string, v: Verdict = GROUNDED, over: Partial<Price> = {}): Price => ({ country: countryCode, priceMin: 4000, priceMax: 6500, sourceUrl: PAGE, verdict: v, ...over })

const input = (over: Partial<CaseInput> = {}): CaseInput => ({
  id: 'case-a',
  kind: 'ordinary',
  countries: [NG, GB],
  state: 'drafted',
  cells: [],
  prices: [],
  costMicros: 0,
  ...over,
})

const FIVE_CELLS = (v: Verdict = GROUNDED): Cell[] => [
  cell('ingredients', ['Aqua', 'Glycerin'], v),
  cell('skin_concerns', ['hd_acne'], v),
  cell('skin_types', ['oily'], v),
  cell('steps', ['cleanse'], v),
  cell('frequency', 'am-pm', v),
]

describe('draftedValuesOf: what a drafted workbook holds that the tool put there', () => {
  const CODE = 'PRD-EVAL-ONE'
  const drafted = (over: Record<string, unknown> = {}, rows = [availability({ product_code: CODE, country: 'NG', price_min: 4000, price_max: 6500, where_sold: 'Pharmacies', source_url: 'https://shop.example/ng' })]) =>
    validWorkbook({
      products: [
        product({
          code: CODE,
          status: 'draft',
          approved_by: null,
          approved_on: null,
          ingredients: 'Aqua; Glycerin; Niacinamide',
          ingredients_source_url: 'https://brand.example/ingredients',
          skin_concerns: 'hd_acne; hd_oiliness',
          skin_types: 'oily',
          steps: 'cleanse',
          frequency: 'am-pm',
          draft_cells:
            'ingredients=https://brand.example/ingredients; ingredients_source_url=https://brand.example/ingredients; skin_concerns=https://derm.example/c; skin_types=https://derm.example/t; steps=https://derm.example/s; frequency=https://derm.example/f',
          ...over,
        }),
      ],
      availability: rows,
      countries: [country({ code: 'NG', currency: 'NGN' })],
    })

  it('returns each marked cell with its value and the page it was marked with, in column order', () => {
    const { cells } = draftedValuesOf(drafted(), CODE)

    expect(cells).toEqual([
      { column: 'ingredients', value: ['Aqua', 'Glycerin', 'Niacinamide'], sourceUrl: 'https://brand.example/ingredients' },
      { column: 'skin_concerns', value: ['hd_acne', 'hd_oiliness'], sourceUrl: 'https://derm.example/c' },
      { column: 'skin_types', value: ['oily'], sourceUrl: 'https://derm.example/t' },
      { column: 'steps', value: ['cleanse'], sourceUrl: 'https://derm.example/s' },
      { column: 'frequency', value: 'am-pm', sourceUrl: 'https://derm.example/f' },
    ])
  })

  it('does not count ingredients_source_url as a value of its own: it is the ingredients list\'s page', () => {
    const { cells } = draftedValuesOf(drafted(), CODE)

    expect(cells.map((c) => c.column)).not.toContain('ingredients_source_url')
  })

  it('leaves out a cell the tool did not mark, even when it holds a value (a person typed it)', () => {
    const { cells } = draftedValuesOf(drafted({ draft_cells: 'frequency=https://derm.example/f' }), CODE)

    expect(cells).toEqual([{ column: 'frequency', value: 'am-pm', sourceUrl: 'https://derm.example/f' }])
  })

  it('returns nothing for a product the tool filled nothing for', () => {
    const wb = drafted({ ingredients: null, ingredients_source_url: null, skin_concerns: null, skin_types: null, steps: null, frequency: null, draft_cells: null }, [])

    expect(draftedValuesOf(wb, CODE)).toEqual({ cells: [], prices: [] })
  })

  it('returns the Availability rows of the product, with the shop left out when there is none', () => {
    const wb = drafted({}, [
      availability({ product_code: CODE, country: 'NG', price_min: 4000, price_max: 6500, where_sold: 'Pharmacies', source_url: 'https://shop.example/ng' }),
      availability({ product_code: CODE, country: 'GB', price_min: 9, price_max: 12, where_sold: null, source_url: 'https://shop.example/gb' }),
      availability({ product_code: 'PRD-SOMEONE-ELSE', country: 'NG', source_url: 'https://other.example/x' }),
    ])

    expect(draftedValuesOf(wb, CODE).prices).toEqual([
      { country: 'NG', priceMin: 4000, priceMax: 6500, whereSold: 'Pharmacies', sourceUrl: 'https://shop.example/ng' },
      { country: 'GB', priceMin: 9, priceMax: 12, sourceUrl: 'https://shop.example/gb' },
    ])
  })
})

describe('scoreDraftCase: values', () => {
  it('counts a filled column once, whatever the judge said about it', () => {
    const score = scoreDraftCase(input({ cells: [cell('steps', ['cleanse'], UNVERIFIABLE), cell('frequency', 'pm', CONTRADICTED)] }))

    expect(score.columns.steps).toMatchObject({ filled: 1 })
    expect(score.columns.frequency).toMatchObject({ filled: 1 })
    expect(score.columns.skin_types).toEqual({ filled: 0, grounded: 0, contradicted: 0, unverifiable: 0 })
  })

  it.each([
    ['supports yes and the exact product yes', verdict(), 'grounded'],
    ['supports no', verdict({ supports: 'no' }), 'contradicted'],
    ['a different product (exactProduct no) even when the page supports the value', verdict({ exactProduct: 'no' }), 'contradicted'],
    ['exactProduct no with supports unclear', verdict({ exactProduct: 'no', supports: 'unclear' }), 'contradicted'],
    ['supports no with exactProduct unclear', verdict({ exactProduct: 'unclear', supports: 'no' }), 'contradicted'],
    ['supports unclear', verdict({ supports: 'unclear' }), 'unverifiable'],
    ['exactProduct unclear with supports yes', verdict({ exactProduct: 'unclear' }), 'unverifiable'],
    ['a page that was not fetched, whatever else the verdict says', verdict({ fetched: false }), 'unverifiable'],
    ['a page that was not fetched, even when the verdict says no', verdict({ fetched: false, supports: 'no', exactProduct: 'no' }), 'unverifiable'],
  ] as const)('files a value as %s under %s', (_label, v, bucket) => {
    const score = scoreDraftCase(input({ cells: [cell('skin_types', ['dry'], v)] }))

    expect(score.columns.skin_types).toEqual({ filled: 1, grounded: 0, contradicted: 0, unverifiable: 0, [bucket]: 1 })
  })

  it('adds the columns and the price rows into the case totals', () => {
    const score = scoreDraftCase(
      input({
        cells: [cell('ingredients', ['Aqua'], GROUNDED), cell('skin_concerns', ['hd_acne'], GROUNDED), cell('steps', ['treat'], CONTRADICTED), cell('frequency', 'am', UNVERIFIABLE)],
        prices: [price('NG', GROUNDED), price('GB', CONTRADICTED)],
      }),
    )

    // 4 cells + 2 rows = 6 values: grounded ingredients, concerns, NG; contradicted steps, GB; unverifiable frequency.
    expect(score.values).toEqual({ filled: 6, grounded: 3, contradicted: 2, unverifiable: 1 })
  })

  it('scores a case with nothing drafted as zero everywhere, not as a problem', () => {
    const score = scoreDraftCase(input())

    expect(score.values).toEqual({ filled: 0, grounded: 0, contradicted: 0, unverifiable: 0 })
    expect(score.availability).toEqual({ rows: 0, grounded: 0, contradicted: 0, unverifiable: 0, wrongCurrency: 0 })
  })

  it('carries the case id, kind, state and cost through', () => {
    const score = scoreDraftCase(input({ id: 'x-1', kind: 'trap-sibling', state: 'failed', costMicros: 12_345 }))

    expect(score).toMatchObject({ id: 'x-1', kind: 'trap-sibling', state: 'failed', costMicros: 12_345 })
  })
})

describe('scoreDraftCase: availability', () => {
  it('counts rows drafted, and files each by its verdict', () => {
    const score = scoreDraftCase(input({ prices: [price('NG', GROUNDED), price('GB', CONTRADICTED)] }))

    expect(score.availability).toEqual({ rows: 2, grounded: 1, contradicted: 1, unverifiable: 0, wrongCurrency: 0 })
  })

  it('counts a row whose page showed another currency than its country\'s as wrong-currency', () => {
    const score = scoreDraftCase(input({ prices: [price('NG', verdict({ currencyShown: 'GBP' }))] }))

    expect(score.availability.wrongCurrency).toBe(1)
  })

  it('does not count a row whose page showed the country\'s own currency', () => {
    const score = scoreDraftCase(input({ prices: [price('NG', verdict({ currencyShown: 'NGN' })), price('GB', verdict({ currencyShown: 'GBP' }))] }))

    expect(score.availability.wrongCurrency).toBe(0)
  })

  it('does not count a row for which the judge saw no currency (null or absent)', () => {
    const absent: Verdict = { fetched: true, exactProduct: 'yes', supports: 'yes' }
    const score = scoreDraftCase(input({ prices: [price('NG', verdict({ currencyShown: null })), price('GB', absent)] }))

    expect(score.availability.wrongCurrency).toBe(0)
  })

  it('takes the country\'s currency from the Countries tab it was given, not from a fixed table', () => {
    const right = scoreDraftCase(input({ countries: [GH], prices: [price('GH', verdict({ currencyShown: 'GHS' }))] }))
    const wrong = scoreDraftCase(input({ countries: [GH], prices: [price('GH', verdict({ currencyShown: 'NGN' }))] }))

    expect(right.availability.wrongCurrency).toBe(0)
    expect(wrong.availability.wrongCurrency).toBe(1)
  })

  it('ignores a currency from a page that was never fetched', () => {
    const score = scoreDraftCase(input({ prices: [price('NG', verdict({ fetched: false, exactProduct: 'unclear', supports: 'unclear', currencyShown: 'GBP' }))] }))

    expect(score.availability.wrongCurrency).toBe(0)
  })

  it('counts the price rows in the case totals as values', () => {
    const score = scoreDraftCase(input({ prices: [price('NG', UNVERIFIABLE)] }))

    expect(score.values).toEqual({ filled: 1, grounded: 0, contradicted: 0, unverifiable: 1 })
  })
})

describe('scoreDraftCase: plausibility against the case\'s expected sets (reported, never a gate)', () => {
  it('agrees when every drafted value is inside the plausible set, whatever the order', () => {
    const score = scoreDraftCase(
      input({
        expected: { skinConcernsPlausible: ['hd_acne', 'hd_oiliness', 'hd_pore'], stepsPlausible: ['cleanse'], frequencyPlausible: ['am', 'am-pm'], skinTypesPlausible: ['oily', 'combination'] },
        cells: [cell('skin_concerns', ['hd_pore', 'hd_acne']), cell('steps', ['cleanse']), cell('frequency', 'am-pm'), cell('skin_types', ['combination'])],
      }),
    )

    expect(score.agreement).toEqual({ skin_concerns: 'agree', steps: 'agree', frequency: 'agree', skin_types: 'agree' })
  })

  it('disagrees when one drafted value falls outside the set', () => {
    const score = scoreDraftCase(
      input({
        expected: { skinConcernsPlausible: ['hd_acne', 'hd_oiliness'], frequencyPlausible: ['am'] },
        cells: [cell('skin_concerns', ['hd_acne', 'hd_redness']), cell('frequency', 'weekly')],
      }),
    )

    expect(score.agreement).toEqual({ skin_concerns: 'disagree', frequency: 'disagree' })
  })

  it('judges a drafted "all" against a plausible set that does not hold it as a disagreement', () => {
    const score = scoreDraftCase(input({ expected: { skinTypesPlausible: ['oily', 'dry'] }, cells: [cell('skin_types', ['all'])] }))

    expect(score.agreement).toEqual({ skin_types: 'disagree' })
  })

  it('says nothing about a column the case has no expectation for, or one the tool left empty', () => {
    const score = scoreDraftCase(input({ expected: { stepsPlausible: ['cleanse'] }, cells: [cell('frequency', 'pm')] }))

    expect(score.agreement).toEqual({})
  })

  it('does not let plausibility change a value\'s grounding or the trap result', () => {
    const score = scoreDraftCase(input({ kind: 'trap-sibling', expected: { frequencyPlausible: ['am'] }, cells: [cell('frequency', 'weekly')] }))

    expect(score.columns.frequency).toMatchObject({ grounded: 1 })
    expect(score.trap).toMatchObject({ passed: true })
  })

  it('reads soldIn: a price row for a country the case says it is not sold in is a disagreement, one for a country it is sold in an agreement', () => {
    const score = scoreDraftCase(input({ expected: { soldIn: { NG: true, GB: false } }, prices: [price('NG'), price('GB')] }))

    expect(score.agreement).toEqual({ 'price:NG': 'agree', 'price:GB': 'disagree' })
  })

  it('does not hold it against the tool that it found no price for a country the case says the product is sold in, or that soldIn is unknown', () => {
    const score = scoreDraftCase(input({ expected: { soldIn: { NG: true, GB: 'unknown' } }, prices: [price('GB')] }))

    expect(score.agreement).toEqual({})
  })
})

describe('scoreDraftCase: traps', () => {
  it('gives an ordinary case no trap result', () => {
    expect(scoreDraftCase(input({ kind: 'ordinary', cells: FIVE_CELLS(WRONG_PRODUCT) })).trap).toBeNull()
  })

  describe('trap-sibling: a near-identical product must not be taken for the one asked about', () => {
    it('passes when no value is marked as being from a different product', () => {
      const score = scoreDraftCase(input({ kind: 'trap-sibling', cells: FIVE_CELLS(GROUNDED), prices: [price('NG')] }))

      expect(score.trap).toMatchObject({ passed: true })
    })

    it('passes when the only complaint is that a page does not support a value (that is not the sibling problem)', () => {
      const score = scoreDraftCase(input({ kind: 'trap-sibling', cells: [cell('steps', ['cleanse'], CONTRADICTED)] }))

      expect(score.trap).toMatchObject({ passed: true })
    })

    it('fails when one cell comes from a different product', () => {
      const score = scoreDraftCase(input({ kind: 'trap-sibling', cells: [cell('steps', ['cleanse']), cell('frequency', 'pm', WRONG_PRODUCT)] }))

      expect(score.trap).toMatchObject({ passed: false })
      expect(score.trap!.problems.length).toBeGreaterThan(0)
    })

    it('fails when a price row comes from a different product', () => {
      const score = scoreDraftCase(input({ kind: 'trap-sibling', prices: [price('NG', WRONG_PRODUCT)] }))

      expect(score.trap).toMatchObject({ passed: false })
    })

    it('does not fail on a page that was not fetched, even if the verdict says no (nothing was seen)', () => {
      const score = scoreDraftCase(input({ kind: 'trap-sibling', cells: [cell('steps', ['cleanse'], verdict({ fetched: false, exactProduct: 'no' }))] }))

      expect(score.trap).toMatchObject({ passed: true })
    })
  })

  describe('trap-foreign-currency: a product priced only in another currency must get no price row for that country', () => {
    const expected = { soldIn: { NG: false as const, GB: true as const } }

    it('passes when the only row is for the country that has local prices', () => {
      const score = scoreDraftCase(input({ kind: 'trap-foreign-currency', expected, prices: [price('GB', verdict({ currencyShown: 'GBP' }))] }))

      expect(score.trap).toMatchObject({ passed: true })
    })

    it('passes when no price row was drafted at all', () => {
      expect(scoreDraftCase(input({ kind: 'trap-foreign-currency', expected })).trap).toMatchObject({ passed: true })
    })

    it('fails when there is a row for the country the case says has no local price, even if the judge saw nothing wrong with its currency', () => {
      const score = scoreDraftCase(input({ kind: 'trap-foreign-currency', expected, prices: [price('NG', GROUNDED)] }))

      expect(score.trap).toMatchObject({ passed: false })
    })

    it('fails on a wrong-currency row for any country', () => {
      const score = scoreDraftCase(input({ kind: 'trap-foreign-currency', expected: {}, prices: [price('GB', verdict({ currencyShown: 'USD' }))] }))

      expect(score.trap).toMatchObject({ passed: false })
    })
  })

  describe.each(['trap-unbranded'] as const)('%s: nothing may be drafted at all', (kind) => {
    it('passes when the case ran and nothing was drafted', () => {
      expect(scoreDraftCase(input({ kind })).trap).toMatchObject({ passed: true })
    })

    it('fails on a single drafted cell, however well grounded', () => {
      expect(scoreDraftCase(input({ kind, cells: [cell('frequency', 'am', GROUNDED)] })).trap).toMatchObject({ passed: false })
    })

    it('fails on a single drafted price row', () => {
      expect(scoreDraftCase(input({ kind, prices: [price('NG')] })).trap).toMatchObject({ passed: false })
    })

    it('fails on a drafted ingredient list', () => {
      expect(scoreDraftCase(input({ kind, cells: [cell('ingredients', ['Aqua'])] })).trap).toMatchObject({ passed: false })
    })
  })

  describe('trap-not-skincare: no skincare value may be drafted, but a real product still has an ingredient list and a price', () => {
    it('passes when the case ran and nothing was drafted', () => {
      expect(scoreDraftCase(input({ kind: 'trap-not-skincare' })).trap).toMatchObject({ passed: true })
    })

    it.each(['skin_concerns', 'skin_types', 'steps', 'frequency'] as const)('fails on a drafted %s cell, however well grounded', (column) => {
      const value = column === 'frequency' ? 'am' : ['oily']

      expect(scoreDraftCase(input({ kind: 'trap-not-skincare', cells: [cell(column, value, GROUNDED)] })).trap).toMatchObject({ passed: false })
    })

    it('passes with a drafted ingredient list and price rows alone', () => {
      const score = scoreDraftCase(input({ kind: 'trap-not-skincare', cells: [cell('ingredients', ['Aqua'])], prices: [price('NG'), price('GB')] }))

      expect(score.trap).toMatchObject({ passed: true })
    })

    it('still judges those values like any other: they count as drafted values', () => {
      const score = scoreDraftCase(input({ kind: 'trap-not-skincare', cells: [cell('ingredients', ['Aqua'], CONTRADICTED)], prices: [price('NG')] }))

      expect(score.values).toEqual({ filled: 2, grounded: 1, contradicted: 1, unverifiable: 0 })
    })

    it('fails when a skincare cell comes with the ingredient list and the price', () => {
      const score = scoreDraftCase(input({ kind: 'trap-not-skincare', cells: [cell('ingredients', ['Aqua']), cell('steps', ['cleanse'])], prices: [price('NG')] }))

      expect(score.trap).toMatchObject({ passed: false })
    })
  })

  describe.each(['trap-sibling', 'trap-foreign-currency', 'trap-unbranded', 'trap-not-skincare'] as const)('%s: a trap that never ran proves nothing', (kind) => {
    it.each(['failed', 'skipped', 'cut-off'] as const)('fails when the case is %s, however empty the result looks', (state) => {
      const score = scoreDraftCase(input({ kind, state }))

      expect(score.trap).toMatchObject({ passed: false })
      expect(score.trap!.problems.length).toBeGreaterThan(0)
    })
  })
})

describe('summariseDraft', () => {
  const scored = (inputs: Partial<CaseInput>[]): CaseScore[] => inputs.map((over, i) => scoreDraftCase(input({ id: `case-${i}`, ...over })))

  /** `grounded` + `contradicted` one-value ordinary cases (each a frequency cell), so the contradicted rate is contradicted / (grounded + contradicted). */
  const values = (grounded: number, contradicted: number): CaseScore[] =>
    scored([
      ...Array.from({ length: grounded }, () => ({ cells: [cell('frequency', 'am', GROUNDED)] })),
      ...Array.from({ length: contradicted }, () => ({ cells: [cell('frequency', 'am', CONTRADICTED)] })),
    ])

  it('adds the per-column counts over all cases', () => {
    const summary = summariseDraft(
      scored([
        { cells: [cell('steps', ['cleanse'], GROUNDED), cell('frequency', 'am', CONTRADICTED)] },
        { cells: [cell('steps', ['treat'], UNVERIFIABLE)] },
        { cells: [] },
      ]),
    )

    expect(summary.columns.steps).toEqual({ filled: 2, grounded: 1, contradicted: 0, unverifiable: 1 })
    expect(summary.columns.frequency).toEqual({ filled: 1, grounded: 0, contradicted: 1, unverifiable: 0 })
    expect(summary.columns.skin_concerns).toEqual({ filled: 0, grounded: 0, contradicted: 0, unverifiable: 0 })
  })

  it('adds the availability counts over all cases', () => {
    const summary = summariseDraft(
      scored([{ prices: [price('NG', GROUNDED), price('GB', verdict({ supports: 'no', currencyShown: 'USD' }))] }, { prices: [price('NG', CONTRADICTED)] }]),
    )

    expect(summary.availability).toEqual({ rows: 3, grounded: 1, contradicted: 2, unverifiable: 0, wrongCurrency: 1 })
  })

  it('adds the totals and the cost, and counts the cases that did not complete', () => {
    const summary = summariseDraft(
      scored([
        { cells: [cell('steps', ['cleanse'])], prices: [price('NG')], costMicros: 1_500 },
        { state: 'failed', costMicros: 250 },
        { state: 'skipped' },
        { state: 'cut-off', costMicros: 10 },
        { state: 'cut-off' },
      ]),
    )

    expect(summary.cases).toBe(5)
    expect(summary.values).toEqual({ filled: 2, grounded: 2, contradicted: 0, unverifiable: 0 })
    expect(summary.costMicros).toBe(1_760)
    expect(summary).toMatchObject({ failed: 1, skipped: 1, cutOff: 2 })
  })

  it('counts traps passed out of traps run, and ordinary cases not at all', () => {
    const summary = summariseDraft(scored([{ kind: 'ordinary' }, { kind: 'trap-unbranded' }, { kind: 'trap-unbranded', cells: [cell('steps', ['cleanse'])] }, { kind: 'trap-not-skincare' }]))

    expect(summary.traps).toEqual({ total: 3, passed: 2 })
  })

  it('counts plausibility agreements and disagreements over all cases', () => {
    const summary = summariseDraft(
      scored([
        { expected: { frequencyPlausible: ['am'] }, cells: [cell('frequency', 'am')] },
        { expected: { frequencyPlausible: ['am'] }, cells: [cell('frequency', 'pm')] },
        { expected: { soldIn: { NG: true } }, prices: [price('NG')] },
      ]),
    )

    expect(summary.agreement).toEqual({ agree: 2, disagree: 1 })
  })

  describe('the gate: contradicted rate at most 5% and unverifiable rate at most 35% of drafted values, no wrong-currency row, every trap passed', () => {
    it('holds on an ordinary good run', () => {
      const summary = summariseDraft(values(10, 0))

      expect(summary.gate).toEqual({ holds: true, failures: [] })
    })

    it('holds with exactly 1 contradicted in 20 values: 5.00% is on the line and passes', () => {
      const summary = summariseDraft(values(19, 1))

      expect(summary.values.filled).toBe(20)
      expect(summary.contradictedRate).toBeCloseTo(0.05, 10)
      expect(summary.gate.holds).toBe(true)
    })

    it('fails with 1 contradicted in 19 values: 5.26% is over the line', () => {
      const summary = summariseDraft(values(18, 1))

      expect(summary.values.filled).toBe(19)
      expect(summary.gate.holds).toBe(false)
      expect(summary.gate.failures).toContain('contradicted-rate')
    })

    it('holds with 2 contradicted in 40 values, fails with 2 in 39', () => {
      expect(summariseDraft(values(38, 2)).gate.holds).toBe(true)
      expect(summariseDraft(values(37, 2)).gate.holds).toBe(false)
    })

    it('counts price rows among the drafted values, so a contradicted row weighs the same as a contradicted cell', () => {
      const nineteenCells = scored([{ cells: FIVE_CELLS(GROUNDED).slice(0, 4) }, { cells: FIVE_CELLS(GROUNDED).slice(0, 4) }, { cells: FIVE_CELLS(GROUNDED).slice(0, 4) }, { cells: FIVE_CELLS(GROUNDED).slice(0, 4) }, { cells: FIVE_CELLS(GROUNDED).slice(0, 3) }])
      const withOneBadRow = [...nineteenCells, ...scored([{ prices: [price('NG', CONTRADICTED)] }])]

      // 19 grounded cells + 1 contradicted row = 20 values, 1 contradicted: on the line.
      expect(summariseDraft(withOneBadRow).values).toEqual({ filled: 20, grounded: 19, contradicted: 1, unverifiable: 0 })
      expect(summariseDraft(withOneBadRow).gate.holds).toBe(true)
    })

    it('does not count unverifiable values as contradicted', () => {
      const summary = summariseDraft(values(10, 0).concat(scored([{ cells: [cell('frequency', 'am', UNVERIFIABLE)] }])))

      expect(summary.contradictedRate).toBe(0)
      expect(summary.gate.holds).toBe(true)
    })

    it('does not hold when the judge could vouch for nothing: a run of only unverifiable values proves nothing, however few are contradicted', () => {
      const summary = summariseDraft(scored([{ cells: FIVE_CELLS(UNVERIFIABLE) }]))

      expect(summary.contradictedRate).toBe(0)
      expect(summary.unverifiableRate).toBe(1)
      expect(summary.gate).toEqual({ holds: false, failures: ['unverifiable-rate'] })
    })

    // Unverifiable values are each a frequency cell, so the rate is unverifiable / (grounded + unverifiable).
    const unverifiableValues = (grounded: number, unverifiable: number): CaseScore[] =>
      scored([
        ...Array.from({ length: grounded }, () => ({ cells: [cell('frequency', 'am', GROUNDED)] })),
        ...Array.from({ length: unverifiable }, () => ({ cells: [cell('frequency', 'am', UNVERIFIABLE)] })),
      ])

    it('holds with exactly 7 unverifiable in 20 values: 35.00% is on the line and passes', () => {
      const summary = summariseDraft(unverifiableValues(13, 7))

      expect(summary.values.filled).toBe(20)
      expect(summary.unverifiableRate).toBeCloseTo(0.35, 10)
      expect(summary.gate).toEqual({ holds: true, failures: [] })
    })

    it('fails with 7 unverifiable in 19 values: 36.84% is over the line', () => {
      const summary = summariseDraft(unverifiableValues(12, 7))

      expect(summary.values.filled).toBe(19)
      expect(summary.gate).toEqual({ holds: false, failures: ['unverifiable-rate'] })
    })

    it('holds with 14 unverifiable in 40 values, fails with 14 in 39', () => {
      expect(summariseDraft(unverifiableValues(26, 14)).gate.holds).toBe(true)
      expect(summariseDraft(unverifiableValues(25, 14)).gate.holds).toBe(false)
    })

    it('counts price rows among the values the unverifiable rate is taken of, and a value not fetched as unverifiable', () => {
      const summary = summariseDraft(scored([{ prices: [price('NG', verdict({ fetched: false })), price('GB', GROUNDED)] }]))

      expect(summary.values).toEqual({ filled: 2, grounded: 1, contradicted: 0, unverifiable: 1 })
      expect(summary.gate.failures).toEqual(['unverifiable-rate'])
    })

    it('has a contradicted rate of 0, not NaN, when nothing was drafted', () => {
      const summary = summariseDraft(scored([{}, {}]))

      expect(summary.contradictedRate).toBe(0)
      expect(summary.unverifiableRate).toBe(0)
    })

    it('does not hold when nothing was drafted at all: a run that drafted no value measured no value, however clean it looks', () => {
      const summary = summariseDraft(scored([{}, {}]))

      expect(summary.gate.holds).toBe(false)
      expect(summary.gate.failures).toEqual(['no-values'])
    })

    it('names no-values beside incomplete on a run of no cases', () => {
      expect(summariseDraft([]).gate.failures).toEqual(['incomplete', 'no-values'])
    })

    it('does not name no-values once a single value was drafted', () => {
      expect(summariseDraft(values(1, 0)).gate.failures).toEqual([])
    })

    it('fails on one wrong-currency row however many values are well grounded', () => {
      const summary = summariseDraft([...values(200, 0), ...scored([{ prices: [price('NG', verdict({ currencyShown: 'GBP' }))] }])])

      expect(summary.contradictedRate).toBe(0)
      expect(summary.gate.holds).toBe(false)
      expect(summary.gate.failures).toEqual(['wrong-currency'])
    })

    it('fails when a single trap fails', () => {
      const summary = summariseDraft([...values(30, 0), ...scored([{ kind: 'trap-not-skincare', cells: [cell('steps', ['cleanse'])] }])])

      expect(summary.gate.holds).toBe(false)
      expect(summary.gate.failures).toEqual(['traps'])
    })

    it('names every reason when several fail', () => {
      const summary = summariseDraft([
        ...values(1, 1),
        ...scored([{ kind: 'trap-not-skincare', cells: [cell('steps', ['cleanse'])] }, { prices: [price('NG', verdict({ currencyShown: 'GBP' }))] }]),
      ])

      expect([...summary.gate.failures].sort()).toEqual(['contradicted-rate', 'traps', 'wrong-currency'])
    })

    it.each(['failed', 'skipped', 'cut-off'] as const)('does not hold when an ordinary case is %s: the measurement is incomplete, however clean the rest', (state) => {
      const summary = summariseDraft([...values(10, 0), ...scored([{ state }])])

      expect(summary.gate.holds).toBe(false)
      expect(summary.gate.failures).toEqual(['incomplete'])
    })

    it('does not hold on a run of no cases at all', () => {
      expect(summariseDraft([]).gate.holds).toBe(false)
    })
  })
})

describe('the report lines', () => {
  const score = (over: Partial<CaseInput> = {}) =>
    scoreDraftCase(
      input({
        id: 'cerave-hydrating-cleanser',
        cells: [cell('steps', ['cleanse'], GROUNDED), cell('frequency', 'am-pm', CONTRADICTED), cell('skin_types', ['dry'], UNVERIFIABLE)],
        prices: [price('NG', GROUNDED)],
        costMicros: 12_345,
        ...over,
      }),
    )

  it('formatCaseLine puts the id, the kind, the four counts and the cost on one line', () => {
    const line = formatCaseLine(score())

    expect(line.includes('\n')).toBe(false)
    expect(line).toContain('cerave-hydrating-cleanser')
    expect(line).toContain('ordinary')
    // 3 cells + 1 row: 2 grounded (steps, NG), 1 contradicted (frequency), 1 unverifiable (skin_types).
    expect(line).toContain('filled=4')
    expect(line).toContain('grounded=2')
    expect(line).toContain('contradicted=1')
    expect(line).toContain('unverifiable=1')
    expect(line).toContain('$0.0123')
  })

  it('formatCaseLine shows a trap\'s result as trap=pass or trap=FAIL, and an ordinary case\'s as neither', () => {
    expect(formatCaseLine(score({ kind: 'trap-sibling' }))).toContain('trap=pass')
    expect(formatCaseLine(score({ kind: 'trap-unbranded' }))).toContain('trap=FAIL')
    expect(formatCaseLine(score({ kind: 'ordinary' }))).not.toContain('trap=')
  })

  it('formatCaseLine says when a case failed, was skipped or was cut off by the cap', () => {
    expect(formatCaseLine(score({ state: 'failed' }))).toContain('failed')
    expect(formatCaseLine(score({ state: 'skipped' }))).toContain('skipped')
    expect(formatCaseLine(score({ state: 'cut-off' }))).toContain('cut-off')
  })

  // A run with no trap in it (a --limit trial that stopped before the first trap) is not the gate: it says so instead of a bare PASS.
  it('formatCaseLine shows the class name of the error behind a failed case beside its reason, and no name for a case without one', () => {
    expect(formatCaseLine(score({ state: 'failed', reason: 'drafter-error', errorName: 'AnthropicRequestError' }))).toContain('failed (drafter-error: AnthropicRequestError)')
    expect(formatCaseLine(score({ state: 'failed', reason: 'drafter-error' }))).toContain('failed (drafter-error)')
    expect(scoreDraftCase(input({ state: 'failed', reason: 'drafter-error', errorName: 'AnthropicRequestError' }))).toMatchObject({ errorName: 'AnthropicRequestError' })
    expect(scoreDraftCase(input())).not.toHaveProperty('errorName')
  })

  it('formatGateLine says "no traps covered" when the gate holds over a run with no trap in it', () => {
    expect(formatGateLine(summariseDraft([scoreDraftCase(input({ cells: [cell('steps', ['cleanse'])] }))]))).toBe('Gate: PASS (no traps covered)')
  })

  it('formatGateLine says how many cases and traps a passing gate covered', () => {
    const summary = summariseDraft(
      [input({ id: 'a', cells: [cell('steps', ['cleanse'])] }), input({ id: 'b', kind: 'trap-unbranded' }), input({ id: 'c', kind: 'trap-not-skincare' }), input({ id: 'd' })].map(scoreDraftCase),
    )

    expect(formatGateLine(summary)).toBe('Gate: PASS (4 cases, 2 traps)')
  })

  it('formatGateLine is "Gate: FAIL" with the failed rules and the coverage named when it does not', () => {
    const summary = summariseDraft([scoreDraftCase(input({ cells: [cell('steps', ['cleanse'], CONTRADICTED)] }))])

    expect(formatGateLine(summary)).toMatch(/^Gate: FAIL/)
    expect(formatGateLine(summary)).toContain('contradicted-rate')
    expect(formatGateLine(summary)).toContain('1 case, no traps covered')
  })
})

describe('percent', () => {
  it.each([
    [1, 19, '5.3%'],
    [1, 20, '5.0%'],
    [7, 20, '35.0%'],
    [0, 20, '0.0%'],
    [0, 0, '0.0%'],
    [20, 20, '100.0%'],
    [1, 3, '33.3%'],
  ])('shows %d of %d as %s, one decimal, so the number shown cannot contradict a gate that works to the hundredth of a percent', (part, whole, shown) => {
    expect(percent(part, whole)).toBe(shown)
  })
})

describe('isWrongCurrency', () => {
  it('is true for a fetched page that showed a currency other than the country\'s', () => {
    expect(isWrongCurrency(price('NG', verdict({ currencyShown: 'GBP' })), [NG, GB])).toBe(true)
  })

  it.each([
    ['the right currency', price('NG', verdict({ currencyShown: 'NGN' })), [NG, GB]],
    ['no currency shown', price('NG', verdict({ currencyShown: null })), [NG, GB]],
    ['a page that was not fetched', price('NG', verdict({ fetched: false, currencyShown: 'GBP' })), [NG, GB]],
    ['a country with no currency in the case', price('GH', verdict({ currencyShown: 'GBP' })), [NG, GB]],
  ])('is false for %s', (_label, row, countries) => {
    expect(isWrongCurrency(row, countries)).toBe(false)
  })
})

describe('unverifiable values by reason', () => {
  const reasoned = (reason: Verdict['reason']) => verdict({ fetched: false, exactProduct: 'unclear', supports: 'unclear', reason })

  it('counts each unverifiable value under the reason its verdict gives, over cells and price rows', () => {
    const score = scoreDraftCase(
      input({
        cells: [cell('steps', ['cleanse'], reasoned('refused')), cell('frequency', 'am', reasoned('refused')), cell('skin_types', ['dry'], reasoned('fetch-failed')), cell('skin_concerns', ['hd_acne'], GROUNDED)],
        prices: [price('NG', reasoned('api-error'))],
      }),
    )

    expect(score.unverifiableReasons).toEqual({ 'not-fetched': 0, 'fetch-failed': 1, 'cut-off': 0, refused: 2, 'unreadable-answer': 0, 'api-error': 1, unclear: 0 })
  })

  it('counts a page that was fetched but did not settle the value as "unclear", and a verdict with no reason that was not fetched as not-fetched', () => {
    const score = scoreDraftCase(input({ cells: [cell('steps', ['cleanse'], verdict({ supports: 'unclear' })), cell('frequency', 'am', UNVERIFIABLE)] }))

    expect(score.unverifiableReasons).toMatchObject({ unclear: 1, 'not-fetched': 1 })
  })

  it('does not count a contradicted value, whatever else its verdict holds', () => {
    const score = scoreDraftCase(input({ cells: [cell('steps', ['cleanse'], CONTRADICTED)] }))

    expect(Object.values(score.unverifiableReasons).reduce((a, b) => a + b, 0)).toBe(0)
  })

  it('adds the reasons over all cases, and sums to the unverifiable values', () => {
    const summary = summariseDraft([
      scoreDraftCase(input({ id: 'a', cells: [cell('steps', ['cleanse'], reasoned('cut-off'))] })),
      scoreDraftCase(input({ id: 'b', cells: [cell('steps', ['cleanse'], reasoned('cut-off')), cell('frequency', 'am', reasoned('not-fetched'))] })),
    ])

    expect(summary.unverifiableReasons).toMatchObject({ 'cut-off': 2, 'not-fetched': 1 })
    expect(Object.values(summary.unverifiableReasons).reduce((a, b) => a + b, 0)).toBe(summary.values.unverifiable)
  })

  it('formatUnverifiableLine prints the total and the count of every reason on one line', () => {
    const summary = summariseDraft([scoreDraftCase(input({ cells: [cell('steps', ['cleanse'], reasoned('cut-off')), cell('frequency', 'am', reasoned('not-fetched'))] }))])

    expect(formatUnverifiableLine(summary)).toBe('unverifiable by reason: not-fetched=1 fetch-failed=0 cut-off=1 refused=0 unreadable-answer=0 api-error=0 unclear=0')
  })
})

// A person who opened the page overrules the judge. These checks are calibration data for the eval's own judge, never an input to the drafter.
describe('applyHumanChecks: a person\'s verdict on a value wins over the judge\'s', () => {
  const check = (over: Partial<HumanCheck> = {}): HumanCheck => ({ caseId: 'case-a', column: 'frequency', value: 'am-pm', verdict: 'correct', note: 'n', checkedOn: '2026-10-22', by: 'owner', ...over })

  it('turns a contradicted value into a grounded one when the person says it is correct, and counts it as overruled', () => {
    const checked = applyHumanChecks(input({ cells: [cell('frequency', 'am-pm', CONTRADICTED)] }), [check()])
    const score = scoreDraftCase(checked)

    expect(score.values).toEqual({ filled: 1, grounded: 1, contradicted: 0, unverifiable: 0 })
    expect(score.overruled).toEqual([{ value: 'frequency', judge: 'contradicted', human: 'correct', note: 'n' }])
  })

  it('turns a grounded value into a contradicted one when the person says it is wrong', () => {
    const score = scoreDraftCase(applyHumanChecks(input({ cells: [cell('frequency', 'am-pm', GROUNDED)] }), [check({ verdict: 'wrong' })]))

    expect(score.values).toEqual({ filled: 1, grounded: 0, contradicted: 1, unverifiable: 0 })
    expect(score.overruled).toEqual([{ value: 'frequency', judge: 'grounded', human: 'wrong', note: 'n' }])
  })

  it('settles an unverifiable value either way, and counts that as overruled too', () => {
    const score = scoreDraftCase(applyHumanChecks(input({ cells: [cell('frequency', 'am-pm', UNVERIFIABLE)] }), [check()]))

    expect(score.values.grounded).toBe(1)
    expect(score.overruled).toHaveLength(1)
  })

  it('does not count a value as overruled when the person and the judge agree', () => {
    const score = scoreDraftCase(applyHumanChecks(input({ cells: [cell('frequency', 'am-pm', GROUNDED)] }), [check()]))

    expect(score.values.grounded).toBe(1)
    expect(score.overruled).toEqual([])
  })

  it('overrules a price row by its country, and takes the wrong-currency flag with a verdict the person says is correct', () => {
    const row = price('NG', verdict({ supports: 'no', currencyShown: 'GBP' }), { priceMin: 14900, priceMax: 17700 })
    const score = scoreDraftCase(applyHumanChecks(input({ prices: [row] }), [check({ column: 'price:NG', value: '14900-17700' })]))

    expect(score.availability).toEqual({ rows: 1, grounded: 1, contradicted: 0, unverifiable: 0, wrongCurrency: 0 })
    expect(score.overruled).toMatchObject([{ value: 'price:NG', judge: 'contradicted', human: 'correct' }])
  })

  it.each([
    ['another case', { caseId: 'case-b' }],
    ['another column', { column: 'steps' as const }],
    ['another drafted value: a person checked what was drafted then, not what is drafted now', { value: 'am' }],
    ['another country', { column: 'price:GB' as const, value: '4000-6500' }],
  ])('leaves a value alone when the check is for %s', (_label, over) => {
    const checked = applyHumanChecks(input({ cells: [cell('frequency', 'am-pm', CONTRADICTED)], prices: [price('NG', CONTRADICTED)] }), [check(over)])

    expect(scoreDraftCase(checked).values).toEqual({ filled: 2, grounded: 0, contradicted: 2, unverifiable: 0 })
    expect(scoreDraftCase(checked).overruled).toEqual([])
  })

  it('does not change the input it is given', () => {
    const original = input({ cells: [cell('frequency', 'am-pm', CONTRADICTED)] })

    applyHumanChecks(original, [check()])

    expect(original.cells[0]!.verdict).toEqual(CONTRADICTED)
  })

  it('gates on the person\'s verdict: a value the judge contradicted that the person says is right no longer fails the gate', () => {
    // 1 contradicted in 19 values is 5.26%, over the line (1 in 20 would be exactly on it and pass).
    const cells = [...Array.from({ length: 18 }, () => cell('frequency', 'am', GROUNDED)), cell('steps', ['cleanse'], CONTRADICTED)]
    const withoutCheck = summariseDraft([scoreDraftCase(input({ cells }))])
    const withCheck = summariseDraft([scoreDraftCase(applyHumanChecks(input({ cells }), [check({ column: 'steps', value: 'cleanse' })]))])

    expect(withoutCheck.gate.failures).toContain('contradicted-rate')
    expect(withCheck.gate.failures).not.toContain('contradicted-rate')
  })

  it('sums the overruled values over cases in the summary, each with its case', () => {
    const a = scoreDraftCase(applyHumanChecks(input({ id: 'case-a', cells: [cell('frequency', 'am-pm', CONTRADICTED)] }), [check()]))
    const b = scoreDraftCase(input({ id: 'case-b', cells: [cell('frequency', 'am-pm', CONTRADICTED)] }))
    const summary = summariseDraft([a, b])

    expect(summary.overruled).toEqual([{ caseId: 'case-a', value: 'frequency', judge: 'contradicted', human: 'correct', note: 'n' }])
  })

  it('formatOverruledLines says how many, and lists each value by case, column and both verdicts, never the note', () => {
    const a = scoreDraftCase(applyHumanChecks(input({ id: 'case-a', cells: [cell('frequency', 'am-pm', CONTRADICTED)] }), [check({ note: 'SENTINEL-NOTE' })]))
    const lines = formatOverruledLines(summariseDraft([a]))

    expect(lines).toEqual(['judge overruled by a person: 1', '  case-a frequency judge=contradicted person=correct'])
    expect(formatOverruledLines(summariseDraft([scoreDraftCase(input())]))).toEqual(['judge overruled by a person: 0'])
  })
})
