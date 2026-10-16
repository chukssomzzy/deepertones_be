import { PermanentJobError } from '../../jobs/job'
import { NotFoundError, UnavailableError, ValidationError } from '../../lib/errors'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { AiBudgetExceededError } from '../../providers/anthropic/ai-spend.provider'
import type { CatalogImageStore } from '../../providers/catalog-images/catalog-image-store.provider'
import type { ProductAnalyst } from '../../providers/product-analysis/product-analyst.provider'
import type { ProductForm, ProductIdentity, ProductResearcher } from '../../providers/product-research/product-researcher.provider'
import { type AnalysisProblem, checkAnalysis } from './catalog.analysis'
import { brandKey, identityKey, nearMissCandidates, normaliseText } from './catalog.identity'
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
  /** New-product research attempts allowed in any rolling 24 hours, whatever their outcome. */
  dailyResearchBudget: 200,
  /** Analysis attempts allowed in any rolling 24 hours, whatever their outcome except failed. */
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

/** The day's budget for model calls is spent, or the AI spend cap was reached. Nothing was called; try again later. */
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
 * `fallbackFormulationId` is the product's stale formulation, when it was analysed by the current versions, so a
 * caller that cannot get fresh ingredients can still show an answer.
 */
export type ResearchResult =
  | { kind: 'found'; formulationId: string }
  | { kind: 'not-found'; fallbackFormulationId?: string }
  | { kind: 'budget-exhausted'; fallbackFormulationId?: string }

