import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import { type AiJob, AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import { BIG_CAP_MICROS } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import type { CatalogDrafter, DraftRequest, DraftResult } from '../../src/providers/catalog-drafting/catalog-drafter.provider'
import type { ProductIdentity, ProductResearcher, ResearchResult } from '../../src/providers/product-research/product-researcher.provider'
import type { DraftCase } from './draft-cases'
import { type DraftJudge, type JudgeRequest, unverifiable } from './draft-judge'
import { defaultOutDir, runDraftEval } from './draft-run'
import type { Verdict } from './draft-score'
import type { HumanCheck } from './draft-human-checks'
import type { DraftSet } from './score'

// The orchestration of `npm run eval:catalog -- --mode draft`, with the researcher, the drafter and the judge faked and the ledger real (a
// MemoryAiSpendLedger, as in the script): one workbook built from the cases, every case drafted through the real draftWorkbook, every drafted value
// judged once, the scores and the gate, the console lines, and the files written. Nothing here calls the API or touches the disk.

/** The one day every date in this file hangs from. */
const BASE = new Date('2030-06-15T00:00:00.000Z')
const JUDGE_JOB = 'judge-draft' as AiJob
const DRAFT_JOB: AiJob = 'draft-catalog-row'

// Text that must never reach the console: a page's path and query, and the message of an error.
const URL_SENTINEL = 'SENTINEL-URL-PATH'
const ERROR_SENTINEL = 'SENTINEL-ERROR-MESSAGE'

// --- cases -------------------------------------------------------------------------------------------------------------------------------------

const ORDINARY: DraftCase = {
  id: 'cerave-hydrating-cleanser',
  kind: 'ordinary',
  product: { brand: 'CeraVe', name: 'Hydrating Cleanser', variant: 'Normal to Dry Skin', form: 'liquid', category: 'skin' },
  countries: ['NG', 'GB'],
}
const SIBLING: DraftCase = {
  id: 'cerave-foaming-cleanser',
  kind: 'trap-sibling',
  product: { brand: 'CeraVe', name: 'Foaming Cleanser', category: 'skin' },
  countries: ['NG', 'GB'],
}
const FOREIGN: DraftCase = {
  id: 'us-only-sunscreen',
  kind: 'trap-foreign-currency',
  product: { brand: 'Neutrogena', name: 'Ultra Sheer Sunscreen', form: 'lotion', category: 'skin' },
  countries: ['NG', 'GB'],
  expected: { soldIn: { NG: false, GB: true } },
}
const UNBRANDED: DraftCase = {
  id: 'unbranded-shea-butter',
  kind: 'trap-unbranded',
  product: { brand: 'Unbranded', name: 'Raw Shea Butter', category: 'body' },
  countries: ['NG'],
}
const CASES = [ORDINARY, SIBLING, FOREIGN, UNBRANDED]

// --- fakes -------------------------------------------------------------------------------------------------------------------------------------

const CELL_PAGE = (column: string) => `https://www.derm.example/${column}/${URL_SENTINEL}?q=${URL_SENTINEL}`
const PRICE_PAGE = (country: string) => `https://shop.example/${country}/${URL_SENTINEL}`
const INGREDIENT_PAGE = `https://brand.example/ingredients/${URL_SENTINEL}`

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 }
/** One call's cost, on the real ledger path: reserve, then settle. Throws AiBudgetExceededError when the cap would be passed. */
const spend = async (ledger: MemoryAiSpendLedger, job: AiJob, micros: number) => {
  if (micros === 0) return
  const id = await ledger.reserve({ job, model: 'fake-model', estimateMicros: micros })
  await ledger.settle(id, { usage: ZERO_USAGE, costMicros: micros })
}

/** Answers every ordinary product in full; the unbranded one gets nothing; the foreign-currency one only a GB price. */
const answerFor = (request: DraftRequest): DraftResult => {
  if (request.product.brand === 'Unbranded') return { cells: {}, availability: [] }
  const countries = request.product.brand === 'Neutrogena' ? request.countries.filter((c) => c.code === 'GB') : request.countries
  return {
    cells: {
      skin_concerns: { value: ['hd_acne'], sourceUrl: CELL_PAGE('skin_concerns') },
      skin_types: { value: ['oily'], sourceUrl: CELL_PAGE('skin_types') },
      steps: { value: ['cleanse'], sourceUrl: CELL_PAGE('steps') },
      frequency: { value: 'am-pm', sourceUrl: CELL_PAGE('frequency') },
    },
    availability: countries.map(({ code }) => ({ country: code, priceMin: 4000, priceMax: 6500, whereSold: 'Pharmacies', sourceUrl: PRICE_PAGE(code) })),
  }
}

class FakeDrafter implements CatalogDrafter {
  readonly requests: DraftRequest[] = []
  answer: (request: DraftRequest) => DraftResult = answerFor
  /** Throw this instead of answering, for the requests it returns an error for. */
  failure: (request: DraftRequest) => Error | undefined = () => undefined
  constructor(
    private readonly ledger: MemoryAiSpendLedger,
    private readonly microsPerCall = 0,
  ) {}
  async draft(request: DraftRequest): Promise<DraftResult> {
    this.requests.push(request)
    await spend(this.ledger, DRAFT_JOB, this.microsPerCall)
    const failure = this.failure(request)
    if (failure) throw failure
    return this.answer(request)
  }
}

