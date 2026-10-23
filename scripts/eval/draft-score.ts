/*
 * The pure half of `npm run eval:catalog -- --mode draft` (draft-run.ts is the orchestration): what the drafter put in a workbook, what a judge said about
 * each value, and the scores and the gate computed from the two. Nothing here calls the API or prints, so all of it is tested (draft-score.test.ts).
 */
import type { RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import type { DraftCountry } from '../../src/providers/catalog-drafting/catalog-drafter.provider'
import type { DraftCaseKind, DraftExpected } from './draft-cases'
import type { HumanCheck } from './draft-human-checks'

/** The Products columns a draft can fill: the four the drafter writes and the ingredient list the researcher writes. */
export const COLUMNS = ['ingredients', 'skin_concerns', 'skin_types', 'steps', 'frequency'] as const
export type Column = (typeof COLUMNS)[number]
const LIST_COLUMNS: readonly Column[] = ['ingredients', 'skin_concerns', 'skin_types', 'steps']

type Answer = 'yes' | 'no' | 'unclear'

/**
 * Why a verdict vouches for nothing, as a fixed code (never a model's words). `cut-off` is also what a value gets that was never asked about because the
 * run stopped at the spend cap or on a rejected key: the run was cut off before it.
 */
export const UNVERIFIABLE_REASONS = ['not-fetched', 'fetch-failed', 'cut-off', 'refused', 'unreadable-answer', 'api-error'] as const
export type UnverifiableReason = (typeof UNVERIFIABLE_REASONS)[number]

/** What the judge said about one value and the page it cites. `currencyShown` and `pricesShown` (the whole-number prices the page shows for this exact product) are only ever given for a price row; `reason` only when `fetched` is false. */
export type Verdict = { fetched: boolean; exactProduct: Answer; supports: Answer; currencyShown?: string | null; pricesShown?: number[]; reason?: UnverifiableReason }

export type DraftedCell = { column: Column; value: string | string[]; sourceUrl: string }
export type DraftedPrice = { country: string; priceMin: number; priceMax: number; whereSold?: string; sourceUrl: string }

const entriesOf = (cell: unknown): string[] =>
  typeof cell === 'string'
    ? cell
        .split(';')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
    : []

/** The page each marked cell was drafted from: `draft_cells` is `column=https-link` entries, and a link can hold "=" itself. */
const markedPages = (cell: unknown): Map<string, string> => {
  const pages = new Map<string, string>()
  for (const entry of entriesOf(cell)) {
    const equals = entry.indexOf('=')
    if (equals > 0 && !pages.has(entry.slice(0, equals))) pages.set(entry.slice(0, equals), entry.slice(equals + 1))
  }
  return pages
}

/**
 * What the tool put in the drafted workbook for one product, read back from the file's own cells: each marked cell with its value and page, in column
 * order, and the product's Availability rows. A cell the tool did not mark is a person's and is left out; `ingredients_source_url` is the ingredient list's
 * page, not a value.
 */
export const draftedValuesOf = (workbook: RawWorkbook, code: string): { cells: DraftedCell[]; prices: DraftedPrice[] } => {
  const row = workbook.products.rows.find((r) => r.code === code)
  const pages = markedPages(row?.draft_cells)
  const cells: DraftedCell[] = []
  for (const column of COLUMNS) {
    const sourceUrl = pages.get(column)
    if (row === undefined || sourceUrl === undefined) continue
    const items = entriesOf(row[column])
    if (items.length === 0) continue
    cells.push({ column, value: LIST_COLUMNS.includes(column) ? items : items.join('; '), sourceUrl })
  }
  const prices = workbook.availability.rows
    .filter((r) => r.product_code === code)
    .map((r): DraftedPrice => {
      const whereSold = typeof r.where_sold === 'string' ? r.where_sold.trim() : ''
      return { country: String(r.country), priceMin: Number(r.price_min), priceMax: Number(r.price_max), ...(whereSold === '' ? {} : { whereSold }), sourceUrl: String(r.source_url ?? '') }
    })
  return { cells, prices }
}

export type CaseState = 'drafted' | 'failed' | 'skipped' | 'cut-off'

/** A value a person's check turned over: what the judge had said (as a bucket), and what the person said. The note is for the report, never the console. */
export type Overruled = { value: string; judge: 'grounded' | 'contradicted' | 'unverifiable'; human: HumanCheck['verdict']; note: string }

export type CaseInput = {
  id: string
  kind: DraftCaseKind
  /** The countries the case asked about, each with the currency of its Countries row. */
  countries: DraftCountry[]
  state: CaseState
  /** Why a failed case failed, as a fixed code. */
  reason?: string
  /** The class name of the error behind a failed case (never its message). */
  errorName?: string
  expected?: DraftExpected
  cells: (DraftedCell & { verdict: Verdict })[]
  prices: (DraftedPrice & { verdict: Verdict })[]
  costMicros: number
  /** Set by applyHumanChecks. */
  overruled?: Overruled[]
}

export type Counts = { filled: number; grounded: number; contradicted: number; unverifiable: number }
export type AvailabilityCounts = { rows: number; grounded: number; contradicted: number; unverifiable: number; wrongCurrency: number }
export type TrapResult = { passed: boolean; problems: string[] }
/** Unverifiable values by why: the judge's reasons, and "unclear" for a page that was fetched but did not settle the value. */
export type UnverifiableCounts = Record<UnverifiableReason | 'unclear', number>

/** A country's budget bands: a price up to `lowMax` is low, up to `midMax` is mid, above that is high. The Countries tab's low_max and mid_max. */
export type Bands = { lowMax: number; midMax: number }
export type Band = 'low' | 'mid' | 'high'

export const bandOf = (amount: number, { lowMax, midMax }: Bands): Band => (amount <= lowMax ? 'low' : amount <= midMax ? 'mid' : 'high')

/**
 * Price coverage and band accuracy, reported beside the gate and never part of it. Coverage: of the product-country pairs a drafted ordinary case asked
 * about, how many got a price row. Band accuracy: of the rows whose page the judge could read a price on, how many put the product in the band the page puts
 * it in (the drafted range's midpoint against the median of the prices shown). A row with no readable page price is band-unknown, neither right nor wrong.
 */
export type PriceScore = {
  asked: number
  priced: number
  byCountry: Record<string, { asked: number; priced: number }>
  bandCorrect: number
  bandKnown: number
  bandUnknown: number
}

const noPrices = (): PriceScore => ({ asked: 0, priced: 0, byCountry: {}, bandCorrect: 0, bandKnown: 0, bandUnknown: 0 })

export type CaseScore = {
  id: string
  kind: DraftCaseKind
  state: CaseState
  reason?: string
  errorName?: string
  costMicros: number
  columns: Record<Column, Counts>
  availability: AvailabilityCounts
  values: Counts
  unverifiableReasons: UnverifiableCounts
  /** The values a person's check turned over from the judge's verdict. */
  overruled: Overruled[]
  prices: PriceScore
  /** Whether each drafted value falls in the case's plausible set ("price:NG" for a price row). Reported only, never part of the gate. */
  agreement: Record<string, 'agree' | 'disagree'>
  /** Null for an ordinary case. */
  trap: TrapResult | null
}

type Bucket = 'grounded' | 'contradicted' | 'unverifiable'

/** A page that was not fetched says nothing. One that says no, or is about a different product, contradicts the value, even when the rest is unclear. */
const bucketOf = ({ fetched, exactProduct, supports }: Verdict): Bucket => {
  if (!fetched) return 'unverifiable'
  if (exactProduct === 'no' || supports === 'no') return 'contradicted'
  return exactProduct === 'yes' && supports === 'yes' ? 'grounded' : 'unverifiable'
}

const HUMAN_VERDICT: Record<HumanCheck['verdict'], Verdict> = {
  correct: { fetched: true, exactProduct: 'yes', supports: 'yes', currencyShown: null },
  wrong: { fetched: true, exactProduct: 'yes', supports: 'no', currencyShown: null },
}

/**
 * A person's verdict on a drafted value wins over the judge's: correct is grounded, wrong is contradicted (and a price a person found correct is not in
 * the wrong currency). A check applies only to the value it was made on, so a run that drafts something else for that column keeps the judge's verdict.
 * The values whose bucket changed are listed in `overruled`. The input is not changed.
 */
export const applyHumanChecks = (input: CaseInput, checks: HumanCheck[]): CaseInput => {
  const overruled: Overruled[] = []
  const decide = (name: string, drafted: string, verdict: Verdict): Verdict => {
    const check = checks.find((c) => c.caseId === input.id && c.column === name && c.value === drafted)
    if (check === undefined) return verdict
    const before = bucketOf(verdict)
    const after = HUMAN_VERDICT[check.verdict]
    if (before !== bucketOf(after)) overruled.push({ value: name, judge: before, human: check.verdict, note: check.note })
    // The page's prices are a fact about the page, not about the value, so a person's verdict on the value leaves them be.
    return { ...after, ...(verdict.pricesShown === undefined ? {} : { pricesShown: verdict.pricesShown }) }
  }
  return {
    ...input,
    cells: input.cells.map((cell) => ({ ...cell, verdict: decide(cell.column, [cell.value].flat().join('; '), cell.verdict) })),
    prices: input.prices.map((price) => ({ ...price, verdict: decide(`price:${price.country}`, `${price.priceMin}-${price.priceMax}`, price.verdict) })),
    overruled: [...(input.overruled ?? []), ...overruled],
  }
}

const noCounts = (): Counts => ({ filled: 0, grounded: 0, contradicted: 0, unverifiable: 0 })

const addCounts = (into: Counts, from: Counts) => {
  into.filled += from.filled
  into.grounded += from.grounded
  into.contradicted += from.contradicted
  into.unverifiable += from.unverifiable
}

const noReasons = (): UnverifiableCounts => ({ ...Object.fromEntries(UNVERIFIABLE_REASONS.map((reason) => [reason, 0])), unclear: 0 }) as UnverifiableCounts

/** Why a value is unverifiable, when it is: a verdict from a fake or an older run that gives no reason for a page not fetched is "not-fetched". */
const reasonOf = (verdict: Verdict): keyof UnverifiableCounts | undefined =>
  bucketOf(verdict) !== 'unverifiable' ? undefined : verdict.fetched ? 'unclear' : (verdict.reason ?? 'not-fetched')

export const currencyOf = (countries: DraftCountry[], code: string): string | undefined => countries.find((country) => country.code === code)?.currency

/** The page showed a price in another currency than its country's. A page that was not fetched, or showed none, or a country with no currency, is not counted. */
export const isWrongCurrency = (price: CaseInput['prices'][number], countries: DraftCountry[]): boolean => {
  const { fetched, currencyShown } = price.verdict
  const expected = currencyOf(countries, price.country)
  return fetched && typeof currencyShown === 'string' && expected !== undefined && currencyShown !== expected
}

const PLAUSIBLE = {
  skin_concerns: 'skinConcernsPlausible',
  skin_types: 'skinTypesPlausible',
  steps: 'stepsPlausible',
  frequency: 'frequencyPlausible',
} as const satisfies Partial<Record<Column, keyof DraftExpected>>

const agreementOf = ({ cells, prices, expected }: CaseInput): CaseScore['agreement'] => {
  const agreement: CaseScore['agreement'] = {}
  for (const { column, value } of cells) {
    if (!(column in PLAUSIBLE)) continue
    const plausible = expected?.[PLAUSIBLE[column as keyof typeof PLAUSIBLE]]
    if (plausible === undefined) continue
    agreement[column] = [value].flat().every((item) => plausible.includes(item)) ? 'agree' : 'disagree'
  }
  // A price the case says there is none for is held against the tool; a missing price for a country the product is sold in is not (a shop may simply not be searchable).
  for (const { country } of prices) {
    const sold = expected?.soldIn?.[country]
    if (sold === true) agreement[`price:${country}`] = 'agree'
    else if (sold === false) agreement[`price:${country}`] = 'disagree'
  }
  return agreement
}

const medianOf = (numbers: number[]): number => {
  const sorted = [...numbers].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** Only an ordinary case that was drafted is asked for prices; a trap's prices are held against the tool by the trap, and a case that stopped part-way asked nothing. */
const priceScoreOf = (input: CaseInput, bands: Record<string, Bands>): PriceScore => {
  const score = noPrices()
  if (input.kind !== 'ordinary' || input.state !== 'drafted') return score
  for (const { code } of input.countries) {
    const priced = input.prices.some((price) => price.country === code)
    score.byCountry[code] = { asked: 1, priced: priced ? 1 : 0 }
    score.asked++
    if (priced) score.priced++
  }
  for (const { country, priceMin, priceMax, verdict } of input.prices) {
    const countryBands = bands[country]
    const shown = verdict.fetched ? (verdict.pricesShown ?? []) : []
    if (countryBands === undefined || shown.length === 0) {
      score.bandUnknown++
      continue
    }
    score.bandKnown++
    if (bandOf((priceMin + priceMax) / 2, countryBands) === bandOf(medianOf(shown), countryBands)) score.bandCorrect++
  }
  return score
}

const trapOf = (input: CaseInput): TrapResult | null => {
  if (input.kind === 'ordinary') return null
  // A trap that never ran, or ran in part, proves nothing, however empty its result looks.
  if (input.state !== 'drafted') return { passed: false, problems: [`case-${input.state}`] }

  const problems: string[] = []
  if (input.kind === 'trap-sibling') {
    for (const { column, verdict } of input.cells) if (verdict.fetched && verdict.exactProduct === 'no') problems.push(`wrong-product:${column}`)
    for (const { country, verdict } of input.prices) if (verdict.fetched && verdict.exactProduct === 'no') problems.push(`wrong-product:price:${country}`)
  } else if (input.kind === 'trap-foreign-currency') {
    for (const price of input.prices) {
      if (input.expected?.soldIn?.[price.country] === false) problems.push(`price-without-local-price:${price.country}`)
      if (isWrongCurrency(price, input.countries)) problems.push(`wrong-currency:${price.country}`)
    }
  } else if (input.kind === 'trap-unbranded') {
    for (const { column } of input.cells) problems.push(`drafted:${column}`)
    for (const { country } of input.prices) problems.push(`drafted:price:${country}`)
  } else {
    // A real product that is not for a routine still has an ingredient list and a price; what it must not get is a skincare value.
    for (const { column } of input.cells) if (column !== 'ingredients') problems.push(`drafted:${column}`)
  }
  return { passed: problems.length === 0, problems }
}

export const scoreDraftCase = (input: CaseInput, bands: Record<string, Bands> = {}): CaseScore => {
  const columns = Object.fromEntries(COLUMNS.map((column) => [column, noCounts()])) as Record<Column, Counts>
  for (const { column, verdict } of input.cells) {
    columns[column].filled++
    columns[column][bucketOf(verdict)]++
  }
  const availability: AvailabilityCounts = { rows: input.prices.length, grounded: 0, contradicted: 0, unverifiable: 0, wrongCurrency: 0 }
  for (const price of input.prices) {
    availability[bucketOf(price.verdict)]++
    if (isWrongCurrency(price, input.countries)) availability.wrongCurrency++
  }
  const unverifiableReasons = noReasons()
  for (const { verdict } of [...input.cells, ...input.prices]) {
    const reason = reasonOf(verdict)
    if (reason !== undefined) unverifiableReasons[reason]++
  }
  const values = noCounts()
  for (const column of COLUMNS) addCounts(values, columns[column])
  addCounts(values, { filled: availability.rows, grounded: availability.grounded, contradicted: availability.contradicted, unverifiable: availability.unverifiable })

  return {
    id: input.id,
    kind: input.kind,
    state: input.state,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.errorName === undefined ? {} : { errorName: input.errorName }),
    costMicros: input.costMicros,
    columns,
    availability,
    values,
    unverifiableReasons,
    overruled: input.overruled ?? [],
    prices: priceScoreOf(input, bands),
    agreement: agreementOf(input),
    trap: trapOf(input),
  }
}

/** Why the gate does not hold. */
export type GateFailure = 'contradicted-rate' | 'unverifiable-rate' | 'wrong-currency' | 'traps' | 'incomplete' | 'no-values'

export type DraftSummary = {
  cases: number
  columns: Record<Column, Counts>
  availability: AvailabilityCounts
  values: Counts
  unverifiableReasons: UnverifiableCounts
  prices: PriceScore
  /** Every value a person's check turned over, with its case. */
  overruled: (Overruled & { caseId: string })[]
  costMicros: number
  failed: number
  skipped: number
  cutOff: number
  traps: { total: number; passed: number }
  agreement: { agree: number; disagree: number }
  /** Contradicted values over drafted values; 0 when nothing was drafted. */
  contradictedRate: number
  /** Unverifiable values over drafted values; 0 when nothing was drafted. */
  unverifiableRate: number
  gate: { holds: boolean; failures: GateFailure[] }
}

// The gate's two rates, held as whole percents and compared in integers so a value exactly on the line (1 in 20, 7 in 20) does not depend on float rounding.
const MAX_CONTRADICTED_PERCENT = 5
// A judge that cannot read the pages vouches for nothing, and a run it cannot check must not pass.
const MAX_UNVERIFIABLE_PERCENT = 35

export const summariseDraft = (scores: CaseScore[]): DraftSummary => {
  const columns = Object.fromEntries(COLUMNS.map((column) => [column, noCounts()])) as Record<Column, Counts>
  const availability: AvailabilityCounts = { rows: 0, grounded: 0, contradicted: 0, unverifiable: 0, wrongCurrency: 0 }
  const values = noCounts()
  const unverifiableReasons = noReasons()
  const agreement = { agree: 0, disagree: 0 }
  const prices = noPrices()
  const overruled: DraftSummary['overruled'] = []
  let costMicros = 0
  for (const score of scores) {
    for (const column of COLUMNS) addCounts(columns[column], score.columns[column])
    for (const key of Object.keys(availability) as (keyof AvailabilityCounts)[]) availability[key] += score.availability[key]
    addCounts(values, score.values)
    for (const reason of Object.keys(unverifiableReasons) as (keyof UnverifiableCounts)[]) unverifiableReasons[reason] += score.unverifiableReasons[reason]
    for (const verdict of Object.values(score.agreement)) agreement[verdict]++
    for (const key of ['asked', 'priced', 'bandCorrect', 'bandKnown', 'bandUnknown'] as const) prices[key] += score.prices[key]
    for (const [code, counts] of Object.entries(score.prices.byCountry)) {
      const into = (prices.byCountry[code] ??= { asked: 0, priced: 0 })
      into.asked += counts.asked
      into.priced += counts.priced
    }
    overruled.push(...score.overruled.map((o) => ({ caseId: score.id, ...o })))
    costMicros += score.costMicros
  }

  const trapped = scores.filter((score) => score.trap !== null)
  const traps = { total: trapped.length, passed: trapped.filter((score) => score.trap?.passed).length }
  const incomplete = scores.filter((score) => score.state !== 'drafted').length

  const failures: GateFailure[] = []
  if (values.contradicted * 100 > values.filled * MAX_CONTRADICTED_PERCENT) failures.push('contradicted-rate')
  if (values.unverifiable * 100 > values.filled * MAX_UNVERIFIABLE_PERCENT) failures.push('unverifiable-rate')
  if (availability.wrongCurrency > 0) failures.push('wrong-currency')
  if (traps.passed < traps.total) failures.push('traps')
  // A run of no cases measured nothing.
  if (incomplete > 0 || scores.length === 0) failures.push('incomplete')
  // Both rates are fractions of the values drafted, so a run that drafted none (a drafter that returns nothing) would pass them by dividing nothing by nothing.
  if (values.filled === 0) failures.push('no-values')

  return {
    cases: scores.length,
    columns,
    availability,
    values,
    unverifiableReasons,
    prices,
    overruled,
    costMicros,
    failed: scores.filter((score) => score.state === 'failed').length,
    skipped: scores.filter((score) => score.state === 'skipped').length,
    cutOff: scores.filter((score) => score.state === 'cut-off').length,
    traps,
    agreement,
    contradictedRate: values.filled === 0 ? 0 : values.contradicted / values.filled,
    unverifiableRate: values.filled === 0 ? 0 : values.unverifiable / values.filled,
    gate: { holds: failures.length === 0, failures },
  }
}

export const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`

/** One case on one line: ids, fixed codes and numbers, never a model's words. */
export const formatCaseLine = (score: CaseScore): string => {
  const { filled, grounded, contradicted, unverifiable } = score.values
  const parts = [score.id, score.kind, `filled=${filled}`, `grounded=${grounded}`, `contradicted=${contradicted}`, `unverifiable=${unverifiable}`, usd(score.costMicros)]
  if (score.trap !== null) parts.push(`trap=${score.trap.passed ? 'pass' : 'FAIL'}`)
  if (score.state !== 'drafted') parts.push(score.reason === undefined ? score.state : `${score.state} (${score.reason}${score.errorName === undefined ? '' : `: ${score.errorName}`})`)
  return parts.join('  ')
}

/** One decimal, so the number shown is the one the gate's whole-percent line is judged against. 0 of 0 is 0.0%. */
export const percent = (part: number, whole: number): string => `${(whole === 0 ? 0 : (part / whole) * 100).toFixed(1)}%`

export const formatUnverifiableLine = (summary: DraftSummary): string =>
  `unverifiable by reason: ${(Object.entries(summary.unverifiableReasons) as [string, number][]).map(([reason, count]) => `${reason}=${count}`).join(' ')}`

/** How many values a person overruled the judge on, and which: case, column and the two verdicts, never the note. */
export const formatOverruledLines = (summary: DraftSummary): string[] => [
  `judge overruled by a person: ${summary.overruled.length}`,
  ...summary.overruled.map((o) => `  ${o.caseId} ${o.value} judge=${o.judge} person=${o.human}`),
]

/** Coverage and band accuracy on one line. Reported, not gated; 0 of 0 is 0.0%, not NaN. */
export const formatPricesLine = ({ prices }: DraftSummary): string => {
  const countries = Object.entries(prices.byCountry).map(([code, c]) => `${code} ${c.priced}/${c.asked}`)
  return `Prices: coverage ${prices.priced}/${prices.asked} (${percent(prices.priced, prices.asked)})${countries.map((c) => ` ${c}`).join('')}; band-correct ${prices.bandCorrect}/${prices.bandKnown} (${percent(prices.bandCorrect, prices.bandKnown)}), band unknown ${prices.bandUnknown}`
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The gate's verdict and what it covered. A run with no trap in it (a --limit trial) is not the gate, and says so even when it passes: the traps are
 * the part of the gate that a small slice of the set may not reach.
 */
export const formatGateLine = (summary: DraftSummary): string => {
  const coverage = summary.traps.total === 0 ? 'no traps covered' : plural(summary.traps.total, 'trap')
  if (summary.gate.holds) return summary.traps.total === 0 ? `Gate: PASS (${coverage})` : `Gate: PASS (${plural(summary.cases, 'case')}, ${coverage})`
  return `Gate: FAIL (${summary.gate.failures.join(', ')}; ${plural(summary.cases, 'case')}, ${coverage})`
}
