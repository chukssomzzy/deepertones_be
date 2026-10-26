import { describe, expect, it } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../../lib/errors'
import { MemoryGoalReader } from '../../providers/goal-reading/memory.goal-reader'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import type { Mention } from '../../providers/mention-reading/mention-reader.provider'
import { MemoryMentionReader } from '../../providers/mention-reading/memory.mention-reader'
import type { ProductIdentity } from '../../providers/product-research/product-researcher.provider'
import type { ReferenceEntry } from '../catalog/catalog.reference'
import type { ProductSummary, ResearchResult, ResolveResult } from '../catalog/catalog.service'
import type { ConcernKind, Origin, RoutineStep } from '../catalog/catalog.vocabulary'
import { FakeCatalogWorkbook } from '../catalog/catalog.workbook.service.fake'
import type { ShownConcern, SkinTypeLabel } from '../face-scans/face-scans.tables'
import { FakeGoalsRepository } from '../goals/goals.repository.fake'
import { GoalsService } from '../goals/goals.service'
import type { Goal } from '../goals/goals.vocabulary'
import { FakeSafetyRepository } from '../safety/safety.repository.fake'
import { SafetyService } from '../safety/safety.service'
import type { SafetyChoice } from '../safety/safety.vocabulary'
import { FakeRecommendationsRepository } from './recommendations.repository.fake'
import { RecommendationService } from './recommendations.service'

// RecommendationService: the shopping facts (setShopping, currentShopping) and candidatesFor, the one question "which reviewed products may be suggested
// to this profile for this routine step". The goals and safety services are the real ones over their fake repositories (the answers are saved the way a
// user saves them, and the reaction words are parsed by the real parse). Only the edges are fakes: the workbook's read side (FakeCatalogWorkbook, the
// interface PR 3 fixes), the catalog's product reads, the face scan's skin type, the mention reader and the catalog the safety parse resolves against.
// Expected values are literals worked out from the spec, never taken from the code under test.

// The one clock every test hangs off; later times are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

const actor = (userId: string, profileId: string): Actor => ({ kind: 'user', userId, status: 'anonymous', profileId })
// Amara and Tolu are two accounts; Amara has a second profile.
const AMARA = actor('user-amara', 'profile-amara-1')
const AMARA_SECOND_PROFILE = actor('user-amara', 'profile-amara-2')
const TOLU = actor('user-tolu', 'profile-tolu-1')
const PUBLIC: Actor = { kind: 'public' }
const SYSTEM: Actor = { kind: 'system', job: 'parse-safety' }

// What the Countries tab holds: bands are per country, in its own currency.
const NG = { code: 'NG', currency: 'NGN', lowMax: 5000, midMax: 15000, status: 'active' } as const
const GB = { code: 'GB', currency: 'GBP', lowMax: 15, midMax: 40, status: 'active' } as const

const rule = (name: string, kind: ConcernKind, aliases: string[] = []): ReferenceEntry => ({ name, aliases, kind, rule: `${name} is a ${kind} (test rule)`, source: null })
// The live approved rules the fake workbook hands back. Only two kinds take a product out of a candidate list; an allergen is for the verdict.
const RULES: ReferenceEntry[] = [
  rule('retinol', 'pregnancy-caution'),
  rule('hydroquinone', 'banned-substance', ['quinol']),
  rule('parfum', 'allergen', ['fragrance']),
  rule('alcohol denat', 'irritation'),
]

type Recommendation = Parameters<FakeCatalogWorkbook['offer']>[1]

/** An approved row that passes every rule for a glow-goal user with no skin type, no budget and nothing to avoid; a test changes the one thing it is about. */
const row = (code: string, over: Partial<Recommendation> = {}): Recommendation => ({
  code,
  productId: `product-${code}`,
  formulationId: `formulation-${code}`,
  ingredients: ['Aqua', 'Glycerin'],
  skinConcerns: ['hd_radiance'],
  skinTypes: 'all',
  steps: ['moisturise'],
  frequency: 'am-pm',
  ownCautions: [],
  evidenceUrls: ['https://example.com/evidence'],
  ingredientsSourceUrl: 'https://example.com/ingredients',
  keyIngredient: null,
  strength: null,
  origin: 'sourced',
  priceMin: 1000,
  priceMax: 2000,
  whereSold: 'Pharmacies and online',
  ...over,
})

/** The catalog's product reads, for the two things candidatesFor asks it: the summaries of the rows' pinned formulations, and a product's latest ingredient list (the method PR 5 adds). */
class FakeProductReads {
  private summaries = new Map<string, ProductSummary>()
  private lists = new Map<string, string[]>()

  summaryOf(recommendation: Recommendation): ProductSummary {
    return { id: recommendation.productId, kind: 'named', brand: `Brand ${recommendation.code}`, name: `Name ${recommendation.code}`, variant: null, form: null, category: 'skin', imageUrl: null }
  }

  addRow(recommendation: Recommendation): void {
    this.summaries.set(recommendation.formulationId, this.summaryOf(recommendation))
  }

  /** A product the user named, with the ingredient list its latest formulation holds. */
  knowProduct(productId: string, ingredients: string[]): void {
    this.lists.set(productId, ingredients)
  }

  async productSummaries(formulationIds: string[]): Promise<Map<string, ProductSummary>> {
    return new Map(formulationIds.flatMap((id): [string, ProductSummary][] => (this.summaries.has(id) ? [[id, this.summaries.get(id)!]] : [])))
  }

  async latestIngredients(productId: string): Promise<string[] | null> {
    return this.lists.get(productId) ?? null
  }
}

/**
 * The catalog the safety parse resolves a named product against: every product is found, with an id made from its name. A product named
 * `Unresearched` is in the catalog with no ingredient list and research finds none, so the parse marks it unresolved but keeps its product id.
 */
class ScriptedCatalog {
  async resolve(identity: ProductIdentity): Promise<ResolveResult> {
    if (identity.name === 'Unresearched') return { kind: 'needs-research', productId: 'product-Unresearched' }
    return { kind: 'ready', productId: `product-${identity.name}`, formulationId: `formulation-${identity.name}` }
  }

  async research(productId: string): Promise<ResearchResult> {
    if (productId === 'product-Unresearched') return { kind: 'not-found' }
    return { kind: 'found', formulationId: `formulation-${productId}` }
  }
}

const REACTION_TEXT = 'my reaction words'
const PRESCRIPTION_TEXT = 'my prescription words'
/** A product the user named, with its maker (so the parse resolves it to `product-<name>`). */
const named = (name: string): Mention => ({ kind: 'product', brand: name, name, category: 'skin' })
/** A product the user named with no maker ("the white tub from the market"): the catalog cannot take it, so it is unresolved with no product. */
const unnamed = (name: string): Mention => ({ kind: 'product', brand: null, name, category: 'skin' })
const ingredient = (name: string): Mention => ({ kind: 'ingredient', name })

