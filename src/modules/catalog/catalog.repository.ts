import { and, asc, count, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { analysisAttempts, concernTraits, formulationConcerns, formulations, productAliases, products, researchAttempts } from './catalog.table'
import type { AnalysisAttempt, DraftConcernRow, Formulation, NewFormulation, NewProduct, Product, ResearchAttempt, StoredConcern } from './catalog.types'

// Drizzle wraps the driver error, so the SQLite message may be on the cause.
const isForeignKeyFailure = (error: unknown): boolean => {
  for (let e = error as { message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (typeof e.message === 'string' && /FOREIGN KEY constraint failed/.test(e.message)) return true
  }
  return false
}

// D1 allows 100 bound parameters per statement; a trait row binds 2.
const TRAIT_CHUNK = 40

export class D1CatalogRepository {
  constructor(private readonly db: Db) {}

  /**
   * Stores the product, or, when its identity key is already stored (a concurrent scan of the same product won
   * the race), stores nothing. Either way returns the stored row, so the caller carries on with the winner.
   */
  async createProduct(input: NewProduct): Promise<Product> {
    await this.db.insert(products).values(input).onConflictDoNothing({ target: products.identityKey })
    const [row] = await this.db.select().from(products).where(eq(products.identityKey, input.identityKey))
    if (!row) throw new Error(`product ${input.id} was not stored`)
    return row
  }

  async findProductById(id: string): Promise<Product | null> {
    const [row] = await this.db.select().from(products).where(eq(products.id, id))
    return row ?? null
  }

  /** The product whose identity key is `key`, else the one an alias maps `key` to; null if neither. */
  async findProductByKey(key: string): Promise<Product | null> {
    const [byIdentity] = await this.db.select().from(products).where(eq(products.identityKey, key))
    if (byIdentity) return byIdentity
    const [byAlias] = await this.db
      .select({ product: products })
      .from(productAliases)
      .innerJoin(products, eq(products.id, productAliases.productId))
      .where(eq(productAliases.aliasKey, key))
    return byAlias?.product ?? null
  }

  /**
   * Remembers `aliasKey` as another spelling of the product. Does nothing when the key already is a product's
   * identity key (the identity must keep finding its own product) or already an alias (the first owner keeps it).
   * ONE statement, so the identity check and the insert cannot be separated by another writer. Throws for an
   * unknown product (the foreign key refuses it; `insert or ignore` does not swallow that).
   */
  async addAlias(aliasKey: string, productId: string): Promise<void> {
    try {
      await this.db.run(sql`
        insert or ignore into product_aliases (alias_key, product_id)
        select ${aliasKey}, ${productId}
        where not exists (select 1 from products where identity_key = ${aliasKey})`)
    } catch (error) {
      if (isForeignKeyFailure(error)) throw new Error(`unknown product ${productId}`, { cause: error })
      throw error
    }
  }

  /** The brand's newest products first (the later insert wins a tie), so the most recent catalogue entries are compared. */
  async productsByBrandKey(brandKey: string, limit: number): Promise<Product[]> {
    return this.db
      .select()
      .from(products)
      .where(eq(products.brandKey, brandKey))
      .orderBy(desc(products.createdAt), sql`rowid desc`)
      .limit(limit)
  }

  /**
   * Stores the formulation, or, when the product already has one with this ingredient list (an earlier scan, or a
   * concurrent one that won the race), stores nothing. Either way returns the stored row, so the caller carries on with the winner.
   */
  async createFormulation(input: NewFormulation): Promise<Formulation> {
    await this.db.insert(formulations).values(input).onConflictDoNothing({ target: [formulations.productId, formulations.ingredientsKey] })
    const [row] = await this.db
      .select()
      .from(formulations)
      .where(and(eq(formulations.productId, input.productId), eq(formulations.ingredientsKey, input.ingredientsKey)))
    if (!row) throw new Error(`formulation ${input.id} was not stored`)
    return row
  }

  async findFormulation(id: string): Promise<Formulation | null> {
    const [row] = await this.db.select().from(formulations).where(eq(formulations.id, id))
    return row ?? null
  }

  /** The product's formulation found most recently; the later insert wins a tie. */
  async latestFormulation(productId: string): Promise<Formulation | null> {
    const [row] = await this.db
      .select()
      .from(formulations)
      .where(eq(formulations.productId, productId))
      .orderBy(desc(formulations.foundAt), sql`rowid desc`)
      .limit(1)
    return row ?? null
  }

  async findFormulationByIngredientsKey(productId: string, ingredientsKey: string): Promise<Formulation | null> {
    const [row] = await this.db
      .select()
      .from(formulations)
      .where(and(eq(formulations.productId, productId), eq(formulations.ingredientsKey, ingredientsKey)))
      .orderBy(desc(formulations.foundAt), sql`rowid desc`)
      .limit(1)
    return row ?? null
  }

  /** Records that the formulation was seen again at `foundAt`, which can make it the latest. Never moves the time backwards. */
  async touchFormulation(id: string, foundAt: Date): Promise<void> {
    await this.db
      .update(formulations)
      .set({ foundAt: sql`max(${formulations.foundAt}, ${foundAt.getTime()})` })
      .where(eq(formulations.id, id))
  }

  /**
   * Replaces the formulation's analysis: old traits and concerns out, new concerns and traits in, versions set,
   * in ONE batch so a reader never sees a half-written analysis. One INSERT per concern keeps each statement
   * under D1's bound-parameter limit however many concerns there are. Throws, storing nothing, for an unknown formulation.
   */
  async saveAnalysis(
    formulationId: string,
    analysis: { concerns: DraftConcernRow[]; analysisVersion: number; referenceVersion: string; analysedAt: Date },
  ): Promise<void> {
    const [existing] = await this.db.select({ id: formulations.id }).from(formulations).where(eq(formulations.id, formulationId))
    if (!existing) throw new Error(`unknown formulation ${formulationId}`)

    const rows = analysis.concerns.map((c, position) => ({ id: crypto.randomUUID(), formulationId, position, c }))
    const traitRows = rows.flatMap(({ id, c }) => [...new Set(c.traits)].map((trait) => ({ concernId: id, trait })))

    const statements: BatchItem<'sqlite'>[] = [
      this.db
        .delete(concernTraits)
        .where(
          inArray(
            concernTraits.concernId,
            this.db.select({ id: formulationConcerns.id }).from(formulationConcerns).where(eq(formulationConcerns.formulationId, formulationId)),
          ),
        ),
      this.db.delete(formulationConcerns).where(eq(formulationConcerns.formulationId, formulationId)),
    ]
    for (const { id, position, c } of rows) {
      const { traits: _traits, ...columns } = c
      statements.push(this.db.insert(formulationConcerns).values({ ...columns, id, formulationId, position }))
    }
    for (let i = 0; i < traitRows.length; i += TRAIT_CHUNK) {
      statements.push(this.db.insert(concernTraits).values(traitRows.slice(i, i + TRAIT_CHUNK)))
    }
    statements.push(
      this.db
        .update(formulations)
        .set({ analysisVersion: analysis.analysisVersion, referenceVersion: analysis.referenceVersion, analysedAt: analysis.analysedAt })
        .where(eq(formulations.id, formulationId)),
    )
    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  }

  /** The formulation's concerns in the order they were saved, each with its traits sorted. */
  async concernsFor(formulationId: string): Promise<StoredConcern[]> {
    const concerns = await this.db
      .select()
      .from(formulationConcerns)
      .where(eq(formulationConcerns.formulationId, formulationId))
      .orderBy(asc(formulationConcerns.position))
    if (concerns.length === 0) return []
    const traitRows = await this.db
      .select({ concernId: concernTraits.concernId, trait: concernTraits.trait })
      .from(concernTraits)
      .innerJoin(formulationConcerns, eq(formulationConcerns.id, concernTraits.concernId))
      .where(eq(formulationConcerns.formulationId, formulationId))
      .orderBy(asc(concernTraits.trait))
    return concerns.map((concern) => ({
      ...concern,
      traits: traitRows.filter((t) => t.concernId === concern.id).map((t) => t.trait),
    }))
  }

  async setProductImage(productId: string, image: { key: string; sourceUrl: string; checkedAt: Date }): Promise<void> {
    await this.db
      .update(products)
      .set({ imageKey: image.key, imageSourceUrl: image.sourceUrl, imageCheckedAt: image.checkedAt })
      .where(eq(products.id, productId))
  }

  /** Records that an image was looked for at `checkedAt`, leaving any image the product has. */
  async markImageChecked(productId: string, checkedAt: Date): Promise<void> {
    await this.db.update(products).set({ imageCheckedAt: checkedAt }).where(eq(products.id, productId))
  }

  async recordResearchAttempt(attempt: ResearchAttempt): Promise<void> {
    await this.db.insert(researchAttempts).values(attempt)
  }

  /** Turns a started attempt into its outcome. The time it started is kept. */
  async settleResearchAttempt(id: string, outcome: ResearchAttempt['outcome']): Promise<void> {
    await this.db.update(researchAttempts).set({ outcome }).where(eq(researchAttempts.id, id))
  }

  /** How many research attempts were made at or after `since`: started, found and not-found ones. A failed attempt (an outage) costs nothing. */
  async researchAttemptsSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(researchAttempts)
      .where(and(gte(researchAttempts.attemptedAt, since), ne(researchAttempts.outcome, 'failed')))
    return row?.n ?? 0
  }

  /** The product's most recent attempt of any outcome (the later insert wins a tie), or null if it has none. */
  async lastResearchOutcome(productId: string): Promise<{ outcome: ResearchAttempt['outcome']; attemptedAt: Date } | null> {
    const [row] = await this.db
      .select({ outcome: researchAttempts.outcome, attemptedAt: researchAttempts.attemptedAt })
      .from(researchAttempts)
      .where(eq(researchAttempts.productId, productId))
      .orderBy(desc(researchAttempts.attemptedAt), sql`rowid desc`)
      .limit(1)
    return row ?? null
  }

  async recordAnalysisAttempt(attempt: AnalysisAttempt): Promise<void> {
    await this.db.insert(analysisAttempts).values(attempt)
  }

  /** Turns a started attempt into its outcome. The time it started is kept. */
  async settleAnalysisAttempt(id: string, outcome: Exclude<AnalysisAttempt['outcome'], 'started'>): Promise<void> {
    await this.db.update(analysisAttempts).set({ outcome }).where(eq(analysisAttempts.id, id))
  }

  /** The formulation's most recent attempt of any outcome (the later insert wins a tie), or null if it has none. */
  async lastAnalysisAttempt(formulationId: string): Promise<{ outcome: AnalysisAttempt['outcome']; attemptedAt: Date } | null> {
    const [row] = await this.db
      .select({ outcome: analysisAttempts.outcome, attemptedAt: analysisAttempts.attemptedAt })
      .from(analysisAttempts)
      .where(eq(analysisAttempts.formulationId, formulationId))
      .orderBy(desc(analysisAttempts.attemptedAt), sql`rowid desc`)
      .limit(1)
    return row ?? null
  }

  /** How many analysis attempts were made at or after `since`: started, ok and rejected ones. A failed attempt (an outage) costs nothing. */
  async analysisAttemptsSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(analysisAttempts)
      .where(and(gte(analysisAttempts.attemptedAt, since), ne(analysisAttempts.outcome, 'failed')))
    return row?.n ?? 0
  }

  /** How many analyses of this formulation were rejected under exactly these versions. */
  async rejectedAnalyses(formulationId: string, analysisVersion: number, referenceVersion: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(analysisAttempts)
      .where(
        and(
          eq(analysisAttempts.formulationId, formulationId),
          eq(analysisAttempts.outcome, 'rejected'),
          eq(analysisAttempts.analysisVersion, analysisVersion),
          eq(analysisAttempts.referenceVersion, referenceVersion),
        ),
      )
    return row?.n ?? 0
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type CatalogRepository = PublicOf<D1CatalogRepository>
