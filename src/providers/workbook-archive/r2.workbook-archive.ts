import { assertWorkbookSize, workbookKey, XLSX_MEDIA_TYPE, type WorkbookArchive, type WorkbookEnvironment } from './workbook-archive.provider'

export type R2WorkbookArchiveConfig = {
  /** The private bucket, deepertones-private. */
  bucket: R2Bucket
  /** The only environment whose keys (workbooks/<environment>/...) this archive will write. */
  environment: WorkbookEnvironment
}

/**
 * Keeps each applied catalog upload's .xlsx in the private bucket. The bucket is shared by every environment and told apart by key prefix, so
 * the key is built from this archive's own environment and no caller can name a key of another's.
 */
export class R2WorkbookArchive implements WorkbookArchive {
  // Never shared or cached, like every object in this bucket.
  private static readonly CACHE_CONTROL = 'private, no-store'

  private readonly bucket: R2Bucket
  private readonly environment: WorkbookEnvironment

  constructor({ bucket, environment }: R2WorkbookArchiveConfig) {
    this.bucket = bucket
    this.environment = environment
  }

  async put(version: number, file: Uint8Array): Promise<string> {
    assertWorkbookSize(file)
    const key = workbookKey(this.environment, version)
    await this.bucket.put(key, file, { httpMetadata: { contentType: XLSX_MEDIA_TYPE, cacheControl: R2WorkbookArchive.CACHE_CONTROL } })
    return key
  }
}
