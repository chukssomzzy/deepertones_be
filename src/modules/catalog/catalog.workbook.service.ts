import { ConflictError, UnavailableError, ValidationError } from '../../lib/errors'
import { MAX_WORKBOOK_BYTES, type WorkbookArchive } from '../../providers/workbook-archive/workbook-archive.provider'
import { brandKey, identityKey, normaliseText } from './catalog.identity'
import { ingredientsKey } from './catalog.ingredients'
import type { ReferenceEntry } from './catalog.reference'
import type { NewProduct } from './catalog.types'
import type { RoutineStep } from './catalog.vocabulary'
import { diffWorkbooks, type TabDiff, type WorkbookDiff } from './catalog.workbook.diff'
import { toRawWorkbook } from './catalog.workbook.raw'
import type { CatalogWorkbookRepository, Country, LiveRules, PlannedProduct, Recommendation, WorkbookChanges } from './catalog.workbook.repository'
import { nextRulesVersion } from './catalog.workbook.rules-version'
import { CONTRACT_VERSION, validateWorkbook, type IngredientRule, type ProductRow, type RawWorkbook, type Workbook, type WorkbookProblem } from './catalog.workbook.schema'
import { RawWorkbookSchema } from './catalog.workbook.schemas'

/** A product row that no product of the catalog has the identity of (by identity key or alias): the upload would make it. */
export type NewProductSummary = { code: string; brand: string; name: string; variant: string | null; form: string | null }

/**
 * Ingredient rules as the matcher reads them (`ReferenceEntry`), in code order. Pure and exported so the routine eval maps its snapshot's rules through the
 * same lines as the service, which passes it only the approved ones.
 */
export const referenceEntriesOf = (rules: readonly Pick<IngredientRule, 'code' | 'name' | 'aliases' | 'kind' | 'statement' | 'sourceUrl'>[]): ReferenceEntry[] =>
  [...rules]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((rule) => ({ name: rule.name, aliases: rule.aliases, kind: rule.kind, rule: rule.statement, source: rule.sourceUrl }))

export type ImportDiff = WorkbookDiff & { newProducts: NewProductSummary[] }

/** The workbook is whatever JSON object was uploaded: its shape is checked by the import, after the contract version. */
export type ImportInput = { workbook: unknown; file: Uint8Array | null; baseVersion: number; dryRun: boolean; uploadedBy: string; contractVersion: string }
export type ImportResult = { applied: boolean; catalogVersion: number; diff: ImportDiff }
export type ExportResult = { catalogVersion: number; contractVersion: string; workbook: RawWorkbook }

type Deps = {
  repository: CatalogWorkbookRepository
  archive: WorkbookArchive
  now: () => Date
  newId: () => string
  /** Which environment this is. Required, so that a wiring that forgets it fails to compile instead of skipping the approver check. */
  environment: string
  /** The labels of the people who may approve a step-down template in production, separated by commas. Left out or empty, nobody may. */
  qualifiedApprovers?: string
}

/**
 * The catalog workbook: what the Products, Availability, Ingredients, Countries, Claim words and Tapers tabs hold, served as an export, changed by an import, and read
 * by the modules that need the live rules, the countries or the approved products. No actor is needed: the admin routes are guarded by a token
 * before this is called, and a user never reaches it. Nothing here asks a model or a web page anything: a row's product is found by exact
 * identity key or alias, else made.
 */
export class CatalogWorkbookService {
  // Cloudflare documents 1,000 queries per Worker invocation on the paid plan, and does not say whether the statements of a batch count one by one, so
  // the batch is held under it with room for the reads of the request. See "Catalog workbook import" in docs/architecture.md.
  private static readonly MAX_BATCH_STATEMENTS = 900
  /** The first bytes of every zip, so of every .xlsx: `PK\x03\x04`. */
  private static readonly ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

  private readonly repository: CatalogWorkbookRepository
  private readonly archive: WorkbookArchive
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly environment: string
  private readonly qualifiedApprovers: ReadonlySet<string>

  constructor(deps: Deps) {
    this.repository = deps.repository
    this.archive = deps.archive
    this.now = deps.now
    this.newId = deps.newId
    this.environment = deps.environment
    this.qualifiedApprovers = new Set((deps.qualifiedApprovers ?? '').split(',').map((label) => label.trim()).filter((label) => label !== ''))
  }

  /** Every row of every tab as the import takes it back, retired rows included, with the version they are at. */
  async exportWorkbook(): Promise<ExportResult> {
    const { catalogVersion, workbook } = await this.repository.readWorkbook()
    return { catalogVersion, contractVersion: CONTRACT_VERSION, workbook: toRawWorkbook(workbook) }
  }

