import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTRACT_VERSION, type RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import { readFileBytes, readWorkbookBytes, readWorkbookFile, WorkbookFileError, writeWorkbookFile } from './xlsx'
import { readFile } from 'node:fs/promises'
import { availability, country, day, dayAsDate, HEADERS, ingredient, product, TAB_NAMES, validWorkbook } from './workbook.fixture'

// The shared xlsx module behind `catalog:export` (which writes a workbook file) and `catalog:upload` (which reads one back). The file layout is
// the contract with the people who edit it: four tabs named exactly Products, Availability, Ingredients and Countries, the header row first, and a
// hidden `_meta` sheet that remembers which catalog version the file was exported at. `_meta` holds one `key | value` pair per row:
//   catalogVersion | <number>
//   contractVersion | <text>
// Fixtures that stand for "what Excel did to the file" are built with exceljs directly, never with writeWorkbookFile, so reading is not tested
// against its own writer.

let dir: string
let n = 0
const newPath = () => join(dir, `workbook-${++n}.xlsx`)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'catalog-xlsx-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

type Cells = unknown[][]
type FileSpec = { tabs?: Partial<Record<keyof typeof TAB_NAMES, Cells>>; names?: Partial<Record<keyof typeof TAB_NAMES, string>>; meta?: Cells | null }

/** A workbook file made the way a person with Excel would: every tab with its header row, then whatever rows the test gives. */
const buildFile = async (spec: FileSpec = {}): Promise<string> => {
  const path = newPath()
  const book = new ExcelJS.Workbook()
  for (const key of Object.keys(TAB_NAMES) as (keyof typeof TAB_NAMES)[]) {
    const rows = spec.tabs?.[key] ?? [[...HEADERS[key]]]
    const name = spec.names?.[key] ?? TAB_NAMES[key]
    const sheet = book.addWorksheet(name)
    rows.forEach((cells, index) => {
      const row = sheet.getRow(index + 1)
      cells.forEach((value, column) => {
        if (value === undefined) return
        const cell = row.getCell(column + 1)
        cell.value = value as ExcelJS.CellValue
        if (value instanceof Date) cell.numFmt = 'yyyy-mm-dd'
      })
    })
  }
  if (spec.meta !== null) {
    const meta = book.addWorksheet('_meta')
    meta.state = 'hidden'
    for (const [key, value] of spec.meta ?? [['catalogVersion', 7]]) meta.addRow([key, value])
  }
  await book.xlsx.writeFile(path)
  return path
}

const load = async (path: string): Promise<ExcelJS.Workbook> => new ExcelJS.Workbook().xlsx.readFile(path)

/** One product row's cells, in header order, from a fixture row. */
const productCells = (row: Record<string, unknown>): unknown[] => HEADERS.products.map((header) => row[header] ?? null)