const setup = () => {
  let clock = T0
  let n = 0
  const workbook = new FakeCatalogWorkbook().addCountry(NG).addCountry(GB).setRules(RULES)
  const products = new FakeProductReads()
  const face = { skinType: null as SkinTypeLabel | null }
  const safetyRepository = new FakeSafetyRepository()
  const reader = new MemoryMentionReader()
  const safety = new SafetyService({ repository: safetyRepository, reader, catalog: new ScriptedCatalog(), jobs: new MemoryJobQueue(), now: () => clock, newId: () => `safety-${++n}` })
  const goals = new GoalsService({ repository: new FakeGoalsRepository(), reader: new MemoryGoalReader(), safety, now: () => clock, newId: () => `goal-${++n}` })
  const repository = new FakeRecommendationsRepository()
  const service = new RecommendationService({
    repository,
    goals,
    safety,
    workbook,
    faceScans: { latestSkinType: async () => face.skinType },
    catalog: products,
    now: () => clock,
    newId: () => `shopping-${++n}`,
  })
  return { service, repository, workbook, products, face, safety, safetyRepository, reader, goals, tick: () => (clock = new Date(clock.getTime() + MINUTE)) }
}
type Ctx = ReturnType<typeof setup>

const asUser = <T>(who: Actor, fn: () => Promise<T>) => runAs(who, fn)

const setGoal = (ctx: Ctx, goal: Goal, who: Actor = AMARA) => asUser(who, () => ctx.goals.set({ goal }))
const setSafety = (ctx: Ctx, choices: SafetyChoice[], who: Actor = AMARA) => asUser(who, () => ctx.safety.set({ choices }))
const setShopping = (ctx: Ctx, country: string, budgetBand?: string, who: Actor = AMARA) =>
  asUser(who, () => ctx.service.setShopping(budgetBand === undefined ? { country } : { country, budgetBand }))
const candidates = (ctx: Ctx, step: RoutineStep = 'moisturise', who: Actor = AMARA) => asUser(who, () => ctx.service.candidatesFor({ step }))
const codesOf = async (ctx: Ctx, step: RoutineStep = 'moisturise', who: Actor = AMARA) => (await candidates(ctx, step, who)).map((candidate) => candidate.code)

/** A user who can be asked for candidates: a goal (glow, whose concerns are hd_radiance, hd_moisture and hd_texture), safety answers and a shopping country. */
const ready = async (ctx: Ctx, over: { goal?: Goal; choices?: SafetyChoice[]; country?: string; band?: string; who?: Actor } = {}) => {
  const who = over.who ?? AMARA
  await setGoal(ctx, over.goal ?? 'glow', who)
  await setSafety(ctx, over.choices ?? ['none'], who)
  await setShopping(ctx, over.country ?? 'NG', over.band, who)
}

/** Puts rows on offer in a country and in the product reads. */
const stock = (ctx: Ctx, rows: Recommendation[], country = 'NG') => {
  for (const r of rows) {
    ctx.workbook.offer(country, r)
    ctx.products.addRow(r)
  }
}

/**
 * Saves the safety answer with these mentions and runs the real parse of its words, so the stored mentions are what the parse really makes of them.
 * `parsed: false` leaves the parse to run later, as in the first minutes after saving.
 */
const mentioning = async (ctx: Ctx, over: { reaction?: Mention[]; prescription?: Mention[]; choices?: SafetyChoice[]; parsed?: boolean } = {}, who: Actor = AMARA) => {
  const choices: SafetyChoice[] = [...(over.choices ?? []), ...(over.reaction ? (['reaction'] as const) : []), ...(over.prescription ? (['prescription'] as const) : [])]
  ctx.reader.respondWith((text) => (text === REACTION_TEXT ? (over.reaction ?? []) : text === PRESCRIPTION_TEXT ? (over.prescription ?? []) : []))
  await asUser(who, () =>
    ctx.safety.set({
      choices,
      ...(over.reaction ? { reactionText: REACTION_TEXT } : {}),
      ...(over.prescription ? { prescriptionText: PRESCRIPTION_TEXT } : {}),
    }),
  )
  if (over.parsed === false) return
  if (who.kind !== 'user') throw new Error('an answer needs a user')
  const safetyId = (await ctx.safetyRepository.current(who.profileId))!.id
  await runAs(SYSTEM, () => ctx.safety.parse(safetyId))
}

describe('RecommendationService.setShopping and currentShopping', () => {
  it('saves the country and band for the caller\'s profile and answers them with the time they were set', async () => {
    const ctx = setup()

    const view = await setShopping(ctx, 'NG', 'mid')

    expect(view).toEqual({ country: 'NG', budgetBand: 'mid', updatedAt: T0 })
    expect(await asUser(AMARA, () => ctx.service.currentShopping())).toEqual(view)
  })

  it('answers no band as null, not as a band, when none is given', async () => {
    const ctx = setup()

    expect(await setShopping(ctx, 'NG')).toEqual({ country: 'NG', budgetBand: null, updatedAt: T0 })
  })

  it('gives a guest the same as a verified user', async () => {
    const ctx = setup()

    expect(await setShopping(ctx, 'NG', 'low', TOLU)).toMatchObject({ country: 'NG', budgetBand: 'low' })
  })

  it('keeps every change, and the newest is the current one: a band can be taken back by saying the country alone', async () => {
    const ctx = setup()
    await setShopping(ctx, 'NG', 'mid')
    ctx.tick()
    await setShopping(ctx, 'GB', 'high')
    ctx.tick()
    await setShopping(ctx, 'GB')

    expect((await ctx.repository.history('profile-amara-1')).map((r) => [r.country, r.budgetBand])).toEqual([
      ['GB', null],
      ['GB', 'high'],
      ['NG', 'mid'],
    ])
    expect(await asUser(AMARA, () => ctx.service.currentShopping())).toMatchObject({ country: 'GB', budgetBand: null })
  })

  it.each([
    ['a country that is not in the Countries tab', 'ZZ'],
    ['an empty country', ''],
  ])('refuses %s with UNKNOWN_COUNTRY, and stores nothing', async (_label, country) => {
    const ctx = setup()

    const error = await errorOf(setShopping(ctx, country, 'mid'))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe('UNKNOWN_COUNTRY')
    expect(await ctx.repository.history('profile-amara-1')).toEqual([])
  })

  it('refuses a retired country with UNKNOWN_COUNTRY: a retired country is no longer served', async () => {
    const ctx = setup()
    ctx.workbook.retireCountry('GB')

    const error = await errorOf(setShopping(ctx, 'GB'))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe('UNKNOWN_COUNTRY')
    expect(await ctx.repository.history('profile-amara-1')).toEqual([])
  })

  it.each(['platinum', 'MID', ''])('refuses the band "%s", which is not low, mid or high, with UNKNOWN_BUDGET_BAND, and stores nothing', async (band) => {
    const ctx = setup()

    const error = await errorOf(setShopping(ctx, 'NG', band))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe('UNKNOWN_BUDGET_BAND')
    expect(await ctx.repository.history('profile-amara-1')).toEqual([])
  })

  it.each(['low', 'mid', 'high'])('accepts the %s band', async (band) => {
    const ctx = setup()

    expect(await setShopping(ctx, 'NG', band)).toMatchObject({ budgetBand: band })
  })

  it('is 404 SHOPPING_NOT_SET for a profile that never set one', async () => {
    const ctx = setup()

    const error = await errorOf(asUser(AMARA, () => ctx.service.currentShopping()))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('SHOPPING_NOT_SET')
  })

  it('keeps one profile\'s fact from another account and from another profile of the same account', async () => {
    const ctx = setup()
    await setShopping(ctx, 'NG', 'mid')

    expect((await errorOf(asUser(TOLU, () => ctx.service.currentShopping()))).code).toBe('SHOPPING_NOT_SET')
    expect((await errorOf(asUser(AMARA_SECOND_PROFILE, () => ctx.service.currentShopping()))).code).toBe('SHOPPING_NOT_SET')
    await setShopping(ctx, 'GB', undefined, AMARA_SECOND_PROFILE)
    expect(await asUser(AMARA, () => ctx.service.currentShopping())).toMatchObject({ country: 'NG', budgetBand: 'mid' })
  })

  it('needs a user: a caller with no session is UnauthorizedError from both', async () => {
    const ctx = setup()

    expect(await errorOf(asUser(PUBLIC, () => ctx.service.setShopping({ country: 'NG' })))).toBeInstanceOf(UnauthorizedError)
    expect(await errorOf(asUser(PUBLIC, () => ctx.service.currentShopping()))).toBeInstanceOf(UnauthorizedError)
  })
})

