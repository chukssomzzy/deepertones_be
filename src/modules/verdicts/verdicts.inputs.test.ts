import { describe, expect, it } from 'vitest'
import type { RoutineStep } from '../catalog/catalog.vocabulary'
import type { VerdictReference } from '../catalog/catalog.workbook.service'
import type { ShelfFacts } from '../catalog/catalog.service'
import type { SafetyMentionRow } from '../safety/safety.types'
import type { NoLabelPurpose } from '../scans/scans.vocabulary'
import type { ShelfActiveEntry } from '../shelf/shelf.service'
import type { ShownConcern } from '../face-scans/face-scans.tables'
import { verdictFingerprint } from './verdicts.fingerprint'
import { floorVerdicts, type FloorResult } from './verdicts.floor'
import { assembleVerdictInputs, fingerprintInputOf, fitRequestOf, provenanceOf } from './verdicts.inputs'

// The pure assembly of a shelf verdict's inputs (spec #171, D2a): the facts the accessors already loaded (reference, goal, shelf entries, formulation facts,
// no-label facts, routine steps, safety snapshot, face scan, fitter identity) become the exact inputs of the floor, the merge, the fit judge, the fingerprint and
// the saved provenance. No I/O, no clock. Expected values are worked out by hand from the spec and the vocabularies, never from the code under test.
//
// Shapes assumed (the contract this file pins):
//   Facts  { reference, goal, entries, shelfFacts, noLabelFacts, steps, safety, mentionIngredients, scan, fitter }, where
//          shelfFacts is keyed by FORMULATION id, noLabelFacts by no-label ITEM id, steps by catalog PRODUCT id (as their accessors give them), and
//          mentionIngredients (productId -> ingredient list of a product the user named, which the floor matches by ingredients) is the one input the
//          accessors do not already supply.
//   assembleVerdictInputs(facts)       { floorInput, entries: {id, category}[] (for mergeVerdict), unresolved: string[] (entry ids), perEntry: Map<entryId, { step, sourceUrls }> }
//   fitRequestOf(facts, floor)         FitRequest, or null when there is nothing to ask: no open product and no clash, or the profile has no goal
//   fingerprintInputOf(facts, floor)   FingerprintInput
//   provenanceOf(facts, floor)         the saved row's `inputs`: ids, codes and bands only, never words the user typed

type Facts = Parameters<typeof assembleVerdictInputs>[0]

const AT = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

// ---- the reviewed reference: rules as the Ingredients tab holds them (normalised names), claim words, and the approved step-down codes ----

const ruleOf = (over: Partial<VerdictReference['rules'][number]> & Pick<VerdictReference['rules'][number], 'name' | 'kind'>): VerdictReference['rules'][number] => ({
  aliases: [],
  rule: `${over.name} (test rule)`,
  source: null,
  group: null,
  clashesWith: [],
  helps: [],
  ...over,
})

const RULES = [
  ruleOf({ name: 'niacinamide', kind: 'irritation', source: 'https://example.org/rules/niacinamide', helps: ['hd_radiance', 'hd_age_spot'] }),
  ruleOf({ name: 'vitamin b3', kind: 'irritation', source: 'https://example.org/rules/b3', helps: ['hd_texture'] }),
  ruleOf({ name: 'zinc pca', kind: 'drying', source: null, helps: ['hd_pore', 'hd_oiliness'] }),
  ruleOf({ name: 'parfum', aliases: ['fragrance'], kind: 'allergen', source: 'https://example.org/rules/parfum' }),
  ruleOf({ name: 'clobetasol propionate', aliases: ['clobetasol'], kind: 'banned-substance', group: 'steroid', source: 'https://example.org/rules/clobetasol' }),
  ruleOf({ name: 'hydroquinone', kind: 'restricted-substance', group: 'lightening-agent', source: 'https://example.org/rules/hydroquinone' }),
  ruleOf({ name: 'retinol', kind: 'pregnancy-caution', group: 'retinoid', clashesWith: ['exfoliating-acid'], helps: ['hd_texture', 'hd_age_spot'], source: 'https://example.org/rules/retinol' }),
  ruleOf({ name: 'glycolic acid', kind: 'irritation', group: 'exfoliating-acid', clashesWith: ['retinoid'], helps: ['hd_texture'], source: 'https://example.org/rules/aha' }),
]

