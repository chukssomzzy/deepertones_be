import { describe, expect, it, vi } from 'vitest'
import { PermanentJobError } from '../../jobs/job'
import { NotFoundError, UnavailableError, ValidationError } from '../../lib/errors'
import { AiBudgetExceededError } from '../../providers/anthropic/ai-spend.provider'
import { MemoryCatalogImageStore } from '../../providers/catalog-images/memory.catalog-image-store'
import { MemoryProductAnalyst } from '../../providers/product-analysis/memory.product-analyst'
import type { DraftConcern, ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import { MemoryProductResearcher } from '../../providers/product-research/memory.product-researcher'
import type { ProductForm, ProductIdentity } from '../../providers/product-research/product-researcher.provider'
import { identityKey } from './catalog.identity'
import { REFERENCE_COVERAGE, REFERENCE_VERSION } from './catalog.reference'
import { FakeCatalogRepository } from './catalog.repository.fake'
import { AnalysisRejectedError, CATALOG_POLICY, CatalogBusyError, ProductCatalogService } from './catalog.service'
import type { DraftConcernRow } from './catalog.types'
import { ANALYSIS_VERSION, CONCERN_KINDS, FRESH_FOR_DAYS, SEVERITIES, TRAITS } from './catalog.vocabulary'

// The repository contract (fake and D1) is mounted by catalog.repository.test.ts and its integration twin.

const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const SOURCE_URL = 'https://www.cerave.com/hydrating-cleanser'
const IMAGE_KEY_PREFIX = 'catalog/test'
const IMAGE_URL = 'https://www.cerave.com/images/hydrating-cleanser.jpg'
// The regulation URL the seed reference data attaches to banned substances and named fragrance allergens.
const EUR_LEX = 'https://eur-lex.europa.eu/eli/reg/2009/1223/oj'
const MADE_UP_SOURCE = 'https://made-up.example/claim'

/** Nothing here is in the seed reference data, so a formulation of these needs no concern. */
const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
/** "Mercury" is a banned substance in the seed reference data (one rule, regulation source). */
const WITH_MERCURY = ['Aqua', 'Mercury', 'Glycerin']

const JPEG: ProductImage = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg' }

const identity = (over: Partial<ProductIdentity> = {}): ProductIdentity => ({
  brand: 'CeraVe',
  name: 'Hydrating Facial Cleanser',
  category: 'skin',
  ...over,
})

type SetupOptions = {
  policy?: Partial<typeof CATALOG_POLICY>
  images?: MemoryCatalogImageStore
  repository?: FakeCatalogRepository
  researcher?: MemoryProductResearcher
}

const setup = (options: SetupOptions = {}) => {
  let clock = T0
  let n = 0
  const repository = options.repository ?? new FakeCatalogRepository()
  const researcher = options.researcher ?? new MemoryProductResearcher()
  const analyst = new MemoryProductAnalyst()
  const images = options.images ?? new MemoryCatalogImageStore()
  const service = new ProductCatalogService({
    repository,
    researcher,
    analyst,
    images,
    imageKeyPrefix: IMAGE_KEY_PREFIX,
    now: () => clock,
    newId: () => `id-${++n}`,
    ...(options.policy ? { policy: { ...CATALOG_POLICY, ...options.policy } } : {}),
  })
  return { service, repository, researcher, analyst, images, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) }
}
type Ctx = ReturnType<typeof setup>

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

/** Resolves a new product and researches it, through the service, so the product and formulation are real. */
const researched = async (ctx: Ctx, over: { who?: ProductIdentity; ingredients?: string[] } = {}) => {
  const { who = identity(), ingredients = CLEAN } = over
  ctx.researcher.respondWith(() => ({ found: true, ingredients, sourceUrl: SOURCE_URL }))
  const resolved = await ctx.service.resolve(who)
  if (resolved.kind !== 'needs-research') throw new Error(`expected needs-research, got ${resolved.kind}`)
  const found = await ctx.service.research(resolved.productId)
  if (found.kind !== 'found') throw new Error(`expected found, got ${found.kind}`)
  return { productId: resolved.productId, formulationId: found.formulationId }
}

/** researched, then analysed with the current analysis version and no concerns. */
const analysed = async (ctx: Ctx, over: { who?: ProductIdentity; ingredients?: string[] } = {}) => {
  const product = await researched(ctx, over)
  await ctx.service.analyse(product.formulationId)
  return product
}

const draft = (over: Partial<DraftConcern> = {}): DraftConcern => ({
  kind: 'banned-substance',
  severity: 'high',
  ingredients: ['Mercury'],
  why: 'Mercury is prohibited in cosmetics and is a known poisoning risk.',
  whoShouldTakeCare: 'Everyone, and especially anyone pregnant.',
  traits: ['sensitive'],
  sources: [EUR_LEX],
  ...over,
})

const OLD_CONCERN: DraftConcernRow = {
  kind: 'banned-substance',
  severity: 'high',
  ingredients: ['Mercury'],
  why: 'First opinion.',
  whoShouldTakeCare: 'Everyone.',
  traits: [],
  sources: [],
}

/**
 * An analysis made by older code. The service only ever writes the current versions, so the only way to reach
 * "analysed, but not by the current analysis or reference version" is to write it through the repository.
 */
const analysedByOlderCode = (ctx: Ctx, formulationId: string, over: { analysisVersion?: number; referenceVersion?: string }) =>
  ctx.repository.saveAnalysis(formulationId, {
    concerns: [OLD_CONCERN],
    analysisVersion: ANALYSIS_VERSION,
    referenceVersion: REFERENCE_VERSION,
    analysedAt: T0,
    ...over,
  })
const OLDER_CODE = [
  ['an older analysis version', { analysisVersion: ANALYSIS_VERSION - 1 }],
  ['an older reference version', { referenceVersion: 'seed-old' }],
] as const

describe('CATALOG_POLICY', () => {
  it('sets the research and analysis budgets, brand scan, near-miss threshold and near-miss limit', () => {
    expect(CATALOG_POLICY).toEqual({ dailyResearchBudget: 200, dailyAnalysisBudget: 300, brandScanLimit: 50, nearMissThreshold: 0.6, nearMissLimit: 3 })
  })
})

describe('ProductCatalogService.resolve', () => {
  it('creates a product it has not seen and asks for research', async () => {
    const { service, repository } = setup()

    const result = await service.resolve(identity())

    expect(result).toEqual({ kind: 'needs-research', productId: expect.any(String) })
    expect(await repository.findProductByKey('cerave|hydrating facial cleanser||')).toMatchObject({
      id: (result as { productId: string }).productId,
      brandKey: 'cerave',
      brand: 'CeraVe',
      name: 'Hydrating Facial Cleanser',
      variant: null,
      form: null,
      category: 'skin',
      createdAt: T0,
    })
  })

  it('keeps the variant when the label has one', async () => {
    const { service, repository } = setup()

    await service.resolve(identity({ variant: 'Night' }))

    expect(await repository.findProductByKey('cerave|hydrating facial cleanser|night|')).toMatchObject({ variant: 'Night' })
  })

  it('keeps the form when the label has one', async () => {
    const { service, repository } = setup()

    await service.resolve(identity({ form: 'spray' }))

    expect(await repository.findProductByKey('cerave|hydrating facial cleanser||spray')).toMatchObject({ form: 'spray' })
  })

  it('finds the same product again, however the label spells it, instead of creating another', async () => {
    const { service } = setup()
    const first = await service.resolve(identity())

    const again = await service.resolve(identity({ brand: 'CERAVE', name: 'hydrating  facial cleanser 236 ml' }))

    expect(again).toEqual(first)
  })

  it('says ready, without calling the researcher or the analyst, for a product with a fresh formulation analysed by the current version', async () => {
    const ctx = setup()
    const { productId, formulationId } = await analysed(ctx)
    const researchCalls = ctx.researcher.calls.length
    const analyseCalls = ctx.analyst.calls.analyse.length

    const result = await ctx.service.resolve(identity({ brand: 'cerave', name: 'HYDRATING FACIAL CLEANSER 236ml' }))

    expect(result).toEqual({ kind: 'ready', productId, formulationId })
    expect(ctx.researcher.calls).toHaveLength(researchCalls)
    expect(ctx.analyst.calls.analyse).toHaveLength(analyseCalls)
    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
  })

  it('asks for analysis of a formulation that has never been analysed', async () => {
    const ctx = setup()
    const { productId, formulationId } = await researched(ctx)

    expect(await ctx.service.resolve(identity())).toEqual({ kind: 'needs-analysis', productId, formulationId })
  })

  it('asks for analysis again, on the next scan, of a formulation analysed by an older version', async () => {
    const ctx = setup()
    const { productId, formulationId } = await analysed(ctx)
    // The service only ever writes the current version, so an older one can only be made by writing it directly.
    await ctx.repository.saveAnalysis(formulationId, {
      concerns: [],
      analysisVersion: ANALYSIS_VERSION - 1,
      referenceVersion: REFERENCE_VERSION,
      analysedAt: T0,
    })

    expect(await ctx.service.resolve(identity())).toEqual({ kind: 'needs-analysis', productId, formulationId })
  })

  it('treats a formulation found exactly FRESH_FOR_DAYS ago as still fresh', async () => {
    const ctx = setup()
    const { productId, formulationId } = await analysed(ctx)
    ctx.advance(FRESH_FOR_DAYS * DAY)

    expect(await ctx.service.resolve(identity())).toEqual({ kind: 'ready', productId, formulationId })
  })

  it('asks for new research once the formulation is older than FRESH_FOR_DAYS', async () => {
    const ctx = setup()
    const { productId } = await analysed(ctx)
    ctx.advance(FRESH_FOR_DAYS * DAY + 1)

    expect(await ctx.service.resolve(identity())).toEqual({ kind: 'needs-research', productId })
  })
})

describe('ProductCatalogService.resolve near misses', () => {
  const ACME = 'Acme'
  // Word overlap with TARGET (Jaccard): A 3/5 = 0.6 (exactly the threshold), B 4/5, C 5/6, D 5/5, E 2/5.
  const TARGET = identity({ brand: ACME, name: 'Radiance Serum Vitamin Glow Booster' })
  const NAMES = {
    A: 'Radiance Serum Vitamin',
    B: 'Radiance Serum Vitamin Glow',
    C: 'Radiance Serum Vitamin Glow Booster Night',
    D: 'Booster Glow Vitamin Serum Radiance',
    E: 'Radiance Serum',
  }

  /** Creates the products one after another, so each is newer than the last. Returns their ids by letter. */
  const catalogued = async (ctx: Ctx, letters: (keyof typeof NAMES)[]) => {
    const ids: Record<string, string> = {}
    for (const letter of letters) {
      const result = await ctx.service.resolve(identity({ brand: ACME, name: NAMES[letter] }))
      ids[letter] = result.productId
      ctx.advance(MINUTE)
    }
    return ids
  }
  const askedNames = (ctx: Ctx) => ctx.analyst.calls.sameProduct.map(([, candidate]) => candidate.name)

  it.each([
    ['asks the model about a same-brand product whose name is exactly at the similarity threshold', 'A', 1],
    ['does not ask the model about a same-brand product whose name is below the similarity threshold', 'E', 0],
  ] as const)('%s', async (_label, letter, asks) => {
    const ctx = setup()
    await catalogued(ctx, [letter])

    await ctx.service.resolve(TARGET)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(asks)
  })

  it('never compares with another brand\'s product, however similar the name', async () => {
    const ctx = setup()
    await ctx.service.resolve(identity({ brand: 'Other Brand', name: NAMES.D }))

    const result = await ctx.service.resolve(TARGET)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
    expect(result.kind).toBe('needs-research')
  })

  it('asks about at most nearMissLimit candidates, always as (the scanned label, the candidate), and makes a new product when all are different', async () => {
    const ctx = setup()
    const ids = await catalogued(ctx, ['A', 'B', 'C', 'D'])
    const before = ctx.analyst.calls.sameProduct.length

    const result = await ctx.service.resolve(TARGET)

    const asks = ctx.analyst.calls.sameProduct.slice(before)
    expect(asks).toHaveLength(CATALOG_POLICY.nearMissLimit)
    for (const [asked] of asks) expect(asked).toMatchObject({ brand: ACME, name: TARGET.name, category: 'skin' })
    // Four candidates qualify; the least similar (and oldest) is the one left out.
    expect(askedNames(ctx).slice(before)).not.toContain(NAMES.A)
    expect(result.kind).toBe('needs-research')
    expect(Object.values(ids)).not.toContain(result.productId)
  })

  it('stops at the first candidate the model says is the same product, and remembers the spelling as an alias', async () => {
    const ctx = setup()
    const ids = await catalogued(ctx, ['A', 'B', 'C', 'D'])
    ctx.analyst.sameProductWith(() => true)
    const before = ctx.analyst.calls.sameProduct.length

    const first = await ctx.service.resolve(TARGET)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(before + 1)
    expect(first.kind).toBe('needs-research')
    expect(Object.values(ids)).toContain(first.productId)

    const second = await ctx.service.resolve(TARGET)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(before + 1)
    expect(second).toEqual(first)
  })

  it('continues with the candidate the model confirms, not with another', async () => {
    const ctx = setup()
    const ids = await catalogued(ctx, ['A', 'B', 'C', 'D'])
    ctx.analyst.sameProductWith((_target, candidate) => candidate.name === NAMES.C)

    const result = await ctx.service.resolve(TARGET)

    expect(result).toEqual({ kind: 'needs-research', productId: ids.C })
  })

  it('is ready at once when the confirmed product already has a fresh, current analysis', async () => {
    const ctx = setup()
    const { productId, formulationId } = await analysed(ctx, { who: identity({ brand: ACME, name: NAMES.B }) })
    ctx.analyst.sameProductWith(() => true)

    expect(await ctx.service.resolve(TARGET)).toEqual({ kind: 'ready', productId, formulationId })
  })

  it('throws CatalogBusyError, merging nothing and creating nothing, when the AI spend cap stops the question', async () => {
    const ctx = setup()
    await catalogued(ctx, ['B'])
    ctx.analyst.failNextWith(new AiBudgetExceededError('cap'))

    const error = await errorOf(ctx.service.resolve(TARGET))

    expect(error).toBeInstanceOf(CatalogBusyError)
    expect(await ctx.repository.findProductByKey(identityKey(TARGET))).toBeNull()
    // With room again the same scan asks the model afresh and carries on.
    ctx.analyst.sameProductWith(() => false)
    expect((await ctx.service.resolve(TARGET)).kind).toBe('needs-research')
  })

  it('compares only with the brand\'s newest brandScanLimit products', async () => {
    const ctx = setup({ policy: { brandScanLimit: 2 } })
    // B is the near miss but the oldest; two newer, unrelated products fill the scan.
    await ctx.service.resolve(identity({ brand: ACME, name: NAMES.B }))
    ctx.advance(MINUTE)
    await ctx.service.resolve(identity({ brand: ACME, name: 'Zinc Mask Clay' }))
    ctx.advance(MINUTE)
    await ctx.service.resolve(identity({ brand: ACME, name: 'Oat Cream Calm' }))

    const result = await ctx.service.resolve(TARGET)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
    expect(result.kind).toBe('needs-research')
  })
})

