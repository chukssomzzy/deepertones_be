import { REFERENCE, REFERENCE_VERSION } from './catalog.reference'
import { seedRuleCode } from './catalog.workbook.seed'
import { STATEMENT_ROWS, type CatalogWorkbookRepository, type Country, type LiveRules, type Recommendation, type WorkbookPlan } from './catalog.workbook.repository'
import type { RuleRow } from './catalog.workbook.repository.contract'
import type { AvailabilityRow, ClaimWordRow, IngredientRule, ProductRow, TaperRow, Workbook } from './catalog.workbook.schema'
import type { RoutineStep } from './catalog.vocabulary'
import { SHOWN_CONCERNS, type ShownConcern } from '../face-scans/face-scans.tables'

const day = (text: string | null): Date | null => (text === null ? null : new Date(`${text}T00:00:00.000Z`))
const text = (date: Date | null): string | null => (date === null ? null : date.toISOString().slice(0, 10))
const byCode = <T extends { code: string }>(a: T, b: T): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
const batches = (rows: number, per: number): number => Math.ceil(rows / per)

/** In-memory CatalogWorkbookRepository for unit tests. Behaviour is pinned by catalogWorkbookRepositoryContract. */
export class FakeCatalogWorkbookRepository implements CatalogWorkbookRepository {
  // Starts as the migrated database does: the REFERENCE rules, approved, under the seed rules version, with the codes the seed gave them.
  private version = REFERENCE_VERSION
  private catalogNumber = 1
  private rules: RuleRow[] = REFERENCE.map((entry) => ({
    code: seedRuleCode(entry),
    name: entry.name,
    aliases: [...entry.aliases],
    kind: entry.kind,
    strengthLimit: null,
    statement: entry.rule,
    sourceUrl: entry.source,
    helps: [],
    group: null,
    clashesWith: [],
    status: 'approved',
    approvedBy: 'reference seed',
    approvedOn: '2026-10-21',
    auditedBy: null,
    auditedOn: null,
  }))
  private products: ProductRow[] = []
  private availability: AvailabilityRow[] = []
  private countryRows: Country[] = []
  private claimWordRows: ClaimWordRow[] = []
  private taperRows: TaperRow[] = []
  /** The catalog products a row can join: identity key to product id. A product an upload makes is added. */
  private readonly productIds = new Map<string, string>()
  /** Other spellings of a product: alias key to the product's identity key. */
  private readonly aliases = new Map<string, string>()
  /** The formulations of the workbook's products: product identity key and list key to formulation id. A list a product already has is stored once. */
  private readonly formulationIds = new Map<string, string>()
  /** The product each Products row is, and the formulation it pins (null for a row uploaded with no list), by code. */
  private readonly productOf = new Map<string, string>()
  private readonly pinned = new Map<string, string | null>()

  async liveRules(): Promise<LiveRules> {
    const approved = this.rules.filter((rule) => rule.status === 'approved').sort(byCode)
    return {
      version: this.version,
      entries: approved.map((rule) => ({ name: rule.name, aliases: [...rule.aliases], kind: rule.kind, rule: rule.statement, source: rule.sourceUrl })),
    }
  }

  async catalogVersion(): Promise<number> {
    return this.catalogNumber
  }

  async readWorkbook(): Promise<{ catalogVersion: number; rulesVersion: string; workbook: Workbook }> {
    return {
      catalogVersion: this.catalogNumber,
      rulesVersion: this.version,
      workbook: {
        products: structuredClone([...this.products].sort(byCode)),
        availability: structuredClone([...this.availability].sort((a, b) => (`${a.productCode}:${a.country}` < `${b.productCode}:${b.country}` ? -1 : 1))),
        ingredients: this.ingredientRules(),
        countries: structuredClone([...this.countryRows].sort(byCode)),
        claimWords: structuredClone([...this.claimWordRows].sort(byCode)),
        tapers: structuredClone([...this.taperRows].sort(byCode)),
      },
    }
  }

  async readVerdictReference(): Promise<{ catalogVersion: number; rulesVersion: string; rules: IngredientRule[]; claimWords: ClaimWordRow[]; tapers: TaperRow[] }> {
    return {
      catalogVersion: this.catalogNumber,
      rulesVersion: this.version,
      rules: this.ingredientRules(),
      claimWords: structuredClone([...this.claimWordRows].sort(byCode)),
      tapers: structuredClone([...this.taperRows].sort(byCode)),
    }
  }

