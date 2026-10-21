import { describe, expect, it } from 'vitest'
import type { DraftConcernRow } from '../../src/modules/catalog/catalog.types'
import type { ResearchResult } from '../../src/providers/product-research/product-researcher.provider'
import type { Mention } from '../../src/providers/mention-reading/mention-reader.provider'
import type { AnalysisCase, GoalCase, MentionCase, ResearchCase } from './cases'
import { loadEnv, parseArgs, scoreAnalysis, scoreGoalReading, scoreMentions, scoreResearch, summarise } from './score'

const PRODUCT = { brand: 'Test Brand', name: 'Test Cream', category: 'skin' } as const

const analysisCase = (expectation: AnalysisCase['expect'], id = 'case-1'): AnalysisCase => ({
  id,
  product: PRODUCT,
  ingredients: ['Aqua', 'Hydroquinone', 'Parfum'],
  expect: expectation,
})

const stored = (overrides: Partial<DraftConcernRow> = {}): DraftConcernRow => ({
  kind: 'banned-substance',
  severity: 'high',
  ingredients: ['Hydroquinone'],
  why: 'Not permitted in cosmetic skin products.',
  whoShouldTakeCare: 'Everyone.',
  traits: [],
  sources: [],
  ...overrides,
})

describe('scoreAnalysis', () => {
  const banned = analysisCase({ flagged: [{ kind: 'banned-substance', ingredient: 'Hydroquinone' }] })

  it('passes when a stored concern of the expected kind lists the expected ingredient', () => {
    expect(scoreAnalysis(banned, { stored: [stored()] })).toEqual({ id: 'case-1', pass: true, problems: [] })
  })

  it('passes a clean case when the analysis is stored with no concerns', () => {
    const clean = analysisCase({ flagged: [] }, 'clean')

    expect(scoreAnalysis(clean, { stored: [] })).toEqual({ id: 'clean', pass: true, problems: [] })
  })

  it('fails with the refusal code when the analysis was rejected', () => {
    expect(scoreAnalysis(banned, { rejected: 'UNCOVERED_FLAGGED_FACT' })).toEqual({
      id: 'case-1',
      pass: false,
      problems: ['rejected:UNCOVERED_FLAGGED_FACT'],
    })
  })

  it('fails with the error name when the adapter threw', () => {
    expect(scoreAnalysis(banned, { error: 'AnthropicUnavailableError' })).toEqual({
      id: 'case-1',
      pass: false,
      problems: ['error:AnthropicUnavailableError'],
    })
  })

  it('reports a missing fact when no stored concern has the expected kind', () => {
    const result = scoreAnalysis(banned, { stored: [stored({ kind: 'irritation', severity: 'medium' })] })

    expect(result.pass).toBe(false)
    expect(result.problems).toEqual(['missing:banned-substance:Hydroquinone'])
  })

  it('reports a missing fact when the concern of the right kind does not list the expected ingredient', () => {
    const result = scoreAnalysis(banned, { stored: [stored({ ingredients: ['Parfum'] })] })

    expect(result.pass).toBe(false)
    expect(result.problems).toEqual(['missing:banned-substance:Hydroquinone'])
  })

  it('reports a missing fact when nothing was stored', () => {
    expect(scoreAnalysis(banned, { stored: [] })).toEqual({ id: 'case-1', pass: false, problems: ['missing:banned-substance:Hydroquinone'] })
  })

  it('reports every uncovered fact, and only those', () => {
    const c = analysisCase({
      flagged: [
        { kind: 'banned-substance', ingredient: 'Hydroquinone' },
        { kind: 'allergen', ingredient: 'Parfum' },
      ],
    })

    const result = scoreAnalysis(c, { stored: [stored({ kind: 'allergen', severity: 'medium', ingredients: ['Parfum'] })] })

    expect(result.pass).toBe(false)
    expect(result.problems).toEqual(['missing:banned-substance:Hydroquinone'])
  })

  it('covers a fact from a concern that lists the ingredient among several', () => {
    const result = scoreAnalysis(banned, { stored: [stored({ ingredients: ['Aqua', 'Hydroquinone'] })] })

    expect(result.pass).toBe(true)
  })

  describe('severityAtLeast', () => {
    const needs = (severity: 'low' | 'medium' | 'high') =>
      analysisCase({
        flagged: [{ kind: 'banned-substance', ingredient: 'Hydroquinone' }],
        severityAtLeast: [{ kind: 'banned-substance', severity }],
      })

    it('passes when the stored severity is exactly the minimum', () => {
      expect(scoreAnalysis(needs('high'), { stored: [stored({ severity: 'high' })] }).pass).toBe(true)
      expect(scoreAnalysis(needs('medium'), { stored: [stored({ severity: 'medium' })] }).pass).toBe(true)
    })

    it('passes when the stored severity is above the minimum', () => {
      expect(scoreAnalysis(needs('low'), { stored: [stored({ severity: 'high' })] }).pass).toBe(true)
      expect(scoreAnalysis(needs('medium'), { stored: [stored({ severity: 'high' })] }).pass).toBe(true)
    })

    it('fails one step below the minimum', () => {
      const result = scoreAnalysis(needs('high'), { stored: [stored({ severity: 'medium' })] })

      expect(result).toEqual({ id: 'case-1', pass: false, problems: ['severity:banned-substance<high'] })
    })

    it('fails when low is stored against a medium minimum', () => {
      const result = scoreAnalysis(needs('medium'), { stored: [stored({ severity: 'low' })] })

      expect(result.pass).toBe(false)
      expect(result.problems).toEqual(['severity:banned-substance<medium'])
    })
  })
})