describe('ProductCatalogService.research', () => {
  const productFor = async (ctx: Ctx, who = identity()) => (await ctx.service.resolve(who)).productId

  it('creates a web formulation with the ingredients as found and records a found attempt', async () => {
    const ctx = setup()
    const productId = await productFor(ctx, identity({ variant: 'Night' }))
    const ingredients = ['Aqua (Water)', 'Glycerin', 'Parfum/Fragrance']
    ctx.researcher.respondWith(() => ({ found: true, ingredients, sourceUrl: SOURCE_URL }))

    const result = await ctx.service.research(productId)

    expect(result).toEqual({ kind: 'found', formulationId: expect.any(String) })
    const formulationId = (result as { formulationId: string }).formulationId
    expect(await ctx.repository.findFormulation(formulationId)).toMatchObject({
      productId,
      sourceKind: 'web',
      sourceUrl: SOURCE_URL,
      ingredients,
      foundAt: T0,
    })
    expect(ctx.researcher.calls).toHaveLength(1)
    expect(ctx.researcher.calls[0]).toMatchObject({ brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: 'Night', category: 'skin' })
    expect(await ctx.repository.lastResearchOutcome(productId)).toEqual({ outcome: 'found', attemptedAt: T0 })
    expect(await ctx.repository.researchAttemptsSince(T0)).toBe(1)
  })

  it('reuses a formulation with the same ingredient list, moving its found time to now, instead of creating a duplicate', async () => {
    const ctx = setup()
    const first = await analysed(ctx)
    ctx.advance(FRESH_FOR_DAYS * DAY + 1)
    expect(await ctx.service.resolve(identity())).toEqual({ kind: 'needs-research', productId: first.productId })

    const again = await ctx.service.research(first.productId)

    expect(again).toEqual({ kind: 'found', formulationId: first.formulationId })
    expect((await ctx.repository.findFormulation(first.formulationId))!.foundAt).toEqual(new Date(T0.getTime() + FRESH_FOR_DAYS * DAY + 1))
    expect((await ctx.repository.latestFormulation(first.productId))!.id).toBe(first.formulationId)
    // Fresh again, and still analysed: nothing was replaced.
    expect(await ctx.service.resolve(identity())).toEqual({ kind: 'ready', productId: first.productId, formulationId: first.formulationId })
  })

  it('stores a changed ingredient list as a new formulation and keeps the old one', async () => {
    const ctx = setup()
    const first = await researched(ctx)
    // Stale, so it is researched again: a fresh formulation is returned without asking the researcher.
    ctx.advance(FRESH_FOR_DAYS * DAY + 1)
    ctx.researcher.respondWith(() => ({ found: true, ingredients: [...CLEAN, 'Phenoxyethanol'], sourceUrl: SOURCE_URL }))

    const second = await ctx.service.research(first.productId)

    expect(second.kind).toBe('found')
    const secondId = (second as { formulationId: string }).formulationId
    expect(secondId).not.toBe(first.formulationId)
    expect((await ctx.repository.latestFormulation(first.productId))!.id).toBe(secondId)
    expect((await ctx.repository.findFormulation(first.formulationId))!.ingredients).toEqual(CLEAN)
  })

  it('answers not-found and records a not-found attempt when the researcher finds nothing', async () => {
    const ctx = setup()
    const productId = await productFor(ctx)

    const result = await ctx.service.research(productId)

    expect(result).toEqual({ kind: 'not-found' })
    expect(await ctx.repository.latestFormulation(productId)).toBeNull()
    expect(await ctx.repository.lastResearchOutcome(productId)).toEqual({ outcome: 'not-found', attemptedAt: T0 })
  })

  it('records a failed attempt and rethrows when the researcher throws', async () => {
    const ctx = setup()
    const productId = await productFor(ctx)
    ctx.researcher.failNextWith(new Error('search is down'))

    await expect(ctx.service.research(productId)).rejects.toThrow('search is down')

    expect(await ctx.repository.lastResearchOutcome(productId)).toEqual({ outcome: 'failed', attemptedAt: T0 })
  })

  describe('when the AI spend cap is reached', () => {
    const CAP_REACHED = () => new AiBudgetExceededError('The AI spend cap would be exceeded')

    it('answers budget-exhausted instead of throwing, and stores nothing', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      ctx.researcher.failNextWith(CAP_REACHED())

      const result = await ctx.service.research(productId)

      expect(result).toEqual({ kind: 'budget-exhausted' })
      expect(await ctx.repository.latestFormulation(productId)).toBeNull()
    })

    it('settles the started attempt as failed, so it neither counts against the daily research budget nor is remembered as not-found', async () => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      const productId = await productFor(ctx)
      ctx.researcher.failNextWith(CAP_REACHED())

      await ctx.service.research(productId)

      expect(await ctx.repository.lastResearchOutcome(productId)).toEqual({ outcome: 'failed', attemptedAt: T0 })
      expect(await ctx.repository.researchAttemptsSince(T0)).toBe(0)
    })

    it('researches the same product again as soon as there is room, because the refusal is not cached', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      ctx.researcher.failNextWith(CAP_REACHED())
      await ctx.service.research(productId)
      ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))

      expect(await ctx.service.research(productId)).toEqual({ kind: 'found', formulationId: expect.any(String) })
    })

    it('still rethrows every other error from the researcher', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      ctx.researcher.failNextWith(new Error('search is down'))

      await expect(ctx.service.research(productId)).rejects.toThrow('search is down')
    })
  })

  describe('daily budget', () => {
    // A not-found product is not researched again for a week, so each research here is of a different product.
    const products = async (ctx: Ctx, count: number) => {
      const ids: string[] = []
      for (let i = 0; i < count; i++) ids.push(await productFor(ctx, identity({ name: `Cleanser ${'abcdefgh'[i]}${'zyxwvuts'[i]}` })))
      return ids
    }

    it('researches while attempts are under the budget and refuses, without calling the researcher, once they reach it', async () => {
      const ctx = setup({ policy: { dailyResearchBudget: 2 } })
      const [a, b, c] = await products(ctx, 3)

      expect(await ctx.service.research(a!)).toEqual({ kind: 'not-found' })
      expect(await ctx.service.research(b!)).toEqual({ kind: 'not-found' })
      expect(await ctx.service.research(c!)).toEqual({ kind: 'budget-exhausted' })

      expect(ctx.researcher.calls).toHaveLength(2)
    })

    it.each([
      ['found', (ctx: Ctx) => ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))],
      ['not-found', (ctx: Ctx) => ctx.researcher.respondWith(() => ({ found: false }))],
    ] as const)('counts a %s attempt against the budget', async (_outcome, arrange) => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      const [first, second] = await products(ctx, 2)
      arrange(ctx)
      await ctx.service.research(first!)

      expect(await ctx.service.research(second!)).toEqual({ kind: 'budget-exhausted' })
    })

    it('does not count a failed attempt against the budget, since an outage costs nothing', async () => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      const [first, second] = await products(ctx, 2)
      ctx.researcher.failNextWith(new Error('search is down'))
      await ctx.service.research(first!).catch(() => undefined)

      expect(await ctx.service.research(second!)).toEqual({ kind: 'not-found' })
      expect(ctx.researcher.calls).toHaveLength(1)
    })

    it('does not count a fresh formulation that is returned without researching', async () => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      const first = await researched(ctx)

      expect(await ctx.service.research(first.productId)).toEqual({ kind: 'found', formulationId: first.formulationId })
    })

    it.each([
      ['exactly 24 hours ago', DAY, 'budget-exhausted'],
      ['24 hours and a millisecond ago', DAY + 1, 'not-found'],
    ] as const)('counts an attempt made %s only while it is within the last 24 hours', async (_label, elapsed, expected) => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      const [first, second] = await products(ctx, 2)
      await ctx.service.research(first!)
      ctx.advance(elapsed)

      expect(await ctx.service.research(second!)).toEqual({ kind: expected })
    })
  })

  describe('stock image', () => {
    // The researcher cannot see image urls; the image comes from the og:image of the page it cited.
    const withImage = (ctx: Ctx, pageImage: string | null = IMAGE_URL) => {
      ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))
      ctx.images.respondToPage(SOURCE_URL, pageImage)
    }

    it.each([
      ['image/jpeg', 'jpg'],
      ['image/png', 'png'],
      ['image/webp', 'webp'],
    ] as const)('stores an accepted %s image as <prefix>/products/<id>.%s and sets it on the product', async (mediaType, extension) => {
      const ctx = setup()
      const productId = await productFor(ctx)
      const image: ProductImage = { bytes: new Uint8Array([9, 9]), mediaType }
      ctx.images.respondTo(IMAGE_URL, image)
      ctx.analyst.imageShowsProductWith(() => true)
      withImage(ctx)

      const result = await ctx.service.research(productId)

      const key = `${IMAGE_KEY_PREFIX}/products/${productId}.${extension}`
      expect(ctx.images.stored.get(key)).toEqual(image)
      expect(await ctx.repository.findProductById(productId)).toMatchObject({ imageKey: key, imageSourceUrl: IMAGE_URL, imageCheckedAt: T0 })
      expect(ctx.analyst.calls.imageShowsProduct).toHaveLength(1)
      expect(ctx.analyst.calls.imageShowsProduct[0]![0]).toEqual(image)
      expect(ctx.analyst.calls.imageShowsProduct[0]![1]).toMatchObject({ brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' })
      expect(result.kind).toBe('found')
    })

    it('stores the image under the configured key prefix, so the Worker stays in its own corner of the shared bucket', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      ctx.images.respondTo(IMAGE_URL, JPEG)
      ctx.analyst.imageShowsProductWith(() => true)
      withImage(ctx)

      await ctx.service.research(productId)

      expect([...ctx.images.stored.keys()]).toEqual([`catalog/test/products/${productId}.jpg`])
      expect((await ctx.repository.findProductById(productId))?.imageKey).toBe(`catalog/test/products/${productId}.jpg`)
    })

    it('marks the image as checked, with no image, when the download fails', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      ctx.images.respondTo(IMAGE_URL, null)
      withImage(ctx)

      const result = await ctx.service.research(productId)

      expect(result.kind).toBe('found')
      expect(await ctx.repository.findProductById(productId)).toMatchObject({ imageKey: null, imageSourceUrl: null, imageCheckedAt: T0 })
      expect(ctx.analyst.calls.imageShowsProduct).toHaveLength(0)
      expect(ctx.images.stored.size).toBe(0)
    })

    it('stores nothing, and marks the image as checked, when the model says the image is not this product', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      ctx.images.respondTo(IMAGE_URL, JPEG)
      ctx.analyst.imageShowsProductWith(() => false)
      withImage(ctx)

      const result = await ctx.service.research(productId)

      expect(result.kind).toBe('found')
      expect(await ctx.repository.findProductById(productId)).toMatchObject({ imageKey: null, imageSourceUrl: null, imageCheckedAt: T0 })
      expect(ctx.images.stored.size).toBe(0)
    })

    it('marks the image as checked without fetching or judging anything when the source page has no image', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      withImage(ctx, null)

      await ctx.service.research(productId)

      expect(ctx.images.pageLookups).toEqual([SOURCE_URL])
      expect(ctx.images.fetched).toHaveLength(0)
      expect(ctx.analyst.calls.imageShowsProduct).toHaveLength(0)
      expect(await ctx.repository.findProductById(productId)).toMatchObject({ imageKey: null, imageSourceUrl: null, imageCheckedAt: T0 })
    })

    it('does not look at the source page again for a product that already has an image', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      ctx.images.respondTo(IMAGE_URL, JPEG)
      ctx.analyst.imageShowsProductWith(() => true)
      withImage(ctx)
      await ctx.service.research(productId)
      ctx.advance(FRESH_FOR_DAYS * DAY + 1)

      await ctx.service.research(productId)

      expect(ctx.images.pageLookups).toHaveLength(1)
    })

    it('does not look at the source page while the image check is still fresh', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      await ctx.repository.markImageChecked(productId, new Date(T0.getTime() - FRESH_FOR_DAYS * DAY))
      withImage(ctx)

      await ctx.service.research(productId)

      expect(ctx.images.pageLookups).toHaveLength(0)
      expect(ctx.images.fetched).toHaveLength(0)
    })

    it('looks at the source page again once the image check is older than FRESH_FOR_DAYS', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      await ctx.repository.markImageChecked(productId, new Date(T0.getTime() - FRESH_FOR_DAYS * DAY - 1))
      withImage(ctx)

      await ctx.service.research(productId)

      expect(ctx.images.pageLookups).toEqual([SOURCE_URL])
    })

    it('does not fetch another image for a product that already has one', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      ctx.images.respondTo(IMAGE_URL, JPEG)
      ctx.analyst.imageShowsProductWith(() => true)
      withImage(ctx)
      await ctx.service.research(productId)
      ctx.advance(FRESH_FOR_DAYS * DAY + 1)

      await ctx.service.research(productId)

      expect(ctx.images.fetched).toHaveLength(1)
    })

    // Research only reruns once the formulation is more than FRESH_FOR_DAYS old, and the image was checked at the same
    // time, so "checked exactly FRESH_FOR_DAYS ago" can no longer be reached through the service: only this side is left.
    it('looks again for an image checked more than FRESH_FOR_DAYS ago, when the product is researched again', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      ctx.images.respondTo(IMAGE_URL, null)
      withImage(ctx)
      await ctx.service.research(productId)
      ctx.advance(FRESH_FOR_DAYS * DAY + 1)

      await ctx.service.research(productId)

      expect(ctx.images.fetched).toHaveLength(2)
    })

    class FetchThrows extends MemoryCatalogImageStore {
      override async fetchImage(): Promise<never> {
        throw new Error('network down')
      }
    }
    class PutThrows extends MemoryCatalogImageStore {
      override async put(): Promise<void> {
        throw new Error('bucket down')
      }
    }

    it.each([
      ['the download throws', () => ({ images: new FetchThrows() }), () => undefined],
      ['the model check throws', () => ({ images: undefined }), (ctx: Ctx) => ctx.analyst.failNextWith(new Error('model down'))],
      ['the model check is refused by the AI spend cap', () => ({ images: undefined }), (ctx: Ctx) => ctx.analyst.failNextWith(new AiBudgetExceededError('cap'))],
      ['storing the image throws', () => ({ images: new PutThrows() }), () => undefined],
    ] as const)('still reports the ingredients as found when %s', async (_label, options, arrange) => {
      const ctx = setup(options())
      const productId = await productFor(ctx)
      ctx.images.respondTo(IMAGE_URL, JPEG)
      ctx.analyst.imageShowsProductWith(() => true)
      withImage(ctx)
      arrange(ctx)

      const result = await ctx.service.research(productId)

      expect(result).toEqual({ kind: 'found', formulationId: expect.any(String) })
      expect((await ctx.repository.latestFormulation(productId))!.id).toBe((result as { formulationId: string }).formulationId)
      expect((await ctx.repository.findProductById(productId))!.imageKey).toBeNull()
    })
  })
})

