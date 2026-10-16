import { describe, expect, it } from 'vitest'
import { brandKey, identityKey, nameSimilarity, nearMissCandidates, normaliseText, stripSizes } from './catalog.identity'

// stripSizes may leave a space where the token was; the identity key is what trims it.
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('normaliseText', () => {
  it.each([
    ['L\'Oréal Paris', 'loreal paris'],
    ['L’Oréal Paris', 'loreal paris'],
    ['Crème Brûlée', 'creme brulee'],
    ['Procter & Gamble', 'procter and gamble'],
    ['A&B', 'a and b'],
    ['Olay® Regenerist™ ©', 'olay regenerist'],
    ['Niacinamide 10% + Zinc 1%', 'niacinamide 10 zinc 1'],
    ['Beauty Bar — Original', 'beauty bar original'],
    ['  Hydrating   FACIAL\tCleanser \n', 'hydrating facial cleanser'],
    ['The Ordinary.', 'the ordinary'],
    ['Serum 1.5 OZ', 'serum 1.5 oz'],
    ['SPF 50+', 'spf 50 plus'],
    ['Hydro Boost+', 'hydro boost plus'],
    ['Niacinamide + Zinc', 'niacinamide zinc'],
    ['NC15', 'nc 15'],
    ['SPF15', 'spf 15'],
    ['Tint v2.5', 'tint v 2.5'],
    ['Vitamin C 2.5% Serum', 'vitamin c 2.5 serum'],
  ])('normalises %j to %j', (input, expected) => {
    expect(normaliseText(input)).toBe(expected)
  })

  it('drops a dot unless it sits between two digits', () => {
    expect(normaliseText('Cream. 1.5 oz.')).toBe('cream 1.5 oz')
    expect(normaliseText('v.2 a.b')).toBe('v 2 a b')
  })

  it('returns an empty string for text with no letters or digits', () => {
    expect(normaliseText(' — ® ')).toBe('')
  })
})

describe('stripSizes', () => {
  it.each([
    ['cream 50 ml', 'cream'],
    ['cream 50ml', 'cream'],
    ['bar 100g', 'bar'],
    ['bar 100 g', 'bar'],
    ['bar 10 g', 'bar'],
    ['water 250 l', 'water'],
    ['water 10l', 'water'],
    ['gel 250ml', 'gel'],
    ['gel 1 ml', 'gel'],
    ['pill 2 mg', 'pill'],
    ['pack 1 kg', 'pack'],
    ['pack 1 oz', 'pack'],
    ['mist 1 fl oz', 'mist'],
    ['powder 2 kg', 'powder'],
    ['tablet 500 mg', 'tablet'],
    ['serum 1.5 oz', 'serum'],
    ['mist 3.4 fl oz', 'mist'],
    ['mist 3 floz', 'mist'],
    ['bar 100g original', 'bar original'],
  ])('removes the pack size from %j', (input, expected) => {
    expect(tidy(stripSizes(input))).toBe(expected)
  })

  it.each([['shade 4 l'], ['level 6 g'], ['7 g'], ['water 1 l'], ['oil 0.5l'], ['bar 9 g'], ['bar 9.9g'], ['tone 4l']])(
    'keeps a bare g or l under 10, which is a shade or level and not a size: %j',
    (input) => {
      expect(tidy(stripSizes(input))).toBe(input)
    },
  )

  it.each([['spf 15'], ['vitamin c 10'], ['no 5 lotion'], ['10 gel']])('keeps numbers that are not pack sizes in %j', (input) => {
    expect(tidy(stripSizes(input))).toBe(input)
  })
})