describe('writeWorkbookFile', () => {
  it('writes the four tabs under their exact names, in order, then a hidden _meta sheet', async () => {
    const path = newPath()
    await writeWorkbookFile(path, validWorkbook(), 7)

    const book = await load(path)

    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(['Products', 'Availability', 'Ingredients', 'Countries', '_meta'])
    // veryHidden, not hidden: Excel's Unhide menu does not list it, so nobody edits the version stamp by accident.
    expect(book.getWorksheet('_meta')?.state).toBe('veryHidden')
    for (const name of ['Products', 'Availability', 'Ingredients', 'Countries']) expect(book.getWorksheet(name)?.state, name).toBe('visible')
  })

  it('puts each tab\'s headers in row 1, in order, and the rows below them', async () => {
    const path = newPath()
    const workbook = validWorkbook({ products: [product(), product({ code: 'PRD-SECOND', brand: 'Second Brand' })] })
    await writeWorkbookFile(path, workbook, 7)

    const book = await load(path)

    for (const [key, name] of Object.entries(TAB_NAMES) as [keyof typeof TAB_NAMES, string][]) {
      const sheet = book.getWorksheet(name)!
      expect(HEADERS[key].map((_, index) => sheet.getRow(1).getCell(index + 1).value), name).toEqual([...HEADERS[key]])
    }
    const products = book.getWorksheet('Products')!
    expect(products.getRow(2).getCell(1).value).toBe('PRD-CERAVE-CLEANSER')
    expect(products.getRow(3).getCell(1).value).toBe('PRD-SECOND')
    expect(products.getRow(3).getCell(2).value).toBe('Second Brand')
    expect(products.actualRowCount).toBe(3)
  })

  it('records the catalog version, as a number, and the contract version in _meta', async () => {
    const path = newPath()
    await writeWorkbookFile(path, validWorkbook(), 12)

    const meta = (await load(path)).getWorksheet('_meta')!
    const pairs = new Map<unknown, unknown>()
    meta.eachRow((row) => pairs.set(row.getCell(1).value, row.getCell(2).value))

    expect(pairs.get('catalogVersion')).toBe(12)
    expect(pairs.get('contractVersion')).toBe(CONTRACT_VERSION)
  })

  it('writes numbers as numbers and everything else as text, dates included, so no spreadsheet reformats a cell', async () => {
    const path = newPath()
    await writeWorkbookFile(path, validWorkbook({ products: [product({ approved_on: day(-3), code: '007' })], availability: [availability({ price_min: 4000, price_max: 6500 })] }), 7)

    const book = await load(path)
    const products = book.getWorksheet('Products')!
    const priceMin = book.getWorksheet('Availability')!.getRow(2).getCell(HEADERS.availability.indexOf('price_min') + 1)
    const approvedOn = products.getRow(2).getCell(HEADERS.products.indexOf('approved_on') + 1)

    expect(priceMin.value).toBe(4000)
    expect(approvedOn.value).toBe(day(-3))
    expect(typeof approvedOn.value).toBe('string')
    expect(products.getRow(2).getCell(1).value).toBe('007')
  })

  it('leaves a null cell, and a cell missing from the row, empty', async () => {
    const path = newPath()
    const sparse = product()
    delete sparse.variant
    await writeWorkbookFile(path, validWorkbook({ products: [sparse] }), 7)

    const row = (await load(path)).getWorksheet('Products')!.getRow(2)

    expect(row.getCell(HEADERS.products.indexOf('variant') + 1).value).toBeNull()
    expect(row.getCell(HEADERS.products.indexOf('form') + 1).value).toBeNull()
  })

  it('writes a tab that has headers and no rows as just its header row', async () => {
    const path = newPath()
    await writeWorkbookFile(path, validWorkbook({ products: [], availability: [], ingredients: [], countries: [] }), 1)

    const book = await load(path)

    for (const name of Object.values(TAB_NAMES)) expect(book.getWorksheet(name)!.actualRowCount, name).toBe(1)
  })
})

describe('writeWorkbookFile: _meta stamps', () => {
  const pairsOf = async (path: string) => {
    const pairs = new Map<unknown, unknown>()
    ;(await load(path)).getWorksheet('_meta')!.eachRow((row) => pairs.set(row.getCell(1).value, row.getCell(2).value))
    return pairs
  }

  it('records the environment the file was exported from, when given one', async () => {
    const path = newPath()
    await writeWorkbookFile(path, validWorkbook(), 7, { environment: 'staging' })

    expect((await pairsOf(path)).get('environment')).toBe('staging')
  })

  it('records the contract version it is given, which is the server\'s, rather than this checkout\'s', async () => {
    const path = newPath()
    await writeWorkbookFile(path, validWorkbook(), 7, { contractVersion: '9.9.9' })

    expect((await pairsOf(path)).get('contractVersion')).toBe('9.9.9')
  })

  it('writes no environment row when none is given', async () => {
    const path = newPath()
    await writeWorkbookFile(path, validWorkbook(), 7)

    expect((await pairsOf(path)).has('environment')).toBe(false)
  })

  it('writes no catalogVersion row for a null version, which reads back as null', async () => {
    const path = newPath()
    await writeWorkbookFile(path, validWorkbook(), null)

    expect((await pairsOf(path)).has('catalogVersion')).toBe(false)
    expect((await readWorkbookFile(path)).catalogVersion).toBeNull()
  })
})