describe('scoreResearch', () => {
  const expected: ResearchCase = {
    id: 'research-1',
    product: PRODUCT,
    expect: { found: true, ingredientsInclude: ['Glycerin', 'Niacinamide'] },
  }
  const found = (ingredients: string[]): ResearchResult => ({ found: true, ingredients, sourceUrl: 'https://example.com/p' })

  it('passes when found and every expected ingredient is in the list', () => {
    expect(scoreResearch(expected, found(['Aqua', 'Glycerin', 'Niacinamide', 'Zinc PCA']))).toEqual({
      id: 'research-1',
      pass: true,
      problems: [],
      detail: { sourceHost: 'example.com', ingredients: ['Aqua', 'Glycerin', 'Niacinamide', 'Zinc PCA'] },
    })
  })

  describe('detail (for the JSON report only, so a fixture can be checked against what the model returned)', () => {
    it('carries the list exactly as the model returned it, also when the case failed', () => {
      const returned = ['GLYCERIN*', 'Aqua', 'aqua']

      const result = scoreResearch(expected, found(returned))

      expect(result.pass).toBe(false)
      expect(result.detail).toEqual({ sourceHost: 'example.com', ingredients: returned })
    })

    it('carries the host of the source page and nothing more of the URL: no path, query or credentials', () => {
      const outcome: ResearchResult = { found: true, ingredients: ['Glycerin', 'Niacinamide'], sourceUrl: 'https://www.shop.example/p/serum?token=abc123#top' }

      const { detail } = scoreResearch(expected, outcome)

      expect(detail!.sourceHost).toBe('www.shop.example')
      expect(JSON.stringify(detail)).not.toContain('abc123')
      expect(JSON.stringify(detail)).not.toContain('/p/serum')
    })

    it('leaves the host out when the source is not a URL', () => {
      const { detail } = scoreResearch(expected, { found: true, ingredients: ['Glycerin', 'Niacinamide'], sourceUrl: 'not a url' })

      expect(detail).toEqual({ ingredients: ['Glycerin', 'Niacinamide'] })
      expect(detail).not.toHaveProperty('sourceHost')
    })

    it('is absent when nothing was found and when the adapter threw', () => {
      expect(scoreResearch(expected, { found: false })).not.toHaveProperty('detail')
      expect(scoreResearch(expected, { error: 'AnthropicUnavailableError' })).not.toHaveProperty('detail')
    })

    it('is not on an analysis result', () => {
      const result = scoreAnalysis(analysisCase({ flagged: [] }), { stored: [] })

      expect(result).not.toHaveProperty('detail')
    })
  })

  it('compares ingredient names normalised, so case, footnote marks and full stops do not matter', () => {
    expect(scoreResearch(expected, found(['GLYCERIN*', 'niacinamide.'])).pass).toBe(true)
  })

  it('fails with not-found when the product was not found', () => {
    expect(scoreResearch(expected, { found: false })).toEqual({ id: 'research-1', pass: false, problems: ['not-found'] })
  })

  it('names each expected ingredient the list lacks', () => {
    const result = scoreResearch(expected, found(['Aqua', 'Glycerin']))

    expect(result.pass).toBe(false)
    expect(result.problems).toEqual(['missing-ingredient:Niacinamide'])
  })

  it('names every missing ingredient when several are lacking', () => {
    const result = scoreResearch(expected, found(['Aqua']))

    expect([...result.problems].sort()).toEqual(['missing-ingredient:Glycerin', 'missing-ingredient:Niacinamide'])
  })

  it('fails with the error name when the adapter threw', () => {
    expect(scoreResearch(expected, { error: 'AnthropicUnavailableError' })).toEqual({
      id: 'research-1',
      pass: false,
      problems: ['error:AnthropicUnavailableError'],
    })
  })
})

