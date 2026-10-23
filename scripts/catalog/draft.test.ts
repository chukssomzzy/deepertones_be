import { describe, expect, it } from 'vitest'
import type { RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import { type AiJob, AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import { BIG_CAP_MICROS } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import type { CatalogDrafter, DraftRequest, DraftResult } from '../../src/providers/catalog-drafting/catalog-drafter.provider'
import { MemoryCatalogDrafter } from '../../src/providers/catalog-drafting/memory.catalog-drafter'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'
import type { ProductIdentity, ProductResearcher } from '../../src/providers/product-research/product-researcher.provider'
import { draftWorkbook, formatReport, runDraft } from './draft'

// `catalog:draft`, minus the file and the network: a workbook in, the same workbook with its empty draft cells filled out, with the researcher and the
// drafter faked. What is pinned: it fills only EMPTY cells of DRAFT rows, never adds or removes a product, marks each cell it filled in draft_cells with
// the page it came from, adds Availability rows only for draft products and the countries that have none, drops what the vocabularies or the https
// rule refuse, and stops at the spend cap with what it has.

/** The one day every date in this file hangs from; fixtures are offsets from it. */
const BASE = new Date('2030-06-15T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const day = (offset: number) => new Date(BASE.getTime() + offset * DAY).toISOString().slice(0, 10)
const APPROVED_ON = day(-3)

type Tab = keyof RawWorkbook
type RawTab = RawWorkbook[Tab]
type Raw = RawTab['rows'][number]

// The header row of each tab, as a literal written from the spec's tables.
const HEADERS = {
  products: ['code', 'brand', 'name', 'variant', 'form', 'category', 'ingredients', 'ingredients_source_url', 'skin_concerns', 'skin_types', 'steps', 'frequency', 'own_cautions', 'evidence_urls', 'origin', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on', 'draft_cells'],
  availability: ['product_code', 'country', 'price_min', 'price_max', 'where_sold', 'source_url'],
  ingredients: ['code', 'name', 'aliases', 'kind', 'strength_limit', 'statement', 'source_url', 'helps', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  countries: ['code', 'currency', 'low_max', 'mid_max', 'status'],
} as const satisfies Record<Tab, readonly string[]>

const tab = (name: Tab, rows: Raw[]): RawTab => ({ headers: [...HEADERS[name]], rows })

// --- fixtures -----------------------------------------------------------------------------------------------------------------------------------

/** A draft product with only its identity, category and origin filled: everything the drafting tool can fill is empty. */
const blank = (code: string, brand: string, name: string, over: Raw = {}): Raw => ({
  code,
  brand,
  name,
  variant: null,
  form: null,
  category: 'skin',
  ingredients: null,
  ingredients_source_url: null,
  skin_concerns: null,
  skin_types: null,
  steps: null,
  frequency: null,
  own_cautions: null,
  evidence_urls: null,
  origin: 'sourced',
  status: 'draft',
  approved_by: null,
  approved_on: null,
  audited_by: null,
  audited_on: null,
  draft_cells: null,
  ...over,
})

const CERAVE = blank('PRD-CERAVE', 'CeraVe', 'Hydrating Cleanser', { variant: 'Normal to Dry Skin', form: 'liquid' })
const VANICREAM = blank('PRD-VANICREAM', 'Vanicream', 'Gentle Cleanser')
const AVEENO = blank('PRD-AVEENO', 'Aveeno', 'Calm Moisturiser')

/** Reviewed and signed off: the tool must never touch it. */
const APPROVED = blank('PRD-APPROVED', 'La Roche-Posay', 'Toleriane Cleanser', {
  ingredients: 'Aqua; Glycerin',
  ingredients_source_url: 'https://www.laroche.example/toleriane',
  skin_concerns: 'hd_redness',
  skin_types: 'all',
  steps: 'cleanse',
  frequency: 'am-pm',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
})

/** Retired with an empty ingredient list, which a retired row may have: the tool must not fill it either. */
const RETIRED = blank('PRD-RETIRED', 'Old Brand', 'Old Cleanser', { skin_concerns: 'hd_acne', skin_types: 'oily', steps: 'cleanse', frequency: 'pm', status: 'retired' })

const NG = { code: 'NG', currency: 'NGN', low_max: 5000, mid_max: 15000, status: 'active' }
const GB = { code: 'GB', currency: 'GBP', low_max: 10, mid_max: 30, status: 'active' }
const GH_RETIRED = { code: 'GH', currency: 'GHS', low_max: 100, mid_max: 400, status: 'retired' }

const price = (product_code: string, country: string, over: Raw = {}): Raw => ({ product_code, country, price_min: 4000, price_max: 6500, where_sold: 'Pharmacies', ...over })

const RULE: Raw = {
  code: 'ING-RETINOL-SUN-SENSITIVITY',
  name: 'retinol',
  aliases: null,
  kind: 'sun-sensitivity',
  strength_limit: null,
  statement: 'Can make skin burn more easily in the sun, so sunscreen matters while using it.',
  source_url: null,
  helps: null,
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
}

type Rows = Partial<Record<Tab, Raw[]>>
const workbook = (rows: Rows = {}): RawWorkbook => ({
  products: tab('products', rows.products ?? [CERAVE]),
  availability: tab('availability', rows.availability ?? []),
  ingredients: tab('ingredients', rows.ingredients ?? [RULE]),
  countries: tab('countries', rows.countries ?? [NG, GB, GH_RETIRED]),
})

// Where the fakes say their values came from.
const SRC = {
  ingredients: 'https://www.cerave.example/hydrating-cleanser',
  concerns: 'https://www.dermsite.example/cerave-hydrating-cleanser/concerns',
  types: 'https://www.dermsite.example/cerave-hydrating-cleanser/types',
  steps: 'https://www.dermsite.example/cerave-hydrating-cleanser/steps',
  frequency: 'https://www.dermsite.example/cerave-hydrating-cleanser/frequency',
  price: 'https://www.pharmacy.example/cerave-hydrating-cleanser',
}
const INGREDIENT_LIST = ['Aqua', 'Glycerin', 'Niacinamide']

/** A drafter's answer for every column, whatever was asked, and a priced row for each country asked. */
const everything = (request: DraftRequest): DraftResult => ({
  cells: {
    skin_concerns: { value: ['hd_acne', 'hd_oiliness'], sourceUrl: SRC.concerns },
    skin_types: { value: ['oily'], sourceUrl: SRC.types },
    steps: { value: ['cleanse'], sourceUrl: SRC.steps },
    frequency: { value: 'am-pm', sourceUrl: SRC.frequency },
  },
  availability: request.countries.map(({ code: country }) => ({ country, priceMin: 4000, priceMax: 6500, whereSold: 'Pharmacies and online', sourceUrl: SRC.price })),
})

const fakes = () => {
  const researcher = new MemoryProductResearcher()
  researcher.respondWith(() => ({ found: true, ingredients: INGREDIENT_LIST, sourceUrl: SRC.ingredients }))
  const drafter = new MemoryCatalogDrafter()
  drafter.respondWith(everything)
  return { researcher, drafter }
}

type Over = { researcher?: ProductResearcher; drafter?: CatalogDrafter; ledger?: MemoryAiSpendLedger; countries?: string[]; passes?: number }
const run = async (input: RawWorkbook, over: Over = {}) => {
  const made = fakes()
  const ledger = over.ledger ?? new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
  const researcher = over.researcher ?? made.researcher
  const drafter = over.drafter ?? made.drafter
  const outcome = await draftWorkbook(input, { researcher, drafter, ledger, countries: over.countries, passes: over.passes })
  return { outcome, ...made, ledger }
}

// --- reading the result -----------------------------------------------------------------------------------------------------------------------

const isEmpty = (cell: unknown) => cell === undefined || cell === null || (typeof cell === 'string' && cell.trim() === '')
const listOf = (cell: unknown): string[] => (typeof cell === 'string' ? cell.split(';').map((item) => item.trim()).filter((item) => item !== '') : [])
const productOf = (workbook: RawWorkbook, code: string): Raw => workbook.products.rows.find((r) => r.code === code)!
const draftCellsOf = (workbook: RawWorkbook, code: string) => listOf(productOf(workbook, code).draft_cells).sort()
const availabilityOf = (workbook: RawWorkbook, code: string) => workbook.availability.rows.filter((r) => r.product_code === code)

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

/** The Products cells a drafter may fill, for a product the fakes answered in full. */
const FILLED_CERAVE = {
  ingredients: INGREDIENT_LIST,
  ingredients_source_url: SRC.ingredients,
  skin_concerns: ['hd_acne', 'hd_oiliness'],
  skin_types: ['oily'],
  steps: ['cleanse'],
  frequency: 'am-pm',
}

const sorted = (list: string[]) => [...list].sort()

describe('draftWorkbook: filling a draft row', () => {
  it('fills every empty cell the tool can fill: the ingredient list and its page from the researcher, the rest from the drafter', async () => {
    const { outcome } = await run(workbook())

    const row = productOf(outcome.workbook, 'PRD-CERAVE')
    expect(listOf(row.ingredients)).toEqual(FILLED_CERAVE.ingredients)
    expect(row.ingredients_source_url).toBe(FILLED_CERAVE.ingredients_source_url)
    expect(listOf(row.skin_concerns)).toEqual(FILLED_CERAVE.skin_concerns)
    expect(listOf(row.skin_types)).toEqual(FILLED_CERAVE.skin_types)
    expect(listOf(row.steps)).toEqual(FILLED_CERAVE.steps)
    expect(row.frequency).toBe(FILLED_CERAVE.frequency)
  })

  it('marks every cell it filled in draft_cells as column=source, so a reviewer knows what to check and where it came from', async () => {
    const { outcome } = await run(workbook())

    expect(draftCellsOf(outcome.workbook, 'PRD-CERAVE')).toEqual(
      sorted([
        `ingredients=${SRC.ingredients}`,
        `ingredients_source_url=${SRC.ingredients}`,
        `skin_concerns=${SRC.concerns}`,
        `skin_types=${SRC.types}`,
        `steps=${SRC.steps}`,
        `frequency=${SRC.frequency}`,
      ]),
    )
  })

  it('leaves the status draft and the sign-off columns empty: a filled draft is still a draft', async () => {
    const { outcome } = await run(workbook())

    const row = productOf(outcome.workbook, 'PRD-CERAVE')
    expect(row.status).toBe('draft')
    for (const column of ['approved_by', 'approved_on', 'audited_by', 'audited_on']) expect(isEmpty(row[column]), column).toBe(true)
  })

  it('asks the researcher for the product as it is named in the workbook', async () => {
    const { researcher } = await run(workbook())

    expect(researcher.calls).toEqual([{ brand: 'CeraVe', name: 'Hydrating Cleanser', variant: 'Normal to Dry Skin', form: 'liquid', category: 'skin' }] satisfies ProductIdentity[])
  })

  it('asks the drafter for the empty columns and the countries with no row, naming the product', async () => {
    const { drafter } = await run(workbook({ availability: [price('PRD-CERAVE', 'NG')] }))

    expect(drafter.calls).toHaveLength(1)
    const [request] = drafter.calls
    expect(request!.product).toEqual({ brand: 'CeraVe', name: 'Hydrating Cleanser', variant: 'Normal to Dry Skin', form: 'liquid', category: 'skin' })
    expect(sorted(request!.columns)).toEqual(['frequency', 'skin_concerns', 'skin_types', 'steps'])
    expect(request!.countries).toEqual([{ code: 'GB', currency: 'GBP' }])
  })

  it('passes no variant or form to the researcher for a product that has none', async () => {
    const { researcher } = await run(workbook({ products: [VANICREAM] }))

    expect(researcher.calls).toEqual([{ brand: 'Vanicream', name: 'Gentle Cleanser', category: 'skin' }])
    expect(Object.keys(researcher.calls[0]!)).not.toContain('variant')
  })

  it('is not stopped and skips nothing on an ordinary run', async () => {
    const { outcome } = await run(workbook())

    expect(outcome.stoppedBy).toBeNull()
    expect(outcome.skipped).toEqual([])
    expect(outcome.failed).toEqual([])
  })
})

describe('draftWorkbook: only empty cells', () => {
  it('never overwrites a filled cell, even when the drafter answers for it', async () => {
    const partly = blank('PRD-CERAVE', 'CeraVe', 'Hydrating Cleanser', {
      ingredients: 'Aqua; Parfum',
      ingredients_source_url: 'https://www.cerave.example/original',
      skin_concerns: 'hd_moisture',
      frequency: 'am',
    })

    const { outcome } = await run(workbook({ products: [partly] }))

    const row = productOf(outcome.workbook, 'PRD-CERAVE')
    expect(row.ingredients).toBe('Aqua; Parfum')
    expect(row.ingredients_source_url).toBe('https://www.cerave.example/original')
    expect(row.skin_concerns).toBe('hd_moisture')
    expect(row.frequency).toBe('am')
    // ...while the empty ones are filled.
    expect(listOf(row.skin_types)).toEqual(['oily'])
    expect(listOf(row.steps)).toEqual(['cleanse'])
  })

  it('asks only for what is empty: no researcher for a filled ingredient list, no drafter column for a filled cell', async () => {
    const partly = blank('PRD-CERAVE', 'CeraVe', 'Hydrating Cleanser', { ingredients: 'Aqua; Parfum', skin_concerns: 'hd_moisture', frequency: 'am' })

    const { researcher, drafter } = await run(workbook({ products: [partly] }))

    expect(researcher.calls).toEqual([])
    expect(sorted(drafter.calls[0]!.columns)).toEqual(['skin_types', 'steps'])
  })

  it('marks only the cells it filled: a filled cell gets no draft_cells entry', async () => {
    const partly = blank('PRD-CERAVE', 'CeraVe', 'Hydrating Cleanser', { ingredients: 'Aqua; Parfum', skin_concerns: 'hd_moisture', frequency: 'am' })

    const { outcome } = await run(workbook({ products: [partly] }))

    expect(draftCellsOf(outcome.workbook, 'PRD-CERAVE')).toEqual(sorted([`skin_types=${SRC.types}`, `steps=${SRC.steps}`]))
  })

  it('keeps the draft_cells entries a row already had and adds to them', async () => {
    const earlier = 'https://www.earlier.example/frequency'
    const partly = blank('PRD-CERAVE', 'CeraVe', 'Hydrating Cleanser', { frequency: 'am', draft_cells: `frequency=${earlier}` })

    const { outcome } = await run(workbook({ products: [partly] }))

    const entries = draftCellsOf(outcome.workbook, 'PRD-CERAVE')
    expect(entries).toContain(`frequency=${earlier}`)
    expect(entries).toContain(`skin_types=${SRC.types}`)
    expect(entries).toHaveLength(1 + 5)
  })

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['spaces only', '   '],
    ['a tab and a newline only', '\t\n'],
    ['no key at all', undefined],
  ])('counts a cell of %s as empty and fills it', async (_label, cell) => {
    const row = blank('PRD-CERAVE', 'CeraVe', 'Hydrating Cleanser', { frequency: cell ?? null, steps: cell ?? null, ingredients: cell ?? null })
    if (cell === undefined) for (const column of ['frequency', 'steps', 'ingredients']) delete row[column]

    const { outcome } = await run(workbook({ products: [row] }))

    const filled = productOf(outcome.workbook, 'PRD-CERAVE')
    expect(filled.frequency).toBe('am-pm')
    expect(listOf(filled.steps)).toEqual(['cleanse'])
    expect(listOf(filled.ingredients)).toEqual(INGREDIENT_LIST)
  })

  it.each([['0'], [' x ']])('counts a cell holding %j as filled, and leaves it', async (text) => {
    const row = blank('PRD-CERAVE', 'CeraVe', 'Hydrating Cleanser', { frequency: text })

    const { outcome } = await run(workbook({ products: [row] }))

    expect(productOf(outcome.workbook, 'PRD-CERAVE').frequency).toBe(text)
  })

  it('never fills own_cautions, evidence_urls, the variant, the form, the category or the origin, whatever the drafter says', async () => {
    const { outcome } = await run(workbook({ products: [VANICREAM] }))

    const row = productOf(outcome.workbook, 'PRD-VANICREAM')
    for (const column of ['own_cautions', 'evidence_urls', 'variant', 'form']) expect(isEmpty(row[column]), column).toBe(true)
    expect(row.category).toBe('skin')
    expect(row.origin).toBe('sourced')
    expect(row.brand).toBe('Vanicream')
    expect(row.name).toBe('Gentle Cleanser')
  })
})

describe('draftWorkbook: rows that are not drafts', () => {
  const rows = [CERAVE, APPROVED, RETIRED, VANICREAM]
  const base = () => workbook({ products: rows, availability: [price('PRD-APPROVED', 'NG')] })

  it('leaves an approved row and a retired row exactly as they were', async () => {
    const { outcome } = await run(base())

    expect(productOf(outcome.workbook, 'PRD-APPROVED')).toEqual(APPROVED)
    expect(productOf(outcome.workbook, 'PRD-RETIRED')).toEqual(RETIRED)
  })

  it('does not even ask about an approved row or a retired row: no research, no drafting, no cost', async () => {
    const { researcher, drafter } = await run(base())

    expect(researcher.calls.map((c) => c.brand)).toEqual(['CeraVe', 'Vanicream'])
    expect(drafter.calls.map((c) => c.product.brand)).toEqual(['CeraVe', 'Vanicream'])
  })

  it('adds no availability row for an approved row or a retired row', async () => {
    const { outcome } = await run(base())

    expect(availabilityOf(outcome.workbook, 'PRD-APPROVED')).toEqual([price('PRD-APPROVED', 'NG')])
    expect(availabilityOf(outcome.workbook, 'PRD-RETIRED')).toEqual([])
  })

  it('keeps the products it was given: none added, none removed, none moved', async () => {
    const { outcome } = await run(base())

    expect(outcome.workbook.products.rows.map((r) => r.code)).toEqual(['PRD-CERAVE', 'PRD-APPROVED', 'PRD-RETIRED', 'PRD-VANICREAM'])
  })

  it('keeps the products even when it learns nothing about them', async () => {
    const made = fakes()
    made.researcher.respondWith(() => ({ found: false }))
    made.drafter.respondWith(() => ({ cells: {}, availability: [] }))

    const { outcome } = await run(base(), { researcher: made.researcher, drafter: made.drafter })

    expect(outcome.workbook.products.rows).toEqual(rows)
  })

  it('leaves the Ingredients and Countries tabs and every header row as they were', async () => {
    const input = base()

    const { outcome } = await run(input)

    expect(outcome.workbook.ingredients).toEqual(input.ingredients)
    expect(outcome.workbook.countries).toEqual(input.countries)
    for (const name of ['products', 'availability', 'ingredients', 'countries'] as const) expect(outcome.workbook[name].headers).toEqual(input[name].headers)
  })

  it('skips a draft row that has no brand, name or category, asking about nothing, and says so', async () => {
    const nameless = blank('PRD-NAMELESS', 'Brand', 'x', { name: '  ' })
    const brandless = blank('PRD-BRANDLESS', '', 'Some Cleanser')
    const uncategorised = blank('PRD-NOCAT', 'Other Brand', 'Some Cleanser', { category: null })

    const { outcome, researcher, drafter } = await run(workbook({ products: [nameless, brandless, uncategorised] }))

    expect(researcher.calls).toEqual([])
    expect(drafter.calls).toEqual([])
    expect(outcome.skipped.sort()).toEqual(['PRD-BRANDLESS', 'PRD-NAMELESS', 'PRD-NOCAT'])
    expect(outcome.workbook.products.rows).toEqual([nameless, brandless, uncategorised])
  })
})

describe('draftWorkbook: a draft row the contract would refuse by its identity', () => {
  const long = 'x'.repeat(121)
  it.each([
    ['a brand over 120 characters', { brand: long }],
    ['a name over 120 characters', { name: long }],
    ['a variant over 120 characters', { variant: long }],
    ['a form that is not one of the forms', { form: 'banana' }],
    ['a category that is not one of the categories', { category: 'gadget' }],
  ])('skips, listing it, and asks about nothing, for %s', async (_label, over) => {
    const odd = blank('PRD-ODD', 'Brand', 'Some Cleanser', over)

    const { outcome, researcher, drafter } = await run(workbook({ products: [odd] }))

    expect(outcome.skipped).toEqual(['PRD-ODD'])
    expect(researcher.calls).toEqual([])
    expect(drafter.calls).toEqual([])
    expect(outcome.workbook.products.rows).toEqual([odd])
  })

  it('accepts a brand, a name and a variant of exactly 120 characters, and every form and category the vocabularies hold', async () => {
    const edge = blank('PRD-EDGE', 'b'.repeat(120), 'n'.repeat(120), { variant: 'v'.repeat(120), form: 'balm', category: 'other' })

    const { outcome } = await run(workbook({ products: [edge] }))

    expect(outcome.skipped).toEqual([])
  })
})

describe('draftWorkbook: the input', () => {
  it('is never changed: the workbook it is given is the same afterwards, even frozen', async () => {
    const input = deepFreeze(structuredClone(workbook({ products: [CERAVE, APPROVED], availability: [price('PRD-APPROVED', 'NG')] })))
    const before = structuredClone(input)

    const { outcome } = await run(input)

    expect(input).toEqual(before)
    expect(outcome.workbook).not.toBe(input)
    expect(productOf(outcome.workbook, 'PRD-CERAVE').frequency).toBe('am-pm')
  })
})

describe('draftWorkbook: ingredient lists', () => {
  it('leaves ingredients and their source empty, and marks nothing, when the researcher finds nothing', async () => {
    const made = fakes()
    made.researcher.respondWith(() => ({ found: false }))

    const { outcome } = await run(workbook(), { researcher: made.researcher })

    const row = productOf(outcome.workbook, 'PRD-CERAVE')
    expect(isEmpty(row.ingredients)).toBe(true)
    expect(isEmpty(row.ingredients_source_url)).toBe(true)
    expect(draftCellsOf(outcome.workbook, 'PRD-CERAVE').some((entry) => entry.startsWith('ingredients'))).toBe(false)
  })

  it('still fills the other cells when the researcher finds nothing', async () => {
    const made = fakes()
    made.researcher.respondWith(() => ({ found: false }))

    const { outcome } = await run(workbook(), { researcher: made.researcher })

    expect(productOf(outcome.workbook, 'PRD-CERAVE').frequency).toBe('am-pm')
  })

  it('does not take a list whose source is not an https page as found: nothing is written', async () => {
    const made = fakes()
    made.researcher.respondWith(() => ({ found: true, ingredients: INGREDIENT_LIST, sourceUrl: 'http://www.cerave.example/list' }))

    const { outcome } = await run(workbook(), { researcher: made.researcher })

    expect(isEmpty(productOf(outcome.workbook, 'PRD-CERAVE').ingredients)).toBe(true)
  })

  it('does not take a list whose source address holds a semicolon, which would split its draft_cells entry: nothing is written', async () => {
    const made = fakes()
    made.researcher.respondWith(() => ({ found: true, ingredients: INGREDIENT_LIST, sourceUrl: 'https://www.cerave.example/list;v=2' }))

    const { outcome } = await run(workbook(), { researcher: made.researcher })

    expect(isEmpty(productOf(outcome.workbook, 'PRD-CERAVE').ingredients)).toBe(true)
    expect(isEmpty(productOf(outcome.workbook, 'PRD-CERAVE').ingredients_source_url)).toBe(true)
    expect(draftCellsOf(outcome.workbook, 'PRD-CERAVE').some((entry) => entry.startsWith('ingredients'))).toBe(false)
  })

  it('does not take a list with an item that holds a semicolon, which would split into two items in the cell: nothing is written', async () => {
    const made = fakes()
    made.researcher.respondWith(() => ({ found: true, ingredients: ['Aqua', 'Glycerin; Parfum'], sourceUrl: SRC.ingredients }))

    const { outcome } = await run(workbook(), { researcher: made.researcher })

    const row = productOf(outcome.workbook, 'PRD-CERAVE')
    expect(isEmpty(row.ingredients)).toBe(true)
    expect(isEmpty(row.ingredients_source_url)).toBe(true)
    expect(draftCellsOf(outcome.workbook, 'PRD-CERAVE').some((entry) => entry.startsWith('ingredients'))).toBe(false)
  })

  it('asks the researcher only when the ingredient list and its source are both empty: a source with no list is left for a person', async () => {
    const lonely = blank('PRD-CERAVE', 'CeraVe', 'Hydrating Cleanser', { ingredients_source_url: 'https://www.cerave.example/original' })

    const { outcome, researcher } = await run(workbook({ products: [lonely] }))

    expect(researcher.calls).toEqual([])
    expect(isEmpty(productOf(outcome.workbook, 'PRD-CERAVE').ingredients)).toBe(true)
    expect(productOf(outcome.workbook, 'PRD-CERAVE').ingredients_source_url).toBe('https://www.cerave.example/original')
  })

  it('does not take an empty list as found', async () => {
    const made = fakes()
    made.researcher.respondWith(() => ({ found: true, ingredients: [], sourceUrl: SRC.ingredients }))

    const { outcome } = await run(workbook(), { researcher: made.researcher })

    expect(isEmpty(productOf(outcome.workbook, 'PRD-CERAVE').ingredients)).toBe(true)
    expect(isEmpty(productOf(outcome.workbook, 'PRD-CERAVE').ingredients_source_url)).toBe(true)
  })

  it('keeps the label order of the list the researcher found', async () => {
    const made = fakes()
    made.researcher.respondWith(() => ({ found: true, ingredients: ['Zinc Oxide', 'Aqua', 'Glycerin'], sourceUrl: SRC.ingredients }))

    const { outcome } = await run(workbook(), { researcher: made.researcher })

    expect(listOf(productOf(outcome.workbook, 'PRD-CERAVE').ingredients)).toEqual(['Zinc Oxide', 'Aqua', 'Glycerin'])
  })
})

describe('draftWorkbook: what the drafter says that cannot be used', () => {
  const answering = (cells: DraftResult['cells']) => {
    const drafter = new MemoryCatalogDrafter()
    drafter.respondWith(() => ({ cells, availability: [] }))
    return drafter
  }
  // Written as the model could say them, past the types.
  const loose = (cells: unknown) => cells as DraftResult['cells']

  it('drops an item outside the vocabulary and keeps the others of the cell', async () => {
    const drafter = answering({ skin_concerns: { value: ['hd_redness', 'glowy', 'hd_acne'], sourceUrl: SRC.concerns } })

    const { outcome } = await run(workbook(), { drafter })

    expect(listOf(productOf(outcome.workbook, 'PRD-CERAVE').skin_concerns)).toEqual(['hd_redness', 'hd_acne'])
  })

  it.each([
    ['skin_concerns', ['glowy']],
    ['skin_types', ['dehydrated']],
    ['steps', ['exfoliate']],
    ['skin_concerns', []],
  ])('leaves %s empty, with no draft_cells entry, when none of %j is in the vocabulary', async (column, value) => {
    const drafter = answering(loose({ [column]: { value, sourceUrl: SRC.concerns } }))

    const { outcome } = await run(workbook(), { drafter })

    expect(isEmpty(productOf(outcome.workbook, 'PRD-CERAVE')[column])).toBe(true)
    expect(draftCellsOf(outcome.workbook, 'PRD-CERAVE').some((entry) => entry.startsWith(`${column}=`))).toBe(false)
  })

  it.each([['daily'], ['AM'], [''], ['am; pm']])('leaves frequency empty for the value %j', async (value) => {
    const drafter = answering(loose({ frequency: { value, sourceUrl: SRC.frequency } }))

    const { outcome } = await run(workbook(), { drafter })

    expect(isEmpty(productOf(outcome.workbook, 'PRD-CERAVE').frequency)).toBe(true)
  })

  it.each([
    ['not https', 'http://www.dermsite.example/p'],
    ['not a web address', 'javascript:alert(1)'],
    ['ftp', 'ftp://files.example/p'],
    ['empty', ''],
    ['missing', undefined],
    ['on localhost', 'https://localhost/p'],
    ['an IP address', 'https://10.0.0.1/p'],
  ])('leaves a cell empty, with no draft_cells entry, when its source is %s', async (_label, sourceUrl) => {
    const drafter = answering(loose({ frequency: { value: 'pm', sourceUrl }, steps: { value: ['cleanse'], sourceUrl: SRC.steps } }))

    const { outcome } = await run(workbook(), { drafter })

    const row = productOf(outcome.workbook, 'PRD-CERAVE')
    expect(isEmpty(row.frequency)).toBe(true)
    expect(draftCellsOf(outcome.workbook, 'PRD-CERAVE').some((entry) => entry.startsWith('frequency='))).toBe(false)
    // The cell with a good source is unaffected.
    expect(listOf(row.steps)).toEqual(['cleanse'])
  })

  it('does not write "all" next to another skin type, which the workbook would refuse', async () => {
    const drafter = answering({ skin_types: { value: ['all', 'oily'], sourceUrl: SRC.types } })

    const { outcome } = await run(workbook(), { drafter })

    expect(outcome.problems.map((p) => p.rule)).not.toContain('ALL_MIXED_WITH_OTHERS')
  })

  it('accepts "all" on its own', async () => {
    const drafter = answering({ skin_types: { value: ['all'], sourceUrl: SRC.types } })

    const { outcome } = await run(workbook(), { drafter })

    expect(productOf(outcome.workbook, 'PRD-CERAVE').skin_types).toBe('all')
  })
})

describe('draftWorkbook: availability', () => {
  it('adds a row for each active country the product has none for, with the prices and where it is sold', async () => {
    const { outcome } = await run(workbook())

    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE')).toEqual([
      { product_code: 'PRD-CERAVE', country: 'NG', price_min: 4000, price_max: 6500, where_sold: 'Pharmacies and online', source_url: SRC.price },
      { product_code: 'PRD-CERAVE', country: 'GB', price_min: 4000, price_max: 6500, where_sold: 'Pharmacies and online', source_url: SRC.price },
    ])
  })

  it('writes the page each drafted row came from in source_url, and nothing in source_url of a row it did not draft', async () => {
    const drafter = new MemoryCatalogDrafter()
    drafter.respondWith((request) => ({ cells: {}, availability: request.countries.map(({ code: country }) => ({ country, priceMin: 1, priceMax: 2, sourceUrl: `https://www.pharmacy.example/${country.toLowerCase()}` })) }))
    const existing = price('PRD-CERAVE', 'NG')

    const { outcome } = await run(workbook({ availability: [existing] }), { drafter })

    const rows = availabilityOf(outcome.workbook, 'PRD-CERAVE')
    expect(rows[0]).toEqual(existing)
    expect(rows[0]!.source_url ?? null).toBeNull()
    expect(rows[1]!.source_url).toBe('https://www.pharmacy.example/gb')
  })

  it('leaves where_sold empty but still records the source when the drafter gave no where_sold', async () => {
    const drafter = new MemoryCatalogDrafter()
    drafter.respondWith(() => ({ cells: {}, availability: [{ country: 'NG', priceMin: 1, priceMax: 2, sourceUrl: SRC.price }] }))

    const { outcome } = await run(workbook(), { drafter })

    const [row] = availabilityOf(outcome.workbook, 'PRD-CERAVE')
    expect(isEmpty(row!.where_sold)).toBe(true)
    expect(row!.source_url).toBe(SRC.price)
  })

  it('asks only about countries with no row, leaves the existing row as it was, and adds a row for the rest', async () => {
    const existing = price('PRD-CERAVE', 'NG', { price_min: 1, price_max: 2, where_sold: 'Corner shop' })

    const { outcome, drafter } = await run(workbook({ availability: [existing] }))

    expect(drafter.calls[0]!.countries).toEqual([{ code: 'GB', currency: 'GBP' }])
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE').map((r) => r.country)).toEqual(['NG', 'GB'])
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE')[0]).toEqual(existing)
  })

  it('never asks about a retired country, so none is drafted for it', async () => {
    const { outcome, drafter } = await run(workbook())

    expect(drafter.calls[0]!.countries).toEqual([
      { code: 'NG', currency: 'NGN' },
      { code: 'GB', currency: 'GBP' },
    ])
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE').map((r) => r.country)).not.toContain('GH')
  })

  it('limits the countries to those named when it is given a list', async () => {
    const { outcome, drafter } = await run(workbook(), { countries: ['GB'] })

    expect(drafter.calls[0]!.countries).toEqual([{ code: 'GB', currency: 'GBP' }])
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE').map((r) => r.country)).toEqual(['GB'])
  })

  it.each([
    ['a country that is not in the Countries tab', ['XX']],
    ['a retired country', ['GH']],
    ['a good country next to a bad one', ['NG', 'XX']],
  ])('refuses %s in the list, naming it, before spending anything', async (_label, countries) => {
    const made = fakes()

    await expect(run(workbook(), { countries, researcher: made.researcher, drafter: made.drafter })).rejects.toThrow(/XX|GH/)

    expect(made.researcher.calls).toEqual([])
    expect(made.drafter.calls).toEqual([])
  })

  it('does not call the drafter at all for a product that is complete and has a row for every country', async () => {
    const complete = blank('PRD-CERAVE', 'CeraVe', 'Hydrating Cleanser', {
      ingredients: 'Aqua; Glycerin',
      ingredients_source_url: SRC.ingredients,
      skin_concerns: 'hd_acne',
      skin_types: 'oily',
      steps: 'cleanse',
      frequency: 'pm',
    })

    const { researcher, drafter } = await run(workbook({ products: [complete], availability: [price('PRD-CERAVE', 'NG'), price('PRD-CERAVE', 'GB')] }))

    expect(researcher.calls).toEqual([])
    expect(drafter.calls).toEqual([])
  })

  it('still asks about the missing countries of a product whose cells are all filled', async () => {
    const complete = blank('PRD-CERAVE', 'CeraVe', 'Hydrating Cleanser', {
      ingredients: 'Aqua; Glycerin',
      ingredients_source_url: SRC.ingredients,
      skin_concerns: 'hd_acne',
      skin_types: 'oily',
      steps: 'cleanse',
      frequency: 'pm',
    })

    const { outcome, drafter } = await run(workbook({ products: [complete], availability: [price('PRD-CERAVE', 'NG')] }))

    expect(drafter.calls[0]!.columns).toEqual([])
    expect(drafter.calls[0]!.countries).toEqual([{ code: 'GB', currency: 'GBP' }])
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE').map((r) => r.country)).toEqual(['NG', 'GB'])
  })

  describe('rows that cannot be used', () => {
    const answeringRows = (...rows: Record<string, unknown>[]) => {
      const drafter = new MemoryCatalogDrafter()
      drafter.respondWith(() => ({ cells: {}, availability: rows as unknown as DraftResult['availability'] }))
      return drafter
    }
    const good = (country: string) => ({ country, priceMin: 4000, priceMax: 6500, whereSold: 'Pharmacies', sourceUrl: SRC.price })
    const rowsFor = async (...rows: Record<string, unknown>[]) => {
      const { outcome } = await run(workbook({ products: [CERAVE] }), { drafter: answeringRows(...rows) })
      return availabilityOf(outcome.workbook, 'PRD-CERAVE')
    }

    it.each([
      ['a country that was not asked for', { ...good('US') }],
      ['a country that is not in the Countries tab', { ...good('XX') }],
      ['a retired country', { ...good('GH') }],
      ['a lowest price above the highest', { ...good('NG'), priceMin: 6501 }],
      ['a negative price', { ...good('NG'), priceMin: -1 }],
      ['a price with a fraction', { ...good('NG'), priceMax: 6500.5 }],
      ['a price that is text', { ...good('NG'), priceMin: '4000' }],
      ['a missing price', { ...good('NG'), priceMax: undefined }],
      ['a price of 0, which a source never gives (the workbook allows it for a price typed by hand)', { ...good('NG'), priceMin: 0, priceMax: 0 }],
      ['a price beyond what a whole number can hold exactly', { ...good('NG'), priceMax: 2 ** 53 }],
      ['a source that is not https', { ...good('NG'), sourceUrl: 'http://www.pharmacy.example/p' }],
      ['no source', { ...good('NG'), sourceUrl: undefined }],
    ])('adds no row for %s', async (_label, bad) => {
      expect(await rowsFor(bad)).toEqual([])
    })

    it('adds a country once, keeping the first row, when the drafter lists it twice', async () => {
      const rows = await rowsFor({ ...good('NG'), priceMin: 1000, priceMax: 2000 }, { ...good('NG'), priceMin: 5, priceMax: 6 })

      expect(rows).toEqual([{ product_code: 'PRD-CERAVE', country: 'NG', price_min: 1000, price_max: 2000, where_sold: 'Pharmacies', source_url: SRC.price }])
    })

    it('adds a row for a country the product already has none for even when the drafter also lists one it does have', async () => {
      const { outcome } = await run(workbook({ availability: [price('PRD-CERAVE', 'NG', { price_min: 7, price_max: 8 })] }), {
        drafter: answeringRows(good('NG'), good('GB')),
      })

      expect(availabilityOf(outcome.workbook, 'PRD-CERAVE').map((r) => [r.country, r.price_min])).toEqual([
        ['NG', 7],
        ['GB', 4000],
      ])
    })

    it('accepts a lowest price of 1 and a lowest price equal to the highest', async () => {
      const rows = await rowsFor({ ...good('NG'), priceMin: 1, priceMax: 1 }, { ...good('GB'), priceMin: 12, priceMax: 12 })

      expect(rows.map((r) => [r.country, r.price_min, r.price_max])).toEqual([
        ['NG', 1, 1],
        ['GB', 12, 12],
      ])
    })

    it('adds the row without where_sold when the drafter gave none, or gave a link', async () => {
      const rows = await rowsFor({ ...good('NG'), whereSold: undefined }, { ...good('GB'), whereSold: 'Buy at https://shop.example/x' })

      expect(rows.map((r) => r.country)).toEqual(['NG', 'GB'])
      expect(rows.every((r) => isEmpty(r.where_sold))).toBe(true)
    })

    it('writes prices as numbers, which is what a spreadsheet cell of a price is', async () => {
      const rows = await rowsFor(good('NG'))

      expect(typeof rows[0]!.price_min).toBe('number')
      expect(typeof rows[0]!.price_max).toBe('number')
    })
  })
})

describe('draftWorkbook: the result is checked against the workbook contract', () => {
  it('has no problem when everything was filled from good answers, so the output can go straight to an upload', async () => {
    const { outcome } = await run(workbook({ products: [CERAVE, APPROVED, RETIRED, VANICREAM], availability: [price('PRD-APPROVED', 'NG')] }))

    expect(outcome.problems).toEqual([])
  })

  it('lists what is still wrong when the researcher found no ingredients, by tab, row and column, so a person can finish the row', async () => {
    const made = fakes()
    made.researcher.respondWith(() => ({ found: false }))

    // CERAVE is the second data row of Products: the header is row 1.
    const { outcome } = await run(workbook({ products: [APPROVED, CERAVE] }), { researcher: made.researcher })

    expect(outcome.problems).toEqual([{ tab: 'products', row: 3, column: 'ingredients', rule: 'REQUIRED' }])
  })

  it('lists every problem, not just the first', async () => {
    const made = fakes()
    made.researcher.respondWith(() => ({ found: false }))

    const { outcome } = await run(workbook({ products: [CERAVE, VANICREAM] }), { researcher: made.researcher })

    expect(outcome.problems).toEqual(
      expect.arrayContaining([
        { tab: 'products', row: 2, column: 'ingredients', rule: 'REQUIRED' },
        { tab: 'products', row: 3, column: 'ingredients', rule: 'REQUIRED' },
      ]),
    )
    expect(outcome.problems).toHaveLength(2)
  })

  it('writes draft_cells entries the contract accepts: no INVALID_DRAFT_CELL or DRAFT_CELL_COLUMN', async () => {
    const { outcome } = await run(workbook())

    expect(outcome.problems.map((p) => p.rule)).not.toContain('INVALID_DRAFT_CELL')
    expect(outcome.problems.map((p) => p.rule)).not.toContain('DRAFT_CELL_COLUMN')
  })
})

// --- the spend cap ------------------------------------------------------------------------------------------------------------------------------

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 }
const MODEL = 'claude-haiku-5-5'
const RESEARCH: AiJob = 'research'
const DRAFT_CATALOG_ROW: AiJob = 'draft-catalog-row'

