import { describe, expect, it, vi } from 'vitest'
import { PermanentJobError } from '../../jobs/job'
import { NotFoundError, UnavailableError, ValidationError } from '../../lib/errors'
import { AiBudgetExceededError } from '../../providers/anthropic/ai-spend.provider'
import { MemoryCatalogImageStore } from '../../providers/catalog-images/memory.catalog-image-store'
import { MemoryProductAnalyst } from '../../providers/product-analysis/memory.product-analyst'
import type { DraftConcern, ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import { MemoryEmailSender } from '../../providers/email/memory.email'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryProductResearcher } from '../../providers/product-research/memory.product-researcher'
import type { ProductForm, ProductIdentity } from '../../providers/product-research/product-researcher.provider'
import { FakeOpsAlertsRepository } from '../ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import { brandKey, identityKey } from './catalog.identity'
import { REFERENCE_COVERAGE, REFERENCE_VERSION } from './catalog.reference'
import { FakeCatalogRepository } from './catalog.repository.fake'
import { AnalysisRejectedError, CATALOG_POLICY, CatalogBusyError, ProductCatalogService } from './catalog.service'
import type { StockImageOutcome } from './catalog.service'
import type { DraftConcernRow } from './catalog.types'
import { ANALYSIS_VERSION, CONCERN_KINDS, FRESH_FOR_DAYS, SEVERITIES, TRAITS } from './catalog.vocabulary'

// The repository contract (fake and D1) is mounted by catalog.repository.test.ts and its integration twin.

