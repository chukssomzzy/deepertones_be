import type { StockImageOutcome } from '../../src/modules/catalog/catalog.service'
import type { Verdicts } from './matching-set'

// Pure scoring for `npm run eval:matching` (see matching.ts): what the photos did to the catalog, and whether the targets held.

/** A judge question asked while a photo was resolved: the candidate row it was shown and its answer. */
export type JudgeQuestion = { candidateRowId: string; same: boolean }

/**
 * What one photo did, in the order the photos were processed. `how` says what resolve did: found the row by key,
 * had the judge say a near miss is the same product, or made a new row. `differs` names the identity fields
 * (never their values) that differ from the first readable photo of the same product in this order.
 * `unreadable` is only a photo with nothing to match (not a beauty product, or the recognizer refused it); a failure of
 * ours or the provider's is `error`, carrying the error class name, and fails the run instead of hiding in the denominator.
 */
export type PhotoOutcome =
  | { folder: string; photo: string; unreadable: true }
  | { folder: string; photo: string; error: string }
  | { folder: string; photo: string; rowId: string; how: 'exact-key' | 'judge-same' | 'new-row'; judged: JudgeQuestion[]; differs: string[] }

export type OrderInput = { seed: number; photos: PhotoOutcome[] }

/** Only the look-alike declarations matter to scoring. */
export type ScoringLabels = Record<string, { lookalikes?: string[] }>

export type DuplicateCause = 'judge-said-no' | 'recognition-differed'
export type Duplicate = { rowId: string; photo: string; cause: DuplicateCause; differs: string[] }

export type ProductScore = {
  folder: string
  photos: number
  /** Distinct rows the product's readable photos landed on. */
  rows: number
  /** Share of the readable photos on the row most of them landed on; 1 when none could be read. */
  consistency: number
  hits: number
  repeats: number
  /** Hits over repeats; 1 when there were no repeats. */
  repeatHit: number
  unreadable: number
  errors: number
  duplicates: Duplicate[]
}

export type WrongMerge = { rowId: string; folders: string[]; lookalikes: boolean }

export type OrderScore = {
  seed: number
  products: ProductScore[]
  hits: number
  repeats: number
  repeatHit: number
  unreadable: number
  errors: number
  duplicates: number
  wrongMerges: WrongMerge[]
}

export type MatchingScore = {
  orders: OrderScore[]
  worstRepeatHit: number
  averageRepeatHit: number
  /** Over every order, so a merge in one order is not averaged away. */
  wrongMerges: number
  duplicates: number
  /** Errored photos over every order. */
  errors: number
  /** Distinct error class names, sorted. */
  errorNames: string[]
  /** Every order has a product with at least two readable photos; without one the repeat-hit rate measures nothing. */
  evidence: boolean
}

const ratio = (part: number, whole: number): number => (whole === 0 ? 1 : part / whole)

const scoreProduct = (folder: string, photos: PhotoOutcome[]): ProductScore => {
  const readable = photos.filter((p): p is Extract<PhotoOutcome, { rowId: string }> => 'rowId' in p)
  const perRow = new Map<string, number>()
  const duplicates: Duplicate[] = []
  for (const [index, photo] of readable.entries()) {
    if (photo.how === 'new-row' && index > 0) {
      const earlierRows = new Set(readable.slice(0, index).map((p) => p.rowId))
      const refused = photo.judged.some((question) => !question.same && earlierRows.has(question.candidateRowId))
      duplicates.push({ rowId: photo.rowId, photo: photo.photo, cause: refused ? 'judge-said-no' : 'recognition-differed', differs: photo.differs })
    }
    perRow.set(photo.rowId, (perRow.get(photo.rowId) ?? 0) + 1)
  }
  const firstRow = readable[0]?.rowId
  const repeats = Math.max(0, readable.length - 1)
  const hits = readable.slice(1).filter((p) => p.rowId === firstRow).length
  return {
    folder,
    photos: photos.length,
    rows: perRow.size,
    consistency: ratio(Math.max(0, ...perRow.values()), readable.length),
    hits,
    repeats,
    repeatHit: ratio(hits, repeats),
    unreadable: photos.filter((p) => 'unreadable' in p).length,
    errors: photos.filter((p) => 'error' in p).length,
    duplicates,
  }
}