/** Spends on the real ledger as the Claude client does (reserve, then settle), then answers from the inner fake. A reservation over the cap throws before the fake is asked. */
const spend = async (ledger: MemoryAiSpendLedger, job: AiJob, micros: number) => {
  const id = await ledger.reserve({ job, model: MODEL, estimateMicros: micros })
  await ledger.settle(id, { usage: ZERO_USAGE, costMicros: micros })
}
class CostedResearcher implements ProductResearcher {
  constructor(
    private readonly inner: ProductResearcher,
    private readonly ledger: MemoryAiSpendLedger,
    private readonly micros: number,
  ) {}
  async research(product: ProductIdentity) {
    await spend(this.ledger, RESEARCH, this.micros)
    return this.inner.research(product)
  }
}
class CostedDrafter implements CatalogDrafter {
  constructor(
    private readonly inner: CatalogDrafter,
    private readonly ledger: MemoryAiSpendLedger,
    private readonly micros: number,
  ) {}
  async draft(request: DraftRequest) {
    await spend(this.ledger, DRAFT_CATALOG_ROW, this.micros)
    return this.inner.draft(request)
  }
}

const CALL_MICROS = 1_000

/** Three draft products, each needing one research call and one drafting call of CALL_MICROS, under a cap of `capMicros`. */
const capped = async (capMicros: number) => {
  const ledger = new MemoryAiSpendLedger({ capMicros })
  const made = fakes()
  const outcome = await draftWorkbook(workbook({ products: [CERAVE, VANICREAM, AVEENO] }), {
    researcher: new CostedResearcher(made.researcher, ledger, CALL_MICROS),
    drafter: new CostedDrafter(made.drafter, ledger, CALL_MICROS),
    ledger,
  })
  return { outcome, ledger, ...made }
}

