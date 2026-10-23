/*
 * The orchestration of `npm run eval:catalog -- --mode draft`, without the network, the clock or the disk (the script injects them): one workbook built from
 * the cases, every case drafted through the real draftWorkbook one at a time, every value it drafted judged once, then the scores, the gate, the console
 * lines and two files. What the console prints is only case ids, hosts, fixed codes and numbers; the full pages and verdicts go to the JSON report.
 */
import { join } from 'node:path'
import { CONTRACT, type RawRow, type RawWorkbook, type TabKey } from '../../src/modules/catalog/catalog.workbook.schema'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import type { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import type { CatalogDrafter, DraftRequest, DraftResult, DraftCountry } from '../../src/providers/catalog-drafting/catalog-drafter.provider'
import type { ProductIdentity, ProductResearcher, ResearchResult } from '../../src/providers/product-research/product-researcher.provider'
import { draftWorkbook } from '../catalog/draft'
import type { DraftCase } from './draft-cases'
import type { HumanCheck } from './draft-human-checks'
import { type DraftJudge, type JudgeRequest, unverifiable } from './draft-judge'
import {
  type CaseInput,
  type CaseScore,
  type CaseState,
  COLUMNS,
  type Counts,
  currencyOf,
  type DraftedCell,
  type DraftedPrice,
  draftedValuesOf,
  formatCaseLine,
  applyHumanChecks,
  formatGateLine,
  formatOverruledLines,
  formatUnverifiableLine,
  isWrongCurrency,
  percent,
  scoreDraftCase,
  summariseDraft,
  usd,
  type Verdict,
} from './draft-score'
import type { DraftSet } from './score'

export type RunDeps = {
  researcher: ProductResearcher
  drafter: CatalogDrafter
  judge: DraftJudge
  /** The ledger the clients spend on; the run reads what each case cost from it. */
  ledger: MemoryAiSpendLedger
}

export type RunIo = {
  log: (line: string) => void
  mkdir: (dir: string) => Promise<void>
  writeFile: (path: string, text: string) => Promise<void>
  writeWorkbook: (path: string, workbook: RawWorkbook) => Promise<void>
}

export type RunArgs = {
  cases: DraftCase[]
  /** Which set `cases` is, for the report and the first line; main when left out. */
  set?: DraftSet
  /** What a person has checked by hand: each such value gets the person's verdict instead of the judge's. None when left out. */
  humanChecks?: HumanCheck[]
  /** Run only the first N cases. */
  limit?: number
  /** Where the report and the drafted workbook go; defaultOutDir(startedAt) when left out. */
  outDir?: string
  startedAt: Date
  /** The model of each job, for the report. */
  models?: Record<string, string>
  deps: RunDeps
  io: RunIo
}

/** No colons: actions/upload-artifact refuses them in a file name. */
export const defaultOutDir = (startedAt: Date): string => `.eval/draft-${startedAt.toISOString().replace(/:/g, '-')}`

// The eval's Countries tab. The bands are required by the contract and used by nothing here.
const COUNTRY_ROWS: RawRow[] = [
  { code: 'NG', currency: 'NGN', low_max: 5000, mid_max: 15000, status: 'active' },
  { code: 'GB', currency: 'GBP', low_max: 10, mid_max: 30, status: 'active' },
]

const EVAL_COUNTRIES: DraftCountry[] = COUNTRY_ROWS.map((row) => ({ code: row.code as string, currency: row.currency as string }))

const headersOf = (key: TabKey): string[] => CONTRACT.tabs.find((tab) => tab.key === key)!.columns.map((column) => column.name)

const workbookOf = (products: RawRow[], availability: RawRow[]): RawWorkbook => ({
  products: { headers: headersOf('products'), rows: products },
  availability: { headers: headersOf('availability'), rows: availability },
  ingredients: { headers: headersOf('ingredients'), rows: [] },
  countries: { headers: headersOf('countries'), rows: structuredClone(COUNTRY_ROWS) },
})

const codeOf = (c: DraftCase): string => `EVAL-${c.id.toUpperCase()}`

/** A draft row holding only who the product is: every cell the tools fill is empty, as in a workbook nobody has touched. */
const productRowOf = (c: DraftCase): RawRow => ({
  code: codeOf(c),
  brand: c.product.brand,
  name: c.product.name,
  variant: c.product.variant ?? null,
  form: c.product.form ?? null,
  category: c.product.category,
  origin: 'sourced',
  status: 'draft',
})

/** A value the judge was never asked about, because the run had already stopped. */
const NOT_ASKED: Verdict = unverifiable('cut-off')

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return '(unreadable address)'
  }
}

type Stop = 'cap' | 'config' | null

/** The name of an error's class, for a report: a code identifier, never the message. `constructor.name`, because an instance's `name` is "Error" unless a subclass sets it. */
const classNameOf = (error: unknown): string => {
  const name = (error as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name
  return typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,59}$/.test(name) ? name : 'Error'
}

