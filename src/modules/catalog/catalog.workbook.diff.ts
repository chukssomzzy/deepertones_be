import { stableJson } from '../../lib/stable-json'
import { guideKey, type Workbook } from './catalog.workbook.schema'

/** What an upload does to one tab, as codes. Availability is keyed "<product code>:<country>", a guide by its step ("<step>:<goal>" when it has a goal), and a row that is gone is listed under `retired`. */
export type TabDiff = { added: string[]; updated: string[]; retired: string[]; reactivated: string[] }

export type WorkbookDiff = { products: TabDiff; availability: TabDiff; ingredients: TabDiff; countries: TabDiff; claimWords: TabDiff; tapers: TabDiff; guides: TabDiff }

// Rows are compared by what they mean: both sides are parsed, so "a;b" and "a; b" are one list, and a date is a day, not a string.
const meaning = (row: object): string => stableJson(JSON.parse(JSON.stringify(row)))

const diffTab = <Row extends object>(live: Row[], next: Row[], keyOf: (row: Row) => string, retiredOf: (row: Row) => boolean): TabDiff => {
  const diff: TabDiff = { added: [], updated: [], retired: [], reactivated: [] }
  const before = new Map(live.map((row) => [keyOf(row), row]))
  const after = new Map(next.map((row) => [keyOf(row), row]))
  for (const [key, row] of after) {
    const was = before.get(key)
    if (!was) diff.added.push(key)
    else if (retiredOf(was) && !retiredOf(row)) diff.reactivated.push(key)
    else if (!retiredOf(was) && retiredOf(row)) diff.retired.push(key)
    else if (meaning(was) !== meaning(row)) diff.updated.push(key)
  }
  // A code the upload leaves out is retired, unless it already was.
  for (const [key, row] of before) if (!after.has(key) && !retiredOf(row)) diff.retired.push(key)
  return diff
}

const rowStatus = (row: { status: string }): boolean => row.status === 'retired'

/**
 * What applying `next` over `live` changes. A code missing from `next` is retired (its row stays, so the code is never reused), and a retired
 * code put back is reactivated. A product's availability that is gone is retired too; it has no status of its own, and the row is removed.
 */
export const diffWorkbooks = (live: Workbook, next: Workbook): WorkbookDiff => ({
  products: diffTab(live.products, next.products, (row) => row.code, rowStatus),
  availability: diffTab(live.availability, next.availability, (row) => `${row.productCode}:${row.country}`, () => false),
  ingredients: diffTab(live.ingredients, next.ingredients, (row) => row.code, rowStatus),
  countries: diffTab(live.countries, next.countries, (row) => row.code, (row) => row.status === 'retired'),
  claimWords: diffTab(live.claimWords, next.claimWords, (row) => row.code, rowStatus),
  tapers: diffTab(live.tapers, next.tapers, (row) => row.code, rowStatus),
  guides: diffTab(live.guides, next.guides, guideKey, rowStatus),
})
