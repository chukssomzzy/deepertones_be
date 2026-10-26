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
    form: null,
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
  form: null,
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

      it('createProduct stores the form, and findProductByKey and findProductById read it back', async () => {
        const repo = await make()
        const input = newProduct({ form: 'roll-on' })

        const created = await repo.createProduct(input)

        expect(created.form).toBe('roll-on')
        expect(await repo.findProductByKey(input.identityKey)).toMatchObject({ id: input.id, form: 'roll-on' })
        expect(await repo.findProductById(input.id)).toMatchObject({ form: 'roll-on' })
      })

      it('createProduct stores no form as null', async () => {
        const repo = await make()
        const input = newProduct({ form: null })

        const created = await repo.createProduct(input)

        expect(created.form).toBeNull()
        expect((await repo.findProductById(input.id))!.form).toBeNull()
      })

      it('createProduct with an identity key that is already stored creates nothing and returns the existing product', async () => {
        const repo = await make()
        const first = newProduct({ name: 'Original Name' })
        await repo.createProduct(first)

        const second = await repo.createProduct(newProduct({ identityKey: first.identityKey, brandKey: first.brandKey, name: 'Raced Name' }))

        expect(second).toMatchObject({ id: first.id, name: 'Original Name' })
        expect(await repo.productsByBrandFamily(first.brandKey, 10)).toHaveLength(1)
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

    // D1 binds at most 100 parameters per statement, so the repository reads ids in chunks; these sizes straddle the chunk edge.
    describe.each([
      {
        method: 'findProductsByIds' as const,
        store: async (repo: CatalogRepository, count: number) => {
          const rows = Array.from({ length: count }, () => newProduct())
          for (const row of rows) await repo.createProduct(row)
          return rows.map((row) => row.id)
        },
      },
      {
        method: 'findFormulationsByIds' as const,
        store: async (repo: CatalogRepository, count: number) => {
          const product = newProduct()
          await repo.createProduct(product)
          const rows = Array.from({ length: count }, () => newFormulation(product.id))
          for (const row of rows) await repo.createFormulation(row)
          return rows.map((row) => row.id)
        },
      },
    ])('$method', ({ method, store }) => {
      const idsOf = (rows: { id: string }[]) => rows.map((row) => row.id)

      it.each([1, 90, 91, 95, 181])('returns each of %i stored ids once', async (count) => {
        const repo = await make()
        const ids = await store(repo, count)

        const found = idsOf(await repo[method](ids))

        expect(found).toHaveLength(count)
        expect([...found].sort()).toEqual([...ids].sort())
      })

      it('returns exactly the stored ones when some of the ids are unknown', async () => {
        const repo = await make()
        const ids = await store(repo, 95)

        const found = idsOf(await repo[method]([...ids.slice(0, 50), freshId(), ...ids.slice(50), freshId()]))

        expect(found).toHaveLength(95)
        expect([...found].sort()).toEqual([...ids].sort())
      })

      it('returns nothing for no ids, and nothing for ids nobody has', async () => {
        const repo = await make()

        expect(await repo[method]([])).toEqual([])
        expect(await repo[method](Array.from({ length: 95 }, freshId))).toEqual([])
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

    describe('productsByBrandFamily', () => {
      it('returns the products whose brand key is the first word or starts with it and a space, and no others', async () => {
        const repo = await make()
        const word = fresh('nivea')
        const plain = newProduct({ brandKey: word })
        const men = newProduct({ brandKey: `${word} men` })
        const sun = newProduct({ brandKey: `${word} sun` })
        const longer = newProduct({ brandKey: `${word} men sport` })
        const lookalike = newProduct({ brandKey: `${word}ux` })
        const suffixed = newProduct({ brandKey: `${word}2` })
        const elsewhere = newProduct()
        const endsWithIt = newProduct({ brandKey: `body ${word}` })
        for (const p of [plain, lookalike, men, elsewhere, sun, suffixed, endsWithIt, longer]) await repo.createProduct(p)

        const found = await repo.productsByBrandFamily(word, 10)

        expect(found.map((p) => p.id).sort()).toEqual([plain.id, men.id, sun.id, longer.id].sort())
      })

      it('finds a family that has no product with the bare first word as its brand key', async () => {
        const repo = await make()
        const word = fresh('garnier')
        const fructis = newProduct({ brandKey: `${word} fructis` })
        await repo.createProduct(fructis)

        expect((await repo.productsByBrandFamily(word, 10)).map((p) => p.id)).toEqual([fructis.id])
      })

      it('returns the newest products first across the family, a later insert before an earlier one created at the same time', async () => {
        const repo = await make()
        const word = fresh('nivea')
        const oldest = newProduct({ brandKey: word, createdAt: at(-HOUR) })
        const middle = newProduct({ brandKey: `${word} men`, createdAt: at(HOUR) })
        const tiedLater = newProduct({ brandKey: `${word} sun`, createdAt: at(HOUR) })
        const newest = newProduct({ brandKey: word, createdAt: at(2 * HOUR) })
        for (const p of [middle, oldest, newest, tiedLater]) await repo.createProduct(p)

        expect((await repo.productsByBrandFamily(word, 10)).map((p) => p.id)).toEqual([newest.id, tiedLater.id, middle.id, oldest.id])
      })

      it('returns at most limit products, the newest ones', async () => {
        const repo = await make()
        const word = fresh('nivea')
        const old = newProduct({ brandKey: word, createdAt: at(-HOUR) })
        const mid = newProduct({ brandKey: `${word} men`, createdAt: at(0) })
        const recent = newProduct({ brandKey: `${word} sun`, createdAt: at(HOUR) })
        for (const p of [old, mid, recent]) await repo.createProduct(p)

        expect((await repo.productsByBrandFamily(word, 2)).map((p) => p.id)).toEqual([recent.id, mid.id])
        expect(await repo.productsByBrandFamily(word, 3)).toHaveLength(3)
      })

      it('returns an empty list for an unknown first word', async () => {
        const repo = await make()

        expect(await repo.productsByBrandFamily(fresh('nivea'), 10)).toEqual([])
      })

      it('returns only the products with an empty brand key for an empty first word', async () => {
        const repo = await make()
        const blank = newProduct({ brandKey: '' })
        const named = newProduct({ brandKey: fresh('nivea') })
        for (const p of [named, blank]) await repo.createProduct(p)

        const found = await repo.productsByBrandFamily('', 10)

        expect(found.map((p) => p.id)).toContain(blank.id)
        expect(found.every((p) => p.brandKey === '')).toBe(true)
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

    describe('search text', () => {
      it('createProduct keeps the search text it is given, and findProductById reads it back', async () => {
        const repo = await make()
        const input = newProduct({ searchText: 'cerave hydrating facial cleanser' })

        expect(await repo.createProduct(input)).toMatchObject({ searchText: 'cerave hydrating facial cleanser' })
        expect(await repo.findProductById(input.id)).toMatchObject({ searchText: 'cerave hydrating facial cleanser' })
      })

      it('createProduct stores an empty search text for a product given none', async () => {
        const repo = await make()
        const input = newProduct()

        expect(await repo.createProduct(input)).toMatchObject({ searchText: '' })
        expect(await repo.findProductById(input.id)).toMatchObject({ searchText: '' })
      })
    })

    describe('filling in search text', () => {
      // The finder sees every product in a shared D1 whose search text is empty, and the fixtures of other tests leave it empty. So a test makes its own
      // products with ids that start with "!<its own word>" and reads only those back; it never writes to a row it did not make.
      const word = () => `w${runSalt}n${counter++}z`
      const mine = (w: string, suffix: string, over: Partial<NewProduct> = {}) => newProduct({ id: `!${w}-${suffix}`, brand: 'Acme', name: `${w} ${suffix}`, ...over })
      const ownIds = (found: { id: string }[], w: string) => found.map((p) => p.id).filter((id) => id.startsWith(`!${w}-`))

      it('finds a named product whose search text is empty, and not one that has search text', async () => {
        const repo = await make()
        const w = word()
        const [empty, filled] = [mine(w, 'a'), mine(w, 'b', { searchText: 'acme something' })]
        for (const p of [empty, filled]) await repo.createProduct(p)

        const found = await repo.namedWithoutSearchText(500)

        expect(ownIds(found, w)).toEqual([empty.id])
        expect(found.find((p) => p.id === empty.id)).toMatchObject({ brand: 'Acme', kind: 'named', searchText: '' })
        expect(found.every((p) => p.kind === 'named' && p.searchText === '')).toBe(true)
      })

      it('never returns an unnamed product, though its search text is empty', async () => {
        const repo = await make()
        const w = word()
        const [unnamed, named] = [newUnnamedProduct({ id: `!${w}-u` }), mine(w, 'a')]
        for (const p of [unnamed, named]) await repo.createProduct(p)

        const found = await repo.namedWithoutSearchText(500)

        expect(ownIds(found, w)).toEqual([named.id])
        expect(found.map((p) => p.id)).not.toContain(unnamed.id)
      })

      it('returns its products in id order', async () => {
        const repo = await make()
        const w = word()
        for (const suffix of ['c', 'a', 'b']) await repo.createProduct(mine(w, suffix))

        expect(ownIds(await repo.namedWithoutSearchText(500), w)).toEqual([`!${w}-a`, `!${w}-b`, `!${w}-c`])
      })

      it('returns at most `limit` products, the first ones in id order', async () => {
        const repo = await make()
        const w = word()
        for (const suffix of ['c', 'a', 'b']) await repo.createProduct(mine(w, suffix))

        // Other tests may have left rows with empty text, so the limited answers are compared with the unlimited one, not with a fixed list.
        const all = (await repo.namedWithoutSearchText(500)).map((p) => p.id)
        expect(all.length).toBeGreaterThanOrEqual(3)
        expect((await repo.namedWithoutSearchText(2)).map((p) => p.id)).toEqual(all.slice(0, 2))
        expect((await repo.namedWithoutSearchText(3)).map((p) => p.id)).toEqual(all.slice(0, 3))
        expect((await repo.namedWithoutSearchText(1)).map((p) => p.id)).toEqual(all.slice(0, 1))
        expect(await repo.namedWithoutSearchText(0)).toEqual([])
      })

      it('setSearchText sets one product\'s search text, which search then finds, and stops it being returned by the finder', async () => {
        const repo = await make()
        const w = word()
        const [one, other] = [mine(w, 'a'), mine(w, 'b')]
        for (const p of [one, other]) await repo.createProduct(p)
        // Search lists only products with ingredients, so the one it must find has a formulation.
        await repo.createFormulation(newFormulation(one.id))

        await repo.setSearchText(one.id, `acme ${w} filled`)

        expect(await repo.findProductById(one.id)).toMatchObject({ searchText: `acme ${w} filled` })
        expect((await repo.search(`${w} filled`, 10)).map((p) => p.id)).toEqual([one.id])
        expect(ownIds(await repo.namedWithoutSearchText(500), w)).toEqual([other.id])
        expect(await repo.findProductById(other.id)).toMatchObject({ searchText: '' })
      })

      it('setSearchText changes nothing but the search text', async () => {
        const repo = await make()
        const w = word()
        const input = mine(w, 'a', { variant: 'Night', category: 'hair' })
        await repo.createProduct(input)

        await repo.setSearchText(input.id, 'something')

        expect(await repo.findProductById(input.id)).toMatchObject({
          id: input.id,
          identityKey: input.identityKey,
          brandKey: input.brandKey,
          kind: 'named',
          brand: 'Acme',
          name: `${w} a`,
          variant: 'Night',
          category: 'hair',
          imageKey: null,
        })
      })

      describe('setSearchTexts', () => {
        it('sets the search text of several products in one call, which search then finds', async () => {
          const repo = await make()
          const w = word()
          const made = [mine(w, 'a'), mine(w, 'b'), mine(w, 'c')]
          for (const p of made) await repo.createProduct(p)
          // Search lists only products with ingredients.
          for (const p of made) await repo.createFormulation(newFormulation(p.id))

          await repo.setSearchTexts(made.map((p, i) => ({ id: p.id, searchText: `acme ${w} text${i}` })))

          for (const [i, p] of made.entries()) expect(await repo.findProductById(p.id)).toMatchObject({ searchText: `acme ${w} text${i}` })
          expect(ownIds(await repo.namedWithoutSearchText(500), w)).toEqual([])
          expect((await repo.search(w, 10)).map((p) => p.id)).toEqual(made.map((p) => p.id))
        })

        it('ignores an id that is not a product, and still applies the others', async () => {
          const repo = await make()
          const w = word()
          const [one, two] = [mine(w, 'a'), mine(w, 'b')]
          for (const p of [one, two]) await repo.createProduct(p)

          await expect(
            repo.setSearchTexts([
              { id: one.id, searchText: 'first' },
              { id: `!${w}-nobody`, searchText: 'nobody' },
              { id: two.id, searchText: 'second' },
            ]),
          ).resolves.toBeUndefined()

          expect(await repo.findProductById(one.id)).toMatchObject({ searchText: 'first' })
          expect(await repo.findProductById(two.id)).toMatchObject({ searchText: 'second' })
          expect(await repo.findProductById(`!${w}-nobody`)).toBeNull()
        })

        it('does nothing for an empty list', async () => {
          const repo = await make()
          const w = word()
          const input = mine(w, 'a')
          await repo.createProduct(input)

          await expect(repo.setSearchTexts([])).resolves.toBeUndefined()

          expect(await repo.findProductById(input.id)).toMatchObject({ searchText: '' })
        })

        it('changes nothing but the search text', async () => {
          const repo = await make()
          const w = word()
          const input = mine(w, 'a', { variant: 'Night', category: 'hair' })
          await repo.createProduct(input)

          await repo.setSearchTexts([{ id: input.id, searchText: 'something' }])

          expect(await repo.findProductById(input.id)).toMatchObject({
            id: input.id,
            identityKey: input.identityKey,
            brandKey: input.brandKey,
            kind: 'named',
            brand: 'Acme',
            name: `${w} a`,
            variant: 'Night',
            category: 'hair',
            imageKey: null,
            searchText: 'something',
          })
        })

        it('takes 500 rows in one call', async () => {
          const repo = await make()
          const w = word()
          const made = Array.from({ length: 500 }, (_, i) => mine(w, String(i).padStart(3, '0')))
          for (const p of made) await repo.createProduct(p)
          // Search lists only products with ingredients; the one the search below must find has them.
          await repo.createFormulation(newFormulation(made[250]!.id))

          await repo.setSearchTexts(made.map((p, i) => ({ id: p.id, searchText: `acme ${w} n${i}z` })))

          expect(ownIds(await repo.namedWithoutSearchText(1000), w)).toEqual([])
          expect(await repo.findProductById(made[0]!.id)).toMatchObject({ searchText: `acme ${w} n0z` })
          expect(await repo.findProductById(made[499]!.id)).toMatchObject({ searchText: `acme ${w} n499z` })
          expect((await repo.search(`${w} n250z`, 10)).map((p) => p.id)).toEqual([made[250]!.id])
          // 500 sequential inserts: ~0.7s alone, but over the 5s default on a loaded CI runner (staging run 40336099906).
        }, 30_000)
      })

      it('setSearchText for an unknown id does nothing and does not throw', async () => {
        const repo = await make()

        await expect(repo.setSearchText(`!${word()}-nobody`, 'x')).resolves.toBeUndefined()
      })
    })

    describe('search', () => {
      // Each call yields a word no other test (or earlier run against a shared D1) uses, and none is inside another: the "z" ends it.
      const word = () => `w${runSalt}n${counter++}z`
      /** A named product whose search text is written out by hand, as the service would build it: lower case, normalised. */
      const searchable = (searchText: string, over: Partial<NewProduct> = {}): NewProduct => {
        const [brand = '', ...rest] = searchText.split(' ')
        return newProduct({ brand, name: rest.join(' '), brandKey: fresh('brand'), searchText, ...over })
      }
      const idsOf = (products: { id: string }[]) => products.map((p) => p.id)
      /**
       * A product the catalog has ingredients for. Search lists only those (a product nobody has found a list for is hidden, see the tests on
       * that below), so every fixture a test needs search to find is made with this.
       */
      const listed = async (repo: CatalogRepository, input: NewProduct) => {
        const product = await repo.createProduct(input)
        await repo.createFormulation(newFormulation(product.id))
        return product
      }

      it('finds a named product by a fragment in the middle of its search text, and returns the stored product', async () => {
        const repo = await make()
        const w = word()
        const product = await listed(repo, searchable(`acme ${w} glow serum`, { variant: 'Night', category: 'skin' }))

        const found = await repo.search(`${w} glow`, 10)

        expect(found).toHaveLength(1)
        expect(found[0]).toMatchObject({ id: product.id, kind: 'named', brand: 'acme', variant: 'Night', category: 'skin', imageKey: null })
      })

      it('finds a product by a fragment at the very start and at the very end of its search text', async () => {
        const repo = await make()
        const w = word()
        const product = await listed(repo, searchable(`acme glow ${w}`))

        expect(idsOf(await repo.search('acme', 10))).toContain(product.id)
        expect(idsOf(await repo.search(w, 10))).toEqual([product.id])
      })

      it('finds nothing for text that no search text or alias contains', async () => {
        const repo = await make()
        await listed(repo, searchable(`acme ${word()} glow`))

        expect(await repo.search(word(), 10)).toEqual([])
      })

      it('finds nothing, rather than every product, for an empty query', async () => {
        const repo = await make()
        await listed(repo, searchable(`acme ${word()} glow`))

        expect(await repo.search('', 10)).toEqual([])
      })

      it('never returns an unnamed product, even for a word in its identity key', async () => {
        const repo = await make()
        const w = word()
        await repo.createProduct(newUnnamedProduct({ identityKey: `unnamed:aqua\n${w}\nglycerin`, searchText: '' }))

        expect(await repo.search(w, 10)).toEqual([])
        expect(await repo.search('aqua', 10)).not.toContainEqual(expect.objectContaining({ kind: 'unnamed' }))
      })

      describe('a product with no formulation', () => {
        it('is not found, though its search text matches', async () => {
          const repo = await make()
          const w = word()
          await repo.createProduct(searchable(`acme ${w} glow serum`))

          expect(await repo.search(w, 10)).toEqual([])
          expect(await repo.search(`${w} glow`, 10)).toEqual([])
        })

        it('is found once a formulation is stored for it, whether it came from the web or from a label', async () => {
          const repo = await make()
          const [web, label] = [word(), word()]
          const fromWeb = await repo.createProduct(searchable(`acme ${web} serum`))
          const fromLabel = await repo.createProduct(searchable(`acme ${label} serum`))
          expect(await repo.search(web, 10)).toEqual([])
          expect(await repo.search(label, 10)).toEqual([])

          await repo.createFormulation(newFormulation(fromWeb.id, { sourceKind: 'web' }))
          await repo.createFormulation(newFormulation(fromLabel.id, { sourceKind: 'label', sourceUrl: null }))

          expect(idsOf(await repo.search(web, 10))).toEqual([fromWeb.id])
          expect(idsOf(await repo.search(label, 10))).toEqual([fromLabel.id])
        })

        it('is found with a formulation however old it is or whether it was analysed', async () => {
          const repo = await make()
          const w = word()
          const product = await repo.createProduct(searchable(`acme ${w} serum`))

          await repo.createFormulation(newFormulation(product.id, { foundAt: at(-400 * 24 * HOUR) }))

          expect(idsOf(await repo.search(w, 10))).toEqual([product.id])
        })

        it('is not listed because another product has a formulation: each product needs its own', async () => {
          const repo = await make()
          const w = word()
          const hidden = await repo.createProduct(searchable(`acme ${w} ghost`))
          const shown = await listed(repo, searchable(`acme ${w} real`))

          expect(idsOf(await repo.search(w, 10))).toEqual([shown.id])
          expect(idsOf(await repo.search(w, 10))).not.toContain(hidden.id)
        })

        it('is not found through an alias until it has a formulation, and then is', async () => {
          const repo = await make()
          const w = word()
          const product = await repo.createProduct(searchable(`acme ${word()} cleanser`))
          await repo.addAlias(`acme|${w} wash|`, product.id)
          expect(await repo.search(w, 10)).toEqual([])

          await repo.createFormulation(newFormulation(product.id))

          expect(idsOf(await repo.search(w, 10))).toEqual([product.id])
        })

        it('still lists a product with a formulation through its aliases, once, however many formulations it has', async () => {
          const repo = await make()
          const w = word()
          const product = await listed(repo, searchable(`acme ${word()} cleanser`))
          await repo.createFormulation(newFormulation(product.id))
          await repo.addAlias(`acme|${w} wash|`, product.id)
          await repo.addAlias(`acme|${w} foam|night`, product.id)

          expect(idsOf(await repo.search(w, 10))).toEqual([product.id])
        })

        it('does not use up the limit: products with no formulation ahead of listed ones leave the listed ones their places', async () => {
          const repo = await make()
          const w = word()
          for (const suffix of ['a', 'b', 'c']) await repo.createProduct(searchable(`${w} ${suffix}`))
          const shown = [await listed(repo, searchable(`${w} d`)), await listed(repo, searchable(`${w} e`))]

          expect(idsOf(await repo.search(w, 2))).toEqual(shown.map((p) => p.id))
        })
      })

      describe('through an alias', () => {
        it('finds a product by text in one of its aliases, when its own search text does not contain it', async () => {
          const repo = await make()
          const w = word()
          const product = await listed(repo, searchable(`acme ${word()} cleanser`))
          await repo.addAlias(`acme|${w} wash|`, product.id)

          expect(idsOf(await repo.search(w, 10))).toEqual([product.id])
        })

        it('does not return a product for another product\'s alias', async () => {
          const repo = await make()
          const w = word()
          const owner = await listed(repo, searchable(`acme ${word()} cleanser`))
          const other = await listed(repo, searchable(`beta ${word()} cleanser`))
          await repo.addAlias(`acme|${w} wash|`, owner.id)

          expect(idsOf(await repo.search(w, 10))).toEqual([owner.id])
          expect(idsOf(await repo.search(w, 10))).not.toContain(other.id)
        })

        it('returns a product reachable through its search text and an alias once, and through two aliases once', async () => {
          const repo = await make()
          const w = word()
          const product = await listed(repo, searchable(`acme ${w} cleanser`))
          await repo.addAlias(`acme|${w} wash|`, product.id)
          await repo.addAlias(`acme|${w} foam|night`, product.id)

          expect(idsOf(await repo.search(w, 10))).toEqual([product.id])
        })
      })

      describe('with several words', () => {
        it('finds a product by words in a different order, and by words that leave some of its own out', async () => {
          const repo = await make()
          const w = word()
          const product = await listed(repo, searchable(`acme ${w} glow serum`))

          expect(idsOf(await repo.search(`serum ${w}`, 10))).toEqual([product.id])
          expect(idsOf(await repo.search(`${w} serum`, 10))).toEqual([product.id])
          expect(idsOf(await repo.search(`serum ${w} acme`, 10))).toEqual([product.id])
        })

        it('finds nothing when one of the words is in neither the search text nor an alias', async () => {
          const repo = await make()
          const w = word()
          await listed(repo, searchable(`acme ${w} glow serum`))

          expect(await repo.search(`${w} serum ${word()}`, 10)).toEqual([])
        })

        it('matches each word as a fragment, not as a whole word', async () => {
          const repo = await make()
          const w = word()
          const product = await listed(repo, searchable(`acme ${w} glowing serums`))

          expect(idsOf(await repo.search(`${w} glow serum`, 10))).toEqual([product.id])
        })

        it('ignores empty words, so extra spaces change nothing, and finds nothing for a query of only spaces', async () => {
          const repo = await make()
          const w = word()
          const product = await listed(repo, searchable(`acme ${w} glow serum`))

          expect(idsOf(await repo.search(`  ${w}   glow  `, 10))).toEqual([product.id])
          expect(await repo.search('   ', 10)).toEqual([])
        })

        it('looks at the first 8 words only: a 9th that nothing contains is ignored, while an 8th that nothing contains is not', async () => {
          const repo = await make()
          const w = word()
          const product = await listed(repo, searchable(`${w} a b c d e f g`))

          expect(idsOf(await repo.search(`${w} a b c d e f g ${word()}`, 10))).toEqual([product.id])
          expect(await repo.search(`${w} a b c d e f ${word()} g`, 10)).toEqual([])
        })

        it('takes a query of up to 80 characters: one that is exactly the search text finds it, and a long one that matches nothing finds nothing', async () => {
          const repo = await make()
          const w = word()
          const words = [w, ...Array.from({ length: 7 }, (_, i) => `abcdefg${i}`)]
          const base = words.join(' ')
          const text = `${base}${'x'.repeat(80 - base.length)}`
          expect(text).toHaveLength(80)
          const product = await listed(repo, searchable(text))

          expect(idsOf(await repo.search(text, 10))).toEqual([product.id])
          expect(await repo.search(`${w}${'y'.repeat(80 - w.length)}`, 10)).toEqual([])
          expect(await repo.search('y'.repeat(80), 10)).toEqual([])
        })

        it('finds a product when every word is in one of its aliases, even words that are not in its search text, and across the "|" between brand and name', async () => {
          const repo = await make()
          const w = word()
          const product = await listed(repo, searchable(`acme ${word()} cleanser`))
          await repo.addAlias(`acme|${w} foaming wash|night`, product.id)

          expect(idsOf(await repo.search(`wash ${w}`, 10))).toEqual([product.id])
          expect(idsOf(await repo.search(`acme ${w} night`, 10))).toEqual([product.id])
        })

        it('does not combine the search text and an alias: words split between them find nothing', async () => {
          const repo = await make()
          const [inText, inAlias] = [word(), word()]
          const product = await listed(repo, searchable(`acme ${inText} cleanser`))
          await repo.addAlias(`acme|${inAlias} wash|`, product.id)

          expect(await repo.search(`${inText} ${inAlias}`, 10)).toEqual([])
        })

        it('does not combine two aliases either', async () => {
          const repo = await make()
          const [one, two] = [word(), word()]
          const product = await listed(repo, searchable(`acme ${word()} cleanser`))
          await repo.addAlias(`acme|${one} wash|`, product.id)
          await repo.addAlias(`acme|${two} foam|`, product.id)

          expect(await repo.search(`${one} ${two}`, 10)).toEqual([])
        })

        it('returns a product once though its search text and two of its aliases all match', async () => {
          const repo = await make()
          const w = word()
          const product = await listed(repo, searchable(`acme ${w} cleanser`))
          await repo.addAlias(`acme|${w} wash|`, product.id)
          await repo.addAlias(`acme|${w} foam|night`, product.id)

          expect(idsOf(await repo.search(`cleanser ${w}`, 10))).toEqual([product.id])
          expect(idsOf(await repo.search(`acme ${w}`, 10))).toEqual([product.id])
        })

        it('ranks a search text that starts with the whole query before one that only holds all its words, though the other sorts first', async () => {
          const repo = await make()
          const w = word()
          const holds = await listed(repo, searchable(`${w} aloe butter`))
          const starts = await listed(repo, searchable(`${w} butter cream`))

          expect(idsOf(await repo.search(`${w} butter`, 10))).toEqual([starts.id, holds.id])
        })
      })

      describe('the limit', () => {
        it('returns at most `limit` products: the first ones in the order below, not any ten', async () => {
          const repo = await make()
          const w = word()
          for (const suffix of ['d', 'b', 'e', 'a', 'c']) await listed(repo, searchable(`${w} ${suffix}`))

          const found = await repo.search(w, 3)

          expect(found.map((p) => p.searchText)).toEqual([`${w} a`, `${w} b`, `${w} c`])
        })

        it('returns everything when fewer products match than the limit, and exactly `limit` at the boundary', async () => {
          const repo = await make()
          const w = word()
          for (const suffix of ['a', 'b', 'c']) await listed(repo, searchable(`${w} ${suffix}`))

          expect(await repo.search(w, 4)).toHaveLength(3)
          expect(await repo.search(w, 3)).toHaveLength(3)
          expect(await repo.search(w, 2)).toHaveLength(2)
        })
      })

      describe('the order', () => {
        it('puts a product whose search text starts with the query before one that only contains it, though the other sorts first alphabetically', async () => {
          const repo = await make()
          const w = word()
          const contains = await listed(repo, searchable(`acme ${w} glow`))
          const prefix = await listed(repo, searchable(`${w} body butter`))

          // "acme ..." sorts before "w..." on its own, so only the prefix rule can put the other first.
          expect(idsOf(await repo.search(w, 10))).toEqual([prefix.id, contains.id])
        })

        it('orders products of the same rank by search text', async () => {
          const repo = await make()
          const w = word()
          const prefixes = [`${w} c`, `${w} a`, `${w} b`]
          const containing = [`acme ${w} z`, `acme ${w} y`]
          for (const text of [...prefixes, ...containing]) await listed(repo, searchable(text))

          const found = await repo.search(w, 10)

          expect(found.map((p) => p.searchText)).toEqual([`${w} a`, `${w} b`, `${w} c`, `acme ${w} y`, `acme ${w} z`])
        })

        it('orders products with the same search text by id', async () => {
          const repo = await make()
          const w = word()
          // Created in the reverse of the expected order, with ids that do not come from the clock.
          for (const suffix of ['c', 'a', 'b']) await listed(repo, searchable(`acme ${w} glow`, { id: `${w}-${suffix}` }))

          expect(idsOf(await repo.search(w, 10))).toEqual([`${w}-a`, `${w}-b`, `${w}-c`])
        })

        it('gives the same order every time it is asked', async () => {
          const repo = await make()
          const w = word()
          for (const text of [`acme ${w} b`, `${w} z`, `acme ${w} a`, `${w} y`]) await listed(repo, searchable(text))

          const first = idsOf(await repo.search(w, 10))

          expect(idsOf(await repo.search(w, 10))).toEqual(first)
          expect(first).toHaveLength(4)
        })
      })
    })
  })
}
