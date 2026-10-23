/**
 * The workbook file, shared by `catalog:export` (writes one) and `catalog:upload` (reads one back). The layout is the contract with the people
 * who edit it: four tabs named exactly Products, Availability, Ingredients and Countries, the header row first, and a hidden `_meta` sheet that
 * remembers where the file came from, one `key | value` pair per row: `catalogVersion`, `environment` and `contractVersion`.
 */
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import { CONTRACT_VERSION, type Cell, type RawRow, type RawTab, type RawWorkbook, type TabKey } from '../../src/modules/catalog/catalog.workbook.schema'

export const TAB_NAMES: Record<TabKey, string> = { products: 'Products', availability: 'Availability', ingredients: 'Ingredients', countries: 'Countries' }
const TAB_KEYS = Object.keys(TAB_NAMES) as TabKey[]
const META = '_meta'

/** What a file remembers about where it came from. `contractVersion` is the server's when it was exported, and defaults to this checkout's. */
export type Stamp = { environment?: string; contractVersion?: string }

export type WorkbookFile = { workbook: RawWorkbook; catalogVersion: number | null; environment: string | null; contractVersion: string | null }

/** Numbers stay numbers; everything else is text, dates included, so no spreadsheet reformats a cell on the way through. */
export async function writeWorkbookFile(path: string, workbook: RawWorkbook, catalogVersion: number | null, stamp: Stamp = {}): Promise<void> {
  const book = new ExcelJS.Workbook()
  for (const key of TAB_KEYS) {
    const { headers, rows } = workbook[key]
    const sheet = book.addWorksheet(TAB_NAMES[key])
    headers.forEach((header, column) => {
      sheet.getRow(1).getCell(column + 1).value = header
    })
    rows.forEach((row, index) => {
      headers.forEach((header, column) => {
        const value = row[header]
        if (value !== null && value !== undefined) sheet.getRow(index + 2).getCell(column + 1).value = value
      })
    })
  }
  const meta = book.addWorksheet(META)
  // veryHidden: Excel's Unhide menu does not list it, so nobody edits the stamps by accident.
  meta.state = 'veryHidden'
  if (catalogVersion !== null) meta.addRow(['catalogVersion', catalogVersion])
  if (stamp.environment !== undefined) meta.addRow(['environment', stamp.environment])
  meta.addRow(['contractVersion', stamp.contractVersion ?? CONTRACT_VERSION])
  await book.xlsx.writeFile(path)
}

/**
 * A mistake in the file that the person can fix (a missing tab, a repeated or missing header, a formula with no saved result). The message holds only
 * a tab, a column, a row and fixed words, so a caller that hides every other error's message may print this one.
 */
export class WorkbookFileError extends Error {}

/** A formula saved without a result (written by a tool that never calculated it): there is no value to read, and guessing "empty" would hide it. */
class FormulaWithoutResult extends Error {}

/** What a cell shows, as the contract's cell types. A day is read in UTC, so the same file gives the same date on every machine. */
function plainValue(value: ExcelJS.CellValue | undefined): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return value === '' ? null : value
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  // A hyperlink reads as the text it displays, which is what the person edited and checked, not the address behind it.
  if ('hyperlink' in value) return plainValue(value.text)
  if ('richText' in value) return plainValue(value.richText.map((part) => part.text).join(''))
  if ('formula' in value || 'sharedFormula' in value) {
    if (value.result === undefined) throw new FormulaWithoutResult()
    return plainValue(value.result as ExcelJS.CellValue)
  }
  // An error cell (#REF!, #N/A) stays visible as its text, so the contract rejects it rather than treat it as empty.
  if ('error' in value) return value.error
  return null
}

const isEmpty = (row: RawRow): boolean => Object.values(row).every((cell) => cell === null)

/**
 * Headers as written on row 1; each later row is one object keyed by them. Empty rows between filled ones are kept, so a problem reported for
 * row N is row N in the spreadsheet. Empty rows after the last filled one are dropped: a sheet keeps them once a cell was only formatted.
 * A header written twice, or data in a column with no header, is refused: either would silently lose a column of the person's work.
 */