describe('draftWorkbook: the spend cap', () => {
  it('reports what the ledger says was spent', async () => {
    const { outcome, ledger } = await capped(BIG_CAP_MICROS)

    expect(outcome.stoppedBy).toBeNull()
    expect(outcome.spentMicros).toBe(6 * CALL_MICROS)
    expect(outcome.spentMicros).toBe(ledger.spentMicros())
  })

  it('stops cleanly at the cap, with the products it finished filled and the rest exactly as they were', async () => {
    // Exactly two calls fit: the first product's research and drafting. The third call would pass the cap by one micro or more.
    const { outcome } = await capped(2 * CALL_MICROS)

    expect(outcome.stoppedBy).toBe('cap')
    expect(outcome.spentMicros).toBe(2 * CALL_MICROS)
    expect(productOf(outcome.workbook, 'PRD-CERAVE').frequency).toBe('am-pm')
    expect(listOf(productOf(outcome.workbook, 'PRD-CERAVE').ingredients)).toEqual(INGREDIENT_LIST)
    expect(productOf(outcome.workbook, 'PRD-VANICREAM')).toEqual(VANICREAM)
    expect(productOf(outcome.workbook, 'PRD-AVEENO')).toEqual(AVEENO)
  })

  it('makes no call after the cap is hit', async () => {
    const { researcher, drafter } = await capped(2 * CALL_MICROS)

    expect(researcher.calls.map((c) => c.brand)).toEqual(['CeraVe'])
    expect(drafter.calls.map((c) => c.product.brand)).toEqual(['CeraVe'])
  })

  it('keeps what was filled before the cap was hit inside a product: the ingredient list is kept when the drafting is refused', async () => {
    const { outcome } = await capped(CALL_MICROS + CALL_MICROS - 1)

    const row = productOf(outcome.workbook, 'PRD-CERAVE')
    expect(outcome.stoppedBy).toBe('cap')
    expect(listOf(row.ingredients)).toEqual(INGREDIENT_LIST)
    expect(row.ingredients_source_url).toBe(SRC.ingredients)
    expect(draftCellsOf(outcome.workbook, 'PRD-CERAVE')).toEqual(sorted([`ingredients=${SRC.ingredients}`, `ingredients_source_url=${SRC.ingredients}`]))
    expect(isEmpty(row.frequency)).toBe(true)
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE')).toEqual([])
    expect(outcome.spentMicros).toBe(CALL_MICROS)
  })

  it('stops before the very first call when the cap is too small for it, and returns the workbook as it came', async () => {
    const input = workbook({ products: [CERAVE, VANICREAM, AVEENO] })
    const ledger = new MemoryAiSpendLedger({ capMicros: CALL_MICROS - 1 })
    const made = fakes()

    const outcome = await draftWorkbook(input, { researcher: new CostedResearcher(made.researcher, ledger, CALL_MICROS), drafter: new CostedDrafter(made.drafter, ledger, CALL_MICROS), ledger })

    expect(outcome.stoppedBy).toBe('cap')
    expect(outcome.spentMicros).toBe(0)
    expect(outcome.workbook).toEqual(input)
  })

  it('stops on a refusal from the drafter as well as one from the researcher', async () => {
    const made = fakes()
    made.drafter.failNextWith(new AiBudgetExceededError('The AI spend cap would be exceeded'))

    const { outcome } = await run(workbook({ products: [CERAVE, VANICREAM] }), { drafter: made.drafter })

    expect(outcome.stoppedBy).toBe('cap')
    expect(listOf(productOf(outcome.workbook, 'PRD-CERAVE').ingredients)).toEqual(INGREDIENT_LIST)
    expect(productOf(outcome.workbook, 'PRD-VANICREAM')).toEqual(VANICREAM)
  })

})