  async tapersByCode(codes: string[]): Promise<TaperRow[]> {
    return structuredClone(this.taperRows.filter((row) => codes.includes(row.code)).sort(byCode))
  }

  async stepsOf(productIds: string[]): Promise<Map<string, RoutineStep[]>> {
    const found = new Map<string, RoutineStep[]>()
    for (const row of [...this.products].sort(byCode)) {
      const productId = this.productOf.get(row.code)
      if (row.status !== 'approved' || productId === undefined || !productIds.includes(productId)) continue
      found.set(productId, [...new Set([...(found.get(productId) ?? []), ...row.steps])])
    }
    return found
  }

  async skinConcernsOf(productIds: string[]): Promise<Map<string, ShownConcern[]>> {
    const listed = new Map<string, Set<ShownConcern>>()
    for (const row of [...this.products].sort(byCode)) {
      const productId = this.productOf.get(row.code)
      if (row.status !== 'approved' || productId === undefined || !productIds.includes(productId)) continue
      listed.set(productId, new Set([...(listed.get(productId) ?? []), ...row.skinConcerns]))
    }
    return new Map([...listed].map(([productId, concerns]) => [productId, SHOWN_CONCERNS.filter((concern) => concerns.has(concern))]))
  }

  private ingredientRules(): IngredientRule[] {
    return [...this.rules].sort(byCode).map((rule) => ({
      ...rule,
      aliases: [...rule.aliases],
      helps: [...rule.helps],
      clashesWith: [...rule.clashesWith],
      approvedOn: day(rule.approvedOn),
      auditedOn: day(rule.auditedOn),
    }))
  }

  async countries(): Promise<Country[]> {
    return structuredClone([...this.countryRows].sort(byCode))
  }

  async approvedFor(query: { country: string; step: RoutineStep }): Promise<Recommendation[]> {
    return this.products
      .filter((row) => row.status === 'approved' && row.steps.includes(query.step) && this.pinned.get(row.code))
      .sort(byCode)
      .flatMap((row) => {
        const sold = this.availability.find((a) => a.productCode === row.code && a.country === query.country)
        if (!sold) return []
        return [
          {
            code: row.code,
            productId: this.productOf.get(row.code)!,
            formulationId: this.pinned.get(row.code)!,
            ingredients: [...row.ingredients],
            skinConcerns: [...row.skinConcerns],
            skinTypes: row.skinTypes.includes('all') ? ('all' as const) : row.skinTypes.filter((type) => type !== 'all'),
            steps: [...row.steps],
            frequency: row.frequency,
            ownCautions: [...row.ownCautions],
            evidenceUrls: [...row.evidenceUrls],
            ingredientsSourceUrl: row.ingredientsSourceUrl,
            keyIngredient: row.keyIngredient,
            strength: row.strength,
            origin: row.origin,
            priceMin: sold.priceMin,
            priceMax: sold.priceMax,
            whereSold: sold.whereSold,
          },
        ]
      })
  }

  async matchProducts(keys: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    for (const key of keys) {
      // An identity key wins over an alias of the same text.
      if (this.productIds.has(key)) found.set(key, key)
      else if (this.aliases.has(key)) found.set(key, this.aliases.get(key)!)
    }
    return found
  }

  statementCount(plan: WorkbookPlan): number {
    const rows = STATEMENT_ROWS
    return (
      1 +
      batches(plan.countries.length, rows.countries) +
      batches(plan.retiredCountries.length, rows.codes) +
      batches(plan.newProducts.length, rows.newProducts) +
      batches(plan.products.filter((planned) => planned.formulation !== null).length, rows.formulations) +
      batches(plan.products.length, rows.recommended) +
      batches(plan.retiredProducts.length, rows.codes) +
      (plan.availability === null ? 0 : 1 + batches(plan.availability.length, rows.availability)) +
      batches(plan.ingredients.length, rows.rules) +
      batches(plan.retiredIngredients.length, rows.codes) +
      batches(plan.claimWords.length, rows.claimWords) +
      batches(plan.retiredClaimWords.length, rows.codes) +
      batches(plan.tapers.length, rows.tapers) +
      batches(plan.retiredTapers.length, rows.codes)
    )
  }