const wrongMergesOf = (photos: PhotoOutcome[], labels: ScoringLabels): WrongMerge[] => {
  const foldersOnRow = new Map<string, Set<string>>()
  for (const photo of photos) {
    if (!('rowId' in photo)) continue
    foldersOnRow.set(photo.rowId, (foldersOnRow.get(photo.rowId) ?? new Set()).add(photo.folder))
  }
  return [...foldersOnRow]
    .filter(([, folders]) => folders.size > 1)
    .map(([rowId, set]) => {
      const folders = [...set].sort()
      const declared = folders.every((a) => folders.every((b) => a === b || labels[a]?.lookalikes?.includes(b)))
      return { rowId, folders, lookalikes: declared }
    })
}

/** One photo order: per product, then pooled. Repeat-hit is measured against the row the product's first readable photo in this order resolved to. */
export const scoreOrder = (order: OrderInput, labels: ScoringLabels): OrderScore => {
  const byFolder = new Map<string, PhotoOutcome[]>()
  for (const photo of order.photos) byFolder.set(photo.folder, [...(byFolder.get(photo.folder) ?? []), photo])
  const products = [...byFolder].map(([folder, photos]) => scoreProduct(folder, photos))
  const hits = products.reduce((sum, p) => sum + p.hits, 0)
  const repeats = products.reduce((sum, p) => sum + p.repeats, 0)
  return {
    seed: order.seed,
    products,
    hits,
    repeats,
    repeatHit: ratio(hits, repeats),
    unreadable: products.reduce((sum, p) => sum + p.unreadable, 0),
    errors: products.reduce((sum, p) => sum + p.errors, 0),
    duplicates: products.reduce((sum, p) => sum + p.duplicates.length, 0),
    wrongMerges: wrongMergesOf(order.photos, labels),
  }
}

export const scoreMatching = (orders: OrderInput[], labels: ScoringLabels): MatchingScore => {
  const scored = orders.map((order) => scoreOrder(order, labels))
  const rates = scored.map((o) => o.repeatHit)
  const errorNames = [...new Set(orders.flatMap((o) => o.photos).flatMap((p) => ('error' in p ? [p.error] : [])))].sort()
  return {
    orders: scored,
    worstRepeatHit: rates.length === 0 ? 1 : Math.min(...rates),
    averageRepeatHit: rates.length === 0 ? 1 : rates.reduce((sum, r) => sum + r, 0) / rates.length,
    wrongMerges: scored.reduce((sum, o) => sum + o.wrongMerges.length, 0),
    duplicates: scored.reduce((sum, o) => sum + o.duplicates, 0),
    errors: scored.reduce((sum, o) => sum + o.errors, 0),
    errorNames,
    evidence: scored.length > 0 && scored.every((o) => o.repeats > 0),
  }
}

/** What research did with the product's stock image: the catalog's own outcomes, plus the two ways research ended before an image was tried. */
export type ImageStage = StockImageOutcome | 'no-source-page' | 'budget-exhausted'

// A Record keyed by the union, so a stage added to StockImageOutcome fails the typecheck here until it is counted.
const STAGE_NAMES: Record<ImageStage, true> = {
  stored: true,
  'already-has-image': true,
  'checked-recently': true,
  'no-page-image': true,
  'download-failed': true,
  'not-this-product': true,
  error: true,
  'no-source-page': true,
  'budget-exhausted': true,
}
const STAGES = Object.keys(STAGE_NAMES) as ImageStage[]

export type ImageOutcome = {
  folder: string
  stage: ImageStage
  /** sha256 of the stored bytes; only for `stored`. */
  hash?: string
  /** Error class name; only for `error`. */
  error?: string
}

export type ImageVerdict = 'right' | 'wrong' | 'unjudged'

export type ImagesScore = {
  products: number
  stored: number
  /** Stored over products; unjudged images count. */
  coverage: number
  stages: Record<ImageStage, number>
  right: number
  wrong: number
  unjudged: number
  perProduct: { folder: string; stage: ImageStage; hash?: string; verdict?: ImageVerdict; error?: string }[]
  /** Distinct error class names of the products whose stage was `error`, sorted. */
  errorNames: string[]
}

export const scoreImages = (outcomes: ImageOutcome[], verdicts: Verdicts): ImagesScore => {
  const stages = Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<ImageStage, number>
  const perProduct: ImagesScore['perProduct'] = outcomes.map((outcome) => {
    stages[outcome.stage]++
    if (outcome.stage !== 'stored') return { folder: outcome.folder, stage: outcome.stage, ...(outcome.error ? { error: outcome.error } : {}) }
    const verdict: ImageVerdict = (outcome.hash && verdicts[outcome.hash]) || 'unjudged'
    return { folder: outcome.folder, stage: outcome.stage, ...(outcome.hash ? { hash: outcome.hash } : {}), verdict }
  })
  const count = (verdict: ImageVerdict) => perProduct.filter((p) => p.verdict === verdict).length
  return {
    products: outcomes.length,
    stored: stages.stored,
    coverage: outcomes.length === 0 ? 0 : stages.stored / outcomes.length,
    stages,
    right: count('right'),
    wrong: count('wrong'),
    unjudged: count('unjudged'),
    perProduct,
    errorNames: [...new Set(outcomes.flatMap((o) => (o.error ? [o.error] : [])))].sort(),
  }
}