describe('readWorkbookFile: a round trip', () => {
  it('reads back exactly what was written: headers in order, rows, nulls for empty cells, numbers as numbers, lists and dates as text', async () => {
    const path = newPath()
    const written: RawWorkbook = validWorkbook({
      products: [
        product({ evidence_urls: 'https://a.example/one; https://a.example/two', own_cautions: 'sun-sensitivity; irritation', variant: 'Fragrance free' }),
        product({ code: 'PRD-DRAFT-SERUM', brand: 'Brand Two', name: 'Serum', status: 'draft', approved_by: null, approved_on: null, draft_cells: 'frequency=https://a.example/f' }),
      ],
      availability: [availability(), availability({ product_code: 'PRD-DRAFT-SERUM', price_min: 0, price_max: 0, where_sold: null, source_url: null })],
      ingredients: [ingredient(), ingredient({ code: 'ING-ALCOHOL-DENAT-DRYING', name: 'alcohol denat', aliases: 'sd alcohol; denatured alcohol', kind: 'drying', source_url: 'https://a.example/rule', helps: 'hd_oiliness' })],
      countries: [country(), country({ code: 'GH', currency: 'GHS', low_max: 40, mid_max: 120, status: 'retired' })],
    })

    await writeWorkbookFile(path, written, 7)
    const read = await readWorkbookFile(path)

    // toEqual treats a missing key and `undefined` as the same, so the nulls are checked on their own below.
    expect(read.workbook).toEqual(written)
    expect(read.catalogVersion).toBe(7)
  })

  it('gives null, never undefined or an empty string, for an empty cell, and keeps every header as a key', async () => {
    const path = newPath()
    const sparse = product()
    delete sparse.variant
    await writeWorkbookFile(path, validWorkbook({ products: [sparse] }), 7)

    const row = (await readWorkbookFile(path)).workbook.products.rows[0]!

    expect(Object.keys(row).sort()).toEqual([...HEADERS.products].sort())
    expect(row.variant).toBeNull()
    expect(row.form).toBeNull()
    expect(row.audited_by).toBeNull()
  })

  it('keeps a number a number, and a text that only looks like one text', async () => {
    const path = newPath()
    await writeWorkbookFile(path, validWorkbook({ products: [product({ code: '007' })], availability: [availability({ price_min: 4000, price_max: 6500 })], countries: [country({ low_max: 5000, mid_max: 15000 })] }), 7)

    const { workbook } = await readWorkbookFile(path)

    expect(workbook.availability.rows[0]).toMatchObject({ price_min: 4000, price_max: 6500 })
    expect(workbook.countries.rows[0]).toMatchObject({ low_max: 5000, mid_max: 15000 })
    expect(workbook.products.rows[0]!.code).toBe('007')
  })

  it.each([[7], [1], [4096]])('returns catalog version %i as a number', async (version) => {
    const path = newPath()
    await writeWorkbookFile(path, validWorkbook(), version)

    expect((await readWorkbookFile(path)).catalogVersion).toBe(version)
  })
})