const T0 = new Date('2030-06-15T12:00:00.000Z')
/** Midnight UTC of the day T0 is in: the window the daily budget alerts are kept in. */
const DAY_START = new Date('2030-06-15T00:00:00.000Z')
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
  // The real alerting service, so what is asserted is what the owner would be emailed about: one job per kind and window.
  const alertJobs = new MemoryJobQueue()
  const opsAlerts = new OpsAlertsService({
    repository: new FakeOpsAlertsRepository(),
    jobs: alertJobs,
    email: new MemoryEmailSender(),
    recipient: 'ops@example.com',
    environment: 'test',
    now: () => clock,
  })
  const service = new ProductCatalogService({
    repository,
    researcher,
    analyst,
    images,
    imageKeyPrefix: IMAGE_KEY_PREFIX,
    opsAlerts,
    now: () => clock,
    newId: () => `id-${++n}`,
    ...(options.policy ? { policy: { ...CATALOG_POLICY, ...options.policy } } : {}),
  })
  /** The kind and window of every alert queued so far. */
  const alerts = () => alertJobs.enqueued.map((e) => e.body as { kind: string; windowStart: number })
  return { service, repository, researcher, analyst, images, alerts, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) }
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
  // Word overlap with TARGET (Jaccard): A 3/5 = 0.6 (exactly the threshold), B 4/5, C 5/6, D 5/5, E 3/8 (and TARGET's words are not all inside it).
  const TARGET = identity({ brand: ACME, name: 'Radiance Serum Vitamin Glow Booster' })
  const NAMES = {
    A: 'Radiance Serum Vitamin',
    B: 'Radiance Serum Vitamin Glow',
    C: 'Radiance Serum Vitamin Glow Booster Night',
    D: 'Booster Glow Vitamin Serum Radiance',
    E: 'Radiance Serum Hydra Mist',
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

    expect(result).toEqual({ kind: 'found', formulationId: expect.any(String), image: expect.any(String) })
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

    expect(again).toEqual({ kind: 'found', formulationId: first.formulationId, image: expect.any(String) })
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

      expect(await ctx.service.research(productId)).toEqual({ kind: 'found', formulationId: expect.any(String), image: expect.any(String) })
    })

    it('still rethrows every other error from the researcher', async () => {
      const ctx = setup()
      const productId = await productFor(ctx)
      ctx.researcher.failNextWith(new Error('search is down'))

      await expect(ctx.service.research(productId)).rejects.toThrow('search is down')
    })
  })

  describe('daily budget', () => {
    const ALERT = [{ kind: 'research-budget', windowStart: DAY_START.getTime() }]
    // A not-found product is not researched again for a week, so each research here is of a different product.
    const products = async (ctx: Ctx, count: number) => {
      const ids: string[] = []
      for (let i = 0; i < count; i++) ids.push(await productFor(ctx, identity({ name: `Cleanser ${'abcdefgh'[i]}${'zyxwvuts'[i]}` })))
      return ids
    }

    it('researches every product, even past the budget, and raises research-budget when an attempt goes past it, not before', async () => {
      const ctx = setup({ policy: { dailyResearchBudget: 2 } })
      const [a, b, c] = await products(ctx, 3)

      expect(await ctx.service.research(a!)).toEqual({ kind: 'not-found' })
      expect(await ctx.service.research(b!)).toEqual({ kind: 'not-found' })
      expect(ctx.alerts()).toEqual([])
      expect(await ctx.service.research(c!)).toEqual({ kind: 'not-found' })

      expect(ctx.researcher.calls).toHaveLength(3)
      expect(ctx.alerts()).toEqual(ALERT)
    })

    it('stores what it finds past the budget, as it does under it', async () => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      const [first, second] = await products(ctx, 2)
      await ctx.service.research(first!)
      ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))

      const result = await ctx.service.research(second!)

      expect(result).toEqual({ kind: 'found', formulationId: expect.any(String), image: expect.any(String) })
      expect(await ctx.repository.latestFormulation(second!)).toMatchObject({ ingredients: CLEAN })
      expect(ctx.alerts()).toEqual(ALERT)
    })

    it('never answers budget-exhausted for the budget, however far past it the day goes', async () => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      const ids = await products(ctx, 4)

      const kinds = []
      for (const id of ids) kinds.push((await ctx.service.research(id)).kind)

      expect(kinds).toEqual(['not-found', 'not-found', 'not-found', 'not-found'])
    })

    it('raises the alert once for the day, however many attempts go past the budget', async () => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      for (const id of await products(ctx, 4)) await ctx.service.research(id)

      expect(ctx.alerts()).toEqual(ALERT)
    })

    it.each([
      ['found', (ctx: Ctx) => ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))],
      ['not-found', (ctx: Ctx) => ctx.researcher.respondWith(() => ({ found: false }))],
    ] as const)('counts a %s attempt against the budget', async (_outcome, arrange) => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      const [first, second] = await products(ctx, 2)
      arrange(ctx)
      await ctx.service.research(first!)
      expect(ctx.alerts()).toEqual([])

      await ctx.service.research(second!)

      expect(ctx.alerts()).toEqual(ALERT)
    })

    it('does not count a failed attempt against the budget, since an outage costs nothing', async () => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      const [first, second] = await products(ctx, 2)
      ctx.researcher.failNextWith(new Error('search is down'))
      await ctx.service.research(first!).catch(() => undefined)

      expect(await ctx.service.research(second!)).toEqual({ kind: 'not-found' })
      expect(ctx.researcher.calls).toHaveLength(1)
      expect(ctx.alerts()).toEqual([])
    })

    it('does not count a fresh formulation that is returned without researching', async () => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      const first = await researched(ctx)

      expect(await ctx.service.research(first.productId)).toEqual({ kind: 'found', formulationId: first.formulationId })
      expect(ctx.alerts()).toEqual([])
    })

    it('still skips, without calling the researcher or raising, a product that was not found less than 7 days ago, even past the budget', async () => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      const [first, second] = await products(ctx, 2)
      await ctx.service.research(first!)
      await ctx.service.research(second!)
      expect(ctx.alerts()).toEqual(ALERT)
      const calls = ctx.researcher.calls.length

      expect(await ctx.service.research(first!)).toEqual({ kind: 'not-found' })

      expect(ctx.researcher.calls).toHaveLength(calls)
      expect(ctx.alerts()).toEqual(ALERT)
    })

    it.each([
      ['exactly 24 hours ago', DAY, 1],
      ['24 hours and a millisecond ago', DAY + 1, 0],
    ] as const)('counts an attempt made %s only while it is within the last 24 hours (the alert is raised %i time(s))', async (_label, elapsed, raised) => {
      const ctx = setup({ policy: { dailyResearchBudget: 1 } })
      const [first, second] = await products(ctx, 2)
      await ctx.service.research(first!)
      ctx.advance(elapsed)

      expect(await ctx.service.research(second!)).toEqual({ kind: 'not-found' })

      // The alert's window is the day the attempt was made in, which is the next UTC day for these two.
      expect(ctx.alerts()).toHaveLength(raised)
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

      expect(result).toEqual({ kind: 'found', formulationId: expect.any(String), image: 'error' })
      expect((await ctx.repository.latestFormulation(productId))!.id).toBe((result as { formulationId: string }).formulationId)
      expect((await ctx.repository.findProductById(productId))!.imageKey).toBeNull()
    })
    describe('outcome reported on the found result', () => {
      const found = (image: StockImageOutcome) => ({ kind: 'found', formulationId: expect.any(String), image })

      it('reports stored when the image downloaded, the model said it shows the product, and it was put and recorded', async () => {
        const ctx = setup()
        const productId = await productFor(ctx)
        ctx.images.respondTo(IMAGE_URL, JPEG)
        ctx.analyst.imageShowsProductWith(() => true)
        withImage(ctx)

        expect(await ctx.service.research(productId)).toEqual(found('stored'))
      })

      it('reports already-has-image when the product already had an image, and looks nothing up', async () => {
        const ctx = setup()
        const productId = await productFor(ctx)
        ctx.images.respondTo(IMAGE_URL, JPEG)
        ctx.analyst.imageShowsProductWith(() => true)
        withImage(ctx)
        await ctx.service.research(productId)
        ctx.advance(FRESH_FOR_DAYS * DAY + 1)

        expect(await ctx.service.research(productId)).toEqual(found('already-has-image'))
        expect(ctx.images.pageLookups).toHaveLength(1)
      })

      it('reports checked-recently when an image was looked for within FRESH_FOR_DAYS, and looks nothing up', async () => {
        const ctx = setup()
        const productId = await productFor(ctx)
        await ctx.repository.markImageChecked(productId, new Date(T0.getTime() - FRESH_FOR_DAYS * DAY))
        withImage(ctx)

        expect(await ctx.service.research(productId)).toEqual(found('checked-recently'))
        expect(ctx.images.pageLookups).toHaveLength(0)
      })

      it('reports no-page-image when the source page gives no image url', async () => {
        const ctx = setup()
        const productId = await productFor(ctx)
        withImage(ctx, null)

        expect(await ctx.service.research(productId)).toEqual(found('no-page-image'))
      })

      it('reports download-failed when the image url gives nothing safe to download', async () => {
        const ctx = setup()
        const productId = await productFor(ctx)
        ctx.images.respondTo(IMAGE_URL, null)
        withImage(ctx)

        expect(await ctx.service.research(productId)).toEqual(found('download-failed'))
      })

      it('reports not-this-product when the model says the image does not show the product, and still marks it checked', async () => {
        const ctx = setup()
        const productId = await productFor(ctx)
        ctx.images.respondTo(IMAGE_URL, JPEG)
        ctx.analyst.imageShowsProductWith(() => false)
        withImage(ctx)

        expect(await ctx.service.research(productId)).toEqual(found('not-this-product'))
        expect(await ctx.repository.findProductById(productId)).toMatchObject({ imageKey: null, imageCheckedAt: T0 })
      })

      it('reports error, with the formulation stored, when the import throws', async () => {
        const ctx = setup({ images: new PutThrows() })
        const productId = await productFor(ctx)
        ctx.images.respondTo(IMAGE_URL, JPEG)
        ctx.analyst.imageShowsProductWith(() => true)
        withImage(ctx)

        const result = await ctx.service.research(productId)

        expect(result).toEqual(found('error'))
        expect((await ctx.repository.latestFormulation(productId))!.id).toBe((result as { formulationId: string }).formulationId)
      })

      it('carries no image on the found result of a still-fresh formulation, where the researcher did not run', async () => {
        const ctx = setup()
        const productId = await productFor(ctx)
        ctx.images.respondTo(IMAGE_URL, JPEG)
        ctx.analyst.imageShowsProductWith(() => true)
        withImage(ctx)
        await ctx.service.research(productId)

        const again = await ctx.service.research(productId)

        expect(again).toEqual({ kind: 'found', formulationId: expect.any(String) })
        expect(again).not.toHaveProperty('image')
      })
    })

    describe('from ranked product pages', () => {
      const PAGE_1 = 'https://www.cerave.com/products/hydrating-cleanser-1'
      const PAGE_2 = 'https://www.retailer-two.example/p/cerave-hydrating-cleanser'
      const PAGE_3 = 'https://www.retailer-three.example/p/cerave-hydrating-cleanser'
      const PAGE_4 = 'https://www.retailer-four.example/p/cerave-hydrating-cleanser'
      /** The image a page names; the number is also the first byte of the image, so the analyst can tell them apart. */
      const imageUrlOf = (n: number) => `https://images.example/${n}.jpg`
      const imageOf = (n: number): ProductImage => ({ bytes: new Uint8Array([n]), mediaType: 'image/jpeg' })
      /** The page names image number `n` and that image downloads. */
      const pageShows = (ctx: Ctx, page: string, n: number) => {
        ctx.images.respondToPage(page, imageUrlOf(n))
        ctx.images.respondTo(imageUrlOf(n), imageOf(n))
      }
      /** The page names image number `n`, but the image does not download. */
      const pageShowsUndownloadable = (ctx: Ctx, page: string, n: number) => {
        ctx.images.respondToPage(page, imageUrlOf(n))
        ctx.images.respondTo(imageUrlOf(n), null)
      }
      /** The Haiku check accepts exactly the images whose number is in `accepted`. */
      const accepting = (ctx: Ctx, ...accepted: number[]) =>
        ctx.analyst.imageShowsProductWith((image) => accepted.includes(image.bytes[0]!))
      const checkedNumbers = (ctx: Ctx) => ctx.analyst.calls.imageShowsProduct.map(([image]) => image.bytes[0])

      const foundWith = (ctx: Ctx, imagePages?: string[], searchPages?: string[]) =>
        ctx.researcher.respondWith(() => ({
          found: true,
          ingredients: CLEAN,
          sourceUrl: SOURCE_URL,
          ...(imagePages ? { imagePages } : {}),
          ...(searchPages ? { searchPages } : {}),
        }))
      const notFoundWith = (ctx: Ctx, imagePages?: string[], searchPages?: string[]) =>
        ctx.researcher.respondWith(() => ({ found: false, ...(imagePages ? { imagePages } : {}), ...(searchPages ? { searchPages } : {}) }))

      /**
       * The product is CeraVe Hydrating Facial Cleanser, so "hydrating" is the one name word that is neither the brand nor generic: a
       * search page earns its place only with it in the path. Each page has its own host, as only the best page of a host is kept.
       */
      const searchPage = (n: number) => `https://search-${n}.example/p/cerave-hydrating-cleanser`
      const namedPage = (n: number) => `https://named-${n}.example/p/cerave-hydrating-cleanser`

      describe('which pages are tried, and in what order', () => {
        it('tries the pages the researcher named in order, then the page the ingredients came from', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [PAGE_1, PAGE_2, PAGE_3])

          await ctx.service.research(productId)

          expect(ctx.images.pageLookups).toEqual([PAGE_1, PAGE_2, PAGE_3, SOURCE_URL])
        })

        it('tries the page of the ingredients when the researcher named no pages', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx)

          await ctx.service.research(productId)

          expect(ctx.images.pageLookups).toEqual([SOURCE_URL])
        })

        it('looks at a page once when the ingredient page is also one of the named pages, or a named page repeats', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [SOURCE_URL, PAGE_1, PAGE_1])

          await ctx.service.research(productId)

          expect(ctx.images.pageLookups).toEqual([SOURCE_URL, PAGE_1])
        })

        it('tries at most 10 pages, so the ingredient page is dropped when 10 named pages come first', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          const named = Array.from({ length: 10 }, (_, i) => namedPage(i + 1))
          foundWith(ctx, named)

          await ctx.service.research(productId)

          expect(ctx.images.pageLookups).toEqual(named)
        })

        it('counts the 10 pages after removing duplicates, so a repeat does not use up a place', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          const named = Array.from({ length: 10 }, (_, i) => namedPage(i + 1))
          foundWith(ctx, [named[0]!, ...named])

          await ctx.service.research(productId)

          expect(ctx.images.pageLookups).toEqual(named)
        })

        it('tries the named pages, then the ingredient page, then the search pages that name the product, best match first', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          const weak = 'https://weak.example/hydrating'
          const strong = 'https://strong.example/p/cerave-hydrating-facial-cleanser'
          foundWith(ctx, [PAGE_1], [weak, strong])

          await ctx.service.research(productId)

          expect(ctx.images.pageLookups).toEqual([PAGE_1, SOURCE_URL, strong, weak])
        })

        it('looks at a page once when a search page repeats a named page, the ingredient page or another search page', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [PAGE_1], [SOURCE_URL, PAGE_1, searchPage(1), searchPage(1)])

          await ctx.service.research(productId)

          expect(ctx.images.pageLookups).toEqual([PAGE_1, SOURCE_URL, searchPage(1)])
        })

        it('counts the 10 pages over the whole list, named pages and ingredient page first, so the lowest ranked search pages are dropped', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          const named = [namedPage(1), namedPage(2), namedPage(3)]
          const search = Array.from({ length: 12 }, (_, i) => searchPage(i + 1))
          foundWith(ctx, named, search)

          await ctx.service.research(productId)

          expect(ctx.images.pageLookups).toEqual([...named, SOURCE_URL, ...search.slice(0, 6)])
        })

        it('never looks at a search page whose path names nothing of the product beyond its brand and generic words', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, undefined, ['https://shop.example/brands/cerave', 'https://shop.example/facial-cleanser', 'https://shop.example/nivea-soft-cream'])

          await ctx.service.research(productId)

          expect(ctx.images.pageLookups).toEqual([SOURCE_URL])
        })

        it('tries a search page for the image when the named pages and the ingredient page give none', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [PAGE_1], [searchPage(1)])
          pageShows(ctx, searchPage(1), 5)
          accepting(ctx, 5)

          const result = await ctx.service.research(productId)

          expect(result).toMatchObject({ kind: 'found', image: 'stored' })
          expect((await ctx.repository.findProductById(productId))?.imageSourceUrl).toBe(imageUrlOf(5))
        })

        it('stops at the first page whose image is accepted, and does not look at the pages after it', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [PAGE_1, PAGE_2, PAGE_3])
          pageShows(ctx, PAGE_1, 1)
          pageShows(ctx, PAGE_2, 2)
          accepting(ctx, 1, 2)

          const result = await ctx.service.research(productId)

          expect(result).toEqual({ kind: 'found', formulationId: expect.any(String), image: 'stored' })
          expect(ctx.images.pageLookups).toEqual([PAGE_1])
          expect(checkedNumbers(ctx)).toEqual([1])
        })

        it('uses the ingredient page for the image when the named pages give none', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [PAGE_1, PAGE_2])
          pageShows(ctx, SOURCE_URL, 9)
          accepting(ctx, 9)

          const result = await ctx.service.research(productId)

          expect(result).toMatchObject({ kind: 'found', image: 'stored' })
          expect((await ctx.repository.findProductById(productId))?.imageSourceUrl).toBe(imageUrlOf(9))
        })
      })

      describe('which images are checked', () => {
        it('goes on to the next page when the image of one is not this product, and stores the first image that is accepted', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [PAGE_1, PAGE_2])
          pageShows(ctx, PAGE_1, 1)
          pageShows(ctx, PAGE_2, 2)
          accepting(ctx, 2)

          const result = await ctx.service.research(productId)

          const key = `${IMAGE_KEY_PREFIX}/products/${productId}.jpg`
          expect(result).toEqual({ kind: 'found', formulationId: expect.any(String), image: 'stored' })
          expect(ctx.images.stored.get(key)).toEqual(imageOf(2))
          expect(ctx.images.stored.size).toBe(1)
          expect(await ctx.repository.findProductById(productId)).toMatchObject({ imageKey: key, imageSourceUrl: imageUrlOf(2), imageCheckedAt: T0 })
        })

        it('goes on to the next page when the image of one does not download', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [PAGE_1, PAGE_2])
          pageShowsUndownloadable(ctx, PAGE_1, 1)
          pageShows(ctx, PAGE_2, 2)
          accepting(ctx, 2)

          const result = await ctx.service.research(productId)

          expect(result).toMatchObject({ kind: 'found', image: 'stored' })
          expect((await ctx.repository.findProductById(productId))?.imageSourceUrl).toBe(imageUrlOf(2))
        })

        it('runs at most 3 image checks, so a fourth image that would have been accepted is never stored', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [PAGE_1, PAGE_2, PAGE_3, PAGE_4])
          pageShows(ctx, PAGE_1, 1)
          pageShows(ctx, PAGE_2, 2)
          pageShows(ctx, PAGE_3, 3)
          pageShows(ctx, PAGE_4, 4)
          accepting(ctx, 4)

          const result = await ctx.service.research(productId)

          expect(result).toEqual({ kind: 'found', formulationId: expect.any(String), image: 'not-this-product' })
          expect(checkedNumbers(ctx)).toEqual([1, 2, 3])
          // With no check left, the fourth page is not even fetched.
          expect(ctx.images.pageLookups).not.toContain(PAGE_4)
          expect(ctx.images.stored.size).toBe(0)
          expect(await ctx.repository.findProductById(productId)).toMatchObject({ imageKey: null, imageCheckedAt: T0 })
        })

        it('does not count an image that failed to download as a check', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [PAGE_1, PAGE_2, PAGE_3])
          pageShowsUndownloadable(ctx, PAGE_1, 1)
          pageShows(ctx, PAGE_2, 2)
          pageShows(ctx, PAGE_3, 3)
          accepting(ctx, 3)

          const result = await ctx.service.research(productId)

          expect(result).toMatchObject({ kind: 'found', image: 'stored' })
          expect(checkedNumbers(ctx)).toEqual([2, 3])
        })

        it('does not count a page with no image as a check', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [PAGE_1, PAGE_2, PAGE_3])
          pageShows(ctx, PAGE_2, 2)
          pageShows(ctx, PAGE_3, 3)
          accepting(ctx, 3)

          expect(await ctx.service.research(productId)).toMatchObject({ kind: 'found', image: 'stored' })
          expect(checkedNumbers(ctx)).toEqual([2, 3])
        })

        it('downloads and checks an image once when two pages name the same image url', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [PAGE_1, PAGE_2, PAGE_3])
          pageShows(ctx, PAGE_1, 1)
          ctx.images.respondToPage(PAGE_2, imageUrlOf(1))
          pageShows(ctx, PAGE_3, 3)
          accepting(ctx, 3)

          const result = await ctx.service.research(productId)

          expect(result).toMatchObject({ kind: 'found', image: 'stored' })
          expect(ctx.images.fetched).toEqual([imageUrlOf(1), imageUrlOf(3)])
          expect(checkedNumbers(ctx)).toEqual([1, 3])
        })
      })

      describe('when no image is stored', () => {
        it.each([
          ['no page names an image', [], 'no-page-image'],
          ['one image does not download and no other page names an image', ['download-failed'], 'download-failed'],
          ['an image does not download and a later page names none', ['download-failed', 'no-page-image'], 'download-failed'],
          ['a page names none and a later image does not download', ['no-page-image', 'download-failed'], 'download-failed'],
          ['an image is rejected and later pages fail earlier stages', ['not-this-product', 'download-failed', 'no-page-image'], 'not-this-product'],
          ['an image is rejected after pages that failed earlier stages', ['no-page-image', 'download-failed', 'not-this-product'], 'not-this-product'],
        ] as const)('reports the furthest stage reached across the pages when %s', async (_label, stages, expected) => {
          const ctx = setup()
          const productId = await productFor(ctx)
          const pages = [PAGE_1, PAGE_2, PAGE_3]
          foundWith(ctx, pages.slice(0, stages.length))
          stages.forEach((stage, index) => {
            const page = pages[index]!
            if (stage === 'download-failed') pageShowsUndownloadable(ctx, page, index + 1)
            if (stage === 'not-this-product') pageShows(ctx, page, index + 1)
          })
          accepting(ctx)

          const result = await ctx.service.research(productId)

          expect(result).toEqual({ kind: 'found', formulationId: expect.any(String), image: expected })
          expect(await ctx.repository.findProductById(productId)).toMatchObject({ imageKey: null, imageSourceUrl: null, imageCheckedAt: T0 })
          expect(ctx.images.stored.size).toBe(0)
        })
      })

      describe('when the product is already settled', () => {
        it('looks at no page and reports already-has-image for a product that has an image, whatever pages are named', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          await ctx.repository.setProductImage(productId, { key: `${IMAGE_KEY_PREFIX}/products/${productId}.jpg`, sourceUrl: imageUrlOf(7), checkedAt: T0 })
          foundWith(ctx, [PAGE_1])
          pageShows(ctx, PAGE_1, 1)
          accepting(ctx, 1)

          const result = await ctx.service.research(productId)

          expect(result).toEqual({ kind: 'found', formulationId: expect.any(String), image: 'already-has-image' })
          expect(ctx.images.pageLookups).toHaveLength(0)
        })

        it('looks at no page and reports checked-recently while an image check is still fresh, whatever pages are named', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          await ctx.repository.markImageChecked(productId, new Date(T0.getTime() - FRESH_FOR_DAYS * DAY))
          foundWith(ctx, [PAGE_1])
          pageShows(ctx, PAGE_1, 1)
          accepting(ctx, 1)

          const result = await ctx.service.research(productId)

          expect(result).toEqual({ kind: 'found', formulationId: expect.any(String), image: 'checked-recently' })
          expect(ctx.images.pageLookups).toHaveLength(0)
        })
      })

      describe('when the image import fails', () => {
        it('reports error and still returns the stored ingredients when the model check throws on a named page', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          foundWith(ctx, [PAGE_1, PAGE_2])
          pageShows(ctx, PAGE_1, 1)
          ctx.analyst.failNextWith(new Error('model down'))
          const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

          const result = await ctx.service.research(productId)

          expect(result).toEqual({ kind: 'found', formulationId: expect.any(String), image: 'error' })
          expect((await ctx.repository.latestFormulation(productId))!.id).toBe((result as { formulationId: string }).formulationId)
          expect(JSON.stringify(logged.mock.calls)).not.toContain(PAGE_1)
          expect(JSON.stringify(logged.mock.calls)).not.toContain(imageUrlOf(1))
          logged.mockRestore()
        })
      })

      describe('when the researcher found no ingredient list', () => {
        it('attempts the image from the named pages, reports it on the not-found result, and still records the attempt as not found', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          notFoundWith(ctx, [PAGE_1, PAGE_2])
          pageShows(ctx, PAGE_2, 2)
          accepting(ctx, 2)

          const result = await ctx.service.research(productId)

          const key = `${IMAGE_KEY_PREFIX}/products/${productId}.jpg`
          expect(result).toEqual({ kind: 'not-found', image: 'stored' })
          expect(ctx.images.pageLookups).toEqual([PAGE_1, PAGE_2])
          expect(await ctx.repository.findProductById(productId)).toMatchObject({ imageKey: key, imageSourceUrl: imageUrlOf(2) })
          expect(await ctx.repository.lastResearchOutcome(productId)).toEqual({ outcome: 'not-found', attemptedAt: T0 })
          expect(await ctx.repository.latestFormulation(productId)).toBeNull()
        })

        it('reports the furthest stage on the not-found result when no named page gives an accepted image, and marks the image checked', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          notFoundWith(ctx, [PAGE_1, PAGE_2])
          pageShows(ctx, PAGE_1, 1)
          accepting(ctx)

          const result = await ctx.service.research(productId)

          expect(result).toEqual({ kind: 'not-found', image: 'not-this-product' })
          expect(await ctx.repository.findProductById(productId)).toMatchObject({ imageKey: null, imageCheckedAt: T0 })
        })

        it('attempts the image from the search pages alone, when the researcher named no pages of its own', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          notFoundWith(ctx, undefined, [searchPage(1)])
          pageShows(ctx, searchPage(1), 3)
          accepting(ctx, 3)

          const result = await ctx.service.research(productId)

          expect(result).toEqual({ kind: 'not-found', image: 'stored' })
          expect(ctx.images.pageLookups).toEqual([searchPage(1)])
          expect(await ctx.repository.findProductById(productId)).toMatchObject({ imageSourceUrl: imageUrlOf(3) })
          expect(await ctx.repository.lastResearchOutcome(productId)).toEqual({ outcome: 'not-found', attemptedAt: T0 })
        })

        it('tries the named pages and then the ranked search pages on a not-found result', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          notFoundWith(ctx, [PAGE_1], [searchPage(2), searchPage(1)])

          await ctx.service.research(productId)

          expect(ctx.images.pageLookups).toEqual([PAGE_1, searchPage(2), searchPage(1)])
        })

        it('looks at no search page on a not-found result when none of them names the product', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          notFoundWith(ctx, undefined, ['https://shop.example/brands/cerave', 'https://shop.example/nivea-soft-cream'])

          await ctx.service.research(productId)

          expect(ctx.images.pageLookups).toEqual([])
          expect(ctx.images.fetched).toEqual([])
        })

        it('attempts the image from the search pages when the ingredient list was rejected for a link, trying no ingredient page', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          ctx.researcher.respondWith(() => ({ found: true, ingredients: ['Aqua', 'visit www.evil.example'], sourceUrl: SOURCE_URL, searchPages: [searchPage(1)] }))
          pageShows(ctx, searchPage(1), 1)
          accepting(ctx, 1)

          const result = await ctx.service.research(productId)

          expect(result).toEqual({ kind: 'not-found', image: 'stored' })
          expect(ctx.images.pageLookups).toEqual([searchPage(1)])
        })

        it('has no image on the not-found result, and looks at no page, when the researcher named none', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          notFoundWith(ctx)

          const result = await ctx.service.research(productId)

          expect(result).toEqual({ kind: 'not-found' })
          expect(result).not.toHaveProperty('image')
          expect(ctx.images.pageLookups).toHaveLength(0)
          expect((await ctx.repository.findProductById(productId))?.imageCheckedAt).toBeNull()
        })

        it('attempts the image from the named pages when the ingredient list was rejected for a link, trying no ingredient page', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          ctx.researcher.respondWith(() => ({ found: true, ingredients: ['Aqua', 'visit www.evil.example'], sourceUrl: SOURCE_URL, imagePages: [PAGE_1] }))
          pageShows(ctx, PAGE_1, 1)
          accepting(ctx, 1)

          const result = await ctx.service.research(productId)

          expect(result).toEqual({ kind: 'not-found', image: 'stored' })
          expect(ctx.images.pageLookups).toEqual([PAGE_1])
          expect(await ctx.repository.latestFormulation(productId)).toBeNull()
        })

        it('reports already-has-image on the not-found result for a product that has an image already, and looks at no page', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          await ctx.repository.setProductImage(productId, { key: `${IMAGE_KEY_PREFIX}/products/${productId}.jpg`, sourceUrl: imageUrlOf(7), checkedAt: T0 })
          notFoundWith(ctx, [PAGE_1])

          expect(await ctx.service.research(productId)).toEqual({ kind: 'not-found', image: 'already-has-image' })
          expect(ctx.images.pageLookups).toHaveLength(0)
        })

        it('reports error on the not-found result, and still records the attempt as not found, when the image import throws', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          notFoundWith(ctx, [PAGE_1])
          pageShows(ctx, PAGE_1, 1)
          ctx.analyst.failNextWith(new Error('model down'))
          const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

          const result = await ctx.service.research(productId)
          logged.mockRestore()

          expect(result).toEqual({ kind: 'not-found', image: 'error' })
          expect(await ctx.repository.lastResearchOutcome(productId)).toEqual({ outcome: 'not-found', attemptedAt: T0 })
        })

        it('does no image work when the not-found is the cached one from the last 7 days, whatever the researcher would now name', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          notFoundWith(ctx)
          await ctx.service.research(productId)
          ctx.advance(7 * DAY - 1)
          notFoundWith(ctx, [PAGE_1])
          pageShows(ctx, PAGE_1, 1)
          accepting(ctx, 1)

          const again = await ctx.service.research(productId)

          expect(again).toEqual({ kind: 'not-found' })
          expect(again).not.toHaveProperty('image')
          expect(ctx.researcher.calls).toHaveLength(1)
          expect(ctx.images.pageLookups).toHaveLength(0)
          expect(ctx.analyst.calls.imageShowsProduct).toHaveLength(0)
        })

        it('does not look for the image again on a later not-found research while the image check is still fresh', async () => {
          const ctx = setup()
          const productId = await productFor(ctx)
          notFoundWith(ctx, [PAGE_1])
          await ctx.service.research(productId)
          ctx.advance(7 * DAY + 1)

          // The first attempt marked the image checked, and 7 days is well inside FRESH_FOR_DAYS: no second look.
          expect(await ctx.service.research(productId)).toEqual({ kind: 'not-found', image: 'checked-recently' })
          expect(ctx.images.pageLookups).toEqual([PAGE_1])
        })
      })
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
        kind: 'named',
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
    const found = await ctx.service.research(productId)
    if (found.kind !== 'found') throw new Error('expected found')

    const summary = await ctx.service.productSummary(found.formulationId)

    expect(summary).toEqual({
      id: productId,
      kind: 'named',
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
    const { productId, formulationId } = await researched(ctx)

    expect(await ctx.service.productSummary(formulationId)).toMatchObject({ id: productId, variant: null, imageUrl: null })
  })

  it('says the product was not found for an unknown formulation id', async () => {
    const { service } = setup()

    const error = await errorOf(service.productSummary('no-such-formulation'))

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

    expect(a).toEqual({ kind: 'found', formulationId: expect.any(String), image: expect.any(String) })
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

      expect(await ctx.service.research(repository.watched)).toEqual({ kind: 'found', formulationId: expect.any(String), image: expect.any(String) })

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

    expect(await ctx.service.research(productId)).toEqual({ kind: 'found', formulationId: expect.any(String), image: expect.any(String) })
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

    expect(await ctx.service.research(productId)).toEqual({ kind: 'found', formulationId: expect.any(String), image: expect.any(String) })
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

      expect(result).toEqual({ kind: 'found', formulationId: expect.any(String), image: expect.any(String) })
      expect((await ctx.repository.latestFormulation(productId))!.ingredients).toEqual(['Aqua', ingredient, 'Glycerin'])
    },
  )
})