/**
 * The researcher and the drafter as draftWorkbook sees them, remembering the class name of what they last threw. The error is rethrown as it was, so the
 * spend cap and a refused key still stop the run; `catalog:draft` itself only keeps a fixed reason, and the eval wants to know which kind of failure it was.
 */
const recordingErrors = (researcher: ProductResearcher, drafter: CatalogDrafter) => {
  let errorName: string | undefined
  const rethrow = (error: unknown): never => {
    errorName = classNameOf(error)
    throw error
  }
  return {
    researcher: { research: async (product: ProductIdentity): Promise<ResearchResult> => researcher.research(product).catch(rethrow) } satisfies ProductResearcher,
    drafter: { draft: async (request: DraftRequest): Promise<DraftResult> => drafter.draft(request).catch(rethrow) } satisfies CatalogDrafter,
    /** What the last failure was, once: each case starts clean. */
    takeErrorName: (): string | undefined => {
      const name = errorName
      errorName = undefined
      return name
    },
  }
}

/** The console lines for a case's values that need a person's eye: a value the page contradicts, and a price shown in another currency. Hosts and codes only. */
const attentionLines = (input: CaseInput): string[] => {
  const lines: string[] = []
  for (const { column, value, sourceUrl, verdict } of input.cells) {
    if (verdict.fetched && (verdict.supports === 'no' || verdict.exactProduct === 'no')) {
      // An ingredient list is what a model read off a page, so it stays out of the console; the other columns hold only words from our own lists.
      const shown = column === 'ingredients' ? '' : ` ${[value].flat().join('; ')}`
      lines.push(`  ${input.id} contradicted ${column}${shown} ${hostOf(sourceUrl)} (product=${verdict.exactProduct} supports=${verdict.supports})`)
    }
  }
  for (const price of input.prices) {
    const { country, priceMin, priceMax, sourceUrl, verdict } = price
    const range = `${priceMin}-${priceMax}`
    if (verdict.fetched && (verdict.supports === 'no' || verdict.exactProduct === 'no')) {
      lines.push(`  ${input.id} contradicted availability ${country} ${range} ${hostOf(sourceUrl)} (product=${verdict.exactProduct} supports=${verdict.supports})`)
    }
    if (isWrongCurrency(price, input.countries)) {
      lines.push(`  ${input.id} wrong-currency availability ${country} ${range} ${hostOf(sourceUrl)}`)
    }
  }
  return lines
}