describe('readWorkbookFile: a file as Excel leaves it', () => {
  it('reads a real Excel date cell as YYYY-MM-DD text', async () => {
    const path = await buildFile({ tabs: { products: [[...HEADERS.products], productCells({ code: 'PRD-A', approved_on: dayAsDate(-3), audited_on: dayAsDate(0) })] } })

    const row = (await readWorkbookFile(path)).workbook.products.rows[0]!

    expect(row.approved_on).toBe(day(-3))
    expect(row.audited_on).toBe(day(0))
  })

  it.each(['America/Los_Angeles', 'Pacific/Auckland'])('reads the same day for a date cell whatever the time zone of the machine (%s)', async (zone) => {
    const path = await buildFile({ tabs: { products: [[...HEADERS.products], productCells({ code: 'PRD-A', approved_on: dayAsDate(-3) })] } })
    const before = process.env.TZ
    process.env.TZ = zone
    try {
      expect((await readWorkbookFile(path)).workbook.products.rows[0]!.approved_on).toBe(day(-3))
    } finally {
      if (before === undefined) delete process.env.TZ
      else process.env.TZ = before
    }
  })

  it('reads a date typed as text as that same text', async () => {
    const path = await buildFile({ tabs: { products: [[...HEADERS.products], productCells({ code: 'PRD-A', approved_on: day(-3) })] } })

    expect((await readWorkbookFile(path)).workbook.products.rows[0]!.approved_on).toBe(day(-3))
  })

  it('reads a link Excel turned into a hyperlink as its address, not as an object', async () => {
    const url = 'https://www.cerave.com/hydrating-cleanser'
    const path = await buildFile({ tabs: { products: [[...HEADERS.products], productCells({ code: 'PRD-A', ingredients_source_url: { text: url, hyperlink: url } })] } })

    expect((await readWorkbookFile(path)).workbook.products.rows[0]!.ingredients_source_url).toBe(url)
  })

  it('reads a hyperlink as the text it displays, not the address behind it, since the displayed text is what the person edited and checked', async () => {
    const path = await buildFile({ tabs: { products: [[...HEADERS.products], productCells({ code: 'PRD-A', brand: { text: 'CeraVe', hyperlink: 'https://elsewhere.example/page' } })] } })

    expect((await readWorkbookFile(path)).workbook.products.rows[0]!.brand).toBe('CeraVe')
  })

  it('reads a hyperlink whose displayed text is rich text as that text', async () => {
    const path = await buildFile({ tabs: { products: [[...HEADERS.products], productCells({ code: 'PRD-A', brand: { text: { richText: [{ text: 'Cera' }, { text: 'Ve' }] }, hyperlink: 'https://elsewhere.example/page' } })] } })

    expect((await readWorkbookFile(path)).workbook.products.rows[0]!.brand).toBe('CeraVe')
  })

  it('refuses a formula that has no saved result, naming the tab, the row and the column, rather than read it as empty', async () => {
    const path = await buildFile({ tabs: { availability: [[...HEADERS.availability], ['PRD-A', 'NG', { formula: '2000+2000' }, 6500, null]] } })

    await expect(readWorkbookFile(path)).rejects.toThrow(/Availability.*row 2.*price_min.*formula/i)
  })

  it('reads a formula cell as the value it shows', async () => {
    const path = await buildFile({ tabs: { availability: [[...HEADERS.availability], ['PRD-A', 'NG', { formula: '2000+2000', result: 4000 }, 6500, null]] } })

    expect((await readWorkbookFile(path)).workbook.availability.rows[0]!.price_min).toBe(4000)
  })

  it('reads a cell with mixed formatting as its plain text', async () => {
    const path = await buildFile({ tabs: { products: [[...HEADERS.products], productCells({ code: 'PRD-A', brand: { richText: [{ text: 'Cera' }, { text: 'Ve' }] } })] } })

    expect((await readWorkbookFile(path)).workbook.products.rows[0]!.brand).toBe('CeraVe')
  })

  it('drops the empty rows after the last filled one, which a sheet keeps once a cell has been formatted', async () => {
    const path = newPath()
    const book = new ExcelJS.Workbook()
    for (const [key, name] of Object.entries(TAB_NAMES) as [keyof typeof TAB_NAMES, string][]) {
      const sheet = book.addWorksheet(name)
      sheet.addRow([...HEADERS[key]])
    }
    const products = book.getWorksheet('Products')!
    products.addRow(productCells({ code: 'PRD-A', brand: 'A', name: 'A' }))
    products.getRow(6).getCell(1).font = { bold: true }
    const meta = book.addWorksheet('_meta')
    meta.addRow(['catalogVersion', 7])
    await book.xlsx.writeFile(path)

    expect((await readWorkbookFile(path)).workbook.products.rows).toHaveLength(1)
  })

  it('keeps an empty row between filled ones as an all-null row, so a problem reported for a row number points at the same row in the spreadsheet', async () => {
    const path = newPath()
    const book = new ExcelJS.Workbook()
    for (const [key, name] of Object.entries(TAB_NAMES) as [keyof typeof TAB_NAMES, string][]) book.addWorksheet(name).addRow([...HEADERS[key]])
    const products = book.getWorksheet('Products')!
    products.getRow(2).getCell(1).value = 'PRD-A'
    products.getRow(4).getCell(1).value = 'PRD-C'
    book.addWorksheet('_meta').addRow(['catalogVersion', 7])
    await book.xlsx.writeFile(path)

    const rows = (await readWorkbookFile(path)).workbook.products.rows

    expect(rows).toHaveLength(3)
    expect(rows[0]!.code).toBe('PRD-A')
    expect(Object.values(rows[1]!).every((cell) => cell === null)).toBe(true)
    expect(rows[2]!.code).toBe('PRD-C')
  })

  it('returns the headers as written, so the contract can say which are missing or unknown', async () => {
    const odd = ['code', 'brand', 'colour']
    const path = await buildFile({ tabs: { products: [odd, ['PRD-A', 'A', 'red']] } })

    const tab = (await readWorkbookFile(path)).workbook.products

    expect(tab.headers).toEqual(odd)
    expect(tab.rows).toEqual([{ code: 'PRD-A', brand: 'A', colour: 'red' }])
  })
})

