import { ConflictError, UnavailableError, ValidationError } from '../../lib/errors'
import { MAX_WORKBOOK_BYTES, type WorkbookArchive } from '../../providers/workbook-archive/workbook-archive.provider'
import { brandKey, identityKey, normaliseText } from './catalog.identity'
import type { ShownConcern } from '../face-scans/face-scans.tables'
import type { Goal } from '../goals/goals.vocabulary'
import { ingredientsKey } from './catalog.ingredients'
import type { ReferenceEntry } from './catalog.reference'
import type { NewProduct } from './catalog.types'
import { WEEK_BANDS, type EscalationReason, type IngredientGroup, type ResponseOutcome, type RoutineStep, type TaperKind, type WeekBand } from './catalog.vocabulary'
import { diffWorkbooks, type TabDiff, type WorkbookDiff } from './catalog.workbook.diff'
import { toRawWorkbook } from './catalog.workbook.raw'
import type { CatalogWorkbookRepository, Country, LiveRules, PlannedProduct, Recommendation, RecommendedByCode, WorkbookChanges } from './catalog.workbook.repository'
import { nextRulesVersion } from './catalog.workbook.rules-version'
import { CONTRACT_VERSION, REINTRO_NEVER_BACK, guideKey, reintroductionKey, validateWorkbook, weekKey, type GuideRow, type IngredientRule, type ProductRow, type RawWorkbook, type ScheduleStep, type TaperRow, type Workbook, type WorkbookProblem } from './catalog.workbook.schema'
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

/** An approved rule as the shelf verdict reads it: what the matcher reads, and the metadata only the floor and the fit judge use. */
export type VerdictRule = ReferenceEntry & { group: IngredientGroup | null; clashesWith: IngredientGroup[]; helps: IngredientRule['helps'] }

/**
 * What the shelf verdict is built against, from one read: the rules version and catalog version that read was at, the approved rules in code order, the approved
 * claim phrases in code order, and for each kind of step-down the code of the approved template to use (a kind with none is absent).
 */
export type VerdictReference = {
  rulesVersion: string
  catalogVersion: number
  rules: VerdictRule[]
  claimPhrases: string[]
  tapers: Partial<Record<TaperKind, string>>
}

/**
 * The rules as the shelf verdict reads them, in code order, whatever their status: which rules count is the caller's choice (the service passes the approved
 * ones, the verdict eval its own set). Pure and exported so the eval maps through the same lines as the service. The lists are copies.
 */
export const verdictRulesOf = (rules: readonly IngredientRule[]): VerdictRule[] =>
  [...rules]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((rule) => ({
      name: rule.name,
      aliases: [...rule.aliases],
      kind: rule.kind,
      rule: rule.statement,
      source: rule.sourceUrl,
      group: rule.group,
      clashesWith: [...rule.clashesWith],
      helps: [...rule.helps],
    }))

/**
 * For each kind, the code of its approved template that was approved most recently, the lower code when two were approved on the same day; a kind with none is
 * absent. Pure and exported so the verdict eval picks its step-down templates the way the service does.
 */
export const approvedTapersOf = (tapers: readonly TaperRow[]): Partial<Record<TaperKind, string>> => {
  const chosen = new Map<TaperKind, TaperRow>()
  for (const taper of tapers) {
    if (taper.status !== 'approved') continue
    const held = chosen.get(taper.kind)
    const day = taper.approvedOn?.getTime() ?? 0
    const heldDay = held?.approvedOn?.getTime() ?? 0
    if (!held || day > heldDay || (day === heldDay && taper.code < held.code)) chosen.set(taper.kind, taper)
  }
  return Object.fromEntries([...chosen].map(([kind, taper]) => [kind, taper.code]))
}

/** A routine guide as a screen reads it: the four texts and nothing else (a guide's status and sign-off never leave the service). */
export type Guide = { whatItDoes: string; lookFor: string; forDeeperSkin: string; lookForWhenPregnant: string | null }

const guideOf = (row: GuideRow): Guide => ({ whatItDoes: row.whatItDoes, lookFor: row.lookFor, forDeeperSkin: row.forDeeperSkin, lookForWhenPregnant: row.lookForWhenPregnant })

/** An escalation as a screen reads it: the three texts and nothing else. */
export type Escalation = { whoToSee: string; howSoon: string; whatToTellThem: string }

/** A response as a screen reads it. The texts may hold `{step}`, which the caller fills with the step's plain noun. */
export type Response = { title: string; body: string; whatToDoNow: string | null }

/** A week card as a screen reads it: a short heading and the text. The server prints "Week {n}" itself. */
export type WeekCard = { title: string; text: string }