describe('draftWorkbook: a call that fails for another reason', () => {
  const SECRET = 'Claude said secret-42 about this product'
  const unavailable = () => new Error(SECRET)

  it('leaves that product as it was when the researcher fails, records it, and carries on with the next product', async () => {
    const made = fakes()
    made.researcher.failNextWith(unavailable())

    // One pass: what a later pass does with a product that failed is pinned under "draftWorkbook: retry passes".
    const { outcome, drafter } = await run(workbook({ products: [CERAVE, VANICREAM] }), { researcher: made.researcher, passes: 1 })

    expect(outcome.failed).toEqual([{ code: 'PRD-CERAVE', reason: 'researcher-error' }])
    expect(productOf(outcome.workbook, 'PRD-CERAVE')).toEqual(CERAVE)
    expect(drafter.calls.map((c) => c.product.brand)).toEqual(['Vanicream'])
    expect(productOf(outcome.workbook, 'PRD-VANICREAM').frequency).toBe('am-pm')
    expect(listOf(productOf(outcome.workbook, 'PRD-VANICREAM').ingredients)).toEqual(INGREDIENT_LIST)
    expect(outcome.stoppedBy).toBeNull()
  })

  it('keeps what the researcher found when the drafter fails, leaves the rest empty, records it, and carries on', async () => {
    const made = fakes()
    made.drafter.failNextWith(unavailable())

    // One pass: a later pass would try this product's prices again (see "draftWorkbook: retry passes").
    const { outcome } = await run(workbook({ products: [CERAVE, VANICREAM] }), { drafter: made.drafter, passes: 1 })

    const failedRow = productOf(outcome.workbook, 'PRD-CERAVE')
    expect(outcome.failed).toEqual([{ code: 'PRD-CERAVE', reason: 'drafter-error' }])
    expect(listOf(failedRow.ingredients)).toEqual(INGREDIENT_LIST)
    expect(draftCellsOf(outcome.workbook, 'PRD-CERAVE')).toEqual(sorted([`ingredients=${SRC.ingredients}`, `ingredients_source_url=${SRC.ingredients}`]))
    expect(isEmpty(failedRow.frequency)).toBe(true)
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE')).toEqual([])
    expect(productOf(outcome.workbook, 'PRD-VANICREAM').frequency).toBe('am-pm')
    expect(availabilityOf(outcome.workbook, 'PRD-VANICREAM').map((r) => r.country)).toEqual(['NG', 'GB'])
  })

  it('records a fixed reason, never the error message', async () => {
    const made = fakes()
    made.researcher.failNextWith(unavailable())

    const { outcome } = await run(workbook(), { researcher: made.researcher })

    expect(JSON.stringify(outcome)).not.toContain('secret-42')
    expect(formatReport(outcome)).not.toContain('secret-42')
  })

  it('records each product that failed, in row order', async () => {
    const researcher = new MemoryProductResearcher()
    researcher.respondWith(() => ({ found: true, ingredients: INGREDIENT_LIST, sourceUrl: SRC.ingredients }))
    const failing: ProductResearcher = {
      research: async (product) => {
        if (product.brand !== 'Vanicream') throw unavailable()
        return researcher.research(product)
      },
    }

    const { outcome } = await run(workbook({ products: [CERAVE, VANICREAM, AVEENO] }), { researcher: failing })

    expect(outcome.failed).toEqual([
      { code: 'PRD-CERAVE', reason: 'researcher-error' },
      { code: 'PRD-AVEENO', reason: 'researcher-error' },
    ])
    expect(productOf(outcome.workbook, 'PRD-VANICREAM').frequency).toBe('am-pm')
  })

  it('still stops at the spend cap after an earlier product failed, keeping that failure on the record', async () => {
    const made = fakes()
    made.researcher.failNextWith(unavailable())
    made.drafter.respondWith(everything)
    const ledger = new MemoryAiSpendLedger({ capMicros: CALL_MICROS })
    // The first product's research fails before it costs anything; the second product's research fits the cap, its drafting does not.
    const first = new CostedResearcher(made.researcher, ledger, 0)
    const outcome = await draftWorkbook(workbook({ products: [CERAVE, VANICREAM, AVEENO] }), {
      researcher: { research: (product) => (product.brand === 'CeraVe' ? first.research(product) : new CostedResearcher(made.researcher, ledger, CALL_MICROS).research(product)) },
      drafter: new CostedDrafter(made.drafter, ledger, CALL_MICROS),
      ledger,
    })

    expect(outcome.failed).toEqual([{ code: 'PRD-CERAVE', reason: 'researcher-error' }])
    expect(outcome.stoppedBy).toBe('cap')
    expect(productOf(outcome.workbook, 'PRD-AVEENO')).toEqual(AVEENO)
  })
})

