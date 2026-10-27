import { ADMIN_TOKEN, fetchWorker as fetchAdmin, withBaseGuides } from './admin.catalog.support'

// Shared by the integration tests that need a recommendation catalog in D1: they put it there the way the team does, through the admin import
// endpoint (PR 3), as an export of what is live with their own rows added. Nothing writes a table directly. The endpoint, its header and the
// export and import shapes are the ones fixed in the plan's "Interfaces between PRs", so these helpers stay in step with PR 3 by that text.

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** The day the rows were approved: today, on the real clock the Worker also runs on. */
export const APPROVED_ON = new Date().toISOString().slice(0, 10)

type Cell = string | number | boolean | null
export type RawRow = Record<string, Cell>
export type RawTab = { headers: string[]; rows: RawRow[] }
export type RawWorkbook = { products: RawTab; availability: RawTab; ingredients: RawTab; countries: RawTab; claimWords: RawTab; tapers: RawTab; guides: RawTab }
export type Exported = { catalogVersion: number; contractVersion: string; workbook: RawWorkbook }
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>

/** An approved Products row that passes every candidate rule for a user with the glow goal, no skin type and nothing to avoid; a test changes what it is about. Lists are `;`-joined, as in the sheet. */
export const productRow = (over: RawRow): RawRow => ({
  variant: null,
  form: null,
  category: 'skin',
  ingredients: 'Aqua; Glycerin; Cetearyl Alcohol',
  ingredients_source_url: 'https://shop.example/product',
  key_ingredient: null,
  strength: null,
  skin_concerns: 'hd_moisture',
  skin_types: 'all',
  steps: 'moisturise',
  frequency: 'am-pm',
  own_cautions: null,
  evidence_urls: null,
  origin: 'sourced',
  status: 'approved',
  approved_by: 'Test Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  draft_cells: null,
  ...over,
})

export const availabilityRow = (productCode: string, country: string, priceMin: number, priceMax: number = priceMin + 500): RawRow => ({
  product_code: productCode,
  country,
  price_min: priceMin,
  price_max: priceMax,
  where_sold: 'Pharmacies and online',
  // Optional (PR 2's contract adds it after where_sold). The headers come from the export, so the tab's columns are never listed here.
  source_url: null,
})

export const countryRow = (code: string, over: RawRow = {}): RawRow => ({ code, currency: 'NGN', low_max: 5000, mid_max: 15000, status: 'active', ...over })

// The admin endpoints are called through the Worker that admin.catalog.support hands the test token as a binding, whatever Worker environment the
// calling test built for itself (theirs carries no admin token). The `fetchWorker` the helpers below are given is kept in their signatures, unused.
const adminToken = (): string => ADMIN_TOKEN

let calls = 0
// The admin endpoints are limited per address, so every call comes from its own.
const freshIp = () => `10.99.${Math.floor(calls / 250) % 250}.${(calls++ % 250) + 1}`

const dataOf = async (res: Response, what: string) => {
  const text = await res.text()
  if (res.status !== 200) throw new Error(`${what}: expected 200, got ${res.status} ${text.slice(0, 600)}`)
  const body = JSON.parse(text) as { data?: unknown }
  return (body.data ?? body) as never
}

/** What is live, in the sheet's shape. */
export const exportCatalog = async (_fetchWorker: Fetch): Promise<Exported> =>
  dataOf(await fetchAdmin('http://deepertones.test/api/v1/admin/catalog/export', { headers: { 'X-Admin-Token': adminToken(), 'cf-connecting-ip': freshIp() } }), 'export')

/**
 * Applies a change to what is live, the way the team does: export, edit the rows, upload with the version the edit started from. `change`
 * adds, edits or retires rows in the exported workbook (a row missing from an upload is retired). Resolves to the new catalog version.
 */
export const applyCatalogChange = async (fetchWorker: Fetch, change: (workbook: RawWorkbook) => void): Promise<number> => {
  const live = await exportCatalog(fetchWorker)
  const workbook = structuredClone(live.workbook)
  change(workbook)
  withBaseGuides(workbook)
  const form = new FormData()
  form.set('workbook', JSON.stringify(workbook))
  form.set('file', new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'catalog.xlsx', { type: XLSX_TYPE }))
  form.set('baseVersion', String(live.catalogVersion))
  form.set('dryRun', 'false')
  form.set('uploadedBy', 'integration test')
  // The contract version the export said: the file is, in life, exactly what the export gave, edited.
  form.set('contractVersion', live.contractVersion)
  const res = await fetchAdmin('http://deepertones.test/api/v1/admin/catalog/import', {
    method: 'POST',
    headers: { 'X-Admin-Token': adminToken(), 'cf-connecting-ip': freshIp() },
    body: form,
  })
  const applied = (await dataOf(res, 'import')) as { applied: boolean; catalogVersion: number }
  if (!applied.applied) throw new Error('the import was a dry run, or was not applied')
  return applied.catalogVersion
}

/** Sets a country's row in the Countries tab: adds it, or replaces the row with the same code. */
export const putCountry = (workbook: RawWorkbook, row: RawRow): void => {
  workbook.countries.rows = [...workbook.countries.rows.filter((existing) => existing.code !== row.code), row]
}
