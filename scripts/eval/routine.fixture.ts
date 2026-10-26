import type { ReferenceEntry } from '../../src/modules/catalog/catalog.reference'
import type { ProductSummary } from '../../src/modules/catalog/catalog.service'
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { FakeCatalogWorkbook } from '../../src/modules/catalog/catalog.workbook.service.fake'
import { maxNewProductsFor, ROUTINE_ALLOWED_FREQUENCIES } from '../../src/modules/routines/routines.rules'
import type { Routine, RoutineSkeleton, SkeletonCandidate, SkeletonGap, SkeletonShelfProduct } from '../../src/modules/routines/routines.types'
import type { RoutineCase } from './routine-cases'
import type { Snapshot, SnapshotOffer } from './routine-snapshot'

// Shared by the routine eval tests: a tiny catalog snapshot built in memory (never the owner's file), a case, a skeleton and a routine, each with
// defaults that pass every rule so a test changes the one thing it is about. Not a test file, so it is never run.

export type Recommendation = Parameters<FakeCatalogWorkbook['offer']>[1]
type Country = Parameters<FakeCatalogWorkbook['addCountry']>[0]

/** What the Countries tab holds: bands are per country, in its own currency. */
export const NG: Country = { code: 'NG', currency: 'NGN', lowMax: 5000, midMax: 15000, status: 'active' }
export const GB: Country = { code: 'GB', currency: 'GBP', lowMax: 15, midMax: 40, status: 'active' }

export const rule = (name: string, kind: ReferenceEntry['kind'], aliases: string[] = []): ReferenceEntry => ({ name, aliases, kind, rule: `${name} is a ${kind} (test rule)`, source: null })

/** The live rules of the tiny snapshot. Only banned-substance and (for a pregnant or breastfeeding user) pregnancy-caution take a row out of a candidate list. */
export const RULES: ReferenceEntry[] = [
  rule('retinol', 'pregnancy-caution'),
  rule('hydroquinone', 'banned-substance', ['quinol']),
  rule('parfum', 'allergen', ['fragrance']),
]

/** An approved row that passes every rule for a glow-goal user with no skin type, no budget and nothing to avoid; a test changes the one thing it is about. */
export const row = (code: string, over: Partial<Recommendation> = {}): Recommendation => ({
  code,
  productId: `snap-${code}`,
  formulationId: `snap-f-${code}`,
  ingredients: ['Aqua', 'Glycerin'],
  skinConcerns: ['hd_radiance'],
  skinTypes: 'all',
  steps: ['moisturise'],
  frequency: 'am-pm',
  ownCautions: [],
  evidenceUrls: [`https://evidence.example/${code}/a`],
  ingredientsSourceUrl: `https://ingredients.example/${code}`,
  origin: 'sourced',
  priceMin: 1000,
  priceMax: 2000,
  whereSold: 'Pharmacies and online',
  ...over,
})

/** A row on offer in a country, with the product facts the catalog would give for its formulation. */
export const offer = (country: string, recommendation: Recommendation, summary: Partial<ProductSummary> = {}): SnapshotOffer => ({
  country,
  row: recommendation,
  summary: {
    id: recommendation.productId,
    kind: 'named',
    brand: `Brand ${recommendation.code}`,
    name: `Name ${recommendation.code}`,
    variant: null,
    form: 'cream',
    category: 'skin',
    imageUrl: null,
    ...summary,
  },
})

export const snapshotOf = (offers: SnapshotOffer[], over: Partial<Snapshot> = {}): Snapshot => ({
  sha256: 'a'.repeat(64),
  countries: [NG, GB],
  rules: RULES,
  offers,
  ...over,
})

/** A glow-goal person in Nigeria with nothing on the shelf, no budget and no skin type. */
export const caseOf = (over: Partial<RoutineCase> = {}): RoutineCase => ({
  id: 'case-1',
  persona: 'amara',
  goal: 'glow',
  country: 'NG',
  budgetBand: null,
  skinType: null,
  seen: [{ concern: 'hd_radiance', level: 'some' }],
  alsoNoticed: [],
  safety: { choices: ['none'], reactionIngredients: [], prescriptionIngredients: [] },
  cautions: [],
  shelf: [],
  ...over,
})

export const shelfProduct = (id: string, over: Partial<SkeletonShelfProduct> = {}): SkeletonShelfProduct => ({
  id,
  brand: 'Shelf Brand',
  name: `Shelf ${id}`,
  ingredients: ['Aqua'],
  step: 'cleanse',
  verdict: { kind: 'keep' },
  sourceUrls: [],
  ...over,
})

// --- skeletons and routines (for the scorer, the label sheet and the run) -----------------------------------------------------------------------

export const candidate = (code: string, over: Partial<SkeletonCandidate> = {}): SkeletonCandidate => ({
  code,
  brand: `Brand ${code}`,
  name: `Name ${code}`,
  form: 'cream',
  ingredients: ['Aqua', 'Glycerin'],
  skinConcerns: ['hd_radiance'],
  frequency: 'am-pm',
  priceMin: 1000,
  priceMax: 2000,
  evidenceUrls: [`https://evidence.example/${code}/a`],
  ingredientsSourceUrl: `https://ingredients.example/${code}`,
  outcomeHint: null,
  ...over,
})

export const skeletonOf = (gaps: SkeletonGap[], over: Partial<RoutineSkeleton> = {}): RoutineSkeleton => ({
  goal: 'glow',
  person: { seen: [{ concern: 'hd_radiance', level: 'some' }], alsoNoticed: [], skinType: null, lowConfidence: ['hd_redness', 'hd_texture', 'hd_moisture'], cautions: [], budgetBand: null },
  steps: ['cleanse', 'treat', 'moisturise', 'protect'],
  shelf: [],
  gaps,
  limits: {
    allowed: structuredClone(ROUTINE_ALLOWED_FREQUENCIES),
    maxNewProducts: maxNewProductsFor(gaps),
  },
  hintsShown: false,
  ...over,
})

export type PickPlan = Partial<Record<RoutineStep, string>>

/** A routine that picks the given candidate for each step it names, with a plain reason and no links. Steps are written in routine order. */
export const routineOf = (picks: PickPlan, over: Partial<Routine> = {}): Routine => ({
  steps: (['cleanse', 'treat', 'moisturise', 'protect'] as const).flatMap((step) =>
    picks[step] === undefined ? [] : [{ step, product: { kind: 'candidate' as const, code: picks[step]! }, frequency: step === 'protect' ? ('am' as const) : ('pm' as const), reason: 'It suits your skin.', grounding: [] }],
  ),
  tapers: [],
  expectation: 'Give it 8 to 12 weeks.',
  ...over,
})