describe('ProductCatalogService.research of a stale product', () => {
  const STALE = FRESH_FOR_DAYS * DAY + 1

  it('offers its stale analysed formulation as a fallback when the new research finds nothing', async () => {
    const ctx = setup()
    const stale = await analysed(ctx)
    ctx.advance(STALE)
    ctx.researcher.respondWith(() => ({ found: false }))

    expect(await ctx.service.research(stale.productId)).toEqual({ kind: 'not-found', fallbackFormulationId: stale.formulationId })
  })

  it('researches a stale product past the daily budget, rather than offering its stale formulation as a refusal', async () => {
    const ctx = setup({ policy: { dailyResearchBudget: 1 } })
    const stale = await analysed(ctx)
    ctx.advance(STALE)
    // Another product's research this very day spends the budget of 1.
    ctx.researcher.respondWith(() => ({ found: false }))
    const other = await ctx.service.resolve(identity({ name: 'Foaming Cleanser' }))
    await ctx.service.research(other.productId)
    expect(ctx.alerts()).toEqual([])
    ctx.researcher.respondWith(() => ({ found: true, ingredients: [...CLEAN, 'Panthenol'], sourceUrl: SOURCE_URL }))
    const callsBefore = ctx.researcher.calls.length

    const result = await ctx.service.research(stale.productId)

    expect(result).toEqual({ kind: 'found', formulationId: expect.not.stringMatching(stale.formulationId), image: expect.any(String) })
    expect(ctx.researcher.calls).toHaveLength(callsBefore + 1)
    expect(ctx.alerts()).toHaveLength(1)
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
    // A soap, a lotion or an oil is read as skin care on one photo and body care on the next: the two are compatible, the judge decides.
    ['still asks about a skin candidate for a body label', identity({ brand: ACME, name: GLOW, category: 'skin' }), identity({ brand: ACME, name: GLOW_BOOSTER, category: 'body' }), 1],
    ['still asks about a body candidate for a skin label', identity({ brand: ACME, name: GLOW, category: 'body' }), identity({ brand: ACME, name: GLOW_BOOSTER, category: 'skin' }), 1],
    ['never asks about a hair candidate for a body label', identity({ brand: ACME, name: GLOW, category: 'hair' }), identity({ brand: ACME, name: GLOW_BOOSTER, category: 'body' }), 0],
    ['never asks about a makeup candidate for a skin label', identity({ brand: ACME, name: GLOW, category: 'makeup' }), identity({ brand: ACME, name: GLOW_BOOSTER, category: 'skin' }), 0],
    ['still asks when the variants differ in words but not in numbers, because the judge decides editions', identity({ brand: ACME, name: GLOW, variant: 'Night' }), identity({ brand: ACME, name: GLOW, variant: 'Day' }), 1],
    ['never asks about a candidate whose variant has a different number (SPF 30 against SPF 50)', identity({ brand: ACME, name: GLOW, variant: 'SPF 30' }), identity({ brand: ACME, name: GLOW, variant: 'SPF 50' }), 0],
    ['never asks about a candidate whose variant has a different percentage (2% against 5%)', identity({ brand: ACME, name: GLOW, variant: '2%' }), identity({ brand: ACME, name: GLOW, variant: '5%' }), 0],
    ['still asks when the variants carry the same number and differ in the other words', identity({ brand: ACME, name: GLOW, variant: 'SPF 30 Light' }), identity({ brand: ACME, name: GLOW, variant: 'SPF 30 Fragrance Free' }), 1],
    ['still asks when only one of the variants carries a number', identity({ brand: ACME, name: GLOW, variant: 'SPF 30' }), identity({ brand: ACME, name: GLOW, variant: 'Night' }), 1],
    ['still asks when the variants differ only in case and spacing', identity({ brand: ACME, name: GLOW, variant: 'Night Repair' }), identity({ brand: ACME, name: GLOW_BOOSTER, variant: 'night  repair' }), 1],
    // A row made when the scent went unread is not every scent of the line: "Body Wash" must not take in Shea Butter, then Cucumber.
    ['never asks about a candidate with no variant when the scanned label names one', identity({ brand: ACME, name: GLOW }), identity({ brand: ACME, name: GLOW_BOOSTER, variant: 'Night' }), 0],
    ['still asks when only the candidate has a variant, because the label may not have shown it', identity({ brand: ACME, name: GLOW, variant: 'Night' }), identity({ brand: ACME, name: GLOW_BOOSTER }), 1],
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

  it('asks the same-product judge, and a "no" makes a new product, when a spray is scanned and only a formless product exists', async () => {
    const ctx = setup()
    const formless = await ctx.service.resolve(nivea())
    ctx.analyst.sameProductWith(() => false)

    const result = await ctx.service.resolve(nivea('spray'))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.kind).toBe('needs-research')
    expect(result.productId).not.toBe(formless.productId)
  })

  it('asks the judge, and a "yes" lands on the spray, when a formless label is scanned and only a spray exists', async () => {
    const ctx = setup()
    const spray = await ctx.service.resolve(nivea('spray'))
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.resolve(nivea())

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).toBe(spray.productId)
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
    ['a conflicting variant number', { ...NIVEA_MEN, variant: 'SPF 30' }, { ...NIVEA_NAME, variant: 'SPF 50' }],
  ])('never asks the judge about a family member with %s, and makes a new product', async (_label, existingIdentity, scanned) => {
    const ctx = setup()
    const existing = await ctx.service.resolve(existingIdentity)
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.resolve(scanned)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
    expect(result.kind).toBe('needs-research')
    expect(result.productId).not.toBe(existing.productId)
  })

  it.each<[string, ProductIdentity, ProductIdentity]>([
    ['no form against a form', NIVEA_MEN, { ...NIVEA_NAME, form: undefined }],
    ['a differing variant without numbers', { ...NIVEA_MEN, variant: 'Fresh' }, { ...NIVEA_NAME, variant: 'Original' }],
  ])('asks the judge about a family member with %s, and a "yes" lands on it', async (_label, existingIdentity, scanned) => {
    const ctx = setup()
    const existing = await ctx.service.resolve(existingIdentity)
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.resolve(scanned)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).toBe(existing.productId)
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

    // Not a subset of any stored name (that would trip the ambiguity guard), but near all ten.
    const result = await ctx.service.resolve(identity({ brand: 'NIVEA', name: 'MEN DRY IMPACT Frost', category: 'body', form: 'spray' }))

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
    const ALERT = [{ kind: 'analysis-budget', windowStart: DAY_START.getTime() }]

    it('analyses every formulation, even past the budget, and raises analysis-budget when an attempt goes past it, not before', async () => {
      const ctx = setup({ policy: { dailyAnalysisBudget: 2 } })
      const first = await another(ctx, 0)
      const second = await another(ctx, 1)
      const third = await another(ctx, 2)
      ctx.analyst.analyseWith(() => [draft()])

      await ctx.service.analyse(first.formulationId)
      await ctx.service.analyse(second.formulationId)
      expect(ctx.alerts()).toEqual([])
      await expect(ctx.service.analyse(third.formulationId)).resolves.toBeUndefined()

      expect(ctx.analyst.calls.analyse).toHaveLength(3)
      expect((await ctx.service.productView(third.formulationId)).formulation.analysedAt).not.toBeNull()
      expect(ctx.alerts()).toEqual(ALERT)
    })

    it('never throws CatalogBusyError for the budget, however far past it the day goes', async () => {
      const ctx = setup({ policy: { dailyAnalysisBudget: 1 } })
      ctx.analyst.analyseWith(() => [draft()])

      for (let i = 0; i < 4; i++) await expect(ctx.service.analyse((await another(ctx, i)).formulationId)).resolves.toBeUndefined()
    })

    it('raises the alert once for the day, however many attempts go past the budget', async () => {
      const ctx = setup({ policy: { dailyAnalysisBudget: 1 } })
      ctx.analyst.analyseWith(() => [draft()])
      for (let i = 0; i < 4; i++) await ctx.service.analyse((await another(ctx, i)).formulationId)

      expect(ctx.alerts()).toEqual(ALERT)
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
      expect(ctx.alerts()).toEqual([])

      await ctx.service.analyse(second.formulationId).catch(() => undefined)

      expect(ctx.alerts()).toEqual(ALERT)
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
      expect(ctx.alerts()).toEqual([])
    })

    it.each([
      ['exactly 24 hours ago', DAY, 1],
      ['24 hours and a millisecond ago', DAY + 1, 0],
    ] as const)('counts an analysis made %s only while it is within the last 24 hours (the alert is raised %i time(s))', async (_label, elapsed, raised) => {
      const ctx = setup({ policy: { dailyAnalysisBudget: 1 } })
      const first = await another(ctx, 0)
      const second = await another(ctx, 1)
      ctx.analyst.analyseWith(() => [draft()])
      await ctx.service.analyse(first.formulationId)
      ctx.advance(elapsed)

      await expect(ctx.service.analyse(second.formulationId)).resolves.toBeUndefined()

      expect(ctx.alerts()).toHaveLength(raised)
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
    opsAlerts: new OpsAlertsService({
      repository: new FakeOpsAlertsRepository(),
      jobs: new MemoryJobQueue(),
      email: new MemoryEmailSender(),
      recipient: 'ops@example.com',
      environment: 'test',
      now: () => clock,
    }),
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
      expect(await first).toEqual({ kind: 'found', formulationId: expect.any(String), image: expect.any(String) })
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

      await expect(ctx.service.research(other.productId)).resolves.toEqual({ kind: 'found', formulationId: expect.any(String), image: expect.any(String) })

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
        await expect(attempt).resolves.toEqual({ kind: 'found', formulationId: expect.any(String), image: expect.any(String) })
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

      await expect(ctx.service.research(productId)).resolves.toEqual({ kind: 'found', formulationId: expect.any(String), image: expect.any(String) })
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

// The identity key of the product that holds a list nobody named: "unnamed:" and the list's ingredients key (lower case, one per line).
const CLEAN_UNNAMED_KEY = 'unnamed:aqua\nglycerin\ncetearyl alcohol'
const MERCURY_UNNAMED_KEY = 'unnamed:aqua\nmercury\nglycerin'

describe('ProductCatalogService.resolve: the kind of a product', () => {
  it('creates a product from a label as a named one', async () => {
    const { service, repository } = setup()

    await service.resolve(identity())

    expect(await repository.findProductByKey(identityKey(identity()))).toMatchObject({ kind: 'named' })
  })
})

describe('ProductCatalogService.fromLabel: an ingredient list with no name', () => {
  it('creates an unnamed product keyed by the list, with no brand, name or variant and the category other, and stores the list as a label formulation', async () => {
    const ctx = setup()

    const result = await ctx.service.fromLabel({ ingredients: CLEAN })

    expect(result).toMatchObject({ productId: expect.any(String), formulationId: expect.any(String) })
    expect(await ctx.repository.findProductByKey(CLEAN_UNNAMED_KEY)).toMatchObject({
      id: result.productId,
      kind: 'unnamed',
      brand: '',
      name: '',
      variant: null,
      category: 'other',
      createdAt: T0,
    })
    expect(await ctx.repository.findFormulation(result.formulationId)).toMatchObject({
      productId: result.productId,
      ingredients: CLEAN,
      sourceKind: 'label',
      sourceUrl: null,
      foundAt: T0,
      analysisVersion: null,
    })
  })

  it('takes the category from the label when it printed one', async () => {
    const ctx = setup()

    const result = await ctx.service.fromLabel({ ingredients: CLEAN, category: 'hair' })

    expect(await ctx.repository.findProductById(result.productId)).toMatchObject({ kind: 'unnamed', category: 'hair', brand: '', name: '' })
  })

  it.each([
    ['a brand alone', { brand: 'Glow Co' }],
    ['a name alone', { name: 'Bright Tone Serum' }],
    ['a variant alone', { variant: 'Night' }],
    ['a brand and a variant', { brand: 'Glow Co', variant: 'Night' }],
  ] as const)('treats %s as no name at all: the product is unnamed, with empty brand and name', async (_label, partial) => {
    const ctx = setup()

    const result = await ctx.service.fromLabel({ ingredients: CLEAN, ...partial })

    expect(await ctx.repository.findProductById(result.productId)).toMatchObject({ kind: 'unnamed', brand: '', name: '', variant: null })
    expect(await ctx.repository.findProductByKey(CLEAN_UNNAMED_KEY)).toMatchObject({ id: result.productId })
  })

  it('gives the same product and formulation to the same list again, whoever it comes from, creating nothing new', async () => {
    const ctx = setup()
    const first = await ctx.service.fromLabel({ ingredients: CLEAN })
    ctx.advance(HOUR)

    const again = await ctx.service.fromLabel({ ingredients: CLEAN })

    expect(again).toMatchObject({ productId: first.productId, formulationId: first.formulationId })
  })

  it('reads a list written another way as the same list: case, spacing and a trailing footnote mark do not matter', async () => {
    const ctx = setup()
    const first = await ctx.service.fromLabel({ ingredients: CLEAN })

    const again = await ctx.service.fromLabel({ ingredients: ['AQUA', '  Glycerin* ', 'cetearyl   alcohol'] })

    expect(again).toMatchObject({ productId: first.productId, formulationId: first.formulationId })
  })

  it('treats a list in another order, or with an ingredient more, as a different list with its own product and formulation', async () => {
    const ctx = setup()
    const first = await ctx.service.fromLabel({ ingredients: CLEAN })

    const reordered = await ctx.service.fromLabel({ ingredients: ['Glycerin', 'Aqua', 'Cetearyl Alcohol'] })
    const longer = await ctx.service.fromLabel({ ingredients: [...CLEAN, 'Phenoxyethanol'] })

    for (const other of [reordered, longer]) {
      expect(other.productId).not.toBe(first.productId)
      expect(other.formulationId).not.toBe(first.formulationId)
    }
    expect(reordered.productId).not.toBe(longer.productId)
  })

  it('ends with one product and one formulation when two scans of the same list arrive at once', async () => {
    const ctx = setup()

    const [a, b] = await Promise.all([ctx.service.fromLabel({ ingredients: CLEAN }), ctx.service.fromLabel({ ingredients: CLEAN })])

    expect(a).toMatchObject({ productId: b.productId, formulationId: b.formulationId })
    expect(await ctx.repository.findProductByKey(CLEAN_UNNAMED_KEY)).toMatchObject({ id: a.productId })
  })

  it('analyses the list once: the same list from another scan finds it analysed, and analysing it again calls nothing', async () => {
    const ctx = setup()
    const first = await ctx.service.fromLabel({ ingredients: CLEAN })
    await ctx.service.analyse(first.formulationId)

    const second = await ctx.service.fromLabel({ ingredients: CLEAN })
    await ctx.service.analyse(second.formulationId)

    expect(second.formulationId).toBe(first.formulationId)
    expect(ctx.analyst.calls.analyse).toHaveLength(1)
    expect((await ctx.service.productView(second.formulationId)).formulation.analysedAt).toEqual(T0)
  })

  it('never researches or asks whether two products are the same: no model is called to store a list', async () => {
    const ctx = setup()

    await ctx.service.fromLabel({ ingredients: CLEAN })
    await ctx.service.fromLabel({ ingredients: WITH_MERCURY, category: 'skin' })

    expect(ctx.researcher.calls).toEqual([])
    expect(ctx.analyst.calls.sameProduct).toEqual([])
    expect(ctx.analyst.calls.analyse).toEqual([])
  })

  const entries = (count: number) => Array.from({ length: count }, (_, i) => `Ingredient ${i}`)

  it.each([
    ['150 entries', entries(150)],
    ['an entry of 120 characters', ['Aqua', 'a'.repeat(120)]],
    ['an entry of 120 characters once trimmed', ['Aqua', `  ${'a'.repeat(120)}  `]],
  ])('accepts %s', async (_label, ingredients) => {
    const ctx = setup()

    await expect(ctx.service.fromLabel({ ingredients })).resolves.toMatchObject({ productId: expect.any(String), formulationId: expect.any(String) })
  })

  it.each([
    ['an empty list', []],
    ['151 entries', entries(151)],
    ['an entry of 121 characters', ['Aqua', 'a'.repeat(121)]],
    ['an entry of 121 characters once trimmed', ['Aqua', `  ${'a'.repeat(121)}  `]],
    ['a blank entry', ['Aqua', '   ', 'Glycerin']],
    ['an entry with a link', ['Aqua', 'see http://evil.example']],
    ['an entry with markup', ['Aqua', '<script>evil()</script>']],
    ['an entry with a control character', ['Aqua', 'Glyc\u0007erin']],
  ])('rejects %s as an unreadable label, and creates no product and no formulation', async (_label, ingredients) => {
    const ctx = setup()

    const error = await errorOf(ctx.service.fromLabel({ ingredients }))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe('LABEL_UNREADABLE')
    expect(await ctx.repository.findProductByKey(`unnamed:${ingredients.map((i) => i.trim().toLowerCase()).join('\n')}`)).toBeNull()
  })
})

describe('ProductCatalogService.fromLabel: an ingredient list with a brand and name', () => {
  const GLOW = identity({ brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' })

  it('creates the named product the label names and stores the list as its label formulation, without researching it', async () => {
    const ctx = setup()

    const result = await ctx.service.fromLabel({ ingredients: CLEAN, brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Night', category: 'skin' })

    const product = await ctx.repository.findProductByKey('glow co|bright tone serum|night|')
    expect(product).toMatchObject({ id: result.productId, kind: 'named', brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Night', category: 'skin', createdAt: T0 })
    expect(await ctx.repository.findFormulation(result.formulationId)).toMatchObject({
      productId: result.productId,
      ingredients: CLEAN,
      sourceKind: 'label',
      sourceUrl: null,
      foundAt: T0,
    })
    expect(ctx.researcher.calls).toEqual([])
  })

  it('files a product whose label printed no category under other', async () => {
    const ctx = setup()

    const result = await ctx.service.fromLabel({ ingredients: CLEAN, brand: 'Glow Co', name: 'Bright Tone Serum' })

    expect(await ctx.repository.findProductById(result.productId)).toMatchObject({ kind: 'named', category: 'other', variant: null })
  })

  it('does not make an unnamed product as well', async () => {
    const ctx = setup()

    await ctx.service.fromLabel({ ingredients: CLEAN, brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' })

    expect(await ctx.repository.findProductByKey(CLEAN_UNNAMED_KEY)).toBeNull()
  })

  it('leaves the new product ready for analysis, as a researched one would be: resolving it later says needs-analysis, then ready once analysed', async () => {
    const ctx = setup()
    const result = await ctx.service.fromLabel({ ingredients: CLEAN, brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' })

    expect(await ctx.service.resolve(GLOW)).toEqual({ kind: 'needs-analysis', productId: result.productId, formulationId: result.formulationId })

    await ctx.service.analyse(result.formulationId)

    expect(await ctx.service.resolve(GLOW)).toEqual({ kind: 'ready', productId: result.productId, formulationId: result.formulationId })
    expect(ctx.researcher.calls).toEqual([])
  })

  it('finds a product the catalog already holds, however the label spells it, and reuses its identical list without calling the researcher again', async () => {
    const ctx = setup()
    const known = await analysed(ctx)
    const researches = ctx.researcher.calls.length

    const result = await ctx.service.fromLabel({ ingredients: CLEAN, brand: 'CERAVE', name: 'hydrating  facial cleanser 236 ml', category: 'skin' })

    expect(result).toMatchObject({ productId: known.productId, formulationId: known.formulationId })
    expect(ctx.researcher.calls).toHaveLength(researches)
    expect(ctx.analyst.calls.sameProduct).toEqual([])
  })

  it('stores a materially different list for a known product as a new label formulation, leaving the researched one as it was', async () => {
    const ctx = setup()
    const known = await analysed(ctx)

    const result = await ctx.service.fromLabel({ ingredients: [...CLEAN, 'Phenoxyethanol'], brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' })

    expect(result.productId).toBe(known.productId)
    expect(result.formulationId).not.toBe(known.formulationId)
    expect(await ctx.repository.findFormulation(result.formulationId)).toMatchObject({ productId: known.productId, sourceKind: 'label', analysisVersion: null })
    expect(await ctx.repository.findFormulation(known.formulationId)).toMatchObject({ sourceKind: 'web', analysisVersion: ANALYSIS_VERSION })
  })

  it('gives a different variant its own product', async () => {
    const ctx = setup()
    const day = await ctx.service.fromLabel({ ingredients: CLEAN, brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Day', category: 'skin' })

    const night = await ctx.service.fromLabel({ ingredients: CLEAN, brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Night', category: 'skin' })

    expect(night.productId).not.toBe(day.productId)
  })

  describe('a name that nearly matches one the catalog holds', () => {
    const KNOWN = identity({ brand: 'Acme', name: 'Radiance Serum Vitamin Glow' })
    const LABEL = { ingredients: CLEAN, brand: 'Acme', name: 'Radiance Serum Vitamin Glow Booster', category: 'skin' } as const

    it('asks the model whether it is the same product, and uses the product it says it is, remembering the spelling', async () => {
      const ctx = setup()
      const known = await ctx.service.resolve(KNOWN)
      ctx.analyst.sameProductWith(() => true)

      // The same words in another order: equal specificity, so the spelling is remembered (a longer label would not be).
      const reordered = { ...LABEL, name: 'Vitamin Glow Radiance Serum' }
      const first = await ctx.service.fromLabel(reordered)
      const second = await ctx.service.fromLabel(reordered)

      expect(first.productId).toBe(known.productId)
      expect(second.productId).toBe(known.productId)
      expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
      expect(ctx.researcher.calls).toEqual([])
      expect(await ctx.repository.findFormulation(first.formulationId)).toMatchObject({ productId: known.productId, sourceKind: 'label' })
    })

    it('creates a new product when the model says it is a different one', async () => {
      const ctx = setup()
      const known = await ctx.service.resolve(KNOWN)

      const result = await ctx.service.fromLabel(LABEL)

      expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
      expect(result.productId).not.toBe(known.productId)
      expect(await ctx.repository.findProductById(result.productId)).toMatchObject({ kind: 'named', name: 'Radiance Serum Vitamin Glow Booster' })
    })

    it('throws CatalogBusyError, creating no product and storing no list, when the AI spend cap stops the question', async () => {
      const ctx = setup()
      await ctx.service.resolve(KNOWN)
      ctx.analyst.failNextWith(new AiBudgetExceededError('cap'))

      const error = await errorOf(ctx.service.fromLabel(LABEL))

      expect(error).toBeInstanceOf(CatalogBusyError)
      expect(await ctx.repository.findProductByKey(identityKey(LABEL))).toBeNull()
    })
  })

  it.each([
    ['an empty list', []],
    ['an entry with a link', ['Aqua', 'see http://evil.example']],
    ['an entry of 121 characters', ['Aqua', 'a'.repeat(121)]],
  ])('rejects %s as an unreadable label before it creates the product the label names', async (_label, ingredients) => {
    const ctx = setup()

    const error = await errorOf(ctx.service.fromLabel({ ingredients, brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' }))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe('LABEL_UNREADABLE')
    expect(await ctx.repository.findProductByKey(identityKey(GLOW))).toBeNull()
  })
})

describe('ProductCatalogService.fromLabel: a product identified after its list was stored without a name', () => {
  const LABEL = { brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' } as const

  /** An unnamed product whose list is analysed, with one concern. */
  const analysedUnnamed = async (ctx: Ctx) => {
    const unnamed = await ctx.service.fromLabel({ ingredients: WITH_MERCURY })
    ctx.analyst.analyseWith(() => [draft()])
    await ctx.service.analyse(unnamed.formulationId)
    ctx.advance(HOUR)
    return unnamed
  }

  it('moves the unnamed formulation, with its analysis and concerns, to the named product, keeping its id, and removes the unnamed product', async () => {
    const ctx = setup()
    const unnamed = await analysedUnnamed(ctx)

    const result = await ctx.service.fromLabel({ ingredients: WITH_MERCURY, ...LABEL })

    expect(result.formulationId).toBe(unnamed.formulationId)
    expect(result.productId).not.toBe(unnamed.productId)
    expect(await ctx.repository.findFormulation(unnamed.formulationId)).toMatchObject({ productId: result.productId, analysisVersion: ANALYSIS_VERSION })
    expect(await ctx.repository.findProductById(unnamed.productId)).toBeNull()
    expect(await ctx.repository.findProductByKey(MERCURY_UNNAMED_KEY)).toBeNull()
  })

  it('shows the moved formulation as the named product\'s, with its concerns, to an item that already pointed at it', async () => {
    const ctx = setup()
    const unnamed = await analysedUnnamed(ctx)
    const before = await ctx.service.productView(unnamed.formulationId)
    expect(before.product).toMatchObject({ kind: 'unnamed', brand: '', name: '' })

    const result = await ctx.service.fromLabel({ ingredients: WITH_MERCURY, ...LABEL })

    const after = await ctx.service.productView(unnamed.formulationId)
    expect(after.product).toMatchObject({ id: result.productId, kind: 'named', brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' })
    expect(after.concerns).toEqual(before.concerns)
    expect(after.concerns).toHaveLength(1)
    expect(after.formulation).toEqual(before.formulation)
  })

  it('does not pay for the analysis again: the named product resolves as ready, and the analyst was called once', async () => {
    const ctx = setup()
    const unnamed = await analysedUnnamed(ctx)

    const result = await ctx.service.fromLabel({ ingredients: WITH_MERCURY, ...LABEL })

    expect(await ctx.service.resolve(identity({ brand: 'Glow Co', name: 'Bright Tone Serum' }))).toEqual({
      kind: 'ready',
      productId: result.productId,
      formulationId: unnamed.formulationId,
    })
    expect(ctx.analyst.calls.analyse).toHaveLength(1)
    expect(ctx.researcher.calls).toEqual([])
  })

  it('moves an unnamed formulation onto a named product that already has other lists, which keep their own', async () => {
    const ctx = setup()
    const web = await analysed(ctx, { who: identity({ brand: 'Glow Co', name: 'Bright Tone Serum' }) })
    const unnamed = await analysedUnnamed(ctx)

    const result = await ctx.service.fromLabel({ ingredients: WITH_MERCURY, ...LABEL })

    expect(result.productId).toBe(web.productId)
    expect(result.formulationId).toBe(unnamed.formulationId)
    expect(await ctx.repository.findFormulation(web.formulationId)).toMatchObject({ productId: web.productId, sourceKind: 'web' })
    expect(await ctx.repository.findFormulation(unnamed.formulationId)).toMatchObject({ productId: web.productId, sourceKind: 'label' })
    expect(await ctx.repository.findProductById(unnamed.productId)).toBeNull()
  })

  it('uses the named product\'s existing formulation when it already has that exact list, and leaves the unnamed formulation viewable for anyone still pointing at it', async () => {
    const ctx = setup()
    ctx.analyst.analyseWith(() => [draft()])
    const named = await analysed(ctx, { who: identity({ brand: 'Glow Co', name: 'Bright Tone Serum' }), ingredients: WITH_MERCURY })
    const unnamed = await analysedUnnamed(ctx)
    expect(unnamed.formulationId).not.toBe(named.formulationId)

    const result = await ctx.service.fromLabel({ ingredients: WITH_MERCURY, ...LABEL })

    expect(result).toMatchObject({ productId: named.productId, formulationId: named.formulationId })
    expect((await ctx.service.productView(named.formulationId)).product).toMatchObject({ kind: 'named', id: named.productId })
    // An item that was shown the unnamed list keeps working: its formulation is not deleted from under it.
    expect((await ctx.service.productView(unnamed.formulationId)).formulation.id).toBe(unnamed.formulationId)
  })

  it('leaves an unnamed product with another list alone', async () => {
    const ctx = setup()
    const other = await ctx.service.fromLabel({ ingredients: CLEAN })
    await analysedUnnamed(ctx)

    await ctx.service.fromLabel({ ingredients: WITH_MERCURY, ...LABEL })

    expect(await ctx.repository.findProductByKey(CLEAN_UNNAMED_KEY)).toMatchObject({ id: other.productId, kind: 'unnamed' })
    expect(await ctx.repository.findFormulation(other.formulationId)).toMatchObject({ productId: other.productId })
  })

  it('moves an unnamed list that was never analysed too, leaving the named product needing analysis', async () => {
    const ctx = setup()
    const unnamed = await ctx.service.fromLabel({ ingredients: CLEAN })

    const result = await ctx.service.fromLabel({ ingredients: CLEAN, ...LABEL })

    expect(result.formulationId).toBe(unnamed.formulationId)
    expect(await ctx.service.resolve(identity({ brand: 'Glow Co', name: 'Bright Tone Serum' }))).toEqual({
      kind: 'needs-analysis',
      productId: result.productId,
      formulationId: unnamed.formulationId,
    })
  })
})

describe('ProductCatalogService.productView: the kind of the product', () => {
  it('says an unnamed product is unnamed, with empty brand and name, no variant, no image, and the concerns of its list', async () => {
    const ctx = setup()
    const { formulationId } = await ctx.service.fromLabel({ ingredients: WITH_MERCURY })
    ctx.analyst.analyseWith(() => [draft()])
    await ctx.service.analyse(formulationId)

    const view = await ctx.service.productView(formulationId)

    expect(view.product).toEqual({ id: expect.any(String), kind: 'unnamed', brand: '', name: '', variant: null, form: null, category: 'other', imageUrl: null })
    expect(view.formulation).toMatchObject({ id: formulationId, ingredients: WITH_MERCURY, source: { kind: 'label', url: null }, analysedAt: T0 })
    expect(view.concerns).toHaveLength(1)
    expect(view.concerns[0]).toMatchObject({ kind: 'banned-substance', severity: 'high', ingredients: ['Mercury'] })
  })

  it('says a product made from a label with a name is named', async () => {
    const ctx = setup()
    const { formulationId } = await ctx.service.fromLabel({ ingredients: CLEAN, brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' })

    expect((await ctx.service.productView(formulationId)).product).toMatchObject({ kind: 'named', brand: 'Glow Co', name: 'Bright Tone Serum' })
  })
})

describe('ProductCatalogService.fromLabel: an adoption another product wins', () => {
  /** A catalog repository in which a rival product adopts the formulation just before the one under test gets to. */
  class LosesTheRace extends FakeCatalogRepository {
    rival: string | undefined
    override async adoptUnnamedFormulation(formulationId: string, productId: string): Promise<void> {
      if (this.rival) {
        const rival = this.rival
        this.rival = undefined
        await super.adoptUnnamedFormulation(formulationId, rival)
      }
      return super.adoptUnnamedFormulation(formulationId, productId)
    }
  }

  it('never reports the other product\'s formulation as its own: it stores the list as a formulation of its product and leaves the winner\'s alone', async () => {
    const repository = new LosesTheRace()
    const ctx = setup({ repository })
    const unnamed = await ctx.service.fromLabel({ ingredients: WITH_MERCURY })
    repository.rival = (await ctx.service.resolve(identity({ brand: 'Rival Co', name: 'Other Serum' }))).productId

    const result = await ctx.service.fromLabel({ ingredients: WITH_MERCURY, brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' })

    expect(result.productId).not.toBe(repository.rival)
    expect(result.formulationId).not.toBe(unnamed.formulationId)
    expect(await repository.findFormulation(result.formulationId)).toMatchObject({ productId: result.productId, ingredients: WITH_MERCURY, sourceKind: 'label' })
    expect(await repository.findFormulation(unnamed.formulationId)).toMatchObject({ productId: expect.any(String) })
    expect((await repository.findFormulation(unnamed.formulationId))!.productId).not.toBe(result.productId)
    expect(ctx.researcher.calls).toEqual([])
  })
})

describe('ProductCatalogService.fromLabel: a named label that prints no category', () => {
  const ACME = 'Acme'
  const KNOWN = identity({ brand: ACME, name: 'Radiance Serum Vitamin Glow' })
  // Word overlap with the label's name (Jaccard): KNOWN 4/5 = 0.8, HAIR 3/5 = 0.6 (exactly the threshold).
  const LABEL = { ingredients: CLEAN, brand: ACME, name: 'Radiance Serum Vitamin Glow Booster' }
  const HAIR = identity({ brand: ACME, name: 'Radiance Serum Vitamin', category: 'hair' })

  it('reuses the product the label exactly matches by brand, name and variant, leaving its category as it was', async () => {
    const ctx = setup()
    const known = await ctx.service.resolve(identity({ variant: 'Night' }))

    const result = await ctx.service.fromLabel({ ingredients: CLEAN, brand: 'CERAVE', name: 'hydrating facial cleanser', variant: 'night' })

    expect(result.productId).toBe(known.productId)
    expect(await ctx.repository.findProductById(known.productId)).toMatchObject({ category: 'skin', kind: 'named' })
    expect(ctx.analyst.calls.sameProduct).toEqual([])
  })

  it('offers a near-miss name to the judge against a product of any category, and reuses the product when the judge says it is the same, writing no new one', async () => {
    const ctx = setup()
    const known = await ctx.service.resolve(KNOWN)
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.fromLabel(LABEL)

    expect(result.productId).toBe(known.productId)
    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(await ctx.repository.productsByBrandFamily('acme', 10)).toHaveLength(1)
    expect(await ctx.repository.findProductById(known.productId)).toMatchObject({ category: 'skin', name: 'Radiance Serum Vitamin Glow' })
    expect(await ctx.repository.findFormulation(result.formulationId)).toMatchObject({ productId: known.productId, sourceKind: 'label' })
    expect(ctx.researcher.calls).toEqual([])
  })

  it('remembers the spelling as an alias, so the same label is not put to the judge again', async () => {
    const ctx = setup()
    const known = await ctx.service.resolve(KNOWN)
    ctx.analyst.sameProductWith(() => true)
    const reordered = { ...LABEL, name: 'Vitamin Glow Radiance Serum' }
    await ctx.service.fromLabel(reordered)

    const again = await ctx.service.fromLabel(reordered)

    expect(again.productId).toBe(known.productId)
    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
  })

  it('asks the judge about near misses of every category, not just one, up to the usual limit', async () => {
    const ctx = setup()
    await ctx.service.resolve(KNOWN)
    await ctx.service.resolve(HAIR)

    await ctx.service.fromLabel(LABEL)

    expect(ctx.analyst.calls.sameProduct.map(([, candidate]) => candidate.name).sort()).toEqual(['Radiance Serum Vitamin', 'Radiance Serum Vitamin Glow'])
  })

  it('creates the product with the category other when the label matches no one and the judge says no', async () => {
    const ctx = setup()
    const known = await ctx.service.resolve(KNOWN)

    const result = await ctx.service.fromLabel(LABEL)

    expect(result.productId).not.toBe(known.productId)
    expect(await ctx.repository.findProductById(result.productId)).toMatchObject({ kind: 'named', category: 'other', name: 'Radiance Serum Vitamin Glow Booster' })
  })

  it('creates the product with the category other when nothing in the catalog is near its name, without asking the judge', async () => {
    const ctx = setup()
    await ctx.service.resolve(identity({ brand: ACME, name: 'Zinc Mask Clay' }))

    const result = await ctx.service.fromLabel(LABEL)

    expect(await ctx.repository.findProductById(result.productId)).toMatchObject({ category: 'other' })
    expect(ctx.analyst.calls.sameProduct).toEqual([])
  })

  it('still keeps products of another category apart when the label DOES print a category: no question to the judge, a new product', async () => {
    const ctx = setup()
    const known = await ctx.service.resolve(KNOWN)

    const result = await ctx.service.fromLabel({ ...LABEL, category: 'hair' })

    expect(ctx.analyst.calls.sameProduct).toEqual([])
    expect(result.productId).not.toBe(known.productId)
    expect(await ctx.repository.findProductById(result.productId)).toMatchObject({ category: 'hair' })
  })
})


describe('ProductCatalogService: the search text of a product', () => {
  const searchTextOf = async (ctx: Ctx, productId: string) => (await ctx.repository.findProductById(productId))!.searchText

  it('is the brand, name and variant, lower case, with accents and punctuation folded and "+" read as plus', async () => {
    const ctx = setup()

    const { productId } = await ctx.service.resolve(identity({ brand: "L'Oréal Paris", name: 'Revitalift Crème', variant: 'SPF 50+' }))

    expect(await searchTextOf(ctx, productId)).toBe('loreal paris revitalift creme spf 50 plus')
  })

  it('is just the brand and name, with no trailing space, when the product has no variant', async () => {
    const ctx = setup()

    const { productId } = await ctx.service.resolve(identity())

    expect(await searchTextOf(ctx, productId)).toBe('cerave hydrating facial cleanser')
  })

  it('reads "&" as "and" and drops apostrophes, the way the identity key does', async () => {
    const ctx = setup()

    const { productId } = await ctx.service.resolve(identity({ brand: "Johnson's", name: 'Baby Oil & Lotion', category: 'body' }))

    expect(await searchTextOf(ctx, productId)).toBe('johnsons baby oil and lotion')
  })

  it('is set on a named product created from a back label too', async () => {
    const ctx = setup()

    const { productId } = await ctx.service.fromLabel({ ingredients: CLEAN, brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Night', category: 'skin' })

    expect(await searchTextOf(ctx, productId)).toBe('glow co bright tone serum night')
  })

  it('is empty for an unnamed product', async () => {
    const ctx = setup()

    const { productId } = await ctx.service.fromLabel({ ingredients: CLEAN })

    expect(await searchTextOf(ctx, productId)).toBe('')
  })
})

describe('ProductCatalogService.search', () => {
  /**
   * A product search can list: one the catalog has ingredients for (here from a back label). Search hides a named product that has no
   * formulation, so every fixture a test needs search to find is made with this, and the tests at the end of this block cover the rule itself.
   */
  const listed = async (ctx: Ctx, who: ProductIdentity) => {
    const resolved = await ctx.service.resolve(who)
    await ctx.service.addLabelIngredients(resolved.productId, CLEAN)
    return resolved
  }
  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']
  const callsToAi = (ctx: Ctx) => ctx.analyst.calls.analyse.length + ctx.analyst.calls.sameProduct.length + ctx.analyst.calls.imageShowsProduct.length + ctx.researcher.calls.length
  const idsOf = (found: { id: string }[]) => found.map((p) => p.id)

  it('finds a named product by a fragment of its brand, name and variant, as { id, kind, brand, name, variant, form, category, imageUrl } and nothing more', async () => {
    const ctx = setup()
    const { productId } = await listed(ctx, identity({ variant: 'Night' }))

    const found = await ctx.service.search('facial cleanser')

    expect(found).toEqual([{ id: productId, kind: 'named', brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: 'Night', form: null, category: 'skin', imageUrl: null }])
  })

  it('gives a null variant for a product with none, and the stock image\'s public URL for one that has an image', async () => {
    const ctx = setup()
    const { productId } = await listed(ctx, identity())
    await ctx.repository.setProductImage(productId, { key: 'catalog/test/products/cerave.jpg', sourceUrl: IMAGE_URL, checkedAt: T0 })

    expect(await ctx.service.search('cerave')).toEqual([
      { id: productId, kind: 'named', brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: null, form: null, category: 'skin', imageUrl: 'https://images.test/catalog/test/products/cerave.jpg' },
    ])
  })

  it('shows the form of a product, so a spray and a roll-on of the same line are told apart in the list', async () => {
    const ctx = setup()
    const nivea = { brand: 'NIVEA MEN', name: 'Dry Impact', category: 'body' } as const
    const spray = await listed(ctx, identity({ ...nivea, form: 'spray' }))
    const rollOn = await listed(ctx, identity({ ...nivea, form: 'roll-on' }))

    const found = await ctx.service.search('nivea men dry impact')

    expect(spray.productId).not.toBe(rollOn.productId)
    expect(found).toHaveLength(2)
    expect(found).toEqual(
      expect.arrayContaining([
        { id: spray.productId, kind: 'named', brand: 'NIVEA MEN', name: 'Dry Impact', variant: null, form: 'spray', category: 'body', imageUrl: null },
        { id: rollOn.productId, kind: 'named', brand: 'NIVEA MEN', name: 'Dry Impact', variant: null, form: 'roll-on', category: 'body', imageUrl: null },
      ]),
    )
  })

  it('gives a null form for a product that has none, next to one that has', async () => {
    const ctx = setup()
    const plain = await listed(ctx, identity({ brand: 'Acme', name: 'Glow Serum' }))
    const spray = await listed(ctx, identity({ brand: 'Acme', name: 'Glow Serum', form: 'spray' }))

    const found = await ctx.service.search('acme glow serum')

    expect(Object.fromEntries(found.map((p) => [p.id, p.form]))).toEqual({ [plain.productId]: null, [spray.productId]: 'spray' })
  })

  it.each([
    ['upper case', 'CERAVE HYDRATING'],
    ['surrounding and repeated spaces', '  cerave    hydrating  '],
    ['an accent', 'céravé hydrating'],
    ['punctuation', 'cerave, hydrating!'],
  ])('normalises the query the way the search text is normalised: %s', async (_label, query) => {
    const ctx = setup()
    const { productId } = await listed(ctx, identity())

    expect(idsOf(await ctx.service.search(query))).toEqual([productId])
  })

  it('finds an accented, punctuated product by the plain text a user types', async () => {
    const ctx = setup()
    const { productId } = await listed(ctx, identity({ brand: "L'Oréal Paris", name: 'Revitalift Crème' }))

    expect(idsOf(await ctx.service.search('loreal revitalift creme'))).toEqual([productId])
    expect(idsOf(await ctx.service.search("L'Oréal"))).toEqual([productId])
  })

  it('finds a product by words in another order, and by words that skip some of its own', async () => {
    const ctx = setup()
    const { productId } = await listed(ctx, identity({ brand: 'La Roche-Posay', name: 'Effaclar Purifying Foaming Gel' }))

    expect(idsOf(await ctx.service.search('gel effaclar'))).toEqual([productId])
    expect(idsOf(await ctx.service.search('Roche foaming'))).toEqual([productId])
    expect(idsOf(await ctx.service.search('effaclar sunscreen'))).toEqual([])
  })

  it.each([['nothing but spaces', '   '], ['nothing but punctuation', '!!'], ['an empty string', '']])('finds nothing, rather than every product, for %s', async (_label, query) => {
    const ctx = setup()
    await listed(ctx, identity())

    expect(await ctx.service.search(query)).toEqual([])
  })

  it.each([
    ['one letter and punctuation', 'a!'],
    ['one letter', 'a'],
    ['one digit between spaces', ' 5 '],
    ['punctuation around one letter', '...c...'],
  ])('finds nothing for a query that is under 2 characters once normalised: %s', async (_label, query) => {
    const ctx = setup()
    await listed(ctx, identity({ brand: 'Acme', name: 'Cleanser 5' }))

    expect(await ctx.service.search(query)).toEqual([])
  })

  it('finds a product for a query of exactly 2 characters once normalised', async () => {
    const ctx = setup()
    const { productId } = await listed(ctx, identity())

    expect(idsOf(await ctx.service.search('ce'))).toEqual([productId])
    expect(idsOf(await ctx.service.search('!!ce!!'))).toEqual([productId])
  })

  it('finds nothing for text no product contains', async () => {
    const ctx = setup()
    await listed(ctx, identity())

    expect(await ctx.service.search('sunscreen')).toEqual([])
  })

  it('never returns an unnamed product, though its identity key holds the words of its list', async () => {
    const ctx = setup()
    await ctx.service.fromLabel({ ingredients: CLEAN })
    const { productId } = await listed(ctx, identity())

    expect(idsOf(await ctx.service.search('aqua'))).toEqual([])
    expect(idsOf(await ctx.service.search('unnamed'))).toEqual([])
    expect(idsOf(await ctx.service.search('cerave'))).toEqual([productId])
  })

  it('reaches a product through an alias it was given, once, though its own search text matches too', async () => {
    const ctx = setup()
    const { productId } = await listed(ctx, identity())
    // A spelling the model confirms as the same product is remembered as an alias.
    ctx.analyst.sameProductWith(() => true)
    expect((await ctx.service.resolve(identity({ name: 'Hydrating Cleanser' }))).productId).toBe(productId)

    expect(idsOf(await ctx.service.search('hydrating cleanser'))).toEqual([productId])
    expect(idsOf(await ctx.service.search('cerave'))).toEqual([productId])
  })

  it('returns at most 10 products: ten matches give ten, eleven give the first ten in order', async () => {
    const ctx = setup()
    const ids: string[] = []
    // One brand, names that differ in the last word only (3 of 4 words shared is below the near-miss threshold, so nothing asks the model).
    for (const letter of LETTERS.slice(0, 10)) ids.push((await listed(ctx, identity({ brand: 'Acme', name: `Glow Serum ${letter}` }))).productId)

    expect(idsOf(await ctx.service.search('glow serum'))).toEqual(ids)

    ids.push((await listed(ctx, identity({ brand: 'Acme', name: `Glow Serum ${LETTERS[10]}` }))).productId)

    // Same rank for all of them (none starts with the query), so the order is by name: the 11th, "... k", is the one left out.
    expect(idsOf(await ctx.service.search('glow serum'))).toEqual(ids.slice(0, 10))
  })

  it('puts the products whose name starts with the query first, then the others by name', async () => {
    const ctx = setup()
    const wash = await listed(ctx, identity({ brand: 'Acme', name: 'Ceramide Wash' }))
    const butter = await listed(ctx, identity({ brand: 'Acme', name: 'Cera Butter' }))
    const cleanser = await listed(ctx, identity({ brand: 'CeraVe', name: 'Hydrating Cleanser' }))

    // "cerave ..." starts with "cera"; "acme cera butter" and "acme ceramide wash" only contain it, and Butter sorts before Wash.
    expect(idsOf(await ctx.service.search('cera'))).toEqual([cleanser.productId, butter.productId, wash.productId])
  })

  describe('a product the catalog has no ingredients for', () => {
    it('is hidden: a named product with no formulation is not listed, whatever the query, though its search text matches', async () => {
      const ctx = setup()
      await ctx.service.resolve(identity())

      expect(await ctx.service.search('cerave')).toEqual([])
      expect(await ctx.service.search('hydrating facial cleanser')).toEqual([])
    })

    it('is listed once research has found its ingredients', async () => {
      const ctx = setup()
      const { productId } = await researched(ctx)

      expect(idsOf(await ctx.service.search('cerave'))).toEqual([productId])
    })

    it('is listed once the ingredients are read from a label', async () => {
      const ctx = setup()
      const { productId } = await ctx.service.resolve(identity())
      expect(await ctx.service.search('cerave')).toEqual([])

      await ctx.service.addLabelIngredients(productId, CLEAN)

      expect(idsOf(await ctx.service.search('cerave'))).toEqual([productId])
    })

    it('stays hidden when research finds no ingredients, so a made-up name typed by a user never becomes searchable', async () => {
      const ctx = setup()
      const { productId } = await ctx.service.resolve(identity({ brand: 'Zorblax', name: 'Megacream' }))
      ctx.researcher.respondWith(() => ({ found: false }))

      expect(await ctx.service.research(productId)).toEqual({ kind: 'not-found' })

      expect(await ctx.service.search('zorblax')).toEqual([])
    })

    it('is hidden next to a listed product of the same brand, which is still found', async () => {
      const ctx = setup()
      await ctx.service.resolve(identity({ brand: 'Acme', name: 'Ghost Serum' }))
      const real = await listed(ctx, identity({ brand: 'Acme', name: 'Real Serum' }))

      expect(idsOf(await ctx.service.search('acme'))).toEqual([real.productId])
    })

    it('is not found through an alias either, until it has ingredients', async () => {
      const ctx = setup()
      const { productId } = await ctx.service.resolve(identity())
      ctx.analyst.sameProductWith(() => true)
      expect((await ctx.service.resolve(identity({ name: 'Hydrating Cleanser' }))).productId).toBe(productId)
      expect(await ctx.service.search('hydrating cleanser')).toEqual([])

      await ctx.service.addLabelIngredients(productId, CLEAN)

      expect(idsOf(await ctx.service.search('hydrating cleanser'))).toEqual([productId])
    })

    it('does not use up the limit of 10: ten hidden products ahead of one listed product do not push it out', async () => {
      const ctx = setup()
      for (const letter of LETTERS.slice(0, 10)) await ctx.service.resolve(identity({ brand: 'Acme', name: `Glow Serum ${letter}` }))
      const real = await listed(ctx, identity({ brand: 'Acme', name: 'Glow Serum Z' }))

      expect(idsOf(await ctx.service.search('glow serum'))).toEqual([real.productId])
    })
  })

  it('makes no model or web call, however many products it looks at', async () => {
    const ctx = setup()
    for (const letter of LETTERS) await listed(ctx, identity({ brand: 'Acme', name: `Glow Serum ${letter}` }))
    const before = callsToAi(ctx)

    await ctx.service.search('glow')
    await ctx.service.search('zzz')

    expect(callsToAi(ctx)).toBe(before)
  })
})

describe('ProductCatalogService.namedProduct', () => {
  it('reads a named product back as { id, kind, brand, name, variant, form, category, imageUrl }, with the form it was made with', async () => {
    const ctx = setup()
    const { productId } = await ctx.service.resolve(identity({ brand: 'NIVEA MEN', name: 'Dry Impact', variant: 'Night', category: 'body', form: 'spray' }))

    expect(await ctx.service.namedProduct(productId)).toEqual({ id: productId, kind: 'named', brand: 'NIVEA MEN', name: 'Dry Impact', variant: 'Night', form: 'spray', category: 'body', imageUrl: null })
  })

  it('gives a null form for a product made without one', async () => {
    const ctx = setup()
    const { productId } = await ctx.service.resolve(identity())

    expect(await ctx.service.namedProduct(productId)).toMatchObject({ id: productId, form: null })
  })

  it('reads each product of one line by its own form, not the form of its sibling', async () => {
    const ctx = setup()
    const spray = await ctx.service.resolve(identity({ form: 'spray' }))
    const rollOn = await ctx.service.resolve(identity({ form: 'roll-on' }))

    expect((await ctx.service.namedProduct(spray.productId)).form).toBe('spray')
    expect((await ctx.service.namedProduct(rollOn.productId)).form).toBe('roll-on')
  })
})

describe('ProductCatalogService.choose', () => {
  it('says ready, with the product and formulation, for a product with a fresh formulation analysed by the current version, calling no model', async () => {
    const ctx = setup()
    const { productId, formulationId } = await analysed(ctx)
    const calls = ctx.analyst.calls.analyse.length + ctx.analyst.calls.sameProduct.length + ctx.researcher.calls.length

    const result = await ctx.service.choose(productId)

    expect(result).toEqual({ kind: 'ready', productId, formulationId })
    expect(ctx.analyst.calls.analyse.length + ctx.analyst.calls.sameProduct.length + ctx.researcher.calls.length).toBe(calls)
  })

  it('says needs-analysis for a product whose formulation has not been analysed', async () => {
    const ctx = setup()
    const { productId, formulationId } = await researched(ctx)

    expect(await ctx.service.choose(productId)).toEqual({ kind: 'needs-analysis', productId, formulationId })
  })

  it('says needs-research for a product that has no formulation yet', async () => {
    const ctx = setup()
    const { productId } = await ctx.service.resolve(identity())

    expect(await ctx.service.choose(productId)).toEqual({ kind: 'needs-research', productId })
  })

  it('treats a formulation exactly FRESH_FOR_DAYS old as fresh and one a millisecond older as needing research', async () => {
    const ctx = setup()
    const { productId, formulationId } = await analysed(ctx)

    ctx.advance(FRESH_FOR_DAYS * DAY)
    expect(await ctx.service.choose(productId)).toEqual({ kind: 'ready', productId, formulationId })

    ctx.advance(1)
    expect(await ctx.service.choose(productId)).toEqual({ kind: 'needs-research', productId })
  })

  it.each(OLDER_CODE)('asks for analysis again of a formulation analysed by %s', async (_label, over) => {
    const ctx = setup()
    const { productId, formulationId } = await analysed(ctx)
    await analysedByOlderCode(ctx, formulationId, over)

    expect(await ctx.service.choose(productId)).toEqual({ kind: 'needs-analysis', productId, formulationId })
  })

  it('answers exactly what resolve answers for the same product', async () => {
    const ctx = setup()
    const { productId } = await analysed(ctx)

    expect(await ctx.service.choose(productId)).toEqual(await ctx.service.resolve(identity()))
  })

  it('creates nothing and records no attempt', async () => {
    const ctx = setup()
    const { productId } = await researched(ctx)
    const attempts = await ctx.repository.researchAttemptsSince(new Date(0))

    await ctx.service.choose(productId)

    expect(await ctx.repository.researchAttemptsSince(new Date(0))).toBe(attempts)
    expect(await ctx.repository.productsByBrandFamily('cerave', 10)).toHaveLength(1)
  })

  it('throws PRODUCT_NOT_FOUND for a product id the catalog does not hold', async () => {
    const ctx = setup()

    const error = await errorOf(ctx.service.choose('no-such-product'))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('PRODUCT_NOT_FOUND')
  })

  it('throws PRODUCT_NOT_FOUND for an unnamed product, which search never offers', async () => {
    const ctx = setup()
    const { productId } = await ctx.service.fromLabel({ ingredients: CLEAN })

    const error = await errorOf(ctx.service.choose(productId))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('PRODUCT_NOT_FOUND')
  })
})

describe('ProductCatalogService.fillSearchText', () => {
  /** A named product as a Worker that did not know search text made it: the row is there and its search text is empty. */
  const oldProduct = async (ctx: Ctx, who: { brand: string; name: string; variant?: string }, id: string, key = identityKey(who)) => {
    const product = await ctx.repository.createProduct({
      id,
      identityKey: key,
      brandKey: brandKey(who.brand),
      kind: 'named',
      brand: who.brand,
      name: who.name,
      variant: who.variant ?? null,
      form: null,
      category: 'skin',
      createdAt: T0,
    })
    // A product the old Worker made went on to be researched or read from a label like any other; search lists only those with ingredients.
    await ctx.service.addLabelIngredients(id, CLEAN)
    return product
  }
  const idsOf = (found: { id: string }[]) => found.map((p) => p.id)

  it.each([
    ['Johnson & Johnson', 'Baby Oil', 'johnson & johnson'],
    ['Dove', 'Men+Care Body Wash', 'men+care'],
    ["Carol's Daughter", 'Black Vanilla Moisture', 'carols'],
    ["L'Oréal", 'Revitalift Crème', 'loreal'],
  ])('fills in the search text of %s %s the way a new product gets it, so plain typed text (%s) finds it', async (brand, name, typed) => {
    const ctx = setup()
    await oldProduct(ctx, { brand, name }, 'old-1')
    expect(await ctx.service.search(typed)).toEqual([])

    expect(await ctx.service.fillSearchText()).toBe(1)

    expect(idsOf(await ctx.service.search(typed))).toEqual(['old-1'])
  })

  it('fills in the exact same text resolve would have stored, variant included', async () => {
    const ctx = setup()
    const made = await ctx.service.resolve(identity({ brand: "L'Oréal Paris", name: 'Revitalift Crème', variant: 'SPF 50+' }))
    // The same product, as another key (a stored product with this key would be returned instead of created): the text must not depend on the key.
    await oldProduct(ctx, { brand: "L'Oréal Paris", name: 'Revitalift Crème', variant: 'SPF 50+' }, 'old-1', 'old-worker-key')
    expect((await ctx.repository.findProductById('old-1'))!.searchText).toBe('')

    expect(await ctx.service.fillSearchText()).toBe(1)

    expect((await ctx.repository.findProductById('old-1'))!.searchText).toBe((await ctx.repository.findProductById(made.productId))!.searchText)
    expect((await ctx.repository.findProductById('old-1'))!.searchText).toBe('loreal paris revitalift creme spf 50 plus')
  })

  it('returns how many products it filled, fills each once, and then has nothing left to fill', async () => {
    const ctx = setup()
    for (const n of [1, 2, 3]) await oldProduct(ctx, { brand: 'Acme', name: `Serum ${n}` }, `old-${n}`)

    expect(await ctx.service.fillSearchText()).toBe(3)
    expect(await ctx.service.fillSearchText()).toBe(0)
    expect(idsOf(await ctx.service.search('acme serum'))).toEqual(['old-1', 'old-2', 'old-3'])
  })

  it('does nothing, and returns 0, for a catalog where every product has search text', async () => {
    const ctx = setup()
    const { productId } = await ctx.service.resolve(identity())
    const before = (await ctx.repository.findProductById(productId))!.searchText

    expect(await ctx.service.fillSearchText()).toBe(0)
    expect((await ctx.repository.findProductById(productId))!.searchText).toBe(before)
  })

  it('leaves an unnamed product alone: its search text stays empty, and it is not counted', async () => {
    const ctx = setup()
    const { productId } = await ctx.service.fromLabel({ ingredients: CLEAN })
    await oldProduct(ctx, { brand: 'Acme', name: 'Serum' }, 'old-1')

    expect(await ctx.service.fillSearchText()).toBe(1)

    expect((await ctx.repository.findProductById(productId))!.searchText).toBe('')
  })

  it('does not overwrite search text a product already has', async () => {
    const ctx = setup()
    const made = await ctx.service.resolve(identity())
    await ctx.repository.setSearchText(made.productId, 'set by hand')

    await ctx.service.fillSearchText()

    expect((await ctx.repository.findProductById(made.productId))!.searchText).toBe('set by hand')
  })

  it('fills at most 500 products a call: 501 old products take two calls, 500 and then 1', async () => {
    const ctx = setup()
    for (let n = 0; n < 501; n++) await oldProduct(ctx, { brand: 'Acme', name: `Serum ${n}` }, `old-${String(n).padStart(3, '0')}`)

    expect(await ctx.service.fillSearchText()).toBe(500)
    expect(await ctx.service.fillSearchText()).toBe(1)
    expect(await ctx.service.fillSearchText()).toBe(0)
  })

  it('writes what it fills through one setSearchTexts call per run, holding every filled row, and never row by row', async () => {
    const ctx = setup()
    for (const n of [1, 2, 3]) await oldProduct(ctx, { brand: 'Acme', name: `Serum ${n}` }, `old-${n}`)
    const batch = vi.spyOn(ctx.repository, 'setSearchTexts')
    const single = vi.spyOn(ctx.repository, 'setSearchText')

    await ctx.service.fillSearchText()

    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0]![0]).toEqual([
      { id: 'old-1', searchText: 'acme serum 1' },
      { id: 'old-2', searchText: 'acme serum 2' },
      { id: 'old-3', searchText: 'acme serum 3' },
    ])
    expect(single).not.toHaveBeenCalled()
  })

  it('makes one setSearchTexts call of 500 rows for 501 old products, then one of 1, and none when there is nothing to fill', async () => {
    const ctx = setup()
    for (let n = 0; n < 501; n++) await oldProduct(ctx, { brand: 'Acme', name: `Serum ${n}` }, `old-${String(n).padStart(3, '0')}`)
    const batch = vi.spyOn(ctx.repository, 'setSearchTexts')

    await ctx.service.fillSearchText()
    await ctx.service.fillSearchText()
    await ctx.service.fillSearchText()

    expect(batch.mock.calls.map(([rows]) => rows.length)).toEqual([500, 1])
  })

  it('makes no model or web call', async () => {
    const ctx = setup()
    await oldProduct(ctx, { brand: 'Acme', name: 'Serum' }, 'old-1')

    await ctx.service.fillSearchText()

    expect(ctx.analyst.calls.analyse.length + ctx.analyst.calls.sameProduct.length + ctx.analyst.calls.imageShowsProduct.length + ctx.researcher.calls.length).toBe(0)
  })
})

describe('ProductCatalogService.resolve tolerant near misses', () => {
  const CERAVE_CLEANSER = { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' } as const

  it('asks the judge when the stored product has no form and the label prints one, and a "yes" records an alias', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ brand: 'Cetaphil', name: 'Gentle Skin Cleanser' }))
    ctx.analyst.sameProductWith(() => true)
    const scanned = identity({ brand: 'Cetaphil', name: 'Gentle Skin Cleanser', form: 'cream' })

    const result = await ctx.service.resolve(scanned)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).toBe(stored.productId)
    expect(await ctx.repository.findProductByKey(identityKey(scanned))).toMatchObject({ id: stored.productId })
  })

  it('asks the judge when the label has no form and the stored product has one', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ brand: 'Cetaphil', name: 'Gentle Skin Cleanser', form: 'cream' }))
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.resolve(identity({ brand: 'Cetaphil', name: 'Gentle Skin Cleanser' }))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).toBe(stored.productId)
  })

  it('still never asks about two different known forms', async () => {
    const ctx = setup()
    await ctx.service.resolve(identity({ brand: 'Cetaphil', name: 'Gentle Skin Cleanser', form: 'cream' }))

    await ctx.service.resolve(identity({ brand: 'Cetaphil', name: 'Gentle Skin Cleanser', form: 'gel' }))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
  })

  it('asks the judge when only the suitability wording of the variant differs, and a "yes" lands on the stored product, with no alias for the more specific wording', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ ...CERAVE_CLEANSER, variant: 'Normal to Dry Skin' }))
    ctx.analyst.sameProductWith(() => true)
    const scanned = identity({ ...CERAVE_CLEANSER, variant: 'For Normal to Dry Skin' })

    const result = await ctx.service.resolve(scanned)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result).toEqual({ kind: 'needs-research', productId: stored.productId })
    expect(await ctx.repository.findProductByKey(identityKey(scanned))).toBeNull()
  })

  it('records the alias on a "yes" when the differing variant wording has the same words as the stored one', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ ...CERAVE_CLEANSER, variant: 'Normal to Dry Skin' }))
    ctx.analyst.sameProductWith(() => true)
    const scanned = identity({ ...CERAVE_CLEANSER, variant: 'dry TO normal skin' })

    const result = await ctx.service.resolve(scanned)

    expect(result.productId).toBe(stored.productId)
    expect(await ctx.repository.findProductByKey(identityKey(scanned))).toMatchObject({ id: stored.productId })
  })

  it('makes a new product when the judge says a differing variant is another product', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ ...CERAVE_CLEANSER, variant: 'Normal to Dry Skin' }))
    ctx.analyst.sameProductWith(() => false)

    const result = await ctx.service.resolve(identity({ ...CERAVE_CLEANSER, variant: 'Extra Dry Skin' }))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).not.toBe(stored.productId)
  })

  it.each([
    ['SPF 30 and SPF 50', 'SPF 30', 'SPF 50'],
    ['2% and 5%', '2%', '5%'],
  ])('never reaches the judge, even one that would say yes, when the variants are %s, and makes a new product', async (_label, storedVariant, scannedVariant) => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ brand: 'Acme', name: 'Daily Sun Fluid', variant: storedVariant }))
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.resolve(identity({ brand: 'Acme', name: 'Daily Sun Fluid', variant: scannedVariant }))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
    expect(result.productId).not.toBe(stored.productId)
  })

  it('asks the judge about a reading whose words are all inside a longer stored name (NIVEA "Soft")', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ brand: 'NIVEA', name: 'Soft Light Moisturiser', category: 'body' }))
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.resolve(identity({ brand: 'NIVEA', name: 'soft', category: 'body' }))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).toBe(stored.productId)
  })

  it('returns the stored product on a "yes" for a strictly less specific reading, but records no alias, so the next identical reading asks the judge again', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ brand: 'Neutrogena', name: 'Hydro Boost Water Gel', category: 'skin' }))
    ctx.analyst.sameProductWith(() => true)
    const vague = identity({ brand: 'Neutrogena', name: 'Hydro Boost', category: 'skin' })

    const first = await ctx.service.resolve(vague)
    const second = await ctx.service.resolve(vague)

    expect(first.productId).toBe(stored.productId)
    expect(second.productId).toBe(stored.productId)
    expect(await ctx.repository.findProductByKey(identityKey(vague))).toBeNull()
    expect(ctx.analyst.calls.sameProduct).toHaveLength(2)
  })

  it('records NO alias on a "yes" for a reading with extra words: a vague stored row must not collect specific aliases', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ brand: 'Neutrogena', name: 'Hydro Boost', category: 'skin' }))
    ctx.analyst.sameProductWith(() => true)
    const specific = identity({ brand: 'Neutrogena', name: 'Hydro Boost Water Gel', category: 'skin' })

    const result = await ctx.service.resolve(specific)

    expect(result.productId).toBe(stored.productId)
    expect(await ctx.repository.findProductByKey(identityKey(specific))).toBeNull()
  })

  it('records the alias on a "yes" for a reading with the same words in another order', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ brand: 'Neutrogena', name: 'Water Gel Hydro Boost', category: 'skin' }))
    ctx.analyst.sameProductWith(() => true)
    const reordered = identity({ brand: 'Neutrogena', name: 'Hydro Boost Water Gel', category: 'skin' })

    const result = await ctx.service.resolve(reordered)

    expect(result.productId).toBe(stored.productId)
    expect(await ctx.repository.findProductByKey(identityKey(reordered))).toMatchObject({ id: stored.productId })
  })

  it('records no alias for a reading with no form matched to a product that has one, but resolves to it', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ brand: 'Cetaphil', name: 'Gentle Skin Cleanser', form: 'cream' }))
    ctx.analyst.sameProductWith(() => true)
    const scanned = identity({ brand: 'Cetaphil', name: 'Gentle Skin Cleanser' })

    const result = await ctx.service.resolve(scanned)

    expect(result.productId).toBe(stored.productId)
    expect(await ctx.repository.findProductByKey(identityKey(scanned))).toBeNull()
  })

  describe('ambiguity guard', () => {
    const DEEPLY = { brand: 'Dove', name: 'Deeply Nourishing Body Wash', category: 'body' } as const
    const GO_FRESH = { brand: 'Dove', name: 'Go Fresh Body Wash', category: 'body' } as const

    it('never asks the judge, and makes a new product, when the reading is less specific than two candidates', async () => {
      const ctx = setup()
      const deeply = await ctx.service.resolve(identity(DEEPLY))
      const goFresh = await ctx.service.resolve(identity(GO_FRESH))
      ctx.analyst.sameProductWith(() => true)

      const result = await ctx.service.resolve(identity({ brand: 'Dove', name: 'Body Wash', category: 'body' }))

      expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
      expect([deeply.productId, goFresh.productId]).not.toContain(result.productId)
    })

    it('still asks the judge when the reading is less specific than only one candidate', async () => {
      const ctx = setup()
      const deeply = await ctx.service.resolve(identity(DEEPLY))
      ctx.analyst.sameProductWith(() => true)

      const result = await ctx.service.resolve(identity({ brand: 'Dove', name: 'Body Wash', category: 'body' }))

      expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
      expect(result.productId).toBe(deeply.productId)
    })
  })

  it('does not merge a contained reading when the judge says no', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ brand: "Palmer's", name: 'Cocoa Butter Formula Daily Body Lotion', category: 'body' }))
    ctx.analyst.sameProductWith(() => false)

    const result = await ctx.service.resolve(identity({ brand: "Palmer's", name: 'Cocoa Butter Formula', category: 'body' }))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).not.toBe(stored.productId)
  })
})

