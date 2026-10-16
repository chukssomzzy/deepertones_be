import { describe, expect, it } from 'vitest'
import { ingredientParts, ingredientsKey, normaliseIngredient } from './catalog.ingredients'

describe('normaliseIngredient', () => {
  it.each([
    ['  Aqua  ', 'aqua'],
    ['GLYCERIN', 'glycerin'],
    ['Sodium  Lauryl   Sulfate', 'sodium lauryl sulfate'],
    ['Glycerin*', 'glycerin'],
    ['Parfum †', 'parfum'],
    ['Alcohol Denat.', 'alcohol denat'],
    ['Aqua.*', 'aqua'],
    ['Aqua (Water)', 'aqua (water)'],
  ])('normalises %j to %j', (input, expected) => {
    expect(normaliseIngredient(input)).toBe(expected)
  })

  it('keeps hyphens and digits inside a name', () => {
    expect(normaliseIngredient('Hydroxyisohexyl 3-Cyclohexene Carboxaldehyde')).toBe('hydroxyisohexyl 3-cyclohexene carboxaldehyde')
  })
})

describe('ingredientParts', () => {
  it('is just the name when there is no parenthetical', () => {
    expect(ingredientParts('Glycerin*')).toEqual(['glycerin'])
  })

  it('is the whole name, then the part outside the parentheses, then the part inside', () => {
    expect(ingredientParts('Aqua (Water)')).toEqual(['aqua (water)', 'aqua', 'water'])
    expect(ingredientParts('Parfum (Fragrance)')).toEqual(['parfum (fragrance)', 'parfum', 'fragrance'])
  })

  it('splits a slash into both sides', () => {
    const parts = ingredientParts('Parfum/Fragrance')

    expect(parts[0]).toBe('parfum/fragrance')
    expect(parts).toContain('parfum')
    expect(parts).toContain('fragrance')
  })

  it('handles a bracket in the middle: the name with it removed, and the bracketed part', () => {
    const parts = ingredientParts('Cocos Nucifera (Coconut) Oil')

    expect(parts[0]).toBe('cocos nucifera (coconut) oil')
    expect(parts).toContain('cocos nucifera oil')
    expect(parts).toContain('coconut')
  })

  it.each([
    ['Hydroquinone 4%', 'hydroquinone'],
    ['Hydroquinone USP', 'hydroquinone'],
    ['Hydroquinone BP', 'hydroquinone'],
    ['Hydroquinone EP', 'hydroquinone'],
    ['Hydroquinone 2.5%', 'hydroquinone'],
  ])('strips a trailing strength or grade: %j has the part %j', (raw, part) => {
    expect(ingredientParts(raw)).toContain(part)
  })

  it('strips a trailing strength or grade from each side of a slash', () => {
    const parts = ingredientParts('Retinol 1%/Glycerin USP')

    expect(parts).toContain('retinol')
    expect(parts).toContain('glycerin')
  })

  it('normalises each part', () => {
    expect(ingredientParts('  AQUA  (Water) *')).toEqual(['aqua (water)', 'aqua', 'water'])
  })
})

describe('ingredientsKey', () => {
  it('is equal for lists that differ only in case, spacing and trailing marks', () => {
    expect(ingredientsKey(['Aqua', 'Glycerin*'])).toBe(ingredientsKey(['aqua ', 'GLYCERIN']))
  })

  it('joins the normalised names with newlines', () => {
    expect(ingredientsKey(['Aqua', 'Glycerin*'])).toBe('aqua\nglycerin')
  })

  it('differs when the order differs, because label order is part of the formulation', () => {
    expect(ingredientsKey(['Aqua', 'Glycerin'])).not.toBe(ingredientsKey(['Glycerin', 'Aqua']))
  })

  it('differs when an ingredient is added', () => {
    expect(ingredientsKey(['Aqua'])).not.toBe(ingredientsKey(['Aqua', 'Glycerin']))
  })
})
