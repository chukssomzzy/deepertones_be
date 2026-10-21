import { describe, expect, it, vi } from 'vitest'
import { R2WorkbookArchive } from './r2.workbook-archive'
import { workbookArchiveContract } from './workbook-archive.contract'
import { XLSX_MEDIA_TYPE } from './workbook-archive.provider'

const fakeBucket = () => {
  const put = vi.fn(async (_key: string, _value: unknown, _options?: R2PutOptions) => ({}) as R2Object)
  return { bucket: { put } as unknown as R2Bucket, put }
}

workbookArchiveContract('R2', (environment) => new R2WorkbookArchive({ bucket: fakeBucket().bucket, environment }))

describe('R2WorkbookArchive', () => {
  it('puts the bytes under the returned key with the xlsx media type, never cached', async () => {
    const { bucket, put } = fakeBucket()
    const file = new Uint8Array([1, 2, 3])

    const key = await new R2WorkbookArchive({ bucket, environment: 'production' }).put(4, file)

    expect(put).toHaveBeenCalledWith(key, file, { httpMetadata: { contentType: XLSX_MEDIA_TYPE, cacheControl: 'private, no-store' } })
    expect(key.startsWith('workbooks/production/4-')).toBe(true)
  })

  it('does not swallow a storage failure, so the upload can be refused', async () => {
    const bucket = { put: vi.fn(async () => Promise.reject(new Error('r2 down'))) } as unknown as R2Bucket

    await expect(new R2WorkbookArchive({ bucket, environment: 'test' }).put(2, new Uint8Array([1]))).rejects.toThrow('r2 down')
  })
})
