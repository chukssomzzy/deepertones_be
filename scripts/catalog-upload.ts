// `npm run catalog:upload -- file.xlsx --env staging --by "Name" [--apply]`. The logic is runUpload in scripts/catalog/upload.ts; this only wires the
// real effects.
import { readFile } from 'node:fs/promises'
import { parseUploadArgs } from './catalog/args'
import { httpRequest } from './catalog/admin-api'
import { runUpload } from './catalog/upload'
import { readFileBytes, readWorkbookBytes } from './catalog/xlsx'

async function main(): Promise<number> {
  let args: ReturnType<typeof parseUploadArgs>
  try {
    args = parseUploadArgs(process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    return 1
  }
  return runUpload(args, {
    readText: (path) => readFile(path, 'utf8'),
    readBytes: readFileBytes,
    readWorkbook: readWorkbookBytes,
    request: httpRequest,
    log: console.log,
    error: console.error,
  })
}

process.exitCode = await main()