describe('readWorkbookFile: _meta', () => {
  it('gives a null catalog version for a workbook with no _meta sheet, which is not an error here', async () => {
    const path = await buildFile({ meta: null })

    const read = await readWorkbookFile(path)

    expect(read.catalogVersion).toBeNull()
    expect(read.workbook.products.headers).toEqual([...HEADERS.products])
  })

  it('gives a null catalog version when _meta has no catalogVersion row', async () => {
    const path = await buildFile({ meta: [['contractVersion', CONTRACT_VERSION]] })

    expect((await readWorkbookFile(path)).catalogVersion).toBeNull()
  })

  it.each([['not a number'], [''], [0], [-3], [2.5]])('gives a null catalog version when _meta holds %j, since no export ever made that', async (value) => {
    const path = await buildFile({ meta: [['catalogVersion', value]] })

    expect((await readWorkbookFile(path)).catalogVersion).toBeNull()
  })

  it('reads a catalog version someone retyped as text, as the number it spells', async () => {
    const path = await buildFile({ meta: [['catalogVersion', '12']] })

    expect((await readWorkbookFile(path)).catalogVersion).toBe(12)
  })

  it('reads the environment and the contract version the file was stamped with', async () => {
    const path = await buildFile({ meta: [['catalogVersion', 7], ['environment', 'staging'], ['contractVersion', '1.0.0']] })

    const read = await readWorkbookFile(path)

    expect(read.environment).toBe('staging')
    expect(read.contractVersion).toBe('1.0.0')
  })

  it('gives a null environment and a null contract version when _meta has neither', async () => {
    const path = await buildFile({ meta: [['catalogVersion', 7]] })

    const read = await readWorkbookFile(path)

    expect(read.environment).toBeNull()
    expect(read.contractVersion).toBeNull()
  })

  it('gives null for both stamps, and does not fail, when there is no _meta sheet', async () => {
    const read = await readWorkbookFile(await buildFile({ meta: null }))

    expect(read.environment).toBeNull()
    expect(read.contractVersion).toBeNull()
  })

  it('does not treat _meta as one of the four tabs', async () => {
    const path = await buildFile()

    expect(Object.keys((await readWorkbookFile(path)).workbook).sort()).toEqual(['availability', 'countries', 'ingredients', 'products'])
  })
})

describe('readWorkbookFile: headers that cannot be trusted', () => {
  it('refuses a header written twice, naming the tab, the header and both columns', async () => {
    const twice = [...HEADERS.products]
    twice[3] = 'code'
    const path = await buildFile({ tabs: { products: [twice, ['PRD-A']] } })

    await expect(readWorkbookFile(path)).rejects.toThrow(/Products.*"code".*\bA\b.*\bD\b/)
  })

  it('refuses data under a blank header cell in the middle of the row, naming the tab and the column letter, rather than drop it', async () => {
    const gap: string[] = [...HEADERS.products]
    gap[2] = ''
    const cells: unknown[] = HEADERS.products.map(() => null)
    cells[2] = 'orphan'
    const path = await buildFile({ tabs: { products: [gap, cells] } })

    await expect(readWorkbookFile(path)).rejects.toThrow(/Products.*column C/)
  })

  it('refuses data to the right of the last header, naming the column letter', async () => {
    const cells: unknown[] = HEADERS.availability.map(() => null)
    cells[HEADERS.availability.length] = 'stray'
    const path = await buildFile({ tabs: { availability: [[...HEADERS.availability], cells] } })

    await expect(readWorkbookFile(path)).rejects.toThrow(new RegExp(`Availability.*column ${String.fromCharCode(65 + HEADERS.availability.length)}`))
  })

  it('accepts a blank header cell with nothing under it, such as a column someone cleared', async () => {
    const gap = [...HEADERS.countries, '']
    const path = await buildFile({ tabs: { countries: [gap, ['NG', 'NGN', 5000, 15000, 'active']] } })

    const tab = (await readWorkbookFile(path)).workbook.countries

    expect(tab.headers).toEqual([...HEADERS.countries])
    expect(tab.rows).toHaveLength(1)
  })
})

describe('readWorkbookBytes', () => {
  it('reads the workbook from bytes that are already in memory, so what is parsed is what is sent', async () => {
    const path = newPath()
    await writeWorkbookFile(path, validWorkbook(), 7, { environment: 'staging' })

    const read = await readWorkbookBytes(new Uint8Array(await readFile(path)))

    expect(read.workbook).toEqual(validWorkbook())
    expect(read.catalogVersion).toBe(7)
    expect(read.environment).toBe('staging')
  })

  it('reports bytes that are not a workbook as an error with a message', async () => {
    await expect(readWorkbookBytes(new TextEncoder().encode('this is not a zip file'))).rejects.toThrow(/\S/)
  })
})