describe('RecommendationService.candidatesFor: what it needs first', () => {
  it('is 409 GOAL_REQUIRED for a profile with no goal, even when it has answered everything else', async () => {
    const ctx = setup()
    await setSafety(ctx, ['none'])
    await setShopping(ctx, 'NG')

    const error = await errorOf(candidates(ctx))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('GOAL_REQUIRED')
  })

  it('is 409 SAFETY_ANSWERS_REQUIRED once there is a goal but no safety answer ("none of these" is an answer)', async () => {
    const ctx = setup()
    await setGoal(ctx, 'glow')
    await setShopping(ctx, 'NG')

    const error = await errorOf(candidates(ctx))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('SAFETY_ANSWERS_REQUIRED')
  })

  it('is 409 SHOPPING_REQUIRED once there is a goal and safety answers but no shopping fact', async () => {
    const ctx = setup()
    await setGoal(ctx, 'glow')
    await setSafety(ctx, ['none'])

    const error = await errorOf(candidates(ctx))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('SHOPPING_REQUIRED')
  })

  it('needs a user: a caller with no session is UnauthorizedError', async () => {
    const ctx = setup()

    expect(await errorOf(candidates(ctx, 'moisturise', PUBLIC))).toBeInstanceOf(UnauthorizedError)
  })

  it('answers an empty list, not an error, when nothing is on offer', async () => {
    const ctx = setup()
    await ready(ctx)

    expect(await candidates(ctx)).toEqual([])
  })
})