function readTab(sheet: ExcelJS.Worksheet): RawTab {
  const tab = sheet.name
  const width = Math.max(sheet.columnCount, sheet.getRow(1).cellCount)
  const letter = (column: number) => sheet.getColumn(column).letter
  const read = (rowNumber: number, column: number, header: string | null): Cell => {
    try {
      return plainValue(sheet.getRow(rowNumber).getCell(column).value)
    } catch (error) {
      if (!(error instanceof FormulaWithoutResult)) throw error
      throw new WorkbookFileError(`${tab} row ${rowNumber}, column ${header ?? letter(column)} holds a formula with no saved result. Open the file in Excel, save it, and upload that copy.`, { cause: error })
    }
  }

  const all: string[] = []
  for (let column = 1; column <= width; column++) all.push(String(read(1, column, null) ?? ''))
  const headers = [...all]
  while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop()

  const firstAt = new Map<string, number>()
  headers.forEach((header, index) => {
    if (header === '') return
    const first = firstAt.get(header)
    if (first !== undefined) throw new WorkbookFileError(`The ${tab} tab has the header "${header}" twice, in columns ${letter(first + 1)} and ${letter(index + 1)}. Each column name may appear once.`)
    firstAt.set(header, index)
  })

  const rows: RawRow[] = []
  for (let number = 2; number <= sheet.rowCount; number++) {
    const row: RawRow = {}
    for (let column = 1; column <= width; column++) {
      const header = all[column - 1]!
      const value = read(number, column, header === '' ? null : header)
      if (header === '') {
        if (value !== null) throw new WorkbookFileError(`The ${tab} tab has data in column ${letter(column)} (row ${number}), which has no header. Give the column a header or clear it.`)
      } else {
        row[header] = value
      }
    }
    rows.push(row)
  }
  while (rows.length > 0 && isEmpty(rows[rows.length - 1]!)) rows.pop()
  return { headers, rows }
}

/** What `_meta` holds under `key`, as text or a number, or null when it is not there or cannot be read. */
function metaValue(meta: ExcelJS.Worksheet | undefined, key: string): Cell {
  if (meta === undefined) return null
  for (let number = 1; number <= meta.rowCount; number++) {
    const row = meta.getRow(number)
    try {
      if (plainValue(row.getCell(1).value) === key) return plainValue(row.getCell(2).value)
    } catch (error) {
      if (!(error instanceof FormulaWithoutResult)) throw error
    }
  }
  return null
}

/** The version the file was exported at, or null when `_meta` does not hold a whole number above zero (no export ever wrote anything else). */
function catalogVersionOf(meta: ExcelJS.Worksheet | undefined): number | null {
  const value = metaValue(meta, 'catalogVersion')
  const version = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : null
}

const textOf = (value: Cell): string | null => (typeof value === 'string' ? value : null)

/** The workbook from the bytes of a file already read, so a caller that also sends the file sends exactly what it checked. `name` is how the file is called in a message. */
export async function readWorkbookBytes(bytes: Uint8Array, name = 'The file'): Promise<WorkbookFile> {
  const book = new ExcelJS.Workbook()
  try {
    // exceljs types `load` against an older, non-generic Buffer.
    await book.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof book.xlsx.load>[0])
  } catch (error) {
    // The library's own message is not repeated: it is not ours to vouch for.
    throw new WorkbookFileError(`${name} could not be read as an .xlsx workbook (not one, or damaged): save it from Excel or LibreOffice as .xlsx.`, { cause: error })
  }
  // Names are matched exactly: a renamed or re-cased tab is a missing one, never a guess.
  const sheets = new Map(book.worksheets.map((sheet) => [sheet.name, sheet]))
  const missing = TAB_KEYS.filter((key) => !sheets.has(TAB_NAMES[key])).map((key) => TAB_NAMES[key])
  if (missing.length > 0) throw new WorkbookFileError(`The workbook is missing the ${missing.join(', ')} tab${missing.length > 1 ? 's' : ''}, named exactly so.`)

  const [products, availability, ingredients, countries] = TAB_KEYS.map((key) => readTab(sheets.get(TAB_NAMES[key])!))
  const meta = sheets.get(META)
  return {
    workbook: { products: products!, availability: availability!, ingredients: ingredients!, countries: countries! },
    catalogVersion: catalogVersionOf(meta),
    environment: textOf(metaValue(meta, 'environment')),
    contractVersion: textOf(metaValue(meta, 'contractVersion')),
  }
}

/** The bytes of the file at `path`. A path with no file is the person's typing, so it is told, as typed; any other failure is left as it came. */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path))
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') throw new WorkbookFileError(`No file at ${path}`, { cause: error })
    throw error
  }
}

export async function readWorkbookFile(path: string): Promise<WorkbookFile> {
  return readWorkbookBytes(await readFileBytes(path), path)
}
