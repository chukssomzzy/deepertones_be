import { describe, expect, it } from 'vitest'
import { normaliseIngredient } from '../../src/modules/catalog/catalog.ingredients'
import { flagFacts } from '../../src/modules/catalog/catalog.rules'
import { ANALYSIS_CASES, RESEARCH_CASES } from './cases'

// The eval's fixed cases are data, but data that must stay true: an analysis case may only expect what the
// rule checks really flag, or a "failure" in the eval would be the case's fault and not the model's.

const flaggedKinds = (ingredients: string[]) => flagFacts(ingredients).map((f) => f.kind)

describe('ANALYSIS_CASES', () => {
  it('has a unique, non-empty id per case', () => {
    const ids = ANALYSIS_CASES.map((c) => c.id)

    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((id) => id.trim() !== '')).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every case an ingredient list to analyse', () => {
    for (const c of ANALYSIS_CASES) expect(c.ingredients.length, c.id).toBeGreaterThan(0)
  })

  it.each(ANALYSIS_CASES.map((c) => [c.id, c] as const))(
    'expects exactly the facts the rule checks flag, in the same order (%s)',
    (_id, c) => {
      const actual = flagFacts(c.ingredients).map(({ kind, ingredient }) => ({ kind, ingredient }))

      expect(c.expect.flagged).toEqual(actual)
    },
  )

  it.each(ANALYSIS_CASES.map((c) => [c.id, c] as const))(
    'only asks for a minimum severity on a kind the case flags (%s)',
    (_id, c) => {
      const kinds = flaggedKinds(c.ingredients)

      for (const { kind } of c.expect.severityAtLeast ?? []) expect(kinds).toContain(kind)
    },
  )

  it('includes a case with hydroquinone, a banned substance', () => {
    const found = ANALYSIS_CASES.some((c) =>
      c.expect.flagged.some((f) => f.kind === 'banned-substance' && normaliseIngredient(f.ingredient).startsWith('hydroquinone')),
    )

    expect(found).toBe(true)
  })

  it('includes a case with a mercury compound, a banned substance', () => {
    const found = ANALYSIS_CASES.some((c) =>
      c.expect.flagged.some((f) => f.kind === 'banned-substance' && /mercur|calomel/.test(normaliseIngredient(f.ingredient))),
    )

    expect(found).toBe(true)
  })

  it('includes a case with a fragrance allergen', () => {
    expect(ANALYSIS_CASES.some((c) => c.expect.flagged.some((f) => f.kind === 'allergen'))).toBe(true)
  })

  it('includes a clean case that the rule checks flag nothing in', () => {
    const clean = ANALYSIS_CASES.filter((c) => c.expect.flagged.length === 0)

    expect(clean.length).toBeGreaterThan(0)
    for (const c of clean) expect(flagFacts(c.ingredients), c.id).toEqual([])
  })

  it('requires a banned substance to be judged high severity where the case checks severity', () => {
    const banned = ANALYSIS_CASES.flatMap((c) => c.expect.severityAtLeast ?? []).filter((s) => s.kind === 'banned-substance')

    expect(banned.length).toBeGreaterThan(0)
    for (const s of banned) expect(s.severity).toBe('high')
  })
})

describe('RESEARCH_CASES', () => {
  it('has between 5 and 10 cases', () => {
    expect(RESEARCH_CASES.length).toBeGreaterThanOrEqual(5)
    expect(RESEARCH_CASES.length).toBeLessThanOrEqual(10)
  })

  it('has a unique, non-empty id per case', () => {
    const ids = RESEARCH_CASES.map((c) => c.id)

    expect(ids.every((id) => id.trim() !== '')).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('expects every product to be found', () => {
    for (const c of RESEARCH_CASES) expect(c.expect.found, c.id).toBe(true)
  })

  it('expects at least two distinct ingredients per case', () => {
    for (const c of RESEARCH_CASES) {
      const names = c.expect.ingredientsInclude.map(normaliseIngredient)

      expect(names.every((n) => n !== ''), c.id).toBe(true)
      expect(new Set(names).size, c.id).toBeGreaterThanOrEqual(2)
    }
  })

  it('writes expected ingredient names without stray whitespace', () => {
    for (const c of RESEARCH_CASES) {
      for (const name of c.expect.ingredientsInclude) expect(name, c.id).toBe(name.trim())
    }
  })

  it('covers well-known brands sold in Nigeria', () => {
    const wellKnown = ['cerave', 'the ordinary', 'nivea', 'black opal', 'dove', 'vaseline', 'garnier', 'neutrogena', 'la roche-posay', 'olay']
    const brands = new Set(RESEARCH_CASES.map((c) => c.product.brand.trim().toLowerCase()))

    expect([...brands].filter((b) => wellKnown.includes(b)).length).toBeGreaterThanOrEqual(4)
  })

  it('names a brand and a product for every case', () => {
    for (const c of RESEARCH_CASES) {
      expect(c.product.brand.trim(), c.id).not.toBe('')
      expect(c.product.name.trim(), c.id).not.toBe('')
    }
  })
})