describe('RecommendationService.candidatesFor: the filters, each on its own', () => {
  it('asks the workbook for the shopping country and the step it was asked about, and offers nothing sold only elsewhere', async () => {
    const ctx = setup()
    stock(ctx, [row('SOLD-IN-NG')], 'NG')
    stock(ctx, [row('SOLD-IN-GB')], 'GB')
    await ready(ctx, { country: 'NG' })

    expect(await codesOf(ctx, 'moisturise')).toEqual(['SOLD-IN-NG'])
    expect(ctx.workbook.asked).toEqual([{ country: 'NG', step: 'moisturise' }])
  })

  it('follows the newest shopping fact when the country changes', async () => {
    const ctx = setup()
    stock(ctx, [row('SOLD-IN-NG')], 'NG')
    stock(ctx, [row('SOLD-IN-GB')], 'GB')
    await ready(ctx, { country: 'NG' })
    ctx.tick()
    await setShopping(ctx, 'GB')

    expect(await codesOf(ctx)).toEqual(['SOLD-IN-GB'])
  })

  it('offers only the rows that fill the step asked about, and a row for two steps for either', async () => {
    const ctx = setup()
    stock(ctx, [row('CLEANSER', { steps: ['cleanse'] }), row('CREAM', { steps: ['moisturise'] }), row('BOTH', { steps: ['cleanse', 'moisturise'] })])
    await ready(ctx)

    expect(await codesOf(ctx, 'cleanse')).toEqual(['BOTH', 'CLEANSER'])
    expect(await codesOf(ctx, 'moisturise')).toEqual(['BOTH', 'CREAM'])
    expect(await codesOf(ctx, 'protect')).toEqual([])
  })

  it('keeps a row only when it works on at least one of the goal\'s concerns (glow: hd_radiance, hd_moisture, hd_texture)', async () => {
    const ctx = setup()
    stock(ctx, [
      row('LAST-CONCERN', { skinConcerns: ['hd_texture'] }),
      row('ONE-OF-TWO', { skinConcerns: ['hd_acne', 'hd_moisture'] }),
      row('OTHER-ONLY', { skinConcerns: ['hd_acne'] }),
      row('OTHER-TWO', { skinConcerns: ['hd_pore', 'hd_oiliness'] }),
    ])
    await ready(ctx, { goal: 'glow' })

    expect(await codesOf(ctx)).toEqual(['LAST-CONCERN', 'ONE-OF-TWO'])
  })

  it('reads the concerns from the goal: the same rows give a different answer for clear-skin (hd_acne, hd_pore, hd_oiliness)', async () => {
    const ctx = setup()
    stock(ctx, [row('FOR-GLOW', { skinConcerns: ['hd_radiance'] }), row('FOR-SPOTS', { skinConcerns: ['hd_acne'] })])
    await ready(ctx, { goal: 'clear-skin' })

    expect(await codesOf(ctx)).toEqual(['FOR-SPOTS'])
  })

  describe('skin type', () => {
    const rows = () => [
      row('FOR-ALL', { skinTypes: 'all' }),
      row('DRY-ONLY', { skinTypes: ['dry'] }),
      row('OILY-OR-DRY', { skinTypes: ['oily', 'dry'] }),
      row('OILY-ONLY', { skinTypes: ['oily'] }),
      row('COMBINATION-NORMAL', { skinTypes: ['combination', 'normal'] }),
    ]

    it('keeps rows that list the face scan\'s skin type, and rows for all skin types', async () => {
      const ctx = setup()
      stock(ctx, rows())
      ctx.face.skinType = 'dry'
      await ready(ctx)

      expect(await codesOf(ctx)).toEqual(['DRY-ONLY', 'FOR-ALL', 'OILY-OR-DRY'])
    })

    it('keeps only rows for all skin types when there is no skin type (no face scan), and never assumes one', async () => {
      const ctx = setup()
      stock(ctx, rows())
      ctx.face.skinType = null
      await ready(ctx)

      expect(await codesOf(ctx)).toEqual(['FOR-ALL'])
    })

    it('uses the skin type as it is when asked, so a later scan changes the answer', async () => {
      const ctx = setup()
      stock(ctx, rows())
      await ready(ctx)
      ctx.face.skinType = 'oily'
      const asOily = await codesOf(ctx)
      ctx.face.skinType = 'normal'
      const asNormal = await codesOf(ctx)

      expect(asOily).toEqual(['FOR-ALL', 'OILY-ONLY', 'OILY-OR-DRY'])
      expect(asNormal).toEqual(['COMBINATION-NORMAL', 'FOR-ALL'])
    })
  })

  describe('budget band', () => {
    // NG's bands: low is a price up to 5000, mid up to 15000, high has no cap. The price that counts is the lowest the product costs.
    it.each([
      ['low', 0, true],
      ['low', 5000, true],
      ['low', 5001, false],
      ['mid', 1000, true],
      ['mid', 15000, true],
      ['mid', 15001, false],
      ['high', 15001, true],
      ['high', 9_999_999, true],
    ])('with the %s band, a row whose lowest price is %i is kept: %s', async (band, priceMin, kept) => {
      const ctx = setup()
      stock(ctx, [row('PRICED', { priceMin, priceMax: priceMin + 100 })])
      await ready(ctx, { band })

      expect(await codesOf(ctx)).toEqual(kept ? ['PRICED'] : [])
    })

    it('goes by the lowest price, not the highest: a product that can cost 5000 and can cost 90000 is within the low band', async () => {
      const ctx = setup()
      stock(ctx, [row('WIDE-RANGE', { priceMin: 5000, priceMax: 90_000 })])
      await ready(ctx, { band: 'low' })

      expect(await codesOf(ctx)).toEqual(['WIDE-RANGE'])
    })

    it('takes the thresholds from the shopping country\'s own row: GB\'s low band is up to 15', async () => {
      const ctx = setup()
      stock(ctx, [row('AT-THE-EDGE', { priceMin: 15, priceMax: 20 }), row('A-POUND-OVER', { priceMin: 16, priceMax: 20 })], 'GB')
      await ready(ctx, { country: 'GB', band: 'low' })

      expect(await codesOf(ctx)).toEqual(['AT-THE-EDGE'])
    })

    it('lets every price through when no band was given', async () => {
      const ctx = setup()
      stock(ctx, [row('CHEAP', { priceMin: 100 }), row('DEAR', { priceMin: 9_999_999 })])
      await ready(ctx)

      expect(await codesOf(ctx)).toEqual(['CHEAP', 'DEAR'])
    })

    it('lets every price through after a band is taken back (the newest fact has none)', async () => {
      const ctx = setup()
      stock(ctx, [row('DEAR', { priceMin: 9_999_999 })])
      await ready(ctx, { band: 'low' })
      expect(await codesOf(ctx)).toEqual([])
      ctx.tick()
      await setShopping(ctx, 'NG')

      expect(await codesOf(ctx)).toEqual(['DEAR'])
    })
  })

  it('answers an empty list when the stored country has since been retired, and serves the user again once they choose another', async () => {
    const ctx = setup()
    stock(ctx, [row('SOLD-IN-NG')], 'NG')
    stock(ctx, [row('SOLD-IN-GB')], 'GB')
    await ready(ctx, { country: 'NG' })
    expect(await codesOf(ctx)).toEqual(['SOLD-IN-NG'])

    ctx.workbook.retireCountry('NG')

    expect(await candidates(ctx)).toEqual([])
    ctx.tick()
    await setShopping(ctx, 'GB')
    expect(await codesOf(ctx)).toEqual(['SOLD-IN-GB'])
  })
})

describe('RecommendationService.candidatesFor: the ingredient rules', () => {
  it.each([
    ['pregnant', ['pregnant'] as SafetyChoice[]],
    ['breastfeeding', ['breastfeeding'] as SafetyChoice[]],
    ['both', ['pregnant', 'breastfeeding'] as SafetyChoice[]],
  ])('leaves out a row whose ingredients flag a pregnancy caution when the user is %s, though the row claims nothing in its own cautions', async (_label, choices) => {
    const ctx = setup()
    stock(ctx, [row('HAS-RETINOL', { ingredients: ['Aqua', 'Retinol', 'Glycerin'], ownCautions: [] }), row('PLAIN')])
    await ready(ctx, { choices })

    expect(await codesOf(ctx)).toEqual(['PLAIN'])
  })

  it('reads the ingredients as the analysis does: a strength after the name is no way round the rule', async () => {
    const ctx = setup()
    stock(ctx, [row('RETINOL-STRENGTH', { ingredients: ['Aqua', 'Retinol 0.3%'] })])
    await ready(ctx, { choices: ['pregnant'] })

    expect(await codesOf(ctx)).toEqual([])
  })

  it('keeps a row that flags a pregnancy caution for a user who is neither pregnant nor breastfeeding', async () => {
    const ctx = setup()
    stock(ctx, [row('HAS-RETINOL', { ingredients: ['Aqua', 'Retinol'] })])
    await ready(ctx, { choices: ['none'] })

    expect(await codesOf(ctx)).toEqual(['HAS-RETINOL'])
  })

  it('keeps a row for a user whose other answers are ticked: reaction and prescription are not pregnancy', async () => {
    const ctx = setup()
    stock(ctx, [row('HAS-RETINOL', { ingredients: ['Aqua', 'Retinol'] })])
    await ready(ctx, { choices: ['reaction', 'prescription'] })

    expect(await codesOf(ctx)).toEqual(['HAS-RETINOL'])
  })

  it.each([
    ['by name', ['Aqua', 'Hydroquinone']],
    ['by an alias', ['Aqua', 'Quinol']],
    ['with a strength', ['Aqua', 'Hydroquinone 4%']],
  ])('always leaves out a row whose ingredients flag a banned substance, matched %s, for a user with no safety box ticked', async (_label, ingredients) => {
    const ctx = setup()
    stock(ctx, [row('BANNED', { ingredients }), row('PLAIN')])
    await ready(ctx, { choices: ['none'] })

    expect(await codesOf(ctx)).toEqual(['PLAIN'])
  })

  it('does not take a row out for the other kinds of caution (an allergen, an irritant): those are for the verdict, not the candidate list', async () => {
    const ctx = setup()
    stock(ctx, [row('SCENTED', { ingredients: ['Aqua', 'Parfum/Fragrance', 'Alcohol Denat.'] })])
    await ready(ctx, { choices: ['pregnant'] })

    expect(await codesOf(ctx)).toEqual(['SCENTED'])
  })

  it('applies the live approved rules the workbook hands back, and no others: with none live, nothing is flagged', async () => {
    const ctx = setup()
    ctx.workbook.setRules([])
    stock(ctx, [row('HAS-RETINOL', { ingredients: ['Aqua', 'Retinol'] }), row('HAS-HYDROQUINONE', { ingredients: ['Aqua', 'Hydroquinone'] })])
    await ready(ctx, { choices: ['pregnant'] })

    expect(await codesOf(ctx)).toEqual(['HAS-HYDROQUINONE', 'HAS-RETINOL'])
  })

  describe('a row\'s own cautions only ever narrow', () => {
    it('leaves out a row that lists a pregnancy caution of its own for a pregnant user, though no rule flags its ingredients', async () => {
      const ctx = setup()
      stock(ctx, [row('OWN-PREGNANCY', { ingredients: ['Aqua', 'Glycerin'], ownCautions: ['pregnancy-caution'] }), row('PLAIN')])
      await ready(ctx, { choices: ['pregnant'] })

      expect(await codesOf(ctx)).toEqual(['PLAIN'])
    })

    it('keeps a row with a pregnancy caution of its own for a user who is not pregnant or breastfeeding', async () => {
      const ctx = setup()
      stock(ctx, [row('OWN-PREGNANCY', { ownCautions: ['pregnancy-caution'] })])
      await ready(ctx, { choices: ['none'] })

      expect(await codesOf(ctx)).toEqual(['OWN-PREGNANCY'])
    })

    it('leaves out a row that lists a banned substance of its own, for everyone', async () => {
      const ctx = setup()
      stock(ctx, [row('OWN-BANNED', { ownCautions: ['banned-substance'] })])
      await ready(ctx, { choices: ['none'] })

      expect(await codesOf(ctx)).toEqual([])
    })

    it('does not take a row out for another caution of its own (irritation)', async () => {
      const ctx = setup()
      stock(ctx, [row('OWN-IRRITATION', { ownCautions: ['irritation'] })])
      await ready(ctx, { choices: ['pregnant'] })

      expect(await codesOf(ctx)).toEqual(['OWN-IRRITATION'])
    })

    it('never lets a row\'s own cautions put back what the rules took out: a row that lists only an irritation, with retinol in its ingredients, stays out', async () => {
      const ctx = setup()
      stock(ctx, [row('RETINOL-IRRITATION', { ingredients: ['Aqua', 'Retinol'], ownCautions: ['irritation'] })])
      await ready(ctx, { choices: ['pregnant'] })

      expect(await codesOf(ctx)).toEqual([])
    })
  })
})

