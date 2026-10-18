import type { CatalogRepository } from './catalog.repository'
import type { DraftConcernRow, Formulation, NewFormulation, NewProduct, Product, ResearchAttempt, StoredConcern } from './catalog.types'

/** What recordAnalysisAttempt takes; the D1 implementation must accept the same fields. */
export type AnalysisAttemptInput = {
  id: string
  formulationId: string
  attemptedAt: Date
  /** 'started' is written before the analyst is called and settled after, like a research attempt. */
  outcome: 'started' | 'ok' | 'rejected' | 'failed'
  analysisVersion: number
  referenceVersion: string
}

const copyFormulation = (f: Formulation): Formulation => ({ ...f, ingredients: [...f.ingredients] })

/** In-memory CatalogRepository for unit tests. Behaviour is pinned by catalogRepositoryContract. */
export class FakeCatalogRepository implements CatalogRepository {
  private products = new Map<string, Product>()
  private aliases = new Map<string, string>()
  // Insertion order matters: it breaks ties in found time.
  private formulations: Formulation[] = []
  private concerns = new Map<string, StoredConcern[]>()
  private attempts: ResearchAttempt[] = []
  private analysisAttempts: AnalysisAttemptInput[] = []

  async createProduct(input: NewProduct): Promise<Product> {
    const existing = [...this.products.values()].find((p) => p.identityKey === input.identityKey)
    if (existing) return { ...existing }
    const product: Product = { ...input, kind: input.kind ?? 'named', searchText: input.searchText ?? '', imageKey: null, imageSourceUrl: null, imageCheckedAt: null }
    this.products.set(product.id, product)
    return { ...product }
  }

  async findProductByKey(key: string): Promise<Product | null> {
    const byIdentity = [...this.products.values()].find((p) => p.identityKey === key)
    const found = byIdentity ?? this.products.get(this.aliases.get(key) ?? '')
    return found ? { ...found } : null
  }

  async findProductById(id: string): Promise<Product | null> {
    const found = this.products.get(id)
    return found ? { ...found } : null
  }

  async addAlias(aliasKey: string, productId: string): Promise<void> {
    if (!this.products.has(productId)) throw new Error(`unknown product ${productId}`)
    const isIdentityKey = [...this.products.values()].some((p) => p.identityKey === aliasKey)
    if (isIdentityKey || this.aliases.has(aliasKey)) return
    this.aliases.set(aliasKey, productId)
  }

  /**
   * The named products that `query` (already normalised) reaches, at most `limit`. The query is split on spaces into at most 8 words (empty ones
   * ignored; none at all finds nothing). A product matches when every word is contained in its search text, or every word is contained in one of
   * its alias keys; the words may come in any order and some of the product's words may be left out. Products whose search text starts with the
   * whole query come first, then by search text, then by id. A product reachable more than one way appears once. A product with no formulation is never listed.
   */
  async search(query: string, limit: number): Promise<Product[]> {
    const words = query.split(' ').filter((word) => word !== '').slice(0, 8)
    if (words.length === 0) return []
    const containsAll = (text: string) => words.every((word) => text.includes(word))
    const reaches = (p: Product) =>
      containsAll(p.searchText) || [...this.aliases].some(([aliasKey, productId]) => productId === p.id && containsAll(aliasKey))
    const prefixRank = (p: Product) => (p.searchText.startsWith(query) ? 0 : 1)
    return [...this.products.values()]
      .filter((p) => p.kind === 'named' && this.formulations.some((f) => f.productId === p.id) && reaches(p))
      .sort((a, b) => prefixRank(a) - prefixRank(b) || (a.searchText < b.searchText ? -1 : a.searchText > b.searchText ? 1 : 0) || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((p) => ({ ...p }))
  }

  /** Up to `limit` named products whose search text is empty (made before the column existed, or by a Worker that did not know it), by id. Unnamed products never are. */
  async namedWithoutSearchText(limit: number): Promise<Product[]> {
    return [...this.products.values()]
      .filter((p) => p.kind === 'named' && p.searchText === '')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit)
      .map((p) => ({ ...p }))
  }

