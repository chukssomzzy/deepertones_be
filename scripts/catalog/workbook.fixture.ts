import type { RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'

// Shared by the catalog script tests: one workbook that passes the real contract, and the dates it hangs from. Not a test file, so it is never run.

/** The one day every date in the catalog script tests hangs from; fixtures are offsets from it. */
export const BASE = new Date('2030-06-15T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
export const day = (offset: number): string => new Date(BASE.getTime() + offset * DAY).toISOString().slice(0, 10)
export const dayAsDate = (offset: number): Date => new Date(BASE.getTime() + offset * DAY)

type Tab = keyof RawWorkbook
type Row = RawWorkbook['products']['rows'][number]

/** The header row of each tab, written from the spec's tables (not read back from the contract), in workbook order. */
export const HEADERS = {
  products: ['code', 'brand', 'name', 'variant', 'form', 'category', 'ingredients', 'ingredients_source_url', 'key_ingredient', 'strength', 'skin_concerns', 'skin_types', 'steps', 'frequency', 'own_cautions', 'evidence_urls', 'origin', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on', 'draft_cells'],
  availability: ['product_code', 'country', 'price_min', 'price_max', 'where_sold', 'source_url'],
  ingredients: ['code', 'name', 'aliases', 'kind', 'strength_limit', 'statement', 'source_url', 'helps', 'group', 'clashes_with', 'status', 'approved_by', 'reviewer_role', 'approved_on', 'audited_by', 'audited_on'],
  countries: ['code', 'currency', 'low_max', 'mid_max', 'status'],
  claimWords: ['code', 'phrase', 'claim', 'source_url', 'status', 'approved_by', 'reviewer_role', 'approved_on', 'audited_by', 'audited_on'],
  tapers: ['code', 'kind', 'schedule', 'what_to_expect', 'see_a_professional_if', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  guides: ['step', 'goal', 'what_it_does', 'look_for', 'for_deeper_skin', 'look_for_when_pregnant', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  reintroductions: ['group', 'schedule', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  escalations: ['reason', 'who_to_see', 'how_soon', 'what_to_tell_them', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  responses: ['outcome', 'title', 'body', 'what_to_do_now', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  weeks: ['band', 'goal', 'step_down', 'title', 'text', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
} as const satisfies Record<Tab, readonly string[]>

/** The tab names a workbook file has, in order. */
export const TAB_NAMES = { products: 'Products', availability: 'Availability', ingredients: 'Ingredients', countries: 'Countries', claimWords: 'Claim words', tapers: 'Tapers', guides: 'Guides', reintroductions: 'Reintroductions', escalations: 'Escalations', responses: 'Responses', weeks: 'Weeks' } as const satisfies Record<Tab, string>

export const product = (over: Row = {}): Row => ({
  code: 'PRD-CERAVE-CLEANSER',
  brand: 'CeraVe',
  name: 'Hydrating Facial Cleanser',
  variant: null,
  form: null,
  category: 'skin',
  ingredients: 'Aqua; Glycerin; Cetearyl Alcohol',
  ingredients_source_url: 'https://www.cerave.com/hydrating-cleanser',
  key_ingredient: null,
  strength: null,
  skin_concerns: 'hd_moisture; hd_redness',
  skin_types: 'dry; combination',
  steps: 'cleanse',
  frequency: 'am-pm',
  own_cautions: null,
  evidence_urls: null,
  origin: 'sourced',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: day(-3),
  audited_by: null,
  audited_on: null,
  draft_cells: null,
  ...over,
})

export const availability = (over: Row = {}): Row => ({ product_code: 'PRD-CERAVE-CLEANSER', country: 'NG', price_min: 4000, price_max: 6500, where_sold: 'Pharmacies and online', source_url: 'https://www.healthplus.example/cerave-cleanser', ...over })

export const ingredient = (over: Row = {}): Row => ({
  code: 'ING-RETINOL-SUN-SENSITIVITY',
  name: 'retinol',
  aliases: 'vitamin a alcohol',
  kind: 'sun-sensitivity',
  strength_limit: null,
  statement: 'Can make skin burn more easily in the sun, so sunscreen matters while using it.',
  source_url: null,
  helps: null,
  group: null,
  clashes_with: null,
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  reviewer_role: 'a consultant dermatologist',
  approved_on: day(-3),
  audited_by: null,
  audited_on: null,
  ...over,
})

export const claimWord = (over: Row = {}): Row => ({
  code: 'CLM-WHITENING',
  phrase: 'whitening',
  claim: 'lightening',
  source_url: null,
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  reviewer_role: 'a consultant dermatologist',
  approved_on: day(-3),
  audited_by: null,
  audited_on: null,
  ...over,
})

export const taper = (over: Row = {}): Row => ({
  code: 'TPR-STEROID-1',
  kind: 'steroid',
  schedule: '1-2: alternate-days; 3-4: weekly; 5: stop',
  what_to_expect: 'Skin may flare or look redder for a few days after each step down. This is expected and passes.',
  see_a_professional_if: 'The redness spreads, the skin weeps or blisters, or you feel unwell.',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: day(-3),
  audited_by: null,
  audited_on: null,
  ...over,
})

/** A Guides row: by default the approved base row (no goal) of the cleanse step. A guide has no code; it is its step and goal. */
export const guide = (over: Row = {}): Row => ({
  step: 'cleanse',
  goal: null,
  what_it_does: 'Lifts sweat, sunscreen and dirt off your skin so the rest of your routine can work.',
  look_for: 'A gentle, fragrance-free wash that leaves your skin comfortable, not tight.',
  for_deeper_skin: 'Skip harsh scrubs and hot water: rubbing hard can leave dark marks behind on deeper skin.',
  look_for_when_pregnant: null,
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: day(-3),
  audited_by: null,
  audited_on: null,
  ...over,
})

/** The four approved base rows the contract needs, one for each routine step, written out here and not read from the vocabulary. */
export const baseGuides = (): Row[] => ['cleanse', 'treat', 'moisturise', 'protect'].map((step) => guide({ step }))

/** The reasons an escalation row is written for, the outcomes a response row is, and the week bands: written out here and not read from the vocabularies. */
export const ESCALATION_REASONS = ['pus-or-hot-patch', 'swelling', 'near-eyes', 'worse-after-pause', 'unchanged-after-checks', 'harm-while-two-paused', 'hard-to-ignore-during-step-down', 'about-a-product'] as const
export const RESPONSE_OUTCOMES = ['paused', 'advice-tightness', 'advice-itching', 'advice-breakouts', 'expected-flare', 'check-calmer', 'check-same', 'check-worse', 'nothing-to-pause'] as const
export const WEEK_BANDS = ['1', '2', '3-4', '5-8', '9-12'] as const

/** A Reintroductions row: by default the approved default ladder (no group). */
export const reintroduction = (over: Row = {}): Row => ({
  group: null,
  schedule: '1: weekly; 2: alternate-days; 3: back',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: day(-3),
  audited_by: null,
  audited_on: null,
  ...over,
})

/** An Escalations row: by default the approved row for the first reason. Each says its own reason, so a test can tell which it was given. */
export const escalation = (over: Row = {}): Row => ({
  reason: 'pus-or-hot-patch',
  who_to_see: 'A doctor or a pharmacist.',
  how_soon: 'Today, or within a day.',
  what_to_tell_them: 'What you noticed, where, and since when. Which products you were using.',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: day(-3),
  audited_by: null,
  audited_on: null,
  ...over,
})

/** A Responses row: by default the approved row for the paused outcome, with the one placeholder there is. */
export const response = (over: Row = {}): Row => ({
  outcome: 'paused',
  title: 'We paused your {step}',
  body: 'Your skin needs a rest from your {step}. We will ask how it feels in three days.',
  what_to_do_now: 'Skip anything that stings. Keep to a gentle cleanser and moisturiser.',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: day(-3),
  audited_by: null,
  audited_on: null,
  ...over,
})

/** A Weeks row: by default the approved base row (no goal, no step-down) of band 1. */
export const week = (over: Row = {}): Row => ({
  band: '1',
  goal: null,
  step_down: 'no',
  title: 'Settling in',
  text: 'The first week is about calming things down. Go gently and keep to the basics.',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: day(-3),
  audited_by: null,
  audited_on: null,
  ...over,
})

/** The rows the contract needs of each new tab, each saying its own key so a test can tell which one it was given. */
export const baseReintroductions = (): Row[] => [reintroduction()]
export const allEscalations = (): Row[] => ESCALATION_REASONS.map((reason) => escalation({ reason, who_to_see: `Who to see for ${reason}.` }))
export const allResponses = (): Row[] => RESPONSE_OUTCOMES.map((outcome) => response({ outcome, title: `Title for ${outcome}`, body: `Body for ${outcome}.` }))
export const baseWeeks = (): Row[] => WEEK_BANDS.map((band) => week({ band, title: `Title for ${band}`, text: `Text for ${band}.` }))

export const country = (over: Row = {}): Row => ({ code: 'NG', currency: 'NGN', low_max: 5000, mid_max: 15000, status: 'active', ...over })

/**
 * Gives every approved rule and claim word of the workbook that has no reviewer_role the one the fixtures have. A workbook exported from a catalog stored before contract 2.4.0
 * (the seeded rules, or a fake that starts as the migrated database does) holds rules with none, and the contract needs one of an approved row.
 */
export const withReviewerRoles = (workbook: RawWorkbook): void => {
  for (const tab of [workbook.ingredients, workbook.claimWords]) {
    for (const row of tab.rows) if (row.status === 'approved' && (row.reviewer_role ?? null) === null) row.reviewer_role = 'a consultant dermatologist'
  }
}

/** A workbook the real contract accepts: one valid row in each tab (and the rows the contract needs: four in Guides, the base row of each step; one default ladder; eight escalations, nine responses and five week cards), unless the rows of a tab are given. Every header is present. */
export const validWorkbook = (over: Partial<Record<Tab, Row[]>> = {}): RawWorkbook => ({
  products: { headers: [...HEADERS.products], rows: over.products ?? [product()] },
  availability: { headers: [...HEADERS.availability], rows: over.availability ?? [availability()] },
  ingredients: { headers: [...HEADERS.ingredients], rows: over.ingredients ?? [ingredient()] },
  countries: { headers: [...HEADERS.countries], rows: over.countries ?? [country()] },
  claimWords: { headers: [...HEADERS.claimWords], rows: over.claimWords ?? [claimWord()] },
  tapers: { headers: [...HEADERS.tapers], rows: over.tapers ?? [taper()] },
  guides: { headers: [...HEADERS.guides], rows: over.guides ?? baseGuides() },
  reintroductions: { headers: [...HEADERS.reintroductions], rows: over.reintroductions ?? baseReintroductions() },
  escalations: { headers: [...HEADERS.escalations], rows: over.escalations ?? allEscalations() },
  responses: { headers: [...HEADERS.responses], rows: over.responses ?? allResponses() },
  weeks: { headers: [...HEADERS.weeks], rows: over.weeks ?? baseWeeks() },
})
