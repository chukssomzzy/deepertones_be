import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { desc, eq } from 'drizzle-orm'
import worker from '../../src/index'
import { createDb } from '../../src/lib/db'
import { D1CatalogWorkbookRepository } from '../../src/modules/catalog/catalog.workbook.repository'
import { catalogVersions } from '../../src/modules/catalog/catalog.workbook.table'
// Types only: this file must load while the schema module is being renamed (contract.ts to schema.ts), so a missing module fails a test, not the file.
import type { RawRow, RawTab, RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'

// What the admin catalog tests share: the Worker called with an admin token, a fresh address per call (the admin limiter counts every
// request from an address, wrong tokens included, 10 a minute), and the workbook as the product itself moves it: export, edit, import.

export type Tab = keyof RawWorkbook

/**
 * A token for this file's Worker only. The Worker is handed it as a binding here, the way shelf.routes.test.ts hands it a queue, so no
 * deployed secret, vitest.config.ts value or .dev.vars line is needed to run the tests.
 */
export const ADMIN_TOKEN = 'test-admin-token-5d1c0b7e9a'
export const WORKER_ENV = { ...env, ADMIN_API_TOKEN: ADMIN_TOKEN } as unknown as typeof env

export const fetchWorker = (input: RequestInfo | URL, init?: RequestInit, workerEnv: typeof env = WORKER_ENV) =>
  worker.fetch!(new Request(input, init) as never, workerEnv, createExecutionContext())

export const ORIGIN = 'http://deepertones.test'
export const EXPORT_URL = `${ORIGIN}/api/v1/admin/catalog/export`
export const IMPORT_URL = `${ORIGIN}/api/v1/admin/catalog/import`

/**
 * The contract version this checkout serves, written out: the version of the contract that adds the Guides tab. A literal, not read
 * from the code, so a bump has to be made here too.
 */
export const CONTRACT_VERSION = '2.2.0'

export const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// --- one clock for every date in these tests ---

/** The day every date hangs from; fixtures are offsets from it, so nothing rots as the calendar moves. */
const BASE = new Date('2030-06-15T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
export const day = (offset: number) => new Date(BASE.getTime() + offset * DAY).toISOString().slice(0, 10)
export const APPROVED_ON = day(-3)

// --- names no other test (or earlier run) used, and a new address for every call ---

export const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
export const next = () => counter++
/** One word, ending in z so that no word is inside another. */
export const word = (label = 'adm') => `${label}${runSalt}n${next()}z`
export const freshIp = () => {
  const n = next()
  return `10.${(Number(runSalt) + 7) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
/** Product and rule codes are capitals, digits and hyphens. */
export const code = (prefix: string) => `${prefix}-${runSalt}-${next()}`

// --- the headers of each tab, written out from the spec's tables, in the order the workbook has them (not read back from the contract) ---

export const HEADERS = {
  products: ['code', 'brand', 'name', 'variant', 'form', 'category', 'ingredients', 'ingredients_source_url', 'key_ingredient', 'strength', 'skin_concerns', 'skin_types', 'steps', 'frequency', 'own_cautions', 'evidence_urls', 'origin', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on', 'draft_cells'],
  availability: ['product_code', 'country', 'price_min', 'price_max', 'where_sold', 'source_url'],
  ingredients: ['code', 'name', 'aliases', 'kind', 'strength_limit', 'statement', 'source_url', 'helps', 'group', 'clashes_with', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  countries: ['code', 'currency', 'low_max', 'mid_max', 'status'],
  claimWords: ['code', 'phrase', 'claim', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  tapers: ['code', 'kind', 'schedule', 'what_to_expect', 'see_a_professional_if', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  guides: ['step', 'goal', 'what_it_does', 'look_for', 'for_deeper_skin', 'look_for_when_pregnant', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
} as const satisfies Record<Tab, readonly string[]>
export const TABS = Object.keys(HEADERS) as Tab[]

// --- rows, in the form an export gives and an import takes: lists joined with "; ", dates as YYYY-MM-DD, empty cells null ---

export const productRow = (over: RawRow = {}): RawRow => {
  const brand = word('Brand')
  return {
    code: code('PRD'),
    brand,
    name: 'Hydrating Cleanser',
    variant: null,
    form: null,
    category: 'skin',
    ingredients: 'Aqua; Glycerin; Cetearyl Alcohol',
    ingredients_source_url: 'https://example.com/hydrating-cleanser',
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
    approved_on: APPROVED_ON,
    audited_by: null,
    audited_on: null,
    draft_cells: null,
    ...over,
  }
}

export const availabilityRow = (productCode: string, over: RawRow = {}): RawRow => ({
  product_code: productCode,
  country: 'NG',
  price_min: 3000,
  price_max: 4500,
  where_sold: 'Pharmacies and online',
  source_url: null,
  ...over,
})

export const ruleRow = (over: RawRow = {}): RawRow => ({
  code: code('ING'),
  name: `${word('zq')} extractum`,
  aliases: null,
  kind: 'irritation',
  strength_limit: null,
  statement: 'Commonly reported to sting skin with a weakened barrier.',
  source_url: null,
  helps: null,
  group: null,
  clashes_with: null,
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  ...over,
})

/** A Claim words row: a phrase no other test uses (lower-case, one word), so phrases never clash across the shared database. */
export const claimWordRow = (over: RawRow = {}): RawRow => ({
  code: code('CLM'),
  phrase: word('zqphrase'),
  claim: 'lightening',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  ...over,
})

/** The schedule every taper here has unless a test says otherwise. */
export const SCHEDULE = '1-2: alternate-days; 3-4: weekly; 5: stop'

/** A Tapers row. The approver is the one every row here has, 'Dr A. Reviewer'. */
export const taperRow = (over: RawRow = {}): RawRow => ({
  code: code('TPR'),
  kind: 'steroid',
  schedule: SCHEDULE,
  what_to_expect: 'Skin may flare or look redder for a few days after each step down. This is expected and passes.',
  see_a_professional_if: 'The redness spreads, the skin weeps or blisters, or you feel unwell.',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  ...over,
})

/** The four routine steps, written out. */
export const STEPS = ['cleanse', 'treat', 'moisturise', 'protect'] as const

/** A Guides row: by default the approved base row (no goal) of the cleanse step. A guide has no code; it is its step and goal. */
export const guideRow = (over: RawRow = {}): RawRow => ({
  step: 'cleanse',
  goal: null,
  what_it_does: 'Lifts sweat, sunscreen and dirt off your skin so the rest of your routine can work.',
  look_for: 'A gentle, fragrance-free wash that leaves your skin comfortable, not tight.',
  for_deeper_skin: 'Skip harsh scrubs and hot water: rubbing hard can leave dark marks behind on deeper skin.',
  look_for_when_pregnant: null,
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  ...over,
})

/** The four approved base rows, one for each step; each says its own step, so a test can tell which it was given. */
export const baseGuideRows = (): RawRow[] => STEPS.map((step) => guideRow({ step, what_it_does: `What ${step} does.`, look_for: `What to look for in ${step}.`, for_deeper_skin: `Deeper skin and ${step}.` }))

/**
 * Adds the base row of each step the workbook has no approved base row for. The contract refuses a workbook without all four, and a catalog that has never
 * had guides exports none, so an upload that is about something else starts with this, as the team fills the rows in before its first import.
 */
export const withBaseGuides = (workbook: RawWorkbook): void => {
  for (const base of baseGuideRows()) {
    if (!workbook.guides.rows.some((row) => row.step === base.step && row.goal === null && row.status === 'approved')) workbook.guides.rows.push(base)
  }
}

export const NIGERIA: RawRow = { code: 'NG', currency: 'NGN', low_max: 5000, mid_max: 15000, status: 'active' }
export const BRITAIN: RawRow = { code: 'GB', currency: 'GBP', low_max: 10, mid_max: 25, status: 'active' }

// --- the replies ---

export type Envelope<T> =
  | { success: true; status: number; message: string; data: T }
  | { success: false; status: number; message: string; error: { code: string; details?: unknown } }
export type Reply = { json(): Promise<unknown>; status: number; headers: Headers }

export const read = async <T>(res: Reply) => (await res.json()) as Envelope<T>
export const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = await read<T>(res)
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
export const errorOf = async (res: Reply) => {
  const body = await read<unknown>(res)
  if (body.success) throw new Error(`expected an error, got ${res.status}`)
  return body.error
}

export type TabDiff = { added: string[]; updated: string[]; retired: string[]; reactivated: string[] }
export type NewProduct = { code: string; brand: string; name: string; variant: string | null; form: string | null }
export type ImportDiff = { products: TabDiff; availability: TabDiff; ingredients: TabDiff; countries: TabDiff; claimWords: TabDiff; tapers: TabDiff; guides: TabDiff; newProducts: NewProduct[] }
export type ImportResult = { applied: boolean; catalogVersion: number; diff: ImportDiff }
export type ExportResult = { catalogVersion: number; contractVersion: string; workbook: RawWorkbook }

export const NO_CHANGE: TabDiff = { added: [], updated: [], retired: [], reactivated: [] }
export const EMPTY_DIFF: ImportDiff = { products: NO_CHANGE, availability: NO_CHANGE, ingredients: NO_CHANGE, countries: NO_CHANGE, claimWords: NO_CHANGE, tapers: NO_CHANGE, guides: NO_CHANGE, newProducts: [] }
/** A TabDiff with only the lists given; the lists are compared sorted, because the order of codes within a list is not part of the contract. */
export const diffOf = (over: Partial<TabDiff>): TabDiff => ({ ...NO_CHANGE, ...over })
/** Codes inside a diff in a fixed order, so a test compares the codes and not the order they came in. */
export const sorted = (diff: ImportDiff): ImportDiff => ({
  products: sortTab(diff.products),
  availability: sortTab(diff.availability),
  ingredients: sortTab(diff.ingredients),
  countries: sortTab(diff.countries),
  claimWords: sortTab(diff.claimWords),
  tapers: sortTab(diff.tapers),
  guides: sortTab(diff.guides),
  newProducts: [...diff.newProducts].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
})
const sortTab = (tab: TabDiff): TabDiff => ({ added: [...tab.added].sort(), updated: [...tab.updated].sort(), retired: [...tab.retired].sort(), reactivated: [...tab.reactivated].sort() })

// --- the calls ---

export const adminHeaders = (over: Record<string, string> = {}): Record<string, string> => ({ 'X-Admin-Token': ADMIN_TOKEN, 'cf-connecting-ip': freshIp(), ...over })

/** The access token of a new guest: a valid USER credential, which must never open the admin door. */
export const guestToken = async (): Promise<string> => {
  const res = await fetchWorker(`${ORIGIN}/api/v1/auth/anonymous`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp() },
    body: JSON.stringify({ deviceId: `device-admin-${runSalt}-${next()}`, platform: 'ios' }),
  })
  return (await dataOf<{ tokens: { accessToken: string } }>(res)).tokens.accessToken
}

export const exportRaw = (headers: Record<string, string> = adminHeaders()) => fetchWorker(EXPORT_URL, { headers })

/** What is live now, as an admin reads it. */
export const exportLive = async (): Promise<ExportResult> => dataOf<ExportResult>(await exportRaw())

/** The bytes of a stand-in .xlsx (a zip's first bytes, then a label): the server archives the file and never opens it, so these tell one upload from another. */
export const xlsxBytes = (label: string) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(label)])

export type ImportInput = {
  workbook: RawWorkbook | string
  baseVersion: number | string
  /** Left out of the request when undefined, so the default can be tested. */
  dryRun?: boolean | string
  file?: Uint8Array | null
  /** Left out when null. Sent as the contract version this checkout serves unless a test says another. */
  uploadedBy?: string | null
  contractVersion?: string | null
  headers?: Record<string, string>
  /** The bindings the Worker is handed, for a test that changes the environment (ENVIRONMENT, QUALIFIED_APPROVERS). */
  workerEnv?: typeof env
}

export const importRaw = ({ workbook, baseVersion, dryRun, file = null, uploadedBy = 'Test Editor', contractVersion = CONTRACT_VERSION, headers = adminHeaders(), workerEnv }: ImportInput) => {
  const form = new FormData()
  form.set('workbook', typeof workbook === 'string' ? workbook : JSON.stringify(workbook))
  form.set('baseVersion', String(baseVersion))
  if (dryRun !== undefined) form.set('dryRun', String(dryRun))
  if (file) form.set('file', new Blob([file], { type: XLSX_MEDIA_TYPE }), 'catalog.xlsx')
  if (uploadedBy !== null) form.set('uploadedBy', uploadedBy)
  if (contractVersion !== null) form.set('contractVersion', contractVersion)
  return fetchWorker(IMPORT_URL, { method: 'POST', body: form, headers }, workerEnv)
}

/** The workbook with the tabs' rows changed by `edit`; the live export is never touched. */
export const edited = (live: RawWorkbook, edit: (workbook: RawWorkbook) => void): RawWorkbook => {
  const copy = structuredClone(live)
  edit(copy)
  return copy
}

export const rowsOf = (tab: RawTab) => tab.rows
export const rowWith = (tab: RawTab, key: string, value: unknown): RawRow | undefined => tab.rows.find((row) => row[key] === value)
/** Adds a country row to the workbook unless it already holds that code. */
export const withCountry = (workbook: RawWorkbook, country: RawRow) => {
  if (!rowWith(workbook.countries, 'code', country.code)) workbook.countries.rows.push({ ...country })
}
/** Takes every row of a tab whose `key` is `value` out of the workbook. */
export const without = (tab: RawTab, key: string, value: unknown) => {
  tab.rows = tab.rows.filter((row) => row[key] !== value)
}

/**
 * Export, edit, import: the way the catalog is changed in life. Returns what was live before, and the reply. The base guide rows the contract needs are
 * added for a step that has none (`withBaseGuides`), unless the test says `baseGuides: false` because it is about them.
 */
export const upload = async (
  edit: (workbook: RawWorkbook) => void,
  over: Partial<Omit<ImportInput, 'workbook' | 'baseVersion'>> & { baseVersion?: (live: number) => number; baseGuides?: boolean } = {},
) => {
  const before = await exportLive()
  const { baseVersion, baseGuides, ...rest } = over
  const res = await importRaw({ workbook: edited(before.workbook, (workbook) => { edit(workbook); if (baseGuides !== false) withBaseGuides(workbook) }), baseVersion: baseVersion ? baseVersion(before.catalogVersion) : before.catalogVersion, ...rest })
  return { before, res }
}

/** An upload that is applied, with a file; throws unless it was. */
export const applied = async (edit: (workbook: RawWorkbook) => void, over: { uploadedBy?: string; label?: string } = {}) => {
  const file = xlsxBytes(over.label ?? `apply-${next()}`)
  const { before, res } = await upload(edit, { dryRun: false, file, ...(over.uploadedBy ? { uploadedBy: over.uploadedBy } : {}) })
  const data = await dataOf<ImportResult>(res)
  if (!data.applied) throw new Error('expected the upload to be applied')
  return { before, data, file }
}

// --- looking at what was stored, where the API has no read for it ---

const db = createDb(env.DB)

/** The version of the approved rules in force: the rules version, which an export does not carry. */
export const liveRules = () => new D1CatalogWorkbookRepository(db).liveRules()
export const rulesVersion = async () => (await liveRules()).version
/** The names the matcher is applying now: approved rules only. */
export const liveRuleNames = async () => (await liveRules()).entries.map((entry) => entry.name)
/**
 * An archive key is unique to the attempt, `workbooks/<env>/<version>-<uuid>.xlsx`, so two applies racing for one version never write the same
 * object. The key that counts is the one recorded on the version's row.
 */
export const archiveKeyPattern = (version: number) => new RegExp(`^workbooks/${env.ENVIRONMENT}/${version}-[0-9a-f-]{36}\\.xlsx$`)
/** The file archived for a catalog version, found through the key its row records; null when there is no such version or its row names no object. */
export const archived = async (version: number) => {
  const row = (await db.select().from(catalogVersions).where(eq(catalogVersions.version, version)))[0]
  if (!row?.archiveKey) return null
  const object = await env.PRIVATE_PHOTOS.get(row.archiveKey)
  return object === null ? null : { key: row.archiveKey, contentType: object.httpMetadata?.contentType, bytes: new Uint8Array(await object.arrayBuffer()) }
}
export const latestVersionRow = async () => (await db.select().from(catalogVersions).orderBy(desc(catalogVersions.version)).limit(1))[0]
export const countRows = async (table: string): Promise<number> => (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n
/** How many catalog products carry this brand: a product the import created, found without the API (which hides a product with no list). */
export const productsOfBrand = async (brand: string): Promise<number> =>
  (await env.DB.prepare('SELECT count(*) AS n FROM products WHERE brand = ?').bind(brand).first<{ n: number }>())!.n

/** Everything the catalog tables hold, counted: what a refused or dry upload must leave exactly as it found it. */
export const counts = async () => ({
  products: await countRows('products'),
  formulations: await countRows('formulations'),
  versions: await countRows('catalog_versions'),
  rules: await countRows('ingredient_rules'),
  recommended: await countRows('recommended_products'),
  availability: await countRows('product_availability'),
  countries: await countRows('countries'),
  archives: (await env.PRIVATE_PHOTOS.list({ prefix: `workbooks/${env.ENVIRONMENT}/` })).objects.length,
})