describe('ProductCatalogService.addLabelIngredients', () => {
  const productFor = async (ctx: Ctx) => (await ctx.service.resolve(identity())).productId
  const entries = (count: number) => Array.from({ length: count }, (_, i) => `Ingredient ${i}`)

  it('stores the list from the label photo as a label formulation found now', async () => {
    const ctx = setup()
    const productId = await productFor(ctx)

    const formulationId = await ctx.service.addLabelIngredients(productId, CLEAN)

    expect(await ctx.repository.findFormulation(formulationId)).toMatchObject({
      productId,
      ingredients: CLEAN,
      sourceKind: 'label',
      sourceUrl: null,
      foundAt: T0,
    })
  })

  it('reuses an identical list the product already has, whether it came from the label or the web', async () => {
    const ctx = setup()
    const web = await researched(ctx)

    const first = await ctx.service.addLabelIngredients(web.productId, CLEAN)
    const second = await ctx.service.addLabelIngredients(web.productId, CLEAN)

    expect(first).toBe(web.formulationId)
    expect(second).toBe(web.formulationId)
  })

  it('stores a different list as a new formulation', async () => {
    const ctx = setup()
    const web = await researched(ctx)

    const formulationId = await ctx.service.addLabelIngredients(web.productId, [...CLEAN, 'Phenoxyethanol'])

    expect(formulationId).not.toBe(web.formulationId)
  })

  it.each([
    ['150 entries', entries(150)],
    ['an entry of 120 characters', ['Aqua', 'a'.repeat(120)]],
    ['an entry of 120 characters once trimmed', ['Aqua', `  ${'a'.repeat(120)}  `]],
  ])('accepts %s', async (_label, list) => {
    const ctx = setup()
    const productId = await productFor(ctx)

    await expect(ctx.service.addLabelIngredients(productId, list)).resolves.toEqual(expect.any(String))
  })

  it.each([
    ['an empty list', []],
    ['151 entries', entries(151)],
    ['an entry of 121 characters', ['Aqua', 'a'.repeat(121)]],
    ['an entry of 121 characters once trimmed', ['Aqua', `  ${'a'.repeat(121)}  `]],
  ])('rejects %s as an unreadable label and stores nothing', async (_label, list) => {
    const ctx = setup()
    const productId = await productFor(ctx)

    const error = await errorOf(ctx.service.addLabelIngredients(productId, list))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe('LABEL_UNREADABLE')
    expect(await ctx.repository.latestFormulation(productId)).toBeNull()
  })
})

describe('ProductCatalogService.addLabelIngredients free text', () => {
  const productFor = async (ctx: Ctx) => (await ctx.service.resolve(identity())).productId

  it.each([['see http://evil.example'], ['see www.evil.example'], ['<script>evil()</script>'], ['</b>evil'], ['<!-- evil -->'], ['strength <evil']])(
    'rejects a list with the entry "%s" as an unreadable label and stores nothing',
    async (hostile) => {
      const ctx = setup()
      const productId = await productFor(ctx)

      const error = await errorOf(ctx.service.addLabelIngredients(productId, ['Aqua', hostile]))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error.code).toBe('LABEL_UNREADABLE')
      expect(await ctx.repository.latestFormulation(productId)).toBeNull()
    },
  )

  it.each([['strength > evil'], ['strength < evil'], ['Mercury <1 ppm'], ['pH < 5'], ['> 2%']])('accepts the entry "%s", because a comparison sign is not markup', async (entry) => {
    const ctx = setup()
    const productId = await productFor(ctx)

    const formulationId = await ctx.service.addLabelIngredients(productId, ['Aqua', entry])

    expect((await ctx.repository.findFormulation(formulationId))!.ingredients).toEqual(['Aqua', entry])
  })
})

describe('ProductCatalogService.analyse', () => {
  const viewOf = (ctx: Ctx, formulationId: string) => ctx.service.productView(formulationId)

  it('gives the analyst the product, the ingredients in label order, the flagged facts and the allowed vocabulary', async () => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { who: identity({ variant: 'Night' }), ingredients: WITH_MERCURY })
    ctx.analyst.analyseWith(() => [draft()])

    await ctx.service.analyse(formulationId)

    expect(ctx.analyst.calls.analyse).toHaveLength(1)
    expect(ctx.analyst.calls.analyse[0]).toMatchObject({
      product: { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: 'Night', category: 'skin' },
      ingredients: WITH_MERCURY,
      flaggedFacts: [{ kind: 'banned-substance', ingredient: 'Mercury', rule: expect.any(String), source: EUR_LEX }],
      kinds: CONCERN_KINDS,
      severities: SEVERITIES,
      traits: TRAITS,
    })
  })

  it('stores the analysis once, marked with the current analysis and reference versions and the time', async () => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
    ctx.analyst.analyseWith(() => [draft(), draft({ kind: 'drying', severity: 'low', sources: [] })])
    const save = vi.spyOn(ctx.repository, 'saveAnalysis')
    ctx.advance(HOUR)

    await ctx.service.analyse(formulationId)

    expect(save).toHaveBeenCalledTimes(1)
    expect(await ctx.repository.findFormulation(formulationId)).toMatchObject({
      analysisVersion: ANALYSIS_VERSION,
      referenceVersion: REFERENCE_VERSION,
      analysedAt: new Date(T0.getTime() + HOUR),
    })
    expect(await ctx.repository.concernsFor(formulationId)).toHaveLength(2)
  })

  it('marks a formulation with nothing flagged and no concerns as analysed', async () => {
    const ctx = setup()
    const { formulationId } = await researched(ctx)

    await ctx.service.analyse(formulationId)

    const view = await viewOf(ctx, formulationId)
    expect(view.concerns).toEqual([])
    expect(view.formulation.analysedAt).toEqual(T0)
  })

  it('matches kind, severity and traits to the vocabulary ignoring case, and stores them in canonical form', async () => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
    ctx.analyst.analyseWith(() => [draft({ kind: 'BANNED-Substance', severity: 'High', traits: ['Sensitive', 'GOAL:Clear-Skin', 'Fitzpatrick-5'] })])

    await ctx.service.analyse(formulationId)

    expect((await viewOf(ctx, formulationId)).concerns).toEqual([
      {
        kind: 'banned-substance',
        severity: 'high',
        ingredients: ['Mercury'],
        why: draft().why,
        whoShouldTakeCare: draft().whoShouldTakeCare,
        traits: ['fitzpatrick-5', 'goal:clear-skin', 'sensitive'],
        sources: [EUR_LEX],
      },
    ])
  })

  it.each<[string, Partial<DraftConcern>]>([
    ['kind', { kind: 'nonsense' }],
    ['severity', { severity: 'catastrophic' }],
    ['trait', { traits: ['sensitive', 'shiny'] }],
  ])('rejects the whole analysis, storing nothing, when one concern has an unknown %s', async (_field, bad) => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
    ctx.analyst.analyseWith(() => [draft(), draft({ kind: 'irritation', severity: 'low', ingredients: ['Glycerin'], sources: [], ...bad })])

    await expect(ctx.service.analyse(formulationId)).rejects.toBeInstanceOf(AnalysisRejectedError)

    const view = await viewOf(ctx, formulationId)
    expect(view.concerns).toEqual([])
    expect(view.formulation.analysedAt).toBeNull()
  })

  it('writes each concern\'s ingredients in the formulation\'s own spelling, drops names that are not on the label, and drops a concern left with none', async () => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: ['Aqua (Water)', 'Mercury 2%', 'Glycerin'] })
    ctx.analyst.analyseWith(() => [
      draft({ ingredients: ['mercury', 'Unicorn Tears'] }),
      draft({ kind: 'drying', severity: 'low', ingredients: ['water', 'GLYCERIN'], sources: [] }),
      draft({ kind: 'irritation', severity: 'low', ingredients: ['Unicorn Tears'], sources: [] }),
    ])

    await ctx.service.analyse(formulationId)

    const concerns = (await viewOf(ctx, formulationId)).concerns
    expect(concerns.map((c) => [c.kind, c.ingredients])).toEqual([
      ['banned-substance', ['Mercury 2%']],
      ['drying', ['Aqua (Water)', 'Glycerin']],
    ])
  })

  it('keeps only sources that are a regulation URL from the flagged facts', async () => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: ['Aqua', 'Mercury', 'Sodium Lauryl Sulfate'] })
    ctx.analyst.analyseWith(() => [
      draft({ sources: [EUR_LEX, MADE_UP_SOURCE] }),
      // Sodium lauryl sulfate has no official source, so nothing can back this concern.
      draft({ kind: 'irritation', severity: 'low', ingredients: ['Sodium Lauryl Sulfate'], sources: [MADE_UP_SOURCE] }),
    ])

    await ctx.service.analyse(formulationId)

    expect((await viewOf(ctx, formulationId)).concerns.map((c) => c.sources)).toEqual([[EUR_LEX], []])
  })

  it.each([
    ['the analyst returns no concerns', () => []],
    ['the concern is of another kind', () => [draft({ kind: 'irritation' })]],
    ['the concern names another ingredient', () => [draft({ ingredients: ['Glycerin'] })]],
    ['the covering concern names nothing on the label and is dropped', () => [draft({ ingredients: ['Unicorn Tears'] })]],
  ])('rejects the analysis, storing nothing, when a flagged fact is not covered because %s', async (_label, drafts) => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
    ctx.analyst.analyseWith(drafts)

    await expect(ctx.service.analyse(formulationId)).rejects.toBeInstanceOf(AnalysisRejectedError)

    const view = await viewOf(ctx, formulationId)
    expect(view.concerns).toEqual([])
    expect(view.formulation.analysedAt).toBeNull()
  })

  it('needs every flagged ingredient of a kind in a concern of that kind, not just one of them', async () => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: ['Aqua', 'Linalool', 'Citral'] })
    ctx.analyst.analyseWith(() => [draft({ kind: 'allergen', severity: 'medium', ingredients: ['Linalool'] })])

    await expect(ctx.service.analyse(formulationId)).rejects.toBeInstanceOf(AnalysisRejectedError)

    ctx.analyst.analyseWith(() => [draft({ kind: 'allergen', severity: 'medium', ingredients: ['Linalool', 'Citral'] })])
    await ctx.service.analyse(formulationId)

    expect((await viewOf(ctx, formulationId)).concerns.map((c) => c.ingredients)).toEqual([['Linalool', 'Citral']])
  })

  it.each(OLDER_CODE)('replaces the concerns of an analysis made with %s', async (_label, older) => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
    await analysedByOlderCode(ctx, formulationId, older)
    ctx.advance(HOUR)
    ctx.analyst.analyseWith(() => [draft({ why: 'Second opinion.' })])

    await ctx.service.analyse(formulationId)

    const view = await viewOf(ctx, formulationId)
    expect(view.concerns.map((c) => c.why)).toEqual(['Second opinion.'])
    expect(view.formulation.analysedAt).toEqual(new Date(T0.getTime() + HOUR))
  })

  it.each(OLDER_CODE)('leaves an analysis made with %s in place when the re-run is rejected', async (_label, older) => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
    await analysedByOlderCode(ctx, formulationId, older)
    ctx.advance(HOUR)
    ctx.analyst.analyseWith(() => [])

    await expect(ctx.service.analyse(formulationId)).rejects.toBeInstanceOf(AnalysisRejectedError)

    const view = await viewOf(ctx, formulationId)
    expect(view.concerns.map((c) => c.why)).toEqual(['First opinion.'])
    expect(view.formulation.analysedAt).toEqual(T0)
  })

  it('returns without calling the analyst when the formulation is already analysed by the current analysis and reference versions', async () => {
    const ctx = setup()
    const { formulationId } = await analysed(ctx)
    ctx.advance(HOUR)

    await ctx.service.analyse(formulationId)

    expect(ctx.analyst.calls.analyse).toHaveLength(1)
    expect((await viewOf(ctx, formulationId)).formulation.analysedAt).toEqual(T0)
  })
})

