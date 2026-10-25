import { requireUser } from '../../lib/context'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { ingredientParts, ingredientsKey } from '../catalog/catalog.ingredients'
import { flagFacts } from '../catalog/catalog.rules'
import type { ProductCatalogService } from '../catalog/catalog.service'
import { BUDGET_BANDS, type BudgetBand, type ConcernKind, type RoutineStep } from '../catalog/catalog.vocabulary'
import type { CatalogWorkbookService } from '../catalog/catalog.workbook.service'
import { concernsForGoal } from '../face-scans/face-scans.tables'
import type { FaceScanService } from '../face-scans/face-scans.service'
import type { GoalsService } from '../goals/goals.service'
import { anyIn, expandLabels, namedIn } from '../safety/safety.matching'
import type { SafetyService } from '../safety/safety.service'
import type { SafetyMentionRow } from '../safety/safety.types'
import type { RecommendationsRepository } from './recommendations.repository'
import type { Candidate, CandidateRule, ShoppingRow, ShoppingView } from './recommendations.types'

export type RecommendationServiceDeps = {
  repository: RecommendationsRepository
  /** Asked through their services for the guards and the facts a candidate is judged by, never through their repositories. */
  goals: Pick<GoalsService, 'requireGoal'>
  safety: Pick<SafetyService, 'requireAnswered' | 'currentMentions'>
  workbook: Pick<CatalogWorkbookService, 'countries' | 'approvedFor' | 'liveRules'>
  faceScans: Pick<FaceScanService, 'latestSkinType'>
  catalog: Pick<ProductCatalogService, 'productSummaries' | 'latestIngredients'>
  now?: () => Date
  newId?: () => string
}

/** The country as a code of the Countries tab, and the band as `low`, `mid` or `high`. The wire schema only makes sure both are text; the vocabulary is the service's. */
export type SetShoppingInput = { country: string; budgetBand?: string }

/**
 * Where a profile shops and what it will spend, as history (every change appends a row and the newest is the current one), and the one question the
 * routine asks: which reviewed products may be suggested for a step. A guest has a shopping fact as much as a verified user, and it stays with the
 * profile when the guest signs up.
 *
 * Nothing here is decided by a model or paid for by anyone: a candidate is a row of the reviewed catalog that passes fixed rules, ordered by price.
 */
