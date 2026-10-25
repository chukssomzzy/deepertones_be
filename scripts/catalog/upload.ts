/**
 * `npm run catalog:upload -- file.xlsx --env staging --by "Name" [--apply]`: read an edited workbook, check it against the contract here, then send
 * it to the admin API as a dry run, or applied with `--apply`. Everything that can be known without the server is checked first, so a wrong file
 * never costs a request. Every effect is handed in; the shell is scripts/catalog-upload.ts. Returns the process exit code.
 */
import { basename } from 'node:path'
import { HttpTransportError } from '../../src/lib/http'
import { CONTRACT_VERSION, validateWorkbook, type TabKey, type WorkbookProblem } from '../../src/modules/catalog/catalog.workbook.schema'
import { adminUrl, createTerminal, describeFailure, isRecord, readAdminToken, readAnswer, type AdminRequest, type Environment } from './admin-api'
import { contractMismatch, TAB_NAMES, type WorkbookFile } from './xlsx'

const IMPORT_PATH = '/api/v1/admin/catalog/import'
const UNSURE = 'The upload may or may not have been applied. Run npm run catalog:export and check the catalog version before retrying.'
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
// An apply also archives the file and writes one batch, so it gets longer than the export's 30 s.
const TIMEOUT_MS = 60_000
const KINDS = ['added', 'updated', 'retired', 'reactivated'] as const

type Deps = {
  readText: (path: string) => Promise<string>
  readBytes: (path: string) => Promise<Uint8Array>
  readWorkbook: (bytes: Uint8Array, name?: string) => Promise<WorkbookFile>
  request: AdminRequest
  log: (line: string) => void
  error: (line: string) => void
}

type NewProduct = { code: string; brand: string; name: string; variant: string | null; form: string | null }
type Diff = Record<TabKey, Record<(typeof KINDS)[number], string[]>> & { newProducts: NewProduct[] }

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

const isDiff = (value: unknown): value is Diff =>
  isRecord(value) &&
  Object.keys(TAB_NAMES).every((tab) => {
    const changes = value[tab]
    return isRecord(changes) && KINDS.every((kind) => isStrings(changes[kind]))
  }) &&
  Array.isArray(value.newProducts) &&
  value.newProducts.every((product) => isRecord(product) && typeof product.code === 'string')

const isProblem = (value: unknown): value is WorkbookProblem =>
  isRecord(value) && typeof value.tab === 'string' && typeof value.row === 'number' && typeof value.column === 'string' && typeof value.rule === 'string'

/** Where a problem is and what rule it broke: never the cell's own text, which the contract does not give. */
const problemLine = ({ tab, row, column, rule }: WorkbookProblem): string =>
  `  ${TAB_NAMES[tab] ?? tab} row ${row}${row === 1 ? ' (the header)' : ''}, column ${column}: ${rule}`

function diffLines(diff: Diff): string[] {
  const lines: string[] = []
  for (const tab of Object.keys(TAB_NAMES) as TabKey[]) {
    for (const kind of KINDS) {
      const codes = diff[tab][kind]
      if (codes.length > 0) lines.push(`  ${TAB_NAMES[tab]} ${kind} (${codes.length}): ${codes.join(', ')}`)
    }
  }
  if (diff.newProducts.length > 0) {
    lines.push(`  New products (${diff.newProducts.length}), matched to nothing in the catalog, so check each spelling:`)
    for (const { code, brand, name, variant, form } of diff.newProducts) {
      lines.push(`    ${code}  ${[brand, name, variant, form].filter((part) => part !== null && part !== undefined).join(' / ')}`)
    }
  }
  return lines
}

/** Why a file cannot be uploaded to `env` from what `_meta` remembers, or null when it can. Every reason ends at a fresh export. */
function staleStamp(file: string, env: Environment, read: WorkbookFile): string | null {
  const again = 'Nothing was sent. Run npm run catalog:export again and make the edits on the new file.'
  if (read.catalogVersion === null) return `${file} has no catalog version, so there is no telling which export it was edited from. ${again}`
  if (read.environment === null) return `${file} has no environment stamp, so there is no telling which environment it came from. ${again}`
  if (read.environment !== env) {
    return `${file} was exported from ${read.environment}, but you asked to upload to ${env}. Nothing was sent. Run npm run catalog:export -- --env ${env} and make the edits on that file.`
  }
  if (read.contractVersion !== CONTRACT_VERSION) {
    return `${contractMismatch(file, read.contractVersion)} ${again}`
  }
  return null
}