  /**
   * Refuses a file made for another contract version, then checks the workbook has the tabs and cells the contract is written in (400
   * `VALIDATION_FAILED`) and follows the contract, refuses it if it was made from a catalog version that is not live, and works out what it would change. A
   * dry run stops there and writes nothing. An apply needs the original file: it is archived first, under a key of its own, and then the whole
   * change is one atomic write, which loses cleanly to a concurrent upload from the same version.
   */
  async importWorkbook(input: ImportInput): Promise<ImportResult> {
    // First of all: a file made for another contract cannot be judged by this one, so its problems would only mislead.
    if (input.contractVersion !== CONTRACT_VERSION) {
      console.info({ outcome: 'catalog-import-contract-mismatch' })
      throw new ConflictError('CONTRACT_MISMATCH', `The workbook was made for a different contract version than this server's (${CONTRACT_VERSION}); export it again and redo the edit`)
    }
    const shape = RawWorkbookSchema.safeParse(input.workbook)
    if (!shape.success) {
      console.info({ outcome: 'catalog-import-bad-shape' })
      throw new ValidationError(
        'VALIDATION_FAILED',
        'Invalid workbook',
        shape.error.issues.map((issue) => ({ path: ['workbook', ...issue.path].map(String).join('.'), message: issue.message })),
      )
    }
    const checked = validateWorkbook(shape.data)
    if (!checked.ok) {
      console.info({ outcome: 'catalog-import-invalid', problems: checked.problems.length })
      throw new ValidationError('CATALOG_INVALID', 'The workbook does not follow the contract', { problems: checked.problems })
    }
    const next = checked.workbook
    const unqualified = this.unqualifiedApprovals(next)
    if (unqualified.length > 0) {
      console.info({ outcome: 'catalog-import-unqualified-approver', problems: unqualified.length })
      throw new ValidationError('CATALOG_INVALID', 'A step-down template is approved by someone who may not approve it', { problems: unqualified })
    }
    const live = await this.repository.readWorkbook()
    if (input.baseVersion !== live.catalogVersion) {
      console.info({ outcome: 'catalog-import-stale', catalogVersion: live.catalogVersion })
      throw this.stale()
    }

    const changes = diffWorkbooks(live.workbook, next)
    const { plan, newProducts } = await this.plan(next, changes)
    const full = {
      ...plan,
      baseVersion: live.catalogVersion,
      rulesVersion: await nextRulesVersion(await this.repository.liveRules(), CatalogWorkbookService.approvedRules(next)),
      contractVersion: CONTRACT_VERSION,
      uploadedBy: input.uploadedBy,
      archiveKey: '',
      now: this.now(),
    }
    // Refused before anything is archived, and for a dry run too, so the size is told before anyone tries to apply it. The batch is never split: a split could not be atomic.
    if (this.repository.statementCount(full) > CatalogWorkbookService.MAX_BATCH_STATEMENTS) {
      console.info({ outcome: 'catalog-import-too-large', catalogVersion: live.catalogVersion, counts: CatalogWorkbookService.counts(changes) })
      throw new ValidationError('CATALOG_TOO_LARGE', 'This upload changes too many rows to apply at once; split the change into smaller uploads, each from the new version')
    }
    const diff: ImportDiff = { ...changes, newProducts }
    if (input.dryRun) {
      console.info({ outcome: 'catalog-import-dry-run', catalogVersion: live.catalogVersion, counts: CatalogWorkbookService.counts(changes) })
      return { applied: false, catalogVersion: live.catalogVersion, diff }
    }

    const file = input.file
    if (!file || file.byteLength === 0) throw new ValidationError('CATALOG_FILE_REQUIRED', 'Applying an upload needs the .xlsx file it was made from')
    if (file.byteLength > MAX_WORKBOOK_BYTES) throw new ValidationError('CATALOG_FILE_TOO_LARGE', `The .xlsx file is over ${MAX_WORKBOOK_BYTES} bytes`)
    // An .xlsx is a zip. The server never opens it, so this is the one check that what is archived is not some other file.
    if (!CatalogWorkbookService.ZIP_MAGIC.every((byte, i) => file[i] === byte)) throw new ValidationError('CATALOG_FILE_NOT_XLSX', 'The file is not an .xlsx (it is not a zip)')
    const version = live.catalogVersion + 1
    let archiveKey: string
    try {
      archiveKey = await this.archive.put(version, file)
    } catch {
      console.error({ outcome: 'catalog-archive-failed', catalogVersion: version })
      throw new UnavailableError('CATALOG_ARCHIVE_FAILED', 'The file could not be archived, so nothing was applied; try again')
    }

    const stored = await this.repository.applyWorkbook({ ...full, archiveKey })
    if (!stored) {
      console.info({ outcome: 'catalog-import-lost-race', catalogVersion: version })
      throw this.stale()
    }
    console.info({ outcome: 'catalog-import-applied', catalogVersion: version, counts: CatalogWorkbookService.counts(changes) })
    return { applied: true, catalogVersion: version, diff }
  }

  countries(): Promise<Country[]> {
    return this.repository.countries()
  }

  /** The approved rows sold in the country that are used for the step, each pinned to the formulation the workbook reviewed. */
  approvedFor(query: { country: string; step: RoutineStep }): Promise<Recommendation[]> {
    return this.repository.approvedFor(query)
  }