/** The band of week cards a week falls in: week 13 and later use the last band. */
const bandOfWeek = (week: number): WeekBand => (week <= 1 ? '1' : week === 2 ? '2' : week <= 4 ? '3-4' : week <= 8 ? '5-8' : WEEK_BANDS[WEEK_BANDS.length - 1]!)

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
 * The catalog workbook: what the Products, Availability, Ingredients, Countries, Claim words, Tapers, Guides, Reintroductions, Escalations, Responses and Weeks tabs hold, served as an export, changed by an import, and read
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
      throw new ValidationError('CATALOG_INVALID', 'A step-down template, guide, ladder, escalation, response or week card is approved by someone who may not approve it', { problems: unqualified })
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
   * The rules, claim phrases and step-down templates a shelf verdict is judged by, with the versions it was judged at. One repository read, so the two versions and
   * the rows belong together: two reads could straddle an upload and pair the new rules version with the old catalog version. A job reads this, so there is no actor.
   */
  async verdictReference(): Promise<VerdictReference> {
    const { catalogVersion, rulesVersion, rules, claimWords, tapers } = await this.repository.readVerdictReference()
    return {
      rulesVersion,
      catalogVersion,
      rules: verdictRulesOf(rules.filter((rule) => rule.status === 'approved')),
      claimPhrases: claimWords.filter((word) => word.status === 'approved').map((word) => word.phrase),
      tapers: approvedTapersOf(tapers),
    }
  }

  /** The step-down templates with these codes, retired ones included: a saved verdict still shows the template it was built with. */
  async tapersByCode(codes: string[]): Promise<Map<string, TaperRow>> {
    return new Map((await this.repository.tapersByCode(codes)).map((taper) => [taper.code, taper]))
  }

  /**
   * The guide for a step and a goal: the approved row for that step and goal as it is, else the step's approved row with no goal, else null (the team has not
   * written one yet). A goal's row is given whole: nothing is borrowed from the base row, so a goal row with no pregnancy text has none.
   */
  async guideFor(step: RoutineStep, goal: Goal): Promise<Guide | null> {
    const approved = await this.repository.approvedGuides(step)
    const row = approved.find((candidate) => candidate.goal === goal) ?? approved.find((candidate) => candidate.goal === null)
    return row === undefined ? null : guideOf(row)
  }

  /**
   * The steps a person is brought back on: the approved ladder of the group, else the approved default ladder, else no steps (the team has not written one yet).
   * A ladder is given whole: nothing is borrowed from the default. A group that is never brought back (mercury, steroid, lightening-agent) has no steps, and
   * does not get the default ladder either.
   */
  async reintroductionFor(group: IngredientGroup | null): Promise<ScheduleStep[]> {
    if (group !== null && REINTRO_NEVER_BACK.includes(group)) return []
    const approved = await this.repository.approvedReintroductions()
    const row = (group === null ? undefined : approved.find((candidate) => candidate.group === group)) ?? approved.find((candidate) => candidate.group === null)
    return row === undefined ? [] : row.schedule
  }

  /** The approved escalation of the reason, or null (the team has not written one yet). */
  async escalationFor(reason: EscalationReason): Promise<Escalation | null> {
    const row = await this.repository.approvedEscalation(reason)
    return row === null ? null : { whoToSee: row.whoToSee, howSoon: row.howSoon, whatToTellThem: row.whatToTellThem }
  }

  /** The approved response of the outcome, `{step}` left as it is written, or null (the team has not written one yet). */
  async responseFor(outcome: ResponseOutcome): Promise<Response | null> {
    const row = await this.repository.approvedResponse(outcome)
    return row === null ? null : { title: row.title, body: row.body, whatToDoNow: row.whatToDoNow }
  }

  /**
   * The week card for a week, a goal and whether the person is stepping down a product: the first approved card of the week's band that exists for the goal on a
   * step-down, then for no goal on a step-down, then for the goal, then for no goal; null when the team has written none.
   */
  async weekCardFor(week: number, goal: Goal, stepDown: boolean): Promise<WeekCard | null> {
    const approved = await this.repository.approvedWeeks(bandOfWeek(week))
    const wanted: [Goal | null, boolean][] = [[goal, stepDown], [null, stepDown], [goal, false], [null, false]]
    for (const [wantedGoal, wantedStepDown] of wanted) {
      const row = approved.find((candidate) => candidate.goal === wantedGoal && candidate.stepDown === wantedStepDown)
      if (row !== undefined) return { title: row.title, text: row.text }
    }
    return null
  }

  /**
   * The recommended rows with these codes, whatever their status and in whatever country they are sold, by code: a saved routine shows its product by code even
   * when it has since been retired or is not sold where the person is now (the screen compares `availability` to their country). A code that names no row is absent.
   */
  async recommendedByCode(codes: string[]): Promise<Map<string, RecommendedByCode>> {
    return new Map((await this.repository.recommendedByCode(codes)).map((row) => [row.code, row]))
  }

  /** The routine steps each of these catalog products fills, for those an approved recommended row names. */
  stepsFor(productIds: string[]): Promise<Map<string, RoutineStep[]>> {
    return this.repository.stepsOf(productIds)
  }

  /** The skin concerns each of these catalog products is for, in the vocabulary order, for those an approved recommended row names. */
  skinConcernsFor(productIds: string[]): Promise<Map<string, ShownConcern[]>> {
    return this.repository.skinConcernsOf(productIds)
  }

  /**
   * In production only, the approved rows of the tabs people are shown (Tapers, Guides, Reintroductions, Escalations, Responses, Weeks) whose approver is not on
   * the list: they have to have been approved by a qualified person. The approver is a label in a cell, so this is a process control and not authentication. The
   * problem never holds the name.
   */
  private unqualifiedApprovals(workbook: Workbook): WorkbookProblem[] {
    if (this.environment !== 'production') return []
    const unqualified = (tab: 'tapers' | 'guides' | 'reintroductions' | 'escalations' | 'responses' | 'weeks', rows: readonly { status: string; approvedBy: string | null }[]) =>
      rows.flatMap((row, i): WorkbookProblem[] =>
        row.status === 'approved' && !this.qualifiedApprovers.has(row.approvedBy ?? '') ? [{ tab, row: i + 2, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' }] : [],
      )
    return [
      ...unqualified('tapers', workbook.tapers),
      ...unqualified('guides', workbook.guides),
      ...unqualified('reintroductions', workbook.reintroductions),
      ...unqualified('escalations', workbook.escalations),
      ...unqualified('responses', workbook.responses),
      ...unqualified('weeks', workbook.weeks),
    ]
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
    const guideKeys = written(changes.guides)
    const keptGuides = new Set(next.guides.map(guideKey))
    const ladderKeys = written(changes.reintroductions)
    const keptLadders = new Set(next.reintroductions.map(reintroductionKey))
    const reasons = written(changes.escalations)
    const keptReasons = new Set(next.escalations.map((escalation) => escalation.reason))
    const outcomes = written(changes.responses)
    const keptOutcomes = new Set(next.responses.map((response) => response.outcome))
    const cardKeys = written(changes.weeks)
    const keptCards = new Set(next.weeks.map(weekKey))
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
        guides: next.guides.filter((guide) => guideKeys.has(guideKey(guide))),
        // A guide has no code, so the key the diff names it by is split back into its step and goal.
        retiredGuides: changes.guides.retired
          .filter((key) => !keptGuides.has(key))
          .map((key) => {
            const [step, goal = null] = key.split(':')
            return { step: step as RoutineStep, goal: goal as Goal | null }
          }),
        reintroductions: next.reintroductions.filter((ladder) => ladderKeys.has(reintroductionKey(ladder))),
        // The diff names the ladder with no group `default`, which no group is called.
        retiredReintroductions: changes.reintroductions.retired.filter((key) => !keptLadders.has(key)).map((key) => ({ group: key === 'default' ? null : (key as IngredientGroup) })),
        escalations: next.escalations.filter((escalation) => reasons.has(escalation.reason)),
        retiredEscalations: changes.escalations.retired.filter((key) => !keptReasons.has(key as EscalationReason)).map((key) => ({ reason: key as EscalationReason })),
        responses: next.responses.filter((response) => outcomes.has(response.outcome)),
        retiredResponses: changes.responses.retired.filter((key) => !keptOutcomes.has(key as ResponseOutcome)).map((key) => ({ outcome: key as ResponseOutcome })),
        weeks: next.weeks.filter((card) => cardKeys.has(weekKey(card))),
        // A week card has no code, so the key the diff names it by is split back into its band, goal and step-down.
        retiredWeeks: changes.weeks.retired
          .filter((key) => !keptCards.has(key))
          .map((key) => {
            const stepDown = key.endsWith(':step-down')
            const [band, goal = null] = (stepDown ? key.slice(0, -':step-down'.length) : key).split(':')
            return { band: band as WeekBand, goal: goal as Goal | null, stepDown }
          }),
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
      guides: of(changes.guides),
      reintroductions: of(changes.reintroductions),
      escalations: of(changes.escalations),
      responses: of(changes.responses),
      weeks: of(changes.weeks),
    }
  }
}