class FakeResearcher implements ProductResearcher {
  readonly products: ProductIdentity[] = []
  /** Throw this instead of answering, for the products it returns an error for. */
  failure: (product: ProductIdentity) => Error | undefined = () => undefined
  async research(product: ProductIdentity): Promise<ResearchResult> {
    this.products.push(product)
    const failure = this.failure(product)
    if (failure) throw failure
    return product.brand === 'Unbranded' ? { found: false } : { found: true, ingredients: ['Aqua', 'Glycerin'], sourceUrl: INGREDIENT_PAGE }
  }
}

const GROUNDED: Verdict = { fetched: true, exactProduct: 'yes', supports: 'yes', currencyShown: null }

class FakeJudge implements DraftJudge {
  readonly requests: JudgeRequest[] = []
  /** What it says about a value; by default the page backs it, and a price page shows the country's own currency. */
  verdict: (request: JudgeRequest) => Verdict = (request) => ({ ...GROUNDED, currencyShown: request.column === 'availability' ? (request.value as { currency: string }).currency : null })
  constructor(
    private readonly ledger: MemoryAiSpendLedger,
    private readonly microsPerCall = 0,
  ) {}
  async judge(request: JudgeRequest): Promise<Verdict> {
    this.requests.push(request)
    await spend(this.ledger, JUDGE_JOB, this.microsPerCall)
    return this.verdict(request)
  }
}

type Setup = { cases?: DraftCase[]; set?: DraftSet; humanChecks?: HumanCheck[]; limit?: number; outDir?: string; capMicros?: number; draftMicros?: number; judgeMicros?: number }

const setup = ({ cases = CASES, set, humanChecks, limit, outDir, capMicros = BIG_CAP_MICROS, draftMicros = 0, judgeMicros = 0 }: Setup = {}) => {
  const ledger = new MemoryAiSpendLedger({ capMicros })
  const researcher = new FakeResearcher()
  const drafter = new FakeDrafter(ledger, draftMicros)
  const judge = new FakeJudge(ledger, judgeMicros)
  const logs: string[] = []
  const dirs: string[] = []
  const files = new Map<string, string>()
  const workbooks = new Map<string, RawWorkbook>()
  const run = () =>
    runDraftEval({
      cases,
      ...(set === undefined ? {} : { set }),
      ...(humanChecks === undefined ? {} : { humanChecks }),
      limit,
      outDir,
      startedAt: BASE,
      deps: { researcher, drafter, judge, ledger },
      io: {
        log: (line) => logs.push(line),
        mkdir: async (dir) => {
          dirs.push(dir)
        },
        writeFile: async (path, text) => {
          files.set(path, text)
        },
        writeWorkbook: async (path, workbook) => {
          workbooks.set(path, workbook)
        },
      },
    })
  return { ledger, researcher, drafter, judge, logs, dirs, files, workbooks, run }
}

const OUT = 'out/run-1'
const REPORT_PATH = join(OUT, 'report.json')
const WORKBOOK_PATH = join(OUT, 'draft.xlsx')

type Reported = {
  startedAt: string
  set: string
  capMicros: number
  cases: { id: string; kind: string; state: string; costMicros: number; values: { filled: number; grounded: number; contradicted: number; unverifiable: number }; trap: { passed: boolean } | null; cells: { column: string; sourceUrl: string; verdict: Verdict }[]; prices: { country: string; sourceUrl: string; verdict: Verdict }[] }[]
  summary: {
    gate: { holds: boolean; failures: string[] }
    costMicros: number
    prices: { asked: number; priced: number; byCountry: Record<string, { asked: number; priced: number }>; bandCorrect: number; bandKnown: number; bandUnknown: number }
  }
}
const reportOf = (files: Map<string, string>): Reported => JSON.parse(files.get(REPORT_PATH)!)
const rowOf = (workbook: RawWorkbook, brand: string, name: string) => workbook.products.rows.find((r) => r.brand === brand && r.name === name)!