  /** Sets the search text of one product, changing nothing else. An unknown id is ignored. */
  async setSearchText(id: string, searchText: string): Promise<void> {
    const product = this.products.get(id)
    if (product) product.searchText = searchText
  }

  /** Sets the search text of many products in one call, changing nothing else. Ids that are not products are ignored; an empty list does nothing. */
  async setSearchTexts(rows: { id: string; searchText: string }[]): Promise<void> {
    for (const { id, searchText } of rows) {
      const product = this.products.get(id)
      if (product) product.searchText = searchText
    }
  }

  async productsByBrandFamily(firstWord: string, limit: number): Promise<Product[]> {
    // Map order is insert order; reversing first makes a later insert win a tie in createdAt (the sort is stable).
    return [...this.products.values()]
      .filter((p) => p.brandKey === firstWord || p.brandKey.startsWith(`${firstWord} `))
      .reverse()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((p) => ({ ...p }))
  }

  async createFormulation(input: NewFormulation): Promise<Formulation> {
    // A product has one formulation per ingredient list: a second create for the same list returns the first.
    const existing = this.formulations.find((f) => f.productId === input.productId && f.ingredientsKey === input.ingredientsKey)
    if (existing) return copyFormulation(existing)
    const formulation: Formulation = { ...input, analysisVersion: null, referenceVersion: null, analysedAt: null }
    this.formulations.push(formulation)
    return copyFormulation(formulation)
  }

  /**
   * Moves the formulation of an unnamed product to `productId` (id, analysis and concerns kept) and removes the unnamed product with its aliases, in one step.
   * Throws, changing nothing, for an unknown formulation or product, a formulation of a named product, or a product that already has the list.
   */
  async adoptUnnamedFormulation(formulationId: string, productId: string): Promise<void> {
    const formulation = this.formulations.find((f) => f.id === formulationId)
    if (!formulation) throw new Error(`unknown formulation ${formulationId}`)
    if (!this.products.has(productId)) throw new Error(`unknown product ${productId}`)
    const owner = this.products.get(formulation.productId)
    if (!owner || owner.kind !== 'unnamed') throw new Error(`formulation ${formulationId} does not belong to an unnamed product`)
    if (this.formulations.some((f) => f.productId === productId && f.ingredientsKey === formulation.ingredientsKey)) {
      throw new Error(`product ${productId} already has this ingredient list`)
    }
    formulation.productId = productId
    this.products.delete(owner.id)
    for (const [aliasKey, aliased] of this.aliases) if (aliased === owner.id) this.aliases.delete(aliasKey)
    // Whatever else the unnamed product still held goes with it, as the foreign keys cascade in D1.
    const gone = new Set(this.formulations.filter((f) => f.productId === owner.id).map((f) => f.id))
    this.formulations = this.formulations.filter((f) => !gone.has(f.id))
    for (const id of gone) this.concerns.delete(id)
  }

  async findFormulation(id: string): Promise<Formulation | null> {
    const found = this.formulations.find((f) => f.id === id)
    return found ? copyFormulation(found) : null
  }

  async latestFormulation(productId: string): Promise<Formulation | null> {
    let latest: Formulation | null = null
    for (const f of this.formulations) {
      if (f.productId === productId && (!latest || f.foundAt.getTime() >= latest.foundAt.getTime())) latest = f
    }
    return latest ? copyFormulation(latest) : null
  }

  async findFormulationByIngredientsKey(productId: string, ingredientsKey: string): Promise<Formulation | null> {
    const found = this.formulations.find((f) => f.productId === productId && f.ingredientsKey === ingredientsKey)
    return found ? copyFormulation(found) : null
  }

  async touchFormulation(id: string, foundAt: Date): Promise<void> {
    const found = this.formulations.find((f) => f.id === id)
    if (found && foundAt.getTime() > found.foundAt.getTime()) found.foundAt = foundAt
  }

  async saveAnalysis(
    formulationId: string,
    analysis: { concerns: DraftConcernRow[]; analysisVersion: number; referenceVersion: string; analysedAt: Date },
  ): Promise<void> {
    const formulation = this.formulations.find((f) => f.id === formulationId)
    if (!formulation) throw new Error(`unknown formulation ${formulationId}`)
    formulation.analysisVersion = analysis.analysisVersion
    formulation.referenceVersion = analysis.referenceVersion
    formulation.analysedAt = analysis.analysedAt
    this.concerns.set(
      formulationId,
      analysis.concerns.map((c, position) => ({
        ...c,
        id: crypto.randomUUID(),
        formulationId,
        position,
        ingredients: [...c.ingredients],
        sources: [...c.sources],
        traits: [...new Set(c.traits)].sort(),
      })),
    )
  }