export type Target = { id: string; label: string; met: boolean; actual: string; goal: string }
export type Verdict = { targets: Target[]; /** Stored images with no verdict yet. */ provisional: number; summary: string }

const REPEAT_HIT_GOAL = 0.98
const COVERAGE_GOAL = 0.8
// Ratios of whole numbers can land a hair under the goal in floating point (0.8 is not exact).
const EPSILON = 1e-9
const percent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`

/** Judges each part that ran against its targets; a part that did not run has no targets. */
export const judge = (parts: { matching?: MatchingScore; images?: ImagesScore }): Verdict => {
  const targets: Target[] = []
  const { matching, images } = parts
  if (matching) {
    targets.push(
      { id: 'matching-evidence', label: 'matching evidence', met: matching.evidence, actual: matching.evidence ? 'a repeat in every order' : 'no evidence: an order has no product with 2 readable photos', goal: 'a repeat in every order' },
      { id: 'matching-errors', label: 'matching-errors', met: matching.errors === 0, actual: `${matching.errors} photos errored (see report)`, goal: '0' },
      { id: 'matching-repeat-hit', label: 'worst-order repeat-hit', met: matching.worstRepeatHit >= REPEAT_HIT_GOAL - EPSILON, actual: percent(matching.worstRepeatHit), goal: `>= ${percent(REPEAT_HIT_GOAL)}` },
      { id: 'matching-wrong-merges', label: 'wrong merges', met: matching.wrongMerges === 0, actual: String(matching.wrongMerges), goal: '0' },
    )
  }
  if (images) {
    targets.push(
      { id: 'images-evidence', label: 'images evidence', met: images.products > 0, actual: images.products > 0 ? `${images.products} products` : 'no evidence: no products ran', goal: '>= 1 product' },
      { id: 'images-coverage', label: 'image coverage', met: images.coverage >= COVERAGE_GOAL - EPSILON, actual: percent(images.coverage), goal: `>= ${percent(COVERAGE_GOAL)}` },
      { id: 'images-wrong', label: 'wrong images', met: images.wrong === 0, actual: String(images.wrong), goal: '0' },
    )
  }
  const provisional = images?.unjudged ?? 0
  const lines = targets.map((t) => `${t.met ? '✓' : '✗'} ${t.label}: ${t.actual} (goal ${t.goal})`)
  if (provisional > 0) lines.push(`provisional: ${provisional} images unjudged`)
  return { targets, provisional, summary: lines.join('\n') }
}

/** 0 every judged target met, 1 one was missed. (2, the run could not start, is the runner's.) */
export const exitCode = (verdict: Verdict): 0 | 1 => (verdict.targets.every((t) => t.met) ? 0 : 1)

/**
 * A rough price of one duplicate row in dollars: the research (a Haiku web-search run, about 5 cents) and the analysis (a Sonnet
 * run over the ingredient list, about 3 cents) that the extra row will cost when somebody scans it. The eval does not call them, so
 * this is an estimate to be revisited against `npm run eval:catalog` costs, not a measurement.
 */
export const DUPLICATE_COST_USD = 0.08

export const duplicateCost = (duplicates: number, each: number = DUPLICATE_COST_USD): number => duplicates * each

/** The analysis half of a duplicate's price: the eval never runs analysis, so it is always this constant. */
export const ANALYSIS_COST_USD = 0.03

/**
 * What one duplicate costs per row. When the images part ran, its settled `research` calls are a measurement of the research half
 * (plus the analysis constant); otherwise, or when none settled, the documented constant stands.
 */
export const duplicateUnitCost = (entries: { job: string; status: string; costMicros: number | null }[]): { each: number; source: 'measured' | 'constant' } => {
  const costs = entries.filter((e) => e.job === 'research' && e.status === 'settled' && e.costMicros !== null).map((e) => e.costMicros!)
  if (costs.length === 0) return { each: DUPLICATE_COST_USD, source: 'constant' }
  return { each: costs.reduce((sum, c) => sum + c, 0) / costs.length / 1_000_000 + ANALYSIS_COST_USD, source: 'measured' }
}