export type ProductView = {
  product: {
    id: string
    brand: string
    name: string
    variant: string | null
    form: ProductForm | null
    category: Product['category']
    imageUrl: string | null
  }
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

  private static variantsConflict = (a: string | null | undefined, b: string | null | undefined): boolean => {
    const [x, y] = [normaliseText(a ?? ''), normaliseText(b ?? '')]
    return x !== '' && y !== '' && x !== y
  }

  private readonly repository: CatalogRepository
  private readonly researcher: ProductResearcher
  private readonly analyst: ProductAnalyst
  private readonly images: CatalogImageStore
  private readonly imageKeyPrefix: string
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly policy: CatalogPolicy

  constructor(deps: ProductCatalogServiceDeps) {
    this.repository = deps.repository
    this.researcher = deps.researcher
    this.analyst = deps.analyst
    this.images = deps.images
    this.imageKeyPrefix = deps.imageKeyPrefix
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
    this.policy = deps.policy ?? CATALOG_POLICY
  }

  /**
   * Finds the product this label names, or creates it, and says what it needs next. A spelling no key matches
   * is put to the model against the brand's most similar products; a "same product" answer is remembered as an alias.
   */
  async resolve(identity: ProductIdentity): Promise<ResolveResult> {
    const key = identityKey(identity)
    const known = await this.repository.findProductByKey(key)
    if (known) return this.nextStep(known)

    const brandProducts = await this.repository.productsByBrandKey(brandKey(identity.brand), this.policy.brandScanLimit)
    // A shampoo is not its conditioner, nor a night cream its day cream: only the model's call on the rest is worth paying for.
    const comparable = brandProducts.filter(
      (p) => p.category === identity.category && (p.form ?? null) === (identity.form ?? null) && !ProductCatalogService.variantsConflict(p.variant, identity.variant),
    )
    const candidates = nearMissCandidates(identity, comparable, {
      threshold: this.policy.nearMissThreshold,
      limit: this.policy.nearMissLimit,
    })
    for (const candidate of candidates) {
      if (await this.isSameProduct(identity, candidate)) {
        await this.repository.addAlias(key, candidate.id)
        return this.nextStep(candidate)
      }
    }

    // Returns the stored row, so a concurrent scan of the same new product carries on with the winner.
    const created = await this.repository.createProduct({
      id: this.newId(),
      identityKey: key,
      brandKey: brandKey(identity.brand),
      brand: identity.brand,
      name: identity.name,
      variant: identity.variant ?? null,
      form: identity.form ?? null,
      category: identity.category,
      createdAt: this.now(),
    })
    return this.nextStep(created)
  }

  /**
   * Returns the product's formulation when it is still fresh. Otherwise looks the ingredients up online and stores
   * them as a formulation (an identical list is reused and its found time moved to now).
   *
   * Refused without calling the researcher, and without recording an attempt, when the product was not found less than
   * 7 days ago (so a product nobody can find is not paid for on every scan) or the daily budget is spent. A refusal
   * carries the product's stale formulation as a fallback when it was analysed by the current versions.
   *
   * An attempt is recorded as started BEFORE the researcher is called and settled after the ingredients are stored, so a
   * crash in between still counts against the budget; if that cannot be recorded, nothing is called. A failed attempt (an
   * outage, or a store that failed) stops counting, and so does one the AI spend cap stopped, which answers
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
    if (attempts >= this.policy.dailyResearchBudget) return { kind: 'budget-exhausted', ...this.fallbackFor(latest) }

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
      // The AI spend cap stopped the research: like an outage it settles as failed, so it is not cached as not-found and the next scan may try again.
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
    await this.importStockImage(product, result.imageUrl, now)
    return { kind: 'found', formulationId }
  }

  /** Stores the ingredient list read from a back-label photo; an identical list the product already has is reused. */
  async addLabelIngredients(productId: string, ingredients: string[]): Promise<string> {
    await this.requireProduct(productId)
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
    return this.storeFormulation(productId, trimmed, 'label', null, this.now())
  }

  /**
   * Has the model explain the formulation, checks the answer (see checkAnalysis) and stores it in one write.
   *
   * Does nothing when the formulation is already analysed by the current versions, so a repeated job costs nothing.
   * Refused without calling the model, and without recording an attempt, when the daily budget is spent
   * (CatalogBusyError), the analysis has been rejected 3 times at these versions (PermanentJobError), or the formulation's
   * last attempt is still 'started' and began less than 5 minutes ago (AnalysisInProgressError, which is not a rejection).
   * Every other call records one attempt as started BEFORE the model is called, so a crash in between still counts, and
   * settles it afterwards to ok, rejected or failed; if the started attempt cannot be recorded, the model is not called.
   * An answer that passed the check is ok (and counts) even if storing it failed; only a call the model never answered
   * is failed and stops counting: an outage, or one the AI spend cap stopped, which throws CatalogBusyError.
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
    if (attempts >= this.policy.dailyAnalysisBudget) throw new CatalogBusyError()

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
      product: {
        id: product.id,
        brand: product.brand,
        name: product.name,
        variant: product.variant,
        form: product.form,
        category: product.category,
        imageUrl: product.imageKey === null ? null : this.images.publicUrl(product.imageKey),
      },
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

  /** The model's word on a near miss. If the AI spend cap stops the question, the answer is unknown: merging would guess and creating would risk a duplicate, so the scan waits. */
  private async isSameProduct(identity: ProductIdentity, candidate: Product): Promise<boolean> {
    try {
      return await this.analyst.sameProduct(identity, ProductCatalogService.identityOf(candidate))
    } catch (error) {
      if (error instanceof AiBudgetExceededError) throw new CatalogBusyError()
      throw error
    }
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
   * product id only, never a URL, which came from a web page.
   */
  private async importStockImage(product: Product, imageUrl: string | undefined, now: Date): Promise<void> {
    const checkedAt = product.imageCheckedAt
    if (product.imageKey !== null || (checkedAt !== null && now.getTime() - checkedAt.getTime() <= FRESH_FOR_DAYS * ProductCatalogService.DAY))
      return
    try {
      const image = imageUrl ? await this.images.fetchImage(imageUrl) : null
      if (!imageUrl || !image || !(await this.analyst.imageShowsProduct(image, ProductCatalogService.identityOf(product)))) {
        await this.repository.markImageChecked(product.id, now)
        return
      }
      const key = `${this.imageKeyPrefix}/products/${product.id}.${ProductCatalogService.IMAGE_EXTENSIONS[image.mediaType]}`
      await this.images.put(key, image)
      await this.repository.setProductImage(product.id, {
        key,
        sourceUrl: imageUrl,
        checkedAt: now,
      })
    } catch {
      console.error({ outcome: 'image-import-failed', productId: product.id })
    }
  }
}
