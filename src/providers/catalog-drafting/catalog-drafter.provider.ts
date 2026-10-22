import { isSafePublicHttpsUrl } from '../../lib/url-safety'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { FREQUENCIES, ROUTINE_STEPS } from '../../modules/catalog/catalog.vocabulary'
import { SHOWN_CONCERNS, SKIN_TYPE_LABELS } from '../../modules/face-scans/face-scans.tables'
import type { ProductIdentity } from '../product-research/product-researcher.provider'

/** The Products columns the drafter can fill. The ingredient list is the product researcher's, and every other column is a person's. */
export const DRAFT_COLUMNS = ['skin_concerns', 'skin_types', 'steps', 'frequency'] as const
export type DraftColumn = (typeof DRAFT_COLUMNS)[number]

/** A drafted value and the page it came from. */
export type Sourced<T> = { value: T; sourceUrl: string }

/** A price range for one country. `whereSold` is left out when there is none to give. */
export type DraftedAvailability = { country: string; priceMin: number; priceMax: number; whereSold?: string; sourceUrl: string }

/** A country to price in, and the currency its Countries row says prices there are in. */
export type DraftCountry = { code: string; currency: string }

export type DraftRequest = {
  product: ProductIdentity
  /** The empty columns to draft; may be empty when only countries are wanted. */
  columns: DraftColumn[]
  /** Active countries the product has no price for. */
  countries: DraftCountry[]
}

export type DraftResult = {
  cells: { [C in DraftColumn]?: Sourced<C extends 'frequency' ? string : string[]> }
  availability: DraftedAvailability[]
}

/**
 * Drafts the empty cells of a catalog product with web search, each value with the page it came from. Adapters throw their vendor's
 * errors for failures the caller can act on; "found nothing" is an empty result, not an error.
 */
export interface CatalogDrafter {
  draft(request: DraftRequest): Promise<DraftResult>
}

const VOCABULARY: Record<Exclude<DraftColumn, 'frequency'>, readonly string[]> = {
  skin_concerns: SHOWN_CONCERNS,
  skin_types: [...SKIN_TYPE_LABELS, 'all'],
  steps: ROUTINE_STEPS,
}
const MAX_WHERE_SOLD = 200
const CONTROL_CHARACTER = /\p{Cc}/u

/** The values each column may hold, for the prompt. */
export const DRAFT_VOCABULARY: Record<DraftColumn, readonly string[]> = { ...VOCABULARY, frequency: FREQUENCIES }

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** The items of `value` that are in the vocabulary, once each, in order; undefined when the cell cannot be used. */
const vocabularyList = (column: Exclude<DraftColumn, 'frequency'>, value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const items = [...new Set(value.filter((item): item is string => typeof item === 'string' && VOCABULARY[column].includes(item)))]
  if (items.length === 0) return undefined
  // "all" is every type, so the workbook refuses it next to another.
  if (column === 'skin_types' && items.includes('all') && items.length > 1) return undefined
  return items
}

const cellValue = (column: DraftColumn, value: unknown): string | string[] | undefined => {
  if (column !== 'frequency') return vocabularyList(column, value)
  return typeof value === 'string' && (FREQUENCIES as readonly string[]).includes(value) ? value : undefined
}

// Classified-ad and auction sites: a listing there is one seller's unchecked claim, never evidence for a catalog. Matched on the registrable name
// (the label before the TLD, or before co/com/... under a country TLD), so any TLD and any subdomain is covered. Kept short: general retailers and
// marketplaces are not on it.
const LISTING_SITES: ReadonlySet<string> = new Set(['ebay', 'jiji', 'craigslist', 'gumtree', 'olx'])
const SECOND_LEVEL_LABELS: ReadonlySet<string> = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'])

const isListingSite = (url: string): boolean => {
  const labels = new URL(url).hostname.toLowerCase().replace(/\.+$/, '').split('.')
  const tld = labels.pop()!
  if (tld.length === 2 && labels.length > 1 && SECOND_LEVEL_LABELS.has(labels.at(-1)!)) labels.pop()
  return LISTING_SITES.has(labels.at(-1)!)
}

/** A public https page that can sit in a `draft_cells` entry (the cell is split at ";", so a link holding one would be cut in two), and not a listing site. */
export const isUsableSource = (value: unknown): value is string => isSafePublicHttpsUrl(value) && !value.includes(';') && !isListingSite(value)

// A price row is for one pack size, so its highest price is at most a little above its lowest (shops and pack-size rounding). A wider spread means
// sizes, bundles or unrelated listings were mixed, which is not one product's price.
const MAX_PRICE_SPREAD = 2.5

// A price a source gave is a whole number of at least 1: 0 is a missing price read as free, and a number past 2^53 is not exact. (The workbook itself
// still takes 0 in a price typed by hand.)
const isPrice = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/**
 * What of a drafter's answer the workbook can take: only the columns and countries asked for, only values in the vocabularies, prices as whole
 * numbers (a row whose highest price is over 2.5 times its lowest is not one product's price and is dropped), and only a public https page that is not a classified or auction listing. `searched`, when given, is also the only set of pages a source may be (the model can
 * name a page it never saw). A list cell is filtered to its allowed items; anything else that is not usable is left out whole, never repaired. `raw` is what a model could say, so nothing in it is trusted.
 */
export const checkedDraft = (raw: unknown, request: DraftRequest, searched?: ReadonlySet<string>): DraftResult => {
  const answer = asRecord(raw)
  const cells = asRecord(answer?.cells)
  const rows = answer?.availability
  const sourceOf = (value: unknown): string | undefined => (isUsableSource(value) && (!searched || searched.has(value)) ? value : undefined)
  const result: DraftResult = { cells: {}, availability: [] }
  if (!cells || !Array.isArray(rows)) return result

  for (const column of DRAFT_COLUMNS) {
    if (!request.columns.includes(column)) continue
    const cell = asRecord(cells[column])
    const value = cellValue(column, cell?.value)
    const sourceUrl = sourceOf(cell?.sourceUrl)
    if (value !== undefined && sourceUrl !== undefined) Object.assign(result.cells, { [column]: { value, sourceUrl } })
  }

  const taken = new Set<string>()
  for (const item of rows) {
    const row = asRecord(item)
    if (!row) continue
    const { country, priceMin, priceMax, whereSold } = row
    const sourceUrl = sourceOf(row.sourceUrl)
    if (typeof country !== 'string' || !request.countries.some((asked) => asked.code === country) || taken.has(country)) continue
    if (!isPrice(priceMin) || !isPrice(priceMax) || priceMin > priceMax || sourceUrl === undefined) continue
    if (priceMax > priceMin * MAX_PRICE_SPREAD) continue
    taken.add(country)
    const shop = typeof whereSold === 'string' ? whereSold.trim() : ''
    const plain = shop !== '' && shop.length <= MAX_WHERE_SOLD && !CONTROL_CHARACTER.test(shop) && !hasLinkOrMarkup(shop)
    result.availability.push({ country, priceMin, priceMax, ...(plain ? { whereSold: shop } : {}), sourceUrl })
  }
  return result
}