describe('scoreGoalReading', () => {
  const expected = (goal: GoalCase['expect']['goal'], wantsLighter: boolean): GoalCase => ({ id: 'goal-1', text: 'make my face clear', expect: { goal, wantsLighter } })

  it('passes when the goal and wantsLighter are both what the case expects', () => {
    expect(scoreGoalReading(expected('clear-skin', false), { goal: 'clear-skin', wantsLighter: false })).toEqual({ id: 'goal-1', pass: true, problems: [] })
  })

  it('passes a case that expects no goal when the reader found none', () => {
    expect(scoreGoalReading(expected(null, false), { goal: null, wantsLighter: false })).toEqual({ id: 'goal-1', pass: true, problems: [] })
  })

  it('passes a request to be lighter that came back as brighter with wantsLighter', () => {
    expect(scoreGoalReading(expected('brighter', true), { goal: 'brighter', wantsLighter: true }).pass).toBe(true)
  })

  it('fails with the expected and the actual goal when the goal differs, and nothing else', () => {
    expect(scoreGoalReading(expected('clear-skin', false), { goal: 'glow', wantsLighter: false })).toEqual({ id: 'goal-1', pass: false, problems: ['goal:clear-skin-got-glow'] })
  })

  it('names "none" for a goal that was expected and not found, and for one that was found and not expected', () => {
    expect(scoreGoalReading(expected('glow', false), { goal: null, wantsLighter: false }).problems).toEqual(['goal:glow-got-none'])
    expect(scoreGoalReading(expected(null, false), { goal: 'glow', wantsLighter: false }).problems).toEqual(['goal:none-got-glow'])
  })

  it('fails with the expected and the actual wantsLighter when only that differs', () => {
    expect(scoreGoalReading(expected('brighter', true), { goal: 'brighter', wantsLighter: false }).problems).toEqual(['wantsLighter:true-got-false'])
    expect(scoreGoalReading(expected('clear-skin', false), { goal: 'clear-skin', wantsLighter: true }).problems).toEqual(['wantsLighter:false-got-true'])
  })

  it('reports both problems, the goal first, when both differ', () => {
    expect(scoreGoalReading(expected('fade-dark-marks', false), { goal: 'brighter', wantsLighter: true })).toEqual({
      id: 'goal-1',
      pass: false,
      problems: ['goal:fade-dark-marks-got-brighter', 'wantsLighter:false-got-true'],
    })
  })

  it('fails with the error name when the adapter threw', () => {
    expect(scoreGoalReading(expected('glow', false), { error: 'AnthropicUnavailableError' })).toEqual({ id: 'goal-1', pass: false, problems: ['error:AnthropicUnavailableError'] })
  })
})

