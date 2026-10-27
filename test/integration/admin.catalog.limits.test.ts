import { beforeAll, describe, expect, it } from 'vitest'
import { adminHeaders, applied, counts, dataOf, errorOf, exportLive, freshIp, importRaw, latestVersionRow, xlsxBytes, type ImportResult } from './admin.catalog.support'

// What the import refuses about the request before it reads the workbook: the size of the body, of the file, what the file is, and the label of the
// uploader. The token comes first (it is checked before the body is read), so a caller without it learns nothing about any of these.

// These send the export as it is, and a fresh catalog has no guides, which the contract refuses: the team writes the four base ones before the first import, so
// they are put in once up front and what each test sends is valid but for the request it is about.
beforeAll(async () => {
  await applied(() => {})
})

const MB = 1024 * 1024
/** A file of `size` bytes that starts like a zip, so only its size is in question. */
const zip = (size: number) => {
  const file = new Uint8Array(size)
  file.set([0x50, 0x4b, 0x03, 0x04])
  return file
}

describe('the size of the request', () => {
  it('refuses a body over 16 MB with 413 before the form is read, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()

    const res = await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: false, file: zip(16 * MB + 1) })

    expect(res.status).toBe(413)
    expect(await counts()).toEqual(before)
  })

  it('answers 401, not 413, to a caller without the token who sends a body over 16 MB: the token is checked first', async () => {
    const live = await exportLive()

    const res = await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: false, file: zip(16 * MB + 1), headers: { 'cf-connecting-ip': freshIp() } })

    expect(res.status).toBe(401)
    expect((await errorOf(res)).code).toBe('ADMIN_TOKEN_INVALID')
  })

  it('refuses a file over 10 MB that fits the body with 400 CATALOG_FILE_TOO_LARGE, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()

    const res = await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: false, file: zip(10 * MB + 1) })

    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('CATALOG_FILE_TOO_LARGE')
    expect(await counts()).toEqual(before)
  })

  it('takes a file of exactly 10 MB', async () => {
    const live = await exportLive()

    const res = await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: false, file: zip(10 * MB) })

    expect(res.status).toBe(200)
    expect((await dataOf<ImportResult>(res)).applied).toBe(true)
  })
})

describe('the file', () => {
  it.each([
    ['text', new TextEncoder().encode('this is not a spreadsheet')],
    ['a PDF', new TextEncoder().encode('%PDF-1.7 ...')],
    ['a zip cut short', new Uint8Array([0x50, 0x4b, 0x03])],
  ])('refuses %s with 400 CATALOG_FILE_NOT_XLSX, and writes nothing', async (_, file) => {
    const live = await exportLive()
    const before = await counts()

    const res = await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: false, file })

    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('CATALOG_FILE_NOT_XLSX')
    expect(await counts()).toEqual(before)
  })

  it('does not look at a file on a dry run, which archives nothing', async () => {
    const live = await exportLive()

    const res = await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: true, file: new TextEncoder().encode('not a zip') })

    expect(res.status).toBe(200)
  })
})

describe('uploadedBy', () => {
  it('is trimmed before it is measured and recorded', async () => {
    const live = await exportLive()

    const res = await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: false, file: xlsxBytes('trim'), uploadedBy: `  ${'a'.repeat(80)}  ` })

    expect(res.status).toBe(200)
    expect((await latestVersionRow())?.uploadedBy).toBe('a'.repeat(80))
  })

  it.each([
    ['only spaces', '   '],
    ['81 characters once trimmed', ` ${'a'.repeat(81)} `],
  ])('refuses an uploadedBy of %s with a 400', async (_, uploadedBy) => {
    const live = await exportLive()

    const res = await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: true, uploadedBy })

    expect(res.status).toBe(400)
  })
})