describe('ProductCatalogService.productView', () => {
  it('shows the product, its formulation and source, its concerns, and how complete the reference data is', async () => {
    const ctx = setup()
    const who = identity({ variant: 'Night' })
    ctx.images.respondTo(IMAGE_URL, JPEG)
    ctx.analyst.imageShowsProductWith(() => true)
    const resolved = await ctx.service.resolve(who)
    const productId = resolved.productId
    ctx.researcher.respondWith(() => ({ found: true, ingredients: WITH_MERCURY, sourceUrl: SOURCE_URL }))
    ctx.images.respondToPage(SOURCE_URL, IMAGE_URL)
    const found = await ctx.service.research(productId)
    const formulationId = (found as { formulationId: string }).formulationId
    ctx.analyst.analyseWith(() => [draft()])
    await ctx.service.analyse(formulationId)

    const view = await ctx.service.productView(formulationId)

    expect(view).toEqual({
      product: {
        id: productId,
        brand: 'CeraVe',
        name: 'Hydrating Facial Cleanser',
        variant: 'Night',
        form: null,
        category: 'skin',
        imageUrl: ctx.images.publicUrl(`${IMAGE_KEY_PREFIX}/products/${productId}.jpg`),
      },
      formulation: {
        id: formulationId,
        ingredients: WITH_MERCURY,
        source: { kind: 'web', url: SOURCE_URL },
        foundAt: T0,
        analysedAt: T0,
      },
      concerns: [
        {
          kind: 'banned-substance',
          severity: 'high',
          ingredients: ['Mercury'],
          why: draft().why,
          whoShouldTakeCare: draft().whoShouldTakeCare,
          traits: ['sensitive'],
          sources: [EUR_LEX],
        },
      ],
      reference: { version: REFERENCE_VERSION, coverage: REFERENCE_COVERAGE },
    })
    expect(REFERENCE_COVERAGE).toBe('partial')
  })

  it('shows a label formulation that has not been analysed, for a product with no image, with no image URL and no analysis time', async () => {
    const ctx = setup()
    const { productId } = await researched(ctx)
    const formulationId = await ctx.service.addLabelIngredients(productId, ['Aqua', 'Glycerin', 'Phenoxyethanol'])

    const view = await ctx.service.productView(formulationId)

    expect(view.product).toMatchObject({ id: productId, variant: null, imageUrl: null })
    expect(view.formulation).toEqual({
      id: formulationId,
      ingredients: ['Aqua', 'Glycerin', 'Phenoxyethanol'],
      source: { kind: 'label', url: null },
      foundAt: T0,
      analysedAt: null,
    })
    expect(view.concerns).toEqual([])
    expect(view.reference).toEqual({ version: REFERENCE_VERSION, coverage: REFERENCE_COVERAGE })
  })

  it('says the product was not found for an unknown formulation id', async () => {
    const { service } = setup()

    const error = await errorOf(service.productView('no-such-formulation'))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('PRODUCT_NOT_FOUND')
  })
})

describe('ProductCatalogService.productSummary', () => {
  it('gives the product\'s identity and its public image URL, and nothing of its formulation or concerns', async () => {
    const ctx = setup()
    ctx.images.respondTo(IMAGE_URL, JPEG)
    ctx.analyst.imageShowsProductWith(() => true)
    const { productId } = await ctx.service.resolve(identity({ variant: 'Night' }))
    ctx.researcher.respondWith(() => ({ found: true, ingredients: WITH_MERCURY, sourceUrl: SOURCE_URL }))
    ctx.images.respondToPage(SOURCE_URL, IMAGE_URL)
    await ctx.service.research(productId)

    const summary = await ctx.service.productSummary(productId)

    expect(summary).toEqual({
      id: productId,
      brand: 'CeraVe',
      name: 'Hydrating Facial Cleanser',
      variant: 'Night',
      form: null,
      category: 'skin',
      imageUrl: ctx.images.publicUrl(`${IMAGE_KEY_PREFIX}/products/${productId}.jpg`),
    })
  })

  it('has no image URL for a product with no image', async () => {
    const ctx = setup()
    const { productId } = await researched(ctx)

    expect(await ctx.service.productSummary(productId)).toMatchObject({ id: productId, variant: null, imageUrl: null })
  })

  it('says the product was not found for an unknown product id', async () => {
    const { service } = setup()

    const error = await errorOf(service.productSummary('no-such-product'))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('PRODUCT_NOT_FOUND')
  })
})

describe('ProductCatalogService.research without asking the researcher', () => {
  const productFor = async (ctx: Ctx, who = identity()) => (await ctx.service.resolve(who)).productId

  it('returns the product\'s formulation as found when it is fresh, without calling the researcher', async () => {
    const ctx = setup()
    const first = await researched(ctx)
    ctx.advance(DAY)

    expect(await ctx.service.research(first.productId)).toEqual({ kind: 'found', formulationId: first.formulationId })
    expect(ctx.researcher.calls).toHaveLength(1)
  })

  it.each([
    ['exactly FRESH_FOR_DAYS old, is still fresh and is not researched again', 0, 1],
    ['more than FRESH_FOR_DAYS old, is researched again', 1, 2],
  ] as const)('a formulation %s', async (_label, extra, researcherCalls) => {
    const ctx = setup()
    const first = await researched(ctx)
    ctx.advance(FRESH_FOR_DAYS * DAY + extra)

    await ctx.service.research(first.productId)

    expect(ctx.researcher.calls).toHaveLength(researcherCalls)
  })

  it('leaves two research calls running at once with one formulation', async () => {
    const ctx = setup()
    const productId = await productFor(ctx)
    ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))

    const [a, b] = await Promise.all([ctx.service.research(productId), ctx.service.research(productId)])

    expect(a).toEqual({ kind: 'found', formulationId: expect.any(String) })
    expect(b).toEqual(a)
    // A duplicate stored second would be the latest, so the latest being the shared one means there is only one.
    expect((await ctx.repository.latestFormulation(productId))!.id).toBe((a as { formulationId: string }).formulationId)
  })
})

describe('ProductCatalogService.research attempt accounting', () => {
  const productFor = async (ctx: Ctx, who = identity()) => (await ctx.service.resolve(who)).productId

  it('records the attempt as started before it calls the researcher, and the outcome after', async () => {
    const repository = new FakeCatalogRepository()
    let watched = ''
    const during: { last?: unknown; counted?: number } = {}
    class Probe extends MemoryProductResearcher {
      override async research(product: ProductIdentity) {
        during.last = await repository.lastResearchOutcome(watched)
        during.counted = await repository.researchAttemptsSince(T0)
        return super.research(product)
      }
    }
    const ctx = setup({ repository, researcher: new Probe() })
    watched = await productFor(ctx)
    ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))

    await ctx.service.research(watched)

    expect(during.last).toEqual({ outcome: 'started', attemptedAt: T0 })
    expect(during.counted).toBe(1)
    expect(await repository.lastResearchOutcome(watched)).toEqual({ outcome: 'found', attemptedAt: T0 })
  })

  it('leaves a failed attempt uncounted, since an outage costs nothing', async () => {
    const ctx = setup()
    const productId = await productFor(ctx)
    ctx.researcher.failNextWith(new Error('search is down'))

    await ctx.service.research(productId).catch(() => undefined)

    expect(await ctx.repository.researchAttemptsSince(T0)).toBe(0)
  })

  describe('while the formulation is being stored', () => {
    class StoreProbe extends FakeCatalogRepository {
      duringStore: unknown
      watched = ''
      failStore = false
      override async createFormulation(input: Parameters<FakeCatalogRepository['createFormulation']>[0]) {
        this.duringStore = await this.lastResearchOutcome(this.watched)
        if (this.failStore) throw new Error('database is down')
        return super.createFormulation(input)
      }
    }
    const probed = async () => {
      const repository = new StoreProbe()
      const ctx = setup({ repository })
      repository.watched = await productFor(ctx)
      ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))
      return { ctx, repository }
    }

    it('keeps the attempt started, so it still shields the product from a concurrent call, and settles it found after', async () => {
      const { ctx, repository } = await probed()

      await ctx.service.research(repository.watched)

      expect(repository.duringStore).toEqual({ outcome: 'started', attemptedAt: T0 })
      expect(await repository.lastResearchOutcome(repository.watched)).toEqual({ outcome: 'found', attemptedAt: T0 })
    })

    it('settles the attempt as failed, so it does not count, and rethrows when the formulation cannot be stored', async () => {
      const { ctx, repository } = await probed()
      repository.failStore = true

      await expect(ctx.service.research(repository.watched)).rejects.toThrow('database is down')

      expect(await repository.lastResearchOutcome(repository.watched)).toEqual({ outcome: 'failed', attemptedAt: T0 })
      expect(await repository.researchAttemptsSince(T0)).toBe(0)
    })

    it('rethrows the store error and logs only the bookkeeping outcome when settling fails too', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const { ctx, repository } = await probed()
      repository.failStore = true
      repository.settleResearchAttempt = async () => {
        throw new Error('settle is down')
      }

      await expect(ctx.service.research(repository.watched)).rejects.toThrow('database is down')

      expect(log).toHaveBeenCalledWith({ outcome: 'attempt-bookkeeping-failed' })
      log.mockRestore()
    })

    it('still reports found when settling it fails after a successful store', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const { ctx, repository } = await probed()
      repository.settleResearchAttempt = async () => {
        throw new Error('settle is down')
      }

      expect(await ctx.service.research(repository.watched)).toEqual({ kind: 'found', formulationId: expect.any(String) })

      expect(log).toHaveBeenCalledWith({ outcome: 'attempt-bookkeeping-failed' })
      log.mockRestore()
    })
  })

  it('rethrows the researcher\'s own error even when settling the attempt fails too', async () => {
    class SettleFails extends FakeCatalogRepository {
      override async settleResearchAttempt(): Promise<void> {
        throw new Error('database is down')
      }
    }
    const ctx = setup({ repository: new SettleFails() })
    const productId = await productFor(ctx)
    const original = new Error('search is down')
    ctx.researcher.failNextWith(original)

    await expect(ctx.service.research(productId)).rejects.toBe(original)
  })
})