describe('identityKey', () => {
  it.each([
    [{ brand: 'L\'Oréal Paris', name: 'Revitalift Night Cream', variant: '50 ml' }, 'loreal paris|revitalift night cream|'],
    [{ brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: '236ml' }, 'cerave|hydrating facial cleanser|'],
    [
      { brand: 'NIVEA', name: 'Perfect & Radiant Even Tone Day Cream', variant: 'SPF 15' },
      'nivea|perfect and radiant even tone day cream|spf 15',
    ],
    [{ brand: 'The Ordinary.', name: 'Niacinamide 10% + Zinc 1%', variant: undefined }, 'the ordinary|niacinamide 10 zinc 1|'],
    [{ brand: 'Dove', name: 'Beauty Bar — Original 100g', variant: undefined }, 'dove|beauty bar original|'],
  ])('builds the key for %j', (product, expected) => {
    expect(identityKey(product)).toBe(expected)
  })

  it('keeps a shade or level written with a bare L or G', () => {
    expect(identityKey({ brand: 'Fenty', name: 'Foundation', variant: 'Shade 4 L' })).toBe('fenty|foundation|shade 4 l')
    expect(identityKey({ brand: 'Fenty', name: 'Foundation', variant: '7 G' })).toBe('fenty|foundation|7 g')
    expect(identityKey({ brand: 'Fenty', name: 'Level 6 G Cream' })).toBe('fenty|level 6 g cream|')
  })

  it('still drops a 100 g or 250ml size', () => {
    expect(identityKey({ brand: 'Dove', name: 'Bar', variant: '100 g' })).toBe('dove|bar|')
    expect(identityKey({ brand: 'Dove', name: 'Lotion 250ml' })).toBe('dove|lotion|')
  })

  it('reads a plus sign touching a word or number as "plus"', () => {
    expect(identityKey({ brand: 'Nivea', name: 'Sun', variant: 'SPF 50+' })).toBe('nivea|sun|spf 50 plus')
    expect(identityKey({ brand: 'Neutrogena', name: 'Hydro Boost+' })).toBe('neutrogena|hydro boost plus|')
  })

  it('gives the same key whether or not a space separates a letter from its number', () => {
    expect(identityKey({ brand: 'MAC', name: 'Studio Fix', variant: 'NC15' })).toBe(identityKey({ brand: 'MAC', name: 'Studio Fix', variant: 'NC 15' }))
    expect(identityKey({ brand: 'Nivea', name: 'Sun', variant: 'SPF15' })).toBe(identityKey({ brand: 'Nivea', name: 'Sun', variant: 'SPF 15' }))
    expect(identityKey({ brand: 'MAC', name: 'Studio Fix', variant: 'NC15' })).toBe('mac|studio fix|nc 15')
  })

  it('strips a decimal pack size', () => {
    expect(identityKey({ brand: 'Brand', name: 'Serum 1.5 oz' })).toBe('brand|serum|')
  })

  it('keeps a decimal that is not a pack size', () => {
    expect(identityKey({ brand: 'X', name: 'Vitamin C 2.5% Serum' })).toBe('x|vitamin c 2.5 serum|')
  })

  it('gives the same key for case, spacing and an empty variant differences', () => {
    const canonical = identityKey({ brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: '236ml' })

    expect(identityKey({ brand: '  cerave ', name: 'HYDRATING   facial cleanser', variant: '' })).toBe(canonical)
  })

  it('gives different keys to different variants of one product', () => {
    const a = identityKey({ brand: 'Nivea', name: 'Day Cream', variant: 'SPF 15' })
    const b = identityKey({ brand: 'Nivea', name: 'Day Cream', variant: 'SPF 30' })

    expect(a).not.toBe(b)
  })
})

describe('brandKey', () => {
  it('is the normalised brand', () => {
    expect(brandKey('L\'Oréal Paris')).toBe('loreal paris')
    expect(brandKey('  The Ordinary. ')).toBe('the ordinary')
  })
})