describe('ProductCatalogService.resolve: spellings, % names and range-less readings', () => {
  it('asks the judge about a UK reading for a US row, and a "yes" records an alias', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ brand: 'CeraVe', name: 'Moisturizing Lotion', category: 'body' }))
    ctx.analyst.sameProductWith(() => true)
    const scanned = identity({ brand: 'CeraVe', name: 'Moisturising Lotion', category: 'body' })

    const result = await ctx.service.resolve(scanned)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).toBe(stored.productId)
    expect(await ctx.repository.findProductByKey(identityKey(scanned))).toMatchObject({ id: stored.productId })
  })

  it('makes a new product when the judge says the UK reading is not the US row', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ brand: 'CeraVe', name: 'Moisturizing Lotion', category: 'body' }))
    ctx.analyst.sameProductWith(() => false)

    const result = await ctx.service.resolve(identity({ brand: 'CeraVe', name: 'Moisturising Lotion', category: 'body' }))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).not.toBe(stored.productId)
  })

  it('asks the judge about the L-Ascorbic reading with variant 100% for the row 100% L-Ascorbic Acid Powder, and a "yes" lands on that row', async () => {
    const ctx = setup()
    const stored = await ctx.service.resolve(identity({ brand: 'The Ordinary', name: '100% L-Ascorbic Acid Powder', category: 'skin' }))
    ctx.analyst.sameProductWith(() => true)

    const result = await ctx.service.resolve(identity({ brand: 'The Ordinary', name: 'L-Ascorbic Acid Powder', variant: '100%', category: 'skin' }))

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).toBe(stored.productId)
  })

  describe('a reading with no range name', () => {
    const SHEA = { brand: 'Cantu', name: 'Shea Butter Coconut Curling Cream', category: 'hair' } as const
    const AVOCADO = { brand: 'Cantu', name: 'Avocado Coconut Curling Cream', category: 'hair' } as const
    const READING = { brand: 'Cantu', name: 'Coconut Curling Cream', category: 'hair' } as const

    // Guards behaviour that already holds: the ambiguity guard keeps this apart without a judge call.
    it('is kept apart, with no judge call, when the catalog holds two products of different ranges it could be', async () => {
      const ctx = setup()
      const shea = await ctx.service.resolve(identity(SHEA))
      const avocado = await ctx.service.resolve(identity(AVOCADO))
      ctx.analyst.sameProductWith(() => true)

      const result = await ctx.service.resolve(identity(READING))

      expect(ctx.analyst.calls.sameProduct).toHaveLength(0)
      expect([shea.productId, avocado.productId]).not.toContain(result.productId)
    })

    // Guards behaviour that already holds: one candidate reaches the judge.
    it('reaches the judge when the catalog holds only one of them', async () => {
      const ctx = setup()
      const shea = await ctx.service.resolve(identity(SHEA))
      ctx.analyst.sameProductWith(() => true)

      const result = await ctx.service.resolve(identity(READING))

      expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
      expect(result.productId).toBe(shea.productId)
    })
  })
})

