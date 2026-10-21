import type { PhotoEnvironment } from '../photo-store/photo-store.provider'

/**
 * Where the .xlsx an admin uploaded is kept, once for every applied catalog upload, so the catalog can be traced back to the file it came from.
 * It lives in the private bucket (PRIVATE_PHOTOS) beside the photos, under `workbooks/`, and nothing here gives out an address.
 * `put` throws on storage failure so the caller can refuse the upload.
 */
export interface WorkbookArchive {
  /**
   * Stores the file under a key made for this attempt, `workbooks/<environment>/<version>-<uuid>.xlsx`, and returns the key. The key is
   * never reused, so two uploads racing for one version never write the same object; the loser's file is an orphan, not an overwrite.
   * Throws a plain Error for a file that is empty or over MAX_WORKBOOK_BYTES: the caller has refused those already.
   */
  put(version: number, file: Uint8Array): Promise<string>
}

export type WorkbookEnvironment = PhotoEnvironment

export const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024

export const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** The key for this attempt. Both adapters call this, so the fake cannot make a key the real store would not. */
export const workbookKey = (environment: WorkbookEnvironment, version: number): string => {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Invalid catalog version for an archive key: ${version}`)
  return `workbooks/${environment}/${version}-${crypto.randomUUID()}.xlsx`
}

/** Throws a plain Error unless the file is 1 byte to MAX_WORKBOOK_BYTES. */
export const assertWorkbookSize = (file: Uint8Array): void => {
  if (file.byteLength === 0 || file.byteLength > MAX_WORKBOOK_BYTES) throw new Error(`A workbook file is 1 to ${MAX_WORKBOOK_BYTES} bytes, got ${file.byteLength}`)
}
