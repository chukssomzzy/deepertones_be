import { describe, expect, it } from 'vitest'
import type { Category } from '../catalog/catalog.vocabulary'
import type { NoLabelPurpose } from '../scans/scans.vocabulary'
import { floorVerdicts, type FloorEntry, type FloorInput, type FloorMention, type FloorResult, type FloorRule, type FloorShelfEntry } from './verdicts.floor'

// The rules floor of the shelf verdict (spec #171): a PURE function over plain data. It decides the safety labels (prescribed, likely the problem,
// conflicting, can't tell) and leaves every other skin product OPEN for the fit judge; it also reports the shelf pairs that clash, with the one it would
// reduce if the judge does not name one. No I/O, no clock, no model: the same input is the same output.
// Expected values are literals worked out from the spec and the owner's decisions, never taken from the code under test. Products and brands are invented;
// ingredient names are the real ones the groups are about.

// ---- the live rules, as the floor receives them: a rule's reviewed statement plus the Ingredients tab's group and clashes_with ----

const ruleOf = (over: Partial<FloorRule> & Pick<FloorRule, 'name' | 'kind'>): FloorRule => ({
  aliases: [],
  rule: `${over.name} (test rule)`,
  source: null,
  group: null,
  clashesWith: [],
  ...over,
})

const RULES: FloorRule[] = [
  ruleOf({ name: 'mercury', aliases: ['mercuric chloride'], kind: 'banned-substance', group: 'mercury' }),
  ruleOf({ name: 'clobetasol propionate', aliases: ['clobetasol'], kind: 'banned-substance', group: 'steroid' }),
  ruleOf({ name: 'hydroquinone', aliases: ['quinol'], kind: 'restricted-substance', group: 'lightening-agent' }),
  ruleOf({ name: 'retinol', kind: 'pregnancy-caution', group: 'retinoid', clashesWith: ['exfoliating-acid', 'benzoyl-peroxide'] }),
  ruleOf({ name: 'retinal', kind: 'pregnancy-caution', group: 'retinoid', clashesWith: ['exfoliating-acid', 'benzoyl-peroxide'] }),
  ruleOf({ name: 'glycolic acid', kind: 'irritation', group: 'exfoliating-acid', clashesWith: ['retinoid', 'benzoyl-peroxide'] }),
  ruleOf({ name: 'lactic acid', kind: 'irritation', group: 'exfoliating-acid', clashesWith: ['retinoid', 'benzoyl-peroxide'] }),
  ruleOf({ name: 'benzoyl peroxide', kind: 'irritation', group: 'benzoyl-peroxide', clashesWith: ['retinoid', 'exfoliating-acid'] }),
  ruleOf({ name: 'parfum', aliases: ['fragrance'], kind: 'allergen' }),
  ruleOf({ name: 'alcohol denat', kind: 'irritation' }),
  // A banned substance that belongs to no group (like the banned fragrance allergens): the floor reads groups, so this alone decides nothing.
  ruleOf({ name: 'zzyzx musk', kind: 'banned-substance' }),
]

