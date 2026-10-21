import { describe, expect, it } from 'vitest'
import { MAX_WORKBOOK_BYTES, type WorkbookArchive, type WorkbookEnvironment } from './workbook-archive.provider'

const FILE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])

/** What every WorkbookArchive must do. `make(environment)` returns an empty archive locked to that environment. */
export const workbookArchiveContract = (name: string, make: (environment: WorkbookEnvironment) => WorkbookArchive) => {
  describe(`WorkbookArchive contract: ${name}`, () => {
    it('keys the file workbooks/<environment>/<version>-<uuid>.xlsx', async () => {
      const key = await make('staging').put(7, FILE)

      expect(key).toMatch(/^workbooks\/staging\/7-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.xlsx$/)
    })

    it('gives every attempt a key of its own, even for the same version', async () => {
      const archive = make('test')

      expect(await archive.put(2, FILE)).not.toBe(await archive.put(2, FILE))
    })

    it('refuses an empty file and one over 10 MB, and a version that is not a positive whole number', async () => {
      const archive = make('test')

      await expect(archive.put(2, new Uint8Array(0))).rejects.toThrow()
      await expect(archive.put(2, new Uint8Array(MAX_WORKBOOK_BYTES + 1))).rejects.toThrow()
      await expect(archive.put(0, FILE)).rejects.toThrow()
      await expect(archive.put(1.5, FILE)).rejects.toThrow()
    })

    it('takes a file of exactly 10 MB', async () => {
      await expect(make('test').put(2, new Uint8Array(MAX_WORKBOOK_BYTES))).resolves.toEqual(expect.any(String))
    })
  })
}