describe('ProductCatalogService.resolve: a row whose identity key the code no longer produces', () => {
  /** The name whose key the % size fix changed: "100%" used to read as "100 l", 100 litres, and be stripped as a size. */
  const ASCORBIC = { brand: 'The Ordinary', name: '100% L-Ascorbic Acid Powder', category: 'skin' } as const
  /** The key a Worker before the fix wrote for it. Pinned literally: no migration rewrote the rows it made. */
  const OLD_KEY = 'the ordinary|ascorbic acid powder||'
  const OLD_ID = 'old-row'

  /** The product as the old Worker stored it: today's fields under the key that code produced. */
  const rowFromBeforeTheFix = (ctx: Ctx) =>
    ctx.repository.createProduct({
      id: OLD_ID,
      identityKey: OLD_KEY,
      brandKey: brandKey(ASCORBIC.brand),
      kind: 'named',
      brand: ASCORBIC.brand,
      name: ASCORBIC.name,
      variant: null,
      form: null,
      category: ASCORBIC.category,
      createdAt: T0,
    })

  it('asks the judge once about the old row and, on a "yes", lands the reading on it with an alias for the new key', async () => {
    const ctx = setup()
    await rowFromBeforeTheFix(ctx)
    ctx.analyst.sameProductWith(() => true)
    const scanned = identity(ASCORBIC)

    const result = await ctx.service.resolve(scanned)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).toBe(OLD_ID)
    expect(await ctx.repository.findProductByKey(identityKey(scanned))).toMatchObject({ id: OLD_ID })
  })

  it('reaches the same row by that alias on the next scan, without asking the judge again', async () => {
    const ctx = setup()
    await rowFromBeforeTheFix(ctx)
    ctx.analyst.sameProductWith(() => true)
    await ctx.service.resolve(identity(ASCORBIC))

    const again = await ctx.service.resolve(identity(ASCORBIC))

    expect(again.productId).toBe(OLD_ID)
    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
  })

  it('makes a new product, keyed by the new key and with no alias, when the judge says it is not the old row', async () => {
    const ctx = setup()
    await rowFromBeforeTheFix(ctx)
    ctx.analyst.sameProductWith(() => false)
    const scanned = identity(ASCORBIC)

    const result = await ctx.service.resolve(scanned)

    expect(ctx.analyst.calls.sameProduct).toHaveLength(1)
    expect(result.productId).not.toBe(OLD_ID)
    expect(await ctx.repository.findProductByKey(identityKey(scanned))).toMatchObject({ id: result.productId })
  })
})