describe('RecommendationService.candidatesFor: what the user said reacted, or that they use', () => {
  it.each([
    ['reaction', 'reaction' as const],
    ['prescription', 'prescription' as const],
  ])('leaves out the recommended row that is the same product as a product named in the %s words, by its product id', async (_label, source) => {
    const ctx = setup()
    stock(ctx, [row('CARO-WHITE', { productId: 'product-Caro White' }), row('PLAIN')])
    await ready(ctx)
    await mentioning(ctx, { [source]: [named('Caro White')] })

    expect(await codesOf(ctx)).toEqual(['PLAIN'])
  })

  it('leaves out only that product: other products the user named stay recommendable', async () => {
    const ctx = setup()
    stock(ctx, [row('CARO-WHITE', { productId: 'product-Caro White' }), row('OTHER', { productId: 'product-Other' })])
    await ready(ctx)
    await mentioning(ctx, { reaction: [named('Caro White')] })

    expect(await codesOf(ctx)).toEqual(['OTHER'])
  })

  it('leaves out nothing for a product named with no maker, which the catalog cannot take: it has no product id to match by', async () => {
    const ctx = setup()
    stock(ctx, [row('FIRST'), row('SECOND')])
    await ready(ctx)
    await mentioning(ctx, { reaction: [unnamed('the white tub from the market')] })

    expect(await codesOf(ctx)).toEqual(['FIRST', 'SECOND'])
  })

  it.each([
    ['reaction', 'reaction' as const],
    ['prescription', 'prescription' as const],
  ])('leaves out the row that is the same product as one named in the %s words even when the parse could not resolve it (research found no ingredients), because the id still matches', async (_label, source) => {
    const ctx = setup()
    stock(ctx, [row('UNRESEARCHED', { productId: 'product-Unresearched' }), row('PLAIN')])
    await ready(ctx)
    await mentioning(ctx, { [source]: [named('Unresearched')] })
    // The state this test is about, reached by the real parse: unresolved, with the catalog's product id kept.
    expect(await asUser(AMARA, () => ctx.safety.currentMentions())).toMatchObject([{ kind: 'product', resolution: 'unresolved', productId: 'product-Unresearched' }])

    expect(await codesOf(ctx)).toEqual(['PLAIN'])
  })

  it.each([
    ['the same word in another case', 'FRAGRANCE', ['Aqua', 'Parfum/Fragrance']],
    ['one side of a slash', 'fragrance', ['Aqua', 'Parfum/Fragrance']],
    ['the other side of a slash', 'Parfum', ['Aqua', 'Parfum/Fragrance']],
    ['the word inside a bracket', 'water', ['Aqua (Water)', 'Glycerin']],
    ['a name that carries a strength on the label', 'hydroquinone', ['Aqua', 'Hydroquinone 4%']],
    ['a trailing full stop on the label', 'alcohol denat', ['Aqua', 'Alcohol Denat.']],
  ])('leaves out a row with an ingredient the user named as having reacted: %s', async (_label, mention, ingredients) => {
    const ctx = setup()
    stock(ctx, [row('HAS-IT', { ingredients }), row('PLAIN', { ingredients: ['Squalane'] })])
    await ready(ctx)
    await mentioning(ctx, { reaction: [ingredient(mention)] })

    expect(await codesOf(ctx)).toEqual(['PLAIN'])
  })

  it('leaves out a row with an ingredient the prescription words name, the same way', async () => {
    const ctx = setup()
    stock(ctx, [row('HAS-TRETINOIN', { ingredients: ['Aqua', 'Tretinoin'] }), row('PLAIN')])
    await ready(ctx)
    await mentioning(ctx, { prescription: [ingredient('tretinoin')] })

    expect(await codesOf(ctx)).toEqual(['PLAIN'])
  })

  it('matches a whole ingredient, never part of a name: "alcohol" takes out a row that lists "Alcohol", and not one that lists "Cetearyl Alcohol"', async () => {
    const ctx = setup()
    stock(ctx, [row('FATTY-ALCOHOL', { ingredients: ['Aqua', 'Cetearyl Alcohol'] }), row('ALCOHOL', { ingredients: ['Aqua', 'Alcohol'] })])
    await ready(ctx)
    await mentioning(ctx, { reaction: [ingredient('alcohol')] })

    expect(await codesOf(ctx)).toEqual(['FATTY-ALCOHOL'])
  })

  it('applies the ticked boxes alone while the words are still waiting to be parsed: no mentions yet, nothing left out by them', async () => {
    const ctx = setup()
    stock(ctx, [row('CARO-WHITE', { productId: 'product-Caro White' }), row('SCENTED', { ingredients: ['Aqua', 'Parfum/Fragrance'] }), row('HAS-RETINOL', { ingredients: ['Aqua', 'Retinol'] })])
    await ready(ctx)
    await mentioning(ctx, { choices: ['pregnant'], reaction: [named('Caro White'), ingredient('fragrance')], parsed: false })

    expect(await codesOf(ctx)).toEqual(['CARO-WHITE', 'SCENTED'])
  })

  describe('a name the rules list under more than one label', () => {
    // Rules carry the labels people use for one thing: "parfum" is also "fragrance", "tretinoin" is also "retinoic acid". Matching a named ingredient to a row by
    // the rules' own labels is not fuzzy: it knows exactly the synonyms the reviewed rules list, and no others.
    const withTretinoin = (ctx: Ctx) => ctx.workbook.setRules([...RULES, rule('tretinoin', 'restricted-substance', ['retinoic acid'])])

    it.each([
      ['a reaction to "fragrance" leaves out a row that lists "Parfum"', 'reaction' as const, 'fragrance', ['Aqua', 'Parfum']],
      ['a reaction to "Parfum" leaves out a row that lists "Fragrance"', 'reaction' as const, 'Parfum', ['Aqua', 'Fragrance']],
      ['a reaction to "fragrance" leaves out a row that lists "Parfum/Fragrance"', 'reaction' as const, 'fragrance', ['Aqua', 'Parfum/Fragrance']],
      ['a prescription of "retinoic acid" leaves out a row that lists "Tretinoin"', 'prescription' as const, 'retinoic acid', ['Aqua', 'Tretinoin']],
      ['a prescription of "Tretinoin" leaves out a row that lists "Retinoic Acid 0.05%"', 'prescription' as const, 'Tretinoin', ['Aqua', 'Retinoic Acid 0.05%']],
    ])('%s', async (_label, source, mention, ingredients) => {
      const ctx = setup()
      withTretinoin(ctx)
      stock(ctx, [row('HAS-IT', { ingredients }), row('PLAIN', { ingredients: ['Squalane'] })])
      await ready(ctx)
      await mentioning(ctx, { [source]: [ingredient(mention)] })

      expect(await codesOf(ctx)).toEqual(['PLAIN'])
    })

    it('does not guess at a synonym no rule lists: "perfume" is not "parfum", so the row stays', async () => {
      const ctx = setup()
      stock(ctx, [row('SCENTED', { ingredients: ['Aqua', 'Parfum'] })])
      await ready(ctx)
      await mentioning(ctx, { reaction: [ingredient('perfume')] })

      expect(await codesOf(ctx)).toEqual(['SCENTED'])
    })

    it('uses only the live rules: with none live, "fragrance" no longer finds "Parfum"', async () => {
      const ctx = setup()
      ctx.workbook.setRules([])
      stock(ctx, [row('SCENTED', { ingredients: ['Aqua', 'Parfum'] })])
      await ready(ctx)
      await mentioning(ctx, { reaction: [ingredient('fragrance')] })

      expect(await codesOf(ctx)).toEqual(['SCENTED'])
    })

    it('takes only the labels of a rule the named ingredient is one of: naming "fragrance" says nothing of "alcohol denat"', async () => {
      const ctx = setup()
      stock(ctx, [row('ALCOHOL', { ingredients: ['Aqua', 'Alcohol Denat.'] })])
      await ready(ctx)
      await mentioning(ctx, { reaction: [ingredient('fragrance')] })

      expect(await codesOf(ctx)).toEqual(['ALCOHOL'])
    })
  })

  describe('the same product listed again under another spelling', () => {
    // A row can be a second entry for a product the user named (the workbook joins exactly, so a different spelling is a different product id). Its ingredient
    // list, read as the catalog reads a list (case, spacing and order), is then that of the product they named.
    const dupeOf = (ctx: Ctx) => {
      ctx.products.knowProduct('product-Caro White', ['Aqua', 'Glycerin', 'Niacinamide'])
      ctx.products.knowProduct('product-Dermovate', ['Aqua', 'Squalane'])
      stock(ctx, [
        row('CARO-DUPE', { productId: 'product-caro-white-2', ingredients: ['aqua', 'GLYCERIN ', 'Niacinamide'] }),
        row('DERMOVATE-DUPE', { productId: 'product-dermovate-2', ingredients: ['Aqua', 'squalane'] }),
        row('SAME-INGREDIENTS-REORDERED', { ingredients: ['Glycerin', 'Aqua', 'Niacinamide'] }),
        row('PLAIN', { ingredients: ['Squalane'] }),
      ])
    }

    it('leaves out a row whose ingredient list is that of a product the user said gave a reaction', async () => {
      const ctx = setup()
      dupeOf(ctx)
      await ready(ctx)
      await mentioning(ctx, { reaction: [named('Caro White')] })

      expect(await codesOf(ctx)).toEqual(['DERMOVATE-DUPE', 'PLAIN', 'SAME-INGREDIENTS-REORDERED'])
    })

    it('leaves out a row whose ingredient list is that of a product the user said they use on prescription', async () => {
      const ctx = setup()
      dupeOf(ctx)
      await ready(ctx)
      await mentioning(ctx, { prescription: [named('Dermovate')] })

      expect(await codesOf(ctx)).toEqual(['CARO-DUPE', 'PLAIN', 'SAME-INGREDIENTS-REORDERED'])
    })

    it('does so for both at once, and an order of ingredients that differs is a different list (the order is part of the formulation)', async () => {
      const ctx = setup()
      dupeOf(ctx)
      await ready(ctx)
      await mentioning(ctx, { reaction: [named('Caro White')], prescription: [named('Dermovate')] })

      expect(await codesOf(ctx)).toEqual(['PLAIN', 'SAME-INGREDIENTS-REORDERED'])
    })

    it('has nothing to compare for a product the catalog holds no list for, or that could not be resolved: the rows stay', async () => {
      const ctx = setup()
      stock(ctx, [row('FIRST', { productId: 'product-first' }), row('SECOND', { productId: 'product-second' })])
      await ready(ctx)
      await mentioning(ctx, { reaction: [named('No List Yet'), unnamed('the white tub')] })

      expect(await codesOf(ctx)).toEqual(['FIRST', 'SECOND'])
    })

    it('applies to nothing while the words are not parsed yet, and to the newest answer only', async () => {
      const ctx = setup()
      dupeOf(ctx)
      await ready(ctx)
      await mentioning(ctx, { reaction: [named('Caro White')], parsed: false })
      expect(await codesOf(ctx)).toEqual(['CARO-DUPE', 'DERMOVATE-DUPE', 'PLAIN', 'SAME-INGREDIENTS-REORDERED'])
      ctx.tick()
      await mentioning(ctx, { reaction: [named('Caro White')] })
      expect(await codesOf(ctx)).toEqual(['DERMOVATE-DUPE', 'PLAIN', 'SAME-INGREDIENTS-REORDERED'])
      ctx.tick()

      await setSafety(ctx, ['none'])

      expect(await codesOf(ctx)).toEqual(['CARO-DUPE', 'DERMOVATE-DUPE', 'PLAIN', 'SAME-INGREDIENTS-REORDERED'])
    })
  })

  it('uses the words as they are once they are parsed, and the newest answer only: an earlier reaction no longer counts', async () => {
    const ctx = setup()
    stock(ctx, [row('CARO-WHITE', { productId: 'product-Caro White' })])
    await ready(ctx)
    await mentioning(ctx, { reaction: [named('Caro White')] })
    expect(await codesOf(ctx)).toEqual([])
    ctx.tick()

    await setSafety(ctx, ['none'])

    expect(await codesOf(ctx)).toEqual(['CARO-WHITE'])
  })
})

