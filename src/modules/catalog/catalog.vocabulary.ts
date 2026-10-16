export const CATEGORIES = ['skin', 'hair', 'body', 'makeup', 'other'] as const
export type Category = (typeof CATEGORIES)[number]

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
] as const
export type Trait = (typeof TRAITS)[number]

/** Bumped when the analysis prompt or schema changes, which makes older analyses stale. */
export const ANALYSIS_VERSION = 1

/** A formulation not re-checked for this long is re-checked on its next scan. */
export const FRESH_FOR_DAYS = 365
