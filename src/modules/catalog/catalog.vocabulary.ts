export const CATEGORIES = ['skin', 'hair', 'body', 'makeup', 'other'] as const
export type Category = (typeof CATEGORIES)[number]

export const PRODUCT_FORMS = ['spray', 'roll-on', 'stick', 'cream', 'lotion', 'gel', 'oil', 'serum', 'liquid', 'bar', 'powder', 'balm'] as const
export type ProductForm = (typeof PRODUCT_FORMS)[number]

export const CONCERN_KINDS = [
  'irritation',
  'allergen',
  'pore-clogging',
  'sun-sensitivity',
  'hyperpigmentation-risk',
  'pregnancy-caution',
  'interaction',
  'restricted-substance',
  'banned-substance',
  'drying',
] as const
export type ConcernKind = (typeof CONCERN_KINDS)[number]

/** Mildest first. */
export const SEVERITIES = ['low', 'medium', 'high'] as const
export type Severity = (typeof SEVERITIES)[number]

// TRAITS mirror Perfect Corp skin-analysis concern types (acne, spots, redness, oiliness, hydration, pores, texture,
// wrinkles) + Fitzpatrick I-VI + onboarding goals. The exact Perfect Corp field names are unconfirmed (a skin-type
// field in particular): check its API schema before personalisation ships, then rename here and re-analyse.
// `goal:calm-repair` is last because it came after the other five: it is for skin made thin, red or reactive by a strong cream, which is
// the product's primary user (CONTEXT.md). ANALYSIS_VERSION was not bumped for it, so analyses made before it simply lack the trait until
// they are next re-analysed.
export const TRAITS = [
  'acne-prone',
  'dark-spots',
  'redness',
  'oily',
  'dry',
  'sensitive',
  'large-pores',
  'texture',
  'wrinkles',
  'fitzpatrick-1',
  'fitzpatrick-2',
  'fitzpatrick-3',
  'fitzpatrick-4',
  'fitzpatrick-5',
  'fitzpatrick-6',
  'pregnancy',
  'goal:clear-skin',
  'goal:even-tone',
  'goal:fade-dark-marks',
  'goal:brighter',
  'goal:glow',
  'goal:calm-repair',
] as const
export type Trait = (typeof TRAITS)[number]

/** Bumped when the analysis prompt or schema changes, which makes older analyses stale. */
export const ANALYSIS_VERSION = 1

/** A formulation not re-checked for this long is re-checked on its next scan. */
export const FRESH_FOR_DAYS = 365

// The recommendation catalog's own vocabularies (spec #115). Skin concerns and skin types are the face scan's (`SHOWN_CONCERNS`,
// `SKIN_TYPE_LABELS`), so a recommendation is written in what a scan can show.

/** The steps of a routine, in the order it is done. */
export const ROUTINE_STEPS = ['cleanse', 'treat', 'moisturise', 'protect'] as const
export type RoutineStep = (typeof ROUTINE_STEPS)[number]

export const FREQUENCIES = ['am', 'pm', 'am-pm', 'alternate-days', 'weekly', 'as-needed'] as const
export type Frequency = (typeof FREQUENCIES)[number]

/** Cheapest first. Each country sets where a band ends (the workbook's Countries tab). */
export const BUDGET_BANDS = ['low', 'mid', 'high'] as const
export type BudgetBand = (typeof BUDGET_BANDS)[number]

/** Where a recommendation came from: found by us, or put forward by the brand (which only ever buys a review, never a place). */
export const ORIGINS = ['sourced', 'brand-submitted'] as const
export type Origin = (typeof ORIGINS)[number]

/** The groups an ingredient rule may belong to, which the shelf verdict's rules read: what an ingredient is, as opposed to what it does. Most rules have none. */
export const INGREDIENT_GROUPS = ['mercury', 'steroid', 'lightening-agent', 'retinoid', 'exfoliating-acid', 'benzoyl-peroxide'] as const
export type IngredientGroup = (typeof INGREDIENT_GROUPS)[number]

/** The kinds of product a step-down template is for: the groups that are stopped with a plan, not at once (mercury is stopped at once). */
export const TAPER_KINDS = ['steroid', 'lightening-agent'] as const
export type TaperKind = (typeof TAPER_KINDS)[number]
