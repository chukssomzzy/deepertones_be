/*
 * The catalog reference of `npm run eval:verdict`: the owner's curated workbook, kept in the gitignored eval-data/ folder because the repo is public and the rows
 * name real products. It is read with the reader `catalog:upload` uses and checked by the same contract (as routine-snapshot.ts does), then turned into what the
 * shelf verdict is built against, through the same mappings the live service uses (`verdictRulesOf`, `approvedTapersOf`). Inside the eval only, every rule and claim
 * phrase that is not retired counts as approved, drafts included: the curated rows are all drafts. A step-down template is the exception: it is approved by a
 * qualified person or it does not exist, so a draft one is never used.
 */
import { createHash } from 'node:crypto'
import type { Category, ProductForm } from '../../src/modules/catalog/catalog.vocabulary'
import { TAPER_KINDS } from '../../src/modules/catalog/catalog.vocabulary'
import { validateWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import { approvedTapersOf, verdictClaimWordsOf, verdictRulesOf, type VerdictReference } from '../../src/modules/catalog/catalog.workbook.service'
import type { ShownConcern } from '../../src/modules/face-scans/face-scans.tables'
import { readFileBytes, readWorkbookBytes, WorkbookFileError } from '../catalog/xlsx'
import type { VerdictCase } from './verdict-cases'

export const DEFAULT_VERDICT_SNAPSHOT_PATH = 'eval-data/verdict/catalog-snapshot.xlsx'

/** The snapshot cannot be used and the cases say nothing about the code: the CLI exits 2. The message holds a path, a tab, a row, a column and a rule code, never a cell's value. */
export class VerdictReferenceError extends Error {}

/** The facts of a catalog product that a case copies. */
export type CatalogProduct = { brand: string; name: string; variant: string | null; form: ProductForm | null; category: Category; ingredients: string[] }

export type LoadedVerdictReference = {
  reference: VerdictReference
  /** The sha256 of the file's bytes: what a run is pinned to. */
  sha256: string
  /** Every product of the workbook that is not retired, by code. */
  products: Map<string, CatalogProduct>
  /**
   * What the recommendation catalog says each product is for, by code. Only a product whose row is approved is in it: a draft row is not recommended, so the
   * app would tell the fit judge nothing about it. This is not on `CatalogProduct` so that a case's copy of a product is compared on what it states of itself.
   */
  skinConcerns: Map<string, ShownConcern[]>
}

export const loadVerdictReference = async (path: string): Promise<LoadedVerdictReference> => {
  let bytes: Uint8Array
  try {
    bytes = await readFileBytes(path)
  } catch (error) {
    if (error instanceof WorkbookFileError) {
      throw new VerdictReferenceError(`No catalog snapshot at ${path}. Copy the curated workbook to ${DEFAULT_VERDICT_SNAPSHOT_PATH} (the folder is gitignored: the snapshot is never committed).`, { cause: error })
    }
    throw error
  }
  let file
  try {
    file = await readWorkbookBytes(bytes, path)
  } catch (error) {
    // A WorkbookFileError holds only a tab, a column, a row and fixed words, so its message may be shown.
    if (error instanceof WorkbookFileError) throw new VerdictReferenceError(error.message, { cause: error })
    throw error
  }
  const checked = validateWorkbook(file.workbook)
  if (!checked.ok) {
    const shown = checked.problems.map((p) => `${p.tab} row ${p.row}, column ${p.column}: ${p.rule}`)
    throw new VerdictReferenceError(`The catalog snapshot ${path} breaks the workbook contract (${shown.length} problems):\n${shown.map((line) => `  ${line}`).join('\n')}`)
  }
  const { workbook } = checked

  const tapers = approvedTapersOf(workbook.tapers)
  const missing = TAPER_KINDS.filter((kind) => tapers[kind] === undefined)
  if (missing.length > 0) {
    throw new VerdictReferenceError(`The catalog snapshot ${path} has no approved step-down template of kind: ${missing.join(', ')}. A step-down is approved by a qualified person, so a draft one does not count.`)
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const live = workbook.products.filter((product) => product.status !== 'retired')
  // Draft claim words count as approved here, as draft rules do: the snapshot is the owner's working copy.
  const claimWords = verdictClaimWordsOf(workbook.claimWords.filter((word) => word.status !== 'retired'))
  return {
    reference: {
      rulesVersion: `snapshot-${sha256.slice(0, 12)}`,
      catalogVersion: file.catalogVersion ?? 0,
      rules: verdictRulesOf(workbook.ingredients.filter((rule) => rule.status !== 'retired')),
      claimPhrases: claimWords.map(({ phrase }) => phrase),
      claimWords,
      tapers,
    },
    sha256,
    products: new Map(live.map((product) => [product.code, { brand: product.brand, name: product.name, variant: product.variant, form: product.form, category: product.category, ingredients: [...product.ingredients] }])),
    skinConcerns: new Map(live.filter((product) => product.status === 'approved').map((product) => [product.code, [...product.skinConcerns]])),
  }
}

// --- cases that copy a catalog product -----------------------------------------------------------------------------------------------------------------

export type CatalogEntryProblem = {
  caseId: string
  entryId: string
  code: string
  problem: 'not-in-snapshot' | 'ingredients-differ' | 'skin-concerns-differ'
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, at) => item === b[at])
const sameSet = (a: readonly string[], b: readonly string[]): boolean => sameList([...new Set(a)].sort(), [...new Set(b)].sort())

/**
 * The entries of the cases that copy a catalog product (`source.catalogCode`) and do not match the snapshot, in case order and then shelf order. A copy is only
 * meaningful when its ingredient list is the snapshot's word for word and in order, since the floor and the fit judge read it. With `skinConcerns` given, the
 * entry's own skin concerns must also equal the snapshot's (order aside), and a product with none listed there is expected to carry none. An entry that is made
 * up or has no label has no snapshot row to differ from.
 */
export const checkCatalogEntries = (
  cases: readonly VerdictCase[],
  products: ReadonlyMap<string, CatalogProduct>,
  skinConcerns?: ReadonlyMap<string, readonly ShownConcern[]>,
): CatalogEntryProblem[] =>
  cases.flatMap((c) =>
    c.shelf.flatMap((entry): CatalogEntryProblem[] => {
      if (entry.kind !== 'product' || !('catalogCode' in entry.source)) return []
      const code = entry.source.catalogCode
      const at = { caseId: c.id, entryId: entry.id, code }
      const snapshot = products.get(code)
      if (!snapshot) return [{ ...at, problem: 'not-in-snapshot' }]
      return [
        ...(sameList(entry.ingredients, snapshot.ingredients) ? [] : [{ ...at, problem: 'ingredients-differ' as const }]),
        ...(skinConcerns === undefined || sameSet(entry.skinConcerns ?? [], skinConcerns.get(code) ?? []) ? [] : [{ ...at, problem: 'skin-concerns-differ' as const }]),
      ]
    }),
  )