export const runDraftEval = async ({ cases: allCases, set = 'main', humanChecks = [], limit, outDir: given, startedAt, models, deps, io }: RunArgs): Promise<{ exitCode: number; outDir: string }> => {
  const { judge, ledger } = deps
  const recorded = recordingErrors(deps.researcher, deps.drafter)
  const cases = allCases.slice(0, limit)
  const outDir = given ?? defaultOutDir(startedAt)
  const workbook = workbookOf(cases.map(productRowOf), [])
  // Made before anything is spent, so a directory that cannot be made stops the run while it is still free.
  await io.mkdir(outDir)
  io.log(`Draft eval: set ${set}, ${cases.length} cases, cap ${usd(ledger.capMicros)}`)

  let stopped: Stop = null
  const inputs: CaseInput[] = []
  for (const [index, c] of cases.entries()) {
    const countries: DraftCountry[] = c.countries.flatMap((code) => {
      const currency = currencyOf(EVAL_COUNTRIES, code)
      return currency === undefined ? [] : [{ code, currency }]
    })
    const base = { id: c.id, kind: c.kind, countries, expected: c.expected }
    const finish = (input: Omit<CaseInput, keyof typeof base>) => {
      inputs.push(applyHumanChecks({ ...base, ...input }, humanChecks))
      const score = scoreDraftCase(inputs.at(-1)!)
      io.log(formatCaseLine(score))
      for (const line of attentionLines(inputs.at(-1)!)) io.log(line)
    }

    // After a stop nothing more is asked: the case is left as it was.
    if (stopped !== null) {
      finish({ state: 'cut-off', reason: stopped === 'cap' ? 'spend-cap' : 'config', cells: [], prices: [], costMicros: 0 })
      continue
    }
    // A country the eval has no row for would stop draftWorkbook before it asked anything; the case cannot be asked about, like one with no brand.
    if (countries.length !== c.countries.length) {
      finish({ state: 'skipped', reason: 'unaskable', cells: [], prices: [], costMicros: 0 })
      continue
    }

    const spentBefore = ledger.spentMicros()
    recorded.takeErrorName()
    const outcome = await draftWorkbook(workbookOf([workbook.products.rows[index]!], []), { researcher: recorded.researcher, drafter: recorded.drafter, ledger, countries: c.countries })
    const errorName = recorded.takeErrorName()
    workbook.products.rows[index] = outcome.workbook.products.rows[0]!
    workbook.availability.rows.push(...outcome.workbook.availability.rows)

    let state: CaseState = 'drafted'
    let reason: string | undefined
    if (outcome.skipped.length > 0) [state, reason] = ['skipped', 'unaskable']
    else if (outcome.stoppedBy !== null) [state, reason] = ['cut-off', outcome.stoppedBy === 'cap' ? 'spend-cap' : 'config']
    else if (outcome.failed.length > 0) [state, reason] = ['failed', outcome.failed[0]!.reason]
    stopped = outcome.stoppedBy

    // What a failed case drafted before it failed is judged too. A stopped one is not: the cap or the key would refuse the judge as well, and the run is over.
    const drafted = draftedValuesOf(outcome.workbook, codeOf(c))
    const verdicts = await judgeAll(drafted, c, stopped, judge)
    if (verdicts.stopped !== null) [state, reason, stopped] = ['cut-off', verdicts.stopped === 'cap' ? 'spend-cap' : 'config', verdicts.stopped]

    finish({
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(state === 'failed' && errorName !== undefined ? { errorName } : {}),
      cells: drafted.cells.map((cell, i) => ({ ...cell, verdict: verdicts.cells[i]! })),
      prices: drafted.prices.map((price, i) => ({ ...price, verdict: verdicts.prices[i]! })),
      costMicros: ledger.spentMicros() - spentBefore,
    })
  }

  const scores: CaseScore[] = inputs.map(scoreDraftCase)
  const summary = summariseDraft(scores)

  const reported = scores.map((score, i) => ({ ...score, cells: inputs[i]!.cells, prices: inputs[i]!.prices }))
  const report = { startedAt: startedAt.toISOString(), set, capMicros: ledger.capMicros, ...(models === undefined ? {} : { models }), cases: reported, summary }
  const reportPath = join(outDir, 'report.json')
  const workbookPath = join(outDir, 'draft.xlsx')
  await io.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  await io.writeWorkbook(workbookPath, workbook)

  const { values, availability, traps, agreement } = summary
  if (stopped === 'cap') io.log('Stopped at the spend cap: the cases after this point were not run.')
  if (stopped === 'config') io.log('Stopped: Claude refused our key, billing or permissions. Fix the setup (ANTHROPIC_API_KEY and the account) and run again.')
  for (const column of COLUMNS) {
    const c = summary.columns[column]
    io.log(`${column}: ${countsLine(c)}`)
  }
  io.log(`availability: rows=${availability.rows} grounded=${availability.grounded} contradicted=${availability.contradicted} unverifiable=${availability.unverifiable} wrong-currency=${availability.wrongCurrency}`)
  io.log(formatUnverifiableLine(summary))
  for (const line of formatOverruledLines(summary)) io.log(line)
  io.log(`All values: ${countsLine(values)}, contradicted ${percent(values.contradicted, values.filled)}, unverifiable ${percent(values.unverifiable, values.filled)}`)
  io.log(`Traps passed: ${traps.passed}/${traps.total}. Within the plausible sets: ${agreement.agree} agree, ${agreement.disagree} disagree (reported, not gated).`)
  io.log(`Spent ${usd(summary.costMicros)} of the ${usd(ledger.capMicros)} cap.`)
  io.log(`Report: ${reportPath}`)
  io.log(`Workbook: ${workbookPath}`)
  io.log(formatGateLine(summary))
  return { exitCode: stopped === 'config' ? 2 : summary.gate.holds ? 0 : 1, outDir }
}

const countsLine = (c: Counts): string => `filled=${c.filled} grounded=${c.grounded} contradicted=${c.contradicted} unverifiable=${c.unverifiable}`

/**
 * Judges every drafted value once, the ingredient list and each cell and each price row, in that order. At the spend cap or a rejected key it stops
 * asking: the values not judged are unverifiable, and what stopped it is returned. Nothing is judged when the run was already stopped.
 */
const judgeAll = async (
  drafted: { cells: DraftedCell[]; prices: DraftedPrice[] },
  c: DraftCase,
  alreadyStopped: Stop,
  judge: DraftJudge,
): Promise<{ cells: Verdict[]; prices: Verdict[]; stopped: Stop }> => {
  let stopped: Stop = alreadyStopped
  const ask = async (request: JudgeRequest): Promise<Verdict> => {
    if (stopped !== null) return NOT_ASKED
    try {
      return await judge.judge(request)
    } catch (error) {
      if (error instanceof AiBudgetExceededError) stopped = 'cap'
      else if (error instanceof AnthropicConfigError) stopped = 'config'
      else throw error
      return NOT_ASKED
    }
  }
  const cells: Verdict[] = []
  for (const { column, value, sourceUrl } of drafted.cells) cells.push(await ask({ product: c.product, column, value, sourceUrl }))
  const prices: Verdict[] = []
  for (const { country, priceMin, priceMax, whereSold, sourceUrl } of drafted.prices) {
    const value = { country, currency: currencyOf(EVAL_COUNTRIES, country) ?? '', priceMin, priceMax, ...(whereSold === undefined ? {} : { whereSold }) }
    prices.push(await ask({ product: c.product, column: 'availability', value, sourceUrl }))
  }
  return { cells, prices, stopped: alreadyStopped === null ? stopped : null }
}