describe('RecommendationService.candidatesFor: sharedWithReaction', () => {
  it('lists, for each product the user said gave a reaction, the candidate\'s ingredients that are also in that product\'s latest formulation, spelled as the candidate has them', async () => {
    const ctx = setup()
    ctx.products.knowProduct('product-Caro White', ['Aqua', 'Glycerin', 'Niacinamide', 'Hydroquinone'])
    stock(ctx, [row('SHARES-TWO', { ingredients: ['Aqua', 'Squalane', 'NIACINAMIDE'] })])
    await ready(ctx)
    await mentioning(ctx, { reaction: [named('Caro White')] })

    const [candidate] = await candidates(ctx)

    expect(candidate!.sharedWithReaction).toEqual([{ productId: 'product-Caro White', ingredients: ['Aqua', 'NIACINAMIDE'] }])
  })

  it('compares ingredients the way the rules do: a bracket and a slash are no way round it', async () => {
    const ctx = setup()
    ctx.products.knowProduct('product-Caro White', ['Water', 'Fragrance', 'Hydroquinone'])
    stock(ctx, [row('SHARES-THREE', { ingredients: ['Aqua (Water)', 'Parfum/Fragrance', 'Squalane 4%'] })])
    await ready(ctx)
    await mentioning(ctx, { reaction: [named('Caro White')] })

    const [candidate] = await candidates(ctx)

    expect(candidate!.sharedWithReaction).toEqual([{ productId: 'product-Caro White', ingredients: ['Aqua (Water)', 'Parfum/Fragrance'] }])
  })

  it('compares ingredients through the rules\' own labels: the reaction product\'s "Fragrance" is the candidate\'s "Parfum"', async () => {
    const ctx = setup()
    ctx.products.knowProduct('product-Caro White', ['Aqua', 'Fragrance'])
    stock(ctx, [row('SCENTED', { ingredients: ['Water', 'Parfum', 'Squalane'] })])
    await ready(ctx)
    await mentioning(ctx, { reaction: [named('Caro White')] })

    const [candidate] = await candidates(ctx)

    expect(candidate!.sharedWithReaction).toEqual([{ productId: 'product-Caro White', ingredients: ['Parfum'] }])
  })

  it('is information only: a candidate that shares ingredients with the reaction product is still a candidate', async () => {
    const ctx = setup()
    ctx.products.knowProduct('product-Caro White', ['Aqua', 'Glycerin'])
    stock(ctx, [row('SHARES', { ingredients: ['Aqua', 'Glycerin', 'Squalane'] }), row('SHARES-NOTHING', { ingredients: ['Squalane'] })])
    await ready(ctx)
    await mentioning(ctx, { reaction: [named('Caro White')] })

    expect(await codesOf(ctx)).toEqual(['SHARES', 'SHARES-NOTHING'])
  })

  it('has an entry for each reaction product that shares something, in the order the user named them, and none for one that shares nothing', async () => {
    const ctx = setup()
    ctx.products.knowProduct('product-Caro White', ['Aqua', 'Niacinamide'])
    ctx.products.knowProduct('product-Fair & White', ['Squalane'])
    ctx.products.knowProduct('product-Clean & Clear', ['Glycerin', 'Aqua'])
    stock(ctx, [row('CANDIDATE', { ingredients: ['Aqua', 'Glycerin'] })])
    await ready(ctx)
    await mentioning(ctx, { reaction: [named('Caro White'), named('Fair & White'), named('Clean & Clear')] })

    const [candidate] = await candidates(ctx)

    expect(candidate!.sharedWithReaction).toEqual([
      { productId: 'product-Caro White', ingredients: ['Aqua'] },
      { productId: 'product-Clean & Clear', ingredients: ['Aqua', 'Glycerin'] },
    ])
  })

  it('is empty when the user named no reaction product, and for a product named only as a prescription (that one is for the exclusion, not for this)', async () => {
    const ctx = setup()
    ctx.products.knowProduct('product-Dermovate', ['Aqua', 'Glycerin'])
    stock(ctx, [row('CANDIDATE', { ingredients: ['Aqua', 'Glycerin', 'Squalane'] })])
    await ready(ctx)
    expect((await candidates(ctx))[0]!.sharedWithReaction).toEqual([])

    await mentioning(ctx, { prescription: [named('Dermovate')] })

    expect((await candidates(ctx))[0]!.sharedWithReaction).toEqual([])
  })

  it('has no entry for a reaction product the catalog holds no ingredient list for, or one that could not be resolved', async () => {
    const ctx = setup()
    stock(ctx, [row('CANDIDATE', { ingredients: ['Aqua', 'Glycerin'] })])
    await ready(ctx)
    await mentioning(ctx, { reaction: [named('No List Yet'), unnamed('the white tub')] })

    expect((await candidates(ctx))[0]!.sharedWithReaction).toEqual([])
  })
})

