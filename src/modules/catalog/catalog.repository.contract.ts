import { describe, expect, it } from 'vitest'
import type { CatalogRepository } from './catalog.repository'
import type { DraftConcernRow, NewFormulation, NewProduct } from './catalog.types'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

// Each call yields a value no other test (or earlier run against a shared D1) uses.
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
const fresh = (label: string) => `${label}-${runSalt}-${counter++}`
const freshId = () => crypto.randomUUID()

const newProduct = (over: Partial<NewProduct> = {}): NewProduct => {
  const brandKey = over.brandKey ?? fresh('brand')
  return {
    id: freshId(),
    identityKey: `${brandKey}|${fresh('name')}|`,
    brandKey,
    kind: 'named',
    brand: 'CeraVe',
    name: 'Hydrating Facial Cleanser',
    variant: null,
    category: 'skin',
    createdAt: BASE,
    ...over,
  }
}

/** A product no label named: the catalog keys it by its ingredient list, and it has no brand or name. */
const newUnnamedProduct = (over: Partial<NewProduct> = {}): NewProduct => ({
  id: freshId(),
  identityKey: `unnamed:${fresh('aqua')}\nglycerin`,
  brandKey: '',
  kind: 'unnamed',
  brand: '',
  name: '',
  variant: null,
  category: 'other',
  createdAt: BASE,
  ...over,
})

const newFormulation = (productId: string, over: Partial<NewFormulation> = {}): NewFormulation => {
  const ingredients = over.ingredients ?? ['Aqua', 'Glycerin', fresh('Parfum')]
  return {
    id: freshId(),
    productId,
    ingredients,
    ingredientsKey: ingredients.join('\n').toLowerCase(),
    sourceKind: 'web',
    sourceUrl: 'https://example.com/product',
    foundAt: BASE,
    ...over,
  }
}

const concern = (over: Partial<DraftConcernRow> = {}): DraftConcernRow => ({
  kind: 'irritation',
  severity: 'medium',
  ingredients: ['Sodium Lauryl Sulfate'],
  why: 'High in the list, so likely to sting on a damaged barrier.',
  whoShouldTakeCare: 'Sensitive skin',
  traits: ['sensitive'],
  sources: ['https://example.com/sls'],
  ...over,
})