describe('ProductCatalogService.research negative cache', () => {
  const WEEK = 7 * DAY
  const productFor = async (ctx: Ctx, who = identity()) => (await ctx.service.resolve(who)).productId

  it('answers not-found, without calling the researcher, for a product that was not found less than 7 days ago', async () => {
    const ctx = setup()
    const productId = await productFor(ctx)
    await ctx.service.research(productId)
    ctx.advance(WEEK - 1)
    ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))

    expect(await ctx.service.research(productId)).toEqual({ kind: 'not-found' })
    expect(ctx.researcher.calls).toHaveLength(1)
  })

  it('researches the product again once more than 7 days have passed', async () => {
    const ctx = setup()
    const productId = await productFor(ctx)
    await ctx.service.research(productId)
    ctx.advance(WEEK + 1)
    ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))

    expect(await ctx.service.research(productId)).toEqual({ kind: 'found', formulationId: expect.any(String) })
    expect(ctx.researcher.calls).toHaveLength(2)
  })

  it('remembers a not-found for that product only', async () => {
    const ctx = setup()
    const missing = await productFor(ctx)
    const other = await productFor(ctx, identity({ name: 'Foaming Cleanser' }))
    await ctx.service.research(missing)

    await ctx.service.research(other)

    expect(ctx.researcher.calls).toHaveLength(2)
  })

  it('does not remember a failure, so the next call tries again', async () => {
    const ctx = setup()
    const productId = await productFor(ctx)
    ctx.researcher.failNextWith(new Error('search is down'))
    await ctx.service.research(productId).catch(() => undefined)
    ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))

    expect(await ctx.service.research(productId)).toEqual({ kind: 'found', formulationId: expect.any(String) })
  })
})

describe('ProductCatalogService.research of text that came from the web', () => {
  const productFor = async (ctx: Ctx) => (await ctx.service.resolve(identity())).productId

  const listWith = (ctx: Ctx, ingredient: string) =>
    ctx.researcher.respondWith(() => ({ found: true, ingredients: ['Aqua', ingredient, 'Glycerin'], sourceUrl: SOURCE_URL }))

  it.each([
    ['http://evil.example/offer'],
    ['https://evil.example/offer'],
    ['visit www.evil.example'],
    ['<script>evil()</script>'],
    ['</b>evil'],
    ['<!-- evil -->'],
    ['strength <evil'],
  ])('treats a list with the ingredient "%s" as not found and stores nothing', async (hostile) => {
    const ctx = setup()
    const productId = await productFor(ctx)
    listWith(ctx, hostile)

    expect(await ctx.service.research(productId)).toEqual({ kind: 'not-found' })
    expect(await ctx.repository.latestFormulation(productId)).toBeNull()
  })

  it.each([['strength > evil'], ['strength < evil'], ['Mercury <1 ppm'], ['pH < 5'], ['> 2%']])(
    'stores a list with the ingredient "%s", because a comparison sign is not markup',
    async (ingredient) => {
      const ctx = setup()
      const productId = await productFor(ctx)
      listWith(ctx, ingredient)

      const result = await ctx.service.research(productId)

      expect(result).toEqual({ kind: 'found', formulationId: expect.any(String) })
      expect((await ctx.repository.latestFormulation(productId))!.ingredients).toEqual(['Aqua', ingredient, 'Glycerin'])
    },
  )
})

describe('ProductCatalogService.research of a stale product', () => {
  const STALE = FRESH_FOR_DAYS * DAY + 1

  it.each([
    ['finds nothing', 'not-found'],
    ['is over budget', 'budget-exhausted'],
  ] as const)('offers its stale analysed formulation as a fallback when the new research %s', async (_label, kind) => {
    const ctx = setup({ policy: { dailyResearchBudget: 1 } })
    const stale = await analysed(ctx)
    ctx.advance(STALE)
    ctx.researcher.respondWith(() => ({ found: false }))
    if (kind === 'budget-exhausted') {
      // Another product's research this very day spends the budget of 1.
      const other = await ctx.service.resolve(identity({ name: 'Foaming Cleanser' }))
      await ctx.service.research(other.productId)
    }

    expect(await ctx.service.research(stale.productId)).toEqual({ kind, fallbackFormulationId: stale.formulationId })
  })

  it('offers its stale analysed formulation as a fallback when the AI spend cap stops the new research', async () => {
    const ctx = setup()
    const stale = await analysed(ctx)
    ctx.advance(STALE)
    ctx.researcher.failNextWith(new AiBudgetExceededError('cap'))

    expect(await ctx.service.research(stale.productId)).toEqual({ kind: 'budget-exhausted', fallbackFormulationId: stale.formulationId })
  })

  it.each(OLDER_CODE)('offers no fallback when the AI spend cap stops the new research and the stale formulation was analysed with %s', async (_label, older) => {
    const ctx = setup()
    const stale = await researched(ctx)
    await analysedByOlderCode(ctx, stale.formulationId, older)
    ctx.advance(STALE)
    ctx.researcher.failNextWith(new AiBudgetExceededError('cap'))

    expect(await ctx.service.research(stale.productId)).toEqual({ kind: 'budget-exhausted' })
  })

  it('offers no fallback when the stale formulation was never analysed', async () => {
    const ctx = setup()
    const stale = await researched(ctx)
    ctx.advance(STALE)
    ctx.researcher.respondWith(() => ({ found: false }))

    expect(await ctx.service.research(stale.productId)).toEqual({ kind: 'not-found' })
  })

  it.each(OLDER_CODE)('offers no fallback when the stale formulation was analysed with %s', async (_label, older) => {
    const ctx = setup()
    const stale = await researched(ctx)
    await analysedByOlderCode(ctx, stale.formulationId, older)
    ctx.advance(STALE)
    ctx.researcher.respondWith(() => ({ found: false }))

    expect(await ctx.service.research(stale.productId)).toEqual({ kind: 'not-found' })
  })
})

describe('ProductCatalogService.resolve alias guard', () => {
  const ACME = 'Acme'
  const GLOW = 'Radiance Serum Vitamin Glow'
  const GLOW_BOOSTER = 'Radiance Serum Vitamin Glow Booster'

  // Every pair is similar enough in name to be a near miss; what separates them is category and variant.
  it.each<[string, ProductIdentity, ProductIdentity, number]>([
    ['never asks about a candidate of another category', identity({ brand: ACME, name: GLOW, category: 'hair' }), identity({ brand: ACME, name: GLOW_BOOSTER, category: 'skin' }), 0],
    ['never asks about a candidate whose variant conflicts', identity({ brand: ACME, name: GLOW, variant: 'Night' }), identity({ brand: ACME, name: GLOW, variant: 'Day' }), 0],
    ['still asks when the variants differ only in case and spacing', identity({ brand: ACME, name: GLOW, variant: 'Night Repair' }), identity({ brand: ACME, name: GLOW_BOOSTER, variant: 'night  repair' }), 1],
    ['still asks when only the scanned label has a variant', identity({ brand: ACME, name: GLOW }), identity({ brand: ACME, name: GLOW_BOOSTER, variant: 'Night' }), 1],
    [
      'still asks about a shampoo and a conditioner of one range, which share a category and have no variant',
      identity({ brand: ACME, name: 'Argan Repair Hair Shampoo', category: 'hair' }),
      identity({ brand: ACME, name: 'Argan Repair Hair Conditioner', category: 'hair' }),
      1,
    ],
  ])('%s', async (_label, candidate, scanned, asks) => {
    const ctx = setup()
    const existing = await ctx.service.resolve(candidate)

    const result = await ctx.service.resolve(scanned)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(asks)
    if (asks === 0) {
      expect(result.kind).toBe('needs-research')
      expect(result.productId).not.toBe(existing.productId)
    }
  })
})

describe('ProductCatalogService.resolve product form', () => {
  const NIVEA = { brand: 'NIVEA MEN', name: 'Dry Impact' } as const
  const nivea = (form?: ProductForm): ProductIdentity => identity({ ...NIVEA, ...(form ? { form } : {}) })

  it('makes a new product, without asking the same-product judge, when a spray is scanned and only a formless product exists', async () => {
    const ctx = setup()
    const formless = await ctx.service.resolve(nivea())

    const result = await ctx.service.resolve(nivea('spray'))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
    expect(result.kind).toBe('needs-research')
    expect(result.productId).not.toBe(formless.productId)
  })

  it('makes a new formless product, without asking the judge, when a formless label is scanned and only a spray exists', async () => {
    const ctx = setup()
    const spray = await ctx.service.resolve(nivea('spray'))

    const result = await ctx.service.resolve(nivea())

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
    expect(result.productId).not.toBe(spray.productId)
  })

  it('never asks the judge about a roll-on when a spray is scanned, and makes a separate product', async () => {
    const ctx = setup()
    const rollOn = await ctx.service.resolve(nivea('roll-on'))

    const result = await ctx.service.resolve(nivea('spray'))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
    expect(result.productId).not.toBe(rollOn.productId)
  })

  it('still asks the judge about a near miss of the same form, and remembers a "same product" answer', async () => {
    const ctx = setup()
    const existing = await ctx.service.resolve(identity({ brand: 'NIVEA MEN', name: 'Dry Impact Plus', form: 'spray' }))
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.resolve(identity({ brand: 'NIVEA MEN', name: 'Dry Impact', form: 'spray' }))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).toBe(existing.productId)
  })

  it('tells the researcher the form the product was created with', async () => {
    const ctx = setup()
    ctx.researcher.respondWith(() => ({ found: false }))
    const { productId } = await ctx.service.resolve(nivea('spray'))

    await ctx.service.research(productId)

    expect(ctx.researcher.calls[0]).toMatchObject({ brand: 'NIVEA MEN', name: 'Dry Impact', form: 'spray' })
  })

  it('does not put a form on the identity it gives the researcher for a formless product', async () => {
    const ctx = setup()
    ctx.researcher.respondWith(() => ({ found: false }))
    const { productId } = await ctx.service.resolve(nivea())

    await ctx.service.research(productId)

    expect(ctx.researcher.calls[0]).not.toHaveProperty('form')
  })

  it('shows the form in the product view, and null when there is none', async () => {
    const ctx = setup()
    const spray = await researched(ctx, { who: nivea('spray') })
    const formless = await researched(ctx, { who: identity({ brand: 'Other', name: 'Plain' }) })

    expect((await ctx.service.productView(spray.formulationId)).product.form).toBe('spray')
    expect((await ctx.service.productView(formless.formulationId)).product.form).toBeNull()
  })
})

