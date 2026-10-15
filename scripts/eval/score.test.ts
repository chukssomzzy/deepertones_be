import { describe, expect, it } from 'vitest'
import type { DraftConcernRow } from '../../src/modules/catalog/catalog.types'
import type { ResearchResult } from '../../src/providers/product-research/product-researcher.provider'
import type { AnalysisCase, ResearchCase } from './cases'
import { loadEnv, parseArgs, scoreAnalysis, scoreResearch, summarise } from './score'

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

  it.each(['analysis', 'research', 'all'] as const)('accepts --mode %s', (mode) => {
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

  it.each(['research', 'analysis', 'same-product', 'image-check', 'recognize', 'read-label'])('reads --model %s=<model> as an override for that job', (job) => {
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
