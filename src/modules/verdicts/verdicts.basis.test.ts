import { describe, expect, it } from 'vitest'
import type { FitProductResult, FitResult } from '../../providers/verdict-fitting/verdict-fitter.provider'
import type { Category } from '../catalog/catalog.vocabulary'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import type { NoLabelPurpose } from '../scans/scans.vocabulary'
import { floorVerdicts, type FloorInput, type FloorMention, type FloorResult, type FloorRule, type FloorShelfEntry } from './verdicts.floor'
import { mergeVerdict, type VerdictProduct } from './verdicts.merge'

// Where each product's verdict came from, saved with it as `basis` (spec #259, PR A3): the merge turns the rules floor's facts (or the fit judge's answer, or
// none) into a list of reasons the app can show under "Where this comes from". A PURE mapping, tested through the merge seam that already exists, over the
// REAL floor, so every state here is one the product can reach.
//
// THE CONTRACT THIS FILE PINS (names are this file's choice, the implementer may not rename them without changing it)
//   mergeVerdict({ floor, fit, entries, choices?, reference }) where `reference` is { rules, claimWords }: the approved rules the floor was given, each with
//     its `reviewerRole: string | null` (its source link is the `source` the rule already has), and the approved claim words as
//     { phrase, sourceUrl: string | null, reviewerRole: string | null }. It is the same `rules` and `claimWords` a VerdictReference holds.
//   VerdictProduct.basis: Basis[], with
//     Basis = { kind: 'rule', source: 'ingredient-rule' | 'claim-word', statement, sourceUrl: string | null, reviewerRole: string | null, line }
//           | { kind: 'fit', line } | { kind: 'told-us', about: 'reaction' | 'prescription', line } | { kind: 'no-label', about: 'purpose' | 'unknown-contents', line }
//   A rule basis's `line` is its `statement` (the rule's own words, taken from the approved rule as it was when the verdict was built). Every other `line` is fixed copy.
//
//   floor fact                                        basis
//   ingredient-group | banned-substance | pregnancy   rule / ingredient-rule of the approved rule that flagged the ingredient
//   claim-phrase                                      rule / claim-word of the approved claim word with that phrase; the statement is fixed copy naming the phrase
//   reaction-product                                  told-us / reaction
//   reaction-ingredient                               the matching ingredient rule's basis (where the ingredient has a rule), then told-us / reaction
//   prescription                                      told-us / prescription (the floor already drops every other fact of a prescribed product)
//   no-label-purpose                                  no-label / purpose
//   unknown-contents                                  no-label / unknown-contents
//   fit decided (helping, redundant, blocking, or reduced by a clash)   [fit]
//   undecided (the judge has not answered)            []
//   Several facts: every basis once, rules before the rest, the rules in the order of the facts.
//
// WHAT IS PINNED EXACTLY: the two told-us lines and the fit line (the brief quotes them), and every rule basis (it is the workbook's own words, from the fixtures below).
// WHAT IS NOT: the no-label lines and the claim-word statement beyond what they must say, which await the owner's sign-off; they are pinned by meaning and by the wording gate.
// Expected values are literals written from the fixtures, never recomputed the way the merge does.

const ROLE_RETINOL = 'a consultant dermatologist'
type BasisRule = FloorRule & { reviewerRole: string | null }
const rule = (over: Partial<BasisRule> & Pick<BasisRule, 'name' | 'kind'>): BasisRule => ({ aliases: [], rule: `${over.name} (test rule)`, source: null, group: null, clashesWith: [], reviewerRole: null, ...over })