describe('ProductCatalogService.resolve brand families', () => {
  // The three splits the recognizer really returned for one NIVEA MEN Dry Impact aerosol.
  const SPLITS = {
    'NIVEA MEN | DRY IMPACT': identity({ brand: 'NIVEA MEN', name: 'DRY IMPACT', category: 'body', form: 'spray' }),
    'NIVEA | MEN DRY IMPACT': identity({ brand: 'NIVEA', name: 'MEN DRY IMPACT', category: 'body', form: 'spray' }),
    'NIVEA | MEN (variant Dry Impact)': identity({ brand: 'NIVEA', name: 'MEN', variant: 'Dry Impact', category: 'body', form: 'spray' }),
  }
  type Split = keyof typeof SPLITS
  const pairs = (Object.keys(SPLITS) as Split[]).flatMap((existing) =>
    (Object.keys(SPLITS) as Split[]).filter((incoming) => incoming !== existing).map((incoming) => [existing, incoming] as const),
  )
  const NIVEA_MEN = SPLITS['NIVEA MEN | DRY IMPACT']
  const NIVEA_NAME = SPLITS['NIVEA | MEN DRY IMPACT']

  it.each(pairs)('lands on the existing product when %s exists and %s is scanned, after the judge says they are the same', async (existingSplit, incomingSplit) => {
    const ctx = setup()
    const existing = await ctx.service.resolve(SPLITS[existingSplit])
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.resolve(SPLITS[incomingSplit])

    expect(result).toEqual({ kind: 'needs-research', productId: existing.productId })
    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    const [asked, candidate] = ctx.analyst.calls.sameProduct[0]!
    expect(asked).toMatchObject({ brand: SPLITS[incomingSplit].brand, name: SPLITS[incomingSplit].name })
    expect(candidate).toMatchObject({ brand: SPLITS[existingSplit].brand, name: SPLITS[existingSplit].name })
    // The new spelling is remembered: the key of the incoming split now finds the existing product.
    expect(await ctx.repository.findProductByKey(identityKey(SPLITS[incomingSplit]))).toMatchObject({ id: existing.productId })
  })

  it.each(pairs)('answers a repeat scan of %s then %s from the alias, without asking the judge again', async (existingSplit, incomingSplit) => {
    const ctx = setup()
    await ctx.service.resolve(SPLITS[existingSplit])
    ctx.analyst.sameProductWith(() => true)
    const first = await ctx.service.resolve(SPLITS[incomingSplit])
    const asked = ctx.analyst.calls.sameProduct.length

    const second = await ctx.service.resolve(SPLITS[incomingSplit])

    expect(second).toEqual(first)
    expect(ctx.analyst.calls.sameProduct).toHaveLength(asked)
  })

  it('converges all three splits on one product', async () => {
    const ctx = setup()
    ctx.analyst.sameProductWith(() => true)
    const results = []
    for (const split of Object.values(SPLITS)) results.push(await ctx.service.resolve(split))

    expect(new Set(results.map((r) => r.productId)).size).toBe(1)
  })

  it('still returns an exact repeat of the same split at once, without asking the judge', async () => {
    const ctx = setup()
    const first = await ctx.service.resolve(NIVEA_MEN)
    await ctx.service.resolve(identity({ brand: 'NIVEA', name: 'Soft', category: 'body', form: 'spray' }))

    expect(await ctx.service.resolve(NIVEA_MEN)).toEqual(first)
    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
  })

  it('makes a new product, without asking the judge, for a different product of the family with little word overlap', async () => {
    const ctx = setup()
    const men = await ctx.service.resolve(NIVEA_MEN)
    ctx.analyst.sameProductWith(() => true)

    const sun = await ctx.service.resolve(identity({ brand: 'NIVEA SUN', name: 'Protect & Moisture', category: 'body', form: 'spray' }))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
    expect(sun.kind).toBe('needs-research')
    expect(sun.productId).not.toBe(men.productId)
  })

  it('makes a new product, without asking the judge, for a family member the other way round too', async () => {
    const ctx = setup()
    const sun = await ctx.service.resolve(identity({ brand: 'NIVEA', name: 'SUN', variant: 'Protect & Moisture', category: 'body', form: 'spray' }))
    ctx.analyst.sameProductWith(() => true)

    const men = await ctx.service.resolve(NIVEA_NAME)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
    expect(men.productId).not.toBe(sun.productId)
  })

  it.each<[string, ProductIdentity, ProductIdentity]>([
    [
      'The Ordinary and The Body Shop, with different products',
      identity({ brand: 'The Ordinary', name: 'Niacinamide 10% + Zinc 1%' }),
      identity({ brand: 'The Body Shop', name: 'Tea Tree Oil' }),
    ],
    [
      'The Ordinary and The Body Shop, with the same product name',
      identity({ brand: 'The Ordinary', name: 'Tea Tree Oil' }),
      identity({ brand: 'The Body Shop', name: 'Tea Tree Oil' }),
    ],
  ])('does not merge brands that share only a first word: %s', async (_label, existingIdentity, scanned) => {
    const ctx = setup()
    const existing = await ctx.service.resolve(existingIdentity)
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.resolve(scanned)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
    expect(result.kind).toBe('needs-research')
    expect(result.productId).not.toBe(existing.productId)
  })

  it('does not look at a brand that merely starts with the same letters', async () => {
    const ctx = setup()
    const other = await ctx.service.resolve(identity({ brand: 'NIVEAUX', name: 'MEN DRY IMPACT', category: 'body', form: 'spray' }))
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.resolve(NIVEA_NAME)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
    expect(result.productId).not.toBe(other.productId)
  })

  // Each pair has the same combined words, so only the category, form or variant rule keeps the judge out.
  it.each<[string, ProductIdentity, ProductIdentity]>([
    ['a different category', NIVEA_MEN, { ...NIVEA_NAME, category: 'hair' }],
    ['a different form', NIVEA_MEN, { ...NIVEA_NAME, form: 'roll-on' }],
    ['no form against a form', NIVEA_MEN, { ...NIVEA_NAME, form: undefined }],
    ['a conflicting variant', { ...NIVEA_MEN, variant: 'Fresh' }, { ...NIVEA_NAME, variant: 'Original' }],
  ])('never asks the judge about a family member with %s, and makes a new product', async (_label, existingIdentity, scanned) => {
    const ctx = setup()
    const existing = await ctx.service.resolve(existingIdentity)
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.resolve(scanned)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
    expect(result.kind).toBe('needs-research')
    expect(result.productId).not.toBe(existing.productId)
  })

  it('makes a new product and saves no alias when the judge says the family member is a different product', async () => {
    const ctx = setup()
    const existing = await ctx.service.resolve(NIVEA_MEN)
    ctx.analyst.sameProductWith(() => false)

    const result = await ctx.service.resolve(NIVEA_NAME)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).not.toBe(existing.productId)
    expect(await ctx.repository.findProductByKey(identityKey(NIVEA_NAME))).toMatchObject({ id: result.productId })
    expect(await ctx.repository.findProductByKey(identityKey(NIVEA_MEN))).toMatchObject({ id: existing.productId })
    // A second scan is an exact hit on the product made for it, so the judge is not asked again either.
    expect(await ctx.service.resolve(NIVEA_NAME)).toEqual(result)
    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
  })

  it('leaves the call to the judge for two different same-brand products at exactly 0.6, and makes a new product with no alias', async () => {
    const ctx = setup()
    const sun = identity({ brand: 'NIVEA', name: 'Sun Protect Moisture', category: 'body', form: 'spray' })
    const men = identity({ brand: 'NIVEA', name: 'Men Protect Moisture', category: 'body', form: 'spray' })
    const existing = await ctx.service.resolve(sun)
    ctx.analyst.sameProductWith(() => false)

    const result = await ctx.service.resolve(men)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).not.toBe(existing.productId)
    expect(await ctx.repository.findProductByKey(identityKey(men))).toMatchObject({ id: result.productId })
    expect(await ctx.repository.findProductByKey(identityKey(sun))).toMatchObject({ id: existing.productId })
  })

  it('asks the judge about at most nearMissLimit candidates when the family is large, and then makes a new product', async () => {
    const ctx = setup()
    const flavours = ['Fresh', 'Cool', 'Sport', 'Active', 'Black', 'White', 'Silver', 'Protect', 'Sensitive', 'Original']
    const ids: string[] = []
    for (const [i, flavour] of flavours.entries()) {
      const brand = i % 2 === 0 ? 'NIVEA' : 'NIVEA MEN'
      const name = i % 2 === 0 ? `MEN DRY IMPACT ${flavour}` : `DRY IMPACT ${flavour}`
      ids.push((await ctx.service.resolve(identity({ brand, name, category: 'body', form: 'spray' }))).productId)
      ctx.advance(MINUTE)
    }
    const before = ctx.analyst.calls.sameProduct.length

    const result = await ctx.service.resolve(NIVEA_NAME)

    expect(ctx.analyst.calls.sameProduct.length - before).toBe(CATALOG_POLICY.nearMissLimit)
    expect(ids).not.toContain(result.productId)
  })

  it('compares with only the newest brandScanLimit products of the whole family', async () => {
    const ctx = setup({ policy: { brandScanLimit: 2 } })
    await ctx.service.resolve(NIVEA_MEN)
    ctx.advance(MINUTE)
    await ctx.service.resolve(identity({ brand: 'NIVEA SUN', name: 'Protect & Moisture', category: 'body', form: 'spray' }))
    ctx.advance(MINUTE)
    await ctx.service.resolve(identity({ brand: 'NIVEA', name: 'Soft Cream', category: 'body', form: 'spray' }))
    const before = ctx.analyst.calls.sameProduct.length

    await ctx.service.resolve(NIVEA_NAME)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(before)
  })
})

describe('ProductCatalogService.analyse free text from the model', () => {
  const FIELDS = ['why', 'whoShouldTakeCare'] as const
  const LINKS = ['read more at http://evil.example/offer', 'read more at https://evil.example/offer', 'read more at www.evil.example']
  // HTML-like tags: a "<" straight before a letter, "/" or "!".
  const MARKUP = ['use <script>evil()</script>', 'use <SCRIPT>evil()</SCRIPT>', 'it ends </p> evil', 'a <!-- evil --> comment', 'a rating <evil']
  // Chemistry and ordinary prose use these; none is markup.
  const COMPARISONS = [
    'limited to <1 ppm in leave-on products',
    'when pH < 5',
    'above > 2%',
    'at most <= 2% evil',
    'a rating > evil',
    'a rating < evil',
    'a rating <',
  ]
  const MAX = { why: 800, whoShouldTakeCare: 400 }

  /** Analyses, expects the analysis to be rejected and nothing stored, and returns the error. */
  const rejected = async (ctx: Ctx, formulationId: string) => {
    const error = await errorOf(ctx.service.analyse(formulationId))
    expect(error).toBeInstanceOf(AnalysisRejectedError)
    const view = await ctx.service.productView(formulationId)
    expect(view.concerns).toEqual([])
    expect(view.formulation.analysedAt).toBeNull()
    return error
  }
  const withMercury = async (ctx: Ctx) => (await researched(ctx, { ingredients: WITH_MERCURY })).formulationId

  it.each(FIELDS.flatMap((field) => [[field, MAX[field]] as const]))('accepts %s of exactly %i characters', async (field, max) => {
    const ctx = setup()
    const formulationId = await withMercury(ctx)
    ctx.analyst.analyseWith(() => [draft({ [field]: 'a'.repeat(max) })])

    await ctx.service.analyse(formulationId)

    expect((await ctx.service.productView(formulationId)).concerns[0]![field]).toHaveLength(max)
  })

  it.each(FIELDS.flatMap((field) => [[field, MAX[field] + 1] as const]))('rejects %s of %i characters, storing nothing', async (field, length) => {
    const ctx = setup()
    const formulationId = await withMercury(ctx)
    ctx.analyst.analyseWith(() => [draft({ [field]: 'a'.repeat(length) })])

    const error = await rejected(ctx, formulationId)

    expect(error.message).toContain('TEXT_TOO_LONG')
  })

  it.each(FIELDS.flatMap((field) => LINKS.map((text) => [field, text] as const)))('rejects %s containing the link "%s" as TEXT_HAS_LINK, storing nothing and never repeating it', async (field, text) => {
    const ctx = setup()
    const formulationId = await withMercury(ctx)
    ctx.analyst.analyseWith(() => [draft({ [field]: text })])

    const error = await rejected(ctx, formulationId)

    expect(error.message).toContain('TEXT_HAS_LINK')
    expect(error.message).not.toContain('evil')
  })

  it.each(FIELDS.flatMap((field) => MARKUP.map((text) => [field, text] as const)))('rejects %s containing the markup "%s" as TEXT_HAS_MARKUP, storing nothing and never repeating it', async (field, text) => {
    const ctx = setup()
    const formulationId = await withMercury(ctx)
    ctx.analyst.analyseWith(() => [draft({ [field]: text })])

    const error = await rejected(ctx, formulationId)

    expect(error.message).toContain('TEXT_HAS_MARKUP')
    expect(error.message).not.toContain('evil')
  })

  it.each(FIELDS)('rejects %s containing both a link and markup as TEXT_HAS_LINK', async (field) => {
    const ctx = setup()
    const formulationId = await withMercury(ctx)
    ctx.analyst.analyseWith(() => [draft({ [field]: 'use <b>evil</b> at http://evil.example' })])

    const error = await rejected(ctx, formulationId)

    expect(error.message).toContain('TEXT_HAS_LINK')
  })

  it.each(FIELDS.flatMap((field) => COMPARISONS.map((text) => [field, text] as const)))('accepts %s containing "%s", because a comparison sign is not markup', async (field, text) => {
    const ctx = setup()
    const formulationId = await withMercury(ctx)
    ctx.analyst.analyseWith(() => [draft({ [field]: text })])

    await ctx.service.analyse(formulationId)

    expect((await ctx.service.productView(formulationId)).concerns[0]![field]).toBe(text)
  })

  it('accepts 20 concerns and rejects 21, storing nothing', async () => {
    const ctx = setup()
    const { formulationId } = await researched(ctx)
    const concerns = (count: number) =>
      Array.from({ length: count }, (_, i) => draft({ kind: 'drying', severity: 'low', ingredients: ['Glycerin'], sources: [], why: `Reason ${i}.` }))
    ctx.analyst.analyseWith(() => concerns(21))

    await rejected(ctx, formulationId)

    ctx.analyst.analyseWith(() => concerns(20))
    await ctx.service.analyse(formulationId)
    expect((await ctx.service.productView(formulationId)).concerns).toHaveLength(20)
  })

  it.each<[string, DraftConcern[]]>([
    ['an unknown kind', [draft(), draft({ kind: 'evil ignore previous instructions' })]],
    ['an unknown severity', [draft(), draft({ severity: 'evil ignore previous instructions' })]],
    ['an unknown trait', [draft(), draft({ traits: ['evil ignore previous instructions'] })]],
    ['a flagged fact no concern covers', []],
  ])('rejects %s without repeating any text the model or the label supplied', async (_label, drafts) => {
    const ctx = setup()
    const formulationId = await withMercury(ctx)
    ctx.analyst.analyseWith(() => drafts)

    const error = await rejected(ctx, formulationId)

    expect(error.message).not.toContain('evil')
    // The flagged ingredient comes from the label, so it must not be repeated either.
    expect(error.message.toLowerCase()).not.toContain('mercury')
  })

  it.each([
    ['an unknown trait', 'UNKNOWN_TRAIT', [draft({ traits: ['evil-trait'] })]],
    ['a flagged fact no concern covers', 'UNCOVERED_FLAGGED_FACT', []],
  ] as const)('names %s by the code %s', async (_label, code, drafts) => {
    const ctx = setup()
    const formulationId = await withMercury(ctx)
    ctx.analyst.analyseWith(() => [...drafts])

    expect((await rejected(ctx, formulationId)).message).toContain(code)
  })

  it('stores a concern that covers a banned substance as high severity, whatever severity the model gave', async () => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: ['Aqua', 'Mercury', 'Sodium Lauryl Sulfate'] })
    ctx.analyst.analyseWith(() => [draft({ severity: 'low' }), draft({ kind: 'irritation', severity: 'low', ingredients: ['Sodium Lauryl Sulfate'], sources: [] })])

    await ctx.service.analyse(formulationId)

    expect((await ctx.service.productView(formulationId)).concerns.map((c) => [c.kind, c.severity])).toEqual([
      ['banned-substance', 'high'],
      ['irritation', 'low'],
    ])
  })

  it('keeps a source on a concern only when a flagged fact of the concern\'s own kind and ingredient has it', async () => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: ['Aqua', 'Mercury', 'Linalool', 'Glycerin'] })
    ctx.analyst.analyseWith(() => [
      draft({ sources: [EUR_LEX] }),
      // EUR_LEX is a source of the flagged facts, but no fact is a drying concern ...
      draft({ kind: 'drying', severity: 'low', ingredients: ['Glycerin'], sources: [EUR_LEX] }),
      // ... and the allergen fact is about Linalool, not Glycerin.
      draft({ kind: 'allergen', severity: 'medium', ingredients: ['Glycerin'], sources: [EUR_LEX] }),
      draft({ kind: 'allergen', severity: 'medium', ingredients: ['Linalool'], sources: [EUR_LEX] }),
    ])

    await ctx.service.analyse(formulationId)

    expect((await ctx.service.productView(formulationId)).concerns.map((c) => [c.kind, c.ingredients, c.sources])).toEqual([
      ['banned-substance', ['Mercury'], [EUR_LEX]],
      ['drying', ['Glycerin'], []],
      ['allergen', ['Glycerin'], []],
      ['allergen', ['Linalool'], [EUR_LEX]],
    ])
  })
})