/** Behaviour every CatalogRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const catalogRepositoryContract = (name: string, make: () => CatalogRepository | Promise<CatalogRepository>) => {
  describe(`CatalogRepository contract: ${name}`, () => {
    describe('products', () => {
      it('createProduct returns the product with no image yet', async () => {
        const repo = await make()
        const input = newProduct({ variant: '236ml', category: 'body' })

        const product = await repo.createProduct(input)

        expect(product).toMatchObject({
          id: input.id,
          identityKey: input.identityKey,
          brandKey: input.brandKey,
          brand: 'CeraVe',
          name: 'Hydrating Facial Cleanser',
          variant: '236ml',
          category: 'body',
          imageKey: null,
          imageSourceUrl: null,
          imageCheckedAt: null,
        })
        expect(product.createdAt.getTime()).toBe(BASE.getTime())
      })

      it('createProduct with an identity key that is already stored creates nothing and returns the existing product', async () => {
        const repo = await make()
        const first = newProduct({ name: 'Original Name' })
        await repo.createProduct(first)

        const second = await repo.createProduct(newProduct({ identityKey: first.identityKey, brandKey: first.brandKey, name: 'Raced Name' }))

        expect(second).toMatchObject({ id: first.id, name: 'Original Name' })
        expect(await repo.productsByBrandKey(first.brandKey, 10)).toHaveLength(1)
        expect(await repo.findProductByKey(first.identityKey)).toMatchObject({ id: first.id })
      })

      it('findProductByKey finds a product by its identity key', async () => {
        const repo = await make()
        const input = newProduct()
        await repo.createProduct(input)

        expect(await repo.findProductByKey(input.identityKey)).toMatchObject({ id: input.id, variant: null })
      })

      it('findProductByKey returns null for an unknown key', async () => {
        const repo = await make()

        expect(await repo.findProductByKey(fresh('unknown'))).toBeNull()
      })

      it('findProductById finds a product by its id', async () => {
        const repo = await make()
        const input = newProduct({ variant: 'Night' })
        await repo.createProduct(input)

        expect(await repo.findProductById(input.id)).toMatchObject({ id: input.id, identityKey: input.identityKey, variant: 'Night', imageKey: null })
      })

      it('findProductById returns null for an unknown id', async () => {
        const repo = await make()

        expect(await repo.findProductById(freshId())).toBeNull()
      })

      it('createProduct keeps the kind it is given, named or unnamed, and reads it back by id and by key', async () => {
        const repo = await make()
        const named = newProduct()
        const unnamed = newUnnamedProduct()

        expect(await repo.createProduct(named)).toMatchObject({ kind: 'named' })
        expect(await repo.createProduct(unnamed)).toMatchObject({ kind: 'unnamed', brand: '', name: '', variant: null, category: 'other', brandKey: '' })

        expect(await repo.findProductById(named.id)).toMatchObject({ kind: 'named' })
        expect(await repo.findProductById(unnamed.id)).toMatchObject({ kind: 'unnamed' })
        expect(await repo.findProductByKey(unnamed.identityKey)).toMatchObject({ id: unnamed.id, kind: 'unnamed' })
      })

      it('finds an unnamed product by its identity key, "unnamed:" and the list\'s ingredients key, as written', async () => {
        const repo = await make()
        const listKey = fresh('aqua\nglycerin\ncetearyl alcohol')
        const unnamed = newUnnamedProduct({ identityKey: `unnamed:${listKey}` })
        await repo.createProduct(unnamed)

        expect(await repo.findProductByKey(`unnamed:${listKey}`)).toMatchObject({ id: unnamed.id })
        expect(await repo.findProductByKey(listKey)).toBeNull()
      })

      it('createProduct for an unnamed identity key that is already stored creates nothing and returns the existing product', async () => {
        const repo = await make()
        const first = newUnnamedProduct()
        await repo.createProduct(first)

        const second = await repo.createProduct(newUnnamedProduct({ identityKey: first.identityKey }))

        expect(second).toMatchObject({ id: first.id, kind: 'unnamed' })
      })
    })

    describe('aliases', () => {
      it('findProductByKey finds a product by an alias', async () => {
        const repo = await make()
        const product = newProduct()
        await repo.createProduct(product)
        const alias = fresh('alias')

        await repo.addAlias(alias, product.id)

        expect(await repo.findProductByKey(alias)).toMatchObject({ id: product.id, identityKey: product.identityKey })
      })

      it('adding the same alias twice is a no-op', async () => {
        const repo = await make()
        const product = newProduct()
        await repo.createProduct(product)
        const alias = fresh('alias')
        await repo.addAlias(alias, product.id)

        await expect(repo.addAlias(alias, product.id)).resolves.toBeUndefined()

        expect(await repo.findProductByKey(alias)).toMatchObject({ id: product.id })
      })

      it('an alias equal to an existing identity key is ignored, so the key still finds its own product', async () => {
        const repo = await make()
        const owner = newProduct()
        const other = newProduct()
        await repo.createProduct(owner)
        await repo.createProduct(other)

        await repo.addAlias(owner.identityKey, other.id)

        expect(await repo.findProductByKey(owner.identityKey)).toMatchObject({ id: owner.id })
      })

      it('adding an alias for a product that does not exist throws', async () => {
        const repo = await make()

        await expect(repo.addAlias(fresh('alias'), freshId())).rejects.toThrow()
      })

      it('an alias belongs to one product and a second product cannot take it over', async () => {
        const repo = await make()
        const first = newProduct()
        const second = newProduct()
        await repo.createProduct(first)
        await repo.createProduct(second)
        const alias = fresh('alias')
        await repo.addAlias(alias, first.id)

        await repo.addAlias(alias, second.id)

        expect(await repo.findProductByKey(alias)).toMatchObject({ id: first.id })
      })
    })

    describe('productsByBrandKey', () => {
      it('returns the products with that brand key and no others', async () => {
        const repo = await make()
        const brandKey = fresh('brand')
        const a = newProduct({ brandKey })
        const b = newProduct({ brandKey })
        const elsewhere = newProduct()
        for (const p of [a, b, elsewhere]) await repo.createProduct(p)

        const found = await repo.productsByBrandKey(brandKey, 10)

        expect(found.map((p) => p.id).sort()).toEqual([a.id, b.id].sort())
      })

      it('returns the newest products first, a later insert before an earlier one created at the same time', async () => {
        const repo = await make()
        const brandKey = fresh('brand')
        const oldest = newProduct({ brandKey, createdAt: at(-HOUR) })
        const middle = newProduct({ brandKey, createdAt: at(HOUR) })
        const tiedLater = newProduct({ brandKey, createdAt: at(HOUR) })
        const newest = newProduct({ brandKey, createdAt: at(2 * HOUR) })
        for (const p of [middle, oldest, newest, tiedLater]) await repo.createProduct(p)

        expect((await repo.productsByBrandKey(brandKey, 10)).map((p) => p.id)).toEqual([newest.id, tiedLater.id, middle.id, oldest.id])
        expect((await repo.productsByBrandKey(brandKey, 2)).map((p) => p.id)).toEqual([newest.id, tiedLater.id])
      })

      it('returns at most limit products', async () => {
        const repo = await make()
        const brandKey = fresh('brand')
        for (let i = 0; i < 3; i++) await repo.createProduct(newProduct({ brandKey }))

        expect(await repo.productsByBrandKey(brandKey, 2)).toHaveLength(2)
        expect(await repo.productsByBrandKey(brandKey, 3)).toHaveLength(3)
      })

      it('returns an empty list for an unknown brand key', async () => {
        const repo = await make()

        expect(await repo.productsByBrandKey(fresh('brand'), 10)).toEqual([])
      })
    })

    describe('formulations', () => {
      const withProduct = async (repo: CatalogRepository) => {
        const product = newProduct()
        await repo.createProduct(product)
        return product
      }

      it('createFormulation stores the list in label order with no analysis yet, and findFormulation reads it back', async () => {
        const repo = await make()
        const product = await withProduct(repo)
        const input = newFormulation(product.id, {
          ingredients: ['Aqua (Water)', 'Zinc Oxide', 'Glycerin', 'Parfum (Fragrance)'],
          sourceKind: 'label',
          sourceUrl: null,
          foundAt: at(MINUTE),
        })

        const created = await repo.createFormulation(input)
        const found = await repo.findFormulation(input.id)

        for (const f of [created, found]) {
          expect(f).toMatchObject({
            id: input.id,
            productId: product.id,
            ingredients: ['Aqua (Water)', 'Zinc Oxide', 'Glycerin', 'Parfum (Fragrance)'],
            ingredientsKey: input.ingredientsKey,
            sourceKind: 'label',
            sourceUrl: null,
            analysisVersion: null,
            referenceVersion: null,
            analysedAt: null,
          })
          expect(f!.foundAt.getTime()).toBe(at(MINUTE).getTime())
        }
      })

      it('createFormulation for an ingredient list the product already has returns the existing formulation and stores no duplicate', async () => {
        const repo = await make()
        const product = await withProduct(repo)
        const first = newFormulation(product.id, { foundAt: at(HOUR) })
        await repo.createFormulation(first)

        const again = await repo.createFormulation(
          newFormulation(product.id, { ingredients: first.ingredients, ingredientsKey: first.ingredientsKey, sourceKind: 'label', sourceUrl: null, foundAt: at(2 * HOUR) }),
        )

        expect(again).toMatchObject({ id: first.id, sourceKind: 'web', sourceUrl: first.sourceUrl })
        expect(again.foundAt.getTime()).toBe(at(HOUR).getTime())
        // A duplicate stored later would win the tie-break for latest; the first must still be the only one.
        expect((await repo.latestFormulation(product.id))!.id).toBe(first.id)
        expect((await repo.findFormulationByIngredientsKey(product.id, first.ingredientsKey))!.id).toBe(first.id)
      })

      it('createFormulation stores the same ingredient list for another product as that product\'s own formulation', async () => {
        const repo = await make()
        const mine = await withProduct(repo)
        const theirs = await withProduct(repo)
        const first = newFormulation(mine.id)
        await repo.createFormulation(first)

        const other = await repo.createFormulation(newFormulation(theirs.id, { ingredients: first.ingredients, ingredientsKey: first.ingredientsKey }))

        expect(other.productId).toBe(theirs.id)
        expect(other.id).not.toBe(first.id)
      })

      it('touchFormulation never moves the found time backwards', async () => {
        const repo = await make()
        const product = await withProduct(repo)
        const formulation = newFormulation(product.id, { foundAt: at(2 * HOUR) })
        await repo.createFormulation(formulation)

        await repo.touchFormulation(formulation.id, at(HOUR))

        expect((await repo.findFormulation(formulation.id))!.foundAt.getTime()).toBe(at(2 * HOUR).getTime())
      })

      it('findFormulation returns null for an unknown id', async () => {
        const repo = await make()

        expect(await repo.findFormulation(freshId())).toBeNull()
      })

      it('latestFormulation returns null for a product with no formulation', async () => {
        const repo = await make()
        const product = await withProduct(repo)

        expect(await repo.latestFormulation(product.id)).toBeNull()
      })

      it('latestFormulation returns the one found most recently, whatever order they were stored in', async () => {
        const repo = await make()
        const product = await withProduct(repo)
        const newest = newFormulation(product.id, { foundAt: at(2 * HOUR) })
        const older = newFormulation(product.id, { foundAt: at(HOUR) })
        await repo.createFormulation(newest)
        await repo.createFormulation(older)

        expect((await repo.latestFormulation(product.id))!.id).toBe(newest.id)
      })

      it('latestFormulation breaks a tie in found time by taking the later insert', async () => {
        const repo = await make()
        const product = await withProduct(repo)
        const first = newFormulation(product.id)
        const second = newFormulation(product.id)
        await repo.createFormulation(first)
        await repo.createFormulation(second)

        expect((await repo.latestFormulation(product.id))!.id).toBe(second.id)
      })

      it('latestFormulation looks only at that product', async () => {
        const repo = await make()
        const mine = await withProduct(repo)
        const theirs = await withProduct(repo)
        const own = newFormulation(mine.id, { foundAt: at(HOUR) })
        await repo.createFormulation(own)
        await repo.createFormulation(newFormulation(theirs.id, { foundAt: at(5 * HOUR) }))

        expect((await repo.latestFormulation(mine.id))!.id).toBe(own.id)
      })

      it('findFormulationByIngredientsKey finds the product\'s formulation with that key', async () => {
        const repo = await make()
        const product = await withProduct(repo)
        const input = newFormulation(product.id)
        await repo.createFormulation(input)

        expect((await repo.findFormulationByIngredientsKey(product.id, input.ingredientsKey))!.id).toBe(input.id)
      })

      it('findFormulationByIngredientsKey returns null for another key, or for another product that has the key', async () => {
        const repo = await make()
        const product = await withProduct(repo)
        const other = await withProduct(repo)
        const input = newFormulation(product.id)
        await repo.createFormulation(input)

        expect(await repo.findFormulationByIngredientsKey(product.id, fresh('different'))).toBeNull()
        expect(await repo.findFormulationByIngredientsKey(other.id, input.ingredientsKey)).toBeNull()
      })

      it('touchFormulation sets the found time, which can make an older formulation the latest', async () => {
        const repo = await make()
        const product = await withProduct(repo)
        const older = newFormulation(product.id, { foundAt: at(HOUR) })
        const newer = newFormulation(product.id, { foundAt: at(2 * HOUR) })
        await repo.createFormulation(older)
        await repo.createFormulation(newer)

        await repo.touchFormulation(older.id, at(3 * HOUR))

        expect((await repo.findFormulation(older.id))!.foundAt.getTime()).toBe(at(3 * HOUR).getTime())
        expect((await repo.latestFormulation(product.id))!.id).toBe(older.id)
      })
    })

    describe('analysis', () => {
      const withFormulation = async (repo: CatalogRepository) => {
        const product = newProduct()
        await repo.createProduct(product)
        const formulation = newFormulation(product.id)
        await repo.createFormulation(formulation)
        return formulation
      }

      it('concernsFor is empty for a formulation that has not been analysed', async () => {
        const repo = await make()
        const { id } = await withFormulation(repo)

        expect(await repo.concernsFor(id)).toEqual([])
      })

      it('saveAnalysis stores the concerns and marks the formulation as analysed', async () => {
        const repo = await make()
        const { id } = await withFormulation(repo)

        await repo.saveAnalysis(id, {
          concerns: [concern({ kind: 'allergen', severity: 'high', traits: ['sensitive'] })],
          analysisVersion: 1,
          referenceVersion: 'seed-1',
          analysedAt: at(5 * MINUTE),
        })

        const formulation = (await repo.findFormulation(id))!
        expect(formulation).toMatchObject({ analysisVersion: 1, referenceVersion: 'seed-1' })
        expect(formulation.analysedAt!.getTime()).toBe(at(5 * MINUTE).getTime())
        const stored = await repo.concernsFor(id)
        expect(stored).toHaveLength(1)
        expect(stored[0]).toMatchObject({
          formulationId: id,
          position: 0,
          kind: 'allergen',
          severity: 'high',
          ingredients: ['Sodium Lauryl Sulfate'],
          why: 'High in the list, so likely to sting on a damaged barrier.',
          whoShouldTakeCare: 'Sensitive skin',
          traits: ['sensitive'],
          sources: ['https://example.com/sls'],
        })
      })

      it('concernsFor returns concerns in the order they were saved, with their own traits', async () => {
        const repo = await make()
        const { id } = await withFormulation(repo)

        await repo.saveAnalysis(id, {
          concerns: [
            concern({ kind: 'sun-sensitivity', traits: ['dark-spots'] }),
            concern({ kind: 'drying', traits: ['dry', 'sensitive'] }),
            concern({ kind: 'pore-clogging', traits: [] }),
          ],
          analysisVersion: 1,
          referenceVersion: 'seed-1',
          analysedAt: at(MINUTE),
        })

        const stored = await repo.concernsFor(id)
        expect(stored.map((c) => c.kind)).toEqual(['sun-sensitivity', 'drying', 'pore-clogging'])
        expect(stored.map((c) => c.position)).toEqual([0, 1, 2])
        expect(stored.map((c) => c.traits)).toEqual([['dark-spots'], ['dry', 'sensitive'], []])
      })

      it('concernsFor returns each concern\'s traits sorted', async () => {
        const repo = await make()
        const { id } = await withFormulation(repo)

        await repo.saveAnalysis(id, {
          concerns: [concern({ traits: ['sensitive', 'redness', 'acne-prone', 'goal:glow'] })],
          analysisVersion: 1,
          referenceVersion: 'seed-1',
          analysedAt: at(MINUTE),
        })

        expect((await repo.concernsFor(id))[0]!.traits).toEqual(['acne-prone', 'goal:glow', 'redness', 'sensitive'])
      })

      it('saveAnalysis stores a concern\'s traits once each, even if the draft repeats one', async () => {
        const repo = await make()
        const { id } = await withFormulation(repo)

        await repo.saveAnalysis(id, {
          concerns: [concern({ traits: ['sensitive', 'dry', 'sensitive', 'dry'] })],
          analysisVersion: 1,
          referenceVersion: 'seed-1',
          analysedAt: at(MINUTE),
        })

        expect((await repo.concernsFor(id))[0]!.traits).toEqual(['dry', 'sensitive'])
      })

      it('saveAnalysis for a formulation that does not exist throws and stores nothing', async () => {
        const repo = await make()
        const unknown = freshId()

        await expect(
          repo.saveAnalysis(unknown, { concerns: [concern()], analysisVersion: 1, referenceVersion: 'seed-1', analysedAt: at(MINUTE) }),
        ).rejects.toThrow()

        expect(await repo.concernsFor(unknown)).toEqual([])
      })

      it('concernsFor round-trips ingredient and source lists in order, including text that needs escaping', async () => {
        const repo = await make()
        const { id } = await withFormulation(repo)
        const ingredients = ['Parfum (Fragrance)', 'Aqua "Water"', 'Linalool, Limonene', 'Crème']
        const sources = ['https://example.com/a?x=1&y=2', 'EU 1223/2009 Annex II']

        await repo.saveAnalysis(id, {
          concerns: [concern({ ingredients, sources })],
          analysisVersion: 1,
          referenceVersion: 'seed-1',
          analysedAt: at(MINUTE),
        })

        const [stored] = await repo.concernsFor(id)
        expect(stored!.ingredients).toEqual(ingredients)
        expect(stored!.sources).toEqual(sources)
      })

      it('a second saveAnalysis replaces the concerns, traits and versions instead of adding to them', async () => {
        const repo = await make()
        const { id } = await withFormulation(repo)
        await repo.saveAnalysis(id, {
          concerns: [
            concern({ kind: 'irritation', traits: ['sensitive', 'redness'] }),
            concern({ kind: 'allergen', traits: ['sensitive'] }),
          ],
          analysisVersion: 1,
          referenceVersion: 'seed-1',
          analysedAt: at(MINUTE),
        })

        await repo.saveAnalysis(id, {
          concerns: [concern({ kind: 'drying', traits: ['dry'] })],
          analysisVersion: 2,
          referenceVersion: 'seed-2',
          analysedAt: at(2 * MINUTE),
        })

        const stored = await repo.concernsFor(id)
        expect(stored).toHaveLength(1)
        expect(stored[0]).toMatchObject({ kind: 'drying', position: 0, traits: ['dry'] })
        const formulation = (await repo.findFormulation(id))!
        expect(formulation).toMatchObject({ analysisVersion: 2, referenceVersion: 'seed-2' })
        expect(formulation.analysedAt!.getTime()).toBe(at(2 * MINUTE).getTime())
      })

      it('saveAnalysis with no concerns clears the earlier ones and still marks the formulation analysed', async () => {
        const repo = await make()
        const { id } = await withFormulation(repo)
        await repo.saveAnalysis(id, {
          concerns: [concern()],
          analysisVersion: 1,
          referenceVersion: 'seed-1',
          analysedAt: at(MINUTE),
        })

        await repo.saveAnalysis(id, { concerns: [], analysisVersion: 2, referenceVersion: 'seed-1', analysedAt: at(2 * MINUTE) })

        expect(await repo.concernsFor(id)).toEqual([])
        expect((await repo.findFormulation(id))!.analysisVersion).toBe(2)
      })

      it('saveAnalysis leaves other formulations\' concerns alone', async () => {
        const repo = await make()
        const a = await withFormulation(repo)
        const b = await withFormulation(repo)
        await repo.saveAnalysis(a.id, { concerns: [concern({ kind: 'allergen' })], analysisVersion: 1, referenceVersion: 'seed-1', analysedAt: at(MINUTE) })

        await repo.saveAnalysis(b.id, { concerns: [concern({ kind: 'drying' })], analysisVersion: 1, referenceVersion: 'seed-1', analysedAt: at(MINUTE) })
        await repo.saveAnalysis(b.id, { concerns: [], analysisVersion: 2, referenceVersion: 'seed-1', analysedAt: at(2 * MINUTE) })

        expect((await repo.concernsFor(a.id)).map((c) => c.kind)).toEqual(['allergen'])
        expect((await repo.findFormulation(a.id))!.analysisVersion).toBe(1)
      })
    })

    describe('product image', () => {
      it('setProductImage records the key, the source page and when it was checked', async () => {
        const repo = await make()
        const product = newProduct()
        await repo.createProduct(product)

        await repo.setProductImage(product.id, {
          key: `products/${product.id}.webp`,
          sourceUrl: 'https://brand.example/cleanser',
          checkedAt: at(HOUR),
        })

        const found = (await repo.findProductByKey(product.identityKey))!
        expect(found).toMatchObject({ imageKey: `products/${product.id}.webp`, imageSourceUrl: 'https://brand.example/cleanser' })
        expect(found.imageCheckedAt!.getTime()).toBe(at(HOUR).getTime())
      })

      it('markImageChecked records only the check, leaving the product without an image', async () => {
        const repo = await make()
        const product = newProduct()
        await repo.createProduct(product)

        await repo.markImageChecked(product.id, at(2 * HOUR))

        const found = (await repo.findProductByKey(product.identityKey))!
        expect(found.imageKey).toBeNull()
        expect(found.imageSourceUrl).toBeNull()
        expect(found.imageCheckedAt!.getTime()).toBe(at(2 * HOUR).getTime())
      })
    })

    describe('research attempts', () => {
      // The attempt count is table-wide and D1 may be shared with other tests, so these assert how much it changes.
      type Outcome = 'started' | 'found' | 'not-found' | 'failed'
      const attempt = (over: { id?: string; productId?: string | null; attemptedAt: Date; outcome?: Outcome }) => ({
        id: freshId(),
        productId: null,
        outcome: 'found' as Outcome,
        ...over,
      })
      const windowStart = (hours: number) => at(hours * HOUR + Number(runSalt) * HOUR + counter++ * 10 * MINUTE)

      it('researchAttemptsSince counts an attempt made exactly at the cutoff and later, not one a millisecond before', async () => {
        const repo = await make()
        const since = windowStart(1000)
        const before = await repo.researchAttemptsSince(since)

        await repo.recordResearchAttempt(attempt({ attemptedAt: new Date(since.getTime() - 1) }))
        expect(await repo.researchAttemptsSince(since)).toBe(before)

        await repo.recordResearchAttempt(attempt({ attemptedAt: since }))
        expect(await repo.researchAttemptsSince(since)).toBe(before + 1)

        await repo.recordResearchAttempt(attempt({ attemptedAt: new Date(since.getTime() + 1) }))
        expect(await repo.researchAttemptsSince(since)).toBe(before + 2)
      })

      it('researchAttemptsSince counts started, found and not-found attempts, for a known product or none, but not failed ones', async () => {
        const repo = await make()
        const product = newProduct()
        await repo.createProduct(product)
        const since = windowStart(2000)
        const before = await repo.researchAttemptsSince(since)

        await repo.recordResearchAttempt(attempt({ attemptedAt: since, outcome: 'found', productId: product.id }))
        await repo.recordResearchAttempt(attempt({ attemptedAt: since, outcome: 'not-found', productId: product.id }))
        await repo.recordResearchAttempt(attempt({ attemptedAt: since, outcome: 'started', productId: null }))
        expect(await repo.researchAttemptsSince(since)).toBe(before + 3)

        await repo.recordResearchAttempt(attempt({ attemptedAt: since, outcome: 'failed', productId: product.id }))
        expect(await repo.researchAttemptsSince(since)).toBe(before + 3)
      })

      it('settleResearchAttempt turns a started attempt into its outcome: failed stops counting, found and not-found keep counting', async () => {
        const repo = await make()
        const since = windowStart(3000)
        const before = await repo.researchAttemptsSince(since)
        const [toFail, toFind, toMiss] = [freshId(), freshId(), freshId()]
        for (const id of [toFail, toFind, toMiss]) await repo.recordResearchAttempt(attempt({ id, attemptedAt: since, outcome: 'started' }))
        expect(await repo.researchAttemptsSince(since)).toBe(before + 3)

        await repo.settleResearchAttempt(toFail, 'failed')
        expect(await repo.researchAttemptsSince(since)).toBe(before + 2)

        await repo.settleResearchAttempt(toFind, 'found')
        await repo.settleResearchAttempt(toMiss, 'not-found')
        expect(await repo.researchAttemptsSince(since)).toBe(before + 2)
      })

      it('lastResearchOutcome is null for a product that has had no attempt', async () => {
        const repo = await make()
        const product = newProduct()
        await repo.createProduct(product)

        expect(await repo.lastResearchOutcome(product.id)).toBeNull()
        expect(await repo.lastResearchOutcome(freshId())).toBeNull()
      })

      it('lastResearchOutcome returns the product\'s most recent attempt by time, whatever order they were recorded in, and only that product\'s', async () => {
        const repo = await make()
        const product = newProduct()
        const other = newProduct()
        await repo.createProduct(product)
        await repo.createProduct(other)
        await repo.recordResearchAttempt(attempt({ productId: product.id, attemptedAt: at(2 * HOUR), outcome: 'not-found' }))
        await repo.recordResearchAttempt(attempt({ productId: product.id, attemptedAt: at(HOUR), outcome: 'failed' }))
        await repo.recordResearchAttempt(attempt({ productId: other.id, attemptedAt: at(5 * HOUR), outcome: 'found' }))

        const last = await repo.lastResearchOutcome(product.id)

        expect(last!.outcome).toBe('not-found')
        expect(last!.attemptedAt.getTime()).toBe(at(2 * HOUR).getTime())
      })

      it('lastResearchOutcome follows a settled attempt to its outcome and keeps the time it started', async () => {
        const repo = await make()
        const product = newProduct()
        await repo.createProduct(product)
        const id = freshId()
        await repo.recordResearchAttempt(attempt({ id, productId: product.id, attemptedAt: at(HOUR), outcome: 'started' }))
        expect((await repo.lastResearchOutcome(product.id))!.outcome).toBe('started')

        await repo.settleResearchAttempt(id, 'not-found')

        const last = await repo.lastResearchOutcome(product.id)
        expect(last!.outcome).toBe('not-found')
        expect(last!.attemptedAt.getTime()).toBe(at(HOUR).getTime())
      })
    })

    describe('analysis attempts', () => {
      type Outcome = 'started' | 'ok' | 'rejected' | 'failed'
      const withFormulation = async (repo: CatalogRepository) => {
        const product = newProduct()
        await repo.createProduct(product)
        return repo.createFormulation(newFormulation(product.id))
      }
      const attempt = (formulationId: string, over: { id?: string; attemptedAt?: Date; outcome?: Outcome; analysisVersion?: number; referenceVersion?: string } = {}) => ({
        id: freshId(),
        formulationId,
        attemptedAt: BASE,
        outcome: 'ok' as Outcome,
        analysisVersion: 1,
        referenceVersion: 'ref-a',
        ...over,
      })

      it('analysisAttemptsSince counts a started, ok or rejected attempt made exactly at the cutoff and later, not one a millisecond before, and never a failed one', async () => {
        const repo = await make()
        const formulation = await withFormulation(repo)
        const since = at(4000 * HOUR + Number(runSalt) * HOUR + counter++ * 10 * MINUTE)
        const before = await repo.analysisAttemptsSince(since)

        await repo.recordAnalysisAttempt(attempt(formulation.id, { attemptedAt: new Date(since.getTime() - 1) }))
        expect(await repo.analysisAttemptsSince(since)).toBe(before)

        for (const outcome of ['started', 'ok', 'rejected'] as const) {
          await repo.recordAnalysisAttempt(attempt(formulation.id, { attemptedAt: since, outcome }))
        }
        expect(await repo.analysisAttemptsSince(since)).toBe(before + 3)

        await repo.recordAnalysisAttempt(attempt(formulation.id, { attemptedAt: since, outcome: 'failed' }))
        expect(await repo.analysisAttemptsSince(since)).toBe(before + 3)
      })

      it('settleAnalysisAttempt turns a started attempt into its outcome: a failed one stops counting, an ok or rejected one keeps counting', async () => {
        const repo = await make()
        const formulation = await withFormulation(repo)
        const since = at(5000 * HOUR + Number(runSalt) * HOUR + counter++ * 10 * MINUTE)
        const before = await repo.analysisAttemptsSince(since)
        const [toFail, toPass, toReject] = [freshId(), freshId(), freshId()]
        for (const id of [toFail, toPass, toReject]) {
          await repo.recordAnalysisAttempt(attempt(formulation.id, { id, attemptedAt: since, outcome: 'started' }))
        }
        expect(await repo.analysisAttemptsSince(since)).toBe(before + 3)

        await repo.settleAnalysisAttempt(toFail, 'failed')
        expect(await repo.analysisAttemptsSince(since)).toBe(before + 2)

        await repo.settleAnalysisAttempt(toPass, 'ok')
        await repo.settleAnalysisAttempt(toReject, 'rejected')
        expect(await repo.analysisAttemptsSince(since)).toBe(before + 2)
      })

      it('settling a rejected attempt makes it count as a rejection under its versions', async () => {
        const repo = await make()
        const formulation = await withFormulation(repo)
        const id = freshId()
        await repo.recordAnalysisAttempt(attempt(formulation.id, { id, outcome: 'started' }))
        expect(await repo.rejectedAnalyses(formulation.id, 1, 'ref-a')).toBe(0)

        await repo.settleAnalysisAttempt(id, 'rejected')

        expect(await repo.rejectedAnalyses(formulation.id, 1, 'ref-a')).toBe(1)
      })

      it('lastAnalysisAttempt is null for a formulation that has had no attempt', async () => {
        const repo = await make()
        const formulation = await withFormulation(repo)

        expect(await repo.lastAnalysisAttempt(formulation.id)).toBeNull()
        expect(await repo.lastAnalysisAttempt(freshId())).toBeNull()
      })

      it('lastAnalysisAttempt returns the formulation\'s most recent attempt by time, whatever order they were recorded in, and only that formulation\'s', async () => {
        const repo = await make()
        const formulation = await withFormulation(repo)
        const other = await withFormulation(repo)
        await repo.recordAnalysisAttempt(attempt(formulation.id, { attemptedAt: at(2 * HOUR), outcome: 'rejected' }))
        await repo.recordAnalysisAttempt(attempt(formulation.id, { attemptedAt: at(HOUR), outcome: 'failed' }))
        await repo.recordAnalysisAttempt(attempt(other.id, { attemptedAt: at(5 * HOUR), outcome: 'ok' }))

        const last = await repo.lastAnalysisAttempt(formulation.id)

        expect(last!.outcome).toBe('rejected')
        expect(last!.attemptedAt.getTime()).toBe(at(2 * HOUR).getTime())
      })

      it('lastAnalysisAttempt follows a settled attempt to its outcome and keeps the time it started', async () => {
        const repo = await make()
        const formulation = await withFormulation(repo)
        const id = freshId()
        await repo.recordAnalysisAttempt(attempt(formulation.id, { id, attemptedAt: at(HOUR), outcome: 'started' }))
        expect((await repo.lastAnalysisAttempt(formulation.id))!.outcome).toBe('started')

        await repo.settleAnalysisAttempt(id, 'ok')

        const last = await repo.lastAnalysisAttempt(formulation.id)
        expect(last!.outcome).toBe('ok')
        expect(last!.attemptedAt.getTime()).toBe(at(HOUR).getTime())
      })

      it('rejectedAnalyses counts only the rejections of that formulation under exactly those versions', async () => {
        const repo = await make()
        const formulation = await withFormulation(repo)
        const other = await withFormulation(repo)
        await repo.recordAnalysisAttempt(attempt(formulation.id, { outcome: 'rejected' }))
        await repo.recordAnalysisAttempt(attempt(formulation.id, { outcome: 'rejected' }))
        await repo.recordAnalysisAttempt(attempt(formulation.id, { outcome: 'ok' }))
        await repo.recordAnalysisAttempt(attempt(formulation.id, { outcome: 'failed' }))
        await repo.recordAnalysisAttempt(attempt(formulation.id, { outcome: 'rejected', analysisVersion: 2 }))
        await repo.recordAnalysisAttempt(attempt(formulation.id, { outcome: 'rejected', referenceVersion: 'ref-b' }))
        await repo.recordAnalysisAttempt(attempt(other.id, { outcome: 'rejected' }))

        expect(await repo.rejectedAnalyses(formulation.id, 1, 'ref-a')).toBe(2)
        expect(await repo.rejectedAnalyses(formulation.id, 2, 'ref-a')).toBe(1)
        expect(await repo.rejectedAnalyses(formulation.id, 1, 'ref-b')).toBe(1)
        expect(await repo.rejectedAnalyses(other.id, 1, 'ref-a')).toBe(1)
      })

      it('rejectedAnalyses is zero for a formulation with no attempts', async () => {
        const repo = await make()
        const formulation = await withFormulation(repo)

        expect(await repo.rejectedAnalyses(formulation.id, 1, 'ref-a')).toBe(0)
      })
    })

    describe('adoptUnnamedFormulation', () => {
      /** An unnamed product with its one analysed formulation (one concern), the way a list with no name is stored. */
      const unnamedWithAnalysis = async (repo: CatalogRepository, over: Partial<NewFormulation> = {}) => {
        const unnamed = newUnnamedProduct()
        await repo.createProduct(unnamed)
        const formulation = newFormulation(unnamed.id, { sourceKind: 'label', sourceUrl: null, foundAt: at(HOUR), ...over })
        await repo.createFormulation(formulation)
        await repo.saveAnalysis(formulation.id, {
          concerns: [concern({ kind: 'banned-substance', severity: 'high', traits: ['sensitive'] })],
          analysisVersion: 3,
          referenceVersion: 'seed-9',
          analysedAt: at(2 * HOUR),
        })
        return { unnamed, formulation }
      }
      const namedProduct = async (repo: CatalogRepository) => {
        const named = newProduct()
        await repo.createProduct(named)
        return named
      }

      it('moves the formulation to the named product, keeping its id, its list and source, and its analysis with its concerns', async () => {
        const repo = await make()
        const { formulation } = await unnamedWithAnalysis(repo)
        const named = await namedProduct(repo)
        const concernsBefore = await repo.concernsFor(formulation.id)

        await repo.adoptUnnamedFormulation(formulation.id, named.id)

        const moved = (await repo.findFormulation(formulation.id))!
        expect(moved).toMatchObject({
          id: formulation.id,
          productId: named.id,
          ingredients: formulation.ingredients,
          ingredientsKey: formulation.ingredientsKey,
          sourceKind: 'label',
          sourceUrl: null,
          analysisVersion: 3,
          referenceVersion: 'seed-9',
        })
        expect(moved.foundAt.getTime()).toBe(at(HOUR).getTime())
        expect(moved.analysedAt!.getTime()).toBe(at(2 * HOUR).getTime())
        expect(await repo.concernsFor(formulation.id)).toEqual(concernsBefore)
        expect(concernsBefore).toHaveLength(1)
      })

      it('makes the moved formulation the named product\'s own: found by its latest and by its ingredients key', async () => {
        const repo = await make()
        const { formulation } = await unnamedWithAnalysis(repo)
        const named = await namedProduct(repo)

        await repo.adoptUnnamedFormulation(formulation.id, named.id)

        expect(await repo.latestFormulation(named.id)).toMatchObject({ id: formulation.id })
        expect(await repo.findFormulationByIngredientsKey(named.id, formulation.ingredientsKey)).toMatchObject({ id: formulation.id })
      })

      it('removes the unnamed product, by id and by its identity key', async () => {
        const repo = await make()
        const { unnamed, formulation } = await unnamedWithAnalysis(repo)
        const named = await namedProduct(repo)

        await repo.adoptUnnamedFormulation(formulation.id, named.id)

        expect(await repo.findProductById(unnamed.id)).toBeNull()
        expect(await repo.findProductByKey(unnamed.identityKey)).toBeNull()
        expect(await repo.latestFormulation(unnamed.id)).toBeNull()
      })

      it('keeps the formulation\'s analysis attempts, so a rejection already counted still counts', async () => {
        const repo = await make()
        const { formulation } = await unnamedWithAnalysis(repo)
        const named = await namedProduct(repo)
        await repo.recordAnalysisAttempt({ id: freshId(), formulationId: formulation.id, attemptedAt: BASE, outcome: 'rejected', analysisVersion: 3, referenceVersion: 'seed-9' })

        await repo.adoptUnnamedFormulation(formulation.id, named.id)

        expect(await repo.rejectedAnalyses(formulation.id, 3, 'seed-9')).toBe(1)
      })

      it('leaves the named product\'s other formulations, with their analyses, as they were', async () => {
        const repo = await make()
        const { formulation } = await unnamedWithAnalysis(repo)
        const named = await namedProduct(repo)
        const web = newFormulation(named.id, { foundAt: at(30 * MINUTE) })
        await repo.createFormulation(web)
        await repo.saveAnalysis(web.id, { concerns: [concern()], analysisVersion: 3, referenceVersion: 'seed-9', analysedAt: at(45 * MINUTE) })

        await repo.adoptUnnamedFormulation(formulation.id, named.id)

        expect(await repo.findFormulation(web.id)).toMatchObject({ productId: named.id, analysisVersion: 3 })
        expect(await repo.concernsFor(web.id)).toHaveLength(1)
        // Found after the web one, so the moved list is now the product's latest.
        expect(await repo.latestFormulation(named.id)).toMatchObject({ id: formulation.id })
      })

      it('throws, and changes nothing, when the named product already has a formulation with that ingredients key', async () => {
        const repo = await make()
        const { unnamed, formulation } = await unnamedWithAnalysis(repo)
        const named = await namedProduct(repo)
        const theirs = await repo.createFormulation(newFormulation(named.id, { ingredients: formulation.ingredients, ingredientsKey: formulation.ingredientsKey }))

        await expect(repo.adoptUnnamedFormulation(formulation.id, named.id)).rejects.toThrow()

        expect(await repo.findFormulation(formulation.id)).toMatchObject({ productId: unnamed.id, analysisVersion: 3 })
        expect(await repo.concernsFor(formulation.id)).toHaveLength(1)
        expect(await repo.findProductById(unnamed.id)).toMatchObject({ id: unnamed.id })
        expect(await repo.findFormulationByIngredientsKey(named.id, formulation.ingredientsKey)).toMatchObject({ id: theirs.id })
      })

      it('throws, and changes nothing, for a product that does not exist', async () => {
        const repo = await make()
        const { unnamed, formulation } = await unnamedWithAnalysis(repo)

        await expect(repo.adoptUnnamedFormulation(formulation.id, freshId())).rejects.toThrow()

        expect(await repo.findFormulation(formulation.id)).toMatchObject({ productId: unnamed.id })
        expect(await repo.findProductById(unnamed.id)).not.toBeNull()
      })

      it('throws for a formulation that does not exist, leaving the named product as it was', async () => {
        const repo = await make()
        const named = await namedProduct(repo)

        await expect(repo.adoptUnnamedFormulation(freshId(), named.id)).rejects.toThrow()

        expect(await repo.findProductById(named.id)).toMatchObject({ id: named.id })
      })

      it('lets one of two adopters of the same formulation win: the second, for a different product, throws and the formulation stays with the first', async () => {
        const repo = await make()
        const { formulation } = await unnamedWithAnalysis(repo)
        const first = await namedProduct(repo)
        const second = await namedProduct(repo)
        await repo.adoptUnnamedFormulation(formulation.id, first.id)

        await expect(repo.adoptUnnamedFormulation(formulation.id, second.id)).rejects.toThrow()

        expect(await repo.findFormulation(formulation.id)).toMatchObject({ productId: first.id })
        expect(await repo.findFormulationByIngredientsKey(second.id, formulation.ingredientsKey)).toBeNull()
      })

      it('lets exactly one of two adopters running at once win, whichever it is: the other throws instead of reporting a move that did not happen', async () => {
        const repo = await make()
        const { formulation } = await unnamedWithAnalysis(repo)
        const a = await namedProduct(repo)
        const b = await namedProduct(repo)

        const results = await Promise.allSettled([repo.adoptUnnamedFormulation(formulation.id, a.id), repo.adoptUnnamedFormulation(formulation.id, b.id)])

        expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
        const [winner, loser] = results[0]!.status === 'fulfilled' ? [a, b] : [b, a]
        expect(await repo.findFormulation(formulation.id)).toMatchObject({ productId: winner.id, analysisVersion: 3 })
        expect(await repo.findFormulationByIngredientsKey(loser.id, formulation.ingredientsKey)).toBeNull()
        expect(await repo.concernsFor(formulation.id)).toHaveLength(1)
      })

      it('throws, and removes nothing, for a formulation that belongs to a named product: only an unnamed product is ever given up', async () => {
        const repo = await make()
        const owner = await namedProduct(repo)
        const formulation = await repo.createFormulation(newFormulation(owner.id))
        const target = await namedProduct(repo)

        await expect(repo.adoptUnnamedFormulation(formulation.id, target.id)).rejects.toThrow()

        expect(await repo.findFormulation(formulation.id)).toMatchObject({ productId: owner.id })
        expect(await repo.findProductById(owner.id)).not.toBeNull()
        expect(await repo.findProductById(target.id)).not.toBeNull()
      })
    })
  })
}