describe('scoreMentions', () => {
  // The matching, pinned here and described on scoreMentions: a product is found when the words of its brand and name together are the words of the
  // expected ones (case, accents and punctuation ignored, "&" as "and", and the generic words cream, lotion, soap, gel, serum, oil and jelly left out),
  // and it has a brand exactly when the expected one does. An ingredient is found when its name is the expected one with case, accents, punctuation and
  // spacing ignored. Category and variant are not scored. Each mention found is used once.
  const expected = (products: MentionCase['expect']['products'], ingredients: string[] = []): MentionCase => ({ id: 'mention-1', text: 'unused here', expect: { products, ingredients } })
  const product = (brand: string | null, name: string, over: Record<string, unknown> = {}): Mention => ({ kind: 'product', brand, name, category: 'skin', ...over }) as Mention
  const ingredient = (name: string): Mention => ({ kind: 'ingredient', name })
  const read = (...mentions: Mention[]) => ({ mentions })

  const CARO = { brand: 'Caro White', name: 'Caro White' }

  describe('passing', () => {
    it('passes when the reader found exactly the products and ingredients the case expects', () => {
      const c = expected([CARO], ['fragrance'])

      expect(scoreMentions(c, read(product('Caro White', 'Caro White'), ingredient('fragrance')))).toEqual({ id: 'mention-1', pass: true, problems: [] })
    })

    it('passes a case that expects nothing when the reader found nothing', () => {
      expect(scoreMentions(expected([]), read())).toEqual({ id: 'mention-1', pass: true, problems: [] })
    })

    it('does not mind the order the mentions come in', () => {
      const c = expected([CARO, { brand: 'Carotone', name: 'Carotone' }], ['fragrance', 'parabens'])

      const found = read(ingredient('parabens'), product('Carotone', 'Carotone'), ingredient('fragrance'), product('Caro White', 'Caro White'))

      expect(scoreMentions(c, found).pass).toBe(true)
    })

    it('ignores case, accents and punctuation in a product', () => {
      expect(scoreMentions(expected([{ brand: "L'Oréal", name: 'Paris' }]), read(product('LOREAL', 'paris!'))).pass).toBe(true)
    })

    it.each([
      ['the brand and name as typed', 'Caro White', 'Caro White'],
      ['the brand split from the name differently: Caro | White', 'Caro', 'White'],
      ['the whole name as the brand and a repeat as the name', 'Caro White', 'Caro White'],
      ['the whole name as the brand and one of its words as the name', 'Caro White', 'White'],
    ])('finds Caro White when the reader gave %s', (_label, brand, name) => {
      expect(scoreMentions(expected([CARO]), read(product(brand, name))).pass).toBe(true)
    })

    it.each([
      ['Movate cream', { brand: 'Movate', name: 'Movate' }],
      ['Movate cream', { brand: 'Movate', name: 'Movate cream' }],
      ['Movate cream', { brand: 'Movate', name: 'Cream' }],
    ])('does not count the generic word "cream" against a reader that left it out or put it in (%s)', (_label, found) => {
      expect(scoreMentions(expected([{ brand: 'Movate', name: 'Movate cream' }]), read(product(found.brand, found.name))).pass).toBe(true)
    })

    it.each([
      ['Dove soap', 'Dove', 'Dove'],
      ['Dove soap', 'Dove', 'soap'],
      ['Skin Light cream', 'Skin Light', 'Skin Light'],
    ])('does not count the generic words soap and cream either: %s', (name, brand, found) => {
      expect(scoreMentions(expected([{ brand, name }]), read(product(brand, found))).pass).toBe(true)
    })

    it('reads "&" as "and"', () => {
      expect(scoreMentions(expected([{ brand: 'Fair and White', name: 'Fair and White' }]), read(product('Fair & White', 'Fair & White'))).pass).toBe(true)
    })

    it('does not score the category or the variant', () => {
      const found = product('Caro White', 'Caro White', { category: null, variant: 'Extra' })

      expect(scoreMentions(expected([CARO]), read(found)).pass).toBe(true)
    })

    it('ignores case and spacing in an ingredient: "Shea  Butter" and "sheabutter" are "shea butter"', () => {
      expect(scoreMentions(expected([], ['shea butter']), read(ingredient('Shea  Butter'))).pass).toBe(true)
      expect(scoreMentions(expected([], ['shea butter']), read(ingredient('sheabutter'))).pass).toBe(true)
    })

    it('lets the reader give a product with no brand beside the ones expected: it cannot reach the catalog, so it does no harm', () => {
      expect(scoreMentions(expected([]), read(product(null, 'white tub'))).pass).toBe(true)
      expect(scoreMentions(expected([CARO]), read(product('Caro White', 'Caro White'), product(null, 'toning cream'))).pass).toBe(true)
    })
  })

  describe('a product the case expects with no brand', () => {
    const brandless = expected([{ brand: null, name: 'white tub' }])

    it('is found only as a product with no brand', () => {
      expect(scoreMentions(brandless, read(product(null, 'White Tub'))).pass).toBe(true)
      expect(scoreMentions(brandless, read(product('White', 'tub'))).problems).toEqual(['missing-product:white tub', 'extra-products:1'])
    })
  })

  describe('failing', () => {
    it('names the product that was not found, by the case\'s own name for it, and counts the one that was found instead', () => {
      expect(scoreMentions(expected([CARO]), read(product('Carotone', 'Carotone')))).toEqual({
        id: 'mention-1',
        pass: false,
        problems: ['missing-product:Caro White', 'extra-products:1'],
      })
    })

    it('fails a product the reader found without the brand the case expects, since that product could never be looked up', () => {
      expect(scoreMentions(expected([{ brand: 'Movate', name: 'Movate cream' }]), read(product(null, 'Movate cream'))).problems).toEqual(['missing-product:Movate cream'])
    })

    it('names the ingredient that was not found', () => {
      expect(scoreMentions(expected([], ['lanolin', 'fragrance']), read(ingredient('lanolin'))).problems).toEqual(['missing-ingredient:fragrance'])
    })

    it('fails a product with a word more or fewer than the case expects, beyond the generic words', () => {
      expect(scoreMentions(expected([CARO]), read(product('Caro White', 'Caro White Facial'))).pass).toBe(false)
      expect(scoreMentions(expected([CARO]), read(product('Caro', 'Caro'))).pass).toBe(false)
    })

    it('fails an ingredient the case did not expect, and counts it without naming it: a reader that lists ingredients from memory is the failure that matters', () => {
      const result = scoreMentions(expected([{ brand: 'Dove', name: 'Dove soap' }]), read(product('Dove', 'Dove soap'), ingredient('stearic acid'), ingredient('sodium cocoate')))

      expect(result).toEqual({ id: 'mention-1', pass: false, problems: ['extra-ingredients:2'] })
    })

    it('fails a product with a brand that the case did not expect, and counts it', () => {
      expect(scoreMentions(expected([]), read(product('Nivea', 'Creme'))).problems).toEqual(['extra-products:1'])
    })

    it('does not match an ingredient in a different form: "fragrances" is not "fragrance"', () => {
      expect(scoreMentions(expected([], ['fragrance']), read(ingredient('fragrances'))).problems).toEqual(['missing-ingredient:fragrance', 'extra-ingredients:1'])
    })

    it('uses each mention once: the same ingredient twice is one found and one extra', () => {
      expect(scoreMentions(expected([], ['fragrance']), read(ingredient('fragrance'), ingredient('Fragrance'))).problems).toEqual(['extra-ingredients:1'])
    })

    it('uses each mention once: the same product twice is one found and one extra', () => {
      expect(scoreMentions(expected([CARO]), read(product('Caro White', 'Caro White'), product('Caro White', 'Caro White'))).problems).toEqual(['extra-products:1'])
    })

    it('does not take a product for an ingredient, or the other way round', () => {
      expect(scoreMentions(expected([CARO]), read(ingredient('Caro White'))).problems).toEqual(['missing-product:Caro White', 'extra-ingredients:1'])
      expect(scoreMentions(expected([], ['fragrance']), read(product('fragrance', 'fragrance'))).problems).toEqual(['missing-ingredient:fragrance', 'extra-products:1'])
    })

    it('reports missing products, then missing ingredients, then extra products, then extra ingredients, and in the case\'s order within each', () => {
      const c = expected([CARO, { brand: 'Movate', name: 'Movate' }], ['fragrance', 'parabens'])

      const result = scoreMentions(c, read(product('Nivea', 'Creme'), ingredient('lanolin')))

      expect(result.problems).toEqual(['missing-product:Caro White', 'missing-product:Movate', 'missing-ingredient:fragrance', 'missing-ingredient:parabens', 'extra-products:1', 'extra-ingredients:1'])
    })

    it('fails a case that expects nothing when the reader found something', () => {
      expect(scoreMentions(expected([]), read(ingredient('fragrance'))).problems).toEqual(['extra-ingredients:1'])
    })

    it('never puts a word the model wrote into a problem', () => {
      const result = scoreMentions(expected([]), read(product('Sekret Brand', 'Sekret Cream'), ingredient('sekret acid')))

      expect(JSON.stringify(result)).not.toMatch(/sekret/i)
    })
  })

  it('fails with the error name when the adapter threw', () => {
    expect(scoreMentions(expected([CARO]), { error: 'AnthropicUnavailableError' })).toEqual({ id: 'mention-1', pass: false, problems: ['error:AnthropicUnavailableError'] })
  })
})

