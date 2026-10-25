import { CONTRACT, type AvailabilityRow, type ClaimWordRow, type CountryRow, type IngredientRule, type ProductRow, type RawRow, type RawTab, type RawWorkbook, type ScheduleStep, type TabKey, type TaperRow, type Workbook } from './catalog.workbook.schema'

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
  group: row.group,
  clashes_with: list(row.clashesWith),
  status: row.status,
  approved_by: row.approvedBy,
  approved_on: day(row.approvedOn),
  audited_by: row.auditedBy,
  audited_on: day(row.auditedOn),
})

const claimWord = (row: ClaimWordRow): RawRow => ({
  code: row.code,
  phrase: row.phrase,
  claim: row.claim,
  status: row.status,
  approved_by: row.approvedBy,
  approved_on: day(row.approvedOn),
  audited_by: row.auditedBy,
  audited_on: day(row.auditedOn),
})

/** The one way a schedule is written: `1-2: alternate-days; 3: weekly; 4: stop`, a single week as `N` and a run as `N-M`. */
const schedule = (steps: readonly ScheduleStep[]): string =>
  steps.map((step) => `${step.fromWeek === step.toWeek ? step.fromWeek : `${step.fromWeek}-${step.toWeek}`}: ${step.frequency}`).join(LIST_SEPARATOR)

const taper = (row: TaperRow): RawRow => ({
  code: row.code,
  kind: row.kind,
  schedule: schedule(row.schedule),
  what_to_expect: row.whatToExpect,
  see_a_professional_if: row.seeAProfessionalIf,
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
  claimWords: tab('claimWords', workbook.claimWords, claimWord),
  tapers: tab('tapers', workbook.tapers, taper),
})