const REFERENCE: VerdictReference = {
  rulesVersion: 'rules-0123456789abcdef',
  catalogVersion: 12,
  rules: RULES,
  claimPhrases: ['whitening', 'toning'],
  tapers: { steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' },
}

// ---- the shelf, as the accessors give it ----

type ProductSpec = { id: string; ingredients: string[]; facts?: Partial<ShelfFacts>; steps?: RoutineStep[] }
type NoLabelSpec = { id: string; purpose: NoLabelPurpose; category?: 'skin' | 'hair' | 'body' | 'makeup' | 'other' }

const shelfOf = (products: ProductSpec[], noLabels: NoLabelSpec[] = []): Pick<Facts, 'entries' | 'shelfFacts' | 'noLabelFacts' | 'steps'> => ({
  entries: [
    ...products.map((p, i): ShelfActiveEntry => ({ id: p.id, kind: 'product', addedAt: new Date(AT.getTime() + i * MINUTE), productId: `prod-${p.id}`, formulationId: `form-${p.id}` })),
    ...noLabels.map((n, i): ShelfActiveEntry => ({ id: n.id, kind: 'no-label', addedAt: new Date(AT.getTime() + (products.length + i) * MINUTE), itemId: `item-${n.id}` })),
  ],
  shelfFacts: new Map(
    products.map((p): [string, ShelfFacts] => [
      `form-${p.id}`,
      { productId: `prod-${p.id}`, brand: 'Orbis', name: `Product ${p.id}`, variant: null, form: 'serum', category: 'skin', ingredients: p.ingredients, ...p.facts },
    ]),
  ),
  noLabelFacts: new Map(noLabels.map((n): [string, { purpose: NoLabelPurpose; category: NonNullable<NoLabelSpec['category']> }] => [`item-${n.id}`, { purpose: n.purpose, category: n.category ?? 'skin' }])),
  steps: new Map(products.flatMap((p): [string, RoutineStep[]][] => (p.steps ? [[`prod-${p.id}`, p.steps]] : []))),
})

const mentionOf = (over: Partial<SafetyMentionRow> = {}): SafetyMentionRow => ({
  id: 'mention-1',
  safetyId: 'safety-1',
  source: 'reaction',
  kind: 'product',
  brand: 'Moonlight',
  name: 'Moonlight Glow',
  variant: null,
  category: 'skin',
  productId: 'prod-named',
  resolution: 'resolved',
  position: 0,
  createdAt: AT,
  ...over,
})

const factsOf = (shelf: ReturnType<typeof shelfOf>, over: Partial<Facts> = {}): Facts => ({
  reference: REFERENCE,
  goal: 'fade-dark-marks',
  ...shelf,
  safety: { view: null, parseState: null, mentions: [] },
  mentionIngredients: new Map(),
  scan: null,
  fitter: { model: 'claude-sonnet-5-5', promptHash: 'prompt-hash-1' },
  ...over,
})

const floorOf = (facts: Facts): FloorResult => floorVerdicts(assembleVerdictInputs(facts).floorInput)

// Three ordinary entries: a serum and a cream the rules say nothing against, and a tub with no label.
const SERUM = { id: 'e-serum', ingredients: ['Aqua', 'Niacinamide', 'Zinc PCA'], facts: { name: 'Dew Serum', form: 'serum' as const }, steps: ['moisturise', 'treat'] as RoutineStep[] }
const CREAM = { id: 'e-cream', ingredients: ['Aqua', 'Glycerin', 'Shea Butter'], facts: { name: 'Barrier Cream', variant: 'Rich', form: 'cream' as const } }
const BASIC = shelfOf([SERUM, CREAM], [{ id: 'e-tub', purpose: 'moisturise' }])

describe('assembleVerdictInputs: the floor input', () => {
  it('carries each product with its identity, category, catalog product id and the ingredient list of its own formulation, in the shelf order', () => {
    const { floorInput } = assembleVerdictInputs(factsOf(BASIC))

    expect(floorInput.shelf.slice(0, 2)).toEqual([
      { id: 'e-serum', kind: 'product', brand: 'Orbis', name: 'Dew Serum', variant: null, category: 'skin', productId: 'prod-e-serum', ingredients: ['Aqua', 'Niacinamide', 'Zinc PCA'] },
      { id: 'e-cream', kind: 'product', brand: 'Orbis', name: 'Barrier Cream', variant: 'Rich', category: 'skin', productId: 'prod-e-cream', ingredients: ['Aqua', 'Glycerin', 'Shea Butter'] },
    ])
  })

  it('carries a no-label entry with the purpose and category the user gave, and no brand or variant (it has none; its name is not pinned)', () => {
    const { floorInput } = assembleVerdictInputs(factsOf(BASIC))

    expect(floorInput.shelf[2]).toMatchObject({ id: 'e-tub', kind: 'no-label', brand: null, variant: null, category: 'skin', noLabelPurpose: 'moisturise' })
    expect(typeof (floorInput.shelf[2] as { name: unknown }).name).toBe('string')
  })

  it('takes the rules, claim phrases and approved step-down codes from the reference as they are', () => {
    const { floorInput } = assembleVerdictInputs(factsOf(BASIC))

    expect(floorInput.rules).toEqual(RULES)
    expect(floorInput.claimPhrases).toEqual(['whitening', 'toning'])
    expect(floorInput.tapers).toEqual({ steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' })
  })

  it('passes a non-skin entry through with its category, for the floor and the merge to leave out themselves', () => {
    const shelf = shelfOf([SERUM, { id: 'e-shampoo', ingredients: ['Aqua', 'Sodium Laureth Sulfate'], facts: { category: 'hair' } }], [{ id: 'e-lip', purpose: 'not-sure', category: 'makeup' }])

    const { floorInput, entries } = assembleVerdictInputs(factsOf(shelf))

    expect(floorInput.shelf.map((entry) => [entry.id, entry.category])).toEqual([
      ['e-serum', 'skin'],
      ['e-shampoo', 'hair'],
      ['e-lip', 'makeup'],
    ])
    expect(entries).toEqual([
      { id: 'e-serum', category: 'skin' },
      { id: 'e-shampoo', category: 'hair' },
      { id: 'e-lip', category: 'makeup' },
    ])
  })

  it('gives the merge the same entries, in the same order, as the floor input', () => {
    const { floorInput, entries } = assembleVerdictInputs(factsOf(BASIC))

    expect(entries).toEqual(floorInput.shelf.map(({ id, category }) => ({ id, category })))
  })

  it('leaves out an entry whose formulation is not in the shelf facts, or whose no-label item is not in the no-label facts, and reports its id', () => {
    const shelf = shelfOf([SERUM], [{ id: 'e-tub', purpose: 'lighten' }])
    const facts = factsOf({
      ...shelf,
      entries: [
        { id: 'e-gone', kind: 'product', addedAt: AT, productId: 'prod-gone', formulationId: 'form-gone' },
        ...shelf.entries,
        { id: 'e-lost-tub', kind: 'no-label', addedAt: AT, itemId: 'item-lost' },
      ],
    })

    const { floorInput, entries, unresolved, perEntry } = assembleVerdictInputs(facts)

    expect(unresolved).toEqual(['e-gone', 'e-lost-tub'])
    expect(floorInput.shelf.map((entry) => entry.id)).toEqual(['e-serum', 'e-tub'])
    expect(entries.map((entry) => entry.id)).toEqual(['e-serum', 'e-tub'])
    expect([...perEntry.keys()].sort()).toEqual(['e-serum', 'e-tub'])
  })

  it('reports nothing unresolved when every entry resolves', () => {
    expect(assembleVerdictInputs(factsOf(BASIC)).unresolved).toEqual([])
  })

  it('reads whether the user is pregnant or breastfeeding from the safety view, and false when there is none', () => {
    const view = { choices: ['pregnant' as const], reactionText: null, prescriptionText: null, excludesPregnancyCaution: true, updatedAt: AT }

    expect(assembleVerdictInputs(factsOf(BASIC, { safety: { view, parseState: 'none', mentions: [] } })).floorInput.safety.excludesPregnancyCaution).toBe(true)
    expect(assembleVerdictInputs(factsOf(BASIC, { safety: { view: { ...view, excludesPregnancyCaution: false }, parseState: 'none', mentions: [] } })).floorInput.safety.excludesPregnancyCaution).toBe(false)
    expect(assembleVerdictInputs(factsOf(BASIC)).floorInput.safety.excludesPregnancyCaution).toBe(false)
  })

  it('gives the floor each parsed mention with its source, kind, words and catalog product id, and the ingredient list of the product it resolved to (null when there is none)', () => {
    const safety = {
      view: null,
      parseState: 'done' as const,
      mentions: [
        mentionOf(),
        mentionOf({ id: 'mention-2', source: 'prescription', name: 'Dermovate', productId: 'prod-derm', position: 1 }),
        mentionOf({ id: 'mention-3', kind: 'ingredient', name: 'fragrance', brand: null, category: null, productId: null, resolution: null, position: 2 }),
        mentionOf({ id: 'mention-4', name: 'Unknown tub', productId: null, resolution: 'unresolved', position: 3 }),
      ],
    }
    const mentionIngredients = new Map([['prod-named', ['Aqua', 'Hydroquinone']]])

    const { floorInput } = assembleVerdictInputs(factsOf(BASIC, { safety, mentionIngredients }))

    expect(floorInput.safety.mentions).toEqual([
      { source: 'reaction', kind: 'product', name: 'Moonlight Glow', productId: 'prod-named', ingredients: ['Aqua', 'Hydroquinone'] },
      { source: 'prescription', kind: 'product', name: 'Dermovate', productId: 'prod-derm', ingredients: null },
      { source: 'reaction', kind: 'ingredient', name: 'fragrance', productId: null, ingredients: null },
      { source: 'reaction', kind: 'product', name: 'Unknown tub', productId: null, ingredients: null },
    ])
  })

  it('is what the floor needs: a steroid on the shelf stops with the approved step-down code, and a serum nothing flags is left open', () => {
    const shelf = shelfOf([SERUM, { id: 'e-potent', ingredients: ['Petrolatum', 'Clobetasol Propionate'] }])

    const { entries } = floorVerdicts(assembleVerdictInputs(factsOf(shelf)).floorInput)

    expect(entries).toMatchObject([{ id: 'e-serum', status: 'open' }, { id: 'e-potent', status: 'fixed', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' } }])
  })
})

describe('assembleVerdictInputs: what is known about each entry', () => {
  it('gives the first of the product\'s steps in routine order (not the first listed), found by the catalog product id, and null when the catalog has none', () => {
    const { perEntry } = assembleVerdictInputs(factsOf(BASIC))

    expect(perEntry.get('e-serum')?.step).toBe('treat')
    expect(perEntry.get('e-cream')?.step).toBeNull()
    expect(perEntry.get('e-tub')?.step).toBeNull()
  })

  it('gives the step of the routine order for each pair of steps, whatever order the catalog lists them in', () => {
    const shelf = shelfOf([
      { id: 'a', ingredients: ['Aqua'], steps: ['protect', 'cleanse'] },
      { id: 'b', ingredients: ['Aqua'], steps: ['protect', 'moisturise'] },
      { id: 'c', ingredients: ['Aqua'], steps: ['moisturise', 'treat'] },
    ])

    const { perEntry } = assembleVerdictInputs(factsOf(shelf))

    expect([...perEntry].map(([id, known]) => [id, known.step])).toEqual([
      ['a', 'cleanse'],
      ['b', 'moisturise'],
      ['c', 'treat'],
    ])
  })

  it('gives the sources of the rules that match the product\'s ingredients, once each and sorted, and leaves out a rule that cites none', () => {
    // niacinamide has a source, zinc pca has none, and "Aqua" matches no rule.
    const { perEntry } = assembleVerdictInputs(factsOf(BASIC))

    expect(perEntry.get('e-serum')?.sourceUrls).toEqual(['https://example.org/rules/niacinamide'])
  })

  it('counts every rule that matches an ingredient, not only the first of a kind: "Niacinamide (Vitamin B3)" is matched by two rules of the same kind', () => {
    const shelf = shelfOf([{ id: 'e-b3', ingredients: ['Aqua', 'Niacinamide (Vitamin B3)', 'Parfum'] }])

    const { perEntry } = assembleVerdictInputs(factsOf(shelf))

    expect(perEntry.get('e-b3')?.sourceUrls).toEqual(['https://example.org/rules/b3', 'https://example.org/rules/niacinamide', 'https://example.org/rules/parfum'])
  })

  it('matches a rule by its alias and de-duplicates a source shared by two ingredients', () => {
    const shelf = shelfOf([{ id: 'e-two', ingredients: ['Fragrance', 'Parfum'] }])

    const { perEntry } = assembleVerdictInputs(factsOf(shelf))

    expect(perEntry.get('e-two')?.sourceUrls).toEqual(['https://example.org/rules/parfum'])
  })

  it('gives a no-label entry no sources', () => {
    const { perEntry } = assembleVerdictInputs(factsOf(BASIC))

    expect(perEntry.get('e-tub')?.sourceUrls).toEqual([])
  })
})

describe('fitRequestOf', () => {
  it('carries the goal with its three skin concerns in the goal\'s own order', () => {
    const facts = factsOf(BASIC)

    expect(fitRequestOf(facts, floorOf(facts))?.goal).toEqual({ id: 'fade-dark-marks', skinConcerns: ['hd_age_spot', 'hd_acne', 'hd_texture'] })
  })

  it('has no skin type and no scan when there is no face scan', () => {
    const facts = factsOf(BASIC)

    expect(fitRequestOf(facts, floorOf(facts))).toMatchObject({ skinType: null, scan: null })
  })

  it('carries the skin type and the scan\'s concerns as seen concerns with a level, in the scan\'s order', () => {
    const scan = { skinType: 'combination' as const, concerns: [{ concern: 'hd_age_spot' as ShownConcern, band: 'some' as const }, { concern: 'hd_acne' as ShownConcern, band: 'faint' as const }] }
    const facts = factsOf(BASIC, { scan })

    expect(fitRequestOf(facts, floorOf(facts))).toMatchObject({
      skinType: 'combination',
      scan: [{ concern: 'hd_age_spot', level: 'some' }, { concern: 'hd_acne', level: 'faint' }],
    })
  })

  it('keeps a scan with no skin type: the skin type is null and the concerns are still there', () => {
    const facts = factsOf(BASIC, { scan: { skinType: null, concerns: [{ concern: 'hd_acne', band: 'clear' }] } })

    expect(fitRequestOf(facts, floorOf(facts))).toMatchObject({ skinType: null, scan: [{ concern: 'hd_acne', level: 'clear' }] })
  })

  it('describes an open product by its identity, routine step, form, ingredients, the kinds of caution its ingredients flag and the concerns its rules help', () => {
    const facts = factsOf(BASIC)

    const serum = fitRequestOf(facts, floorOf(facts))?.shelf.find((product) => product.id === 'e-serum')

    // niacinamide is an irritation rule and zinc pca a drying one; the rules they match help radiance, spots, pores and oiliness. Both lists are sorted.
    expect(serum).toEqual({
      id: 'e-serum',
      brand: 'Orbis',
      name: 'Dew Serum',
      variant: null,
      step: 'treat',
      form: 'serum',
      ingredients: ['Aqua', 'Niacinamide', 'Zinc PCA'],
      cautions: ['drying', 'irritation'],
      skinConcerns: ['hd_age_spot', 'hd_oiliness', 'hd_pore', 'hd_radiance'],
      floor: { status: 'open' },
    })
  })

  it('has no caution and no skin concern for a product no rule matches, and a null step and form when they are not known', () => {
    const shelf = shelfOf([{ id: 'e-plain', ingredients: ['Aqua', 'Glycerin'], facts: { form: null } }])
    const facts = factsOf(shelf)

    expect(fitRequestOf(facts, floorOf(facts))?.shelf).toEqual([
      { id: 'e-plain', brand: 'Orbis', name: 'Product e-plain', variant: null, step: null, form: null, ingredients: ['Aqua', 'Glycerin'], cautions: [], skinConcerns: [], floor: { status: 'open' } },
    ])
  })

  it('unions the concerns of every rule an ingredient matches, and lists a caution kind once', () => {
    const shelf = shelfOf([{ id: 'e-b3', ingredients: ['Niacinamide (Vitamin B3)'] }])
    const facts = factsOf(shelf)

    const [product] = fitRequestOf(facts, floorOf(facts))!.shelf

    expect(product!.cautions).toEqual(['irritation'])
    expect(product!.skinConcerns).toEqual(['hd_age_spot', 'hd_radiance', 'hd_texture'])
  })

  it('lists the products the floor decided too, marked fixed with their group, so the judge can read them as context', () => {
    const shelf = shelfOf([SERUM, { id: 'e-potent', ingredients: ['Petrolatum', 'Clobetasol Propionate'] }], [{ id: 'e-tub', purpose: 'moisturise' }])
    const facts = factsOf(shelf)

    const request = fitRequestOf(facts, floorOf(facts))!

    expect(request.shelf.map((product) => [product.id, product.floor])).toEqual([
      ['e-serum', { status: 'open' }],
      ['e-potent', { status: 'fixed', group: 'likely-the-problem' }],
      ['e-tub', { status: 'fixed', group: 'cant-tell' }],
    ])
  })

  it('marks a product that needs a step-down with no approved template as fixed in likely-the-problem, as the provider says', () => {
    const shelf = shelfOf([SERUM, { id: 'e-potent', ingredients: ['Petrolatum', 'Clobetasol Propionate'] }])
    const facts = factsOf(shelf, { reference: { ...REFERENCE, tapers: {} } })

    const request = fitRequestOf(facts, floorOf(facts))!

    expect(request.shelf.find((product) => product.id === 'e-potent')?.floor).toEqual({ status: 'fixed', group: 'likely-the-problem' })
  })

  it('describes a prescribed product as fixed prescribed, which the judge may name as the product a redundant one repeats', () => {
    const shelf = shelfOf([SERUM, { id: 'e-rx', ingredients: ['Aqua', 'Niacinamide'] }])
    const safety = { view: null, parseState: 'done' as const, mentions: [mentionOf({ source: 'prescription', productId: 'prod-e-rx' })] }
    const facts = factsOf(shelf, { safety })

    const request = fitRequestOf(facts, floorOf(facts))!

    expect(request.shelf.map((product) => [product.id, product.floor])).toEqual([
      ['e-serum', { status: 'open' }],
      ['e-rx', { status: 'fixed', group: 'prescribed' }],
    ])
  })

  it('leaves out non-skin entries and entries that did not resolve', () => {
    const shelf = shelfOf([SERUM, { id: 'e-shampoo', ingredients: ['Aqua'], facts: { category: 'hair' } }])
    const facts = factsOf({ ...shelf, entries: [...shelf.entries, { id: 'e-gone', kind: 'product', addedAt: AT, productId: 'prod-gone', formulationId: 'form-gone' }] })

    expect(fitRequestOf(facts, floorOf(facts))?.shelf.map((product) => product.id)).toEqual(['e-serum'])
  })

  it('carries the clashing pairs as the floor found them, the ids and groups only', () => {
    const shelf = shelfOf([
      { id: 'e-retinol', ingredients: ['Aqua', 'Retinol'] },
      { id: 'e-peel', ingredients: ['Aqua', 'Glycolic Acid'] },
    ])
    const facts = factsOf(shelf)

    expect(fitRequestOf(facts, floorOf(facts))?.clashes).toEqual([{ ids: ['e-retinol', 'e-peel'], groups: ['retinoid', 'exfoliating-acid'] }])
  })

  it('has no clashes when no two products clash', () => {
    const facts = factsOf(BASIC)

    expect(fitRequestOf(facts, floorOf(facts))?.clashes).toEqual([])
  })

  it('asks nothing when the floor left no product open and found no clash', () => {
    const shelf = shelfOf([{ id: 'e-potent', ingredients: ['Petrolatum', 'Clobetasol Propionate'] }], [{ id: 'e-tub', purpose: 'moisturise' }])
    const facts = factsOf(shelf)

    expect(fitRequestOf(facts, floorOf(facts))).toBeNull()
  })

  it('asks nothing when the profile has no goal, since the judge cannot judge fit to nothing', () => {
    const facts = factsOf(BASIC, { goal: null })

    expect(fitRequestOf(facts, floorOf(facts))).toBeNull()
  })
})

describe('fingerprintInputOf', () => {
  it('names the rules, claim phrases, rules version, goal, model and prompt the verdict is built against', () => {
    const facts = factsOf(BASIC)

    expect(fingerprintInputOf(facts, floorOf(facts))).toMatchObject({
      rulesVersion: 'rules-0123456789abcdef',
      rules: RULES,
      claimPhrases: ['whitening', 'toning'],
      goal: 'fade-dark-marks',
      model: 'claude-sonnet-5-5',
      promptHash: 'prompt-hash-1',
    })
  })

  it('lists the resolved entries by what the verdict reads of them: a product by its formulation id, a no-label entry by its purpose', () => {
    const facts = factsOf(BASIC)

    expect(fingerprintInputOf(facts, floorOf(facts)).shelf).toEqual([
      { id: 'e-serum', kind: 'product', category: 'skin', brand: 'Orbis', name: 'Dew Serum', variant: null, formulationId: 'form-e-serum' },
      { id: 'e-cream', kind: 'product', category: 'skin', brand: 'Orbis', name: 'Barrier Cream', variant: 'Rich', formulationId: 'form-e-cream' },
      expect.objectContaining({ id: 'e-tub', kind: 'no-label', category: 'skin', brand: null, variant: null, noLabelPurpose: 'moisturise' }),
    ])
  })

  it('carries a non-skin entry with its category, for the fingerprint to drop, and leaves out an entry that did not resolve', () => {
    const shelf = shelfOf([SERUM, { id: 'e-shampoo', ingredients: ['Aqua'], facts: { category: 'hair' } }])
    const facts = factsOf({ ...shelf, entries: [...shelf.entries, { id: 'e-gone', kind: 'product', addedAt: AT, productId: 'prod-gone', formulationId: 'form-gone' }] })

    expect(fingerprintInputOf(facts, floorOf(facts)).shelf.map((entry) => [entry.id, entry.category])).toEqual([
      ['e-serum', 'skin'],
      ['e-shampoo', 'hair'],
    ])
  })

  it('gives the safety snapshot as it is: the view, the state of the parse and the mentions', () => {
    const view = { choices: ['reaction' as const], reactionText: 'Moonlight Glow burned', prescriptionText: null, excludesPregnancyCaution: false, updatedAt: AT }
    const safety = { view, parseState: 'done' as const, mentions: [mentionOf()] }
    const facts = factsOf(BASIC, { safety })

    expect(fingerprintInputOf(facts, floorOf(facts)).safety).toEqual(safety)
  })

  it('gives a profile that never answered a null view, a null parse state and no mentions', () => {
    const facts = factsOf(BASIC)

    expect(fingerprintInputOf(facts, floorOf(facts)).safety).toEqual({ view: null, parseState: null, mentions: [] })
  })

  it('gives the scan as its skin type and each concern with its band, and null when there is no scan', () => {
    const scan = { skinType: 'oily' as const, concerns: [{ concern: 'hd_acne' as ShownConcern, band: 'a-little' as const }, { concern: 'hd_pore' as ShownConcern, band: 'clear' as const }] }
    const withScan = factsOf(BASIC, { scan })

    expect(fingerprintInputOf(withScan, floorOf(withScan)).scan).toEqual({ skinType: 'oily', concerns: [{ concern: 'hd_acne', band: 'a-little' }, { concern: 'hd_pore', band: 'clear' }] })
    expect(fingerprintInputOf(factsOf(BASIC), floorOf(factsOf(BASIC))).scan).toBeNull()
  })

  describe('tapers', () => {
    const POTENT = { id: 'e-potent', ingredients: ['Petrolatum', 'Clobetasol Propionate'] }

    it('holds no kind when the floor stopped nothing with a step-down, however many codes are approved', () => {
      const facts = factsOf(BASIC)

      expect(fingerprintInputOf(facts, floorOf(facts)).tapers).toEqual({})
    })

    it('holds the steroid code, and only that, when the floor used it', () => {
      const facts = factsOf(shelfOf([SERUM, POTENT]))

      expect(fingerprintInputOf(facts, floorOf(facts)).tapers).toEqual({ steroid: 'TPR-STEROID-1' })
    })

    it('holds the lightening code when a no-label tub used for lightening was stepped down', () => {
      const facts = factsOf(shelfOf([SERUM], [{ id: 'e-tub', purpose: 'lighten' }]))

      expect(fingerprintInputOf(facts, floorOf(facts)).tapers).toEqual({ 'lightening-agent': 'TPR-LIGHTENING-1' })
    })

    it('holds both kinds when the floor used both', () => {
      const facts = factsOf(shelfOf([POTENT, { id: 'e-hq', ingredients: ['Aqua', 'Hydroquinone'] }]))

      expect(fingerprintInputOf(facts, floorOf(facts)).tapers).toEqual({ steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' })
    })

    it('hashes a shelf with no steroid the same whether or not the steroid template code changed, and a shelf with a steroid differently', async () => {
      const recoded = { ...REFERENCE, tapers: { ...REFERENCE.tapers, steroid: 'TPR-STEROID-2' } }
      const clean = factsOf(BASIC)
      const cleanRecoded = factsOf(BASIC, { reference: recoded })
      const steroid = factsOf(shelfOf([SERUM, POTENT]))
      const steroidRecoded = factsOf(shelfOf([SERUM, POTENT]), { reference: recoded })
      const hash = (facts: Facts) => verdictFingerprint(fingerprintInputOf(facts, floorOf(facts)))

      expect(await hash(cleanRecoded)).toBe(await hash(clean))
      expect(await hash(steroidRecoded)).not.toBe(await hash(steroid))
    })

    it('does not hold a kind whose product was stopped at once (mercury) rather than stepped down', () => {
      const mercury = { ...REFERENCE, rules: [...RULES, ruleOf({ name: 'mercuric chloride', kind: 'banned-substance', group: 'mercury' })] }
      const facts = factsOf(shelfOf([{ id: 'e-hg', ingredients: ['Aqua', 'Mercuric Chloride'] }]), { reference: mercury })

      expect(fingerprintInputOf(facts, floorOf(facts)).tapers).toEqual({})
    })
  })
})

describe('provenanceOf', () => {
  const view = { choices: ['reaction' as const, 'prescription' as const], reactionText: 'my Moonlight Glow tub burned me', prescriptionText: 'Dermovate from Dr Obi', excludesPregnancyCaution: false, updatedAt: AT }
  const safety = {
    view,
    parseState: 'done' as const,
    mentions: [mentionOf(), mentionOf({ id: 'mention-2', source: 'prescription', name: 'Dermovate', brand: 'Obi Pharma', productId: 'prod-derm', position: 1 })],
  }
  const scan = { skinType: 'combination' as const, concerns: [{ concern: 'hd_age_spot' as ShownConcern, band: 'some' as const }] }
  const shelf = shelfOf([SERUM, { id: 'e-potent', ingredients: ['Petrolatum', 'Clobetasol Propionate'] }], [{ id: 'e-tub', purpose: 'moisturise' }])

  it('records the goal, the resolved entries by formulation or purpose, the scan bands, the safety choices with the parse state, and the step-down codes used', () => {
    const facts = factsOf(shelf, { safety, scan })

    expect(provenanceOf(facts, floorOf(facts))).toEqual({
      goal: 'fade-dark-marks',
      entries: [
        { id: 'e-serum', formulationId: 'form-e-serum' },
        { id: 'e-potent', formulationId: 'form-e-potent' },
        { id: 'e-tub', noLabelPurpose: 'moisturise' },
      ],
      scan: { skinType: 'combination', concerns: [{ concern: 'hd_age_spot', band: 'some' }] },
      // The choices are sorted, and a mention is its source, its catalog product id (if any), its kind and its resolution: never its name. The mentions are
      // sorted by source, then product id, then kind, so the same answers always give the same row whatever order they were read in.
      safety: {
        choices: ['prescription', 'reaction'],
        parseState: 'done',
        mentions: [
          { source: 'prescription', productId: 'prod-derm', kind: 'product', resolution: 'resolved' },
          { source: 'reaction', productId: 'prod-named', kind: 'product', resolution: 'resolved' },
        ],
      },
      taperCodes: ['TPR-STEROID-1'],
    })
  })

  it('records the choices sorted, whatever order the view held them in', () => {
    const facts = factsOf(BASIC, { safety: { ...safety, view: { ...view, choices: ['reaction', 'pregnant', 'prescription', 'breastfeeding'] } } })

    expect(provenanceOf(facts, floorOf(facts)).safety.choices).toEqual(['breastfeeding', 'pregnant', 'prescription', 'reaction'])
  })

  it('records an ingredient the user named, which has no catalog product and no resolution, and a product still being looked up, by those enums only, in a fixed order whatever order they were read in', () => {
    const mentions = [
      mentionOf({ id: 'm-unresolved', position: 2, source: 'reaction', productId: 'prod-unfound', resolution: 'unresolved', name: 'Other Tub Name' }),
      mentionOf({ id: 'm-pending', position: 1, source: 'prescription', productId: null, resolution: 'pending', name: 'Secret Tub Name' }),
      mentionOf({ id: 'm-ingredient', source: 'prescription', kind: 'ingredient', name: 'lanolin zeta', brand: null, category: null, productId: null, resolution: null }),
    ]
    const facts = factsOf(BASIC, { safety: { ...safety, mentions } })

    const saved = provenanceOf(facts, floorOf(facts)).safety.mentions

    // Prescription before reaction; within a source the same product id (here none) falls back to the kind, ingredient before product.
    expect(saved).toEqual([
      { source: 'prescription', productId: null, kind: 'ingredient', resolution: null },
      { source: 'prescription', productId: null, kind: 'product', resolution: 'pending' },
      { source: 'reaction', productId: 'prod-unfound', kind: 'product', resolution: 'unresolved' },
    ])
    const text = JSON.stringify(provenanceOf(facts, floorOf(facts)))
    for (const word of ['lanolin zeta', 'Secret Tub Name', 'Other Tub Name', 'Moonlight']) expect(text).not.toContain(word)
  })

  it('orders the mentions of one source by their catalog product id', () => {
    const mentions = [mentionOf({ id: 'm-b', productId: 'prod-b' }), mentionOf({ id: 'm-a', productId: 'prod-a', position: 1 })]
    const facts = factsOf(BASIC, { safety: { ...safety, mentions } })

    expect(provenanceOf(facts, floorOf(facts)).safety.mentions.map((mention) => mention.productId)).toEqual(['prod-a', 'prod-b'])
  })

  it('records no mentions for a profile with no safety answers', () => {
    const facts = factsOf(BASIC)

    expect(provenanceOf(facts, floorOf(facts)).safety.mentions).toEqual([])
  })

  it('leaves out an entry that is not skin care', () => {
    const mixed = shelfOf([SERUM, { id: 'e-shampoo', ingredients: ['Aqua', 'Sodium Laureth Sulfate'], facts: { category: 'hair' } }], [{ id: 'e-lip', purpose: 'not-sure', category: 'makeup' }, { id: 'e-tub', purpose: 'moisturise' }])
    const facts = factsOf(mixed)

    expect(provenanceOf(facts, floorOf(facts)).entries.map((entry) => entry.id)).toEqual(['e-serum', 'e-tub'])
  })

  it('holds no word the user typed and no product name', () => {
    const facts = factsOf(shelf, { safety, scan })

    const saved = JSON.stringify(provenanceOf(facts, floorOf(facts)))

    for (const text of ['Moonlight', 'burned', 'Dermovate', 'Dr Obi', 'Obi Pharma', 'Dew Serum', 'Orbis']) expect(saved).not.toContain(text)
  })

  it('records no scan, no choices and no parse state for a profile with neither', () => {
    const facts = factsOf(BASIC)

    expect(provenanceOf(facts, floorOf(facts))).toMatchObject({ scan: null, safety: { choices: [], parseState: null }, taperCodes: [] })
  })

  it('leaves out an entry that did not resolve', () => {
    const facts = factsOf({ ...shelf, entries: [...shelf.entries, { id: 'e-gone', kind: 'product', addedAt: AT, productId: 'prod-gone', formulationId: 'form-gone' }] })

    expect(provenanceOf(facts, floorOf(facts)).entries.map((entry) => entry.id)).toEqual(['e-serum', 'e-potent', 'e-tub'])
  })
})