export class RecommendationService {
  private readonly repository: RecommendationsRepository
  private readonly goals: Pick<GoalsService, 'requireGoal'>
  private readonly safety: Pick<SafetyService, 'requireAnswered' | 'currentMentions'>
  private readonly workbook: Pick<CatalogWorkbookService, 'countries' | 'approvedFor' | 'liveRules'>
  private readonly faceScans: Pick<FaceScanService, 'latestSkinType'>
  private readonly catalog: Pick<ProductCatalogService, 'productSummaries' | 'latestIngredients'>
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: RecommendationServiceDeps) {
    this.repository = deps.repository
    this.goals = deps.goals
    this.safety = deps.safety
    this.workbook = deps.workbook
    this.faceScans = deps.faceScans
    this.catalog = deps.catalog
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Saves the country and band for the caller's profile. The country must be an active one of the Countries tab (a retired country is no longer served,
   * so it is refused like an unknown one): 400 `UNKNOWN_COUNTRY`; a band that is not `low`, `mid` or `high` is 400 `UNKNOWN_BUDGET_BAND`. Nothing is stored for a
   * refused request. No band means none: the row says so, and the newest row decides, so saying the country alone takes a band back.
   */
  async setShopping(input: SetShoppingInput): Promise<ShoppingView> {
    const { profileId } = requireUser()
    const country = (await this.workbook.countries()).find((candidate) => candidate.code === input.country)
    if (country?.status !== 'active') throw new ValidationError('UNKNOWN_COUNTRY', 'That country is not one we serve yet', { field: 'country' })
    const budgetBand = input.budgetBand === undefined ? null : RecommendationService.bandOf(input.budgetBand)
    if (input.budgetBand !== undefined && budgetBand === null) {
      throw new ValidationError('UNKNOWN_BUDGET_BAND', 'The budget band is low, mid or high', { field: 'budgetBand' })
    }
    const row: ShoppingRow = { id: this.newId(), profileId, country: country.code, budgetBand, createdAt: this.now() }
    await this.repository.append(row)
    return RecommendationService.view(row)
  }

  /** The caller's current shopping fact, or 404 `SHOPPING_NOT_SET` for a profile that never set one. */
  async currentShopping(): Promise<ShoppingView> {
    const { profileId } = requireUser()
    const row = await this.repository.current(profileId)
    if (!row) throw new NotFoundError('SHOPPING_NOT_SET', 'No shopping country has been set')
    return RecommendationService.view(row)
  }

  /**
   * The reviewed products that may be suggested to the caller's profile for a routine step, cheapest first (by the lowest price, then by code: where a
   * row came from never decides its place). The goal, the safety answers and the shopping fact must all be there first, in that order: 409 `GOAL_REQUIRED`,
   * `SAFETY_ANSWERS_REQUIRED`, `SHOPPING_REQUIRED`. A shopping country that has since been retired gives `[]`, and so does nothing passing: both are normal.
   *
   * A row is kept when it is sold in the country, fills the step, works on at least one of the goal's concerns, suits the skin type (an unknown one
   * only takes rows for all skin types, and is never assumed), costs no more than the band's top in the country's own money, and is clear of what the safety
   * answers rule out. The facts of a row are what the live approved rules find in its ingredients plus the cautions it lists itself, which can only add: a
   * banned substance always leaves a row out, and a pregnancy caution does when the user is pregnant or breastfeeding. Allergens and irritants are for the
   * verdict, not for this list. A product the user named as a reaction or a prescription leaves out the row that is that very product (by product id, resolved
   * or not) and a row that lists exactly the ingredients of its latest list (the same product entered under another spelling). An ingredient they named leaves out
   * any row that lists it, matched whole, as the rules match it and through the labels the live rules give that ingredient ("fragrance" is "parfum", "retinoic acid"
   * is "tretinoin"); a name no rule lists is matched as written and never guessed at. Words not yet parsed name nothing, so the ticked boxes alone apply, and the
   * newest answer only counts.
   *
   * `sharedWithReaction` is information: the candidate's ingredients that a product the user said gave a reaction also holds (by the same labels), so the app can say so.
   */
  async candidatesFor(input: { step: RoutineStep }): Promise<Candidate[]> {
    const { profileId } = requireUser()
    // The guards stay in order, one after the other, so the error says what is missing first.
    const goal = await this.goals.requireGoal()
    const safety = await this.safety.requireAnswered()
    const shopping = await this.repository.current(profileId)
    if (!shopping) throw new ConflictError('SHOPPING_REQUIRED', 'Say which country you shop in first')

    // Everything else is independent of the rest, so it is read together. The rows are read for the stored country whether or not it is still served: a
    // retired one is then answered with none of them.
    const [countries, mentions, skinType, rules, approved] = await Promise.all([
      this.workbook.countries(),
      this.safety.currentMentions(),
      this.faceScans.latestSkinType(),
      this.workbook.liveRules(),
      this.workbook.approvedFor({ country: shopping.country, step: input.step }),
    ])
    const country = countries.find((candidate) => candidate.code === shopping.country)
    if (country?.status !== 'active' || approved.length === 0) return []

    // requireGoal only answers a goal that was sorted, so there is one.
    const concerns = new Set<string>(concernsForGoal(goal.goal!))
    const band = shopping.budgetBand
    const maxPrice = band === 'low' ? country.lowMax : band === 'mid' ? country.midMax : Infinity
    const named = namedIn(mentions, rules.entries)
    const lists = await this.productLists(mentions)
    const listedKeys = new Set(lists.map(({ list }) => ingredientsKey(list)))
    const passed: CandidateRule[] = [
      'country',
      'step',
      'skin-concern',
      'skin-type',
      ...(band === null ? [] : (['budget'] as const)),
      'ingredient-rules',
      ...(named.productIds.size + named.ingredientParts.size > 0 ? (['reactions'] as const) : []),
    ]

    const kept = approved
      .filter((row) => row.skinConcerns.some((concern) => concerns.has(concern)))
      .filter((row) => (skinType === null ? row.skinTypes === 'all' : row.skinTypes === 'all' || row.skinTypes.includes(skinType)))
      .filter((row) => row.priceMin <= maxPrice)
      .filter((row) => {
        const facts = new Set<ConcernKind>([...flagFacts(row.ingredients, rules.entries).map((fact) => fact.kind), ...row.ownCautions])
        return !facts.has('banned-substance') && !(safety.excludesPregnancyCaution && facts.has('pregnancy-caution'))
      })
      .filter((row) => !named.productIds.has(row.productId) && !listedKeys.has(ingredientsKey(row.ingredients)))
      .filter((row) => !row.ingredients.some((ingredient) => anyIn(ingredientParts(ingredient), named.ingredientParts)))
      .sort((a, b) => a.priceMin - b.priceMin || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    if (kept.length === 0) return []

    const summaries = await this.catalog.productSummaries(kept.map((row) => row.formulationId))
    const reacted = lists
      .filter(({ reaction }) => reaction)
      .map(({ productId, list }) => ({ productId, parts: expandLabels(new Set(list.flatMap(ingredientParts)), rules.entries) }))
    const candidates: Candidate[] = []
    for (const row of kept) {
      const product = summaries.get(row.formulationId)
      // A row pins a formulation of a product that exists, so this is a catalog gone wrong; one such row must not take the others down.
      if (!product) {
        console.error({ outcome: 'candidate-product-missing', code: row.code })
        continue
      }
      candidates.push({
        code: row.code,
        product,
        skinConcerns: [...row.skinConcerns],
        ingredients: [...row.ingredients],
        evidenceUrls: [...row.evidenceUrls],
        ingredientsSourceUrl: row.ingredientsSourceUrl,
        passed: [...passed],
        sharedWithReaction: reacted.flatMap(({ productId, parts }) => {
          const shared = row.ingredients.filter((ingredient) => anyIn(ingredientParts(ingredient), parts))
          return shared.length === 0 ? [] : [{ productId, ingredients: shared }]
        }),
        origin: row.origin,
        frequency: row.frequency,
        priceMin: row.priceMin,
        priceMax: row.priceMax,
        whereSold: row.whereSold,
      })
    }
    return candidates
  }

  /**
   * The latest ingredient list the catalog holds for each product the user named as a reaction or a prescription that the parse resolved, in the order they
   * named them, each product once (`reaction` says whether it was named as a reaction: the only ones `sharedWithReaction` is about). A product with no list yet
   * is left out: there is nothing to compare. Reads only, in parallel (the parse names at most three products); nothing is researched.
   */
  private async productLists(mentions: SafetyMentionRow[]): Promise<{ productId: string; reaction: boolean; list: string[] }[]> {
    const products = new Map<string, boolean>()
    for (const mention of mentions) {
      if (mention.kind !== 'product' || mention.resolution !== 'resolved' || mention.productId === null) continue
      products.set(mention.productId, (products.get(mention.productId) ?? false) || mention.source === 'reaction')
    }
    const lists = await Promise.all([...products].map(async ([productId, reaction]) => ({ productId, reaction, list: await this.catalog.latestIngredients(productId) })))
    return lists.flatMap(({ productId, reaction, list }) => (list === null ? [] : [{ productId, reaction, list }]))
  }

  private static bandOf(text: string): BudgetBand | null {
    return BUDGET_BANDS.find((band) => band === text) ?? null
  }

  private static view(row: ShoppingRow): ShoppingView {
    return { country: row.country, budgetBand: row.budgetBand, updatedAt: row.createdAt }
  }
}