describe('nameSimilarity', () => {
  it('is 1 for identical names', () => {
    expect(nameSimilarity({ name: 'Hydrating Facial Cleanser' }, { name: 'hydrating FACIAL cleanser' })).toBe(1)
  })

  it('is 0 for names sharing no word', () => {
    expect(nameSimilarity({ name: 'Day Cream' }, { name: 'Night Serum' })).toBe(0)
  })

  it('is the Jaccard ratio of the words: 3 shared of 4 distinct is 0.75', () => {
    expect(nameSimilarity({ name: 'Hydrating Facial Cleanser' }, { name: 'Hydrating Facial Cleanser Plus' })).toBe(0.75)
  })

  it('is symmetric', () => {
    const a = { name: 'Hydrating Facial Cleanser' }
    const b = { name: 'Hydrating Cleanser' }

    expect(nameSimilarity(a, b)).toBe(nameSimilarity(b, a))
    expect(nameSimilarity(a, b)).toBeCloseTo(2 / 3, 10)
  })

  it('ignores pack sizes', () => {
    expect(nameSimilarity({ name: 'Day Cream 50ml' }, { name: 'Day Cream' })).toBe(1)
  })

  it('pools the name and the variant', () => {
    expect(nameSimilarity({ name: 'Day Cream', variant: 'SPF 15' }, { name: 'Day Cream SPF 15' })).toBe(1)
  })
})

describe('nearMissCandidates', () => {
  const target = { brand: 'CeraVe', name: 'Hydrating Facial Cleanser' }
  const product = (id: string, name: string, variant?: string, brand = 'CeraVe') => ({ id, brand, name, variant })

  const exact = product('exact', 'Hydrating Facial Cleanser 236ml')
  const plusInName = product('a', 'Hydrating Facial Cleanser Plus') // 3/4 = 0.75
  const plusInVariant = product('b', 'Hydrating Facial Cleanser', 'Plus') // 3/4 = 0.75
  const shorter = product('d', 'Hydrating Cleanser') // 2/3
  const atThreshold = product('c', 'Hydrating Facial Cleanser for Normal') // 3/5 = 0.6
  const belowThreshold = product('e', 'Hydrating Facial Cleanser for Normal Dry') // 3/6 = 0.5
  const otherBrand = product('f', 'Hydrating Facial Cleanser Plus', undefined, 'Nivea')
  const unrelated = product('g', 'Foaming Body Wash')

  // b before a on purpose: equal similarity must fall back to id order, not input order.
  const all = [exact, plusInVariant, belowThreshold, otherBrand, unrelated, atThreshold, shorter, plusInName]
  const ids = (found: { id: string }[]) => found.map((p) => p.id)

  it('returns same-brand near misses best first, equal similarity by id', () => {
    expect(ids(nearMissCandidates(target, all, { limit: 10 }))).toEqual(['a', 'b', 'd', 'c'])
  })

  it('excludes a product whose identity key is exactly the target\'s', () => {
    expect(ids(nearMissCandidates(target, all, { limit: 10 }))).not.toContain('exact')
  })

  it('excludes other brands, however similar the name', () => {
    expect(ids(nearMissCandidates(target, all, { limit: 10 }))).not.toContain('f')
  })

  it('includes a product at exactly the default threshold of 0.6 and excludes one just under', () => {
    const found = ids(nearMissCandidates(target, all, { limit: 10 }))

    expect(found).toContain('c')
    expect(found).not.toContain('e')
  })

  it('returns at most 3 by default', () => {
    expect(ids(nearMissCandidates(target, all))).toEqual(['a', 'b', 'd'])
  })

  it('honours a custom limit', () => {
    expect(ids(nearMissCandidates(target, all, { limit: 1 }))).toEqual(['a'])
  })

  it('honours a custom threshold', () => {
    expect(ids(nearMissCandidates(target, all, { threshold: 0.65, limit: 10 }))).toEqual(['a', 'b', 'd'])
    expect(ids(nearMissCandidates(target, all, { threshold: 0.7, limit: 10 }))).toEqual(['a', 'b'])
    expect(ids(nearMissCandidates(target, all, { threshold: 0.75, limit: 10 }))).toEqual(['a', 'b'])
  })

  it('matches the brand by its normalised key', () => {
    const sameBrandSpelled = product('h', 'Hydrating Facial Cleanser Plus', undefined, ' CERAVE® ')

    expect(ids(nearMissCandidates(target, [sameBrandSpelled]))).toEqual(['h'])
  })

  it('returns nothing when there are no products', () => {
    expect(nearMissCandidates(target, [])).toEqual([])
  })
})
