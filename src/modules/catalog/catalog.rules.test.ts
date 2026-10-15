import { describe, expect, it } from 'vitest'
import { normaliseIngredient } from './catalog.ingredients'
import { REFERENCE, REFERENCE_COVERAGE, REFERENCE_VERSION } from './catalog.reference'
import { flagFacts } from './catalog.rules'
import { CONCERN_KINDS } from './catalog.vocabulary'

const kindsOf = (ingredient: string) =>
  flagFacts([ingredient])
    .map((f) => f.kind)
    .sort()

describe('flagFacts', () => {
  it('flags nothing for plain ingredients', () => {
    expect(flagFacts(['Aqua', 'Glycerin', 'Water'])).toEqual([])
    expect(flagFacts([])).toEqual([])
  })

  it('flags nothing for water written with its INCI alias in brackets', () => {
    expect(flagFacts(['Aqua (Water)'])).toEqual([])
  })

  it('flags nothing for an unknown ingredient', () => {
    expect(flagFacts(['Zzyzx Extractum'])).toEqual([])
  })

  it('flags undisclosed fragrance once, as an allergen, under the ingredient exactly as written', () => {
    const facts = flagFacts(['Parfum (Fragrance)'])

    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ kind: 'allergen', ingredient: 'Parfum (Fragrance)' })
  })

  it('flags retinol as a sun sensitiser and a pregnancy caution', () => {
    expect(kindsOf('Retinol')).toEqual(['pregnancy-caution', 'sun-sensitivity'])
  })

  it('flags hydroquinone as banned and a pregnancy caution, keeping the ingredient as given', () => {
    const facts = flagFacts(['HYDROQUINONE'])

    expect(facts.map((f) => f.kind).sort()).toEqual(['banned-substance', 'pregnancy-caution'])
    expect(facts.every((f) => f.ingredient === 'HYDROQUINONE')).toBe(true)
  })

  it('flags mercurous chloride as banned', () => {
    expect(kindsOf('Mercurous Chloride')).toEqual(['banned-substance'])
  })

  it('ignores case, surrounding whitespace and trailing marks', () => {
    expect(kindsOf('  rEtInOl ')).toEqual(['pregnancy-caution', 'sun-sensitivity'])
    expect(kindsOf('Linalool*')).toEqual(['allergen'])
  })

  it('matches on the part inside brackets', () => {
    const facts = flagFacts(['Water (Mercurous Chloride)'])

    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ kind: 'banned-substance', ingredient: 'Water (Mercurous Chloride)' })
  })

  it('matches on the part outside brackets', () => {
    expect(kindsOf('Calomel (CI 77759)')).toEqual(['banned-substance'])
  })

  it('gives every fact a rule, and a source that is an https URL or null', () => {
    const facts = flagFacts(['Retinol', 'Hydroquinone', 'Linalool', 'Isopropyl Myristate'])

    expect(facts.length).toBeGreaterThan(0)
    for (const f of facts) {
      expect(f.rule.trim()).not.toBe('')
      if (f.source !== null) expect(f.source).toMatch(/^https:\/\//)
    }
  })

  it('cites a regulation for regulatory facts and nothing for commonly cited concerns', () => {
    const sourceOf = (ingredient: string, kind: string) => flagFacts([ingredient]).find((f) => f.kind === kind)?.source

    expect(sourceOf('Hydroquinone', 'banned-substance')).toMatch(/^https:\/\//)
    expect(sourceOf('Linalool', 'allergen')).toMatch(/^https:\/\//)
    expect(sourceOf('Hydroquinone', 'pregnancy-caution')).toBeNull()
    expect(sourceOf('Retinol', 'sun-sensitivity')).toBeNull()
    expect(sourceOf('Retinol', 'pregnancy-caution')).toBeNull()
    expect(sourceOf('Isopropyl Myristate', 'pore-clogging')).toBeNull()
    expect(sourceOf('Sodium Lauryl Sulfate', 'irritation')).toBeNull()
  })

  it('points banned and allergen facts at an https source', () => {
    const facts = flagFacts(['Hydroquinone', 'Linalool']).filter((f) => f.kind === 'banned-substance' || f.kind === 'allergen')

    expect(facts).toHaveLength(2)
    for (const f of facts) expect(f.source).toMatch(/^https:\/\//)
  })

  it('keeps input order across ingredients and gives one fact per kind per ingredient', () => {
    const facts = flagFacts(['Aqua', 'Retinol', 'Glycerin', 'Linalool', 'Parfum (Fragrance)'])

    expect(facts.map((f) => f.ingredient)).toEqual([
      'Retinol',
      'Retinol',
      'Linalool',
      'Parfum (Fragrance)',
    ])
    const pairs = facts.map((f) => `${f.ingredient}|${f.kind}`)
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  describe('real label spellings', () => {
    it.each([
      'Hydroquinone 4%',
      'Hydroquinone USP',
      '1,4-Dihydroxybenzene',
      'Quinol',
      'Lilial',
      'Lyral',
      'HICC',
      'Mercuric Chloride',
      'Mercury Iodide',
      'Mercuric Oxide',
      'Clobetasol',
      'Clobetasol 17-Propionate',
    ])('flags %s as banned', (ingredient) => {
      expect(kindsOf(ingredient)).toContain('banned-substance')
    })

    it.each(['Hydroquinone 4%', 'Hydroquinone USP', '1,4-Dihydroxybenzene', 'Quinol'])('flags %s, a name for hydroquinone, as a pregnancy caution too', (ingredient) => {
      expect(kindsOf(ingredient)).toEqual(['banned-substance', 'pregnancy-caution'])
    })

    it.each(['Parfum/Fragrance', 'Fragrance/Parfum', 'Evernia Prunastri (Oakmoss) Extract', 'd-Limonene'])('flags %s as an allergen', (ingredient) => {
      expect(kindsOf(ingredient)).toContain('allergen')
    })

    it.each(['Cocos Nucifera (Coconut) Oil', 'Theobroma Cacao (Cocoa) Seed Butter'])('flags %s as pore-clogging', (ingredient) => {
      expect(kindsOf(ingredient)).toContain('pore-clogging')
    })

    it.each(['Retinyl Palmitate', 'Sodium Laureth Sulfate', 'Mercury Retrograde Extract'])('does not flag %s, which only resembles a listed name', (ingredient) => {
      expect(flagFacts([ingredient])).toEqual([])
    })

    it.each(['Hydroquinone 4%', '1,4-Dihydroxybenzene', 'Parfum/Fragrance', 'Cocos Nucifera (Coconut) Oil', 'Clobetasol 17-Propionate'])(
      'reports %s exactly as written',
      (ingredient) => {
        const facts = flagFacts([ingredient])

        expect(facts.length).toBeGreaterThan(0)
        expect(facts.every((f) => f.ingredient === ingredient)).toBe(true)
      },
    )

    it('gives one allergen fact for a fragrance written as two names with a slash', () => {
      expect(flagFacts(['Parfum/Fragrance']).filter((f) => f.kind === 'allergen')).toHaveLength(1)
    })
  })

  describe('the seed reference', () => {
    it('says it is partial coverage, not the full CosIng set', () => {
      expect(REFERENCE_COVERAGE).toBe('partial')
    })

    it('gives every banned substance and every named fragrance allergen an https source', () => {
      const regulatory = REFERENCE.filter((e) => e.kind === 'banned-substance' || (e.kind === 'allergen' && ![e.name, ...e.aliases].some((l) => /^(parfum|fragrance)$/.test(l))))

      expect(regulatory.length).toBeGreaterThan(0)
      for (const entry of regulatory) expect(entry.source, entry.name).toMatch(/^https:\/\//)
    })

    it('gives commonly cited concerns no source', () => {
      const cited = REFERENCE.filter((e) => ['pore-clogging', 'sun-sensitivity', 'irritation', 'pregnancy-caution'].includes(e.kind))

      expect(cited.length).toBeGreaterThan(0)
      for (const entry of cited) expect(entry.source, entry.name).toBeNull()
    })

    it.each([
      'Mercury',
      'Mercurous Chloride',
      'Calomel',
      'Ammoniated Mercury',
      'Hydroquinone',
      'Clobetasol Propionate',
      'Tretinoin',
      'Butylphenyl Methylpropional',
      'Hydroxyisohexyl 3-Cyclohexene Carboxaldehyde',
    ])('bans %s', (ingredient) => {
      expect(kindsOf(ingredient)).toContain('banned-substance')
    })

    it.each([
      'Linalool',
      'Limonene',
      'Citronellol',
      'Geraniol',
      'Coumarin',
      'Eugenol',
      'Benzyl Alcohol',
      'Cinnamal',
      'Citral',
      'Parfum',
      'Fragrance',
    ])('flags %s as an allergen', (ingredient) => {
      expect(kindsOf(ingredient)).toContain('allergen')
    })

    it.each(['Glycolic Acid', 'Lactic Acid', 'Retinol', 'Citrus Aurantium Bergamia Peel Oil'])('flags %s as sun-sensitising', (ingredient) => {
      expect(kindsOf(ingredient)).toContain('sun-sensitivity')
    })

    it.each(['Isopropyl Myristate', 'Cocos Nucifera Oil', 'Theobroma Cacao Seed Butter'])('flags %s as pore-clogging', (ingredient) => {
      expect(kindsOf(ingredient)).toContain('pore-clogging')
    })

    // The label spelling "Alcohol Denat." normalises to "alcohol denat" (trailing dot stripped), so both must match.
    it.each(['Sodium Lauryl Sulfate', 'Alcohol Denat.', 'Alcohol Denat'])('flags %s as an irritant', (ingredient) => {
      expect(kindsOf(ingredient)).toContain('irritation')
    })

    it.each(['Retinol', 'Hydroquinone'])('flags %s as a pregnancy caution', (ingredient) => {
      expect(kindsOf(ingredient)).toContain('pregnancy-caution')
    })

    it('has a version that marks it as the seed set', () => {
      expect(REFERENCE_VERSION).toMatch(/^seed-/)
    })

    it('uses only known concern kinds', () => {
      for (const entry of REFERENCE) expect(CONCERN_KINDS).toContain(entry.kind)
    })

    it('stores names and aliases already normalised', () => {
      for (const entry of REFERENCE) {
        for (const label of [entry.name, ...entry.aliases]) expect(normaliseIngredient(label)).toBe(label)
      }
    })

    it('gives every entry a name and a rule, and a source that is an https URL or null', () => {
      expect(REFERENCE.length).toBeGreaterThan(0)
      for (const entry of REFERENCE) {
        expect(entry.name).not.toBe('')
        expect(entry.rule.trim()).not.toBe('')
        if (entry.source !== null) expect(entry.source).toMatch(/^https:\/\//)
      }
    })
  })
})
