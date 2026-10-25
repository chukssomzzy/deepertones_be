/*
 * The catalog the routine eval recommends from: the owner's curated workbook, kept in the gitignored eval-data/ folder because the repo is public and the
 * rows name real products. It is read with the reader `catalog:upload` uses and checked by the same contract, then turned into what the recommendation
 * service reads (see catalogFor). Inside the eval only, every row that is not retired counts as approved, drafts included: the curated rows are all drafts.
 */
import { createHash } from 'node:crypto'
import type { ReferenceEntry } from '../../src/modules/catalog/catalog.reference'
import type { ProductSummary } from '../../src/modules/catalog/catalog.service'
import { FakeCatalogWorkbook } from '../../src/modules/catalog/catalog.workbook.service.fake'
import { referenceEntriesOf } from '../../src/modules/catalog/catalog.workbook.service'
import type { Country, Recommendation } from '../../src/modules/catalog/catalog.workbook.repository'
import { validateWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import { readFileBytes, readWorkbookBytes, WorkbookFileError } from '../catalog/xlsx'

export const DEFAULT_SNAPSHOT_PATH = 'eval-data/routine/catalog-snapshot.xlsx'

/** The snapshot cannot be used and the cases say nothing about the code: the CLI exits 2. The message holds a path, a tab, a row, a column and a rule code, never a cell's value. */
export class SnapshotError extends Error {}

/** One product on sale in one country: the row the recommendation service reads (with that country's price), and the product facts a candidate shows. */
export type SnapshotOffer = { country: string; row: Recommendation; summary: ProductSummary }

export type Snapshot = {
  /** The sha256 of the file's bytes: what a label set is pinned to. */
  sha256: string
  countries: Country[]
  rules: ReferenceEntry[]
  offers: SnapshotOffer[]
}

export const loadSnapshot = async (path: string): Promise<Snapshot> => {
  let bytes: Uint8Array
  try {
    bytes = await readFileBytes(path)
  } catch (error) {
    if (error instanceof WorkbookFileError) {
      throw new SnapshotError(`No catalog snapshot at ${path}. Copy the curated workbook to ${DEFAULT_SNAPSHOT_PATH} (the folder is gitignored: the snapshot is never committed).`, { cause: error })
    }
    throw error
  }
  let raw
  try {
    raw = (await readWorkbookBytes(bytes, path)).workbook
  } catch (error) {
    // A WorkbookFileError holds only a tab, a column, a row and fixed words, so its message may be shown.
    if (error instanceof WorkbookFileError) throw new SnapshotError(error.message, { cause: error })
    throw error
  }
  const checked = validateWorkbook(raw)
  if (!checked.ok) {
    const shown = checked.problems.map((p) => `${p.tab} row ${p.row}, column ${p.column}: ${p.rule}`)
    throw new SnapshotError(`The catalog snapshot ${path} breaks the workbook contract (${shown.length} problems):\n${shown.map((line) => `  ${line}`).join('\n')}`)
  }
  const { workbook } = checked

  const live = workbook.products.filter((product) => product.status !== 'retired')
  const offers: SnapshotOffer[] = live.flatMap((product) =>
    workbook.availability
      .filter((availability) => availability.productCode === product.code)
      .map((availability): SnapshotOffer => {
        const productId = `snap-${product.code}`
        return {
          country: availability.country,
          row: {
            code: product.code,
            productId,
            formulationId: `snap-f-${product.code}`,
            ingredients: product.ingredients,
            skinConcerns: product.skinConcerns,
            skinTypes: product.skinTypes.includes('all') ? 'all' : (product.skinTypes as Exclude<Recommendation['skinTypes'], 'all'>),
            steps: product.steps,
            frequency: product.frequency,
            ownCautions: product.ownCautions,
            evidenceUrls: product.evidenceUrls,
            ingredientsSourceUrl: product.ingredientsSourceUrl,
            origin: product.origin,
            priceMin: availability.priceMin,
            priceMax: availability.priceMax,
            whereSold: availability.whereSold,
          },
          summary: { id: productId, kind: 'named', brand: product.brand, name: product.name, variant: product.variant, form: product.form, category: product.category, imageUrl: null },
        }
      }),
  )

  // The live mapping, fed every rule that is not retired (drafts count as approved here).
  const rules = referenceEntriesOf(workbook.ingredients.filter((rule) => rule.status !== 'retired'))

  return { sha256: createHash('sha256').update(bytes).digest('hex'), countries: workbook.countries, rules, offers }
}

/** The snapshot as the recommendation service reads the catalog: the countries, the rows on offer in each, and the rules. */
export const catalogFor = (snapshot: Snapshot): FakeCatalogWorkbook => {
  const catalog = new FakeCatalogWorkbook()
  for (const country of snapshot.countries) catalog.addCountry(country)
  for (const { country, row } of snapshot.offers) catalog.offer(country, row)
  return catalog.setRules(snapshot.rules)
}
