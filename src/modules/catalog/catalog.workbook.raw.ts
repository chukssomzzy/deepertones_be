import {
  CONTRACT,
  type AvailabilityRow,
  type ClaimWordRow,
  type CountryRow,
  type EscalationRow,
  type GuideRow,
  type IngredientRule,
  type ProductRow,
  type RawRow,
  type RawTab,
  type RawWorkbook,
  type ReintroductionRow,
  type ResponseRow,
  type ScheduleStep,
  type TabKey,
  type TaperRow,
  type WeekRow,
  type Workbook,
} from './catalog.workbook.schema'

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
  key_ingredient: row.keyIngredient,
  strength: row.strength,
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
  reviewer_role: row.reviewerRole,
  approved_on: day(row.approvedOn),
  audited_by: row.auditedBy,
  audited_on: day(row.auditedOn),
})

const claimWord = (row: ClaimWordRow): RawRow => ({
  code: row.code,
  phrase: row.phrase,
  claim: row.claim,
  source_url: row.sourceUrl,
  status: row.status,
  approved_by: row.approvedBy,
  reviewer_role: row.reviewerRole,
  approved_on: day(row.approvedOn),
  audited_by: row.auditedBy,
  audited_on: day(row.auditedOn),
})

/** The one way a schedule or a ladder is written: `1-2: alternate-days; 3: weekly; 4: stop`, a single week as `N` and a run as `N-M`. */
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

const guide = (row: GuideRow): RawRow => ({
  step: row.step,
  goal: row.goal,
  what_it_does: row.whatItDoes,
  look_for: row.lookFor,
  for_deeper_skin: row.forDeeperSkin,
  look_for_when_pregnant: row.lookForWhenPregnant,
  status: row.status,
  approved_by: row.approvedBy,
  approved_on: day(row.approvedOn),
  audited_by: row.auditedBy,
  audited_on: day(row.auditedOn),
})

const reintroduction = (row: ReintroductionRow): RawRow => ({
  group: row.group,
  schedule: schedule(row.schedule),
  status: row.status,
  approved_by: row.approvedBy,
  approved_on: day(row.approvedOn),
  audited_by: row.auditedBy,
  audited_on: day(row.auditedOn),
})

const escalation = (row: EscalationRow): RawRow => ({
  reason: row.reason,
  who_to_see: row.whoToSee,
  how_soon: row.howSoon,
  what_to_tell_them: row.whatToTellThem,
  status: row.status,
  approved_by: row.approvedBy,
  approved_on: day(row.approvedOn),
  audited_by: row.auditedBy,
  audited_on: day(row.auditedOn),
})

const response = (row: ResponseRow): RawRow => ({
  outcome: row.outcome,
  title: row.title,
  body: row.body,
  what_to_do_now: row.whatToDoNow,
  status: row.status,
  approved_by: row.approvedBy,
  approved_on: day(row.approvedOn),
  audited_by: row.auditedBy,
  audited_on: day(row.auditedOn),
})

const week = (row: WeekRow): RawRow => ({
  band: row.band,
  goal: row.goal,
  step_down: row.stepDown ? 'yes' : 'no',
  title: row.title,
  text: row.text,
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
  guides: tab('guides', workbook.guides, guide),
  reintroductions: tab('reintroductions', workbook.reintroductions, reintroduction),
  escalations: tab('escalations', workbook.escalations, escalation),
  responses: tab('responses', workbook.responses, response),
  weeks: tab('weeks', workbook.weeks, week),
})
