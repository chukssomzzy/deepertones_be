import { describe, expect, it } from 'vitest'
import { brandFirstWord, brandKey, identityKey, lessSpecific, namesAnotherEdition, nameSimilarity, nearMissCandidates, normaliseText, pagesByNameMatch, sameBrandFamily, stripSizes } from './catalog.identity'

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
    [{ brand: 'L\'Oréal Paris', name: 'Revitalift Night Cream', variant: '50 ml' }, 'loreal paris|revitalift night cream||'],
    [{ brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: '236ml' }, 'cerave|hydrating facial cleanser||'],
    [
      { brand: 'NIVEA', name: 'Perfect & Radiant Even Tone Day Cream', variant: 'SPF 15' },
      'nivea|perfect and radiant even tone day cream|spf 15|',
    ],
    [{ brand: 'The Ordinary.', name: 'Niacinamide 10% + Zinc 1%', variant: undefined }, 'the ordinary|niacinamide 10 zinc 1||'],
    [{ brand: 'Dove', name: 'Beauty Bar — Original 100g', variant: undefined }, 'dove|beauty bar original||'],
  ])('builds the key for %j', (product, expected) => {
    expect(identityKey(product)).toBe(expected)
  })

  it('keeps a shade or level written with a bare L or G', () => {
    expect(identityKey({ brand: 'Fenty', name: 'Foundation', variant: 'Shade 4 L' })).toBe('fenty|foundation|shade 4 l|')
    expect(identityKey({ brand: 'Fenty', name: 'Foundation', variant: '7 G' })).toBe('fenty|foundation|7 g|')
    expect(identityKey({ brand: 'Fenty', name: 'Level 6 G Cream' })).toBe('fenty|level 6 g cream||')
  })

  it('still drops a 100 g or 250ml size', () => {
    expect(identityKey({ brand: 'Dove', name: 'Bar', variant: '100 g' })).toBe('dove|bar||')
    expect(identityKey({ brand: 'Dove', name: 'Lotion 250ml' })).toBe('dove|lotion||')
  })

  it('reads a plus sign touching a word or number as "plus"', () => {
    expect(identityKey({ brand: 'Nivea', name: 'Sun', variant: 'SPF 50+' })).toBe('nivea|sun|spf 50 plus|')
    expect(identityKey({ brand: 'Neutrogena', name: 'Hydro Boost+' })).toBe('neutrogena|hydro boost plus||')
  })

  it('gives the same key whether or not a space separates a letter from its number', () => {
    expect(identityKey({ brand: 'MAC', name: 'Studio Fix', variant: 'NC15' })).toBe(identityKey({ brand: 'MAC', name: 'Studio Fix', variant: 'NC 15' }))
    expect(identityKey({ brand: 'Nivea', name: 'Sun', variant: 'SPF15' })).toBe(identityKey({ brand: 'Nivea', name: 'Sun', variant: 'SPF 15' }))
    expect(identityKey({ brand: 'MAC', name: 'Studio Fix', variant: 'NC15' })).toBe('mac|studio fix|nc 15|')
  })

  it('strips a decimal pack size', () => {
    expect(identityKey({ brand: 'Brand', name: 'Serum 1.5 oz' })).toBe('brand|serum||')
  })

  it('keeps a decimal that is not a pack size', () => {
    expect(identityKey({ brand: 'X', name: 'Vitamin C 2.5% Serum' })).toBe('x|vitamin c 2.5 serum||')
  })

  it('gives the same key for case, spacing and an empty variant differences', () => {
    const canonical = identityKey({ brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: '236ml' })

    expect(identityKey({ brand: '  cerave ', name: 'HYDRATING   facial cleanser', variant: '' })).toBe(canonical)
  })

  it('ends the key with the form, so a spray and a roll-on of one name have different keys', () => {
    const spray = identityKey({ brand: 'NIVEA MEN', name: 'Dry Impact', form: 'spray' })
    const rollOn = identityKey({ brand: 'NIVEA MEN', name: 'Dry Impact', form: 'roll-on' })

    expect(spray).toBe('nivea men|dry impact||spray')
    expect(rollOn).toBe('nivea men|dry impact||roll-on')
    expect(identityKey({ brand: 'NIVEA MEN', name: 'Dry Impact', variant: 'Fresh', form: 'stick' })).toBe('nivea men|dry impact|fresh|stick')
  })

  it('gives a formless product a key ending in a bar, different from the same product with a form', () => {
    const formless = identityKey({ brand: 'NIVEA MEN', name: 'Dry Impact' })

    expect(formless).toBe('nivea men|dry impact||')
    expect(formless).not.toBe(identityKey({ brand: 'NIVEA MEN', name: 'Dry Impact', form: 'spray' }))
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

describe('brandFirstWord', () => {
  it.each([
    ['NIVEA MEN', 'nivea'],
    ['NIVEA', 'nivea'],
    ['  The Ordinary. ', 'the'],
    ['L\'Oréal Paris', 'loreal'],
    ['Dr. Jart+', 'dr'],
  ])('reads %j as the family word %j', (brand, word) => {
    expect(brandFirstWord(brand)).toBe(word)
  })
})

describe('sameBrandFamily', () => {
  it.each([
    ['NIVEA', 'NIVEA MEN'],
    ['NIVEA MEN', 'NIVEA SUN'],
    ['nivea', ' Nivea® '],
    ['The Ordinary', 'The Body Shop'],
  ])('puts %j and %j in one family', (a, b) => {
    expect(sameBrandFamily(a, b)).toBe(true)
    expect(sameBrandFamily(b, a)).toBe(true)
  })

  it.each([
    ['NIVEA', 'NIVEAUX'],
    ['NIVEA', 'Dove'],
    ['Body NIVEA', 'NIVEA'],
    ['NIVEA', 'Johnson Nivea'],
  ])('keeps %j and %j in different families', (a, b) => {
    expect(sameBrandFamily(a, b)).toBe(false)
    expect(sameBrandFamily(b, a)).toBe(false)
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

  it('pools the brand, the name and the variant, so a word that moved between brand and name still counts', () => {
    expect(nameSimilarity({ brand: 'NIVEA MEN', name: 'DRY IMPACT' }, { brand: 'NIVEA', name: 'MEN DRY IMPACT' })).toBe(1)
    expect(nameSimilarity({ brand: 'NIVEA', name: 'MEN', variant: 'Dry Impact' }, { brand: 'NIVEA MEN', name: 'DRY IMPACT' })).toBe(1)
    expect(nameSimilarity({ brand: 'NIVEA', name: 'MEN', variant: 'Dry Impact' }, { brand: 'NIVEA', name: 'MEN DRY IMPACT' })).toBe(1)
  })

  it('counts the brand words, so brands that differ lower the ratio: 4 shared of 7 distinct is 4/7', () => {
    const a = { brand: 'The Ordinary', name: 'Tea Tree Oil' }
    const b = { brand: 'The Body Shop', name: 'Tea Tree Oil' }

    expect(nameSimilarity(a, b)).toBeCloseTo(4 / 7, 10)
    expect(nameSimilarity(b, a)).toBeCloseTo(4 / 7, 10)
  })
})

describe('nearMissCandidates', () => {
  const target = { brand: 'CeraVe', name: 'Hydrating Facial Cleanser' }
  const product = (id: string, name: string, variant?: string, brand = 'CeraVe') => ({ id, brand, name, variant })

  const exact = product('exact', 'Hydrating Facial Cleanser 236ml')
  // Similarities include the brand word: the target is {cerave, hydrating, facial, cleanser}.
  const plusInName = product('a', 'Hydrating Facial Cleanser Plus') // 4/5 = 0.8
  const plusInVariant = product('b', 'Hydrating Facial Cleanser', 'Plus') // 4/5 = 0.8
  const shorter = product('d', 'Hydrating Cleanser') // 3/4 = 0.75
  const atThreshold = product('c', 'Hydrating Facial Cleanser for Normal') // 4/6 = 0.667
  const belowThreshold = product('e', 'Hydrating Foaming Cleanser for Normal Dry') // 3/8 = 0.375, and the target's words are not all inside it
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

  it('includes a product above the default threshold of 0.6 and excludes one just under', () => {
    const found = ids(nearMissCandidates(target, all, { limit: 10 }))

    expect(found).toContain('c')
    expect(found).not.toContain('e')
  })

  it('includes a product whose combined brand, name and variant words are at exactly the default threshold of 0.6', () => {
    // {acme, serum, glow, night} against {acme, serum, glow, oil}: 3/5. Each lacks a word of the other, so neither is a containment.
    const atBoundary = product('at', 'Serum Glow Oil', undefined, 'Acme')
    // {acme, serum, glow, night} against {acme, serum, glow, oil, mask}: 3/6.
    const justUnder = product('under', 'Serum Glow Oil Mask', undefined, 'Acme')

    expect(ids(nearMissCandidates({ brand: 'Acme', name: 'Serum Glow Night' }, [atBoundary, justUnder]))).toEqual(['at'])
  })

  it('returns at most 3 by default', () => {
    expect(ids(nearMissCandidates(target, all))).toEqual(['a', 'b', 'd'])
  })

  it('honours a custom limit', () => {
    expect(ids(nearMissCandidates(target, all, { limit: 1 }))).toEqual(['a'])
  })

  it('honours a custom threshold', () => {
    // Containment bypasses the threshold, so these are all partial overlaps: {cerave, hydrating, facial, cleanser, gentle, foaming} against each.
    const base = { brand: 'CeraVe', name: 'Hydrating Facial Cleanser Gentle Foaming' }
    const five = product('x1', 'Hydrating Facial Cleanser Gentle Plus') // 5 shared of 7: 0.714
    const withExtras = product('x3', 'Hydrating Facial Cleanser Gentle Plus Night') // 5 of 8: 0.625
    const four = product('x2', 'Hydrating Facial Cleanser Plus Night') // 4 of 8: 0.5
    const list = [four, withExtras, five]

    expect(ids(nearMissCandidates(base, list, { threshold: 0.5, limit: 10 }))).toEqual(['x1', 'x3', 'x2'])
    expect(ids(nearMissCandidates(base, list, { threshold: 0.6, limit: 10 }))).toEqual(['x1', 'x3'])
    expect(ids(nearMissCandidates(base, list, { threshold: 0.7, limit: 10 }))).toEqual(['x1'])
    expect(ids(nearMissCandidates(base, list, { threshold: 0.72, limit: 10 }))).toEqual([])
  })

  it('matches the brand by its normalised key', () => {
    const sameBrandSpelled = product('h', 'Hydrating Facial Cleanser Plus', undefined, ' CERAVE® ')

    expect(ids(nearMissCandidates(target, [sameBrandSpelled]))).toEqual(['h'])
  })

  describe('across a brand family', () => {
    const nivea = { brand: 'NIVEA', name: 'MEN DRY IMPACT' }

    it('returns a product whose brand shares the first word and whose words moved between brand and name', () => {
      const split = product('men', 'DRY IMPACT', undefined, 'NIVEA MEN')

      expect(ids(nearMissCandidates(nivea, [split]))).toEqual(['men'])
    })

    it('returns the same product under the other split of the third form, with the words in the variant', () => {
      const split = product('variant', 'MEN', 'Dry Impact', 'NIVEA')

      expect(ids(nearMissCandidates(nivea, [split]))).toEqual(['variant'])
    })

    it('leaves out a family member whose combined words overlap too little', () => {
      const sun = product('sun', 'Protect & Moisture', undefined, 'NIVEA SUN')

      expect(nearMissCandidates(nivea, [sun])).toEqual([])
    })

    it('leaves out a brand that shares only a first word, even with the same product name', () => {
      const target = { brand: 'The Ordinary', name: 'Tea Tree Oil' }
      const other = product('shop', 'Tea Tree Oil', undefined, 'The Body Shop')

      expect(nearMissCandidates(target, [other])).toEqual([])
    })

    it('leaves out a brand that merely starts with the same letters', () => {
      expect(nearMissCandidates(nivea, [product('ux', 'MEN DRY IMPACT', undefined, 'NIVEAUX')])).toEqual([])
    })

    it('leaves out a product whose identity key is the target\'s', () => {
      expect(nearMissCandidates(nivea, [product('same', 'MEN DRY IMPACT', undefined, ' nivea ')])).toEqual([])
    })
  })

  it('returns nothing when there are no products', () => {
    expect(nearMissCandidates(target, [])).toEqual([])
  })

  // A reading whose words are all inside another's is a candidate however low the Jaccard ratio falls; the same-product judge is the gate.
  describe('by containment', () => {
    it.each([
      ['NIVEA "soft" inside "Soft Light Moisturiser"', { brand: 'NIVEA', name: 'soft' }, { brand: 'NIVEA', name: 'Soft Light Moisturiser' }],
      ["Palmer's formula inside the same with Daily Body Lotion", { brand: "Palmer's", name: 'Cocoa Butter Formula' }, { brand: "Palmer's", name: 'Cocoa Butter Formula Daily Body Lotion' }],
      ["Palmer's formula inside the same with Vitamin E", { brand: "Palmer's", name: 'Cocoa Butter Formula' }, { brand: "Palmer's", name: 'Cocoa Butter Formula with Vitamin E' }],
      ['Cetaphil with no variant inside Cetaphil with one', { brand: 'Cetaphil', name: 'Gentle Skin Cleanser' }, { brand: 'Cetaphil', name: 'Gentle Skin Cleanser', variant: 'For all skin types' }],
    ])('returns a stored product when %s (scanned is the shorter)', (_label, scanned, stored) => {
      expect(ids(nearMissCandidates(scanned, [{ id: 'stored', ...stored }]))).toEqual(['stored'])
    })

    it.each([
      ['NIVEA "Soft Light Moisturiser" scanned, "soft" stored', { brand: 'NIVEA', name: 'Soft Light Moisturiser' }, { brand: 'NIVEA', name: 'soft' }],
      ['Cetaphil with a variant scanned, none stored', { brand: 'Cetaphil', name: 'Gentle Skin Cleanser', variant: 'For all skin types' }, { brand: 'Cetaphil', name: 'Gentle Skin Cleanser' }],
    ])('returns a stored product when %s (stored is the shorter)', (_label, scanned, stored) => {
      expect(ids(nearMissCandidates(scanned, [{ id: 'stored', ...stored }]))).toEqual(['stored'])
    })

    it('finds the containment where the Jaccard ratio alone is under the threshold', () => {
      // {nivea, soft} against {nivea, soft, light, moisturiser}: 2/4 = 0.5.
      const found = nearMissCandidates({ brand: 'NIVEA', name: 'soft' }, [{ id: 'x', brand: 'NIVEA', name: 'Soft Light Moisturiser' }])
      expect(ids(found)).toEqual(['x'])
    })

    it('does not make a candidate of a reading that only overlaps without being contained', () => {
      // "Moisturizing Cream" is not inside "Soft Light Moisturiser", and 2/6 is under the threshold.
      const found = nearMissCandidates({ brand: 'NIVEA', name: 'Soft Moisturizing Cream' }, [{ id: 'x', brand: 'NIVEA', name: 'Soft Light Moisturiser' }])
      expect(found).toEqual([])
    })

    it.each([
      ['Vaseline Cocoa Radiant and Aloe Soothe', { brand: 'Vaseline', name: 'Cocoa Radiant' }, { brand: 'Vaseline', name: 'Aloe Soothe' }],
      ['Cantu Leave-In and Curling Cream', { brand: 'Cantu', name: 'Leave-In Conditioning Repair Cream' }, { brand: 'Cantu', name: 'Curling Cream' }],
      ['The Ordinary Niacinamide 10% + Zinc 1% and Hyaluronic Acid 2% + B5', { brand: 'The Ordinary', name: 'Niacinamide 10% + Zinc 1%' }, { brand: 'The Ordinary', name: 'Hyaluronic Acid 2% + B5' }],
      ['NIVEA Soft and Creme', { brand: 'NIVEA', name: 'Soft' }, { brand: 'NIVEA', name: 'Creme' }],
    ])('keeps look-alikes apart: %s are not candidates of each other', (_label, a, b) => {
      expect(nearMissCandidates(a, [{ id: 'b', ...b }])).toEqual([])
      expect(nearMissCandidates(b, [{ id: 'a', ...a }])).toEqual([])
    })

    it('leaves AM and PM lotions to the Jaccard rule as before: still candidates, never merged without the judge', () => {
      // {cerave, am, facial, moisturizing, lotion} against the PM one: 4/6, as before the containment rule.
      const found = nearMissCandidates({ brand: 'CeraVe', name: 'AM Facial Moisturizing Lotion' }, [{ id: 'pm', brand: 'CeraVe', name: 'PM Facial Moisturizing Lotion' }])
      expect(ids(found)).toEqual(['pm'])
    })

    it('never makes a candidate of a reading that is only the brand, which every product of the brand contains', () => {
      const brandOnly = nearMissCandidates({ brand: 'NIVEA', name: '' }, [
        { id: 'a', brand: 'NIVEA', name: 'Soft Light Moisturiser' },
        { id: 'b', brand: 'NIVEA', name: 'Creme' },
      ])
      const brandAsName = nearMissCandidates({ brand: 'NIVEA', name: 'Nivea' }, [{ id: 'a', brand: 'NIVEA', name: 'Soft Light Moisturiser' }])

      expect(brandOnly).toEqual([])
      expect(brandAsName).toEqual([])
    })

    it('does not make a stored brand-only product a candidate of every reading either', () => {
      expect(nearMissCandidates({ brand: 'NIVEA', name: 'Soft Light Moisturiser' }, [{ id: 'bare', brand: 'NIVEA', name: '' }])).toEqual([])
    })

    it('does not pool a pack size into the containment: a size-only difference is the same key, not a candidate', () => {
      expect(nearMissCandidates({ brand: 'NIVEA', name: 'Soft 200ml' }, [{ id: 'same', brand: 'NIVEA', name: 'Soft' }])).toEqual([])
    })

    it('still leaves out another brand family, however fully contained', () => {
      expect(nearMissCandidates({ brand: 'NIVEA', name: 'Soft' }, [{ id: 'o', brand: 'Dove', name: 'Soft Light Moisturiser' }])).toEqual([])
    })

    it('still leaves out a product with the target\'s identity key', () => {
      expect(nearMissCandidates({ brand: 'NIVEA', name: 'Soft' }, [{ id: 'same', brand: ' nivea ', name: 'SOFT' }])).toEqual([])
    })

    it('keeps "NIVEA soft" a containment of "NIVEA Soft Light Moisturiser": soft is neither the brand nor a generic word', () => {
      expect(ids(nearMissCandidates({ brand: 'NIVEA', name: 'soft' }, [{ id: 'x', brand: 'NIVEA', name: 'Soft Light Moisturiser' }]))).toEqual(['x'])
    })

    it.each([
      ['Body Wash in Go Fresh Body Wash', { brand: 'Dove', name: 'Body Wash' }, { brand: 'Dove', name: 'Go Fresh Body Wash' }],
      ['Daily Lotion in Daily Body Lotion Radiant', { brand: 'Vaseline', name: 'Daily Lotion' }, { brand: 'Vaseline', name: 'Daily Body Lotion Radiant' }],
      ['Original Soap in Original Black Soap', { brand: 'Dudu', name: 'Original Soap' }, { brand: 'Dudu', name: 'Original Black Soap' }],
    ])('is not a containment when the shorter side has only brand and generic words: %s', (_label, scanned, stored) => {
      expect(nearMissCandidates(scanned, [{ id: 'stored', ...stored }], { threshold: 0.99 })).toEqual([])
    })

    it('leaves the generic-only reading to the Jaccard rule, where it can still be a candidate', () => {
      // {dove, body, wash} against {dove, go, fresh, body, wash}: 3/5 = 0.6.
      expect(ids(nearMissCandidates({ brand: 'Dove', name: 'Body Wash' }, [{ id: 'g', brand: 'Dove', name: 'Go Fresh Body Wash' }]))).toEqual(['g'])
    })

    it('ranks a containment candidate by similarity with the rest, and the limit still applies', () => {
      const scanned = { brand: 'Palmer\'s', name: 'Cocoa Butter Formula' } // {palmers, cocoa, butter, formula}
      const close = { id: 'close', brand: "Palmer's", name: 'Cocoa Butter Formula Lotion' } // 4/5 by Jaccard, and contained
      const wider = { id: 'wider', brand: "Palmer's", name: 'Cocoa Butter Formula Daily Body Lotion' } // 4/7, contained only
      const nearer = { id: 'nearer', brand: "Palmer's", name: 'Cocoa Butter Formula Daily Lotion' } // 4/6, contained and at the threshold
      const widest = { id: 'widest', brand: "Palmer's", name: 'Cocoa Butter Formula with Vitamin E Daily Lotion' } // 4/8, contained only

      expect(ids(nearMissCandidates(scanned, [widest, wider, nearer, close], { limit: 10 }))).toEqual(['close', 'nearer', 'wider', 'widest'])
      expect(ids(nearMissCandidates(scanned, [widest, wider, nearer, close]))).toEqual(['close', 'nearer', 'wider'])
    })
  })

  // A row written before the % size fix carries the key that code produced; the key its fields produce today is another
  // string. Judging sameness on the recomputed key would hide that row from the judge, which is the duplicate it exists to stop.
  describe('with a stored identity key', () => {
    const ASCORBIC = { brand: 'The Ordinary', name: '100% L-Ascorbic Acid Powder' }
    /** The key a Worker before the % fix wrote for this product: "100%" read as "100 l", 100 litres, and stripped as a size. */
    const OLD_KEY = 'the ordinary|ascorbic acid powder||'
    /** The key the same reading has now. */
    const NEW_KEY = 'the ordinary|100 l ascorbic acid powder||'

    it('no longer produces the pre-fix key for the reading itself', () => {
      expect(identityKey(ASCORBIC)).toBe(NEW_KEY)
      expect(identityKey(ASCORBIC)).not.toBe(OLD_KEY)
    })

    it('makes a row whose stored key differs from the target a candidate, though recomputing the row\'s key would equal the target\'s', () => {
      const stale = { id: 'stale', ...ASCORBIC, identityKey: OLD_KEY }

      expect(ids(nearMissCandidates(ASCORBIC, [stale]))).toEqual(['stale'])
    })

    it('still leaves out a row whose stored key is the target\'s', () => {
      const current = { id: 'current', ...ASCORBIC, identityKey: NEW_KEY }

      expect(nearMissCandidates(ASCORBIC, [current])).toEqual([])
    })

    it('falls back to the recomputed key for a product that carries none', () => {
      expect(nearMissCandidates(ASCORBIC, [{ id: 'keyless', ...ASCORBIC }])).toEqual([])
    })
  })
})

describe('lessSpecific', () => {
  it('is true for a strict subset of the pooled words, false for equal, superset and unrelated words', () => {
    expect(lessSpecific({ brand: 'Dove', name: 'Body Wash' }, { brand: 'Dove', name: 'Deeply Nourishing Body Wash' })).toBe(true)
    expect(lessSpecific({ brand: 'Dove', name: 'Body Wash' }, { brand: 'Dove', name: 'wash body' })).toBe(false)
    expect(lessSpecific({ brand: 'Dove', name: 'Deeply Nourishing Body Wash' }, { brand: 'Dove', name: 'Body Wash' })).toBe(false)
    expect(lessSpecific({ brand: 'Dove', name: 'Go Fresh' }, { brand: 'Dove', name: 'Body Wash' })).toBe(false)
  })
})

describe('namesAnotherEdition', () => {
  it('is true when the label names a variant word the variantless product does not hold', () => {
    expect(namesAnotherEdition({ brand: 'Dove', name: 'Body Wash', variant: 'Shea Butter' }, { brand: 'Dove', name: 'Body Wash' })).toBe(true)
  })

  it('is false when the variant words are already in the product, split differently', () => {
    expect(namesAnotherEdition({ brand: 'NIVEA', name: 'MEN', variant: 'Dry Impact' }, { brand: 'NIVEA MEN', name: 'DRY IMPACT' })).toBe(false)
  })

  it('is false when the product has a variant of its own, or the label has none', () => {
    expect(namesAnotherEdition({ brand: 'Dove', name: 'Body Wash', variant: 'Shea Butter' }, { brand: 'Dove', name: 'Body Wash', variant: 'Cucumber' })).toBe(false)
    expect(namesAnotherEdition({ brand: 'Dove', name: 'Body Wash' }, { brand: 'Dove', name: 'Body Wash' })).toBe(false)
    expect(namesAnotherEdition({ brand: 'Dove', name: 'Body Wash', variant: '' }, { brand: 'Dove', name: 'Body Wash', variant: null })).toBe(false)
  })

  it('ignores pack sizes in the variant', () => {
    expect(namesAnotherEdition({ brand: 'Dove', name: 'Body Wash', variant: '250 ml' }, { brand: 'Dove', name: 'Body Wash' })).toBe(false)
  })
})

describe('pagesByNameMatch', () => {
  const PALMERS = { brand: "Palmer's", name: 'Cocoa Butter Formula Body Lotion' }
  const CANTU = { brand: 'Cantu', name: 'Shea Butter Leave-In Conditioning Repair Cream' }

  const MEDINO = 'https://www.medino.com/palmers-cocoa-butter-formula-body-lotion-400ml'
  const CVS = 'https://www.cvs.com/shop/palmers-cocoa-butter-formula-lotion-prodid-1234'
  const INCIDECODER = 'https://incidecoder.com/products/palmers-cocoa-butter-formula'
  const PALMERS_HOME = 'https://www.palmers.com/'

  it('breaks a tie towards the page with fewer words beyond the product, so a sibling edition comes after it', () => {
    const sibling = 'https://a.example/palmers-cocoa-butter-formula-men-body-lotion'
    const exact = 'https://b.example/palmers-cocoa-butter-formula-body-lotion'

    expect(pagesByNameMatch([sibling, exact], PALMERS)).toEqual([exact, sibling])
  })

  it('counts www.shop.example and shop.example as one site', () => {
    const first = 'https://www.shop.example/palmers-cocoa-butter-formula-body-lotion'
    const second = 'https://shop.example/palmers-cocoa-butter-formula-body-lotion-250ml'

    expect(pagesByNameMatch([first, second], PALMERS)).toEqual([first])
  })

  it('puts the page whose path names most of the product first', () => {
    const ranked = pagesByNameMatch([INCIDECODER, CVS, MEDINO], PALMERS)

    expect(ranked).toEqual([MEDINO, CVS, INCIDECODER])
  })

  it('drops the brand home page, whose path names nothing of the product', () => {
    expect(pagesByNameMatch([PALMERS_HOME, MEDINO], PALMERS)).toEqual([MEDINO])
  })

  it('drops a page that matches only the brand', () => {
    expect(pagesByNameMatch(['https://shop.example/brands/palmers'], PALMERS)).toEqual([])
  })

  it('drops a page that matches only generic words such as lotion and body', () => {
    expect(pagesByNameMatch(['https://shop.example/body-lotion'], PALMERS)).toEqual([])
  })

  it('drops a page that matches only the brand and generic words together', () => {
    expect(pagesByNameMatch(['https://shop.example/palmers-body-lotion'], PALMERS)).toEqual([])
  })

  it('keeps a page that matches a single word beyond the brand and the generic words', () => {
    expect(pagesByNameMatch(['https://shop.example/cocoa'], PALMERS)).toEqual(['https://shop.example/cocoa'])
  })

  it('ranks the exact Cantu product above another Cantu product that shares only some of its words', () => {
    const curl = 'https://www.bswbeautyca.com/cantu-shea-butter-moisturizing-curl-activator-cream'
    const exact = 'https://www.nattoral.com/cantu-shea-butter-leave-in-conditioning-repair-cream-16-oz'

    expect(pagesByNameMatch([curl, exact], CANTU)).toEqual([exact, curl])
  })

  it('keeps the input order between pages with the same score', () => {
    const first = 'https://one.example/cocoa-butter-lotion'
    const second = 'https://two.example/cocoa-butter-lotion'
    const third = 'https://three.example/cocoa-butter-lotion'

    expect(pagesByNameMatch([second, third, first], PALMERS)).toEqual([second, third, first])
  })

  it('keeps only the best page of a host, taking the host from the first page of it in rank order', () => {
    const weak = 'https://www.medino.com/cocoa-butter-hand-cream'
    const other = 'https://www.cvs.com/shop/palmers-cocoa-butter-formula'

    const ranked = pagesByNameMatch([weak, other, MEDINO], PALMERS)

    expect(ranked).toEqual([MEDINO, other])
  })

  it('treats the same host as one even when the input lists its pages apart, keeping the input order among equal scores', () => {
    const a1 = 'https://a.example/cocoa-butter'
    const b1 = 'https://b.example/cocoa-butter'
    const a2 = 'https://a.example/cocoa-butter-again'

    expect(pagesByNameMatch([a1, b1, a2], PALMERS)).toEqual([a1, b1])
  })

  it('does not count words in the query string', () => {
    expect(pagesByNameMatch(['https://shop.example/product?name=cocoa-butter-formula'], PALMERS)).toEqual([])
  })

  it('does not count words in the host', () => {
    expect(pagesByNameMatch(['https://cocoa-butter-formula.example/'], PALMERS)).toEqual([])
  })

  it('does not count words in the fragment', () => {
    expect(pagesByNameMatch(['https://shop.example/p#cocoa-butter-formula'], PALMERS)).toEqual([])
  })

  it('reads a percent-encoded path as the text it stands for', () => {
    const encoded = 'https://shop.example/Cocoa%20Butter%20Formula%20Body%20Lotion'

    expect(pagesByNameMatch([encoded], PALMERS)).toEqual([encoded])
  })

  it('reads accents in the path the way the catalog compares names', () => {
    const accented = 'https://shop.example/p/cr%C3%A8me-de-cocoa'

    expect(pagesByNameMatch([accented], { brand: 'Brand', name: 'Creme de Cocoa' })).toEqual([accented])
  })

  it('does not count a one-character product word', () => {
    expect(pagesByNameMatch(['https://shop.example/c-shirt'], { brand: 'The Ordinary', name: 'Vitamin C Serum' })).toEqual([])
  })

  it('counts the words of the variant', () => {
    const page = 'https://shop.example/p/lotion-coconut'

    expect(pagesByNameMatch([page], { brand: 'Palmers', name: 'Body Lotion', variant: 'Coconut' })).toEqual([page])
  })

  it('does not throw on a bad percent escape, and still reads the rest of the path', () => {
    const broken = 'https://shop.example/cocoa-butter-%E0%A4%A'

    expect(() => pagesByNameMatch([broken], PALMERS)).not.toThrow()
    expect(pagesByNameMatch([broken], PALMERS)).toEqual([broken])
  })

  it('drops a value that is not a URL, without throwing, and keeps the rest', () => {
    expect(pagesByNameMatch(['not a url cocoa butter', '', MEDINO], PALMERS)).toEqual([MEDINO])
  })

  it('returns nothing for no pages', () => {
    expect(pagesByNameMatch([], PALMERS)).toEqual([])
  })
})

describe('a number written with % is never a pack size', () => {
  const keyName = (name: string, variant?: string) => identityKey({ brand: 'The Ordinary', name, variant }).split('|')[1]!.split(' ')

  it.each([
    ['100% L-Ascorbic Acid Powder', '100'],
    ['10% L-Lactic Acid Serum', '10'],
    ['20% G-Peptide Serum', '20'],
  ])('keeps the number and the l or g word of %j in the identity key', (name, number) => {
    const tokens = keyName(name)

    expect(tokens.some((t) => t.includes(number))).toBe(true)
    expect(tokens).toContain(name.includes('L-') ? 'l' : 'g')
  })

  it('keeps the words ascorbic acid powder in the key of 100% L-Ascorbic Acid Powder', () => {
    const key = identityKey({ brand: 'The Ordinary', name: '100% L-Ascorbic Acid Powder' })

    expect(key).toContain('ascorbic acid powder')
    expect(key).toContain('100')
  })

  it('gives "100% L-Ascorbic Acid Powder" a different key from "L-Ascorbic Acid Powder" and from "Ascorbic Acid Powder"', () => {
    const full = identityKey({ brand: 'The Ordinary', name: '100% L-Ascorbic Acid Powder' })

    expect(full).not.toBe(identityKey({ brand: 'The Ordinary', name: 'L-Ascorbic Acid Powder' }))
    expect(full).not.toBe(identityKey({ brand: 'The Ordinary', name: 'Ascorbic Acid Powder' }))
  })

  it('keeps the % number when it sits in the variant', () => {
    const tokens = identityKey({ brand: 'The Ordinary', name: 'L-Ascorbic Acid Powder', variant: '100%' }).split('|')[2]!

    expect(tokens).toContain('100')
  })

  it('does not strip the l of a % number in stripSizes called on the raw text (guards existing behaviour)', () => {
    expect(tidy(stripSizes('100% L-Ascorbic Acid Powder'))).toContain('L-Ascorbic')
  })

  it('still strips a real size beside a % number', () => {
    const tokens = keyName('10% L-Lactic Acid Serum 100 ml')

    expect(tokens).not.toContain('ml')
    expect(tokens).toContain('l')
  })

  // A pack may print "100 %" with a space; the sign still belongs to the number, so the number is still not an amount.
  it.each([
    ['100 % L-Ascorbic Acid Powder', '100% L-Ascorbic Acid Powder', 'b|100 l ascorbic acid powder||'],
    ['10 % L-Lactic Acid Serum', '10% L-Lactic Acid Serum', 'b|10 l lactic acid serum||'],
  ])('keys %j the same as %j', (spaced, tight, expected) => {
    expect(identityKey({ brand: 'B', name: spaced })).toBe(identityKey({ brand: 'B', name: tight }))
    expect(identityKey({ brand: 'B', name: spaced })).toBe(expected)
  })

  it('still strips a real size beside a % number written with a space', () => {
    const tokens = keyName('10 % L-Lactic Acid Serum 100 ml')

    expect(tokens).not.toContain('ml')
    expect(tokens).toContain('l')
    expect(tokens).toContain('10')
  })

  it.each([
    [{ brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: '236ml' }, 'cerave|hydrating facial cleanser||'],
    [{ brand: 'Dove', name: 'Bar', variant: '100 g' }, 'dove|bar||'],
    [{ brand: 'Dove', name: 'Lotion 50 ml' }, 'dove|lotion||'],
    [{ brand: 'Brand', name: 'Mist 3.4 fl oz' }, 'brand|mist||'],
    [{ brand: 'Water Co', name: 'Water 1 l' }, 'water co|water 1 l||'],
    [{ brand: 'Water Co', name: 'Water 10 l' }, 'water co|water||'],
    [{ brand: 'X', name: 'Vitamin C 2.5% Serum' }, 'x|vitamin c 2.5 serum||'],
    [{ brand: 'The Ordinary.', name: 'Niacinamide 10% + Zinc 1%' }, 'the ordinary|niacinamide 10 zinc 1||'],
  ])('leaves the key of %j unchanged', (product, expected) => {
    expect(identityKey(product)).toBe(expected)
  })
})

describe('UK and US spellings in near-miss scoring', () => {
  it('scores CeraVe Moisturising Lotion against CeraVe Moisturizing Lotion as 1', () => {
    expect(nameSimilarity({ brand: 'CeraVe', name: 'Moisturising Lotion' }, { brand: 'CeraVe', name: 'Moisturizing Lotion' })).toBe(1)
  })

  it.each([
    ['moisturising', 'moisturizing'],
    ['moisturiser', 'moisturizer'],
    ['sanitiser', 'sanitizer'],
    ['normalising', 'normalizing'],
    ['colour', 'color'],
    ['centre', 'center'],
    ['grey', 'gray'],
  ])('treats %s and %s as the same word', (uk, us) => {
    expect(nameSimilarity({ brand: 'Acme', name: `Soft ${uk} Cream` }, { brand: 'Acme', name: `Soft ${us} Cream` })).toBe(1)
  })

  it('folds the spelling in a variant too', () => {
    expect(nameSimilarity({ brand: 'Acme', name: 'Tint', variant: 'Grey' }, { brand: 'Acme', name: 'Tint', variant: 'Gray' })).toBe(1)
  })

  it('finds a US row as a near miss for a UK reading, and the other way round', () => {
    const us = { id: 'p1', brand: 'CeraVe', name: 'Moisturizing Lotion' }
    const uk = { id: 'p2', brand: 'CeraVe', name: 'Moisturising Lotion' }

    expect(nearMissCandidates(uk, [us])).toEqual([us])
    expect(nearMissCandidates(us, [uk])).toEqual([uk])
  })

  it('counts a UK reading as less specific than a longer US name that holds its words', () => {
    expect(lessSpecific({ brand: 'CeraVe', name: 'Moisturising Lotion' }, { brand: 'CeraVe', name: 'Daily Moisturizing Lotion' })).toBe(true)
  })

  it.each([['rise', 'rize'], ['wise', 'wize'], ['promise', 'promize'], ['anise', 'anize'], ['greyhound', 'grayhound'], ['centred', 'centered']])(
    'does not fold %s into %s: only the reviewed pairs fold, whole words only',
    (a, b) => {
      expect(nameSimilarity({ brand: 'Acme', name: `${a} Cream` }, { brand: 'Acme', name: `${b} Cream` })).toBeLessThan(1)
    },
  )

  it('does not fold in identityKey: UK and US names keep different keys', () => {
    expect(identityKey({ brand: 'CeraVe', name: 'Moisturising Lotion' })).toBe('cerave|moisturising lotion||')
    expect(identityKey({ brand: 'CeraVe', name: 'Moisturizing Lotion' })).toBe('cerave|moisturizing lotion||')
  })
})

describe('namesAnotherEdition with a % variant', () => {
  it('is false when the variant 100% is already in the product name', () => {
    expect(
      namesAnotherEdition({ brand: 'The Ordinary', name: 'L-Ascorbic Acid Powder', variant: '100%' }, { brand: 'The Ordinary', name: '100% L-Ascorbic Acid Powder' }),
    ).toBe(false)
  })

  it('is still true when the variant % number is not in the product', () => {
    expect(
      namesAnotherEdition({ brand: 'The Ordinary', name: 'L-Ascorbic Acid Powder', variant: '100%' }, { brand: 'The Ordinary', name: 'L-Ascorbic Acid Powder' }),
    ).toBe(true)
  })

  it('folds spellings: a UK variant word held by a US product is not another edition', () => {
    expect(namesAnotherEdition({ brand: 'Acme', name: 'Tint', variant: 'Grey' }, { brand: 'Acme', name: 'Gray Tint' })).toBe(false)
  })
})