describe('runDraftEval: the workbook it builds and drafts', () => {
  it('builds one draft Products row per case, with the case\'s identity and every drafting column empty before drafting', async () => {
    const { run, workbooks } = setup({ outDir: OUT })

    await run()

    const workbook = workbooks.get(WORKBOOK_PATH)!
    expect(workbook.products.rows).toHaveLength(CASES.length)
    const row = rowOf(workbook, 'CeraVe', 'Hydrating Cleanser')
    expect(row).toMatchObject({ variant: 'Normal to Dry Skin', form: 'liquid', category: 'skin', status: 'draft' })
    expect(rowOf(workbook, 'Unbranded', 'Raw Shea Butter')).toMatchObject({ category: 'body', status: 'draft' })
    // Nothing was typed by a person: an empty cell is an empty cell in the file.
    for (const r of workbook.products.rows) expect(r.status).toBe('draft')
  })

  it('gives every row its own product code that the contract accepts', async () => {
    const { run, workbooks } = setup({ outDir: OUT })

    await run()

    const codes = workbooks.get(WORKBOOK_PATH)!.products.rows.map((r) => String(r.code))
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) expect(code).toMatch(/^[A-Z0-9][A-Z0-9-]{1,39}$/)
  })

  it('has a Countries tab with exactly NG (NGN) and GB (GBP), both active', async () => {
    const { run, workbooks } = setup({ outDir: OUT })

    await run()

    const countries = workbooks.get(WORKBOOK_PATH)!.countries.rows.map((r) => [r.code, r.currency, r.status])
    expect(countries).toEqual([
      ['NG', 'NGN', 'active'],
      ['GB', 'GBP', 'active'],
    ])
  })

  it('writes the drafted cells and prices into the workbook, so the owner can open and review them', async () => {
    const { run, workbooks } = setup({ outDir: OUT })

    await run()

    const workbook = workbooks.get(WORKBOOK_PATH)!
    const row = rowOf(workbook, 'CeraVe', 'Hydrating Cleanser')
    expect(row).toMatchObject({ ingredients: 'Aqua; Glycerin', skin_concerns: 'hd_acne', skin_types: 'oily', steps: 'cleanse', frequency: 'am-pm' })
    const prices = workbook.availability.rows.filter((r) => r.product_code === row.code)
    expect(prices.map((r) => r.country).sort()).toEqual(['GB', 'NG'])
  })

  it('asks the researcher about each product as the case names it', async () => {
    const { run, researcher } = setup()

    await run()

    expect(researcher.products).toEqual(CASES.map((c) => c.product))
  })

  it('asks the drafter for all four columns and only the countries the case names, each with the currency of its Countries row', async () => {
    const { run, drafter } = setup()

    await run()

    // The first pass asks every case for every column; later passes (catalog:draft's retries) ask only for prices still missing.
    const firstPass = drafter.requests.filter((request) => (request.attempt ?? 1) === 1)
    expect(firstPass).toHaveLength(CASES.length)
    for (const request of firstPass) expect([...request.columns].sort()).toEqual(['frequency', 'skin_concerns', 'skin_types', 'steps'])
    for (const request of drafter.requests.filter((r) => (r.attempt ?? 1) > 1)) expect(request.columns).toEqual([])
    expect(drafter.requests[0]!.countries).toEqual([
      { code: 'NG', currency: 'NGN' },
      { code: 'GB', currency: 'GBP' },
    ])
    const unbranded = drafter.requests.find((r) => r.product.brand === 'Unbranded')!
    expect(unbranded.countries).toEqual([{ code: 'NG', currency: 'NGN' }])
  })

  it('runs the cases one at a time through draftWorkbook, so a case\'s cost and outcome are its own', async () => {
    const { run, files } = setup({ outDir: OUT, draftMicros: 1_000, judgeMicros: 10 })

    await run()

    // ordinary: 1 draft call + 7 values judged (ingredients, 4 cells, 2 prices); sibling the same; foreign 6 values and 2 retries for its missing GB
    // price; unbranded 1 draft call and 2 retries, and nothing to judge. A case is drafted as catalog:draft drafts it, retries included.
    expect(reportOf(files).cases.map((c) => [c.id, c.costMicros])).toEqual([
      [ORDINARY.id, 1_070],
      [SIBLING.id, 1_070],
      [FOREIGN.id, 3_060],
      [UNBRANDED.id, 3_000],
    ])
  })

  it('applies --limit to the cases it runs and puts in the workbook', async () => {
    const { run, researcher, workbooks, files } = setup({ outDir: OUT, limit: 2 })

    await run()

    expect(researcher.products).toEqual([ORDINARY.product, SIBLING.product])
    expect(workbooks.get(WORKBOOK_PATH)!.products.rows).toHaveLength(2)
    expect(reportOf(files).cases.map((c) => c.id)).toEqual([ORDINARY.id, SIBLING.id])
  })
})

describe('runDraftEval: judging', () => {
  it('judges every drafted value exactly once: the ingredient list, each cell and each price row', async () => {
    const { run, judge } = setup()

    await run()

    // ordinary 7 + sibling 7 + foreign 6 (a GB price only) + unbranded 0.
    expect(judge.requests).toHaveLength(20)
    const keys = judge.requests.map((r) => `${r.product.brand}|${r.product.name}|${r.column}|${r.column === 'availability' ? (r.value as { country: string }).country : ''}`)
    expect(new Set(keys).size).toBe(20)
  })

  it('shows the judge the product as the case names it, the value as drafted and the page it came from', async () => {
    const { run, judge } = setup({ cases: [ORDINARY] })

    await run()

    const byColumn = (column: string) => judge.requests.find((r) => r.column === column)!
    expect(byColumn('skin_concerns')).toMatchObject({ product: ORDINARY.product, value: ['hd_acne'], sourceUrl: CELL_PAGE('skin_concerns') })
    expect(byColumn('frequency')).toMatchObject({ value: 'am-pm', sourceUrl: CELL_PAGE('frequency') })
    expect(byColumn('ingredients')).toMatchObject({ value: ['Aqua', 'Glycerin'], sourceUrl: INGREDIENT_PAGE })
  })

  it('tells the judge a price row\'s country, its currency from the Countries tab, the range and the shop', async () => {
    const { run, judge } = setup({ cases: [ORDINARY] })

    await run()

    const rows = judge.requests.filter((r) => r.column === 'availability')
    expect(rows.map((r) => r.value)).toEqual(
      expect.arrayContaining([
        { country: 'NG', currency: 'NGN', priceMin: 4000, priceMax: 6500, whereSold: 'Pharmacies' },
        { country: 'GB', currency: 'GBP', priceMin: 4000, priceMax: 6500, whereSold: 'Pharmacies' },
      ]),
    )
    expect(rows.find((r) => (r.value as { country: string }).country === 'NG')!.sourceUrl).toBe(PRICE_PAGE('NG'))
  })

  it('does not call the judge for a case that drafted nothing', async () => {
    const { run, judge } = setup({ cases: [UNBRANDED] })

    await run()

    expect(judge.requests).toEqual([])
  })
})