describe('summarise', () => {
  const result = (pass: boolean) => ({ id: 'x', pass, problems: pass ? [] : ['p'] })

  it('counts passes and failures and gives the pass rate as a fraction', () => {
    expect(summarise([result(true), result(true), result(true), result(false)])).toEqual({ total: 4, passed: 3, failed: 1, passRate: 0.75, costMicros: 0 })
  })

  it('gives a pass rate of 1 when everything passes', () => {
    expect(summarise([result(true), result(true)])).toEqual({ total: 2, passed: 2, failed: 0, passRate: 1, costMicros: 0 })
  })

  it('gives a pass rate of 0 when nothing passes', () => {
    expect(summarise([result(false)])).toEqual({ total: 1, passed: 0, failed: 1, passRate: 0, costMicros: 0 })
  })

  it('gives a pass rate of 0, not NaN, for no results', () => {
    expect(summarise([])).toEqual({ total: 0, passed: 0, failed: 0, passRate: 0, costMicros: 0 })
  })

  it('adds up the cost of every result, in micro-USD, whether the case passed or failed', () => {
    const results = [{ ...result(true), costMicros: 1500 }, { ...result(false), costMicros: 2_250_000 }, { ...result(true), costMicros: 7 }]

    expect(summarise(results).costMicros).toBe(2_251_507)
  })

  it('counts a result with no cost recorded as free, so a case that never reached the model adds nothing', () => {
    expect(summarise([{ ...result(true), costMicros: 400 }, result(false)]).costMicros).toBe(400)
  })
})