export async function runUpload(args: { file: string; env: Environment; by: string; apply: boolean }, deps: Deps): Promise<number> {
  const terminal = createTerminal(deps)
  // Once the request is out, an apply that gets no usable answer may still have happened.
  let sent = false
  const unsure = () => {
    if (sent && args.apply) terminal.error(UNSURE)
  }
  try {
    // Read once: the bytes that are checked are the bytes that are sent.
    const bytes = await deps.readBytes(args.file)
    const read = await deps.readWorkbook(bytes, args.file)
    const { workbook, catalogVersion } = read

    const stale = staleStamp(args.file, args.env, read)
    if (stale !== null) {
      terminal.error(stale)
      return 1
    }
    const result = validateWorkbook(workbook)
    if (!result.ok) {
      terminal.error(`${args.file} does not meet the contract (${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}). Nothing was sent.`)
      for (const problem of result.problems) terminal.error(problemLine(problem))
      terminal.error('Each problem is explained in docs/catalog-workbook-contract.md.')
      return 1
    }

    const token = await readAdminToken(args.env, deps.readText)
    terminal.hide(token)

    const form = new FormData()
    form.append('workbook', JSON.stringify(workbook))
    form.append('baseVersion', String(catalogVersion))
    form.append('dryRun', String(!args.apply))
    form.append('uploadedBy', args.by)
    // The stamp is the file's own, which staleStamp has just held equal to this checkout's: the server refuses a file made for another contract.
    form.append('contractVersion', read.contractVersion!)
    // The file goes along only when applying: the server archives it under the new catalog version.
    if (args.apply) form.append('file', new Blob([bytes], { type: XLSX_MEDIA_TYPE }), basename(args.file))

    terminal.log(`${args.env}: ${args.apply ? 'applying' : 'dry run of'} ${args.file}, edited from catalog version ${catalogVersion}.`)
    sent = true
    const answer = readAnswer(await deps.request(adminUrl(args.env, IMPORT_PATH), { method: 'POST', headers: { 'X-Admin-Token': token }, body: form, timeoutMs: TIMEOUT_MS }))

    if (answer.kind === 'refused' && answer.code === 'CATALOG_STALE') {
      terminal.error(`Refused: ${describeFailure(answer)}`)
      terminal.error('The catalog has changed since this file was exported. Run npm run catalog:export again and make the edits on the new file.')
      return 1
    }
    if (answer.kind === 'refused' && answer.code === 'CONTRACT_MISMATCH') {
      terminal.error(`Refused: ${describeFailure(answer)}`)
      terminal.error('The server\'s workbook contract is not the one this file was made for. Run npm run catalog:export again and make the edits on the new file.')
      return 1
    }
    if (answer.kind === 'refused' && answer.code === 'CATALOG_INVALID') {
      terminal.error(`Refused: ${describeFailure(answer)}`)
      const problems = isRecord(answer.details) && Array.isArray(answer.details.problems) ? answer.details.problems.filter(isProblem) : []
      for (const problem of problems) terminal.error(problemLine(problem))
      return 1
    }
    if (answer.kind !== 'data') {
      terminal.error(`Upload failed: ${describeFailure(answer)}`)
      // A 4xx was refused before anything was written; a 5xx or an answer that is not the API's was not.
      if (answer.kind === 'unexpected' || answer.status >= 500) unsure()
      return 1
    }

    const { applied, catalogVersion: liveVersion, diff } = answer.data
    if (typeof applied !== 'boolean' || typeof liveVersion !== 'number' || !isDiff(diff)) {
      terminal.error('Upload failed: the server answered without an applied flag, a catalog version and a diff, so nothing can be reported as done.')
      unsure()
      return 1
    }
    if (applied !== args.apply) {
      terminal.error(`Upload failed: ${args.apply ? 'asked to apply, but the server says it did not' : 'asked for a dry run, but the server says it applied'}. Check the catalog before trying again.`)
      return 1
    }

    const lines = diffLines(diff)
    terminal.log(lines.length === 0 ? 'No changes: the workbook matches the live catalog.' : 'Changes:')
    for (const line of lines) terminal.log(line)
    if (applied) {
      terminal.log(`Applied. The ${args.env} catalog is now at version ${liveVersion}.`)
    } else {
      terminal.log('Dry run: nothing was changed.')
      if (lines.length > 0) terminal.log(`To apply these changes, run again with --apply: npm run catalog:upload -- ${args.file} --env ${args.env} --by ${JSON.stringify(args.by)} --apply`)
    }
    return 0
  } catch (error) {
    terminal.error(`Upload failed: ${(error as Error).message}`)
    if (error instanceof HttpTransportError) unsure()
    return 1
  }
}