describe('runDraftEval: exit code and gate', () => {
  it('exits 0 when no value is contradicted, no price is in the wrong currency and every trap passes', async () => {
    const { run, files } = setup({ outDir: OUT })

    const { exitCode } = await run()

    expect(exitCode).toBe(0)
    expect(reportOf(files).summary.gate).toEqual({ holds: true, failures: [] })
  })

  it('exits 1 when more than 5% of the values are contradicted', async () => {
    const t = setup({ outDir: OUT })
    t.judge.verdict = (request) => (request.column === 'frequency' ? { ...GROUNDED, supports: 'no' } : GROUNDED)

    const { exitCode } = await t.run()

    // 3 of 20 values contradicted is 15%.
    expect(exitCode).toBe(1)
    expect(reportOf(t.files).summary.gate.failures).toContain('contradicted-rate')
  })

  it('exits 1 when a price is shown in another currency than its country\'s', async () => {
    const t = setup({ outDir: OUT })
    t.judge.verdict = (request) => ({ ...GROUNDED, currencyShown: request.column === 'availability' ? 'USD' : null })

    const { exitCode } = await t.run()

    expect(exitCode).toBe(1)
    expect(reportOf(t.files).summary.gate.failures).toContain('wrong-currency')
  })

  it('exits 1 when a trap fails: the unbranded product was drafted anyway', async () => {
    const t = setup({ outDir: OUT })
    t.drafter.answer = (request) => answerFor({ ...request, product: { ...request.product, brand: 'Neutrogena' } })

    const { exitCode } = await t.run()

    expect(exitCode).toBe(1)
    const reported = reportOf(t.files)
    expect(reported.cases.find((c) => c.id === UNBRANDED.id)!.trap).toMatchObject({ passed: false })
    expect(reported.summary.gate.failures).toContain('traps')
  })

  it('exits 1 when the sibling trap is taken in: the judge says the page is for a different product', async () => {
    const t = setup({ outDir: OUT })
    t.judge.verdict = (request) => (request.product.name === 'Foaming Cleanser' ? { ...GROUNDED, exactProduct: 'no' } : GROUNDED)

    const { exitCode } = await t.run()

    expect(exitCode).toBe(1)
    expect(reportOf(t.files).cases.find((c) => c.id === SIBLING.id)!.trap).toMatchObject({ passed: false })
  })

  it('exits 1 when the foreign-currency trap is taken in: a price row for the country with no local price', async () => {
    const t = setup({ outDir: OUT })
    t.drafter.answer = (request) => answerFor({ ...request, product: { ...request.product, brand: 'CeraVe' } })

    const { exitCode } = await t.run()

    expect(exitCode).toBe(1)
    expect(reportOf(t.files).cases.find((c) => c.id === FOREIGN.id)!.trap).toMatchObject({ passed: false })
  })

  it('judges what a failed run drafted before it failed, and exits 1: a case that failed leaves the measurement incomplete', async () => {
    const t = setup({ outDir: OUT })
    t.drafter.failure = (request) => (request.product.brand === 'Neutrogena' ? new Error(ERROR_SENTINEL) : undefined)

    const { exitCode } = await t.run()

    expect(exitCode).toBe(1)
    const reported = reportOf(t.files)
    expect(reported.cases.map((c) => c.state)).toEqual(['drafted', 'drafted', 'failed', 'drafted'])
    expect(t.researcher.products).toHaveLength(4)
  })

  // The class name of an error says what kind of failure it was (Anthropic's request, refusal or a network error) and holds no model words, so it is shown
  // next to the fixed code; the message stays out.
  describe('the class name of the error behind a failed product', () => {
    class OverloadedError extends Error {}

    it('is shown beside drafter-error in the console and kept in report.json, never the message', async () => {
      const t = setup({ outDir: OUT })
      t.drafter.failure = (request) => (request.product.brand === 'Neutrogena' ? new OverloadedError(ERROR_SENTINEL) : undefined)

      await t.run()

      const line = t.logs.find((l) => l.includes(FOREIGN.id) && l.includes('filled='))!
      expect(line).toContain('drafter-error: OverloadedError')
      expect(t.logs.join('\n')).not.toContain(ERROR_SENTINEL)
      expect(t.files.get(REPORT_PATH)).not.toContain(ERROR_SENTINEL)
      const failed = reportOf(t.files).cases.find((c) => c.id === FOREIGN.id)! as unknown as { reason: string; errorName: string }
      expect(failed).toMatchObject({ reason: 'drafter-error', errorName: 'OverloadedError' })
    })

    it('is shown beside researcher-error too', async () => {
      const t = setup({ outDir: OUT })
      t.researcher.failure = (product) => (product.brand === 'Neutrogena' ? new OverloadedError(ERROR_SENTINEL) : undefined)

      await t.run()

      expect(t.logs.find((l) => l.includes(FOREIGN.id) && l.includes('filled='))).toContain('researcher-error: OverloadedError')
      expect((reportOf(t.files).cases.find((c) => c.id === FOREIGN.id)! as unknown as { errorName: string }).errorName).toBe('OverloadedError')
    })

    it('belongs to the product that failed: the cases around it show none', async () => {
      const t = setup({ outDir: OUT })
      t.drafter.failure = (request) => (request.product.brand === 'Neutrogena' ? new OverloadedError('x') : undefined)

      await t.run()

      for (const c of reportOf(t.files).cases.filter((x) => x.id !== FOREIGN.id)) expect(c, c.id).not.toHaveProperty('errorName')
    })

    it('is the name of the class, not of an instance\'s name property: a subclass that sets no name still says what it is', async () => {
      const t = setup({ outDir: OUT })
      t.drafter.failure = (request) => (request.product.brand === 'Neutrogena' ? Object.assign(new OverloadedError('x'), { name: 'Error' }) : undefined)

      await t.run()

      expect((reportOf(t.files).cases.find((c) => c.id === FOREIGN.id)! as unknown as { errorName: string }).errorName).toBe('OverloadedError')
    })

    it('leaves the spend cap and a refused key to stop the run as they did: the wrapper rethrows the error unchanged', async () => {
      const t = setup({ outDir: OUT })
      t.drafter.failure = () => new AnthropicConfigError('rejected')

      const { exitCode } = await t.run()

      expect(exitCode).toBe(2)
      expect(reportOf(t.files).cases.map((c) => c.state)).toEqual(['cut-off', 'cut-off', 'cut-off', 'cut-off'])
    })
  })

  it('skips a case it cannot ask about without calling anything for it, runs the rest, and exits 1', async () => {
    const unaskable: DraftCase = { ...ORDINARY, id: 'no-brand', product: { ...ORDINARY.product, brand: '' } }
    const t = setup({ outDir: OUT, cases: [unaskable, SIBLING] })

    const { exitCode } = await t.run()

    expect(exitCode).toBe(1)
    expect(t.researcher.products).toEqual([SIBLING.product])
    expect(reportOf(t.files).cases.map((c) => [c.id, c.state])).toEqual([
      ['no-brand', 'skipped'],
      [SIBLING.id, 'drafted'],
    ])
  })

  it('exits 2, and still writes what it has, when Claude refuses our key', async () => {
    const t = setup({ outDir: OUT })
    t.drafter.failure = () => new AnthropicConfigError('rejected')

    const { exitCode } = await t.run()

    expect(exitCode).toBe(2)
    expect(t.files.has(REPORT_PATH)).toBe(true)
    expect(t.workbooks.has(WORKBOOK_PATH)).toBe(true)
  })
})

