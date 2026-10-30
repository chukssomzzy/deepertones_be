import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { chunked, queryByIds, type Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { SHOWN_CONCERNS, type ShownConcern, type SkinTypeLabel } from '../face-scans/face-scans.tables'
import { formulations, productAliases, products } from './catalog.table'
import type { NewProduct } from './catalog.types'
import type { ReferenceEntry } from './catalog.reference'
import type { ConcernKind, EscalationReason, Frequency, Origin, ResponseOutcome, RoutineStep, WeekBand } from './catalog.vocabulary'
import {
  compareEscalations,
  compareGuides,
  compareReintroductions,
  compareResponses,
  compareWeeks,
  guideKey,
  reintroductionKey,
  weekKey,
  type AvailabilityRow,
  type ClaimWordRow,
  type CountryRow,
  type EscalationRow,
  type GuideRow,
  type IngredientRule,
  type ProductRow,
  type ReintroductionRow,
  type ResponseRow,
  type TaperRow,
  type WeekRow,
  type Workbook,
} from './catalog.workbook.schema'
import { catalogVersions, claimWords, countries, escalations, guides, ingredientRules, productAvailability, recommendedProducts, reintroductions, responses, tapers, weeks } from './catalog.workbook.table'

/** The approved ingredient rules in the shape the matcher reads, and the rules version they are under. */
export type LiveRules = { version: string; entries: ReferenceEntry[] }

/** What the recommendation module reads of an approved row: the product it is, the list it pins, and the price and place in one country. */
export type Recommendation = {
  code: string
  productId: string
  formulationId: string
  ingredients: string[]
  skinConcerns: ShownConcern[]
  skinTypes: SkinTypeLabel[] | 'all'
  steps: RoutineStep[]
  frequency: Frequency
  ownCautions: ConcernKind[]
  evidenceUrls: string[]
  ingredientsSourceUrl: string | null
  keyIngredient: string | null
  strength: string | null
  origin: Origin
  priceMin: number
  priceMax: number
  whereSold: string | null
}

export type Country = CountryRow

/**
 * What the routine screen reads of a recommended row by its code, whatever its status: the product and list it pins, where it came from, the key
 * ingredient and strength, and the price and place in every country the workbook sells it in.
 */
export type RecommendedByCode = {
  code: string
  status: 'draft' | 'approved' | 'retired'
  productId: string
  /** Null only for a retired row uploaded with no list. */
  formulationId: string | null
  origin: Origin
  keyIngredient: string | null
  strength: string | null
  /** One entry for each country the row has availability in, in country order; empty for a row sold nowhere. */
  availability: { country: string; priceMin: number; priceMax: number; whereSold: string | null }[]
}

/** A Products row that is written, with where it lands in the catalog: the identity key of its product, and the list it pins. */
export type PlannedProduct = {
  row: ProductRow
  /** The identity key of the product this row is: its own when the product is new, else the existing product's (found by identity key or alias). */
  productKey: string
  /** The workbook's list as a formulation to store for the product, or null for a row with no list (a retired one). Ignored if the product already has this list. */
  formulation: { id: string; ingredientsKey: string } | null
}

/** The rows an upload writes, as the diff names them: rows that did not change are left out, so a typical upload writes a few rows, not the catalog. */
export type WorkbookChanges = {
  newProducts: NewProduct[]
  products: PlannedProduct[]
  /** The whole availability table as it should be, or null when it does not change. */
  availability: AvailabilityRow[] | null
  ingredients: IngredientRule[]
  countries: CountryRow[]
  retiredProducts: string[]
  retiredIngredients: string[]
  retiredCountries: string[]
  claimWords: ClaimWordRow[]
  tapers: TaperRow[]
  retiredClaimWords: string[]
  retiredTapers: string[]
  guides: GuideRow[]
  /** Guides the upload leaves out, by step and goal: a guide has no code. */
  retiredGuides: { step: GuideRow['step']; goal: GuideRow['goal'] }[]
  reintroductions: ReintroductionRow[]
  /** Ladders the upload leaves out, by group (null for the default ladder): a ladder has no code. */
  retiredReintroductions: { group: ReintroductionRow['group'] }[]
  escalations: EscalationRow[]
  retiredEscalations: { reason: EscalationRow['reason'] }[]
  responses: ResponseRow[]
  retiredResponses: { outcome: ResponseRow['outcome'] }[]
  weeks: WeekRow[]
  /** Week cards the upload leaves out, by band, goal and step-down: a card has no code. */
  retiredWeeks: { band: WeekRow['band']; goal: WeekRow['goal']; stepDown: WeekRow['stepDown'] }[]
}

/**
 * Everything one applied upload writes. The service decides it (reads, rules, diff, join); the repository only makes it happen, atomically.
 */
export type WorkbookPlan = WorkbookChanges & {
  /** The catalog version the upload was made from. The new version is `baseVersion + 1`. */
  baseVersion: number
  rulesVersion: string
  contractVersion: string
  uploadedBy: string
  archiveKey: string
  now: Date
}

const dayOf = (date: Date | null): string | null => (date === null ? null : date.toISOString().slice(0, 10))
const dateOf = (text: string | null): Date | null => (text === null ? null : new Date(`${text}T00:00:00.000Z`))

// D1 allows 100 bound parameters a statement, so each multi-row statement takes as many rows as fit under it (the comment is the parameters a row binds;
// a test reads them off the built statements, so a column added without lowering its count fails there, not on D1).
export const STATEMENT_ROWS = {
  countries: 18, // 5
  newProducts: 8, // 11
  formulations: 12, // 7
  recommended: 3, // at most 25
  availability: 15, // 6
  rules: 5, // 17
  claimWords: 9, // 11
  tapers: 9, // 11
  guides: 7, // 13
  reintroductions: 11, // 9
  escalations: 9, // 11
  responses: 9, // 11
  weeks: 8, // 12
  codes: 90, // one parameter a code, and two more for the values set
} as const

export class D1CatalogWorkbookRepository {
  // The entries are kept per isolate and read again only when the catalog version moves, which every applied upload does. The rules version alone
  // would do for the entries, but the rule metadata (group, clashes_with) changes under the same rules version, so anything cached from the rules
  // is keyed on the catalog version number. The number is read on every call, so a newly published one is seen at once.
  private static cached: { catalogVersion: number; live: LiveRules } | null = null

  constructor(private readonly db: Db) {}

  /** The rules version of the latest catalog version, and the approved rules, in code order. A draft or retired rule is never returned. */
  async liveRules(): Promise<LiveRules> {
    const [latest] = await this.latestRulesVersion()
    // The migration seeds catalog version 1, so none at all means the database was not migrated.
    if (!latest) throw new Error('no catalog version')
    const held = D1CatalogWorkbookRepository.cached
    if (held?.catalogVersion === latest.version) return held.live

    // The version and the rules are read in one batch, so an upload cannot land between them: the entries are stored under the version they
    // were read with, never under an older one (which would serve the new rules as the old version until the next upload).
    const [versions, rows] = await this.db.batch([
      this.latestRulesVersion(),
      this.db
        .select({ name: ingredientRules.name, aliases: ingredientRules.aliases, kind: ingredientRules.kind, statement: ingredientRules.statement, sourceUrl: ingredientRules.sourceUrl })
        .from(ingredientRules)
        .where(eq(ingredientRules.status, 'approved'))
        .orderBy(asc(ingredientRules.code)),
    ])
    const [current] = versions
    if (!current) throw new Error('no catalog version')
    const live: LiveRules = {
      version: current.rulesVersion,
      entries: rows.map((row) => ({ name: row.name, aliases: row.aliases, kind: row.kind, rule: row.statement, source: row.sourceUrl })),
    }
    D1CatalogWorkbookRepository.cached = { catalogVersion: current.version, live }
    return live
  }

  /** The live catalog version: the number an upload must say it was made from. */
  async catalogVersion(): Promise<number> {
    const [latest] = await this.latestVersion()
    if (!latest) throw new Error('no catalog version')
    return latest.version
  }

  /**
   * Every row of every tab as the last applied upload left it, retired rows included, in code order, with the catalog version they are at and the rules version of
   * that same catalog version. Read in one batch, so the rows and both versions belong together.
   */
  async readWorkbook(): Promise<{ catalogVersion: number; rulesVersion: string; workbook: Workbook }> {
    const [versions, productRows, availabilityRows, ruleRows, countryRows, claimWordRows, taperRows, guideRows, reintroductionRows, escalationRows, responseRows, weekRows] = await this.db.batch([
      this.latestRulesVersion(),
      this.db.select().from(recommendedProducts).orderBy(asc(recommendedProducts.code)),
      this.db.select().from(productAvailability).orderBy(asc(productAvailability.productCode), asc(productAvailability.country)),
      this.db.select().from(ingredientRules).orderBy(asc(ingredientRules.code)),
      this.db.select().from(countries).orderBy(asc(countries.code)),
      this.db.select().from(claimWords).orderBy(asc(claimWords.code)),
      this.db.select().from(tapers).orderBy(asc(tapers.code)),
      this.db.select().from(guides),
      this.db.select().from(reintroductions),
      this.db.select().from(escalations),
      this.db.select().from(responses),
      this.db.select().from(weeks),
    ])
    const [latest] = versions
    if (!latest) throw new Error('no catalog version')
    return {
      catalogVersion: latest.version,
      rulesVersion: latest.rulesVersion,
      workbook: {
        products: productRows.map(
          (row): ProductRow => ({
            code: row.code,
            brand: row.brand,
            name: row.name,
            variant: row.variant,
            form: row.form,
            category: row.category,
            ingredients: row.ingredients,
            ingredientsSourceUrl: row.ingredientsSourceUrl,
            keyIngredient: row.keyIngredient,
            strength: row.strength,
            skinConcerns: row.skinConcerns,
            skinTypes: row.skinTypes,
            steps: row.steps,
            frequency: row.frequency,
            ownCautions: row.ownCautions,
            evidenceUrls: row.evidenceUrls,
            origin: row.origin,
            status: row.status,
            approvedBy: row.approvedBy,
            approvedOn: dateOf(row.approvedOn),
            auditedBy: row.auditedBy,
            auditedOn: dateOf(row.auditedOn),
            draftCells: row.draftCells,
          }),
        ),
        availability: availabilityRows.map((row): AvailabilityRow => ({ productCode: row.productCode, country: row.country, priceMin: row.priceMin, priceMax: row.priceMax, whereSold: row.whereSold, sourceUrl: row.sourceUrl })),
        ingredients: ruleRows.map((row) => D1CatalogWorkbookRepository.ruleOf(row)),
        countries: countryRows.map((row): CountryRow => ({ code: row.code, currency: row.currency, lowMax: row.lowMax, midMax: row.midMax, status: row.status })),
        claimWords: claimWordRows.map((row) => D1CatalogWorkbookRepository.claimWordOf(row)),
        tapers: taperRows.map((row) => D1CatalogWorkbookRepository.taperOf(row)),
        guides: guideRows.map((row) => D1CatalogWorkbookRepository.guideOf(row)).sort(compareGuides),
        reintroductions: reintroductionRows.map((row) => D1CatalogWorkbookRepository.reintroductionOf(row)).sort(compareReintroductions),
        escalations: escalationRows.map((row) => D1CatalogWorkbookRepository.escalationOf(row)).sort(compareEscalations),
        responses: responseRows.map((row) => D1CatalogWorkbookRepository.responseOf(row)).sort(compareResponses),
        weeks: weekRows.map((row) => D1CatalogWorkbookRepository.weekOf(row)).sort(compareWeeks),
      },
    }
  }

  /**
   * The rules, claim words and step-down templates of every status, in code order, with the catalog version they are at and the rules version of that same
   * catalog version: what the shelf verdict is judged by, without the products, availability or countries a whole-workbook read also carries. One batch, so the
   * rows and both versions belong together.
   */
  async readVerdictReference(): Promise<{ catalogVersion: number; rulesVersion: string; rules: IngredientRule[]; claimWords: ClaimWordRow[]; tapers: TaperRow[] }> {
    const [versions, ruleRows, claimWordRows, taperRows] = await this.db.batch([
      this.latestRulesVersion(),
      this.db.select().from(ingredientRules).orderBy(asc(ingredientRules.code)),
      this.db.select().from(claimWords).orderBy(asc(claimWords.code)),
      this.db.select().from(tapers).orderBy(asc(tapers.code)),
    ])
    const [latest] = versions
    if (!latest) throw new Error('no catalog version')
    return {
      catalogVersion: latest.version,
      rulesVersion: latest.rulesVersion,
      rules: ruleRows.map((row) => D1CatalogWorkbookRepository.ruleOf(row)),
      claimWords: claimWordRows.map((row) => D1CatalogWorkbookRepository.claimWordOf(row)),
      tapers: taperRows.map((row) => D1CatalogWorkbookRepository.taperOf(row)),
    }
  }

  /** The approved guides of a step, its base guide and its goal guides: the rows `guideFor` chooses from. A draft or retired guide is never returned. */
  async approvedGuides(step: GuideRow['step']): Promise<GuideRow[]> {
    const rows = await this.db.select().from(guides).where(and(eq(guides.step, step), eq(guides.status, 'approved')))
    return rows.map((row) => D1CatalogWorkbookRepository.guideOf(row)).sort(compareGuides)
  }

  /** The approved ladders, the default one and the ones for a group: the rows `reintroductionFor` chooses from. A draft or retired ladder is never returned. */
  async approvedReintroductions(): Promise<ReintroductionRow[]> {
    const rows = await this.db.select().from(reintroductions).where(eq(reintroductions.status, 'approved'))
    return rows.map((row) => D1CatalogWorkbookRepository.reintroductionOf(row)).sort(compareReintroductions)
  }

  /** The approved escalation of a reason, or null: a draft or retired one is never returned. */
  async approvedEscalation(reason: EscalationReason): Promise<EscalationRow | null> {
    const [row] = await this.db.select().from(escalations).where(and(eq(escalations.key, reason), eq(escalations.status, 'approved')))
    return row === undefined ? null : D1CatalogWorkbookRepository.escalationOf(row)
  }

  /** The approved response of an outcome, or null: a draft or retired one is never returned. */
  async approvedResponse(outcome: ResponseOutcome): Promise<ResponseRow | null> {
    const [row] = await this.db.select().from(responses).where(and(eq(responses.key, outcome), eq(responses.status, 'approved')))
    return row === undefined ? null : D1CatalogWorkbookRepository.responseOf(row)
  }

  /** The approved week cards of a band, its base card, its goal cards and its step-down cards: the rows `weekCardFor` chooses from. A draft or retired card is never returned. */
  async approvedWeeks(band: WeekBand): Promise<WeekRow[]> {
    const rows = await this.db.select().from(weeks).where(and(eq(weeks.band, band), eq(weeks.status, 'approved')))
    return rows.map((row) => D1CatalogWorkbookRepository.weekOf(row)).sort(compareWeeks)
  }

  /** The step-down templates with these codes, retired ones included, in code order. A code that names none is absent. */
  async tapersByCode(codes: string[]): Promise<TaperRow[]> {
    const found: TaperRow[] = []
    for (const chunk of chunked([...new Set(codes)])) {
      for (const row of await this.db.select().from(tapers).where(inArray(tapers.code, chunk))) found.push(D1CatalogWorkbookRepository.taperOf(row))
    }
    return found.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  }

  /**
   * The recommended rows with these codes, whatever their status (a retired row is returned, as a routine saved with it still shows it), in code order, each
   * with its availability in every country. Not filtered by country: the caller says where it is sold and where it is not. A code that names no row is absent.
   */
  async recommendedByCode(codes: string[]): Promise<RecommendedByCode[]> {
    const wanted = [...new Set(codes)]
    const rows = await queryByIds(wanted, (chunk) => this.db.select().from(recommendedProducts).where(inArray(recommendedProducts.code, chunk)))
    const sold = await queryByIds(
      rows.map((row) => row.code),
      (chunk) => this.db.select().from(productAvailability).where(inArray(productAvailability.productCode, chunk)),
    )
    return rows
      .map((row) => ({
        code: row.code,
        status: row.status,
        productId: row.productId,
        formulationId: row.formulationId,
        origin: row.origin,
        keyIngredient: row.keyIngredient,
        strength: row.strength,
        availability: sold
          .filter((a) => a.productCode === row.code)
          .map((a) => ({ country: a.country, priceMin: a.priceMin, priceMax: a.priceMax, whereSold: a.whereSold }))
          .sort((a, b) => (a.country < b.country ? -1 : a.country > b.country ? 1 : 0)),
      }))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  }

  /**
   * For each catalog product id, the routine steps its approved recommended rows fill (the steps of each row in code order, a step once). A product with no
   * approved row is absent: a draft or retired row says nothing.
   */
  async stepsOf(productIds: string[]): Promise<Map<string, RoutineStep[]>> {
    const found = new Map<string, RoutineStep[]>()
    for (const chunk of chunked([...new Set(productIds)])) {
      const rows = await this.db
        .select({ productId: recommendedProducts.productId, steps: recommendedProducts.steps })
        .from(recommendedProducts)
        .where(and(eq(recommendedProducts.status, 'approved'), inArray(recommendedProducts.productId, chunk)))
        .orderBy(asc(recommendedProducts.code))
      for (const row of rows) found.set(row.productId, [...new Set([...(found.get(row.productId) ?? []), ...row.steps])])
    }
    return found
  }

  /**
   * For each catalog product id, the skin concerns its approved recommended rows are for (the union of the rows, a concern once, in the order of the
   * vocabulary). A product with no approved row is absent: a draft or retired row says nothing.
   */
  async skinConcernsOf(productIds: string[]): Promise<Map<string, ShownConcern[]>> {
    const listed = new Map<string, Set<ShownConcern>>()
    for (const chunk of chunked([...new Set(productIds)])) {
      const rows = await this.db
        .select({ productId: recommendedProducts.productId, skinConcerns: recommendedProducts.skinConcerns })
        .from(recommendedProducts)
        .where(and(eq(recommendedProducts.status, 'approved'), inArray(recommendedProducts.productId, chunk)))
        .orderBy(asc(recommendedProducts.code))
      for (const row of rows) listed.set(row.productId, new Set([...(listed.get(row.productId) ?? []), ...row.skinConcerns]))
    }
    return new Map([...listed].map(([productId, concerns]) => [productId, SHOWN_CONCERNS.filter((concern) => concerns.has(concern))]))
  }

  /** Every country, retired ones included, by code. */
  async countries(): Promise<Country[]> {
    return this.db.select().from(countries).orderBy(asc(countries.code))
  }

  /**
   * The approved rows sold in `country` that are used for `step`, by code, each with the price and place there. A row with no availability for
   * the country is never returned, and neither is a draft or a retired one.
   */
  async approvedFor(query: { country: string; step: RoutineStep }): Promise<Recommendation[]> {
    const rows = await this.db
      .select({ row: recommendedProducts, availability: productAvailability })
      .from(recommendedProducts)
      .innerJoin(productAvailability, eq(productAvailability.productCode, recommendedProducts.code))
      .where(
        and(
          eq(recommendedProducts.status, 'approved'),
          isNotNull(recommendedProducts.formulationId),
          eq(productAvailability.country, query.country),
          sql`exists (select 1 from json_each(${recommendedProducts.steps}) where value = ${query.step})`,
        ),
      )
      .orderBy(asc(recommendedProducts.code))
    return rows.map(({ row, availability }) => ({
      code: row.code,
      productId: row.productId,
      formulationId: row.formulationId!,
      ingredients: row.ingredients,
      skinConcerns: row.skinConcerns,
      skinTypes: row.skinTypes.includes('all') ? 'all' : (row.skinTypes as SkinTypeLabel[]),
      steps: row.steps,
      frequency: row.frequency,
      ownCautions: row.ownCautions,
      evidenceUrls: row.evidenceUrls,
      ingredientsSourceUrl: row.ingredientsSourceUrl,
      keyIngredient: row.keyIngredient,
      strength: row.strength,
      origin: row.origin,
      priceMin: availability.priceMin,
      priceMax: availability.priceMax,
      whereSold: availability.whereSold,
    }))
  }

  /**
   * For each key (an identity key), the identity key of the catalog product it names: the product whose identity key it is, else the one an alias
   * maps it to. A key that names no product is absent. Exact: nothing here is a near miss.
   */
  async matchProducts(keys: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    for (const chunk of chunked([...new Set(keys)])) {
      for (const row of await this.db.select({ key: products.identityKey }).from(products).where(inArray(products.identityKey, chunk))) found.set(row.key, row.key)
      const aliased = await this.db
        .select({ alias: productAliases.aliasKey, key: products.identityKey })
        .from(productAliases)
        .innerJoin(products, eq(products.id, productAliases.productId))
        .where(inArray(productAliases.aliasKey, chunk))
      // An identity key wins over an alias of the same text, as findProductByKey has it.
      for (const row of aliased) if (!found.has(row.alias)) found.set(row.alias, row.key)
    }
    return found
  }

  /**
   * How many statements `applyWorkbook` would send in its one batch. A statement may count against a Worker invocation's query limit, so the
   * service refuses a plan whose batch is too big before it archives anything.
   */
  statementCount(plan: WorkbookPlan): number {
    return this.statementsOf(plan).length
  }

  /**
   * Applies an upload in ONE batch, or changes nothing. The first statement inserts the next catalog version, `baseVersion + 1`, which is
   * the primary key: if another upload took that version since the caller read it, the insert violates the key and D1 rolls the WHOLE batch
   * back, so the loser leaves no product, formulation, row or version behind. Returns false for that loss, true when it stands.
   */
  async applyWorkbook(plan: WorkbookPlan): Promise<boolean> {
    const statements = this.statementsOf(plan)
    try {
      await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
    } catch (error) {
      // Whatever the reason, a failed batch changed nothing. Whose row holds the next version tells what happened: ours (the batch committed and only
      // the answer was lost, so this upload stands), another upload's (it lost the race), or nobody's (a real failure, which the caller must see).
      const [taken] = await this.db.select({ archiveKey: catalogVersions.archiveKey }).from(catalogVersions).where(eq(catalogVersions.version, plan.baseVersion + 1))
      if (taken?.archiveKey === plan.archiveKey) return true
      if (taken) return false
      throw error
    }
    return true
  }

  private statementsOf(plan: WorkbookPlan): BatchItem<'sqlite'>[] {
    const version = plan.baseVersion + 1
    const statements: BatchItem<'sqlite'>[] = [
      this.db.insert(catalogVersions).values({
        version,
        rulesVersion: plan.rulesVersion,
        contractVersion: plan.contractVersion,
        uploadedBy: plan.uploadedBy,
        archiveKey: plan.archiveKey,
        createdAt: plan.now,
      }),
    ]
    // Countries first, products before their formulations and rows, rows before the availability that names them: each statement meets its foreign keys.
    for (const rows of chunked(plan.countries, STATEMENT_ROWS.countries)) {
      statements.push(
        this.db
          .insert(countries)
          .values(rows)
          .onConflictDoUpdate({ target: countries.code, set: { currency: sql`excluded.currency`, lowMax: sql`excluded.low_max`, midMax: sql`excluded.mid_max`, status: sql`excluded.status` } }),
      )
    }
    for (const rows of chunked(plan.retiredCountries, STATEMENT_ROWS.codes)) statements.push(this.db.update(countries).set({ status: 'retired' }).where(inArray(countries.code, rows)))

    for (const rows of chunked(plan.newProducts, STATEMENT_ROWS.newProducts)) statements.push(this.db.insert(products).values(rows.map((row) => ({ ...row, kind: row.kind ?? 'named' }))).onConflictDoNothing({ target: products.identityKey }))
    statements.push(...this.productStatements(plan.products, version, plan.now))
    for (const rows of chunked(plan.retiredProducts, STATEMENT_ROWS.codes)) {
      statements.push(this.db.update(recommendedProducts).set({ status: 'retired', updatedInVersion: version }).where(inArray(recommendedProducts.code, rows)))
    }

    if (plan.availability !== null) {
      statements.push(this.db.delete(productAvailability))
      for (const rows of chunked(plan.availability, STATEMENT_ROWS.availability)) statements.push(this.db.insert(productAvailability).values(rows))
    }

    for (const rows of chunked(plan.ingredients, STATEMENT_ROWS.rules)) {
      statements.push(
        this.db
          .insert(ingredientRules)
          .values(rows.map((rule) => ({ ...rule, approvedOn: dayOf(rule.approvedOn), auditedOn: dayOf(rule.auditedOn), updatedInVersion: version })))
          .onConflictDoUpdate({
            target: ingredientRules.code,
            set: {
              name: sql`excluded.name`,
              aliases: sql`excluded.aliases`,
              kind: sql`excluded.kind`,
              strengthLimit: sql`excluded.strength_limit`,
              statement: sql`excluded.statement`,
              sourceUrl: sql`excluded.source_url`,
              helps: sql`excluded.helps`,
              // `group` is a keyword in SQL, so the column is quoted.
              group: sql`excluded."group"`,
              clashesWith: sql`excluded.clashes_with`,
              status: sql`excluded.status`,
              approvedBy: sql`excluded.approved_by`,
              reviewerRole: sql`excluded.reviewer_role`,
              approvedOn: sql`excluded.approved_on`,
              auditedBy: sql`excluded.audited_by`,
              auditedOn: sql`excluded.audited_on`,
              updatedInVersion: sql`excluded.updated_in_version`,
            },
          }),
      )
    }
    for (const rows of chunked(plan.retiredIngredients, STATEMENT_ROWS.codes)) {
      statements.push(this.db.update(ingredientRules).set({ status: 'retired', updatedInVersion: version }).where(inArray(ingredientRules.code, rows)))
    }

    for (const rows of chunked(plan.claimWords, STATEMENT_ROWS.claimWords)) {
      statements.push(
        this.db
          .insert(claimWords)
          .values(rows.map((word) => ({ ...word, approvedOn: dayOf(word.approvedOn), auditedOn: dayOf(word.auditedOn), updatedInVersion: version })))
          .onConflictDoUpdate({
            target: claimWords.code,
            set: {
              phrase: sql`excluded.phrase`,
              claim: sql`excluded.claim`,
              sourceUrl: sql`excluded.source_url`,
              status: sql`excluded.status`,
              approvedBy: sql`excluded.approved_by`,
              reviewerRole: sql`excluded.reviewer_role`,
              approvedOn: sql`excluded.approved_on`,
              auditedBy: sql`excluded.audited_by`,
              auditedOn: sql`excluded.audited_on`,
              updatedInVersion: sql`excluded.updated_in_version`,
            },
          }),
      )
    }
    for (const rows of chunked(plan.retiredClaimWords, STATEMENT_ROWS.codes)) {
      statements.push(this.db.update(claimWords).set({ status: 'retired', updatedInVersion: version }).where(inArray(claimWords.code, rows)))
    }

    for (const rows of chunked(plan.tapers, STATEMENT_ROWS.tapers)) {
      statements.push(
        this.db
          .insert(tapers)
          .values(rows.map((taper) => ({ ...taper, approvedOn: dayOf(taper.approvedOn), auditedOn: dayOf(taper.auditedOn), updatedInVersion: version })))
          .onConflictDoUpdate({
            target: tapers.code,
            set: {
              kind: sql`excluded.kind`,
              schedule: sql`excluded.schedule`,
              whatToExpect: sql`excluded.what_to_expect`,
              seeAProfessionalIf: sql`excluded.see_a_professional_if`,
              status: sql`excluded.status`,
              approvedBy: sql`excluded.approved_by`,
              approvedOn: sql`excluded.approved_on`,
              auditedBy: sql`excluded.audited_by`,
              auditedOn: sql`excluded.audited_on`,
              updatedInVersion: sql`excluded.updated_in_version`,
            },
          }),
      )
    }
    for (const rows of chunked(plan.retiredTapers, STATEMENT_ROWS.codes)) {
      statements.push(this.db.update(tapers).set({ status: 'retired', updatedInVersion: version }).where(inArray(tapers.code, rows)))
    }

    for (const rows of chunked(plan.guides, STATEMENT_ROWS.guides)) {
      statements.push(
        this.db
          .insert(guides)
          .values(rows.map((guide) => ({ ...guide, key: guideKey(guide), approvedOn: dayOf(guide.approvedOn), auditedOn: dayOf(guide.auditedOn), updatedInVersion: version })))
          .onConflictDoUpdate({
            target: guides.key,
            set: {
              step: sql`excluded.step`,
              goal: sql`excluded.goal`,
              whatItDoes: sql`excluded.what_it_does`,
              lookFor: sql`excluded.look_for`,
              forDeeperSkin: sql`excluded.for_deeper_skin`,
              lookForWhenPregnant: sql`excluded.look_for_when_pregnant`,
              status: sql`excluded.status`,
              approvedBy: sql`excluded.approved_by`,
              approvedOn: sql`excluded.approved_on`,
              auditedBy: sql`excluded.audited_by`,
              auditedOn: sql`excluded.audited_on`,
              updatedInVersion: sql`excluded.updated_in_version`,
            },
          }),
      )
    }
    for (const rows of chunked(plan.retiredGuides.map(guideKey), STATEMENT_ROWS.codes)) {
      statements.push(this.db.update(guides).set({ status: 'retired', updatedInVersion: version }).where(inArray(guides.key, rows)))
    }

    for (const rows of chunked(plan.reintroductions, STATEMENT_ROWS.reintroductions)) {
      statements.push(
        this.db
          .insert(reintroductions)
          .values(rows.map((ladder) => ({ ...ladder, key: reintroductionKey(ladder), approvedOn: dayOf(ladder.approvedOn), auditedOn: dayOf(ladder.auditedOn), updatedInVersion: version })))
          .onConflictDoUpdate({
            target: reintroductions.key,
            set: {
              group: sql`excluded."group"`,
              schedule: sql`excluded.schedule`,
              status: sql`excluded.status`,
              approvedBy: sql`excluded.approved_by`,
              approvedOn: sql`excluded.approved_on`,
              auditedBy: sql`excluded.audited_by`,
              auditedOn: sql`excluded.audited_on`,
              updatedInVersion: sql`excluded.updated_in_version`,
            },
          }),
      )
    }
    for (const rows of chunked(plan.retiredReintroductions.map(reintroductionKey), STATEMENT_ROWS.codes)) {
      statements.push(this.db.update(reintroductions).set({ status: 'retired', updatedInVersion: version }).where(inArray(reintroductions.key, rows)))
    }

    for (const rows of chunked(plan.escalations, STATEMENT_ROWS.escalations)) {
      statements.push(
        this.db
          .insert(escalations)
          .values(rows.map((escalation) => ({ ...escalation, key: escalation.reason, approvedOn: dayOf(escalation.approvedOn), auditedOn: dayOf(escalation.auditedOn), updatedInVersion: version })))
          .onConflictDoUpdate({
            target: escalations.key,
            set: {
              reason: sql`excluded.reason`,
              whoToSee: sql`excluded.who_to_see`,
              howSoon: sql`excluded.how_soon`,
              whatToTellThem: sql`excluded.what_to_tell_them`,
              status: sql`excluded.status`,
              approvedBy: sql`excluded.approved_by`,
              approvedOn: sql`excluded.approved_on`,
              auditedBy: sql`excluded.audited_by`,
              auditedOn: sql`excluded.audited_on`,
              updatedInVersion: sql`excluded.updated_in_version`,
            },
          }),
      )
    }
    for (const rows of chunked(plan.retiredEscalations.map((escalation) => escalation.reason), STATEMENT_ROWS.codes)) {
      statements.push(this.db.update(escalations).set({ status: 'retired', updatedInVersion: version }).where(inArray(escalations.key, rows)))
    }

    for (const rows of chunked(plan.responses, STATEMENT_ROWS.responses)) {
      statements.push(
        this.db
          .insert(responses)
          .values(rows.map((response) => ({ ...response, key: response.outcome, approvedOn: dayOf(response.approvedOn), auditedOn: dayOf(response.auditedOn), updatedInVersion: version })))
          .onConflictDoUpdate({
            target: responses.key,
            set: {
              outcome: sql`excluded.outcome`,
              title: sql`excluded.title`,
              body: sql`excluded.body`,
              whatToDoNow: sql`excluded.what_to_do_now`,
              status: sql`excluded.status`,
              approvedBy: sql`excluded.approved_by`,
              approvedOn: sql`excluded.approved_on`,
              auditedBy: sql`excluded.audited_by`,
              auditedOn: sql`excluded.audited_on`,
              updatedInVersion: sql`excluded.updated_in_version`,
            },
          }),
      )
    }
    for (const rows of chunked(plan.retiredResponses.map((response) => response.outcome), STATEMENT_ROWS.codes)) {
      statements.push(this.db.update(responses).set({ status: 'retired', updatedInVersion: version }).where(inArray(responses.key, rows)))
    }

    for (const rows of chunked(plan.weeks, STATEMENT_ROWS.weeks)) {
      statements.push(
        this.db
          .insert(weeks)
          .values(rows.map((card) => ({ ...card, key: weekKey(card), approvedOn: dayOf(card.approvedOn), auditedOn: dayOf(card.auditedOn), updatedInVersion: version })))
          .onConflictDoUpdate({
            target: weeks.key,
            set: {
              band: sql`excluded.band`,
              goal: sql`excluded.goal`,
              stepDown: sql`excluded.step_down`,
              title: sql`excluded.title`,
              text: sql`excluded.text`,
              status: sql`excluded.status`,
              approvedBy: sql`excluded.approved_by`,
              approvedOn: sql`excluded.approved_on`,
              auditedBy: sql`excluded.audited_by`,
              auditedOn: sql`excluded.audited_on`,
              updatedInVersion: sql`excluded.updated_in_version`,
            },
          }),
      )
    }
    for (const rows of chunked(plan.retiredWeeks.map(weekKey), STATEMENT_ROWS.codes)) {
      statements.push(this.db.update(weeks).set({ status: 'retired', updatedInVersion: version }).where(inArray(weeks.key, rows)))
    }
    return statements
  }

  /**
   * The Products rows: first the workbook lists as formulations of their products (nothing is stored for a product that already has that exact
   * list), then the rows themselves, each with the formulation it pins found by its list's key. Every statement finds a product by identity key, so a
   * product a scan created in the meantime is the one used, never a second; a product that is not there is a NOT NULL failure that rolls the batch
   * back, never a row that silently goes missing.
   */
  private productStatements(planned: PlannedProduct[], version: number, foundAt: Date): BatchItem<'sqlite'>[] {
    const productOf = (productKey: string) => sql<string>`(select id from products where identity_key = ${productKey})`
    const statements: BatchItem<'sqlite'>[] = []
    for (const rows of chunked(planned.filter((row) => row.formulation !== null), STATEMENT_ROWS.formulations)) {
      statements.push(
        this.db
          .insert(formulations)
          .values(
            rows.map(({ row, productKey, formulation }) => ({
              id: formulation!.id,
              productId: productOf(productKey),
              ingredients: row.ingredients,
              ingredientsKey: formulation!.ingredientsKey,
              sourceKind: 'workbook' as const,
              sourceUrl: row.ingredientsSourceUrl,
              foundAt,
            })),
          )
          .onConflictDoNothing({ target: [formulations.productId, formulations.ingredientsKey] }),
      )
    }
    for (const rows of chunked(planned, STATEMENT_ROWS.recommended)) {
      statements.push(
        this.db
          .insert(recommendedProducts)
          .values(
            rows.map(({ row, productKey, formulation }) => ({
              code: row.code,
              productId: productOf(productKey),
              formulationId: formulation
                ? sql<string>`(select f.id from formulations f where f.ingredients_key = ${formulation.ingredientsKey} and f.product_id = (select id from products where identity_key = ${productKey}))`
                : null,
              brand: row.brand,
              name: row.name,
              variant: row.variant,
              form: row.form,
              category: row.category,
              ingredients: row.ingredients,
              ingredientsSourceUrl: row.ingredientsSourceUrl,
              keyIngredient: row.keyIngredient,
              strength: row.strength,
              skinConcerns: row.skinConcerns,
              skinTypes: row.skinTypes,
              steps: row.steps,
              frequency: row.frequency,
              ownCautions: row.ownCautions,
              evidenceUrls: row.evidenceUrls,
              origin: row.origin,
              status: row.status,
              approvedBy: row.approvedBy,
              approvedOn: dayOf(row.approvedOn),
              auditedBy: row.auditedBy,
              auditedOn: dayOf(row.auditedOn),
              draftCells: row.draftCells,
              updatedInVersion: version,
            })),
          )
          .onConflictDoUpdate({
            target: recommendedProducts.code,
            set: {
              productId: sql`excluded.product_id`,
              // A row uploaded with no list (a retired one) keeps the formulation it pinned, as long as it is still the same product's.
              formulationId: sql`case when excluded.product_id = ${recommendedProducts.productId} then coalesce(excluded.formulation_id, ${recommendedProducts.formulationId}) else excluded.formulation_id end`,
              brand: sql`excluded.brand`,
              name: sql`excluded.name`,
              variant: sql`excluded.variant`,
              form: sql`excluded.form`,
              category: sql`excluded.category`,
              ingredients: sql`excluded.ingredients`,
              ingredientsSourceUrl: sql`excluded.ingredients_source_url`,
              keyIngredient: sql`excluded.key_ingredient`,
              strength: sql`excluded.strength`,
              skinConcerns: sql`excluded.skin_concerns`,
              skinTypes: sql`excluded.skin_types`,
              steps: sql`excluded.steps`,
              frequency: sql`excluded.frequency`,
              ownCautions: sql`excluded.own_cautions`,
              evidenceUrls: sql`excluded.evidence_urls`,
              origin: sql`excluded.origin`,
              status: sql`excluded.status`,
              approvedBy: sql`excluded.approved_by`,
              approvedOn: sql`excluded.approved_on`,
              auditedBy: sql`excluded.audited_by`,
              auditedOn: sql`excluded.audited_on`,
              draftCells: sql`excluded.draft_cells`,
              updatedInVersion: sql`excluded.updated_in_version`,
            },
          }),
      )
    }
    return statements
  }

  private static ruleOf(row: typeof ingredientRules.$inferSelect): IngredientRule {
    return {
      code: row.code,
      name: row.name,
      aliases: row.aliases,
      kind: row.kind,
      strengthLimit: row.strengthLimit,
      statement: row.statement,
      sourceUrl: row.sourceUrl,
      helps: row.helps,
      group: row.group,
      clashesWith: row.clashesWith,
      status: row.status,
      approvedBy: row.approvedBy,
      reviewerRole: row.reviewerRole,
      approvedOn: dateOf(row.approvedOn),
      auditedBy: row.auditedBy,
      auditedOn: dateOf(row.auditedOn),
    }
  }

  private static claimWordOf(row: typeof claimWords.$inferSelect): ClaimWordRow {
    return {
      code: row.code,
      phrase: row.phrase,
      claim: row.claim,
      sourceUrl: row.sourceUrl,
      status: row.status,
      approvedBy: row.approvedBy,
      reviewerRole: row.reviewerRole,
      approvedOn: dateOf(row.approvedOn),
      auditedBy: row.auditedBy,
      auditedOn: dateOf(row.auditedOn),
    }
  }

  private static taperOf(row: typeof tapers.$inferSelect): TaperRow {
    return {
      code: row.code,
      kind: row.kind,
      schedule: row.schedule,
      whatToExpect: row.whatToExpect,
      seeAProfessionalIf: row.seeAProfessionalIf,
      status: row.status,
      approvedBy: row.approvedBy,
      approvedOn: dateOf(row.approvedOn),
      auditedBy: row.auditedBy,
      auditedOn: dateOf(row.auditedOn),
    }
  }

  private static guideOf(row: typeof guides.$inferSelect): GuideRow {
    return {
      step: row.step,
      goal: row.goal,
      whatItDoes: row.whatItDoes,
      lookFor: row.lookFor,
      forDeeperSkin: row.forDeeperSkin,
      lookForWhenPregnant: row.lookForWhenPregnant,
      status: row.status,
      approvedBy: row.approvedBy,
      approvedOn: dateOf(row.approvedOn),
      auditedBy: row.auditedBy,
      auditedOn: dateOf(row.auditedOn),
    }
  }

  private static reintroductionOf(row: typeof reintroductions.$inferSelect): ReintroductionRow {
    return {
      group: row.group,
      schedule: row.schedule,
      status: row.status,
      approvedBy: row.approvedBy,
      approvedOn: dateOf(row.approvedOn),
      auditedBy: row.auditedBy,
      auditedOn: dateOf(row.auditedOn),
    }
  }

  private static escalationOf(row: typeof escalations.$inferSelect): EscalationRow {
    return {
      reason: row.reason,
      whoToSee: row.whoToSee,
      howSoon: row.howSoon,
      whatToTellThem: row.whatToTellThem,
      status: row.status,
      approvedBy: row.approvedBy,
      approvedOn: dateOf(row.approvedOn),
      auditedBy: row.auditedBy,
      auditedOn: dateOf(row.auditedOn),
    }
  }

  private static responseOf(row: typeof responses.$inferSelect): ResponseRow {
    return {
      outcome: row.outcome,
      title: row.title,
      body: row.body,
      whatToDoNow: row.whatToDoNow,
      status: row.status,
      approvedBy: row.approvedBy,
      approvedOn: dateOf(row.approvedOn),
      auditedBy: row.auditedBy,
      auditedOn: dateOf(row.auditedOn),
    }
  }

  private static weekOf(row: typeof weeks.$inferSelect): WeekRow {
    return {
      band: row.band,
      goal: row.goal,
      stepDown: row.stepDown,
      title: row.title,
      text: row.text,
      status: row.status,
      approvedBy: row.approvedBy,
      approvedOn: dateOf(row.approvedOn),
      auditedBy: row.auditedBy,
      auditedOn: dateOf(row.auditedOn),
    }
  }

  private latestRulesVersion() {
    return this.db.select({ version: catalogVersions.version, rulesVersion: catalogVersions.rulesVersion }).from(catalogVersions).orderBy(desc(catalogVersions.version)).limit(1)
  }

  private latestVersion() {
    return this.db.select({ version: catalogVersions.version }).from(catalogVersions).orderBy(desc(catalogVersions.version)).limit(1)
  }
}

export type CatalogWorkbookRepository = PublicOf<D1CatalogWorkbookRepository>