describe('readWorkbookFile: a tab that is not there', () => {
  it.each(Object.entries(TAB_NAMES))('names the %s tab (%s) when it is missing', async (key, name) => {
    const path = newPath()
    const book = new ExcelJS.Workbook()
    for (const other of Object.values(TAB_NAMES)) if (other !== name) book.addWorksheet(other).addRow(['code'])
    book.addWorksheet('_meta').addRow(['catalogVersion', 7])
    await book.xlsx.writeFile(path)

    await expect(readWorkbookFile(path), key).rejects.toThrow(new RegExp(name))
  })

  it.each([
    ['a lower-case name', 'products'],
    ['a name with a trailing space', 'Products '],
    ['a renamed tab', 'Products (2)'],
  ])('matches tab names exactly, so %s is a missing Products tab', async (_label, wrongName) => {
    const path = await buildFile({ names: { products: wrongName } })

    await expect(readWorkbookFile(path)).rejects.toThrow(/Products/)
  })

  it('reports a file that is not a workbook as an error rather than a crash with no message', async () => {
    const path = newPath()
    await writeFile(path, 'this is not a zip file')

    await expect(readWorkbookFile(path)).rejects.toThrow(/\S/)
  })
})

// A caller that prints only the messages it can vouch for (catalog:draft) tells these apart from every other Error by their class.
describe('readWorkbookFile: mistakes in the file are WorkbookFileErrors', () => {
  it('throws one for a formula with no saved result', async () => {
    const path = await buildFile({ tabs: { availability: [[...HEADERS.availability], ['PRD-A', 'NG', { formula: '2000+2000' }, 6500, null]] } })

    await expect(readWorkbookFile(path)).rejects.toBeInstanceOf(WorkbookFileError)
  })

  it('throws one for a header written twice', async () => {
    const twice = [...HEADERS.products]
    twice[3] = 'code'
    const path = await buildFile({ tabs: { products: [twice, ['PRD-A']] } })

    await expect(readWorkbookFile(path)).rejects.toBeInstanceOf(WorkbookFileError)
  })

  it('throws one for data under a blank header', async () => {
    const gap: string[] = [...HEADERS.products]
    gap[2] = ''
    const cells: unknown[] = HEADERS.products.map(() => null)
    cells[2] = 'orphan'
    const path = await buildFile({ tabs: { products: [gap, cells] } })

    await expect(readWorkbookFile(path)).rejects.toBeInstanceOf(WorkbookFileError)
  })

  it('throws one for a missing tab', async () => {
    const path = await buildFile({ names: { products: 'products' } })

    await expect(readWorkbookFile(path)).rejects.toBeInstanceOf(WorkbookFileError)
  })

  it('throws one, in fixed words and never the library\'s, for a file that is not a workbook, naming the path as given', async () => {
    const path = newPath()
    await writeFile(path, 'this is not a zip file')

    const error = await readWorkbookFile(path).then(() => undefined, (failure: unknown) => failure)

    expect(error).toBeInstanceOf(WorkbookFileError)
    expect((error as Error).message).toBe(`${path} could not be read as an .xlsx workbook (not one, or damaged): save it from Excel or LibreOffice as .xlsx.`)
  })

  it('says "The file" for bytes that are not a workbook when it is not told a name', async () => {
    const error = await readWorkbookBytes(new TextEncoder().encode('this is not a zip file')).then(() => undefined, (failure: unknown) => failure)

    expect(error).toBeInstanceOf(WorkbookFileError)
    expect((error as Error).message).toBe('The file could not be read as an .xlsx workbook (not one, or damaged): save it from Excel or LibreOffice as .xlsx.')
  })

  it('uses the name it is told for bytes that are not a workbook', async () => {
    await expect(readWorkbookBytes(new TextEncoder().encode('nope'), 'edited.xlsx')).rejects.toThrow(/^edited\.xlsx could not be read as an \.xlsx workbook/)
  })

  it('throws one for a path with no file, naming the path as typed', async () => {
    const path = join(dir, 'typed-wrong.xlsx')

    for (const read of [readWorkbookFile, readFileBytes]) {
      const error = await read(path).then(() => undefined, (failure: unknown) => failure)
      expect(error).toBeInstanceOf(WorkbookFileError)
      expect((error as Error).message).toBe(`No file at ${path}`)
    }
  })

  it('leaves any other failure to read a file (a folder, no permission) as it was, for the caller to hide', async () => {
    const error = await readFileBytes(dir).then(() => undefined, (failure: unknown) => failure)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(WorkbookFileError)
  })
})
