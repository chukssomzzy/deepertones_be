import { describe, expect, it } from 'vitest'
import { MemoryWorkbookArchive } from './memory.workbook-archive'
import { workbookArchiveContract } from './workbook-archive.contract'
import { XLSX_MEDIA_TYPE } from './workbook-archive.provider'

workbookArchiveContract('memory', (environment) => new MemoryWorkbookArchive({ environment }))

describe('MemoryWorkbookArchive', () => {
  it('keeps a copy of the bytes under the key it returns, as an .xlsx', async () => {
    const archive = new MemoryWorkbookArchive({ environment: 'test' })
    const file = new Uint8Array([1, 2, 3])

    const key = await archive.put(3, file)
    file[0] = 9

    expect(archive.stored.get(key)).toEqual({ bytes: new Uint8Array([1, 2, 3]), mediaType: XLSX_MEDIA_TYPE })
  })
})