describe('runDraftEval: a key, billing or permission Claude refuses while judging', () => {
  it('exits 2, makes no more judge calls or cases, still writes both files, and leaves the values not judged unverifiable', async () => {
    const t = setup({ outDir: OUT })
    let asked = 0
    const judged = t.judge.verdict
    t.judge.verdict = (request) => {
      if (++asked === 3) throw new AnthropicConfigError('rejected')
      return judged(request)
    }

    const { exitCode } = await t.run()

    expect(exitCode).toBe(2)
    expect(t.judge.requests).toHaveLength(3)
    expect(t.researcher.products).toHaveLength(1)
    expect(t.files.has(REPORT_PATH)).toBe(true)
    expect(t.workbooks.get(WORKBOOK_PATH)!.products.rows).toHaveLength(CASES.length)
    const reported = reportOf(t.files)
    expect(reported.cases.map((c) => c.state)).toEqual(['cut-off', 'cut-off', 'cut-off', 'cut-off'])
    expect(reported.cases[0]!.values).toEqual({ filled: 7, grounded: 2, contradicted: 0, unverifiable: 5 })
    expect(t.logs.some((line) => /refused our key/i.test(line))).toBe(true)
  })
})

describe('runDraftEval: the spend cap', () => {
  it('stops at the cap while drafting, runs no further case, still writes both files and exits 1', async () => {
    // Case 1 costs 1000 + 7 x 100 = 1700. Case 2\'s draft call needs 1000 more and the cap is 2200.
    const t = setup({ outDir: OUT, capMicros: 2_200, draftMicros: 1_000, judgeMicros: 100 })

    const { exitCode } = await t.run()

    expect(exitCode).toBe(1)
    expect(t.researcher.products.map((p) => p.name)).toEqual(['Hydrating Cleanser', 'Foaming Cleanser'])
    expect(t.judge.requests).toHaveLength(7)
    const reported = reportOf(t.files)
    expect(reported.cases.map((c) => c.state)).toEqual(['drafted', 'cut-off', 'cut-off', 'cut-off'])
    expect(reported.summary.gate.holds).toBe(false)
    expect(reported.summary.gate.failures).toContain('incomplete')
    expect(t.workbooks.get(WORKBOOK_PATH)!.products.rows).toHaveLength(CASES.length)
  })

  it('stops at the cap while judging: the values not judged are unverifiable, no more judge calls are made, and no further case runs', async () => {
    // The draft call costs 1000; the cap leaves room for two judge calls of 100 and the third is refused.
    const t = setup({ outDir: OUT, capMicros: 1_250, draftMicros: 1_000, judgeMicros: 100 })

    const { exitCode } = await t.run()

    expect(exitCode).toBe(1)
    expect(t.judge.requests).toHaveLength(3)
    expect(t.researcher.products).toHaveLength(1)
    const first = reportOf(t.files).cases[0]!
    expect(first.state).toBe('cut-off')
    expect(first.values).toEqual({ filled: 7, grounded: 2, contradicted: 0, unverifiable: 5 })
  })

  it('says in the console that it stopped at the spend cap', async () => {
    const t = setup({ outDir: OUT, capMicros: 1_250, draftMicros: 1_000, judgeMicros: 100 })

    await t.run()

    expect(t.logs.some((line) => /spend cap/i.test(line))).toBe(true)
  })

  it('reports the cost of the run as what the ledger says was spent', async () => {
    const t = setup({ outDir: OUT, draftMicros: 1_000, judgeMicros: 10 })

    await t.run()

    const reported = reportOf(t.files)
    expect(reported.summary.costMicros).toBe(t.ledger.spentMicros())
    expect(reported.summary.costMicros).toBe(8_200)
    expect(t.logs.some((line) => line.includes('$0.0082'))).toBe(true)
    expect(reported.capMicros).toBe(BIG_CAP_MICROS)
  })

  it('treats AiBudgetExceededError from the drafter like any cap stop, not as a failed product', async () => {
    const t = setup({ outDir: OUT })
    t.drafter.failure = () => new AiBudgetExceededError('cap')

    const { exitCode } = await t.run()

    expect(exitCode).toBe(1)
    expect(reportOf(t.files).cases.map((c) => c.state)).toEqual(['cut-off', 'cut-off', 'cut-off', 'cut-off'])
  })
})

