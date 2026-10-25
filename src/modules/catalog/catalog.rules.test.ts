import { describe, expect, it } from 'vitest'
import { normaliseIngredient } from './catalog.ingredients'
import { REFERENCE, REFERENCE_COVERAGE, REFERENCE_VERSION, type ReferenceEntry } from './catalog.reference'
import { flagFacts, rulesMatching } from './catalog.rules'
import { CONCERN_KINDS } from './catalog.vocabulary'

const kindsOf = (ingredient: string) =>
  flagFacts([ingredient], REFERENCE)
    .map((f) => f.kind)
    .sort()

describe('flagFacts', () => {
  // The rules are an argument now (the live approved set, or REFERENCE as the seed and the eval fixture), so a result may only
  // ever come from the array it was given: never from a copy of REFERENCE kept somewhere in the module.
  describe('the rules it is given', () => {
    const ZZYZX: ReferenceEntry = { name: 'zzyzx extractum', aliases: ['zzyzx oil'], kind: 'irritation', rule: 'Made up for this test.', source: null }

    it('flags nothing at all when given no rules, not even what REFERENCE holds', () => {
      expect(flagFacts(['Mercury', 'Retinol', 'Linalool'], [])).toEqual([])
    })

    it('flags an ingredient only a given rule names, and stops flagging it once that rule is not in the array', () => {
      expect(flagFacts(['Zzyzx Extractum'], REFERENCE)).toEqual([])

      expect(flagFacts(['Zzyzx Extractum'], [...REFERENCE, ZZYZX])).toEqual([
        { kind: 'irritation', ingredient: 'Zzyzx Extractum', rule: 'Made up for this test.', source: null },
      ])
      expect(flagFacts(['Zzyzx Extractum'], REFERENCE)).toEqual([])
    })

    it('matches a given rule by its aliases and by the parts either side of a bracket', () => {
      expect(flagFacts(['ZZYZX OIL', 'Aqua (Zzyzx Extractum)'], [ZZYZX]).map((f) => f.ingredient)).toEqual(['ZZYZX OIL', 'Aqua (Zzyzx Extractum)'])
    })

    it('says only what the given rules say, so a changed statement is the statement a fact carries', () => {
      const worded = { ...ZZYZX, rule: 'A different statement.', source: 'https://example.com/zzyzx' }

      expect(flagFacts(['Zzyzx Extractum'], [worded])).toEqual([
        { kind: 'irritation', ingredient: 'Zzyzx Extractum', rule: 'A different statement.', source: 'https://example.com/zzyzx' },
      ])
    })

    it('gives one fact per kind per ingredient, and one for each other kind the rules name for it', () => {
      const asAllergen: ReferenceEntry = { ...ZZYZX, kind: 'allergen', rule: 'Also made up.' }

      const facts = flagFacts(['Zzyzx Extractum'], [ZZYZX, ZZYZX, asAllergen])

      expect(facts.map((f) => f.kind).sort()).toEqual(['allergen', 'irritation'])
    })
  })

  it('flags nothing for plain ingredients', () => {
    expect(flagFacts(['Aqua', 'Glycerin', 'Water'], REFERENCE)).toEqual([])
    expect(flagFacts([], REFERENCE)).toEqual([])
  })

  it('flags nothing for water written with its INCI alias in brackets', () => {
    expect(flagFacts(['Aqua (Water)'], REFERENCE)).toEqual([])
  })

  it('flags nothing for an unknown ingredient', () => {
    expect(flagFacts(['Zzyzx Extractum'], REFERENCE)).toEqual([])
  })

  it('flags undisclosed fragrance once, as an allergen, under the ingredient exactly as written', () => {
    const facts = flagFacts(['Parfum (Fragrance)'], REFERENCE)

    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ kind: 'allergen', ingredient: 'Parfum (Fragrance)' })
  })

  it('flags retinol as a sun sensitiser and a pregnancy caution', () => {
    expect(kindsOf('Retinol')).toEqual(['pregnancy-caution', 'sun-sensitivity'])
  })

  it('flags hydroquinone as banned and a pregnancy caution, keeping the ingredient as given', () => {
    const facts = flagFacts(['HYDROQUINONE'], REFERENCE)

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
    const facts = flagFacts(['Water (Mercurous Chloride)'], REFERENCE)

    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ kind: 'banned-substance', ingredient: 'Water (Mercurous Chloride)' })
  })

  it('matches on the part outside brackets', () => {
    expect(kindsOf('Calomel (CI 77759)')).toEqual(['banned-substance'])
  })

  it('gives every fact a rule, and a source that is an https URL or null', () => {
    const facts = flagFacts(['Retinol', 'Hydroquinone', 'Linalool', 'Isopropyl Myristate'], REFERENCE)

    expect(facts.length).toBeGreaterThan(0)
    for (const f of facts) {
      expect(f.rule.trim()).not.toBe('')
      if (f.source !== null) expect(f.source).toMatch(/^https:\/\//)
    }
  })

  it('cites a regulation for regulatory facts and nothing for commonly cited concerns', () => {
    const sourceOf = (ingredient: string, kind: string) => flagFacts([ingredient], REFERENCE).find((f) => f.kind === kind)?.source

    expect(sourceOf('Hydroquinone', 'banned-substance')).toMatch(/^https:\/\//)
    expect(sourceOf('Linalool', 'allergen')).toMatch(/^https:\/\//)
    expect(sourceOf('Hydroquinone', 'pregnancy-caution')).toBeNull()
    expect(sourceOf('Retinol', 'sun-sensitivity')).toBeNull()
    expect(sourceOf('Retinol', 'pregnancy-caution')).toBeNull()
    expect(sourceOf('Isopropyl Myristate', 'pore-clogging')).toBeNull()
    expect(sourceOf('Sodium Lauryl Sulfate', 'irritation')).toBeNull()
  })

  it('points banned and allergen facts at an https source', () => {
    const facts = flagFacts(['Hydroquinone', 'Linalool'], REFERENCE).filter((f) => f.kind === 'banned-substance' || f.kind === 'allergen')

    expect(facts).toHaveLength(2)
    for (const f of facts) expect(f.source).toMatch(/^https:\/\//)
  })

  it('keeps input order across ingredients and gives one fact per kind per ingredient', () => {
    const facts = flagFacts(['Aqua', 'Retinol', 'Glycerin', 'Linalool', 'Parfum (Fragrance)'], REFERENCE)

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
      expect(flagFacts([ingredient], REFERENCE)).toEqual([])
    })

    it.each(['Hydroquinone 4%', '1,4-Dihydroxybenzene', 'Parfum/Fragrance', 'Cocos Nucifera (Coconut) Oil', 'Clobetasol 17-Propionate'])(
      'reports %s exactly as written',
      (ingredient) => {
        const facts = flagFacts([ingredient], REFERENCE)

        expect(facts.length).toBeGreaterThan(0)
        expect(facts.every((f) => f.ingredient === ingredient)).toBe(true)
      },
    )

    it('gives one allergen fact for a fragrance written as two names with a slash', () => {
      expect(flagFacts(['Parfum/Fragrance'], REFERENCE).filter((f) => f.kind === 'allergen')).toHaveLength(1)
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

// rulesMatching is what the shelf verdict reads rules through (the floor, the fit request and the routine's sources), so it is pinned directly: unlike flagFacts
// it keeps every rule that matches, even several of one kind, and a rule is returned as the very object it was given (the verdict reads their other columns).
describe('rulesMatching', () => {
  const rule = (over: Partial<ReferenceEntry> & Pick<ReferenceEntry, 'name'>): ReferenceEntry => ({ aliases: [], kind: 'irritation', rule: `${over.name} (made up)`, source: null, ...over })
  const FIRST = rule({ name: 'zzyzx extractum', aliases: ['zzyzx oil'] })
  const SECOND = rule({ name: 'zzyzx extractum', rule: 'A second reviewed rule for the same ingredient.' })
  const OTHER = rule({ name: 'qwerty butter', kind: 'drying' })

  it('returns both rules when two rules of the same kind match one ingredient, which flagFacts would fold into one', () => {
    const rules = [FIRST, OTHER, SECOND]

    expect(rulesMatching('Zzyzx Extractum', rules)).toEqual([FIRST, SECOND])
    expect(flagFacts(['Zzyzx Extractum'], rules)).toHaveLength(1)
  })

  it('matches by an alias', () => {
    expect(rulesMatching('ZZYZX OIL', [FIRST, OTHER])).toEqual([FIRST])
  })

  it('matches by either side of a slash (in the order the sides are written) and by the part inside or outside brackets', () => {
    const rules = [FIRST, OTHER]

    expect(rulesMatching('Qwerty Butter/Zzyzx Oil', rules)).toEqual([OTHER, FIRST])
    expect(rulesMatching('Aqua (Zzyzx Extractum)', rules)).toEqual([FIRST])
    expect(rulesMatching('Zzyzx Extractum (Qwerty Butter)', rules)).toEqual([FIRST, OTHER])
  })

  it('returns no rule for an ingredient no rule names, and none at all when there are no rules', () => {
    expect(rulesMatching('Aqua', [FIRST, OTHER])).toEqual([])
    expect(rulesMatching('Zzyzx Extractum', [])).toEqual([])
  })

  it('returns a rule once however many of its names the ingredient carries', () => {
    expect(rulesMatching('Zzyzx Extractum/Zzyzx Oil', [FIRST])).toEqual([FIRST])
  })

  it('returns the same order for the same input every time: the strictest kind first, rules of one kind in the order they were given', () => {
    const allergen = rule({ name: 'zzyzx extractum', kind: 'allergen' })
    const banned = rule({ name: 'zzyzx extractum', kind: 'banned-substance' })
    const rules = [SECOND, allergen, FIRST, banned]

    const expected = [banned, allergen, SECOND, FIRST]
    expect(rulesMatching('Zzyzx Extractum', rules)).toEqual(expected)
    expect(rulesMatching('Zzyzx Extractum', rules)).toEqual(expected)
    expect(rulesMatching('Zzyzx Extractum', [...rules])).toEqual(expected)
  })
})
