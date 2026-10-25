import { describe, expect, it } from 'vitest'
import type { ReferenceEntry } from '../catalog/catalog.reference'
import { anyIn, expandLabels, namedIn } from './safety.matching'

// The shared matching of what a user named (a reaction or a prescription) against ingredient lists. RecommendationService.candidatesFor and the shelf verdict's
// rules floor both use it, so the two always agree on what "the user named this" means. It is pure: no clock, no I/O.
// Expected values are literals worked out from candidatesFor's documented behaviour, never taken from the code under test.

const rule = (name: string, aliases: string[] = []): ReferenceEntry => ({ name, aliases, kind: 'allergen', rule: `${name} (test rule)`, source: null })

const RULES: ReferenceEntry[] = [rule('parfum', ['fragrance']), rule('tretinoin', ['retinoic acid']), rule('hydroquinone', ['quinol'])]

const sorted = (set: Set<string>) => [...set].sort()

describe('expandLabels', () => {
  it('adds every other label of a rule that has one of the names as a label, whichever label was named', () => {
    expect(sorted(expandLabels(new Set(['fragrance']), RULES))).toEqual(['fragrance', 'parfum'])
    expect(sorted(expandLabels(new Set(['parfum']), RULES))).toEqual(['fragrance', 'parfum'])
  })

  it('keeps a name that no rule lists exactly as written, and never guesses at a near one', () => {
    expect(sorted(expandLabels(new Set(['zzyzx wax']), RULES))).toEqual(['zzyzx wax'])
    expect(sorted(expandLabels(new Set(['fragranc']), RULES))).toEqual(['fragranc'])
  })

  it('goes one step from what was named and not on through rules that share a label, so the order of the rules never matters', () => {
    const chained = [rule('alpha', ['beta']), rule('beta', ['gamma'])]

    expect(sorted(expandLabels(new Set(['alpha']), chained))).toEqual(['alpha', 'beta'])
    expect(sorted(expandLabels(new Set(['alpha']), [...chained].reverse()))).toEqual(['alpha', 'beta'])
  })

  it('leaves the set it was given as it was', () => {
    const given = new Set(['fragrance'])

    expandLabels(given, RULES)

    expect(sorted(given)).toEqual(['fragrance'])
  })
})

describe('namedIn', () => {
  it('names a product by its product id, resolved or not, and a product with no id by nothing', () => {
    const named = namedIn(
      [
        { kind: 'product', name: 'Glow Cream', productId: 'prod-1' },
        { kind: 'product', name: 'Mystery Balm', productId: null },
      ],
      RULES,
    )

    expect(sorted(named.productIds)).toEqual(['prod-1'])
    expect(sorted(named.ingredientParts)).toEqual([])
  })

  it('names an ingredient by the parts of its name and every label the rules give it', () => {
    const named = namedIn([{ kind: 'ingredient', name: 'Fragrance', productId: null }], RULES)

    expect(sorted(named.ingredientParts)).toEqual(['fragrance', 'parfum'])
    expect(sorted(named.productIds)).toEqual([])
  })

  it('reads a strength and a bracket the way the rules do, so "Hydroquinone 4%" names hydroquinone and its synonyms', () => {
    const named = namedIn([{ kind: 'ingredient', name: 'Hydroquinone 4%', productId: null }], RULES)

    expect(named.ingredientParts.has('hydroquinone')).toBe(true)
    expect(named.ingredientParts.has('quinol')).toBe(true)
  })

  it('names nothing from no words at all', () => {
    const named = namedIn([], RULES)

    expect(sorted(named.productIds)).toEqual([])
    expect(sorted(named.ingredientParts)).toEqual([])
  })
})

describe('anyIn', () => {
  it('is true when one of the parts is in the set, matched whole', () => {
    expect(anyIn(['aqua', 'parfum'], new Set(['parfum']))).toBe(true)
    expect(anyIn(['alcohol denat'], new Set(['alcohol']))).toBe(false)
    expect(anyIn([], new Set(['alcohol']))).toBe(false)
  })
})