describe('runDraftEval: the files', () => {
  it('writes report.json and draft.xlsx to the output directory, which it creates first', async () => {
    const { run, dirs, files, workbooks } = setup({ outDir: OUT })

    await run()

    expect(dirs).toEqual([OUT])
    expect([...files.keys()]).toEqual([REPORT_PATH])
    expect([...workbooks.keys()]).toEqual([WORKBOOK_PATH])
  })

  it('names the set in report.json and in the first line it prints, main unless told otherwise', async () => {
    const main = setup({ outDir: OUT })
    await main.run()
    expect(reportOf(main.files).set).toBe('main')
    expect(main.logs[0]).toContain('set main')

    const holdout = setup({ outDir: OUT, set: 'holdout' })
    await holdout.run()
    expect(reportOf(holdout.files).set).toBe('holdout')
    expect(holdout.logs[0]).toContain('set holdout')
  })

  it('puts the run in .eval/draft-<timestamp>, with no colon in the name, when no directory is given', async () => {
    const { run, dirs, files } = setup()

    const { outDir } = await run()

    expect(defaultOutDir(BASE)).toBe('.eval/draft-2030-06-15T00-00-00.000Z')
    expect(outDir).toBe('.eval/draft-2030-06-15T00-00-00.000Z')
    expect(dirs).toEqual([outDir])
    expect(files.has(join(outDir, 'report.json'))).toBe(true)
  })

  it('writes a JSON report with each case, its state, cost, counts, trap result, and every value with its full page and the judge\'s verdict', async () => {
    const { run, files } = setup({ outDir: OUT })

    await run()

    const reported = reportOf(files)
    expect(reported.startedAt).toBe(BASE.toISOString())
    expect(reported.cases.map((c) => [c.id, c.kind, c.state])).toEqual(CASES.map((c) => [c.id, c.kind, 'drafted']))
    expect(reported.cases[0]!.values).toEqual({ filled: 7, grounded: 7, contradicted: 0, unverifiable: 0 })
    expect(reported.cases[0]!.trap).toBeNull()
    expect(reported.cases[1]!.trap).toMatchObject({ passed: true })
    expect(reported.cases[0]!.cells.find((c) => c.column === 'steps')).toMatchObject({ sourceUrl: CELL_PAGE('steps'), verdict: { fetched: true, exactProduct: 'yes', supports: 'yes' } })
    expect(reported.cases[0]!.prices.map((p) => [p.country, p.sourceUrl])).toEqual([
      ['NG', PRICE_PAGE('NG')],
      ['GB', PRICE_PAGE('GB')],
    ])
  })
})