const RULES: BasisRule[] = [
  rule({ name: 'mercury', aliases: ['mercuric chloride'], kind: 'banned-substance', group: 'mercury', rule: 'Mercury compounds can poison the body.', source: 'https://example.org/rules/mercury', reviewerRole: 'a toxicologist' }),
  rule({ name: 'clobetasol propionate', aliases: ['clobetasol'], kind: 'banned-substance', group: 'steroid', rule: 'A strong steroid that needs a prescription.', source: 'https://example.org/rules/clobetasol', reviewerRole: ROLE_RETINOL }),
  rule({ name: 'hydroquinone', kind: 'restricted-substance', group: 'lightening-agent', rule: 'A lightening agent limited in many countries.', source: null, reviewerRole: null }),
  rule({ name: 'retinol', kind: 'pregnancy-caution', group: 'retinoid', clashesWith: ['exfoliating-acid', 'benzoyl-peroxide'], rule: 'Avoid retinoids while pregnant or breastfeeding.', source: 'https://example.org/rules/retinol', reviewerRole: 'a pharmacist' }),
  rule({ name: 'glycolic acid', kind: 'irritation', group: 'exfoliating-acid', clashesWith: ['retinoid', 'benzoyl-peroxide'] }),
  rule({ name: 'benzoyl peroxide', kind: 'irritation', group: 'benzoyl-peroxide', clashesWith: ['retinoid', 'exfoliating-acid'] }),
  rule({ name: 'parfum', aliases: ['fragrance'], kind: 'allergen', rule: 'Fragrance is a common cause of reactions.', source: 'https://example.org/rules/parfum', reviewerRole: 'a pharmacist' }),
  rule({ name: 'zzyzx musk', kind: 'banned-substance', rule: 'Not allowed in cosmetics in many countries.', source: 'https://example.org/rules/musk', reviewerRole: 'a toxicologist' }),
]
const CLAIM_WORDS = [
  { phrase: 'lightening', sourceUrl: 'https://example.org/claims/lightening', reviewerRole: 'a pharmacist' },
  { phrase: 'whitening', sourceUrl: null, reviewerRole: null },
]
const TAPERS = { steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' } as const

const TOLD_US_REACTION = { kind: 'told-us', about: 'reaction', line: 'You told us your skin reacted to this product.' }
const TOLD_US_PRESCRIPTION = { kind: 'told-us', about: 'prescription', line: 'You told us a doctor prescribed this.' }
const FIT = { kind: 'fit', line: 'Matched against your goal by our checker.' }

/** The basis the workbook's rule gives, written from the fixture: the statement is the rule's own words and the line is the statement. */
const ruleBasis = (name: string) => {
  const found = RULES.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no fixture rule ${name}`)
  return { kind: 'rule', source: 'ingredient-rule', statement: found.rule, sourceUrl: found.source, reviewerRole: found.reviewerRole, line: found.rule }
}

const product = (id: string, ingredients: string[], over: Partial<Extract<FloorShelfEntry, { kind: 'product' }>> = {}): FloorShelfEntry => ({
  id,
  kind: 'product',
  brand: 'Orbis',
  name: `Product ${id}`,
  variant: null,
  category: 'skin',
  productId: `prod-${id}`,
  ingredients,
  step: null,
  ...over,
})
const noLabel = (id: string, noLabelPurpose: NoLabelPurpose, category: Category = 'skin'): FloorShelfEntry => ({ id, kind: 'no-label', brand: null, name: `Tub ${id}`, variant: null, category, noLabelPurpose })
const mention = (over: Partial<FloorMention> & Pick<FloorMention, 'source' | 'kind'>): FloorMention => ({ name: 'anything', productId: null, ingredients: null, ...over })
const prescribed = (productId: string): FloorMention => mention({ source: 'prescription', kind: 'product', productId })
const reactedTo = (productId: string): FloorMention => mention({ source: 'reaction', kind: 'product', productId })
const reactedToIngredient = (name: string): FloorMention => mention({ source: 'reaction', kind: 'ingredient', name })

type Reference = { rules: readonly BasisRule[]; claimWords: readonly { phrase: string; sourceUrl: string | null; reviewerRole: string | null }[] }
const REFERENCE: Reference = { rules: RULES, claimWords: CLAIM_WORDS }

type Over = { pregnant?: boolean; mentions?: FloorMention[]; reference?: Reference }
const floorOf = (shelf: FloorShelfEntry[], over: Over = {}): FloorResult => {
  const reference = over.reference ?? REFERENCE
  const input: FloorInput = {
    shelf,
    rules: reference.rules,
    claimPhrases: reference.claimWords.map(({ phrase }) => phrase),
    tapers: TAPERS,
    safety: { excludesPregnancyCaution: over.pregnant ?? false, mentions: over.mentions ?? [] },
  }
  return floorVerdicts(input)
}

const AI = 'AI-SAID-THIS'
const helping = (id: string): FitProductResult => ({ id, label: 'helping', reason: `${AI} ${id} helps`, sameJobAs: null })
const blocking = (id: string): FitProductResult => ({ id, label: 'blocking', reason: `${AI} ${id} blocks`, sameJobAs: null })
const redundant = (id: string, sameJobAs: string): FitProductResult => ({ id, label: 'redundant', reason: `${AI} ${id} repeats`, sameJobAs })
const fitOf = (products: FitProductResult[], clashes: FitResult['clashes'] = []): FitResult => ({ products, clashes })

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

/** The real floor over the shelf, then the merge of it with `fit`. Everything handed to the merge is frozen, so a merge that edits its input (the reference included) throws. */
const merge = (shelf: FloorShelfEntry[], fit: FitResult | null, over: Over = {}) => {
  const floor = floorOf(shelf, over)
  return mergeVerdict(deepFreeze({ floor, fit, entries: shelf, reference: over.reference ?? REFERENCE }))
}
const basisOf = (result: ReturnType<typeof merge>, id: string): unknown => {
  const found = result.products.find((p) => p.entryId === id) as (VerdictProduct & { basis?: unknown }) | undefined
  if (!found) throw new Error(`no product ${id}`)
  return found.basis
}
/** The basis of the only product on the shelf, decided by the floor alone (the judge is asked about nothing, so it answers nothing). */
const floorBasis = (entry: FloorShelfEntry, over: Over = {}): unknown => basisOf(merge([entry], fitOf([]), over), entry.id)

describe('mergeVerdict: the basis of a product the floor decided by an ingredient rule', () => {
  it('is the rule that flagged the ingredient, with its own words, source link and reviewer role, when the label wrote an alias of the rule', () => {
    expect(floorBasis(product('cream', ['Aqua', 'Clobetasol']))).toEqual([ruleBasis('clobetasol propionate')])
  })

  it('is the mercury rule for mercury, with the reviewer role it was approved with', () => {
    expect(floorBasis(product('cream', ['Aqua', 'Mercuric Chloride']))).toEqual([ruleBasis('mercury')])
  })

  it('has a null source link and a null reviewer role when the rule has none: what a rule stored before contract 2.4.0 reads as, passed on as null and not left out', () => {
    const [hydroquinone] = floorBasis(product('cream', ['Aqua', 'Hydroquinone'])) as Record<string, unknown>[]

    expect(hydroquinone).toEqual(ruleBasis('hydroquinone'))
    expect(hydroquinone).toHaveProperty('sourceUrl', null)
    expect(hydroquinone).toHaveProperty('reviewerRole', null)
  })

  it('is the rule of a banned ingredient that belongs to no group', () => {
    expect(floorBasis(product('cream', ['Aqua', 'Zzyzx Musk']))).toEqual([ruleBasis('zzyzx musk')])
  })

  it('is the pregnancy rule for a pregnancy caution', () => {
    const basis = floorBasis(product('serum', ['Aqua', 'Retinol']), { pregnant: true })

    expect(basis).toEqual([ruleBasis('retinol')])
    expect(basis).toEqual([expect.objectContaining({ reviewerRole: 'a pharmacist', statement: 'Avoid retinoids while pregnant or breastfeeding.' })])
  })

  // Two approved rules can share a name (retinol is both an irritant and a pregnancy caution): the basis must be the one that decided, not the first with that name.
  describe('when another approved rule has the same name', () => {
    const twin = (over: Partial<BasisRule>): Reference => ({
      ...REFERENCE,
      rules: [rule({ name: over.name!, kind: 'irritation', rule: 'Can sting a weakened barrier.', source: 'https://example.org/rules/twin', reviewerRole: 'a nurse', ...over }), ...RULES],
    })

    it('gives the pregnancy rule for a pregnancy caution, not the irritant of the same name that comes first', () => {
      const reference = twin({ name: 'retinol' })

      expect(floorBasis(product('serum', ['Aqua', 'Retinol']), { pregnant: true, reference })).toEqual([ruleBasis('retinol')])
    })

    it('gives the steroid rule for a steroid step-down, not the irritant of the same name that comes first', () => {
      const reference = twin({ name: 'clobetasol propionate', aliases: ['clobetasol'] })

      expect(floorBasis(product('cream', ['Aqua', 'Clobetasol']), { reference })).toEqual([ruleBasis('clobetasol propionate')])
    })
  })
})

describe('mergeVerdict: the basis of a product the floor decided by a claim phrase', () => {
  const claimed = (name: string) => product('glow', ['Aqua', 'Glycerin'], { name })

  it('is the claim word that matched, with its source link and reviewer role, and a fixed statement that names the phrase; its line is the statement', () => {
    const basis = floorBasis(claimed('Lightening Glow Cream')) as Record<string, unknown>[]

    expect(basis).toHaveLength(1)
    expect(basis[0]).toEqual({
      kind: 'rule',
      source: 'claim-word',
      statement: expect.stringContaining('lightening'),
      sourceUrl: 'https://example.org/claims/lightening',
      reviewerRole: 'a pharmacist',
      line: basis[0]!.statement,
    })
    expect((basis[0]!.statement as string).length).toBeGreaterThan('lightening'.length)
  })

  it('has a null source link and a null reviewer role when the claim word has none, and still names the phrase', () => {
    const [word] = floorBasis(claimed('Whitening Glow Cream')) as Record<string, unknown>[]

    expect(word).toMatchObject({ kind: 'rule', source: 'claim-word', statement: expect.stringContaining('whitening') })
    expect(word).toHaveProperty('sourceUrl', null)
    expect(word).toHaveProperty('reviewerRole', null)
  })

  it('is the word of the phrase the name holds, not another approved word', () => {
    const [word] = floorBasis(claimed('Whitening Glow Cream')) as Record<string, unknown>[]

    expect(word!.statement).not.toContain('lightening')
  })
})

describe('mergeVerdict: the basis of a product the user told us about', () => {
  it('is what the user told us about the product they reacted to, in the fixed line', () => {
    expect(floorBasis(product('cream', ['Aqua']), { mentions: [reactedTo('prod-cream')] })).toEqual([TOLD_US_REACTION])
  })

  it('is the same for a product marked from the skin log', () => {
    const marked = mention({ source: 'skin-log', kind: 'product', productId: 'prod-cream' })

    expect(floorBasis(product('cream', ['Aqua']), { mentions: [marked] })).toEqual([TOLD_US_REACTION])
  })

  it('is the ingredient rule first and then what the user told us when they reacted to an ingredient that has a rule', () => {
    const basis = floorBasis(product('toner', ['Aqua', 'Parfum']), { mentions: [reactedToIngredient('fragrance')] })

    expect(basis).toEqual([ruleBasis('parfum'), TOLD_US_REACTION])
  })

  it('is only what the user told us when they reacted to an ingredient that has no rule', () => {
    const basis = floorBasis(product('toner', ['Aqua', 'Glycerin']), { mentions: [reactedToIngredient('glycerin')] })

    expect(basis).toEqual([TOLD_US_REACTION])
  })

  it('is what the user told us about a prescription, and nothing from the rules, for a prescribed product that holds a steroid the rules would step down', () => {
    const shelf = [product('rx', ['Aqua', 'Clobetasol']), product('cream', ['Aqua'])]
    const result = merge(shelf, fitOf([helping('cream')]), { mentions: [prescribed('prod-rx')] })

    expect(basisOf(result, 'rx')).toEqual([TOLD_US_PRESCRIPTION])
  })

  it('is what the user told us about a prescription for a prescribed product that is also one they reacted to', () => {
    const result = merge([product('rx', ['Aqua'])], fitOf([]), { mentions: [prescribed('prod-rx'), reactedTo('prod-rx')] })

    expect(basisOf(result, 'rx')).toEqual([TOLD_US_PRESCRIPTION])
  })
})

describe('mergeVerdict: the basis of a product with no label to read', () => {
  it('is "purpose" for a no-label product described as used for lightening', () => {
    const basis = floorBasis(noLabel('tub', 'lighten')) as Record<string, unknown>[]

    expect(basis).toEqual([{ kind: 'no-label', about: 'purpose', line: expect.any(String) }])
    expect((basis[0]!.line as string).length).toBeGreaterThan(0)
  })

  it('is "unknown-contents" for a no-label product described as used for anything else', () => {
    expect(floorBasis(noLabel('tub', 'moisturise'))).toEqual([{ kind: 'no-label', about: 'unknown-contents', line: expect.any(String) }])
  })

  it('is "unknown-contents" for a product whose ingredient list is empty, since nothing is known of it', () => {
    expect(floorBasis(product('blank', []))).toEqual([{ kind: 'no-label', about: 'unknown-contents', line: expect.any(String) }])
  })

  it('says, for unknown contents, that we cannot see what is in it and so treat it with caution', () => {
    const [basis] = floorBasis(noLabel('tub', 'moisturise')) as { line: string }[]

    expect(basis!.line).toMatch(/caution|careful/i)
  })

  it('has a line for the purpose that differs from the line for unknown contents', () => {
    const [purpose] = floorBasis(noLabel('tub', 'lighten')) as { line: string }[]
    const [unknown] = floorBasis(noLabel('tub', 'moisturise')) as { line: string }[]

    expect(purpose!.line).not.toBe(unknown!.line)
  })
})

describe('mergeVerdict: the basis of a product the fit judge decided', () => {
  const SHELF = () => [product('a', ['Aqua', 'Glycerin']), product('b', ['Aqua', 'Cetearyl Alcohol']), product('c', ['Aqua', 'Squalane'])]

  it('is the fit line alone for a helping, a redundant and a blocking product', () => {
    const result = merge(SHELF(), fitOf([helping('a'), redundant('b', 'a'), blocking('c')]))

    expect(basisOf(result, 'a')).toEqual([FIT])
    expect(basisOf(result, 'b')).toEqual([FIT])
    expect(basisOf(result, 'c')).toEqual([FIT])
  })

  it('does not call the fit a reviewed rule, which it is not', () => {
    const [basis] = basisOf(merge(SHELF(), fitOf([helping('a'), helping('b'), helping('c')])), 'a') as { line: string }[]

    expect(basis!.line).not.toMatch(/reviewed rule/i)
  })

  it('is the fit line alone for the product of a clashing pair that the verdict reduced to alternate days', () => {
    const shelf = [product('serum', ['Aqua', 'Retinol']), product('toner', ['Aqua', 'Glycolic Acid']), product('cream', ['Aqua', 'Glycerin'])]
    const result = merge(shelf, fitOf([helping('serum'), helping('toner'), helping('cream')], [{ ids: ['serum', 'toner'], reduceId: 'toner' }]))

    expect(result.products.find((p) => p.entryId === 'toner')).toMatchObject({ group: 'conflicting', verdict: { kind: 'reduce' } })
    expect(basisOf(result, 'toner')).toEqual([FIT])
    expect(basisOf(result, 'serum')).toEqual([FIT])
  })

  it('has no basis at all for a product the judge has not answered about: it is undecided, and nothing yet says why', () => {
    const result = merge(SHELF(), null)

    for (const id of ['a', 'b', 'c']) {
      expect(result.products.find((p) => p.entryId === id)).toMatchObject({ group: 'undecided' })
      expect(basisOf(result, id), id).toEqual([])
    }
  })

  it('still gives the floor-decided product beside an undecided one its own basis', () => {
    const result = merge([product('cream', ['Aqua', 'Clobetasol']), product('serum', ['Aqua', 'Glycerin'])], null)

    expect(basisOf(result, 'cream')).toEqual([ruleBasis('clobetasol propionate')])
    expect(basisOf(result, 'serum')).toEqual([])
  })

  it('never takes a basis from the judge for a product the floor decided: its answer about it is not read', () => {
    const result = merge([product('cream', ['Aqua', 'Clobetasol']), product('serum', ['Aqua', 'Glycerin'])], fitOf([helping('serum'), helping('cream')]))

    expect(basisOf(result, 'cream')).toEqual([ruleBasis('clobetasol propionate')])
  })
})

describe('mergeVerdict: the basis of a product the floor decided on several facts', () => {
  it('lists every basis once: the ingredient rule and the claim word that both made it a lightening product, in the order of the floor\'s facts', () => {
    const basis = floorBasis(product('glow', ['Aqua', 'Hydroquinone'], { name: 'Lightening Glow Cream' })) as Record<string, unknown>[]

    expect(basis).toHaveLength(2)
    expect(basis[0]).toEqual(ruleBasis('hydroquinone'))
    expect(basis[1]).toMatchObject({ kind: 'rule', source: 'claim-word', sourceUrl: 'https://example.org/claims/lightening', reviewerRole: 'a pharmacist' })
  })

  it('lists a rule once when two facts rest on it, and puts the rules before what the user told us', () => {
    // Retinol is flagged for a pregnant user and is also an ingredient they reacted to: one rule, then what they told us.
    const basis = floorBasis(product('serum', ['Aqua', 'Retinol']), { pregnant: true, mentions: [reactedToIngredient('retinol')] })

    expect(basis).toEqual([ruleBasis('retinol'), TOLD_US_REACTION])
  })

  it('lists what the user told us once, however many ingredients they reacted to', () => {
    const basis = floorBasis(product('toner', ['Aqua', 'Parfum', 'Glycerin']), { mentions: [reactedToIngredient('fragrance'), reactedToIngredient('glycerin')] })

    expect(basis).toEqual([ruleBasis('parfum'), TOLD_US_REACTION])
  })

  it('lists both rules (the pregnancy rule and the rule of the ingredient the user reacted to) before what the user told us', () => {
    const basis = floorBasis(product('serum', ['Aqua', 'Retinol', 'Parfum']), { pregnant: true, mentions: [reactedToIngredient('fragrance')] }) as Record<string, unknown>[]

    expect(basis.map((entry) => entry.kind)).toEqual(['rule', 'rule', 'told-us'])
    expect(basis.slice(0, 2)).toEqual(expect.arrayContaining([ruleBasis('retinol'), ruleBasis('parfum')]))
  })

  it('is the same list in the same order every time the same verdict is built', () => {
    const build = () => floorBasis(product('serum', ['Aqua', 'Retinol', 'Parfum']), { pregnant: true, mentions: [reactedToIngredient('fragrance')] })

    expect(build()).toEqual(build())
  })
})

describe('mergeVerdict: the fixed lines of a basis', () => {
  const trips = (text: string): string[] => FORBIDDEN_WORDING.filter(({ pattern }) => pattern.test(text)).map(({ code }) => code)

  /** Every kind of basis the merge can give, each reached through the floor or the judge as in life. */
  const EVERY_BASIS = (): { where: string; basis: Record<string, unknown> }[] => {
    const cases: [string, FloorShelfEntry[], FitResult | null, Over][] = [
      ['a claim word', [product('glow', ['Aqua'], { name: 'Lightening Glow Cream' })], fitOf([]), {}],
      ['a claim word with no source or role', [product('glow', ['Aqua'], { name: 'Whitening Glow Cream' })], fitOf([]), {}],
      ['a reaction to a product', [product('cream', ['Aqua'])], fitOf([]), { mentions: [reactedTo('prod-cream')] }],
      ['a reaction to an ingredient', [product('toner', ['Aqua', 'Parfum'])], fitOf([]), { mentions: [reactedToIngredient('fragrance')] }],
      ['a prescription', [product('rx', ['Aqua'])], fitOf([]), { mentions: [prescribed('prod-rx')] }],
      ['a no-label product used for lightening', [noLabel('tub', 'lighten')], fitOf([]), {}],
      ['a no-label product used for anything else', [noLabel('tub', 'moisturise')], fitOf([]), {}],
      ['the fit judge', [product('a', ['Aqua', 'Glycerin'])], fitOf([helping('a')]), {}],
    ]
    return cases.flatMap(([where, shelf, fit, over]) => {
      const result = merge(shelf, fit, over)
      return result.products.flatMap((p) => ((p as VerdictProduct & { basis: Record<string, unknown>[] }).basis ?? []).map((basis) => ({ where, basis })))
    })
  }

  it('gives every basis a non-empty line', () => {
    const every = EVERY_BASIS()

    expect(every.length).toBeGreaterThanOrEqual(8)
    for (const { where, basis } of every) {
      expect(typeof basis.line, where).toBe('string')
      expect((basis.line as string).trim().length, where).toBeGreaterThan(0)
    }
  })

  it('gives the lines of a rule basis as the rule\'s statement, and every other kind of basis a line of its own', () => {
    const lines = EVERY_BASIS().filter(({ basis }) => basis.kind !== 'rule')

    // told-us (reaction, prescription), no-label (purpose, unknown-contents) and fit: five distinct fixed lines.
    expect(new Set(lines.map(({ basis }) => basis.line)).size).toBe(5)
    for (const { basis } of EVERY_BASIS().filter(({ basis }) => basis.kind === 'rule')) expect(basis.line).toBe(basis.statement)
  })

  it('passes FORBIDDEN_WORDING on every fixed line there can be: the told-us, no-label and fit lines', () => {
    for (const { where, basis } of EVERY_BASIS().filter(({ basis }) => basis.kind !== 'rule')) expect(trips(basis.line as string), `${where}: "${basis.line}"`).toEqual([])
  })

  // The statement of a claim word names the phrase, and a phrase like "whitening" is itself a word the gate forbids, so the gate is applied to the words around it.
  it('passes FORBIDDEN_WORDING on the words of a claim word\'s statement apart from the phrase it names', () => {
    const claims = EVERY_BASIS().filter(({ basis }) => basis.source === 'claim-word')

    expect(claims.length).toBeGreaterThanOrEqual(2)
    for (const { basis } of claims) {
      const phrase = (['lightening', 'whitening'] as const).find((candidate) => (basis.statement as string).includes(candidate))
      expect(phrase, String(basis.statement)).toBeDefined()
      const around = (basis.statement as string).replaceAll(phrase!, '')
      expect(trips(around), `"${around}"`).toEqual([])
    }
  })
})