describe('draftWorkbook: a call that fails because the setup is wrong', () => {
  const SECRET = 'invalid x-api-key sk-ant-secret-42'

  it('stops the run on a bad key, billing or permission, leaving the products as they were, and does not call that a product failing', async () => {
    const made = fakes()
    made.researcher.failNextWith(new AnthropicConfigError(SECRET))

    const { outcome, drafter } = await run(workbook({ products: [CERAVE, VANICREAM] }), { researcher: made.researcher })

    expect(outcome.stoppedBy).toBe('config')
    expect(outcome.failed).toEqual([])
    expect(outcome.workbook.products.rows).toEqual([CERAVE, VANICREAM])
    expect(drafter.calls).toEqual([])
  })

  it('stops on the same error from the drafter, keeping the ingredient list already found, and makes no further call', async () => {
    const made = fakes()
    made.drafter.failNextWith(new AnthropicConfigError(SECRET))

    const { outcome, researcher } = await run(workbook({ products: [CERAVE, VANICREAM] }), { drafter: made.drafter })

    expect(outcome.stoppedBy).toBe('config')
    expect(outcome.failed).toEqual([])
    expect(listOf(productOf(outcome.workbook, 'PRD-CERAVE').ingredients)).toEqual(INGREDIENT_LIST)
    expect(productOf(outcome.workbook, 'PRD-VANICREAM')).toEqual(VANICREAM)
    expect(researcher.calls.map((c) => c.brand)).toEqual(['CeraVe'])
  })

  it('says so in fixed words, never in the error message', async () => {
    const made = fakes()
    made.researcher.failNextWith(new AnthropicConfigError(SECRET))

    const { outcome } = await run(workbook(), { researcher: made.researcher })

    const report = formatReport(outcome)
    expect(report).toMatch(/key|billing|permission/i)
    expect(report).not.toContain('secret-42')
    expect(JSON.stringify(outcome)).not.toContain('secret-42')
  })

  it('writes the partial workbook all the same, and returns the stop, so the file is not lost', async () => {
    const files = io(workbook({ products: [CERAVE] }))
    const made = fakes()
    made.researcher.failNextWith(new AnthropicConfigError(SECRET))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    const outcome = await runDraft(ARGS, { researcher: made.researcher, drafter: made.drafter, ledger, io: files })

    expect(outcome.stoppedBy).toBe('config')
    expect(files.writes).toHaveLength(1)
  })
})