describe('ProductCatalogService.analyse attempts', () => {
  const REJECTING: DraftConcern[] = []
  const allAttempts = (ctx: Ctx) => ctx.repository.analysisAttemptsSince(new Date(0))
  const rejections = (ctx: Ctx, formulationId: string) => ctx.repository.rejectedAnalyses(formulationId, ANALYSIS_VERSION, REFERENCE_VERSION)
  const another = (ctx: Ctx, n: number) => researched(ctx, { who: identity({ name: `Cleanser ${'abcdefgh'[n]}${'zyxwvuts'[n]}` }), ingredients: WITH_MERCURY })

  // N2: a failed attempt (an outage) costs nothing, so it is recorded but no longer counted against the daily budget.
  it.each([
    ['accepted', 'ok', 1, 0, (ctx: Ctx) => ctx.analyst.analyseWith(() => [draft()])],
    ['rejected', 'rejected', 1, 1, (ctx: Ctx) => ctx.analyst.analyseWith(() => REJECTING)],
    ['failed', 'failed', 0, 0, (ctx: Ctx) => ctx.analyst.failNextWith(new Error('model is down'))],
  ] as const)('records one attempt for an analysis that was %s, settled as %s', async (_outcome, settled, counted, rejected, arrange) => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
    arrange(ctx)

    await ctx.service.analyse(formulationId).catch(() => undefined)

    expect(await ctx.repository.lastAnalysisAttempt(formulationId)).toEqual({ outcome: settled, attemptedAt: T0 })
    expect(await allAttempts(ctx)).toBe(counted)
    expect(await rejections(ctx, formulationId)).toBe(rejected)
  })

  it('rethrows the analyst\'s own error', async () => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
    const original = new Error('model is down')
    ctx.analyst.failNextWith(original)

    await expect(ctx.service.analyse(formulationId)).rejects.toBe(original)
  })

  it('rejects twice as retryable and the third time at the same versions as permanent', async () => {
    const ctx = setup()
    const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
    ctx.analyst.analyseWith(() => REJECTING)

    await expect(ctx.service.analyse(formulationId)).rejects.toBeInstanceOf(AnalysisRejectedError)
    await expect(ctx.service.analyse(formulationId)).rejects.toBeInstanceOf(AnalysisRejectedError)
    const third = await errorOf(ctx.service.analyse(formulationId))

    expect(third).toBeInstanceOf(PermanentJobError)
    expect(ctx.analyst.calls.analyse).toHaveLength(3)
  })

  it('still asks for analysis after two rejections, and reports analysis-failed without calling the analyst after the third', async () => {
    const ctx = setup()
    const { productId, formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
    ctx.analyst.analyseWith(() => REJECTING)
    await ctx.service.analyse(formulationId).catch(() => undefined)
    await ctx.service.analyse(formulationId).catch(() => undefined)

    expect(await ctx.service.resolve(identity())).toEqual({ kind: 'needs-analysis', productId, formulationId })

    await ctx.service.analyse(formulationId).catch(() => undefined)
    const calls = ctx.analyst.calls.analyse.length

    expect(await ctx.service.resolve(identity())).toEqual({ kind: 'analysis-failed', productId, formulationId })
    expect(ctx.analyst.calls.analyse).toHaveLength(calls)
  })

  // The rejections were recorded by older code: the versions are constants, so this is how a version change is reached.
  it.each([
    ['analysis version', { analysisVersion: ANALYSIS_VERSION - 1 }],
    ['reference version', { referenceVersion: 'seed-old' }],
  ] as const)('asks for analysis again once the %s has changed since three rejections', async (_label, older) => {
    const ctx = setup()
    const { productId, formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
    for (let i = 0; i < 3; i++) {
      await ctx.repository.recordAnalysisAttempt({
        id: `old-${i}`,
        formulationId,
        attemptedAt: T0,
        outcome: 'rejected',
        analysisVersion: ANALYSIS_VERSION,
        referenceVersion: REFERENCE_VERSION,
        ...older,
      })
    }

    expect(await ctx.service.resolve(identity())).toEqual({ kind: 'needs-analysis', productId, formulationId })
  })

  describe('when the AI spend cap is reached', () => {
    const arrangeCap = (ctx: Ctx) => ctx.analyst.failNextWith(new AiBudgetExceededError('The AI spend cap would be exceeded'))

    it('throws CatalogBusyError, so the job is retried later, and stores nothing', async () => {
      const ctx = setup()
      const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
      arrangeCap(ctx)

      const error = await errorOf(ctx.service.analyse(formulationId))

      expect(error).toBeInstanceOf(CatalogBusyError)
      expect(error).toBeInstanceOf(UnavailableError)
      expect((await ctx.service.productView(formulationId)).formulation.analysedAt).toBeNull()
    })

    it('is not a rejection of the analysis, however often it happens', async () => {
      const ctx = setup()
      const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })

      for (let i = 0; i < 4; i++) {
        arrangeCap(ctx)
        await errorOf(ctx.service.analyse(formulationId))
      }

      expect(await ctx.repository.rejectedAnalyses(formulationId, ANALYSIS_VERSION, REFERENCE_VERSION)).toBe(0)
      expect(await ctx.service.resolve(identity())).toMatchObject({ kind: 'needs-analysis', formulationId })
    })

    it('records no analysis attempt: a refusal is free and does not use up the daily budget', async () => {
      const ctx = setup()
      const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
      arrangeCap(ctx)

      await errorOf(ctx.service.analyse(formulationId))

      expect(await ctx.repository.analysisAttemptsSince(new Date(0))).toBe(0)
    })

    it('analyses the same formulation once there is room again', async () => {
      const ctx = setup()
      const { formulationId } = await researched(ctx, { ingredients: WITH_MERCURY })
      arrangeCap(ctx)
      await errorOf(ctx.service.analyse(formulationId))
      ctx.analyst.analyseWith(() => [draft()])

      await ctx.service.analyse(formulationId)

      expect((await ctx.service.productView(formulationId)).concerns).toHaveLength(1)
    })
  })

  describe('daily budget', () => {
    it('analyses while attempts are under the budget and refuses, without calling the analyst, once they reach it', async () => {
      const ctx = setup({ policy: { dailyAnalysisBudget: 2 } })
      const first = await another(ctx, 0)
      const second = await another(ctx, 1)
      const third = await another(ctx, 2)
      ctx.analyst.analyseWith(() => [draft()])

      await ctx.service.analyse(first.formulationId)
      await ctx.service.analyse(second.formulationId)
      const error = await errorOf(ctx.service.analyse(third.formulationId))

      expect(error).toBeInstanceOf(CatalogBusyError)
      expect(error).toBeInstanceOf(UnavailableError)
      expect(ctx.analyst.calls.analyse).toHaveLength(2)
    })

    it.each([
      ['accepted', (ctx: Ctx) => ctx.analyst.analyseWith(() => [draft()])],
      ['rejected', (ctx: Ctx) => ctx.analyst.analyseWith(() => REJECTING)],
    ] as const)('counts an analysis that was %s', async (_outcome, arrange) => {
      const ctx = setup({ policy: { dailyAnalysisBudget: 1 } })
      const first = await another(ctx, 0)
      const second = await another(ctx, 1)
      arrange(ctx)
      await ctx.service.analyse(first.formulationId).catch(() => undefined)

      await expect(ctx.service.analyse(second.formulationId)).rejects.toBeInstanceOf(CatalogBusyError)
    })

    // N2: like a failed research, a failed analysis (an outage) costs nothing, so it does not use up the day's budget.
    it('does not count an analysis that failed, since an outage costs nothing', async () => {
      const ctx = setup({ policy: { dailyAnalysisBudget: 1 } })
      const first = await another(ctx, 0)
      const second = await another(ctx, 1)
      ctx.analyst.failNextWith(new Error('model is down'))
      await ctx.service.analyse(first.formulationId).catch(() => undefined)
      ctx.analyst.analyseWith(() => [draft()])

      await expect(ctx.service.analyse(second.formulationId)).resolves.toBeUndefined()
      expect(ctx.analyst.calls.analyse).toHaveLength(1)
    })

    it.each([
      ['exactly 24 hours ago', DAY, true],
      ['24 hours and a millisecond ago', DAY + 1, false],
    ] as const)('counts an analysis made %s only while it is within the last 24 hours', async (_label, elapsed, busy) => {
      const ctx = setup({ policy: { dailyAnalysisBudget: 1 } })
      const first = await another(ctx, 0)
      const second = await another(ctx, 1)
      ctx.analyst.analyseWith(() => [draft()])
      await ctx.service.analyse(first.formulationId)
      ctx.advance(elapsed)

      const outcome = ctx.service.analyse(second.formulationId)

      if (busy) await expect(outcome).rejects.toBeInstanceOf(CatalogBusyError)
      else await expect(outcome).resolves.toBeUndefined()
    })
  })
})

/**
 * A service built around a given analyst and repository, for tests that need to hold or watch an analyst call. It has its
 * own clock, and its researcher finds the mercury formulation, so analysing it needs a concern for the banned substance.
 */
const buildAround = (analyst: MemoryProductAnalyst, repository: FakeCatalogRepository = new FakeCatalogRepository()) => {
  let clock = T0
  let n = 0
  const researcher = new MemoryProductResearcher()
  researcher.respondWith(() => ({ found: true, ingredients: WITH_MERCURY, sourceUrl: SOURCE_URL }))
  const service = new ProductCatalogService({
    repository,
    researcher,
    analyst,
    images: new MemoryCatalogImageStore(),
    imageKeyPrefix: IMAGE_KEY_PREFIX,
    now: () => clock,
    newId: () => `id-${++n}`,
  })
  return { service, repository, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) }
}
/** Resolves and researches the CeraVe product, returning its formulation id. */
const formulationOf = async (service: ProductCatalogService) => {
  const resolved = await service.resolve(identity())
  if (resolved.kind !== 'needs-research') throw new Error('expected needs-research')
  const found = await service.research(resolved.productId)
  if (found.kind !== 'found') throw new Error('expected found')
  return found.formulationId
}

