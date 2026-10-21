import { CONTRACT, type AvailabilityRow, type CountryRow, type IngredientRule, type ProductRow, type RawRow, type RawTab, type RawWorkbook, type TabKey, type Workbook } from './catalog.workbook.schema'

// A workbook as the export serves it and the import takes it back: lists joined with "; ", dates as YYYY-MM-DD, an empty cell null. Pure, so the
// same rows always give the same text, and an export fed to the import changes nothing.

const LIST_SEPARATOR = '; '

const list = (items: readonly string[]): string | null => (items.length === 0 ? null : items.join(LIST_SEPARATOR))
const day = (date: Date | null): string | null => (date === null ? null : date.toISOString().slice(0, 10))

const product = (row: ProductRow): RawRow => ({
  code: row.code,
  brand: row.brand,
  name: row.name,
  variant: row.variant,
  form: row.form,
  category: row.category,
  ingredients: list(row.ingredients),
  ingredients_source_url: row.ingredientsSourceUrl,
  skin_concerns: list(row.skinConcerns),
  skin_types: list(row.skinTypes),
  steps: list(row.steps),
  frequency: row.frequency,
  own_cautions: list(row.ownCautions),
  evidence_urls: list(row.evidenceUrls),
  origin: row.origin,
  status: row.status,
  approved_by: row.approvedBy,
  approved_on: day(row.approvedOn),
  audited_by: row.auditedBy,
  audited_on: day(row.auditedOn),
  draft_cells: list(row.draftCells.map((cell) => `${cell.column}=${cell.url}`)),
})

const availability = (row: AvailabilityRow): RawRow => ({
  product_code: row.productCode,
  country: row.country,
  price_min: row.priceMin,
  price_max: row.priceMax,
  where_sold: row.whereSold,
  source_url: row.sourceUrl,
})

const ingredient = (row: IngredientRule): RawRow => ({
  code: row.code,
  name: row.name,
  aliases: list(row.aliases),
  kind: row.kind,
  strength_limit: row.strengthLimit,
  statement: row.statement,
  source_url: row.sourceUrl,
  helps: list(row.helps),
  status: row.status,
  approved_by: row.approvedBy,
  approved_on: day(row.approvedOn),
  audited_by: row.auditedBy,
  audited_on: day(row.auditedOn),
})

const country = (row: CountryRow): RawRow => ({ code: row.code, currency: row.currency, low_max: row.lowMax, mid_max: row.midMax, status: row.status })

/** The header row of a tab, in the order the contract lists its columns. */
const headersOf = (key: TabKey): string[] => CONTRACT.tabs.find((tab) => tab.key === key)!.columns.map((column) => column.name)

const tab = <Row>(key: TabKey, rows: Row[], raw: (row: Row) => RawRow): RawTab => ({ headers: headersOf(key), rows: rows.map(raw) })

export const toRawWorkbook = (workbook: Workbook): RawWorkbook => ({
  products: tab('products', workbook.products, product),
  availability: tab('availability', workbook.availability, availability),
  ingredients: tab('ingredients', workbook.ingredients, ingredient),
  countries: tab('countries', workbook.countries, country),
})