// --- retry passes -------------------------------------------------------------------------------------------------------------------------------

// Drafted prices feed a budget band, so coverage matters more than exactness: after the first pass, each later pass revisits only the draft products that
// still lack a price for some wanted country, asking the drafter for those countries alone (no columns, so no cell is touched) with the attempt number, so
// it can look more widely. The researcher is never asked again.
describe('draftWorkbook: retry passes', () => {
  const attemptOf = (request: DraftRequest) => request.attempt ?? 1
  const priceRow = (country: string, over: Record<string, unknown> = {}) => ({ country, priceMin: 4000, priceMax: 6500, whereSold: 'Pharmacies', sourceUrl: SRC.price, ...over })
  /** A drafter that records every request, and answers from `answer` (nothing at all by default). */
  const scripted = (answer: (request: DraftRequest) => DraftResult = () => ({ cells: {}, availability: [] })) => {
    const calls: DraftRequest[] = []
    const drafter: CatalogDrafter = {
      draft: async (request) => {
        calls.push(request)
        return answer(request)
      },
    }
    return { calls, drafter }
  }
  /** The rows for those of the countries asked whose code is in `codes`. */
  const pricing = (request: DraftRequest, codes: string[]): DraftResult => ({
    cells: {},
    availability: request.countries.filter((country) => codes.includes(country.code)).map((country) => priceRow(country.code)),
  })
  const countriesOf = (request: DraftRequest) => request.countries.map((country) => country.code)
  const brandsAndAttempts = (calls: DraftRequest[]) => calls.map((call) => [call.product.brand, attemptOf(call)])

  it('asks again, in a second pass, for only the countries still without a price, with no columns and the attempt number, and adds what it finds', async () => {
    const { calls, drafter } = scripted((request) => pricing(request, attemptOf(request) === 1 ? ['NG'] : ['GB']))

    const { outcome } = await run(workbook(), { drafter })

    expect(calls).toHaveLength(2)
    expect(attemptOf(calls[0]!)).toBe(1)
    expect(calls[0]!.columns).not.toEqual([])
    expect(countriesOf(calls[0]!)).toEqual(['NG', 'GB'])
    expect(calls[1]!.attempt).toBe(2)
    expect(calls[1]!.columns).toEqual([])
    expect(calls[1]!.countries).toEqual([{ code: 'GB', currency: 'GBP' }])
    expect(calls[1]!.product).toEqual(calls[0]!.product)
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE').map((r) => r.country)).toEqual(['NG', 'GB'])
  })

  it('makes no second pass when the first priced every country', async () => {
    const { calls, drafter } = scripted((request) => pricing(request, ['NG', 'GB']))

    await run(workbook(), { drafter })

    expect(calls).toHaveLength(1)
  })

  it.each([
    ['by default, three passes', undefined, 3],
    ['one pass', 1, 1],
    ['two passes', 2, 2],
    ['three passes', 3, 3],
    ['five passes', 5, 5],
  ])('asks about a country that is never priced %s, numbering the attempts from 1', async (_label, passes, asked) => {
    const { calls, drafter } = scripted()

    await run(workbook(), { drafter, passes })

    expect(calls.map(attemptOf)).toEqual(Array.from({ length: asked }, (_, i) => i + 1))
  })

  it('stops asking once the last missing price is found: the third pass is not made when the second priced the rest', async () => {
    const { calls, drafter } = scripted((request) => pricing(request, attemptOf(request) === 1 ? [] : ['NG', 'GB']))

    await run(workbook(), { drafter })

    expect(calls.map(attemptOf)).toEqual([1, 2])
  })

  it('revisits only the products that still lack a price: a product priced in the first pass is not asked about again', async () => {
    const { calls, drafter } = scripted((request) => pricing(request, request.product.brand === 'CeraVe' || attemptOf(request) > 1 ? ['NG', 'GB'] : []))

    await run(workbook({ products: [CERAVE, VANICREAM] }), { drafter })

    expect(brandsAndAttempts(calls)).toEqual([
      ['CeraVe', 1],
      ['Vanicream', 1],
      ['Vanicream', 2],
    ])
  })

  it('does not revisit a product that already had a price for every country, even though its cells are empty and nothing was drafted', async () => {
    const { calls, drafter } = scripted()

    await run(workbook({ availability: [price('PRD-CERAVE', 'NG'), price('PRD-CERAVE', 'GB')] }), { drafter })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.countries).toEqual([])
  })

  it('never asks the researcher again, even for a product whose ingredient list it could not find', async () => {
    const made = fakes()
    made.researcher.respondWith(() => ({ found: false }))
    const { calls, drafter } = scripted()

    await run(workbook({ products: [CERAVE, VANICREAM] }), { researcher: made.researcher, drafter })

    expect(calls).toHaveLength(6)
    expect(made.researcher.calls.map((c) => c.brand)).toEqual(['CeraVe', 'Vanicream'])
  })

  it('never asks about a row whose identity the contract would refuse, in any pass', async () => {
    const nameless = blank('PRD-NAMELESS', 'Brand', 'x', { name: '  ' })
    const { calls, drafter } = scripted()

    const { outcome } = await run(workbook({ products: [nameless, CERAVE] }), { drafter })

    expect(outcome.skipped).toEqual(['PRD-NAMELESS'])
    expect(calls.map((c) => c.product.brand)).toEqual(['CeraVe', 'CeraVe', 'CeraVe'])
  })

  it('writes what a later pass finds like a first pass: one row per country, with the source, and the answer checked at the same door', async () => {
    const { calls, drafter } = scripted((request) => {
      if (attemptOf(request) === 1) return pricing(request, ['NG'])
      return {
        // A cell nobody asked for, a country that already has a price, and a good row without where_sold.
        cells: { frequency: { value: 'pm', sourceUrl: SRC.frequency } },
        availability: [priceRow('NG', { priceMin: 1, priceMax: 2 }), priceRow('GB', { priceMin: 9, priceMax: 12, whereSold: undefined, sourceUrl: 'https://www.pharmacy.example/gb' })],
      }
    })

    const { outcome } = await run(workbook(), { drafter, passes: 2 })

    expect(calls).toHaveLength(2)
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE')).toEqual([
      { product_code: 'PRD-CERAVE', country: 'NG', price_min: 4000, price_max: 6500, where_sold: 'Pharmacies', source_url: SRC.price },
      { product_code: 'PRD-CERAVE', country: 'GB', price_min: 9, price_max: 12, where_sold: null, source_url: 'https://www.pharmacy.example/gb' },
    ])
    // The later pass was asked for no column, so a cell it volunteers is not written and leaves no draft_cells entry.
    expect(isEmpty(productOf(outcome.workbook, 'PRD-CERAVE').frequency)).toBe(true)
    expect(draftCellsOf(outcome.workbook, 'PRD-CERAVE').some((entry) => entry.startsWith('frequency='))).toBe(false)
  })

  it('refuses a price row from a later pass that the workbook door refuses, and asks again in the next pass', async () => {
    const { calls, drafter } = scripted((request) => {
      if (attemptOf(request) === 1) return pricing(request, ['NG'])
      if (attemptOf(request) === 2) return { cells: {}, availability: [priceRow('GB', { sourceUrl: 'http://www.pharmacy.example/gb' })] }
      return { cells: {}, availability: [priceRow('GB', { sourceUrl: 'https://www.pharmacy.example/gb' })] }
    })

    const { outcome } = await run(workbook(), { drafter })

    expect(calls.map(attemptOf)).toEqual([1, 2, 3])
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE').map((r) => [r.country, r.source_url])).toEqual([
      ['NG', SRC.price],
      ['GB', 'https://www.pharmacy.example/gb'],
    ])
  })

  it('retries a product whose drafter call failed, for its prices only, and still records the failure because its cells were not drafted', async () => {
    const made = fakes()
    made.drafter.failNextWith(new Error('overloaded'))

    const { outcome } = await run(workbook(), { drafter: made.drafter })

    // The failed call recorded nothing, so the first call on record is the retry.
    expect(made.drafter.calls).toHaveLength(1)
    expect(made.drafter.calls[0]!.attempt).toBe(2)
    expect(made.drafter.calls[0]!.columns).toEqual([])
    expect(countriesOf(made.drafter.calls[0]!)).toEqual(['NG', 'GB'])
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE').map((r) => r.country)).toEqual(['NG', 'GB'])
    expect(isEmpty(productOf(outcome.workbook, 'PRD-CERAVE').frequency)).toBe(true)
    expect(outcome.failed).toEqual([{ code: 'PRD-CERAVE', reason: 'drafter-error' }])
    expect(outcome.stoppedBy).toBeNull()
  })

  it('prices, in a later pass, a product whose research failed, without researching it again, and still records the failure', async () => {
    const made = fakes()
    made.researcher.failNextWith(new Error('overloaded'))

    const { outcome } = await run(workbook({ products: [CERAVE, VANICREAM] }), { researcher: made.researcher, drafter: made.drafter })

    // The failed research recorded nothing, so a research call for CeraVe on record would be a second one.
    expect(brandsAndAttempts(made.drafter.calls)).toEqual([
      ['Vanicream', 1],
      ['CeraVe', 2],
    ])
    expect(made.drafter.calls[1]!.columns).toEqual([])
    expect(made.researcher.calls.map((c) => c.brand)).toEqual(['Vanicream'])
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE').map((r) => r.country)).toEqual(['NG', 'GB'])
    expect(productOf(outcome.workbook, 'PRD-CERAVE')).toEqual({ ...CERAVE })
    expect(outcome.failed).toEqual([{ code: 'PRD-CERAVE', reason: 'researcher-error' }])
  })

  it('carries on after a failed call in a later pass: the next product is still asked, and the failed one again in the pass after', async () => {
    const { calls, drafter } = scripted((request) => {
      if (attemptOf(request) === 2 && request.product.brand === 'CeraVe') throw new Error('overloaded')
      return pricing(request, attemptOf(request) === 3 ? ['NG', 'GB'] : [])
    })

    const { outcome } = await run(workbook({ products: [CERAVE, VANICREAM] }), { drafter })

    expect(brandsAndAttempts(calls)).toEqual([
      ['CeraVe', 1],
      ['Vanicream', 1],
      ['CeraVe', 2],
      ['Vanicream', 2],
      ['CeraVe', 3],
      ['Vanicream', 3],
    ])
    expect(outcome.stoppedBy).toBeNull()
    // A retry that fails is no product failing: its cells were drafted in the first pass.
    expect(outcome.failed).toEqual([])
    expect(availabilityOf(outcome.workbook, 'PRD-CERAVE').map((r) => r.country)).toEqual(['NG', 'GB'])
    expect(availabilityOf(outcome.workbook, 'PRD-VANICREAM').map((r) => r.country)).toEqual(['NG', 'GB'])
  })

  it('does not record a product as failed when only its retries fail: the pair stays unpriced and is listed as missing, and every pass is still made', async () => {
    const { calls, drafter } = scripted((request) => {
      if (attemptOf(request) > 1) throw new Error('overloaded')
      return pricing(request, [])
    })

    const { outcome } = await run(workbook({ products: [CERAVE, VANICREAM] }), { drafter })

    expect(outcome.failed).toEqual([])
    expect(outcome.stoppedBy).toBeNull()
    expect(calls.map(attemptOf)).toEqual([1, 1, 2, 2, 3, 3])
    expect(outcome.prices.missing).toEqual([
      { code: 'PRD-CERAVE', countries: ['NG', 'GB'] },
      { code: 'PRD-VANICREAM', countries: ['NG', 'GB'] },
    ])
    expect(formatReport(outcome)).not.toContain('Failed')
  })

  it('records only the first pass\'s failure of a product: a product that failed in the researcher and again in a retry is listed once', async () => {
    const made = fakes()
    made.researcher.failNextWith(new Error('overloaded'))
    const { drafter } = scripted((request) => {
      if (attemptOf(request) > 1) throw new Error('overloaded again')
      return pricing(request, [])
    })

    const { outcome } = await run(workbook(), { researcher: made.researcher, drafter })

    expect(outcome.failed).toEqual([{ code: 'PRD-CERAVE', reason: 'researcher-error' }])
  })

  it('records a product whose drafter failed in the first pass once, however many retries fail too', async () => {
    const { drafter } = scripted(() => {
      throw new Error('overloaded')
    })

    const { outcome } = await run(workbook(), { drafter })

    expect(outcome.failed).toEqual([{ code: 'PRD-CERAVE', reason: 'drafter-error' }])
  })

  it('stops everything on a bad key, billing or permission met in a later pass, asking no further product or pass', async () => {
    const { calls, drafter } = scripted((request) => {
      if (attemptOf(request) === 2) throw new AnthropicConfigError('invalid x-api-key sk-ant-secret-42')
      return pricing(request, [])
    })

    const { outcome } = await run(workbook({ products: [CERAVE, VANICREAM] }), { drafter })

    expect(outcome.stoppedBy).toBe('config')
    expect(brandsAndAttempts(calls)).toEqual([
      ['CeraVe', 1],
      ['Vanicream', 1],
      ['CeraVe', 2],
    ])
    expect(outcome.failed).toEqual([])
    expect(JSON.stringify(outcome)).not.toContain('secret-42')
  })

  describe('the spend cap', () => {
    /** One product: a research call and a first drafting call that prices NG only, then a second drafting call that prices GB; each costs CALL_MICROS. */
    const cappedAt = async (capMicros: number) => {
      const ledger = new MemoryAiSpendLedger({ capMicros })
      const made = fakes()
      const { calls, drafter } = scripted((request) => pricing(request, attemptOf(request) === 1 ? ['NG'] : ['GB']))
      const outcome = await draftWorkbook(workbook(), { researcher: new CostedResearcher(made.researcher, ledger, CALL_MICROS), drafter: new CostedDrafter(drafter, ledger, CALL_MICROS), ledger })
      return { outcome, calls }
    }

    it('stops at the cap met in a later pass, keeping what was priced before it and asking no more', async () => {
      const { outcome, calls } = await cappedAt(3 * CALL_MICROS - 1)

      expect(outcome.stoppedBy).toBe('cap')
      expect(outcome.spentMicros).toBe(2 * CALL_MICROS)
      expect(calls).toHaveLength(1)
      expect(availabilityOf(outcome.workbook, 'PRD-CERAVE').map((r) => r.country)).toEqual(['NG'])
      expect(listOf(productOf(outcome.workbook, 'PRD-CERAVE').ingredients)).toEqual(INGREDIENT_LIST)
      expect(outcome.failed).toEqual([])
    })

    it('makes the second pass when the cap leaves room for exactly its call', async () => {
      const { outcome, calls } = await cappedAt(3 * CALL_MICROS)

      expect(outcome.stoppedBy).toBeNull()
      expect(outcome.spentMicros).toBe(3 * CALL_MICROS)
      expect(calls.map(attemptOf)).toEqual([1, 2])
      expect(availabilityOf(outcome.workbook, 'PRD-CERAVE').map((r) => r.country)).toEqual(['NG', 'GB'])
    })
  })
})