describe('RecommendationService.candidatesFor: the order, and who pays', () => {
  it('lists the cheapest first (by the lowest price), whatever order the workbook gave them in', async () => {
    const ctx = setup()
    stock(ctx, [row('DEAR', { priceMin: 9000 }), row('MID', { priceMin: 4000 }), row('CHEAP', { priceMin: 1500 })])
    await ready(ctx)

    expect(await codesOf(ctx)).toEqual(['CHEAP', 'MID', 'DEAR'])
  })

  it('breaks a tie in price by code, ascending', async () => {
    const ctx = setup()
    stock(ctx, [row('C-ROW', { priceMin: 3000 }), row('A-ROW', { priceMin: 3000 }), row('B-ROW', { priceMin: 3000 })])
    await ready(ctx)

    expect(await codesOf(ctx)).toEqual(['A-ROW', 'B-ROW', 'C-ROW'])
  })

  it.each([
    ['A-ROW sourced, B-ROW brand-submitted', 'sourced' as Origin, 'brand-submitted' as Origin],
    ['A-ROW brand-submitted, B-ROW sourced', 'brand-submitted' as Origin, 'sourced' as Origin],
  ])('puts two rows that differ only in origin in the same order whichever way round the origins are and whichever way round they come in (%s)', async (_label, originA, originB) => {
    const forward = setup()
    stock(forward, [row('A-ROW', { origin: originA }), row('B-ROW', { origin: originB })])
    await ready(forward)
    const reversed = setup()
    stock(reversed, [row('B-ROW', { origin: originB }), row('A-ROW', { origin: originA })])
    await ready(reversed)

    expect(await codesOf(forward)).toEqual(['A-ROW', 'B-ROW'])
    expect(await codesOf(reversed)).toEqual(['A-ROW', 'B-ROW'])
  })

  it('puts a cheaper sourced row ahead of a dearer brand-submitted one, and the other way round: only the price decides', async () => {
    const ctx = setup()
    stock(ctx, [row('SOURCED-DEAR', { origin: 'sourced', priceMin: 4000 }), row('BRAND-CHEAP', { origin: 'brand-submitted', priceMin: 2000 })])
    await ready(ctx)
    expect(await codesOf(ctx)).toEqual(['BRAND-CHEAP', 'SOURCED-DEAR'])

    const flipped = setup()
    stock(flipped, [row('SOURCED-CHEAP', { origin: 'sourced', priceMin: 2000 }), row('BRAND-DEAR', { origin: 'brand-submitted', priceMin: 4000 })])
    await ready(flipped)
    expect(await codesOf(flipped)).toEqual(['SOURCED-CHEAP', 'BRAND-DEAR'])
  })
})

