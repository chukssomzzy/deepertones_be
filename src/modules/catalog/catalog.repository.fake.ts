import type { CatalogRepository } from './catalog.repository'
import type { DraftConcernRow, Formulation, NewFormulation, NewProduct, Product, ResearchAttempt, StoredConcern } from './catalog.types'

const copyFormulation = (f: Formulation): Formulation => ({ ...f, ingredients: [...f.ingredients] })

/** In-memory CatalogRepository for unit tests. Behaviour is pinned by catalogRepositoryContract. */
export class FakeCatalogRepository implements CatalogRepository {
  private products = new Map<string, Product>()
  private aliases = new Map<string, string>()
  // Insertion order matters: it breaks ties in found time.
  private formulations: Formulation[] = []
  private concerns = new Map<string, StoredConcern[]>()
  private attempts: ResearchAttempt[] = []

  async createProduct(input: NewProduct): Promise<Product> {
    const existing = [...this.products.values()].find((p) => p.identityKey === input.identityKey)
    if (existing) return { ...existing }
    const product: Product = { ...input, imageKey: null, imageSourceUrl: null, imageCheckedAt: null }
    this.products.set(product.id, product)
    return { ...product }
  }

  async findProductByKey(key: string): Promise<Product | null> {
    const byIdentity = [...this.products.values()].find((p) => p.identityKey === key)
    const found = byIdentity ?? this.products.get(this.aliases.get(key) ?? '')
    return found ? { ...found } : null
  }

  async addAlias(aliasKey: string, productId: string): Promise<void> {
    if (!this.products.has(productId)) throw new Error(`unknown product ${productId}`)
    const isIdentityKey = [...this.products.values()].some((p) => p.identityKey === aliasKey)
    if (isIdentityKey || this.aliases.has(aliasKey)) return
    this.aliases.set(aliasKey, productId)
  }

  async productsByBrandKey(brandKey: string, limit: number): Promise<Product[]> {
    // Map order is insert order; reversing first makes a later insert win a tie in createdAt (the sort is stable).
    return [...this.products.values()]
      .filter((p) => p.brandKey === brandKey)
      .reverse()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((p) => ({ ...p }))
  }

  async createFormulation(input: NewFormulation): Promise<Formulation> {
    const formulation: Formulation = { ...input, analysisVersion: null, referenceVersion: null, analysedAt: null }
    this.formulations.push(formulation)
    return copyFormulation(formulation)
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

  async researchAttemptsSince(since: Date): Promise<number> {
    return this.attempts.filter((a) => a.attemptedAt.getTime() >= since.getTime()).length
  }
}