// N1: a call already in flight for the same work is shared, not repeated. The queue retries the refused call later.
describe('ProductCatalogService in-flight sharing', () => {
  const FIVE_MINUTES = 5 * MINUTE

  /** The first call waits at the gate until opened, so a second call can be made while it is "in flight". */
  const gate = () => {
    let release!: () => void
    let entered!: () => void
    return { started: new Promise<void>((resolve) => (entered = resolve)), opened: new Promise<void>((resolve) => (release = resolve)), release: () => release(), enter: () => entered() }
  }
  class HoldFirstResearcher extends MemoryProductResearcher {
    readonly gate = gate()
    private held = false
    override async research(product: ProductIdentity) {
      if (!this.held) {
        this.held = true
        this.gate.enter()
        await this.gate.opened
      }
      return super.research(product)
    }
  }
  class HoldFirstAnalyst extends MemoryProductAnalyst {
    readonly gate = gate()
    private held = false
    override async analyse(input: Parameters<MemoryProductAnalyst['analyse']>[0]) {
      if (!this.held) {
        this.held = true
        this.gate.enter()
        await this.gate.opened
      }
      return super.analyse(input)
    }
  }
  /** A crash between "started" and the outcome: the call fails and so does settling it, so the attempt stays "started". */
  class SettleResearchFails extends FakeCatalogRepository {
    override async settleResearchAttempt(): Promise<void> {
      throw new Error('database is down')
    }
  }
  class SettleAnalysisFails extends FakeCatalogRepository {
    override async settleAnalysisAttempt(): Promise<void> {
      throw new Error('database is down')
    }
  }

  describe('research', () => {
    it('refuses a second research of a product whose research is in flight with RESEARCH_IN_PROGRESS, without calling the researcher again', async () => {
      const researcher = new HoldFirstResearcher()
      researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))
      const ctx = setup({ researcher })
      const { productId } = await ctx.service.resolve(identity())
      const first = ctx.service.research(productId)
      await researcher.gate.started

      const error = await errorOf(ctx.service.research(productId))

      expect(error).toBeInstanceOf(UnavailableError)
      expect(error.code).toBe('RESEARCH_IN_PROGRESS')
      researcher.gate.release()
      expect(await first).toEqual({ kind: 'found', formulationId: expect.any(String) })
      expect(researcher.calls).toHaveLength(1)
    })

    it('does not hold up the research of a different product', async () => {
      const researcher = new HoldFirstResearcher()
      researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))
      const ctx = setup({ researcher })
      const { productId } = await ctx.service.resolve(identity())
      const other = await ctx.service.resolve(identity({ name: 'Foaming Cleanser' }))
      const first = ctx.service.research(productId)
      await researcher.gate.started

      await expect(ctx.service.research(other.productId)).resolves.toEqual({ kind: 'found', formulationId: expect.any(String) })

      researcher.gate.release()
      await first
    })

    it.each([
      ['4 minutes 59.999 seconds ago', 'still in flight, so is refused', FIVE_MINUTES - 1, true],
      ['exactly 5 minutes ago', 'no longer in flight, so research goes ahead', FIVE_MINUTES, false],
    ] as const)('a research attempt that started %s is %s', async (_label, _meaning, elapsed, inProgress) => {
      const ctx = setup({ repository: new SettleResearchFails() })
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const { productId } = await ctx.service.resolve(identity())
      ctx.researcher.failNextWith(new Error('the worker crashed'))
      await ctx.service.research(productId).catch(() => undefined)
      expect(await ctx.repository.lastResearchOutcome(productId)).toEqual({ outcome: 'started', attemptedAt: T0 })
      ctx.advance(elapsed)
      ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))

      const attempt = ctx.service.research(productId)

      if (inProgress) {
        await expect(attempt).rejects.toMatchObject({ code: 'RESEARCH_IN_PROGRESS' })
        expect(ctx.researcher.calls).toHaveLength(0)
      } else {
        await expect(attempt).resolves.toEqual({ kind: 'found', formulationId: expect.any(String) })
        expect(ctx.researcher.calls).toHaveLength(1)
      }
      log.mockRestore()
    })

    it('does not refuse a product whose last attempt has finished, whatever its outcome', async () => {
      const ctx = setup()
      const { productId } = await ctx.service.resolve(identity())
      ctx.researcher.failNextWith(new Error('search is down'))
      await ctx.service.research(productId).catch(() => undefined)
      ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))

      await expect(ctx.service.research(productId)).resolves.toEqual({ kind: 'found', formulationId: expect.any(String) })
    })
  })

  describe('analyse', () => {
    it('refuses a second analysis of a formulation whose analysis is in flight with ANALYSIS_IN_PROGRESS, without calling the analyst again', async () => {
      const analyst = new HoldFirstAnalyst()
      analyst.analyseWith(() => [draft()])
      const { service } = buildAround(analyst)
      const formulationId = await formulationOf(service)
      const first = service.analyse(formulationId)
      await analyst.gate.started

      const error = await errorOf(service.analyse(formulationId))

      expect(error).toBeInstanceOf(UnavailableError)
      expect(error.code).toBe('ANALYSIS_IN_PROGRESS')
      analyst.gate.release()
      await first
      expect(analyst.calls.analyse).toHaveLength(1)
    })

    it('is not a rejection: an analysis refused as in progress does not count towards the three strikes', async () => {
      const analyst = new HoldFirstAnalyst()
      analyst.analyseWith(() => [draft()])
      const { service, repository } = buildAround(analyst)
      const formulationId = await formulationOf(service)
      const first = service.analyse(formulationId)
      await analyst.gate.started
      for (let i = 0; i < 4; i++) await errorOf(service.analyse(formulationId))

      analyst.gate.release()
      await first

      expect(await repository.rejectedAnalyses(formulationId, ANALYSIS_VERSION, REFERENCE_VERSION)).toBe(0)
      expect(await repository.analysisAttemptsSince(new Date(0))).toBe(1)
    })

    it.each([
      ['4 minutes 59.999 seconds ago', 'still in flight, so is refused', FIVE_MINUTES - 1, true],
      ['exactly 5 minutes ago', 'no longer in flight, so analysis goes ahead', FIVE_MINUTES, false],
    ] as const)('an analysis attempt that started %s is %s', async (_label, _meaning, elapsed, inProgress) => {
      const analyst = new MemoryProductAnalyst()
      const { service, repository, advance } = buildAround(analyst, new SettleAnalysisFails())
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const formulationId = await formulationOf(service)
      analyst.failNextWith(new Error('the worker crashed'))
      await service.analyse(formulationId).catch(() => undefined)
      expect(await repository.lastAnalysisAttempt(formulationId)).toEqual({ outcome: 'started', attemptedAt: T0 })
      advance(elapsed)
      analyst.analyseWith(() => [draft()])

      const attempt = service.analyse(formulationId)

      if (inProgress) {
        await expect(attempt).rejects.toMatchObject({ code: 'ANALYSIS_IN_PROGRESS' })
        expect(analyst.calls.analyse).toHaveLength(0)
      } else {
        await expect(attempt).resolves.toBeUndefined()
        expect(analyst.calls.analyse).toHaveLength(1)
      }
      log.mockRestore()
    })

    it('does not refuse a formulation whose last attempt has finished', async () => {
      const analyst = new MemoryProductAnalyst()
      const { service } = buildAround(analyst)
      const formulationId = await formulationOf(service)
      analyst.failNextWith(new Error('model is down'))
      await service.analyse(formulationId).catch(() => undefined)
      analyst.analyseWith(() => [draft()])

      await expect(service.analyse(formulationId)).resolves.toBeUndefined()
    })
  })
})

// N2: analysis is accounted for like research: started before the model is called, settled after.
describe('ProductCatalogService.analyse attempt accounting', () => {
  const analysing = async (ctx: Ctx) => (await researched(ctx, { ingredients: WITH_MERCURY })).formulationId

  it('records the attempt as started, and counted, before it calls the analyst, and the outcome after', async () => {
    const repository = new FakeCatalogRepository()
    const during: { last?: unknown; counted?: number } = {}
    let watched = ''
    class Probe extends MemoryProductAnalyst {
      override async analyse(input: Parameters<MemoryProductAnalyst['analyse']>[0]) {
        during.last = await repository.lastAnalysisAttempt(watched)
        during.counted = await repository.analysisAttemptsSince(T0)
        return super.analyse(input)
      }
    }
    const probe = new Probe()
    probe.analyseWith(() => [draft()])
    const { service } = buildAround(probe, repository)
    watched = await formulationOf(service)

    await service.analyse(watched)

    expect(during.last).toEqual({ outcome: 'started', attemptedAt: T0 })
    expect(during.counted).toBe(1)
    expect(await repository.lastAnalysisAttempt(watched)).toEqual({ outcome: 'ok', attemptedAt: T0 })
  })

  it('settles the attempt as failed, so it does not count, when the AI spend cap refuses the call', async () => {
    const ctx = setup()
    const formulationId = await analysing(ctx)
    ctx.analyst.failNextWith(new AiBudgetExceededError('cap'))

    await errorOf(ctx.service.analyse(formulationId))

    expect(await ctx.repository.lastAnalysisAttempt(formulationId)).toEqual({ outcome: 'failed', attemptedAt: T0 })
    expect(await ctx.repository.analysisAttemptsSince(T0)).toBe(0)
  })

  it('settles the attempt as ok, so it counts, when the model answered and the gate passed but the analysis could not be saved', async () => {
    class SaveFails extends FakeCatalogRepository {
      override async saveAnalysis(): Promise<void> {
        throw new Error('database is down')
      }
    }
    const ctx = setup({ repository: new SaveFails() })
    const formulationId = await analysing(ctx)
    ctx.analyst.analyseWith(() => [draft()])

    await expect(ctx.service.analyse(formulationId)).rejects.toThrow('database is down')

    expect(await ctx.repository.lastAnalysisAttempt(formulationId)).toEqual({ outcome: 'ok', attemptedAt: T0 })
    expect(await ctx.repository.analysisAttemptsSince(T0)).toBe(1)
  })

  it('still counts rejections towards the three strikes, and a failure in between does not reset them', async () => {
    const ctx = setup()
    const formulationId = await analysing(ctx)
    ctx.analyst.analyseWith(() => [])
    await expect(ctx.service.analyse(formulationId)).rejects.toBeInstanceOf(AnalysisRejectedError)
    ctx.analyst.failNextWith(new Error('model is down'))
    await ctx.service.analyse(formulationId).catch(() => undefined)
    await expect(ctx.service.analyse(formulationId)).rejects.toBeInstanceOf(AnalysisRejectedError)

    const third = await errorOf(ctx.service.analyse(formulationId))

    expect(third).toBeInstanceOf(PermanentJobError)
  })

  it('does not call the analyst when the started attempt cannot be recorded', async () => {
    class StartFails extends FakeCatalogRepository {
      override async recordAnalysisAttempt(): Promise<void> {
        throw new Error('database is down')
      }
    }
    const ctx = setup({ repository: new StartFails() })
    const formulationId = await analysing(ctx)

    await expect(ctx.service.analyse(formulationId)).rejects.toThrow('database is down')

    expect(ctx.analyst.calls.analyse).toHaveLength(0)
  })

  describe('when settling the attempt fails', () => {
    class SettleFails extends FakeCatalogRepository {
      override async settleAnalysisAttempt(): Promise<void> {
        throw new Error('database is down')
      }
    }
    const quietly = async <T>(fn: () => Promise<T>) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        return await fn()
      } finally {
        log.mockRestore()
      }
    }

    it('rethrows the analyst\'s own error', async () => {
      const ctx = setup({ repository: new SettleFails() })
      const formulationId = await analysing(ctx)
      const original = new Error('model is down')
      ctx.analyst.failNextWith(original)

      await quietly(async () => expect(ctx.service.analyse(formulationId)).rejects.toBe(original))
    })

    it('still stores an accepted analysis', async () => {
      const ctx = setup({ repository: new SettleFails() })
      const formulationId = await analysing(ctx)
      ctx.analyst.analyseWith(() => [draft()])

      await quietly(() => ctx.service.analyse(formulationId))

      expect((await ctx.service.productView(formulationId)).concerns).toHaveLength(1)
    })

    it('still reports a rejection as a rejection', async () => {
      const ctx = setup({ repository: new SettleFails() })
      const formulationId = await analysing(ctx)
      ctx.analyst.analyseWith(() => [])

      await quietly(async () => expect(ctx.service.analyse(formulationId)).rejects.toBeInstanceOf(AnalysisRejectedError))
    })
  })
})