describe('formatReport', () => {
  /** A run of one product: one research call and one drafting call, costing `micros` between them. */
  const spendOf = async (micros: number) => {
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
    const made = fakes()
    const half = micros / 2
    return draftWorkbook(workbook(), { researcher: new CostedResearcher(made.researcher, ledger, half), drafter: new CostedDrafter(made.drafter, ledger, half), ledger })
  }

  it('prints the spend in dollars to four places', async () => {
    expect(formatReport(await spendOf(12_300))).toContain('$0.0123')
    expect(formatReport(await spendOf(2_000_000))).toContain('$2.0000')
  })

  it('lists each remaining problem with its tab, row, column and rule', async () => {
    const made = fakes()
    made.researcher.respondWith(() => ({ found: false }))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
    const outcome = await draftWorkbook(workbook({ products: [APPROVED, CERAVE] }), { researcher: made.researcher, drafter: made.drafter, ledger })

    const report = formatReport(outcome)

    for (const part of ['products', '3', 'ingredients', 'REQUIRED']) expect(report).toContain(part)
  })

  it('says the cap stopped the run, when it did', async () => {
    const ledger = new MemoryAiSpendLedger({ capMicros: CALL_MICROS })
    const made = fakes()
    const outcome = await draftWorkbook(workbook(), { researcher: new CostedResearcher(made.researcher, ledger, CALL_MICROS), drafter: new CostedDrafter(made.drafter, ledger, CALL_MICROS), ledger })

    expect(formatReport(outcome)).toMatch(/cap/i)
  })

  it('does not mention the cap when the run finished', async () => {
    expect(formatReport(await spendOf(2_000))).not.toMatch(/cap/i)
  })

  it('names each product that failed', async () => {
    const made = fakes()
    made.researcher.failNextWith(new Error('boom'))
    const { outcome } = await run(workbook({ products: [CERAVE, VANICREAM] }), { researcher: made.researcher })

    const report = formatReport(outcome)

    expect(report).toContain('PRD-CERAVE')
    expect(report).not.toContain('PRD-VANICREAM')
  })

  it('names a skipped row', async () => {
    const { outcome } = await run(workbook({ products: [blank('PRD-NAMELESS', 'Brand', 'x', { name: '' })] }))

    expect(formatReport(outcome)).toContain('PRD-NAMELESS')
  })

  describe('the prices line', () => {
    // CeraVe is priced in both countries, Vanicream only in GB, Aveeno in none: 3 of 6 product-country pairs.
    const PRICED: Record<string, string[]> = { CeraVe: ['NG', 'GB'], Vanicream: ['GB'], Aveeno: [] }
    const partlyPriced = (passes?: number) => {
      const drafter = new MemoryCatalogDrafter()
      drafter.respondWith((request) => ({
        cells: {},
        availability: request.countries
          .filter((country) => PRICED[request.product.brand]!.includes(country.code))
          .map((country) => ({ country: country.code, priceMin: 4000, priceMax: 6500, sourceUrl: SRC.price })),
      }))
      return run(workbook({ products: [CERAVE, VANICREAM, AVEENO] }), { drafter, passes })
    }
    const pricesLine = (report: string) => report.split('\n').find((line) => line.startsWith('Prices:'))

    it('says how many product-country pairs are priced, out of how many were asked, and after how many passes', async () => {
      const { outcome } = await partlyPriced()

      const line = pricesLine(formatReport(outcome))

      expect(line).toBeDefined()
      expect(line).toContain('3 of 6')
      expect(line).toContain('3 passes')
    })

    it.each([
      [1, '1 pass'],
      [2, '2 pass'],
    ])('counts the passes made: %d', async (passes, expected) => {
      const { outcome } = await partlyPriced(passes)

      expect(pricesLine(formatReport(outcome))).toContain(expected)
    })

    it('counts a price the workbook already had as priced, and does not list its country as missing', async () => {
      const { outcome } = await run(workbook({ availability: [price('PRD-CERAVE', 'NG')] }), { drafter: new MemoryCatalogDrafter() })

      const report = formatReport(outcome)

      expect(pricesLine(report)).toContain('1 of 2')
      expect(report).toMatch(/PRD-CERAVE: GB(\s|$)/)
      expect(report).not.toMatch(/PRD-CERAVE: NG/)
    })

    it('lists, for each product still missing a price, its code and the countries it lacks', async () => {
      const { outcome } = await partlyPriced()

      const report = formatReport(outcome)

      expect(report).toContain('PRD-AVEENO: NG, GB')
      expect(report).toMatch(/PRD-VANICREAM: NG(\s|$)/)
      expect(report).not.toMatch(/PRD-CERAVE: (NG|GB)/)
    })

    it('says everything is priced, and lists no product, when every pair was', async () => {
      const { outcome } = await run(workbook({ products: [CERAVE, VANICREAM, AVEENO] }))

      const report = formatReport(outcome)

      expect(pricesLine(report)).toContain('6 of 6')
      expect(report).not.toMatch(/PRD-\w+: (NG|GB)/)
    })

    it('counts only the prices that were found, when the spend cap stopped the run in a later pass', async () => {
      const ledger = new MemoryAiSpendLedger({ capMicros: 2 * CALL_MICROS })
      const made = fakes()
      made.drafter.respondWith((request) => ({
        cells: {},
        availability: request.countries.filter((country) => country.code === 'NG').map((country) => ({ country: country.code, priceMin: 4000, priceMax: 6500, sourceUrl: SRC.price })),
      }))
      const outcome = await draftWorkbook(workbook(), { researcher: new CostedResearcher(made.researcher, ledger, CALL_MICROS), drafter: new CostedDrafter(made.drafter, ledger, CALL_MICROS), ledger })

      const report = formatReport(outcome)

      expect(outcome.stoppedBy).toBe('cap')
      expect(pricesLine(report)).toContain('1 of 2')
      expect(report).toContain('PRD-CERAVE: GB')
      expect(report).toMatch(/cap/i)
    })
  })
})