describe('parseArgs', () => {
  it('defaults to every mode with no limit, a 2 dollar spend cap and no model overrides', () => {
    const args = parseArgs([])

    expect(args.mode).toBe('all')
    expect(args.limit).toBeUndefined()
    expect(args.maxUsd).toBe(2)
    expect(args.models).toEqual({})
  })

  it.each(['analysis', 'research', 'goals', 'mentions', 'all'] as const)('accepts --mode %s', (mode) => {
    expect(parseArgs(['--mode', mode]).mode).toBe(mode)
  })

  it('reads --limit as a number', () => {
    expect(parseArgs(['--limit', '3']).limit).toBe(3)
  })

  it('accepts a limit of exactly 1', () => {
    expect(parseArgs(['--limit', '1']).limit).toBe(1)
  })

  it.each([
    [['--max-usd', '5'], 5],
    [['--max-usd', '0.25'], 0.25],
    [['--max-usd=3'], 3],
  ])('reads %j as a spend cap of %d dollars', (argv, expected) => {
    expect(parseArgs(argv as string[]).maxUsd).toBe(expected)
  })

  it.each(['research', 'analysis', 'same-product', 'image-check', 'recognize', 'recognize-shelf', 'recognize-shelf-product', 'read-label', 'split-name', 'read-goal', 'read-mentions'])('reads --model %s=<model> as an override for that job', (job) => {
    expect(parseArgs(['--model', `${job}=claude-haiku-5-5`]).models).toEqual({ [job]: 'claude-haiku-5-5' })
  })

  it('collects a repeated --model into one override per job', () => {
    expect(parseArgs(['--model', 'research=claude-opus-5-5', '--model=analysis=claude-haiku-5-5']).models).toEqual({
      research: 'claude-opus-5-5',
      analysis: 'claude-haiku-5-5',
    })
  })

  it('reads all flags together, in any order', () => {
    expect(parseArgs(['--model', 'research=claude-test', '--max-usd', '0.5', '--limit', '2', '--mode', 'research'])).toEqual({
      mode: 'research',
      limit: 2,
      maxUsd: 0.5,
      models: { research: 'claude-test' },
    })
  })

  it.each([
    ['an unknown flag', ['--verbose']],
    ['a bare word', ['research']],
    ['an unknown mode', ['--mode', 'everything']],
    ['--mode without a value', ['--mode']],
    ['--limit without a value', ['--limit']],
    ['--model without a value', ['--model']],
    ['--model followed by a flag', ['--model', '--limit', '2']],
    ['--model with no job (the old single-model form)', ['--model', 'claude-haiku-5-5']],
    ['--model for a job that does not exist', ['--model', 'bogus=claude-haiku-5-5']],
    ['--model with an empty model', ['--model', 'research=']],
    ['--model with an empty job', ['--model', '=claude-haiku-5-5']],
    ['one bad --model among good ones', ['--model', 'research=claude-haiku-5-5', '--model', 'bogus=x']],
    ['--max-usd without a value', ['--max-usd']],
    ['a spend cap of 0', ['--max-usd', '0']],
    ['a negative spend cap', ['--max-usd', '-1']],
    ['a non-numeric spend cap', ['--max-usd', 'abc']],
    ['a spend cap that is not finite', ['--max-usd', 'Infinity']],
    ['a limit of 0', ['--limit', '0']],
    ['a negative limit', ['--limit', '-1']],
    ['a fractional limit', ['--limit', '1.5']],
    ['a non-numeric limit', ['--limit', 'abc']],
  ])('throws for %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow()
  })
})