// Invented brands and names on purpose: the rules are general, not fixes for any product the eval happens to hold.

/** The names of the candidates the judge was asked about since `before`, in the order it was asked. */
const askedSince = (ctx: Ctx, before: number) => ctx.analyst.calls.sameProduct.slice(before).map(([, candidate]) => candidate.name)

describe('ProductCatalogService.resolve: a reading with the same words as one of several candidates', () => {
  const GLOWCO = { brand: 'Glowco', category: 'body', form: 'lotion' } as const
  /** The reading: the same words as the UK row, and less specific than the Daily and Night ones. */
  const READING = identity({ ...GLOWCO, name: 'Moisturizing Lotion' })
  const UK_SPELLING = 'Moisturising Lotion'
  const LONGER = ['Daily Moisturizing Lotion', 'Night Moisturizing Lotion']
  /** The same three words again, the recognizer having read "Lotion" as the variant: equal to the reading because the words are pooled. */
  const SPLIT_ROW = { name: 'Moisturizing', variant: 'Lotion' }

  /** Stores the rows through resolve, oldest first, so each is a real row of the brand. The judge says "different" while they are made. */
  const catalogued = async (ctx: Ctx, rows: { name: string; variant?: string }[]) => {
    const ids: Record<string, string> = {}
    for (const row of rows) {
      ids[row.name] = (await ctx.service.resolve(identity({ ...GLOWCO, name: row.name, ...(row.variant ? { variant: row.variant } : {}) }))).productId
      ctx.advance(MINUTE)
    }
    return ids
  }
  const named = (...names: string[]) => names.map((name) => ({ name }))

  it('judges only the row with the same words, and a "yes" lands the reading on it and records the alias', async () => {
    const ctx = setup()
    const ids = await catalogued(ctx, named(UK_SPELLING, ...LONGER))
    ctx.analyst.sameProductWith(() => true)
    const before = ctx.analyst.calls.sameProduct.length

    const result = await ctx.service.resolve(READING)

    expect(askedSince(ctx, before)).toEqual([UK_SPELLING])
    expect(result.productId).toBe(ids[UK_SPELLING])
    expect(await ctx.repository.findProductByKey(identityKey(READING))).toMatchObject({ id: ids[UK_SPELLING] })
  })

  it('makes a new row on a "no", having never judged the longer rows', async () => {
    const ctx = setup()
    const ids = await catalogued(ctx, named(UK_SPELLING, ...LONGER))
    ctx.analyst.sameProductWith(() => false)
    const before = ctx.analyst.calls.sameProduct.length

    const result = await ctx.service.resolve(READING)

    expect(askedSince(ctx, before)).toEqual([UK_SPELLING])
    expect(Object.values(ids)).not.toContain(result.productId)
  })

  it('judges every row with the same words, and lands on the one the judge confirms', async () => {
    // Four candidates, so the limit is raised: at three the Night row would fall outside it and the guard would not fire today either.
    const ctx = setup({ policy: { nearMissLimit: 4 } })
    const ids = await catalogued(ctx, [...named(UK_SPELLING), SPLIT_ROW, ...named(...LONGER)])
    ctx.analyst.sameProductWith((_reading, candidate) => candidate.name === SPLIT_ROW.name)
    const before = ctx.analyst.calls.sameProduct.length

    const result = await ctx.service.resolve(READING)

    expect(askedSince(ctx, before)).toEqual([UK_SPELLING, SPLIT_ROW.name])
    expect(result.productId).toBe(ids[SPLIT_ROW.name])
  })

  // Guards the ambiguity guard itself: without a row of the same words, a reading less specific than two rows is still held back.
  it('is still held back, with no judge call, when no candidate has the same words', async () => {
    const ctx = setup()
    const ids = await catalogued(ctx, named(...LONGER))
    ctx.analyst.sameProductWith(() => true)
    const before = ctx.analyst.calls.sameProduct.length

    const result = await ctx.service.resolve(READING)

    expect(askedSince(ctx, before)).toEqual([])
    expect(Object.values(ids)).not.toContain(result.productId)
  })

  // The same words means the full words: a row that differs only by a suitability line is not the reading's equal, so the guard still applies.
  it('is still held back when the nearest row differs by a suitability line', async () => {
    const ctx = setup()
    const ids = await catalogued(ctx, named(`${UK_SPELLING} for Dry Skin`, ...LONGER))
    ctx.analyst.sameProductWith(() => true)
    const before = ctx.analyst.calls.sameProduct.length

    const result = await ctx.service.resolve(READING)

    expect(askedSince(ctx, before)).toEqual([])
    expect(Object.values(ids)).not.toContain(result.productId)
  })
})