// --- the run: read a file, draft, write a new one ----------------------------------------------------------------------------------------------

/** What the input file remembers about where it was exported from, as the reader gives it. */
type FileStamp = { environment: string | null; contractVersion: string | null }
const STAMP: FileStamp = { environment: 'staging', contractVersion: '1.0.0' }

const io = (input: RawWorkbook, catalogVersion: number | null = 7, stamp: FileStamp = STAMP) => {
  const reads: string[] = []
  const writes: { path: string; workbook: RawWorkbook; catalogVersion: number | null; stamp: { environment?: string; contractVersion?: string } }[] = []
  return {
    reads,
    writes,
    readWorkbook: async (path: string) => {
      reads.push(path)
      return { workbook: input, catalogVersion, ...stamp }
    },
    writeWorkbook: async (path: string, workbook: RawWorkbook, version: number | null, written: { environment?: string; contractVersion?: string }) => {
      writes.push({ path, workbook, catalogVersion: version, stamp: written })
    },
  }
}

const ARGS: { input: string; out: string; maxUsd: number; countries: string[] | undefined } = { input: 'catalog-v7.xlsx', out: 'catalog-v7-drafted.xlsx', maxUsd: 2, countries: undefined }

describe('runDraft', () => {
  const runFile = async (input: RawWorkbook, over: Partial<typeof ARGS & { ledger: MemoryAiSpendLedger; catalogVersion: number | null }> = {}) => {
    const files = io(input, over.catalogVersion === undefined ? 7 : over.catalogVersion)
    const made = fakes()
    const ledger = over.ledger ?? new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
    const researcher: ProductResearcher = made.researcher
    const { ledger: _ledger, catalogVersion: _version, ...args } = over
    const outcome = await runDraft({ ...ARGS, ...args }, { researcher, drafter: made.drafter, ledger, io: files })
    return { outcome, files, ...made }
  }

  it('reads the input file and writes the drafted workbook to the --out path, once', async () => {
    const { outcome, files } = await runFile(workbook())

    expect(files.reads).toEqual(['catalog-v7.xlsx'])
    expect(files.writes).toHaveLength(1)
    expect(files.writes[0]!.path).toBe('catalog-v7-drafted.xlsx')
    expect(files.writes[0]!.workbook).toEqual(outcome.workbook)
    expect(productOf(files.writes[0]!.workbook, 'PRD-CERAVE').frequency).toBe('am-pm')
  })

  it('never writes to the input path', async () => {
    const { files } = await runFile(workbook())

    expect(files.writes.map((w) => w.path)).not.toContain('catalog-v7.xlsx')
  })

  it('carries the catalog version of the input file over to the output, or its absence', async () => {
    expect((await runFile(workbook(), { catalogVersion: 7 })).files.writes[0]!.catalogVersion).toBe(7)
    expect((await runFile(workbook(), { catalogVersion: null })).files.writes[0]!.catalogVersion).toBeNull()
  })

  it('carries the environment and the contract version of the input file over to the output, so the draft can be uploaded where it was exported from', async () => {
    const files = io(workbook(), 7, { environment: 'production', contractVersion: '1.0.0' })
    const made = fakes()
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await runDraft(ARGS, { researcher: made.researcher, drafter: made.drafter, ledger, io: files })

    expect(files.writes[0]!.stamp).toEqual({ environment: 'production', contractVersion: '1.0.0' })
  })

  it('stamps nothing the input file did not have, so a file with no environment is still refused by the upload', async () => {
    const files = io(workbook(), 7, { environment: null, contractVersion: null })
    const made = fakes()
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await runDraft(ARGS, { researcher: made.researcher, drafter: made.drafter, ledger, io: files })

    expect(files.writes[0]!.stamp.environment).toBeUndefined()
    expect(files.writes[0]!.stamp.contractVersion).toBeUndefined()
  })

  it('writes the partial workbook when the spend cap stops the run, and says it stopped', async () => {
    const ledger = new MemoryAiSpendLedger({ capMicros: CALL_MICROS })
    const files = io(workbook({ products: [CERAVE, VANICREAM] }))
    const made = fakes()

    const outcome = await runDraft(ARGS, { researcher: new CostedResearcher(made.researcher, ledger, CALL_MICROS), drafter: new CostedDrafter(made.drafter, ledger, CALL_MICROS), ledger, io: files })

    expect(outcome.stoppedBy).toBe('cap')
    expect(files.writes).toHaveLength(1)
    expect(listOf(productOf(files.writes[0]!.workbook, 'PRD-CERAVE').ingredients)).toEqual(INGREDIENT_LIST)
    expect(productOf(files.writes[0]!.workbook, 'PRD-VANICREAM')).toEqual(VANICREAM)
  })

  it('still writes the workbook when problems remain, and returns them, so a person can finish it', async () => {
    const files = io(workbook({ products: [CERAVE] }))
    const made = fakes()
    made.researcher.respondWith(() => ({ found: false }))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    const outcome = await runDraft(ARGS, { researcher: made.researcher, drafter: made.drafter, ledger, io: files })

    expect(files.writes).toHaveLength(1)
    expect(outcome.problems).toEqual([{ tab: 'products', row: 2, column: 'ingredients', rule: 'REQUIRED' }])
  })

  it('still writes the workbook when a product failed, with the others drafted', async () => {
    const files = io(workbook({ products: [CERAVE, VANICREAM] }))
    const made = fakes()
    made.researcher.failNextWith(new Error('boom'))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    const outcome = await runDraft(ARGS, { researcher: made.researcher, drafter: made.drafter, ledger, io: files })

    expect(outcome.failed).toEqual([{ code: 'PRD-CERAVE', reason: 'researcher-error' }])
    expect(files.writes).toHaveLength(1)
    expect(productOf(files.writes[0]!.workbook, 'PRD-CERAVE')).toEqual(CERAVE)
    expect(productOf(files.writes[0]!.workbook, 'PRD-VANICREAM').frequency).toBe('am-pm')
  })

  it('drafts only the countries given on the command line', async () => {
    const { files, drafter } = await runFile(workbook(), { countries: ['GB'] })

    expect(drafter.calls[0]!.countries).toEqual([{ code: 'GB', currency: 'GBP' }])
    expect(availabilityOf(files.writes[0]!.workbook, 'PRD-CERAVE').map((r) => r.country)).toEqual(['GB'])
  })

  it('makes the number of passes it is given, so --passes reaches the drafting', async () => {
    const made = fakes()
    made.drafter.respondWith(() => ({ cells: {}, availability: [] }))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await runDraft({ ...ARGS, passes: 2 }, { researcher: made.researcher, drafter: made.drafter, ledger, io: io(workbook()) })

    expect(made.drafter.calls.map((call) => call.attempt ?? 1)).toEqual([1, 2])
  })

  it('makes three passes when it is given no number', async () => {
    const made = fakes()
    made.drafter.respondWith(() => ({ cells: {}, availability: [] }))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await runDraft(ARGS, { researcher: made.researcher, drafter: made.drafter, ledger, io: io(workbook()) })

    expect(made.drafter.calls.map((call) => call.attempt ?? 1)).toEqual([1, 2, 3])
  })

  it('writes the prices a later pass found', async () => {
    const files = io(workbook())
    const made = fakes()
    made.drafter.respondWith((request) => ({
      cells: {},
      availability: request.countries
        .filter((country) => (request.attempt ?? 1) > 1 || country.code === 'NG')
        .map((country) => ({ country: country.code, priceMin: 4000, priceMax: 6500, sourceUrl: SRC.price })),
    }))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await runDraft(ARGS, { researcher: made.researcher, drafter: made.drafter, ledger, io: files })

    expect(availabilityOf(files.writes[0]!.workbook, 'PRD-CERAVE').map((r) => r.country)).toEqual(['NG', 'GB'])
  })

  it('writes nothing when the input cannot be read', async () => {
    const files = io(workbook())
    const failure = new Error('no such file')
    files.readWorkbook = async () => {
      throw failure
    }
    const made = fakes()
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await expect(runDraft(ARGS, { researcher: made.researcher, drafter: made.drafter, ledger, io: files })).rejects.toBe(failure)

    expect(files.writes).toEqual([])
  })
})