  liveRules(): Promise<LiveRules> {
    return this.repository.liveRules()
  }

  /**
   * In production only, the approved Tapers rows whose approver is not on the list: a template is shown to people, so a qualified person has to
   * have approved it. The approver is a label in a cell, so this is a process control and not authentication. The problem never holds the name.
   */
  private unqualifiedApprovals(workbook: Workbook): WorkbookProblem[] {
    if (this.environment !== 'production') return []
    return workbook.tapers.flatMap((taper, i): WorkbookProblem[] =>
      taper.status === 'approved' && !this.qualifiedApprovers.has(taper.approvedBy ?? '') ? [{ tab: 'tapers', row: i + 2, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' }] : [],
    )
  }

  private stale(): ConflictError {
    return new ConflictError('CATALOG_STALE', 'The catalog has changed since this workbook was exported; export it again and redo the edit')
  }

  /**
   * What to write for the change, and the product rows that would be new. Only rows the diff names are written, so an upload that changes one
   * product writes one product. Each written Products row joins the catalog by its exact identity key, then by alias, else it is a new product.
   */
  private async plan(next: Workbook, changes: WorkbookDiff): Promise<{ plan: WorkbookChanges; newProducts: NewProductSummary[] }> {
    const written = (tab: TabDiff) => new Set([...tab.added, ...tab.updated, ...tab.reactivated, ...tab.retired])
    // A code the upload leaves out is retired in place; one it carries as retired is written with its cells.
    const gone = (tab: TabDiff, rows: { code: string }[]) => {
      const kept = new Set(rows.map((row) => row.code))
      return tab.retired.filter((code) => !kept.has(code))
    }

    const productCodes = written(changes.products)
    const rows = next.products.filter((row) => productCodes.has(row.code))
    const keys = rows.map((row) => identityKey(row))
    const matched = await this.repository.matchProducts(keys)
    const created = new Map<string, NewProduct>()
    const products: PlannedProduct[] = rows.map((row, i) => {
      const key = keys[i]!
      const existing = matched.get(key)
      if (existing === undefined && !created.has(key)) created.set(key, this.newProduct(row, key))
      return {
        row,
        productKey: existing ?? key,
        formulation: row.ingredients.length === 0 ? null : { id: this.newId(), ingredientsKey: ingredientsKey(row.ingredients) },
      }
    })
    const newProducts = rows.filter((row, i) => !matched.has(keys[i]!)).map((row): NewProductSummary => ({ code: row.code, brand: row.brand, name: row.name, variant: row.variant, form: row.form }))

    const ruleCodes = written(changes.ingredients)
    const countryCodes = written(changes.countries)
    const claimCodes = written(changes.claimWords)
    const taperCodes = written(changes.tapers)
    const availabilityChanged = Object.values(changes.availability).some((codes) => codes.length > 0)
    return {
      plan: {
        newProducts: [...created.values()],
        products,
        availability: availabilityChanged ? next.availability : null,
        ingredients: next.ingredients.filter((rule) => ruleCodes.has(rule.code)),
        countries: next.countries.filter((country) => countryCodes.has(country.code)),
        retiredProducts: gone(changes.products, next.products),
        retiredIngredients: gone(changes.ingredients, next.ingredients),
        retiredCountries: gone(changes.countries, next.countries),
        claimWords: next.claimWords.filter((word) => claimCodes.has(word.code)),
        tapers: next.tapers.filter((taper) => taperCodes.has(taper.code)),
        retiredClaimWords: gone(changes.claimWords, next.claimWords),
        retiredTapers: gone(changes.tapers, next.tapers),
      },
      newProducts,
    }
  }

  private newProduct(row: ProductRow, key: string): NewProduct {
    return {
      id: this.newId(),
      identityKey: key,
      brandKey: brandKey(row.brand),
      kind: 'named',
      brand: row.brand,
      name: row.name,
      variant: row.variant,
      form: row.form,
      category: row.category,
      // As a scan names a product, so a search finds it the same way.
      searchText: normaliseText(`${row.brand} ${row.name} ${row.variant ?? ''}`),
      createdAt: this.now(),
    }
  }

  /** The approved rules an upload leaves in force, in code order, as the matcher reads them: the set the rules version names. */
  private static approvedRules(workbook: Workbook): ReferenceEntry[] {
    return referenceEntriesOf(workbook.ingredients.filter((rule) => rule.status === 'approved'))
  }

  private static counts(changes: WorkbookDiff): Record<keyof WorkbookDiff, Record<keyof TabDiff, number>> {
    const of = (tab: TabDiff) => ({ added: tab.added.length, updated: tab.updated.length, retired: tab.retired.length, reactivated: tab.reactivated.length })
    return {
      products: of(changes.products),
      availability: of(changes.availability),
      ingredients: of(changes.ingredients),
      countries: of(changes.countries),
      claimWords: of(changes.claimWords),
      tapers: of(changes.tapers),
    }
  }
}