describe('RecommendationService.candidatesFor: what a candidate carries', () => {
  it('carries its code, the product it is (from its pinned formulation), and the row\'s own facts for the routine to show', async () => {
    const ctx = setup()
    const only = row('NIVEA-SOFT', { origin: 'brand-submitted', frequency: 'pm', priceMin: 1800, priceMax: 2500, whereSold: 'Supermarkets and pharmacies' })
    stock(ctx, [only])
    await ready(ctx)

    const [candidate] = await candidates(ctx)

    expect(candidate).toMatchObject({
      code: 'NIVEA-SOFT',
      product: ctx.products.summaryOf(only),
      sharedWithReaction: [],
      origin: 'brand-submitted',
      frequency: 'pm',
      priceMin: 1800,
      priceMax: 2500,
      whereSold: 'Supermarkets and pharmacies',
    })
  })

  it('carries the row\'s skin concerns, ingredients, evidence links and ingredients source link, as the row lists them', async () => {
    const ctx = setup()
    stock(ctx, [
      row('FACTS', {
        skinConcerns: ['hd_moisture', 'hd_texture'],
        ingredients: ['Aqua', 'Glycerin', 'Squalane'],
        evidenceUrls: ['https://example.com/study-b', 'https://example.com/study-a'],
        ingredientsSourceUrl: 'https://example.com/the-label',
      }),
    ])
    await ready(ctx)

    const [candidate] = await candidates(ctx)

    expect(candidate).toMatchObject({
      code: 'FACTS',
      skinConcerns: ['hd_moisture', 'hd_texture'],
      ingredients: ['Aqua', 'Glycerin', 'Squalane'],
      evidenceUrls: ['https://example.com/study-b', 'https://example.com/study-a'],
      ingredientsSourceUrl: 'https://example.com/the-label',
    })
  })

  it('still offers a row with no evidence links and no ingredients source link, with an empty list and a null', async () => {
    const ctx = setup()
    stock(ctx, [row('NO-LINKS', { evidenceUrls: [], ingredientsSourceUrl: null })])
    await ready(ctx)

    const [candidate] = await candidates(ctx)

    expect(candidate).toMatchObject({ code: 'NO-LINKS', evidenceUrls: [], ingredientsSourceUrl: null })
  })

  it('gives each candidate its own lists of facts: changing one candidate\'s leaves the row and the next candidate as they were', async () => {
    const ctx = setup()
    stock(ctx, [row('FIRST'), row('SECOND', { priceMin: 2000 })])
    await ready(ctx)

    const [first, second] = await candidates(ctx)
    first!.skinConcerns.push('hd_acne')
    first!.ingredients.push('Retinol')
    first!.evidenceUrls.push('https://example.com/extra')

    expect(second).toMatchObject({ skinConcerns: ['hd_radiance'], ingredients: ['Aqua', 'Glycerin'], evidenceUrls: ['https://example.com/evidence'] })
    expect((await candidates(ctx))[0]).toMatchObject({ skinConcerns: ['hd_radiance'], ingredients: ['Aqua', 'Glycerin'], evidenceUrls: ['https://example.com/evidence'] })
  })

  it('lists the rules it passed: country, step, skin concern, skin type and ingredient rules, and no budget or reactions when the user gave none', async () => {
    const ctx = setup()
    stock(ctx, [row('PLAIN')])
    await ready(ctx)

    expect((await candidates(ctx))[0]!.passed).toEqual(['country', 'step', 'skin-concern', 'skin-type', 'ingredient-rules'])
  })

  it('gives each candidate its own list of what it passed: changing one leaves the others as they were', async () => {
    const ctx = setup()
    stock(ctx, [row('FIRST'), row('SECOND', { priceMin: 2000 })])
    await ready(ctx)

    const [first, second] = await candidates(ctx)
    first!.passed.push('budget')

    expect(second!.passed).toEqual(['country', 'step', 'skin-concern', 'skin-type', 'ingredient-rules'])
  })

  it('lists the budget when a band was given, and the reactions when the user named any, in the same fixed order', async () => {
    const ctx = setup()
    stock(ctx, [row('PLAIN')])
    await ready(ctx, { band: 'mid' })
    await mentioning(ctx, { reaction: [ingredient('fragrance')] })

    expect((await candidates(ctx))[0]!.passed).toEqual(['country', 'step', 'skin-concern', 'skin-type', 'budget', 'ingredient-rules', 'reactions'])
  })
})

describe('RecommendationService.candidatesFor: whose facts', () => {
  it('uses the asking profile\'s own goal, safety answers and shopping fact, and no other profile\'s', async () => {
    const ctx = setup()
    stock(ctx, [row('HAS-RETINOL', { ingredients: ['Aqua', 'Retinol'] })], 'NG')
    stock(ctx, [row('SOLD-IN-GB')], 'GB')
    await ready(ctx, { choices: ['pregnant'], country: 'NG', who: AMARA })
    await ready(ctx, { choices: ['none'], country: 'NG', who: TOLU })
    await ready(ctx, { choices: ['none'], country: 'GB', who: AMARA_SECOND_PROFILE })

    expect(await codesOf(ctx, 'moisturise', AMARA)).toEqual([])
    expect(await codesOf(ctx, 'moisturise', TOLU)).toEqual(['HAS-RETINOL'])
    expect(await codesOf(ctx, 'moisturise', AMARA_SECOND_PROFILE)).toEqual(['SOLD-IN-GB'])
  })
})