describe('loadEnv', () => {
  const ENOENT = () => Object.assign(new Error("ENOENT: no such file or directory, open '.dev.vars'"), { code: 'ENOENT' })
  const noFile = () => {
    throw ENOENT()
  }
  const fileOf = (contents: string) => () => contents
  const load = async (input: Parameters<typeof loadEnv>[0]) => loadEnv(input)

  it('uses the key from the environment without needing a file', async () => {
    const result = await load({ env: { ANTHROPIC_API_KEY: 'env-key' }, readFile: noFile })

    expect(result).toEqual({ apiKey: 'env-key' })
  })

  it('prefers the environment key over the one in .dev.vars', async () => {
    const result = await load({ env: { ANTHROPIC_API_KEY: 'env-key' }, readFile: fileOf('ANTHROPIC_API_KEY=file-key\n') })

    expect(result.apiKey).toBe('env-key')
  })

  it('reads the key from .dev.vars when the environment has none', async () => {
    const reads: string[] = []
    const readFile = (path: string) => {
      reads.push(path)
      return 'OTP_PEPPER=x\nANTHROPIC_API_KEY=file-key\n'
    }

    const result = await load({ env: {}, readFile })

    expect(result).toEqual({ apiKey: 'file-key' })
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((p) => p.endsWith('.dev.vars'))).toBe(true)
  })

  it('returns the key only: models are chosen per job (wrangler.jsonc defaults, --model JOB=MODEL), so no model is read from the environment or .dev.vars', async () => {
    const result = await load({
      env: { ANTHROPIC_API_KEY: 'env-key', ANTHROPIC_MODEL: 'env-model' },
      readFile: fileOf('ANTHROPIC_MODEL=file-model\n'),
    })

    expect(result).toEqual({ apiKey: 'env-key' })
  })

  it('treats a missing .dev.vars as no file, and then names the missing key', async () => {
    await expect(load({ env: {}, readFile: noFile })).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  it('throws naming ANTHROPIC_API_KEY when the file has no key, without printing any value from it', async () => {
    const readFile = fileOf('OTP_PEPPER=pepper-value-123\nANTHROPIC_MODEL=model-value-456\nJWT_SECRET=jwt-value-789\n')

    const error = await load({ env: { ANTHROPIC_MODEL: 'env-model-value-000' }, readFile }).then(
      () => undefined,
      (e: unknown) => e,
    )

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('ANTHROPIC_API_KEY')
    for (const secret of ['pepper-value-123', 'model-value-456', 'jwt-value-789', 'env-model-value-000']) {
      expect(message).not.toContain(secret)
    }
  })
})