  async applyWorkbook(plan: WorkbookPlan): Promise<boolean> {
    // Nothing is written unless the upload was made from the live version, as the real one's first statement refuses to otherwise.
    if (plan.baseVersion !== this.catalogNumber) return false
    // A row whose product is neither known nor made by this plan fails the whole batch in the real one (NOT NULL); here it throws before anything is written.
    const made = new Set(plan.newProducts.map((product) => product.identityKey))
    for (const { productKey } of plan.products) {
      if (!this.productIds.has(productKey) && !made.has(productKey)) throw new Error('a Products row names a product that does not exist')
    }
    for (const product of plan.newProducts) if (!this.productIds.has(product.identityKey)) this.productIds.set(product.identityKey, product.id)
    for (const { row, productKey, formulation } of plan.products) {
      this.products = [...this.products.filter((existing) => existing.code !== row.code), structuredClone(row)]
      const productId = this.productIds.get(productKey)!
      const before = this.pinned.get(row.code) ?? null
      let pinned: string | null = null
      if (formulation) {
        const key = `${productKey}\n${formulation.ingredientsKey}`
        if (!this.formulationIds.has(key)) this.formulationIds.set(key, formulation.id)
        pinned = this.formulationIds.get(key)!
      } else if (this.productOf.get(row.code) === productId) {
        // A row uploaded with no list keeps the formulation it pinned, as long as it is still the same product's.
        pinned = before
      }
      this.productOf.set(row.code, productId)
      this.pinned.set(row.code, pinned)
    }
    for (const code of plan.retiredProducts) this.products = this.products.map((row) => (row.code === code ? { ...row, status: 'retired' } : row))
    if (plan.availability) this.availability = structuredClone(plan.availability)
    for (const country of plan.countries) this.countryRows = [...this.countryRows.filter((row) => row.code !== country.code), { ...country }]
    for (const code of plan.retiredCountries) this.countryRows = this.countryRows.map((row) => (row.code === code ? { ...row, status: 'retired' } : row))
    for (const rule of plan.ingredients) {
      const stored: RuleRow = { ...rule, aliases: [...rule.aliases], helps: [...rule.helps], clashesWith: [...rule.clashesWith], approvedOn: text(rule.approvedOn), auditedOn: text(rule.auditedOn) }
      this.rules = [...this.rules.filter((existing) => existing.code !== rule.code), stored]
    }
    for (const code of plan.retiredIngredients) this.rules = this.rules.map((rule) => (rule.code === code ? { ...rule, status: 'retired' } : rule))
    for (const word of plan.claimWords) this.claimWordRows = [...this.claimWordRows.filter((existing) => existing.code !== word.code), structuredClone(word)]
    for (const code of plan.retiredClaimWords) this.claimWordRows = this.claimWordRows.map((word) => (word.code === code ? { ...word, status: 'retired' } : word))
    for (const taper of plan.tapers) this.taperRows = [...this.taperRows.filter((existing) => existing.code !== taper.code), structuredClone(taper)]
    for (const code of plan.retiredTapers) this.taperRows = this.taperRows.map((taper) => (taper.code === code ? { ...taper, status: 'retired' } : taper))
    this.catalogNumber = plan.baseVersion + 1
    this.version = plan.rulesVersion
    return true
  }

  /** Makes `rules` the whole rules set under a new rules version, as an applied upload does. Not part of the repository type. */
  publishRules(rulesVersion: string, rules: RuleRow[]): void {
    this.version = rulesVersion
    this.catalogNumber += 1
    this.rules = rules.map((rule) => ({ ...rule, aliases: [...rule.aliases], clashesWith: [...rule.clashesWith] }))
  }

  /** Makes a catalog product exist, as a scan would, so a Products row with its identity key joins it. Not part of the repository type. */
  addProduct(identityKey: string, id: string): void {
    this.productIds.set(identityKey, id)
  }

  /** Remembers another spelling of a catalog product, as a scan the model matched would. Not part of the repository type. */
  addAlias(aliasKey: string, identityKey: string): void {
    this.aliases.set(aliasKey, identityKey)
  }
}
