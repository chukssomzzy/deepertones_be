import { assertWorkbookSize, workbookKey, XLSX_MEDIA_TYPE, type WorkbookArchive, type WorkbookEnvironment } from './workbook-archive.provider'

/** Keeps archived workbooks in a map and makes keys and checks sizes exactly as R2WorkbookArchive does (same functions). For tests. */
export class MemoryWorkbookArchive implements WorkbookArchive {
  readonly stored = new Map<string, { bytes: Uint8Array; mediaType: string }>()

  private readonly environment: WorkbookEnvironment

  constructor({ environment }: { environment: WorkbookEnvironment }) {
    this.environment = environment
  }

  async put(version: number, file: Uint8Array): Promise<string> {
    assertWorkbookSize(file)
    const key = workbookKey(this.environment, version)
    this.stored.set(key, { bytes: file.slice(), mediaType: XLSX_MEDIA_TYPE })
    return key
  }
}
