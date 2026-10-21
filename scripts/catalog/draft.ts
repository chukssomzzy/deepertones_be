// The drafting step of `npm run catalog:draft`, without the file and the network: a workbook in, the same workbook with the empty cells of its
// DRAFT products filled out, with the product researcher and the catalog drafter injected. It fills only EMPTY cells, never adds or removes a
// product, and marks every cell it filled in `draft_cells` with the page the value came from, so a reviewer knows what to check.
import { validateWorkbook, type RawRow, type RawWorkbook, type WorkbookProblem } from '../../src/modules/catalog/catalog.workbook.schema'
import { CATEGORIES, PRODUCT_FORMS } from '../../src/modules/catalog/catalog.vocabulary'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import type { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import { type CatalogDrafter, checkedDraft, DRAFT_COLUMNS, type DraftColumn, type DraftCountry, type DraftRequest, isUsableSource } from '../../src/providers/catalog-drafting/catalog-drafter.provider'
import type { ProductCategory, ProductForm, ProductIdentity, ProductResearcher } from '../../src/providers/product-research/product-researcher.provider'

export type DraftDeps = {
  researcher: ProductResearcher
  drafter: CatalogDrafter
  /** The ledger the clients spend on; the run reads what was spent from it. */
  ledger: MemoryAiSpendLedger
  /** Limit the countries drafted to these; every active country when left out. */
  countries?: string[]
}

/** A fixed reason, never a message: what Claude said about a product has no business in a report. */
export type FailureReason = 'researcher-error' | 'drafter-error'

export type DraftOutcome = {
  workbook: RawWorkbook
  /** What the contract still finds wrong with the drafted workbook, for a person to finish. */
  problems: WorkbookProblem[]
  /** Codes of draft rows whose brand, name, variant, form or category the contract would refuse, or that lack a brand, name or category: nothing was asked about them. */
  skipped: string[]
  /** Products a call failed for (other than the spend cap); they were left as far as they got and the run went on. */
  failed: { code: string; reason: FailureReason }[]
  /** Why the run ended before the last product: the spend cap, or a setup that is wrong (key, billing, permissions). Null when it did not. */
  stoppedBy: 'cap' | 'config' | null
  spentMicros: number
}

const isEmpty = (cell: unknown): boolean => cell === undefined || cell === null || (typeof cell === 'string' && cell.trim() === '')
const text = (cell: unknown): string => (typeof cell === 'string' ? cell.trim() : '')
const entriesOf = (cell: unknown): string[] =>
  typeof cell === 'string'
    ? cell
        .split(';')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
    : []

const activeCountries = (workbook: RawWorkbook): DraftCountry[] =>
  workbook.countries.rows
    .filter((row) => row.status === 'active' && typeof row.code === 'string' && typeof row.currency === 'string')
    .map((row) => ({ code: row.code as string, currency: row.currency as string }))

/** The errors that end the run, not just one product: the cap, and a key, billing or permission that is wrong (retrying every product cannot help). */
const stopOf = (error: unknown): 'cap' | 'config' | null =>
  error instanceof AiBudgetExceededError ? 'cap' : error instanceof AnthropicConfigError ? 'config' : null

/** The countries to draft: those named, or every active one. A name that is not an active country stops the run before anything is spent. */
const targetCountries = (workbook: RawWorkbook, named: string[] | undefined): DraftCountry[] => {
  const active = activeCountries(workbook)
  if (named === undefined) return active
  const refused = named.filter((code) => !active.some((country) => country.code === code))
  if (refused.length > 0) throw new Error(`Not an active country in the Countries tab: ${refused.join(', ')}`)
  return active.filter((country) => named.includes(country.code))
}

// The contract's cap on a brand, a name and a variant. A row over it, or with a form or category outside the vocabularies, would come back from
// the contract as a problem however well it was drafted, so no call is spent on it.
const MAX_IDENTITY_LENGTH = 120

const identityOf = (row: RawRow): ProductIdentity | undefined => {
  const brand = text(row.brand)
  const name = text(row.name)
  const category = text(row.category)
  const variant = text(row.variant)
  const form = text(row.form)
  if (brand === '' || name === '' || category === '') return undefined
  if ([brand, name, variant].some((part) => part.length > MAX_IDENTITY_LENGTH)) return undefined
  if (form !== '' && !(PRODUCT_FORMS as readonly string[]).includes(form)) return undefined
  if (!(CATEGORIES as readonly string[]).includes(category)) return undefined
  return { brand, name, ...(variant === '' ? {} : { variant }), ...(form === '' ? {} : { form: form as ProductForm }), category: category as ProductCategory }
}

/** Fills the empty cells of the draft products of `input`, and stops at the spend cap with what it has. `input` is not changed. */
export const draftWorkbook = async (input: RawWorkbook, { researcher, drafter, ledger, countries }: DraftDeps): Promise<DraftOutcome> => {
  const workbook = structuredClone(input)
  const wanted = targetCountries(workbook, countries)
  const skipped: string[] = []
  const failed: DraftOutcome['failed'] = []
  let stoppedBy: DraftOutcome['stoppedBy'] = null

  for (const row of workbook.products.rows) {
    if (row.status !== 'draft') continue
    const code = String(row.code)
    const product = identityOf(row)
    if (!product) {
      skipped.push(code)
      continue
    }
    const marks: string[] = []

    // A list with no source is a person's to finish, not ours to guess a page for: the researcher is asked only when both cells are empty.
    try {
      if (isEmpty(row.ingredients) && isEmpty(row.ingredients_source_url)) {
        const found = await researcher.research(product)
        // An item with ";" would be two items once the cell is read back.
        if (found.found && found.ingredients.length > 0 && !found.ingredients.some((item) => item.includes(';')) && isUsableSource(found.sourceUrl)) {
          row.ingredients = found.ingredients.join('; ')
          row.ingredients_source_url = found.sourceUrl
          marks.push(`ingredients=${found.sourceUrl}`, `ingredients_source_url=${found.sourceUrl}`)
        }
      }
    } catch (error) {
      stoppedBy = stopOf(error)
      if (stoppedBy === null) {
        failed.push({ code, reason: 'researcher-error' })
        continue
      }
    }

    if (stoppedBy === null) {
      const columns = DRAFT_COLUMNS.filter((column) => isEmpty(row[column]))
      const have = new Set(workbook.availability.rows.filter((r) => r.product_code === row.code).map((r) => r.country))
      const request: DraftRequest = { product, columns, countries: wanted.filter((country) => !have.has(country.code)) }
      if (request.columns.length > 0 || request.countries.length > 0) {
        try {
          // The adapter has checked its answer, but this is the workbook's door: nothing is written that the vocabularies or the https rule refuse.
          const drafted = checkedDraft(await drafter.draft(request), request)
          for (const column of request.columns) {
            const cell = drafted.cells[column as DraftColumn]
            if (!cell) continue
            row[column] = Array.isArray(cell.value) ? cell.value.join('; ') : cell.value
            marks.push(`${column}=${cell.sourceUrl}`)
          }
          for (const found of drafted.availability) {
            workbook.availability.rows.push({
              product_code: code,
              country: found.country,
              price_min: found.priceMin,
              price_max: found.priceMax,
              where_sold: found.whereSold ?? null,
              source_url: found.sourceUrl,
            })
          }
        } catch (error) {
          stoppedBy = stopOf(error)
          if (stoppedBy === null) failed.push({ code, reason: 'drafter-error' })
        }
      }
    }

    if (marks.length > 0) row.draft_cells = [...entriesOf(row.draft_cells), ...marks].join('; ')
    if (stoppedBy !== null) break
  }

  const checked = validateWorkbook(workbook)
  return { workbook, problems: checked.ok ? [] : checked.problems, skipped, failed, stoppedBy, spentMicros: ledger.spentMicros() }
}

const dollars = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`

/** What a person needs after a run: the spend, what was left undone and why, and every problem still in the file. Never a model's words. */
export const formatReport = (outcome: DraftOutcome): string => {
  const lines = [`Spent ${dollars(outcome.spentMicros)}.`]
  if (outcome.stoppedBy === 'cap') lines.push('Stopped at the spend cap: the products after this point are exactly as they were.')
  if (outcome.stoppedBy === 'config') lines.push('Stopped: Claude refused our key, billing or permissions. Fix the setup (ANTHROPIC_API_KEY and the account) and run again; the products after this point are exactly as they were.')
  if (outcome.failed.length > 0) lines.push(`Failed, left as far as they got (${outcome.failed.length}):`, ...outcome.failed.map((f) => `  ${f.code}: ${f.reason}`))
  if (outcome.skipped.length > 0) lines.push(`Skipped, with a brand, name, variant, form or category the contract would refuse (${outcome.skipped.length}): ${outcome.skipped.join(', ')}`)
  if (outcome.problems.length === 0) lines.push('No problems: the contract accepts the workbook.')
  else lines.push(`Problems still in the workbook (${outcome.problems.length}):`, ...outcome.problems.map((p) => `  ${p.tab} row ${p.row} ${p.column}: ${p.rule}`))
  return lines.join('\n')
}

/** What a workbook file remembers about where it was exported from: carried to the draft unchanged, so the upload can check it. */
type FileStamp = { environment: string | null; contractVersion: string | null }

export type DraftIo = {
  readWorkbook: (path: string) => Promise<{ workbook: RawWorkbook; catalogVersion: number | null } & FileStamp>
  writeWorkbook: (path: string, workbook: RawWorkbook, catalogVersion: number | null, stamp: { environment?: string; contractVersion?: string }) => Promise<void>
}

/** Reads `input`, drafts it, and writes the result to `out`, even when a stop or problems remain: the file is what the person finishes. */
export const runDraft = async (args: { input: string; out: string; countries?: string[] }, deps: Omit<DraftDeps, 'countries'> & { io: DraftIo }): Promise<DraftOutcome> => {
  const { workbook, catalogVersion, environment, contractVersion } = await deps.io.readWorkbook(args.input)
  const outcome = await draftWorkbook(workbook, { researcher: deps.researcher, drafter: deps.drafter, ledger: deps.ledger, countries: args.countries })
  // A stamp the input lacked is left out, not made up: the upload refuses such a file, and a draft must not look more trustworthy than its source.
  await deps.io.writeWorkbook(args.out, outcome.workbook, catalogVersion, {
    ...(environment === null ? {} : { environment }),
    ...(contractVersion === null ? {} : { contractVersion }),
  })
  return outcome
}
