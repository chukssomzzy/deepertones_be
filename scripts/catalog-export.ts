// `npm run catalog:export -- --env staging [--out file.xlsx] [--force]`. The logic is runExport in scripts/catalog/export.ts; this only wires the real effects.
import { access, readFile } from 'node:fs/promises'
import { parseExportArgs } from './catalog/args'
import { httpRequest } from './catalog/admin-api'
import { runExport } from './catalog/export'
import { writeWorkbookFile } from './catalog/xlsx'

async function main(): Promise<number> {
  let args: ReturnType<typeof parseExportArgs>
  try {
    args = parseExportArgs(process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    return 1
  }
  return runExport(args, {
    readText: (path) => readFile(path, 'utf8'),
    request: httpRequest,
    exists: (path) => access(path).then(() => true, () => false),
    writeWorkbook: writeWorkbookFile,
    log: console.log,
    error: console.error,
  })
}

process.exitCode = await main()
