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
  products: ['code', 'brand', 'name', 'variant', 'form', 'category', 'ingredients', 'ingredients_source_url', 'skin_concerns', 'skin_types', 'steps', 'frequency', 'own_cautions', 'evidence_urls', 'origin', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on', 'draft_cells'],
  availability: ['product_code', 'country', 'price_min', 'price_max', 'where_sold', 'source_url'],
  ingredients: ['code', 'name', 'aliases', 'kind', 'strength_limit', 'statement', 'source_url', 'helps', 'group', 'clashes_with', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  countries: ['code', 'currency', 'low_max', 'mid_max', 'status'],
  claimWords: ['code', 'phrase', 'claim', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  tapers: ['code', 'kind', 'schedule', 'what_to_expect', 'see_a_professional_if', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
} as const satisfies Record<Tab, readonly string[]>

/** The tab names a workbook file has, in order. */
export const TAB_NAMES = { products: 'Products', availability: 'Availability', ingredients: 'Ingredients', countries: 'Countries', claimWords: 'Claim words', tapers: 'Tapers' } as const satisfies Record<Tab, string>

export const product = (over: Row = {}): Row => ({
  code: 'PRD-CERAVE-CLEANSER',
  brand: 'CeraVe',
  name: 'Hydrating Facial Cleanser',
  variant: null,
  form: null,
  category: 'skin',
  ingredients: 'Aqua; Glycerin; Cetearyl Alcohol',
  ingredients_source_url: 'https://www.cerave.com/hydrating-cleanser',
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
  approved_on: day(-3),
  audited_by: null,
  audited_on: null,
  ...over,
})

export const claimWord = (over: Row = {}): Row => ({
  code: 'CLM-WHITENING',
  phrase: 'whitening',
  claim: 'lightening',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
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

export const country = (over: Row = {}): Row => ({ code: 'NG', currency: 'NGN', low_max: 5000, mid_max: 15000, status: 'active', ...over })

/** A workbook the real contract accepts: one valid row in each tab, unless the rows of a tab are given. Every header is present. */
export const validWorkbook = (over: Partial<Record<Tab, Row[]>> = {}): RawWorkbook => ({
  products: { headers: [...HEADERS.products], rows: over.products ?? [product()] },
  availability: { headers: [...HEADERS.availability], rows: over.availability ?? [availability()] },
  ingredients: { headers: [...HEADERS.ingredients], rows: over.ingredients ?? [ingredient()] },
  countries: { headers: [...HEADERS.countries], rows: over.countries ?? [country()] },
  claimWords: { headers: [...HEADERS.claimWords], rows: over.claimWords ?? [claimWord()] },
  tapers: { headers: [...HEADERS.tapers], rows: over.tapers ?? [taper()] },
})