  async concernsFor(formulationId: string): Promise<StoredConcern[]> {
    return (this.concerns.get(formulationId) ?? []).map((c) => ({
      ...c,
      ingredients: [...c.ingredients],
      sources: [...c.sources],
      traits: [...c.traits],
    }))
  }

  async setProductImage(productId: string, image: { key: string; sourceUrl: string; checkedAt: Date }): Promise<void> {
    const product = this.products.get(productId)
    if (!product) return
    product.imageKey = image.key
    product.imageSourceUrl = image.sourceUrl
    product.imageCheckedAt = image.checkedAt
  }

  async markImageChecked(productId: string, checkedAt: Date): Promise<void> {
    const product = this.products.get(productId)
    if (product) product.imageCheckedAt = checkedAt
  }

  async recordResearchAttempt(attempt: ResearchAttempt): Promise<void> {
    this.attempts.push({ ...attempt })
  }

  async settleResearchAttempt(id: string, outcome: ResearchAttempt['outcome']): Promise<void> {
    const attempt = this.attempts.find((a) => a.id === id)
    if (attempt) attempt.outcome = outcome
  }

  /** Started, found and not-found attempts count; a failed one (an outage) costs nothing. */
  async researchAttemptsSince(since: Date): Promise<number> {
    return this.attempts.filter((a) => a.attemptedAt.getTime() >= since.getTime() && a.outcome !== 'failed').length
  }

  /** The product's most recent attempt of any outcome (the later insert wins a tie), or null if it has none. */
  async lastResearchOutcome(productId: string): Promise<{ outcome: ResearchAttempt['outcome']; attemptedAt: Date } | null> {
    let last: ResearchAttempt | null = null
    for (const a of this.attempts) {
      if (a.productId === productId && (!last || a.attemptedAt.getTime() >= last.attemptedAt.getTime())) last = a
    }
    return last ? { outcome: last.outcome, attemptedAt: last.attemptedAt } : null
  }

  async recordAnalysisAttempt(attempt: AnalysisAttemptInput): Promise<void> {
    this.analysisAttempts.push({ ...attempt })
  }

  /** Moves a recorded attempt to its final outcome, keeping the time it started. An unknown id is ignored. */
  async settleAnalysisAttempt(id: string, outcome: Exclude<AnalysisAttemptInput['outcome'], 'started'>): Promise<void> {
    const attempt = this.analysisAttempts.find((a) => a.id === id)
    if (attempt) attempt.outcome = outcome
  }

  /** The formulation's most recent attempt of any outcome (the later insert wins a tie), or null if it has none. */
  async lastAnalysisAttempt(formulationId: string): Promise<{ outcome: AnalysisAttemptInput['outcome']; attemptedAt: Date } | null> {
    let last: AnalysisAttemptInput | null = null
    for (const a of this.analysisAttempts) {
      if (a.formulationId === formulationId && (!last || a.attemptedAt.getTime() >= last.attemptedAt.getTime())) last = a
    }
    return last ? { outcome: last.outcome, attemptedAt: last.attemptedAt } : null
  }

  /** How many analysis attempts made at or after `since` count against the budget: started, ok and rejected ones; a failed one (an outage) costs nothing. */
  async analysisAttemptsSince(since: Date): Promise<number> {
    return this.analysisAttempts.filter((a) => a.attemptedAt.getTime() >= since.getTime() && a.outcome !== 'failed').length
  }

  /** How many analyses of this formulation were rejected under exactly these versions. */
  async rejectedAnalyses(formulationId: string, analysisVersion: number, referenceVersion: string): Promise<number> {
    return this.analysisAttempts.filter(
      (a) => a.formulationId === formulationId && a.outcome === 'rejected' && a.analysisVersion === analysisVersion && a.referenceVersion === referenceVersion,
    ).length
  }
}
