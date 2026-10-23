/**
 * `npm run catalog:export -- --env staging [--out file.xlsx] [--force]`: fetch the live catalog from the admin API and write it to a workbook stamped
 * with the catalog version, environment and contract version it was exported at. An existing file is never replaced without `--force`: it may hold
 * someone's edits. Every effect is handed in; the shell is scripts/catalog-export.ts. Returns the process exit code.
 */
import type { RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import { adminUrl, createTerminal, describeFailure, isRecord, readAdminToken, readAnswer, type AdminRequest, type Environment } from './admin-api'
import { TAB_NAMES, type Stamp } from './xlsx'

const EXPORT_PATH = '/api/v1/admin/catalog/export'
const TIMEOUT_MS = 30_000

type Deps = {
  readText: (path: string) => Promise<string>
  request: AdminRequest
  exists: (path: string) => Promise<boolean>
  writeWorkbook: (path: string, workbook: RawWorkbook, catalogVersion: number, stamp: Stamp) => Promise<void>
  log: (line: string) => void
  error: (line: string) => void
}

/** A workbook the file can be written from: every tab has its headers and its rows. Whether the cells are valid is the contract's business. */
const isRawWorkbook = (value: unknown): value is RawWorkbook =>
  isRecord(value) &&
  Object.keys(TAB_NAMES).every((key) => {
    const tab = value[key]
    return isRecord(tab) && Array.isArray(tab.headers) && tab.headers.every((header) => typeof header === 'string') && Array.isArray(tab.rows) && tab.rows.every(isRecord)
  })

export async function runExport(args: { env: Environment; out: string | undefined; force?: boolean }, deps: Deps): Promise<number> {
  const terminal = createTerminal(deps)
  try {
    const token = await readAdminToken(args.env, deps.readText)
    terminal.hide(token)

    const answer = readAnswer(await deps.request(adminUrl(args.env, EXPORT_PATH), { method: 'GET', headers: { 'X-Admin-Token': token }, timeoutMs: TIMEOUT_MS }))
    if (answer.kind !== 'data') {
      terminal.error(`Export failed: ${describeFailure(answer)}`)
      return 1
    }
    const { catalogVersion, contractVersion, workbook } = answer.data
    if (typeof catalogVersion !== 'number' || !Number.isInteger(catalogVersion) || typeof contractVersion !== 'string' || !isRawWorkbook(workbook)) {
      terminal.error('Export failed: the server answered without a whole catalog version, a contract version and a workbook with headers on every tab, so no file was written.')
      return 1
    }

    const path = args.out ?? `catalog-${args.env}-v${catalogVersion}.xlsx`
    if (args.force !== true && (await deps.exists(path))) {
      terminal.error(`Export failed: ${path} already exists, and nothing was written. Use --force to replace it, or --out to choose another name.`)
      return 1
    }
    // The server's contract version, not this checkout's: the file is checked against it on upload, so an out-of-date checkout is caught there.
    await deps.writeWorkbook(path, workbook, catalogVersion, { environment: args.env, contractVersion })
    terminal.log(`Wrote ${path}: the ${args.env} catalog at version ${catalogVersion}.`)
    terminal.log(`Edit it, then check it with: npm run catalog:upload -- ${path} --env ${args.env} --by "Your name"`)
    return 0
  } catch (error) {
    terminal.error(`Export failed: ${(error as Error).message}`)
    return 1
  }
}
