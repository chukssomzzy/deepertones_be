/*
 * The fixed cases for `npm run eval:catalog`.
 *
 * ANALYSIS_CASES are synthetic but realistic ingredient lists. `expect.flagged` is what the rule checks (flagFacts)
 * flag, in order, and cases.test.ts fails if the two drift, so a case can only ever ask the model to explain what the
 * reference data really flags. The model's side of the contract is checked after checkAnalysis, as the service does.
 *
 * RESEARCH_CASES are real products sold in Nigeria. They check retrieval quality (did the search find a real list,
 * and does it contain the ingredients we expect?), not ground truth: the product data is best effort, and a brand can
 * reformulate or reorder, so a failing research case may mean the case needs updating, not that retrieval broke.
 * `ingredientsInclude` is matched the way the catalog matches ingredients (case, footnote marks and brackets ignored),
 * so "Theobroma Cacao Seed Butter" also finds "Theobroma Cacao (Cocoa) Seed Butter".
 */
import type { ConcernKind, Severity } from '../../src/modules/catalog/catalog.vocabulary'
import type { ProductIdentity } from '../../src/providers/product-research/product-researcher.provider'

export type AnalysisCase = {
  id: string
  product: ProductIdentity
  ingredients: string[]
  expect: {
    /** Exactly what flagFacts returns for `ingredients`, in order. */
    flagged: { kind: ConcernKind; ingredient: string }[]
    /** A stored concern of this kind must be at least this severe. */
    severityAtLeast?: { kind: ConcernKind; severity: Severity }[]
  }
}

export type ResearchCase = {
  id: string
  product: ProductIdentity
  expect: {
    found: true
    /** Names the found list must include, whatever their case or bracketed alternatives. */
    ingredientsInclude: string[]
  }
}

export const ANALYSIS_CASES: AnalysisCase[] = [
  {
    id: 'hydroquinone-lightener',
    product: { brand: 'Test Brand', name: 'Skin Lightening Cream', category: 'skin' },
    ingredients: [
      'Aqua (Water)',
      'Hydroquinone 2%',
      'Glycerin',
      'Kojic Acid',
      'Cetearyl Alcohol',
      'Glyceryl Stearate',
      'Dimethicone',
      'Sodium Metabisulfite',
      'Tocopherol',
      'Phenoxyethanol',
      'Carbomer',
    ],
    expect: {
      flagged: [
        { kind: 'banned-substance', ingredient: 'Hydroquinone 2%' },
        { kind: 'pregnancy-caution', ingredient: 'Hydroquinone 2%' },
      ],
      severityAtLeast: [{ kind: 'banned-substance', severity: 'high' }],
    },
  },
  {
    id: 'mercury-calomel-cream',
    product: { brand: 'Test Brand', name: 'Beauty Cream', category: 'skin' },
    ingredients: [
      'Aqua (Water)',
      'Mercurous Chloride (Calomel)',
      'Petrolatum',
      'Lanolin',
      'Cetyl Alcohol',
      'Glycerin',
      'Stearic Acid',
      'Methylparaben',
      'Propylparaben',
    ],
    expect: {
      flagged: [{ kind: 'banned-substance', ingredient: 'Mercurous Chloride (Calomel)' }],
      severityAtLeast: [{ kind: 'banned-substance', severity: 'high' }],
    },
  },
  {
    id: 'fragranced-lotion',
    product: { brand: 'Test Brand', name: 'Perfumed Body Lotion', category: 'body' },
    ingredients: [
      'Aqua (Water)',
      'Glycerin',
      'Caprylic/Capric Triglyceride',
      'Cetearyl Alcohol',
      'Glyceryl Stearate',
      'Dimethicone',
      'Phenoxyethanol',
      'Carbomer',
      'Parfum (Fragrance)',
      'Linalool',
      'Limonene',
      'Citronellol',
      'Benzyl Salicylate',
      'Coumarin',
    ],
    expect: {
      flagged: [
        { kind: 'allergen', ingredient: 'Parfum (Fragrance)' },
        { kind: 'allergen', ingredient: 'Linalool' },
        { kind: 'allergen', ingredient: 'Limonene' },
        { kind: 'allergen', ingredient: 'Citronellol' },
        { kind: 'allergen', ingredient: 'Benzyl Salicylate' },
        { kind: 'allergen', ingredient: 'Coumarin' },
      ],
    },
  },
  {
    id: 'retinol-night-cream',
    product: { brand: 'Test Brand', name: 'Retinol Night Cream', category: 'skin' },
    ingredients: [
      'Aqua (Water)',
      'Glycerin',
      'Caprylic/Capric Triglyceride',
      'Cetearyl Alcohol',
      'Squalane',
      'Retinol',
      'Tocopherol',
      'Bisabolol',
      'Sodium Hyaluronate',
      'Carbomer',
      'Phenoxyethanol',
      'Ethylhexylglycerin',
    ],
    expect: {
      flagged: [
        { kind: 'sun-sensitivity', ingredient: 'Retinol' },
        { kind: 'pregnancy-caution', ingredient: 'Retinol' },
      ],
    },
  },
  {
    id: 'clean-moisturiser',
    product: { brand: 'Test Brand', name: 'Daily Moisturiser', category: 'skin' },
    ingredients: [
      'Aqua (Water)',
      'Glycerin',
      'Cetearyl Alcohol',
      'Glyceryl Stearate',
      'Squalane',
      'Niacinamide',
      'Panthenol',
      'Sodium Hyaluronate',
      'Xanthan Gum',
      'Tocopherol',
      'Phenoxyethanol',
      'Ethylhexylglycerin',
    ],
    expect: { flagged: [] },
  },
  {
    id: 'coconut-oil-body-butter',
    product: { brand: 'Test Brand', name: 'Coconut Body Butter', category: 'body' },
    ingredients: [
      'Cocos Nucifera (Coconut) Oil',
      'Butyrospermum Parkii (Shea) Butter',
      'Glycerin',
      'Cetearyl Alcohol',
      'Stearic Acid',
      'Tocopherol',
      'Aqua (Water)',
      'Phenoxyethanol',
    ],
    expect: { flagged: [{ kind: 'pore-clogging', ingredient: 'Cocos Nucifera (Coconut) Oil' }] },
  },
]