describe('runDraftEval: the console', () => {
  it('prints one line per case with its id, kind, counts and trap result', async () => {
    const { run, logs } = setup({ outDir: OUT })

    await run()

    for (const c of CASES) {
      const lines = logs.filter((line) => line.includes(c.id) && line.includes('filled='))
      expect(lines, c.id).toHaveLength(1)
      expect(lines[0], c.id).toContain(c.kind)
    }
    expect(logs.find((line) => line.includes(UNBRANDED.id) && line.includes('filled='))).toContain('trap=pass')
  })

  it('ends with the gate line, and nothing after it', async () => {
    const { run, logs } = setup({ outDir: OUT })

    await run()

    expect(logs.at(-1)).toBe('Gate: PASS (4 cases, 3 traps)')
  })

  it('prints the percentages with one decimal', async () => {
    const t = setup({ outDir: OUT, cases: [ORDINARY] })
    t.judge.verdict = (request) => (request.column === 'frequency' ? { ...GROUNDED, supports: 'no' } : { ...GROUNDED, currencyShown: request.column === 'availability' ? (request.value as { currency: string }).currency : null })

    await t.run()

    // 1 of the 7 values (the ingredient list, four cells, two prices) is contradicted.
    expect(t.logs.find((l) => l.startsWith('All values:'))).toContain('contradicted 14.3%')
  })

  it('prints the unverifiable values by reason, and puts each value\'s reason in report.json', async () => {
    const t = setup({ outDir: OUT, cases: [ORDINARY] })
    t.judge.verdict = (request) => (request.column === 'steps' ? unverifiable('refused') : request.column === 'frequency' ? unverifiable('fetch-failed') : GROUNDED)

    await t.run()

    expect(t.logs.find((l) => l.startsWith('unverifiable by reason:'))).toBe('unverifiable by reason: not-fetched=0 fetch-failed=1 cut-off=0 refused=1 unreadable-answer=0 api-error=0 unclear=0')
    const cells = reportOf(t.files).cases[0]!.cells
    expect(cells.find((c) => c.column === 'steps')!.verdict).toMatchObject({ reason: 'refused' })
    expect(cells.find((c) => c.column === 'frequency')!.verdict).toMatchObject({ reason: 'fetch-failed' })
  })

  it('lets a person\'s check win over the judge: the value is grounded in the report, the gate and the totals, and the run says how many it overruled', async () => {
    const check: HumanCheck = { caseId: ORDINARY.id, column: 'frequency', value: 'am-pm', verdict: 'correct', note: 'SENTINEL-NOTE', checkedOn: '2030-06-15', by: 'owner' }
    const t = setup({ outDir: OUT, cases: [ORDINARY], humanChecks: [check] })
    t.judge.verdict = (request) => (request.column === 'frequency' ? { ...GROUNDED, supports: 'no' } : { ...GROUNDED, currencyShown: request.column === 'availability' ? (request.value as { currency: string }).currency : null })

    const { exitCode } = await t.run()

    expect(exitCode).toBe(0)
    expect(reportOf(t.files).cases[0]!.cells.find((c) => c.column === 'frequency')!.verdict).toMatchObject({ fetched: true, supports: 'yes' })
    expect(reportOf(t.files).summary).toMatchObject({ overruled: [{ caseId: ORDINARY.id, value: 'frequency', judge: 'contradicted', human: 'correct' }] })
    expect(t.logs).toContain('judge overruled by a person: 1')
    expect(t.logs).toContain(`  ${ORDINARY.id} frequency judge=contradicted person=correct`)
    expect(t.logs.join('\n')).not.toContain('SENTINEL-NOTE')
    // The judge was still asked: the check is applied to its answer, not instead of it.
    expect(t.judge.requests.some((r) => r.column === 'frequency')).toBe(true)
  })

  it('counts none overruled when there are no checks', async () => {
    const t = setup({ outDir: OUT })

    await t.run()

    expect(t.logs).toContain('judge overruled by a person: 0')
  })

  it('marks a value never asked about, because the run stopped first, as cut-off', async () => {
    const t = setup({ outDir: OUT })
    let asked = 0
    t.judge.verdict = () => {
      if (++asked === 3) throw new AnthropicConfigError('rejected')
      return GROUNDED
    }

    await t.run()

    const cells = reportOf(t.files).cases[0]!.cells
    expect(cells.at(-1)!.verdict).toMatchObject({ fetched: false, reason: 'cut-off' })
  })

  it('ends with a FAIL gate line naming the rule when the gate does not hold', async () => {
    const t = setup({ outDir: OUT })
    t.judge.verdict = () => ({ ...GROUNDED, supports: 'no' })

    await t.run()

    expect(t.logs.at(-1)).toMatch(/^Gate: FAIL.*contradicted-rate/)
  })

  it('names the contradicted values with the drafted value and the page\'s host, so the owner knows what to look at', async () => {
    const t = setup({ outDir: OUT, cases: [ORDINARY] })
    t.judge.verdict = (request) => (request.column === 'frequency' ? { ...GROUNDED, supports: 'no' } : GROUNDED)

    await t.run()

    const line = t.logs.find((l) => l.includes('frequency') && l.includes('am-pm') && !l.includes('filled='))
    expect(line).toBeDefined()
    expect(line).toContain('www.derm.example')
  })

  it('never prints a full URL, a page path or query, or the message of an error: only hosts, ids, fixed codes and numbers', async () => {
    const t = setup({ outDir: OUT, draftMicros: 1_000, judgeMicros: 10 })
    t.drafter.failure = (request) => (request.product.brand === 'Neutrogena' ? new Error(ERROR_SENTINEL) : undefined)
    t.judge.verdict = (request) => (request.column === 'steps' ? { ...GROUNDED, supports: 'no' } : GROUNDED)

    await t.run()

    const output = t.logs.join('\n')
    expect(output).not.toContain(URL_SENTINEL)
    expect(output).not.toContain(ERROR_SENTINEL)
    expect(output).not.toContain('https://')
    expect(output).not.toContain('http://')
    // A failed case says why in a fixed code.
    expect(t.logs.some((line) => line.includes(FOREIGN.id) && line.includes('drafter-error'))).toBe(true)
  })

  it('keeps the full URLs out of the console but in the JSON report, which is for the owner\'s eyes', async () => {
    const t = setup({ outDir: OUT })

    await t.run()

    expect(t.logs.join('\n')).not.toContain(URL_SENTINEL)
    expect(t.files.get(REPORT_PATH)).toContain(URL_SENTINEL)
  })
})