describe('ProductCatalogService.resolve: a candidate with the reading\'s form against candidates with none', () => {
  const OAKLEAF = { brand: 'Oakleaf', category: 'body' } as const
  const WITH_FORM = 'Shea Comfort Body Oil'
  const NO_FORM = 'Shea Comfort Solid Jar'
  const SECOND_WITH_FORM = 'Shea Comfort Night Oil'
  /** The reading: less specific than every row below, and it prints its form. */
  const READING = identity({ ...OAKLEAF, name: 'Shea Comfort', form: 'oil' })

  /** Stores the rows through resolve, oldest first. A row given no form is one whose pack never showed it. */
  const catalogued = async (ctx: Ctx, rows: [name: string, form?: 'oil'][]) => {
    const ids: Record<string, string> = {}
    for (const [name, form] of rows) {
      ids[name] = (await ctx.service.resolve(identity({ ...OAKLEAF, name, ...(form ? { form } : {}) }))).productId
      ctx.advance(MINUTE)
    }
    return ids
  }

  it('judges only the row of the reading\'s form, and a "yes" lands the reading on it, with no alias for the less specific reading', async () => {
    const ctx = setup()
    const ids = await catalogued(ctx, [[WITH_FORM, 'oil'], [NO_FORM]])
    ctx.analyst.sameProductWith(() => true)
    const before = ctx.analyst.calls.sameProduct.length

    const result = await ctx.service.resolve(READING)

    expect(askedSince(ctx, before)).toEqual([WITH_FORM])
    expect(result.productId).toBe(ids[WITH_FORM])
    expect(await ctx.repository.findProductByKey(identityKey(READING))).toBeNull()
  })

  it('makes a new row on a "no", having never judged the row with no form', async () => {
    const ctx = setup()
    const ids = await catalogued(ctx, [[WITH_FORM, 'oil'], [NO_FORM]])
    ctx.analyst.sameProductWith(() => false)
    const before = ctx.analyst.calls.sameProduct.length

    const result = await ctx.service.resolve(READING)

    expect(askedSince(ctx, before)).toEqual([WITH_FORM])
    expect(Object.values(ids)).not.toContain(result.productId)
  })

  // Guards the ambiguity guard itself: two rows of the reading's form cannot be told apart, so neither is judged.
  it('is still held back, with no judge call, when two candidates have the reading\'s form', async () => {
    const ctx = setup()
    const ids = await catalogued(ctx, [[WITH_FORM, 'oil'], [SECOND_WITH_FORM, 'oil']])
    ctx.analyst.sameProductWith(() => true)
    const before = ctx.analyst.calls.sameProduct.length

    const result = await ctx.service.resolve(READING)

    expect(askedSince(ctx, before)).toEqual([])
    expect(Object.values(ids)).not.toContain(result.productId)
  })

  it('is still held back when the reading itself prints no form', async () => {
    const ctx = setup()
    const ids = await catalogued(ctx, [[WITH_FORM, 'oil'], [NO_FORM]])
    ctx.analyst.sameProductWith(() => true)
    const before = ctx.analyst.calls.sameProduct.length

    const result = await ctx.service.resolve(identity({ ...OAKLEAF, name: 'Shea Comfort' }))

    expect(askedSince(ctx, before)).toEqual([])
    expect(Object.values(ids)).not.toContain(result.productId)
  })
})