// The workbook's reviewed claim words and approved step-down templates (kind to template code), as the floor receives them.
const CLAIMS = ['lightening', 'whitening', 'bleaching', 'fairness', 'toning']
const TAPERS = { steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' } as const

// ---- builders ----

const product = (id: string, ingredients: string[], over: Partial<Extract<FloorShelfEntry, { kind: 'product' }>> = {}): FloorShelfEntry => ({
  id,
  kind: 'product',
  brand: 'Orbis',
  name: `Product ${id}`,
  variant: null,
  category: 'skin',
  productId: `prod-${id}`,
  ingredients,
  ...over,
})

const noLabel = (id: string, noLabelPurpose: NoLabelPurpose, category: Category = 'skin'): FloorShelfEntry => ({
  id,
  kind: 'no-label',
  brand: null,
  name: `Tub ${id}`,
  variant: null,
  category,
  noLabelPurpose,
})

const mention = (over: Partial<FloorMention> & Pick<FloorMention, 'source' | 'kind'>): FloorMention => ({ name: 'anything', productId: null, ingredients: null, ...over })

const reactedTo = (productId: string, ingredients: string[] | null = null): FloorMention => mention({ source: 'reaction', kind: 'product', productId, ingredients })
const prescribed = (productId: string, ingredients: string[] | null = null): FloorMention => mention({ source: 'prescription', kind: 'product', productId, ingredients })
const reactedToIngredient = (name: string): FloorMention => mention({ source: 'reaction', kind: 'ingredient', name })

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

type Overrides = { rules?: FloorRule[]; claimPhrases?: string[]; tapers?: FloorInput['tapers']; pregnant?: boolean; mentions?: FloorMention[] }

const inputOf = (shelf: FloorShelfEntry[], over: Overrides = {}): FloorInput => ({
  shelf,
  rules: over.rules ?? RULES,
  claimPhrases: over.claimPhrases ?? CLAIMS,
  tapers: over.tapers ?? TAPERS,
  safety: { excludesPregnancyCaution: over.pregnant ?? false, mentions: over.mentions ?? [] },
})

// The input is frozen, so a floor that edits what it was given throws.
const floor = (shelf: FloorShelfEntry[], over: Overrides = {}): FloorResult => floorVerdicts(deepFreeze(inputOf(shelf, over)))

const entryOf = (result: FloorResult, id: string): FloorEntry => {
  const found = result.entries.find((entry) => entry.id === id)
  if (!found) throw new Error(`no entry ${id}`)
  return found
}

const OPEN = (id: string): FloorEntry => ({ id, status: 'open' })

describe('floorVerdicts', () => {
  describe('a product nothing is known against', () => {
    it('is left open for the fit judge, with no clash', () => {
      const result = floor([product('cream', ['Aqua', 'Glycerin', 'Shea Butter'])])

      expect(result).toEqual({ entries: [OPEN('cream')], clashes: [] })
    })
  })

  describe('likely the problem', () => {
    it('drops a product with a mercury compound at once, and says to escalate to a professional', () => {
      const result = floor([product('cream', ['Aqua', 'Mercuric Chloride', 'Glycerin'])])

      expect(entryOf(result, 'cream')).toEqual({
        id: 'cream',
        status: 'fixed',
        group: 'likely-the-problem',
        verdict: { kind: 'drop' },
        escalate: true,
        facts: [{ kind: 'ingredient-group', group: 'mercury', ingredient: 'Mercuric Chloride' }],
      })
    })

    it('stops a product with a steroid with the approved steroid step-down, matching a name with a strength', () => {
      const result = floor([product('cream', ['Aqua', 'Clobetasol Propionate 0.05%'])])

      expect(entryOf(result, 'cream')).toEqual({
        id: 'cream',
        status: 'fixed',
        group: 'likely-the-problem',
        verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' },
        escalate: false,
        facts: [{ kind: 'ingredient-group', group: 'steroid', ingredient: 'Clobetasol Propionate 0.05%' }],
      })
    })

    it('stops a product with a lightening agent with the approved lightening step-down, matching an alias inside a bracket', () => {
      const result = floor([product('cream', ['Aqua', 'Skin Complex (Quinol)'])])

      expect(entryOf(result, 'cream')).toEqual({
        id: 'cream',
        status: 'fixed',
        group: 'likely-the-problem',
        verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' },
        escalate: false,
        facts: [{ kind: 'ingredient-group', group: 'lightening-agent', ingredient: 'Skin Complex (Quinol)' }],
      })
    })

    it('uses the group of the live rules it is given, so a group removed from a rule decides nothing', () => {
      const ungrouped = RULES.map((rule) => (rule.name === 'hydroquinone' ? { ...rule, group: null } : rule))

      expect(entryOf(floor([product('cream', ['Hydroquinone 4%'])], { rules: ungrouped }), 'cream')).toEqual(OPEN('cream'))
    })

    describe('a banned substance that belongs to no rule group (an EU-banned fragrance allergen, tretinoin sold as a cosmetic)', () => {
      it('drops the product at once with no step-down and no escalation, and names the ingredient', () => {
        const result = floor([product('perfume', ['Aqua', 'Zzyzx Musk', 'Glycerin'])])

        expect(entryOf(result, 'perfume')).toEqual({
          id: 'perfume',
          status: 'fixed',
          group: 'likely-the-problem',
          verdict: { kind: 'drop' },
          escalate: false,
          facts: [{ kind: 'banned-substance', ingredient: 'Zzyzx Musk' }],
        })
      })

      it('needs no step-down template to drop', () => {
        expect(entryOf(floor([product('perfume', ['Zzyzx Musk'])], { tapers: {} }), 'perfume')).toMatchObject({ status: 'fixed', verdict: { kind: 'drop' } })
      })

      it('also covers a banned substance whose group decides no outcome of its own (tretinoin in the retinoid group): drop, no escalation, a banned-substance fact', () => {
        const rules = [...RULES, ruleOf({ name: 'tretinoin', kind: 'banned-substance', group: 'retinoid', clashesWith: ['exfoliating-acid'] })]

        expect(entryOf(floor([product('cream', ['Aqua', 'Tretinoin'])], { rules }), 'cream')).toEqual({
          id: 'cream',
          status: 'fixed',
          group: 'likely-the-problem',
          verdict: { kind: 'drop' },
          escalate: false,
          facts: [{ kind: 'banned-substance', ingredient: 'Tretinoin' }],
        })
      })

      it('is out of every clash pair even when its group clashes: an acid next to it makes no pair', () => {
        const rules = [...RULES, ruleOf({ name: 'tretinoin', kind: 'banned-substance', group: 'retinoid', clashesWith: ['exfoliating-acid'] })]

        const result = floor([product('cream', ['Aqua', 'Tretinoin']), product('toner', ['Aqua', 'Glycolic Acid'])], { rules })

        expect(entryOf(result, 'toner')).toEqual(OPEN('toner'))
        expect(result.clashes).toEqual([])
      })

      it('is not made by a banned substance that has a group: that one is a group fact (mercury, steroid), not a second fact', () => {
        const result = floor([product('cream', ['Mercury'])])

        expect(entryOf(result, 'cream')).toMatchObject({ facts: [{ kind: 'ingredient-group', group: 'mercury', ingredient: 'Mercury' }] })
      })

      it('is not made by a rule that is not banned: the same ingredient with another kind and no group decides nothing', () => {
        const irritant = RULES.map((rule) => (rule.name === 'zzyzx musk' ? { ...rule, kind: 'irritation' as const } : rule))

        expect(entryOf(floor([product('perfume', ['Zzyzx Musk'])], { rules: irritant }), 'perfume')).toEqual(OPEN('perfume'))
      })
    })

    describe('when more than one trigger holds', () => {
      const MERCURY = 'Mercury'
      const STEROID = 'Clobetasol'
      const HYDROQUINONE = 'Hydroquinone 2%'

      it('mercury wins over a steroid: drop and escalate, no step-down', () => {
        const entry = entryOf(floor([product('cream', [STEROID, MERCURY])]), 'cream')

        expect(entry).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'drop' }, escalate: true })
        expect(entry).toMatchObject({ facts: expect.arrayContaining([{ kind: 'ingredient-group', group: 'mercury', ingredient: MERCURY }]) })
      })

      it('mercury wins over a lightening agent', () => {
        expect(entryOf(floor([product('cream', [HYDROQUINONE, MERCURY])]), 'cream')).toMatchObject({ verdict: { kind: 'drop' }, escalate: true })
      })

      it('a steroid wins over a lightening agent: the steroid step-down, whichever is listed first', () => {
        expect(entryOf(floor([product('a', [HYDROQUINONE, STEROID])]), 'a')).toMatchObject({ verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, escalate: false })
        expect(entryOf(floor([product('b', [STEROID, HYDROQUINONE])]), 'b')).toMatchObject({ verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, escalate: false })
      })

      it('mercury wins over a steroid even when the product is also the one the user reacted to', () => {
        const result = floor([product('cream', [STEROID, MERCURY])], { mentions: [reactedTo('prod-cream')] })

        expect(entryOf(result, 'cream')).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'drop' }, escalate: true })
      })

      it('a steroid wins over a banned substance with no group: the step-down, not a drop', () => {
        expect(entryOf(floor([product('cream', ['Zzyzx Musk', STEROID])]), 'cream')).toMatchObject({ verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, escalate: false })
      })

      it('a lightening agent wins over a banned substance with no group: the step-down, not a drop', () => {
        expect(entryOf(floor([product('cream', ['Zzyzx Musk', HYDROQUINONE])]), 'cream')).toMatchObject({ verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' }, escalate: false })
      })

      it('mercury wins over a banned substance with no group: drop and escalate', () => {
        expect(entryOf(floor([product('cream', ['Zzyzx Musk', MERCURY])]), 'cream')).toMatchObject({ verdict: { kind: 'drop' }, escalate: true })
      })

      it('a banned substance with no group and a reaction match both drop, and the product says it holds the banned substance', () => {
        const result = floor([product('perfume', ['Zzyzx Musk'])], { mentions: [reactedTo('prod-perfume')] })

        expect(entryOf(result, 'perfume')).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'drop' }, escalate: false })
        expect(entryOf(result, 'perfume')).toMatchObject({ facts: expect.arrayContaining([{ kind: 'banned-substance', ingredient: 'Zzyzx Musk' }]) })
      })

      describe('and it is also the product the user reacted to (the reaction does not force a stop at once and adds no escalation)', () => {
        it('a steroid still gets the steroid step-down', () => {
          const result = floor([product('cream', ['Aqua', STEROID])], { mentions: [reactedTo('prod-cream')] })

          expect(entryOf(result, 'cream')).toMatchObject({ status: 'fixed', group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, escalate: false })
        })

        it('a lightening agent still gets the lightening step-down', () => {
          const result = floor([product('cream', ['Aqua', HYDROQUINONE])], { mentions: [reactedTo('prod-cream')] })

          expect(entryOf(result, 'cream')).toMatchObject({ status: 'fixed', group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' }, escalate: false })
        })

        it('a lightening claim still gets the lightening step-down', () => {
          const result = floor([product('cream', ['Aqua'], { name: 'Bleaching Cream' })], { mentions: [reactedTo('prod-cream')] })

          expect(entryOf(result, 'cream')).toMatchObject({ status: 'fixed', group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' }, escalate: false })
        })

        it('a steroid and a lightening agent together still get the steroid step-down', () => {
          const result = floor([product('cream', ['Aqua', STEROID, HYDROQUINONE])], { mentions: [reactedTo('prod-cream')] })

          expect(entryOf(result, 'cream')).toMatchObject({ verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, escalate: false })
        })

        it('with no template for the kind it needs it is taper-missing, not a drop', () => {
          const result = floor([product('cream', ['Aqua', STEROID])], { tapers: {}, mentions: [reactedTo('prod-cream')] })

          expect(entryOf(result, 'cream')).toMatchObject({ status: 'taper-missing', group: 'likely-the-problem', missingTaper: 'steroid', escalate: false })
        })

        it('mercury still wins: drop and escalate', () => {
          const result = floor([product('cream', ['Aqua', MERCURY, STEROID])], { mentions: [reactedTo('prod-cream')] })

          expect(entryOf(result, 'cream')).toMatchObject({ verdict: { kind: 'drop' }, escalate: true })
        })
      })
    })

    describe('a lightening or bleaching claim in the brand, name or variant', () => {
      it('stops the product with the lightening step-down, however the claim is cased, and names the approved phrase', () => {
        const result = floor([product('cream', ['Aqua', 'Glycerin'], { name: 'Glow WHITENING Cream' })])

        expect(entryOf(result, 'cream')).toEqual({
          id: 'cream',
          status: 'fixed',
          group: 'likely-the-problem',
          verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' },
          escalate: false,
          facts: [{ kind: 'claim-phrase', phrase: 'whitening' }],
        })
      })

      it('finds the claim in the brand alone and in the variant alone', () => {
        const result = floor([
          product('in-brand', ['Aqua'], { brand: 'Bleaching Lab', name: 'Body Milk' }),
          product('in-variant', ['Aqua'], { name: 'Body Milk', variant: 'Extra Fairness' }),
        ])

        expect(entryOf(result, 'in-brand')).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' } })
        expect(entryOf(result, 'in-variant')).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' } })
      })

      it('matches a whole word only: a longer word that contains the claim is not a claim', () => {
        expect(entryOf(floor([product('balm', ['Aqua'], { name: 'Unfairness Balm' })]), 'balm')).toEqual(OPEN('balm'))
      })

      it('matches a phrase of several words, and nothing outside the approved list ("brightening" and "glow" are not claim words)', () => {
        const phrases = ['skin toning']

        expect(entryOf(floor([product('a', ['Aqua'], { variant: 'SKIN  TONING' })], { claimPhrases: phrases }), 'a')).toMatchObject({ group: 'likely-the-problem' })
        expect(entryOf(floor([product('b', ['Aqua'], { name: 'Brightening Glow Serum' })]), 'b')).toEqual(OPEN('b'))
      })

      it('does not match a phrase split across the brand and the name', () => {
        const result = floor([product('cream', ['Aqua'], { brand: 'Skin', name: 'Toning Cream' })], { claimPhrases: ['skin toning'] })

        expect(entryOf(result, 'cream')).toEqual(OPEN('cream'))
      })

      it('gives one fact for a phrase that appears in two fields', () => {
        const result = floor([product('cream', ['Aqua'], { name: 'Whitening Cream', variant: 'Whitening' })])

        expect(entryOf(result, 'cream')).toMatchObject({ facts: [{ kind: 'claim-phrase', phrase: 'whitening' }] })
      })

      it('copes with a product that has no brand and no variant', () => {
        expect(entryOf(floor([product('plain', ['Aqua'], { brand: null, variant: null })]), 'plain')).toEqual(OPEN('plain'))
      })
    })

    describe('a no-label entry', () => {
      it('described as used for lightening is stopped with the lightening step-down', () => {
        const result = floor([noLabel('tub', 'lighten')])

        expect(entryOf(result, 'tub')).toEqual({
          id: 'tub',
          status: 'fixed',
          group: 'likely-the-problem',
          verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' },
          escalate: false,
          facts: [{ kind: 'no-label-purpose', purpose: 'lighten' }],
        })
      })
    })

    describe('the product the user said they reacted to', () => {
      it('is dropped at once with no step-down and no escalation, matched by product id', () => {
        const result = floor([product('serum', ['Aqua', 'Glycerin']), product('toner', ['Aqua', 'Rose Water'])], { mentions: [reactedTo('prod-serum')] })

        expect(entryOf(result, 'serum')).toEqual({
          id: 'serum',
          status: 'fixed',
          group: 'likely-the-problem',
          verdict: { kind: 'drop' },
          escalate: false,
          facts: [{ kind: 'reaction-product' }],
        })
        expect(entryOf(result, 'toner')).toEqual(OPEN('toner'))
      })

      it('is matched by a list that reads the same as its own, even under another product id and another spelling', () => {
        const result = floor([product('serum', ['Aqua', 'Glycerin'])], { mentions: [reactedTo('prod-elsewhere', ['AQUA', 'glycerin'])] })

        expect(entryOf(result, 'serum')).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'drop' }, escalate: false })
      })

      it('is not matched by a list that differs in its ingredients or in their order (the order is part of the formulation)', () => {
        const shelf = [product('serum', ['Aqua', 'Glycerin'])]

        expect(entryOf(floor(shelf, { mentions: [reactedTo('prod-elsewhere', ['Aqua', 'Glycerin', 'Panthenol'])] }), 'serum')).toEqual(OPEN('serum'))
        expect(entryOf(floor(shelf, { mentions: [reactedTo('prod-elsewhere', ['Glycerin', 'Aqua'])] }), 'serum')).toEqual(OPEN('serum'))
      })

      it('names nothing when the words were not resolved to a product or a list', () => {
        const result = floor([product('serum', ['Aqua', 'Glycerin'])], { mentions: [mention({ source: 'reaction', kind: 'product', productId: null, ingredients: null })] })

        expect(entryOf(result, 'serum')).toEqual(OPEN('serum'))
      })
    })

    describe('with no approved step-down template for the kind it needs', () => {
      it('says which kind is missing and invents no template code, for a steroid', () => {
        const result = floor([product('cream', ['Clobetasol'])], { tapers: { 'lightening-agent': 'TPR-LIGHTENING-1' } })

        expect(entryOf(result, 'cream')).toEqual({
          id: 'cream',
          status: 'taper-missing',
          group: 'likely-the-problem',
          missingTaper: 'steroid',
          escalate: false,
          facts: [{ kind: 'ingredient-group', group: 'steroid', ingredient: 'Clobetasol' }],
        })
      })

      it('says which kind is missing, for a lightening agent, a claim and a no-label lightener alike', () => {
        const result = floor([product('a', ['Hydroquinone']), product('b', ['Aqua'], { name: 'Bleaching Gel' }), noLabel('c', 'lighten')], { tapers: { steroid: 'TPR-STEROID-1' } })

        for (const id of ['a', 'b', 'c']) expect(entryOf(result, id)).toMatchObject({ status: 'taper-missing', group: 'likely-the-problem', missingTaper: 'lightening-agent' })
      })

      it('still drops mercury and a reaction match, which need no step-down', () => {
        const result = floor([product('a', ['Mercury']), product('b', ['Aqua'])], { tapers: {}, mentions: [reactedTo('prod-b')] })

        expect(entryOf(result, 'a')).toMatchObject({ status: 'fixed', verdict: { kind: 'drop' }, escalate: true })
        expect(entryOf(result, 'b')).toMatchObject({ status: 'fixed', verdict: { kind: 'drop' }, escalate: false })
      })
    })
  })

  describe('conflicting', () => {
    const retinolSerum = () => product('serum', ['Aqua', 'Retinol'])

    it('drops a product with a pregnancy-caution ingredient when the user is pregnant or breastfeeding', () => {
      const result = floor([retinolSerum()], { pregnant: true })

      expect(entryOf(result, 'serum')).toEqual({
        id: 'serum',
        status: 'fixed',
        group: 'conflicting',
        verdict: { kind: 'drop' },
        escalate: false,
        facts: [{ kind: 'pregnancy-caution', ingredient: 'Retinol' }],
      })
    })

    it('leaves the same product open when the user is not pregnant or breastfeeding', () => {
      expect(entryOf(floor([retinolSerum()], { pregnant: false }), 'serum')).toEqual(OPEN('serum'))
    })

    it('is beaten by likely the problem: one ingredient that is both a steroid and a pregnancy caution gets the step-down, not a drop', () => {
      const rules = [...RULES, ruleOf({ name: 'clobetasol', kind: 'pregnancy-caution' })]
      const result = floor([product('cream', ['Aqua', 'Clobetasol'])], { pregnant: true, rules })

      expect(entryOf(result, 'cream')).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' } })
    })

    describe('an ingredient the user said they reacted to', () => {
      it('drops any product that holds it, matched through the rules\' aliases both ways', () => {
        const result = floor([product('toner', ['Aqua', 'Parfum']), product('mist', ['Aqua', 'Fragrance']), product('gel', ['Aqua'])], { mentions: [reactedToIngredient('fragrance')] })

        expect(entryOf(result, 'toner')).toEqual({
          id: 'toner',
          status: 'fixed',
          group: 'conflicting',
          verdict: { kind: 'drop' },
          escalate: false,
          facts: [{ kind: 'reaction-ingredient', ingredient: 'Parfum', named: 'fragrance' }],
        })
        expect(entryOf(result, 'mist')).toMatchObject({ group: 'conflicting', verdict: { kind: 'drop' } })
        expect(entryOf(result, 'gel')).toEqual(OPEN('gel'))
      })

      it('matches the name whole, so "alcohol" does not name "Alcohol Denat."', () => {
        const result = floor([product('toner', ['Aqua', 'Alcohol Denat.'])], { mentions: [reactedToIngredient('alcohol')] })

        expect(entryOf(result, 'toner')).toEqual(OPEN('toner'))
      })

      it('matches a name no rule lists exactly as written', () => {
        const result = floor([product('balm', ['Aqua', 'ZZYZX WAX']), product('oil', ['Aqua', 'Zzyzx Waxes'])], { mentions: [reactedToIngredient('Zzyzx Wax')] })

        expect(entryOf(result, 'balm')).toMatchObject({ group: 'conflicting', verdict: { kind: 'drop' } })
        expect(entryOf(result, 'oil')).toEqual(OPEN('oil'))
      })

      it('is beaten by likely the problem: a steroid in the product gets the step-down, not a drop', () => {
        const rules = [...RULES, ruleOf({ name: 'clobetasol', kind: 'allergen' })]
        const result = floor([product('cream', ['Aqua', 'Clobetasol'])], { rules, mentions: [reactedToIngredient('clobetasol')] })

        expect(entryOf(result, 'cream')).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' } })
      })

      it('is beaten by a prescription for the product: kept', () => {
        const result = floor([product('toner', ['Aqua', 'Parfum'])], { mentions: [reactedToIngredient('fragrance'), prescribed('prod-toner')] })

        expect(entryOf(result, 'toner')).toMatchObject({ group: 'prescribed', verdict: { kind: 'keep' } })
      })

      it('adds to a pregnancy caution: one drop that carries both facts', () => {
        const result = floor([product('serum', ['Aqua', 'Retinol', 'Parfum'])], { pregnant: true, mentions: [reactedToIngredient('fragrance')] })

        expect(entryOf(result, 'serum')).toEqual({
          id: 'serum',
          status: 'fixed',
          group: 'conflicting',
          verdict: { kind: 'drop' },
          escalate: false,
          facts: [
            { kind: 'pregnancy-caution', ingredient: 'Retinol' },
            { kind: 'reaction-ingredient', ingredient: 'Parfum', named: 'fragrance' },
          ],
        })
      })

      it('gives one fact for an ingredient the user named twice', () => {
        const result = floor([product('toner', ['Aqua', 'Parfum'])], { mentions: [reactedToIngredient('fragrance'), reactedToIngredient('parfum')] })

        expect(entryOf(result, 'toner')).toMatchObject({ facts: [{ kind: 'reaction-ingredient', ingredient: 'Parfum', named: 'fragrance' }] })
      })

      it('is not made by an ingredient the user was prescribed, which they want to use', () => {
        const result = floor([product('toner', ['Aqua', 'Parfum'])], { mentions: [mention({ source: 'prescription', kind: 'ingredient', name: 'fragrance' })] })

        expect(entryOf(result, 'toner')).toEqual(OPEN('toner'))
      })
    })
  })

  describe("can't tell what's in it", () => {
    it.each(['moisturise', 'treat-spots', 'not-sure'] as const)('sets aside a no-label entry described as "%s": it is dropped with a reason about unknown contents', (purpose) => {
      const result = floor([noLabel('tub', purpose)])

      expect(entryOf(result, 'tub')).toEqual({
        id: 'tub',
        status: 'fixed',
        group: 'cant-tell',
        verdict: { kind: 'drop' },
        escalate: false,
        facts: [{ kind: 'unknown-contents' }],
      })
    })
  })

  describe('a product with an empty ingredient list', () => {
    it('is set aside like an unknown product rather than left open: nothing is known, so nothing is guessed', () => {
      const result = floor([product('mystery', [])])

      expect(entryOf(result, 'mystery')).toEqual({
        id: 'mystery',
        status: 'fixed',
        group: 'cant-tell',
        verdict: { kind: 'drop' },
        escalate: false,
        facts: [{ kind: 'unknown-contents' }],
      })
    })

    it('takes no part in a clash', () => {
      expect(floor([product('mystery', []), product('serum', ['Retinol'])]).clashes).toEqual([])
    })

    it('still yields to a stricter label: a lightening claim in its name gets the step-down, and a prescription keeps it', () => {
      const claim = floor([product('cream', [], { name: 'Whitening Cream' })])
      const kept = floor([product('cream', [])], { mentions: [prescribed('prod-cream')] })

      expect(entryOf(claim, 'cream')).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' } })
      expect(entryOf(kept, 'cream')).toMatchObject({ group: 'prescribed', verdict: { kind: 'keep' } })
    })
  })

  describe('a prescribed product', () => {
    it('is always kept, even when it holds a steroid, and is not stopped or escalated', () => {
      const result = floor([product('cream', ['Aqua', 'Clobetasol Propionate'])], { mentions: [prescribed('prod-cream')] })

      expect(entryOf(result, 'cream')).toEqual({
        id: 'cream',
        status: 'fixed',
        group: 'prescribed',
        verdict: { kind: 'keep' },
        escalate: false,
        facts: [{ kind: 'prescription' }],
      })
    })

    it('is matched by a list that reads the same as its own, under another product id', () => {
      const result = floor([product('cream', ['Aqua', 'Clobetasol'])], { mentions: [prescribed('prod-elsewhere', ['aqua', 'CLOBETASOL'])] })

      expect(entryOf(result, 'cream')).toMatchObject({ group: 'prescribed', verdict: { kind: 'keep' } })
    })

    it('is not matched by a different list under a different product id', () => {
      const result = floor([product('cream', ['Aqua', 'Clobetasol'])], { mentions: [prescribed('prod-elsewhere', ['Aqua', 'Clobetasol', 'Glycerin'])] })

      expect(entryOf(result, 'cream')).toMatchObject({ group: 'likely-the-problem' })
    })

    it('overrides every other label: a pregnancy caution, a lightening claim, a mercury compound and a reaction mention of the same product', () => {
      const result = floor(
        [
          product('retinoid', ['Retinol']),
          product('claim', ['Aqua'], { name: 'Whitening Lotion' }),
          product('mercury', ['Mercury']),
          product('reacted', ['Aqua', 'Glycerin']),
        ],
        { pregnant: true, mentions: [prescribed('prod-retinoid'), prescribed('prod-claim'), prescribed('prod-mercury'), prescribed('prod-reacted'), reactedTo('prod-reacted')] },
      )

      for (const id of ['retinoid', 'claim', 'mercury', 'reacted']) {
        expect(entryOf(result, id)).toMatchObject({ status: 'fixed', group: 'prescribed', verdict: { kind: 'keep' }, escalate: false })
      }
    })

    it('does not make a product prescribed because it holds an ingredient the user was prescribed', () => {
      const result = floor([product('cream', ['Aqua', 'Clobetasol'])], { mentions: [mention({ source: 'prescription', kind: 'ingredient', name: 'clobetasol' })] })

      expect(entryOf(result, 'cream')).toMatchObject({ group: 'likely-the-problem' })
    })
  })

  describe('products that clash', () => {
    const retinoid = (id: string) => product(id, ['Aqua', 'Retinol'])
    const acid = (id: string) => product(id, ['Aqua', 'Glycolic Acid'])
    const peroxide = (id: string) => product(id, ['Aqua', 'Benzoyl Peroxide 5%'])

    it('reports a retinoid and an exfoliating acid as a pair, leaves both open, and falls back to reducing the acid to alternate days', () => {
      const result = floor([retinoid('serum'), acid('toner')])

      expect(result.entries).toEqual([OPEN('serum'), OPEN('toner')])
      expect(result.clashes).toEqual([{ ids: ['serum', 'toner'], groups: ['retinoid', 'exfoliating-acid'], fallbackReduceId: 'toner', maxFrequency: 'alternate-days' }])
    })

    it('reduces the acid over the retinoid whichever comes first on the shelf', () => {
      const result = floor([acid('toner'), retinoid('serum')])

      expect(result.clashes).toEqual([{ ids: ['toner', 'serum'], groups: ['exfoliating-acid', 'retinoid'], fallbackReduceId: 'toner', maxFrequency: 'alternate-days' }])
    })

    it('reduces benzoyl peroxide over a retinoid', () => {
      const result = floor([peroxide('spot'), retinoid('serum')])

      expect(result.clashes).toEqual([{ ids: ['spot', 'serum'], groups: ['benzoyl-peroxide', 'retinoid'], fallbackReduceId: 'spot', maxFrequency: 'alternate-days' }])
    })

    it('breaks a tie between an acid and benzoyl peroxide by shelf order: the one that comes first on the shelf is reduced', () => {
      expect(floor([acid('toner'), peroxide('spot')]).clashes).toEqual([
        { ids: ['toner', 'spot'], groups: ['exfoliating-acid', 'benzoyl-peroxide'], fallbackReduceId: 'toner', maxFrequency: 'alternate-days' },
      ])
      expect(floor([peroxide('spot'), acid('toner')]).clashes).toEqual([
        { ids: ['spot', 'toner'], groups: ['benzoyl-peroxide', 'exfoliating-acid'], fallbackReduceId: 'spot', maxFrequency: 'alternate-days' },
      ])
    })

    it('pairs groups that only one side lists: the clash is read in both directions', () => {
      const oneSided = RULES.map((rule) => ({ ...rule, clashesWith: rule.name === 'retinol' ? ['exfoliating-acid' as const] : [] }))

      const result = floor([retinoid('serum'), acid('toner')], { rules: oneSided })

      expect(result.clashes).toEqual([{ ids: ['serum', 'toner'], groups: ['retinoid', 'exfoliating-acid'], fallbackReduceId: 'toner', maxFrequency: 'alternate-days' }])
    })

    it('leaves a product that is taper-missing out of every pair: it is already out', () => {
      const result = floor([retinoid('serum'), product('peel', ['Glycolic Acid', 'Clobetasol'])], { tapers: {} })

      expect(entryOf(result, 'peel')).toMatchObject({ status: 'taper-missing' })
      expect(result.clashes).toEqual([])
    })

    it('reports one pair for two products however many clashing ingredients they hold', () => {
      const result = floor([product('serum', ['Retinol', 'Retinal']), product('peel', ['Glycolic Acid', 'Lactic Acid'])])

      expect(result.clashes).toHaveLength(1)
      expect(result.clashes[0]).toMatchObject({ ids: ['serum', 'peel'], fallbackReduceId: 'peel' })
    })

    it('reports every clashing pair on a shelf, in shelf order', () => {
      const result = floor([retinoid('serum'), acid('toner'), peroxide('spot')])

      expect(result.clashes.map((pair) => pair.ids)).toEqual([
        ['serum', 'toner'],
        ['serum', 'spot'],
        ['toner', 'spot'],
      ])
    })

    it('reports no pair when the rules list no clash between the groups, or when two products share a group', () => {
      const noClashes = RULES.map((rule) => ({ ...rule, clashesWith: [] }))

      expect(floor([retinoid('serum'), acid('toner')], { rules: noClashes }).clashes).toEqual([])
      expect(floor([retinoid('one'), product('two', ['Retinal'])]).clashes).toEqual([])
    })

    it('leaves a product that is likely the problem out of every pair: it is already out', () => {
      const bleachingPeel = product('peel', ['Glycolic Acid', 'Hydroquinone'])

      const result = floor([retinoid('serum'), bleachingPeel])

      expect(entryOf(result, 'peel')).toMatchObject({ group: 'likely-the-problem' })
      expect(entryOf(result, 'serum')).toEqual(OPEN('serum'))
      expect(result.clashes).toEqual([])
    })

    it('leaves a product dropped for pregnancy out of every pair: there is nothing left to reduce', () => {
      const result = floor([retinoid('serum'), acid('toner')], { pregnant: true })

      expect(entryOf(result, 'serum')).toMatchObject({ group: 'conflicting', verdict: { kind: 'drop' } })
      expect(entryOf(result, 'toner')).toEqual(OPEN('toner'))
      expect(result.clashes).toEqual([])
    })

    it('still reports the pair for a prescribed product, but never falls back to reducing it', () => {
      const result = floor([retinoid('serum'), acid('toner')], { mentions: [prescribed('prod-toner')] })

      expect(entryOf(result, 'toner')).toMatchObject({ group: 'prescribed', verdict: { kind: 'keep' } })
      expect(result.clashes).toEqual([{ ids: ['serum', 'toner'], groups: ['retinoid', 'exfoliating-acid'], fallbackReduceId: 'serum', maxFrequency: 'alternate-days' }])
    })

    it('reports no pair when both products are prescribed: neither can be reduced', () => {
      const result = floor([retinoid('serum'), acid('toner')], { mentions: [prescribed('prod-serum'), prescribed('prod-toner')] })

      expect(result.clashes).toEqual([])
    })
  })

  describe('what is on the shelf', () => {
    it.each(['hair', 'body', 'makeup', 'other'] as const)('leaves a %s item out of the answer altogether, whatever it holds (non-skin items are ignored for now)', (category) => {
      const result = floor([product('keep-me', ['Aqua']), product('ignored', ['Mercury'], { category }), noLabel('ignored-tub', 'lighten', category)])

      expect(result).toEqual({ entries: [OPEN('keep-me')], clashes: [] })
    })

    it('does not let an ignored item take part in a clash', () => {
      const result = floor([product('hair-oil', ['Retinol'], { category: 'hair' }), product('toner', ['Glycolic Acid'])])

      expect(result.clashes).toEqual([])
    })

    it('gives an empty answer for an empty shelf', () => {
      expect(floor([])).toEqual({ entries: [], clashes: [] })
    })
  })

  describe('determinism', () => {
    const SHELF = [product('toner', ['Glycolic Acid']), noLabel('tub', 'moisturise'), product('cream', ['Mercury']), product('serum', ['Retinol']), product('gel', ['Aqua'])]

    it('gives the same answer for the same input, and does not change the input', () => {
      const once = floor(SHELF, { pregnant: true })
      const again = floorVerdicts(structuredClone(inputOf(SHELF, { pregnant: true })))

      expect(again).toEqual(once)
    })

    it('answers in shelf order, however strict a later entry is', () => {
      expect(floor(SHELF).entries.map((entry) => entry.id)).toEqual(['toner', 'tub', 'cream', 'serum', 'gel'])
      expect(floor([...SHELF].reverse()).entries.map((entry) => entry.id)).toEqual(['gel', 'serum', 'cream', 'tub', 'toner'])
    })
  })
})