// Beside the gate the run reports what the drafted prices are for: coverage (of the product-country pairs asked in ordinary cases that were drafted, how
// many got a price row) and band accuracy (of the rows whose page the judge could read a price for, how many put the product in the page's budget band,
// from the Countries tab's low_max and mid_max: NG 5000 and 15000, GB 10 and 30). Neither is part of the gate.
describe('runDraftEval: price coverage and band accuracy', () => {
  const ordinary = (id: string, brand: string, countries: string[] = ['NG', 'GB']): DraftCase => ({ id, kind: 'ordinary', product: { brand, name: 'Body Lotion', category: 'body' }, countries })
  const AMBER = ordinary('amber-body-lotion', 'Amber')
  const KURUVO = ordinary('kuruvo-body-lotion', 'Kuruvo')
  const ZELVO = ordinary('zelvo-body-lotion', 'Zelvo')
  const PRICES_CASES = [AMBER, KURUVO, ZELVO, FOREIGN]

  /** The drafted range for each product and country: NG 4000-6500 is mid (5250), GB 8-12 is low (10). Kuruvo gets no GB price; Zelvo's drafting fails. */
  const priceAnswer = (request: DraftRequest): DraftResult => {
    const base = answerFor(request)
    if (request.product.brand === 'Neutrogena') return base
    const rows = { NG: { priceMin: 4000, priceMax: 6500 }, GB: { priceMin: 8, priceMax: 12 } } as const
    const countries = request.product.brand === 'Kuruvo' ? request.countries.filter((c) => c.code === 'NG') : request.countries
    return { ...base, availability: countries.map(({ code }) => ({ country: code, ...rows[code as 'NG' | 'GB'], sourceUrl: PRICE_PAGE(code) })) }
  }

  /** What each judged price page showed: Amber NG 5200 (mid, as drafted), Amber GB 25 (mid, not the low drafted), Kuruvo nothing, the foreign trap 5000 (which would be known if it were counted). */
  const pricesShownFor = (request: JudgeRequest): number[] | undefined => {
    const country = (request.value as { country: string }).country
    const brand = request.product.brand
    if (brand === 'Amber') return country === 'NG' ? [5200] : [25]
    if (brand === 'Neutrogena') return [5000]
    return undefined
  }

  const priced = (extra: Setup = {}) => {
    const t = setup({ outDir: OUT, cases: PRICES_CASES, ...extra })
    t.drafter.answer = priceAnswer
    t.drafter.failure = (request) => (request.product.brand === 'Zelvo' ? new Error(ERROR_SENTINEL) : undefined)
    t.judge.verdict = (request) => {
      if (request.column !== 'availability') return GROUNDED
      const shown = pricesShownFor(request)
      return { ...GROUNDED, currencyShown: (request.value as { currency: string }).currency, ...(shown === undefined ? {} : { pricesShown: shown }) }
    }
    return t
  }

  it('reports the coverage and the band accuracy in the console, over ordinary cases that were drafted only', async () => {
    const t = priced()

    await t.run()

    // Amber asked NG and GB (2 priced), Kuruvo asked NG and GB (NG priced): 4 asked, 3 priced. The failed ordinary case and the trap are not in it.
    const line = t.logs.find((l) => l.startsWith('Prices:'))!
    expect(line).toMatch(/coverage 3\/4 \(75(\.0)?%\)/)
    expect(line).toMatch(/NG 2\/2/)
    expect(line).toMatch(/GB 1\/2/)
    // Amber NG: drafted 5250 is mid, the page's 5200 is mid. Amber GB: drafted 10 is low, the page's 25 is mid. Kuruvo NG: the page showed no price.
    expect(line).toMatch(/band-correct 1\/2 \(50(\.0)?%\)/)
    expect(line).toMatch(/band unknown 1/)
    expect(line).not.toContain('NaN')
  })

  it('keeps the same numbers in report.json under summary.prices', async () => {
    const t = priced()

    await t.run()

    expect(reportOf(t.files).summary.prices).toEqual({
      asked: 4,
      priced: 3,
      byCountry: { NG: { asked: 2, priced: 2 }, GB: { asked: 2, priced: 1 } },
      bandCorrect: 1,
      bandKnown: 2,
      bandUnknown: 1,
    })
  })

  it('counts a case that failed apart, as it already does, and not in the coverage', async () => {
    const t = priced()

    await t.run()

    expect(reportOf(t.files).cases.map((c) => [c.id, c.state])).toContainEqual([ZELVO.id, 'failed'])
    expect(reportOf(t.files).summary.prices.asked).toBe(4)
  })

  it('does not let a person\'s check on a price change its band: the page\'s prices stand', async () => {
    const check: HumanCheck = { caseId: AMBER.id, column: 'price:NG', value: '4000-6500', verdict: 'wrong', note: 'n', checkedOn: '2030-06-15', by: 'owner' }
    const t = priced({ humanChecks: [check] })

    await t.run()

    expect(reportOf(t.files).summary.prices).toMatchObject({ bandCorrect: 1, bandKnown: 2, bandUnknown: 1 })
  })

  it('is not part of the gate: a run whose prices are all out of band and half missing exits as it did', async () => {
    const t = setup({ outDir: OUT, cases: [AMBER, KURUVO] })
    t.drafter.answer = priceAnswer
    t.judge.verdict = (request) => (request.column === 'availability' ? { ...GROUNDED, currencyShown: (request.value as { currency: string }).currency, pricesShown: [900_000] } : GROUNDED)

    const { exitCode } = await t.run()

    expect(reportOf(t.files).summary.prices).toMatchObject({ asked: 4, priced: 3, bandCorrect: 0, bandKnown: 3, bandUnknown: 0 })
    expect(exitCode).toBe(0)
    expect(t.logs.at(-1)).toMatch(/^Gate: PASS/)
  })

  it('says band-correct 0 of 0, not NaN, when the judge gave no prices at all, and still ends with the gate line', async () => {
    const t = setup({ outDir: OUT })

    await t.run()

    const line = t.logs.find((l) => l.startsWith('Prices:'))!
    expect(line).toMatch(/coverage 2\/2/)
    expect(line).toMatch(/band-correct 0\/0/)
    expect(line).toMatch(/band unknown 2/)
    expect(line).not.toContain('NaN')
    expect(t.logs.at(-1)).toMatch(/^Gate: /)
  })
})
