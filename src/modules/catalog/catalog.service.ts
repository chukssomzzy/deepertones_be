import { PermanentJobError } from '../../jobs/job'
import { NotFoundError, UnavailableError, ValidationError } from '../../lib/errors'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { AiBudgetExceededError } from '../../providers/anthropic/ai-spend.provider'
import type { CatalogImageStore } from '../../providers/catalog-images/catalog-image-store.provider'
import type { ProductAnalyst } from '../../providers/product-analysis/product-analyst.provider'
import type { ProductCategory, ProductForm, ProductIdentity, ProductResearcher } from '../../providers/product-research/product-researcher.provider'
import type { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import { type AnalysisProblem, checkAnalysis } from './catalog.analysis'
import { brandFirstWord, brandKey, identityKey, lessSpecific, nearMissCandidates, normaliseText } from './catalog.identity'
import { ingredientsKey } from './catalog.ingredients'
import { REFERENCE_COVERAGE, REFERENCE_VERSION } from './catalog.reference'
import type { CatalogRepository } from './catalog.repository'
import { flagFacts } from './catalog.rules'
import type { Formulation, Product } from './catalog.types'
import { ANALYSIS_VERSION, CONCERN_KINDS, FRESH_FOR_DAYS, SEVERITIES, TRAITS } from './catalog.vocabulary'

export type CatalogPolicy = {
  dailyResearchBudget: number
  dailyAnalysisBudget: number
  brandScanLimit: number
  nearMissThreshold: number
  nearMissLimit: number
}

export const CATALOG_POLICY: CatalogPolicy = {
  /** New-product research attempts in any rolling 24 hours, whatever their outcome, from which an ops alert is raised. They are never refused. */
  dailyResearchBudget: 200,
  /** Analysis attempts in any rolling 24 hours, whatever their outcome except failed, from which an ops alert is raised. They are never refused. */
  dailyAnalysisBudget: 300,
  /** How many of a brand's newest products are compared with a new label. */
  brandScanLimit: 50,
  /** Name similarity (0 to 1) from which a same-brand product is put to the model as a possible match. */
  nearMissThreshold: 0.6,
  /** How many such candidates are put to the model. */
  nearMissLimit: 3,
}

/** The model's analysis broke a rule, so nothing was stored. A later attempt may do better, so it is retryable. `reason` is a fixed code. */
export class AnalysisRejectedError extends UnavailableError {
  constructor(reason: AnalysisProblem) {
    super('ANALYSIS_REJECTED', `The analysis was rejected: ${reason}`)
  }
}

/** Another call is already researching this product. Nothing was called; the queue retries later, by when the first call has stored its result. */
export class ResearchInProgressError extends UnavailableError {
  constructor() {
    super('RESEARCH_IN_PROGRESS', 'This product is already being researched; try again later')
  }
}

/** Another call is already analysing this formulation. Nothing was called, and it is not a rejection; the queue retries later. */
export class AnalysisInProgressError extends UnavailableError {
  constructor() {
    super('ANALYSIS_IN_PROGRESS', 'This formulation is already being analysed; try again later')
  }
}

/**
 * The AI spend cap stopped a model call. Nothing was called; try again later. Only the eval script's MemoryAiSpendLedger still refuses on a
 * cap (the real ledger alerts instead), so in production this is not thrown: it stays so the eval's --max-usd really stops spending.
 */
export class CatalogBusyError extends UnavailableError {
  constructor() {
    super('CATALOG_BUSY', 'The catalog has reached its daily limit; try again later')
  }
}

export type ProductCatalogServiceDeps = {
  repository: CatalogRepository
  researcher: ProductResearcher
  analyst: ProductAnalyst
  images: CatalogImageStore
  /** Where stock images go in the shared public bucket, e.g. `catalog/staging`: the Worker's own corner, apart from the CI-synced assets. */
  imageKeyPrefix: string
  /** Told when a daily research or analysis budget is passed. Never refuses, and never throws. */
  opsAlerts: OpsAlertsService
  now?: () => Date
  newId?: () => string
  policy?: CatalogPolicy
}

/** What a scan of this product needs next. */
export type ResolveResult =
  | { kind: 'ready'; productId: string; formulationId: string }
  | { kind: 'needs-analysis'; productId: string; formulationId: string }
  /** Analysis was rejected too often at the current versions; it is not tried again until one of them changes. */
  | { kind: 'analysis-failed'; productId: string; formulationId: string }
  | { kind: 'needs-research'; productId: string }

/**
 * What the stock image import did on one research run. Research never fails because of the image; this only says what happened.
 * - `stored`: the image downloaded, the model said it shows this product, and it was put and recorded.
 * - `already-has-image`: the product already had an image; nothing was looked up.
 * - `checked-recently`: an image was looked for within FRESH_FOR_DAYS; nothing was looked up.
 * - `no-page-image`: the source page gave no image URL.
 * - `download-failed`: the image URL gave nothing safe to download (bad URL, type or size).
 * - `not-this-product`: the model said the image does not show this product.
 * - `error`: something in the import threw; swallowed, and only the product id is logged.
 */
export type StockImageOutcome =
  | 'stored'
  | 'already-has-image'
  | 'checked-recently'
  | 'no-page-image'
  | 'download-failed'
  | 'not-this-product'
  | 'error'

/**
 * `fallbackFormulationId` is the product's stale formulation, when it was analysed by the current versions, so a
 * caller that cannot get fresh ingredients can still show an answer.
 */
export type ResearchResult =
  | { kind: 'found'; formulationId: string; image?: StockImageOutcome }
  | { kind: 'not-found'; fallbackFormulationId?: string }
  | { kind: 'budget-exhausted'; fallbackFormulationId?: string }

/** The product and formulation a label's list belongs to; `analysed` says whether that formulation is already analysed by the current versions. */
export type LabelResult = { productId: string; formulationId: string; analysed: boolean }

/**
 * A product's identity and stock image, nothing about its formulation: what a search shows, what an identification reads back,
 * and all a scan item carries. Each presenter names the fields it publishes.
 */
export type ProductSummary = {
  id: string
  kind: Product['kind']
  brand: string
  name: string
  variant: string | null
  form: ProductForm | null
  category: Product['category']
  imageUrl: string | null
}

export type ProductView = {
  product: ProductSummary
  formulation: {
    id: string
    ingredients: string[]
    source: { kind: Formulation['sourceKind']; url: string | null }
    foundAt: Date
    analysedAt: Date | null
  }
  concerns: {
    kind: string
    severity: string
    ingredients: string[]
    why: string
    whoShouldTakeCare: string
    traits: string[]
    sources: string[]
  }[]
  /** How much of the regulatory lists the rule checks cover, so a result with no flags is never read as an all-clear. */
  reference: { version: string; coverage: typeof REFERENCE_COVERAGE }
}

export class ProductCatalogService {
  private static readonly DAY = 24 * 60 * 60 * 1000
  /** What the identity key of a product no label named starts with; the rest is the list's ingredients key. */
  private static readonly UNNAMED_PREFIX = 'unnamed:'
  /** The most products a search returns: a list to pick from, not to page through. */
  private static readonly MAX_SEARCH_RESULTS = 10
  /** A query shorter than this, once normalised, would match most of the catalog; the route already refuses it, so it is the service's rule too. */
  private static readonly MIN_SEARCH_LENGTH = 2
  /** How many products without search text one `fillSearchText` call fills. */
  private static readonly FILL_BATCH = 500
  private static readonly MAX_LABEL_INGREDIENTS = 150
  private static readonly MAX_LABEL_INGREDIENT_LENGTH = 120
  private static readonly CONTROL_CHARACTER = /\p{Cc}/u
  private static readonly IMAGE_EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  } as const

  private static readonly WEEK = 7 * ProductCatalogService.DAY
  /** An attempt still 'started' this long after it began is taken to have been lost to a crash, and no longer shields the work from a retry. */
  private static readonly IN_FLIGHT_FOR = 5 * 60 * 1000
  /** Rejections at the same analysis and reference versions after which a formulation is given up on until a version changes. */
  private static readonly MAX_REJECTIONS = 3

  private static identityOf = (product: Product): ProductIdentity => ({
    brand: product.brand,
    name: product.name,
    category: product.category,
    ...(product.variant === null ? {} : { variant: product.variant }),
    ...(product.form === null ? {} : { form: product.form }),
  })

  /** Normalised like a user's query (accents folded), but with pack sizes kept: "50 ml" is a thing a person may type. */
  private static searchTextOf = (product: { brand: string; name: string; variant?: string | null }): string =>
    normaliseText(`${product.brand} ${product.name} ${product.variant ?? ''}`)

  /** A form missing on either side is compatible (the label may simply not print it); two different known forms are different products. */
  private static formsCompatible = (a: string | null | undefined, b: string | null | undefined): boolean => !a || !b || a === b

  /** Only numbers set variants apart for good (SPF 30 and 50, 2% and 5%); any other difference is the judge's to weigh. */
  /**
   * Whether a near miss of one category may be put to the judge for a label of another. The same, or skin care and body care: a soap,
   * a lotion or an oil is read as one on one photo and the other on the next. Hair, makeup and other stay apart from everything else.
   */
  private static categoriesCompatible = (a: ProductCategory, b: ProductCategory): boolean =>
    a === b || (ProductCatalogService.SKIN_OR_BODY.has(a) && ProductCatalogService.SKIN_OR_BODY.has(b))
  private static readonly SKIN_OR_BODY: ReadonlySet<ProductCategory> = new Set<ProductCategory>(['skin', 'body'])

  private static variantsConflict = (a: string | null | undefined, b: string | null | undefined): boolean => {
    const [x, y] = [normaliseText(a ?? '').match(/\d+(?:\.\d+)?/g), normaliseText(b ?? '').match(/\d+(?:\.\d+)?/g)]
    return x !== null && y !== null && x.join(' ') !== y.join(' ')
  }

  private readonly repository: CatalogRepository
  private readonly researcher: ProductResearcher
  private readonly analyst: ProductAnalyst
  private readonly images: CatalogImageStore
  private readonly imageKeyPrefix: string
  private readonly opsAlerts: OpsAlertsService
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly policy: CatalogPolicy

  constructor(deps: ProductCatalogServiceDeps) {
    this.repository = deps.repository
    this.researcher = deps.researcher
    this.analyst = deps.analyst
    this.images = deps.images
    this.imageKeyPrefix = deps.imageKeyPrefix
    this.opsAlerts = deps.opsAlerts
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
    this.policy = deps.policy ?? CATALOG_POLICY
  }

  /**
   * The named products whose brand, name and variant, or any alias, contain what was typed (the query is normalised like the product's
   * search text, so case, accents and punctuation do not matter), best first, at most 10. Makes no model or web call. A query under
   * 2 characters once normalised ("a!") finds nothing and is not run, never every product.
   */
  async search(q: string): Promise<ProductSummary[]> {
    const query = normaliseText(q)
    if (query.length < ProductCatalogService.MIN_SEARCH_LENGTH) return []
    const found = await this.repository.search(query, ProductCatalogService.MAX_SEARCH_RESULTS)
    return found.map((product) => this.summaryOf(product))
  }

  /**
   * A named product by id, for a caller that was offered it by `search`. An id the catalog does not hold, and an unnamed product (which
   * search never offers), are both PRODUCT_NOT_FOUND.
   */
  async namedProduct(productId: string): Promise<ProductSummary> {
    return this.summaryOf(await this.requireNamedProduct(productId))
  }

  /**
   * What a scan of a product the user picked from search needs next: the answer `resolve` gives for the same product, with no lookup
   * by name, no model call and nothing written. PRODUCT_NOT_FOUND for an id the catalog does not hold or an unnamed product.
   */
  async choose(productId: string): Promise<ResolveResult> {
    return this.nextStep(await this.requireNamedProduct(productId))
  }

  /**
   * Gives the named products that have no search text (made before the column existed, or by a Worker that did not know it) the
   * text a new product gets, at most 500 a call. Never touches a product that has text, and makes no model or web call. Returns
   * how many it filled; the scheduled reaper calls it until none are left.
   */
  async fillSearchText(): Promise<number> {
    const missing = await this.repository.namedWithoutSearchText(ProductCatalogService.FILL_BATCH)
    // One write for all of them: a Worker invocation may make only so many subrequests, and one per product would spend them.
    if (missing.length > 0) await this.repository.setSearchTexts(missing.map((product) => ({ id: product.id, searchText: ProductCatalogService.searchTextOf(product) })))
    return missing.length
  }

  /**
   * Finds the product this label names, or creates it, and says what it needs next. A spelling no key matches
   * is put to the model against the brand's most similar products; a "same product" answer is remembered as an alias.
   */
  async resolve(identity: ProductIdentity): Promise<ResolveResult> {
    return this.nextStep(await this.findOrCreateProduct(identity))
  }

  /**
   * The product this label names: found by its key, else by a near miss the model says is the same, else created.
   * A label that prints no category (`category` absent) is compared with the brand's products of every category, and
   * a product made from it is filed under other.
   */
  private async findOrCreateProduct(identity: Omit<ProductIdentity, 'category'> & { category?: ProductIdentity['category'] }): Promise<Product> {
    const key = identityKey(identity)
    const known = await this.repository.findProductByKey(key)
    if (known) return known

    const brandProducts = await this.repository.productsByBrandFamily(brandFirstWord(identity.brand), this.policy.brandScanLimit)
    // A shampoo is not its conditioner, nor SPF 30 its SPF 50, nor a spray its roll-on: only the model's call on the rest is worth paying for.
    const comparable = brandProducts.filter(
      (p) =>
        (identity.category === undefined || ProductCatalogService.categoriesCompatible(p.category, identity.category)) &&
        ProductCatalogService.formsCompatible(p.form, identity.form) &&
        !ProductCatalogService.variantsConflict(p.variant, identity.variant),
    )
    const candidates = nearMissCandidates(identity, comparable, {
      threshold: this.policy.nearMissThreshold,
      limit: this.policy.nearMissLimit,
    })
    // A reading that says less than two or more candidates ("Body Wash" among Deeply Nourishing and Go Fresh) cannot be told from either: a duplicate is safer than a wrong merge.
    const ambiguous = candidates.filter((c) => lessSpecific(identity, c)).length >= 2
    for (const candidate of ambiguous ? [] : candidates) {
      if (await this.isSameProduct({ ...identity, category: identity.category ?? candidate.category }, candidate)) {
        // A reading that says less than the product ("Hydro Boost"), or more than a vague row, or prints no form where the product does, would as an alias claim a
        // look-alike's next reading by exact key; only a reading of equal specificity is remembered.
        const unequal = lessSpecific(identity, candidate) || lessSpecific(candidate, identity) || (!identity.form && !!candidate.form)
        if (!unequal) await this.repository.addAlias(key, candidate.id)
        return candidate
      }
    }

    // Returns the stored row, so a concurrent scan of the same new product carries on with the winner.
    return this.repository.createProduct({
      id: this.newId(),
      identityKey: key,
      brandKey: brandKey(identity.brand),
      kind: 'named',
      brand: identity.brand,
      name: identity.name,
      variant: identity.variant ?? null,
      form: identity.form ?? null,
      category: identity.category ?? 'other',
      searchText: ProductCatalogService.searchTextOf(identity),
      createdAt: this.now(),
    })
  }

  /**
   * Returns the product's formulation when it is still fresh. Otherwise looks the ingredients up online and stores
   * them as a formulation (an identical list is reused and its found time moved to now).
   *
   * Refused without calling the researcher, and without recording an attempt, when the product was not found less than
   * 7 days ago (so a product nobody can find is not paid for on every scan). A refusal carries the product's stale
   * formulation as a fallback when it was analysed by the current versions. The daily budget never refuses: an attempt past it
   * raises the research-budget ops alert (once a day) and goes ahead.
   *
   * An attempt is recorded as started BEFORE the researcher is called and settled after the ingredients are stored, so a
   * crash in between still counts against the budget; if that cannot be recorded, nothing is called. A failed attempt (an
   * outage, or a store that failed) stops counting, and so does one the eval's spend cap stopped, which answers
   * budget-exhausted. Failing to settle never hides what the researcher did or threw.
   *
   * While the product's last attempt is still 'started' and began less than 5 minutes ago, another call is taken to be
   * researching it: this one throws ResearchInProgressError without calling the researcher, and the queue retries it.
   */
  async research(productId: string): Promise<ResearchResult> {
    const product = await this.requireProduct(productId)
    const now = this.now()

    const latest = await this.repository.latestFormulation(productId)
    if (latest && !this.isStale(latest, now)) return { kind: 'found', formulationId: latest.id }

    const last = await this.repository.lastResearchOutcome(productId)
    if (last?.outcome === 'started' && this.isInFlight(last.attemptedAt, now)) throw new ResearchInProgressError()
    if (last?.outcome === 'not-found' && now.getTime() - last.attemptedAt.getTime() < ProductCatalogService.WEEK) {
      return { kind: 'not-found', ...this.fallbackFor(latest) }
    }

    const attempts = await this.repository.researchAttemptsSince(new Date(now.getTime() - ProductCatalogService.DAY))
    if (attempts >= this.policy.dailyResearchBudget) await this.opsAlerts.raise('research-budget')

    const attemptId = this.newId()
    await this.repository.recordResearchAttempt({
      id: attemptId,
      productId,
      attemptedAt: now,
      outcome: 'started',
    })

    let result: Awaited<ReturnType<ProductResearcher['research']>>
    try {
      result = await this.researcher.research(ProductCatalogService.identityOf(product))
    } catch (error) {
      // The eval's spend cap stopped the research (the real ledger never does): like an outage it settles as failed, so it is not cached as not-found and the next scan may try again.
      await this.settleAttempt(attemptId, 'failed')
      if (error instanceof AiBudgetExceededError) return { kind: 'budget-exhausted', ...this.fallbackFor(latest) }
      throw error
    }
    // The list comes from a web page, so it is not stored if any entry carries a link or markup.
    if (!result.found || result.ingredients.some(hasLinkOrMarkup)) {
      await this.settleAttempt(attemptId, 'not-found')
      return { kind: 'not-found', ...this.fallbackFor(latest) }
    }

    // Settled only once the ingredients are stored: until then the 'started' row keeps shielding the product from a concurrent call.
    let formulationId: string
    try {
      formulationId = await this.storeFormulation(productId, result.ingredients, 'web', result.sourceUrl, now)
    } catch (error) {
      await this.settleAttempt(attemptId, 'failed')
      throw error
    }
    await this.settleAttempt(attemptId, 'found')
    // After the formulation is stored, so a failing image can never lose the ingredients.
    const image = await this.importStockImage(product, result.sourceUrl, now)
    return { kind: 'found', formulationId, image }
  }

  /** Stores the ingredient list read from a back-label photo; an identical list the product already has is reused. */
  async addLabelIngredients(productId: string, ingredients: string[]): Promise<string> {
    await this.requireProduct(productId)
    return this.storeFormulation(productId, ProductCatalogService.readableList(ingredients), 'label', null, this.now())
  }

  /**
   * Files a list read from the back of a product that has no product yet, and says which formulation it is. Researches nothing.
   *
   * With both a brand and a name the list belongs to the product they name (found as `resolve` finds it, so a near-miss
   * spelling is put to the model; created if new). Otherwise it belongs to the unnamed product for that list, keyed by the list
   * itself, so the same list from anyone's scan is one formulation, analysed once. When a named product is later given a list an
   * unnamed product holds, that formulation moves to it (same id, so the analysis is kept and items already pointing at it
   * now show the named product), unless the named product already has the list: then its own is used and the unnamed one is left
   * for the items still pointing at it.
   *
   * The list is checked before anything is written (LABEL_UNREADABLE).
   */
  async fromLabel(label: { ingredients: string[]; brand?: string; name?: string; variant?: string; category?: Product['category'] }): Promise<LabelResult> {
    const ingredients = ProductCatalogService.readableList(label.ingredients)
    const listKey = ingredientsKey(ingredients)
    const unnamedKey = `${ProductCatalogService.UNNAMED_PREFIX}${listKey}`
    const brand = label.brand?.trim()
    const name = label.name?.trim()
    const variant = label.variant?.trim()

    if (!brand || !name) {
      const product = await this.repository.createProduct({
        id: this.newId(),
        identityKey: unnamedKey,
        brandKey: '',
        kind: 'unnamed',
        brand: '',
        name: '',
        variant: null,
        form: null,
        category: label.category ?? 'other',
        searchText: '',
        createdAt: this.now(),
      })
      return this.labelResult(product.id, await this.formulationFor(product.id, ingredients, listKey))
    }

    const product = await this.findOrCreateProduct({ brand, name, ...(label.category ? { category: label.category } : {}), ...(variant ? { variant } : {}) })
    const own = await this.repository.findFormulationByIngredientsKey(product.id, listKey)
    if (own) return this.labelResult(product.id, own)

    const unnamed = await this.repository.findProductByKey(unnamedKey)
    const held = unnamed?.kind === 'unnamed' ? await this.repository.findFormulationByIngredientsKey(unnamed.id, listKey) : null
    if (held) {
      try {
        await this.repository.adoptUnnamedFormulation(held.id, product.id)
        return this.labelResult(product.id, held)
      } catch {
        // Whatever stopped the move (a concurrent adopter took the formulation, for this product or another; or a failed write), the
        // formulation is not ours now: use this product's own formulation for the list, or store one. A real outage fails there too.
      }
    }
    return this.labelResult(product.id, await this.formulationFor(product.id, ingredients, listKey))
  }

  /** The product's formulation for this list, as it is; stored as a new label formulation when it has none. */
  private async formulationFor(productId: string, ingredients: string[], listKey: string): Promise<Formulation> {
    const known = await this.repository.findFormulationByIngredientsKey(productId, listKey)
    if (known) return known
    const stored = await this.storeFormulation(productId, ingredients, 'label', null, this.now())
    const formulation = await this.repository.findFormulation(stored)
    if (!formulation) throw new Error(`formulation ${stored} was not stored`)
    return formulation
  }

  private labelResult(productId: string, formulation: Formulation): LabelResult {
    return { productId, formulationId: formulation.id, analysed: this.isAnalysed(formulation) }
  }

  /** The list trimmed, or LABEL_UNREADABLE when it is empty, over its bounds, or carries a link, markup or a control character. */
  private static readableList(ingredients: string[]): string[] {
    const trimmed = ingredients.map((name) => name.trim())
    const readable =
      trimmed.length > 0 &&
      trimmed.length <= ProductCatalogService.MAX_LABEL_INGREDIENTS &&
      trimmed.every(
        (name) =>
          name !== '' &&
          name.length <= ProductCatalogService.MAX_LABEL_INGREDIENT_LENGTH &&
          !ProductCatalogService.CONTROL_CHARACTER.test(name) &&
          !hasLinkOrMarkup(name),
      )
    if (!readable) throw new ValidationError('LABEL_UNREADABLE', 'The ingredient list on the label could not be read')
    return trimmed
  }

  /**
   * Has the model explain the formulation, checks the answer (see checkAnalysis) and stores it in one write.
   *
   * Does nothing when the formulation is already analysed by the current versions, so a repeated job costs nothing.
   * Refused without calling the model, and without recording an attempt, when the analysis has been rejected 3 times at
   * these versions (PermanentJobError), or the formulation's last attempt is still 'started' and began less than 5 minutes
   * ago (AnalysisInProgressError, which is not a rejection). The daily budget never refuses: an attempt past it raises the
   * analysis-budget ops alert (once a day) and goes ahead.
   * Every other call records one attempt as started BEFORE the model is called, so a crash in between still counts, and
   * settles it afterwards to ok, rejected or failed; if the started attempt cannot be recorded, the model is not called.
   * An answer that passed the check is ok (and counts) even if storing it failed; only a call the model never answered
   * is failed and stops counting: an outage, or one the eval's spend cap stopped, which throws CatalogBusyError.
   * Failing to settle never changes the result or the error. A rejected answer leaves any
   * earlier analysis as it was and throws AnalysisRejectedError, or PermanentJobError when it was the 3rd rejection.
   */
  async analyse(formulationId: string): Promise<void> {
    const formulation = await this.repository.findFormulation(formulationId)
    if (!formulation) throw new NotFoundError('FORMULATION_NOT_FOUND', 'Formulation not found')
    if (this.isAnalysed(formulation)) return

    const rejections = await this.repository.rejectedAnalyses(formulationId, ANALYSIS_VERSION, REFERENCE_VERSION)
    if (rejections >= ProductCatalogService.MAX_REJECTIONS) throw new PermanentJobError('The analysis was rejected too often at these versions')
    const now = this.now()
    const last = await this.repository.lastAnalysisAttempt(formulationId)
    if (last?.outcome === 'started' && this.isInFlight(last.attemptedAt, now)) throw new AnalysisInProgressError()
    const attempts = await this.repository.analysisAttemptsSince(new Date(now.getTime() - ProductCatalogService.DAY))
    if (attempts >= this.policy.dailyAnalysisBudget) await this.opsAlerts.raise('analysis-budget')

    const product = await this.requireProduct(formulation.productId)
    const flaggedFacts = flagFacts(formulation.ingredients)
    const attemptId = this.newId()
    await this.repository.recordAnalysisAttempt({
      id: attemptId,
      formulationId,
      attemptedAt: now,
      outcome: 'started',
      analysisVersion: ANALYSIS_VERSION,
      referenceVersion: REFERENCE_VERSION,
    })

    let outcome: 'ok' | 'rejected' | 'failed' = 'failed'
    let problem: AnalysisProblem | undefined
    try {
      const drafts = await this.analyst.analyse({
        product: ProductCatalogService.identityOf(product),
        ingredients: formulation.ingredients,
        flaggedFacts,
        kinds: CONCERN_KINDS,
        severities: SEVERITIES,
        traits: TRAITS,
      })
      const checked = checkAnalysis(drafts, formulation.ingredients, flaggedFacts)
      if (checked.ok) {
        // The model answered and was paid for, so this counts even if storing the answer fails below.
        outcome = 'ok'
        await this.repository.saveAnalysis(formulationId, {
          concerns: checked.concerns,
          analysisVersion: ANALYSIS_VERSION,
          referenceVersion: REFERENCE_VERSION,
          analysedAt: this.now(),
        })
      } else {
        outcome = 'rejected'
        problem = checked.reason
      }
    } catch (error) {
      if (!(error instanceof AiBudgetExceededError)) throw error
      throw new CatalogBusyError()
    } finally {
      // Still 'failed' when the model did not answer (an outage, or a refusal by the spend cap, which did not run it), so that does not use up the day's budget.
      await this.bookkeeping(() => this.repository.settleAnalysisAttempt(attemptId, outcome))
    }
    if (problem) {
      const error = new AnalysisRejectedError(problem)
      throw rejections + 1 >= ProductCatalogService.MAX_REJECTIONS ? new PermanentJobError(error.message, { cause: error }) : error
    }
  }

  /** Everything a result screen shows for a formulation: the product, its ingredients and source, the concerns and the reference coverage. */
  async productView(formulationId: string): Promise<ProductView> {
    const formulation = await this.repository.findFormulation(formulationId)
    if (!formulation) throw new NotFoundError('PRODUCT_NOT_FOUND', 'Product not found')
    const product = await this.requireProduct(formulation.productId)
    const concerns = await this.repository.concernsFor(formulationId)

    return {
      product: this.summaryOf(product),
      formulation: {
        id: formulation.id,
        ingredients: formulation.ingredients,
        source: { kind: formulation.sourceKind, url: formulation.sourceUrl },
        foundAt: formulation.foundAt,
        analysedAt: formulation.analysedAt,
      },
      concerns: concerns.map((c) => ({
        kind: c.kind,
        severity: c.severity,
        ingredients: c.ingredients,
        why: c.why,
        whoShouldTakeCare: c.whoShouldTakeCare,
        traits: c.traits,
        sources: c.sources,
      })),
      reference: { version: REFERENCE_VERSION, coverage: REFERENCE_COVERAGE },
    }
  }

  /**
   * Who the product behind a formulation is, for a screen that must not carry its ingredients or concerns (a scan item). Read
   * through the formulation, not a product id the caller kept: a named label that adopts an unnamed product's list moves the
   * formulation and deletes the unnamed product, and an item already showing it must follow. Reads no concerns.
   */
  async productSummary(formulationId: string): Promise<ProductSummary> {
    const formulation = await this.repository.findFormulation(formulationId)
    if (!formulation) throw new NotFoundError('PRODUCT_NOT_FOUND', 'Product not found')
    return this.summaryOf(await this.requireProduct(formulation.productId))
  }

  /**
   * productSummary for many formulations in two reads, for a list (a shelf). A formulation that does not resolve, or whose product is
   * gone, is left out of the map rather than failing the rest. Reads no concerns.
   */
  async productSummaries(formulationIds: string[]): Promise<Map<string, ProductSummary>> {
    const summaries = new Map<string, ProductSummary>()
    if (formulationIds.length === 0) return summaries
    const formulations = await this.repository.findFormulationsByIds([...new Set(formulationIds)])
    const products = new Map((await this.repository.findProductsByIds([...new Set(formulations.map((f) => f.productId))])).map((p) => [p.id, p]))
    for (const formulation of formulations) {
      const product = products.get(formulation.productId)
      if (product) summaries.set(formulation.id, this.summaryOf(product))
    }
    return summaries
  }

  /** The model's word on a near miss. If the AI spend cap stops the question, the answer is unknown: merging would guess and creating would risk a duplicate, so the scan waits. */
  private async isSameProduct(identity: ProductIdentity, candidate: Product): Promise<boolean> {
    try {
      return await this.analyst.sameProduct(identity, ProductCatalogService.identityOf(candidate))
    } catch (error) {
      if (error instanceof AiBudgetExceededError) throw new CatalogBusyError()
      throw error
    }
  }

  private summaryOf(product: Product): ProductSummary {
    return {
      id: product.id,
      kind: product.kind,
      brand: product.brand,
      name: product.name,
      variant: product.variant,
      form: product.form,
      category: product.category,
      imageUrl: product.imageKey === null ? null : this.images.publicUrl(product.imageKey),
    }
  }

  private async requireNamedProduct(productId: string): Promise<Product> {
    const product = await this.requireProduct(productId)
    if (product.kind !== 'named') throw new NotFoundError('PRODUCT_NOT_FOUND', 'Product not found')
    return product
  }

  private async requireProduct(productId: string): Promise<Product> {
    const product = await this.repository.findProductById(productId)
    if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND', 'Product not found')
    return product
  }

  /**
   * Re-analysis and refresh are lazy: a version bump or an old formulation is only noticed when the product is next
   * scanned, so nothing is paid for products nobody scans again. Exactly FRESH_FOR_DAYS old is still fresh.
   */
  private async nextStep(product: Product): Promise<ResolveResult> {
    const latest = await this.repository.latestFormulation(product.id)
    if (!latest || this.isStale(latest, this.now())) return { kind: 'needs-research', productId: product.id }
    const ids = { productId: product.id, formulationId: latest.id }
    if (this.isAnalysed(latest)) return { kind: 'ready', ...ids }
    const rejections = await this.repository.rejectedAnalyses(latest.id, ANALYSIS_VERSION, REFERENCE_VERSION)
    return {
      kind: rejections >= ProductCatalogService.MAX_REJECTIONS ? 'analysis-failed' : 'needs-analysis',
      ...ids,
    }
  }

  /** A 'started' attempt this young is still running somewhere; exactly IN_FLIGHT_FOR old is taken as lost. */
  private isInFlight(startedAt: Date, now: Date): boolean {
    return now.getTime() - startedAt.getTime() < ProductCatalogService.IN_FLIGHT_FOR
  }

  private isStale(formulation: Formulation, now: Date): boolean {
    return now.getTime() - formulation.foundAt.getTime() > FRESH_FOR_DAYS * ProductCatalogService.DAY
  }

  private isAnalysed(formulation: Formulation): boolean {
    return formulation.analysisVersion === ANALYSIS_VERSION && formulation.referenceVersion === REFERENCE_VERSION
  }

  /** The stale formulation to show when fresh research is not possible, if it is worth showing: analysed by the current versions. */
  private fallbackFor(latest: Formulation | null): { fallbackFormulationId?: string } {
    return latest && this.isAnalysed(latest) ? { fallbackFormulationId: latest.id } : {}
  }

  private async settleAttempt(attemptId: string, outcome: 'found' | 'not-found' | 'failed'): Promise<void> {
    await this.bookkeeping(() => this.repository.settleResearchAttempt(attemptId, outcome))
  }

  /** Attempt records are accounting, not the work itself: a failure to write one must not hide the work's result or error. The log has no detail. */
  private async bookkeeping(write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch {
      console.error({ outcome: 'attempt-bookkeeping-failed' })
    }
  }

  private async storeFormulation(
    productId: string,
    ingredients: string[],
    sourceKind: Formulation['sourceKind'],
    sourceUrl: string | null,
    foundAt: Date,
  ): Promise<string> {
    // The repository returns the product's existing formulation for this list (an earlier scan, or a concurrent one), so
    // two writers converge on one row.
    const id = this.newId()
    const stored = await this.repository.createFormulation({
      id,
      productId,
      ingredients,
      ingredientsKey: ingredientsKey(ingredients),
      sourceKind,
      sourceUrl,
      foundAt,
    })
    if (stored.id !== id) await this.repository.touchFormulation(stored.id, foundAt)
    return stored.id
  }

  /**
   * Gives the product a stock image, once, when none is stored and none was looked for in the last FRESH_FOR_DAYS.
   * The image is stored only after it downloads safely AND the model says it shows this product. Nothing in here
   * may fail the research: the ingredients are already stored, and a missing image is normal. The log carries the
   * product id only, never a URL, which came from a web page. Says what happened, for the caller to report.
   */
  private async importStockImage(product: Product, sourceUrl: string, now: Date): Promise<StockImageOutcome> {
    const checkedAt = product.imageCheckedAt
    if (product.imageKey !== null) return 'already-has-image'
    if (checkedAt !== null && now.getTime() - checkedAt.getTime() <= FRESH_FOR_DAYS * ProductCatalogService.DAY) return 'checked-recently'
    try {
      const imageUrl = await this.images.pageImageUrl(sourceUrl)
      const image = imageUrl ? await this.images.fetchImage(imageUrl) : null
      if (!imageUrl || !image) {
        await this.repository.markImageChecked(product.id, now)
        return imageUrl ? 'download-failed' : 'no-page-image'
      }
      if (!(await this.analyst.imageShowsProduct(image, ProductCatalogService.identityOf(product)))) {
        await this.repository.markImageChecked(product.id, now)
        return 'not-this-product'
      }
      const key = `${this.imageKeyPrefix}/products/${product.id}.${ProductCatalogService.IMAGE_EXTENSIONS[image.mediaType]}`
      await this.images.put(key, image)
      await this.repository.setProductImage(product.id, {
        key,
        sourceUrl: imageUrl,
        checkedAt: now,
      })
      return 'stored'
    } catch {
      console.error({ outcome: 'image-import-failed', productId: product.id })
      return 'error'
    }
  }
}