export const RESEARCH_CASES: ResearchCase[] = [
  {
    id: 'cerave-hydrating-cleanser',
    product: { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' },
    expect: { found: true, ingredientsInclude: ['Glycerin', 'Ceramide NP', 'Sodium Hyaluronate', 'Cholesterol'] },
  },
  {
    id: 'ordinary-niacinamide-zinc',
    product: { brand: 'The Ordinary', name: 'Niacinamide 10% + Zinc 1%', category: 'skin' },
    expect: { found: true, ingredientsInclude: ['Niacinamide', 'Zinc PCA', 'Pentylene Glycol'] },
  },
  {
    id: 'nivea-soft',
    product: { brand: 'NIVEA', name: 'Soft Moisturising Cream', category: 'skin' },
    expect: { found: true, ingredientsInclude: ['Glycerin', 'Paraffinum Liquidum'] },
  },
  {
    id: 'dove-beauty-bar',
    product: { brand: 'Dove', name: 'Beauty Bar', variant: 'Original', category: 'body' },
    expect: { found: true, ingredientsInclude: ['Sodium Lauroyl Isethionate', 'Stearic Acid', 'Lauric Acid'] },
  },
  {
    id: 'vaseline-cocoa-radiant',
    product: { brand: 'Vaseline', name: 'Intensive Care Cocoa Radiant Body Lotion', category: 'body' },
    expect: { found: true, ingredientsInclude: ['Glycerin', 'Petrolatum', 'Stearic Acid', 'Theobroma Cacao Seed Butter'] },
  },
  {
    id: 'black-opal-dark-spot-serum',
    product: { brand: 'Black Opal', name: 'Even True Advanced Dark Spot Serum', category: 'skin' },
    expect: { found: true, ingredientsInclude: ['Glycerin', 'Niacinamide'] },
  },
  {
    id: 'neutrogena-hydro-boost',
    product: { brand: 'Neutrogena', name: 'Hydro Boost Water Gel', category: 'skin' },
    expect: { found: true, ingredientsInclude: ['Glycerin', 'Dimethicone', 'Sodium Hyaluronate'] },
  },
]
