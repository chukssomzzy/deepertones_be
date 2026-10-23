import { describe, expect, it } from 'vitest'
import { CATEGORIES, FREQUENCIES, PRODUCT_FORMS, ROUTINE_STEPS } from '../../src/modules/catalog/catalog.vocabulary'
import { SHOWN_CONCERNS, SKIN_TYPE_LABELS } from '../../src/modules/face-scans/face-scans.tables'
import { DRAFT_CASES, type DraftCase } from './draft-cases'
import { DRAFT_HOLDOUT } from './draft-holdout'

// DRAFT_CASES is the measurement set for `npm run eval:catalog -- --mode draft`. It is data, but data that must stay valid: a case the drafter
// cannot be asked about, or an expected value outside the vocabulary, would make the eval's verdict the case's fault. The rules below are written
// out here, not read from the cases, and each loops inside one test so an empty list is valid (it is only ever too short to measure much).

const KINDS = ['ordinary', 'trap-sibling', 'trap-foreign-currency', 'trap-unbranded', 'trap-not-skincare'] as const
const COUNTRIES = ['NG', 'GB']
const MAX_IDENTITY_LENGTH = 120
// The case id becomes the product code EVAL-<ID>, and the contract's code pattern allows 40 characters in all.
const ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,34}$/

const VOCABULARY = {
  skinConcernsPlausible: [...SHOWN_CONCERNS],
  skinTypesPlausible: [...SKIN_TYPE_LABELS, 'all'],
  stepsPlausible: [...ROUTINE_STEPS],
  frequencyPlausible: [...FREQUENCIES],
} as const

// Both sets are held to the same rules. The holdout checks a drafter fix on products the fix was not made against, so a product in both sets would
// defeat it; that is asserted last.
describe.each([
  ['DRAFT_CASES', DRAFT_CASES],
  ['DRAFT_HOLDOUT', DRAFT_HOLDOUT],
] as [string, DraftCase[]][])('%s', (_name, cases) => {
  it('gives every case a unique id that can become a product code', () => {
    const ids = cases.map((c) => c.id)

    for (const id of ids) expect(id, id).toMatch(ID_SHAPE)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every case a known kind', () => {
    for (const c of cases) expect(KINDS, c.id).toContain(c.kind)
  })

  it('can be asked about: a brand, a name and a category from the vocabulary, a form from the vocabulary when there is one, nothing over the contract\'s length', () => {
    for (const { id, product } of cases) {
      expect(product.brand.trim(), `${id} brand`).not.toBe('')
      expect(product.name.trim(), `${id} name`).not.toBe('')
      expect(CATEGORIES, `${id} category`).toContain(product.category)
      if (product.form !== undefined) expect(PRODUCT_FORMS, `${id} form`).toContain(product.form)
      for (const part of [product.brand, product.name, product.variant ?? '']) expect(part.length, `${id} identity length`).toBeLessThanOrEqual(MAX_IDENTITY_LENGTH)
    }
  })

  it('names at least one country for every case, each one NG or GB, without repeats', () => {
    for (const c of cases) {
      expect(c.countries.length, c.id).toBeGreaterThan(0)
      for (const code of c.countries) expect(COUNTRIES, `${c.id} country`).toContain(code)
      expect(new Set(c.countries).size, `${c.id} repeats a country`).toBe(c.countries.length)
    }
  })

  it('expects only values the drafter may write, and plausible sets that are not empty', () => {
    for (const { id, expected } of cases) {
      for (const [key, allowed] of Object.entries(VOCABULARY)) {
        const plausible = (expected as Record<string, string[] | undefined> | undefined)?.[key]
        if (plausible === undefined) continue
        expect(plausible.length, `${id} ${key} is empty`).toBeGreaterThan(0)
        for (const value of plausible) expect(allowed, `${id} ${key}`).toContain(value)
      }
    }
  })

  it('keeps soldIn to countries the case asks about, with true, false or "unknown"', () => {
    for (const { id, countries, expected } of cases) {
      for (const [code, sold] of Object.entries(expected?.soldIn ?? {})) {
        expect(countries, `${id} soldIn.${code}`).toContain(code)
        expect([true, false, 'unknown'], `${id} soldIn.${code}`).toContain(sold)
      }
    }
  })

  it('gives a trap-foreign-currency case, if the set has one, a country it is known not to be sold in, which is what the trap measures', () => {
    for (const c of cases.filter((x) => x.kind === 'trap-foreign-currency')) {
      expect(Object.values(c.expected?.soldIn ?? {}), c.id).toContain(false)
    }
  })

  it('does not hang a plausible set on a trap that must draft nothing', () => {
    for (const c of cases.filter((x) => x.kind === 'trap-unbranded' || x.kind === 'trap-not-skincare')) {
      expect(c.expected?.skinConcernsPlausible, c.id).toBeUndefined()
      expect(c.expected?.stepsPlausible, c.id).toBeUndefined()
    }
  })
})

const identityOf = ({ product }: DraftCase): string => [product.brand, product.name].map((part) => part.trim().toLowerCase()).join('\u0000')

describe('DRAFT_CASES and DRAFT_HOLDOUT together', () => {
  it('share no product (by brand and name, ignoring case) and no case id', () => {
    const measured = new Set(DRAFT_CASES.map(identityOf))
    const measuredIds = new Set(DRAFT_CASES.map((c) => c.id))

    for (const c of DRAFT_HOLDOUT) {
      expect(measured.has(identityOf(c)), `${c.id} is in both sets`).toBe(false)
      expect(measuredIds.has(c.id), `${c.id} id is in both sets`).toBe(false)
    }
  })
})
