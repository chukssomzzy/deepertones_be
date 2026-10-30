import { requireUser } from '../../lib/context'
import { NotFoundError, ValidationError } from '../../lib/errors'
import type { ProductCatalogService, ProductSummary } from '../catalog/catalog.service'
import type { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import type { NoLabelView, ScanService } from '../scans/scans.service'
import type { ShelfRepository } from './shelf.repository'
import type { ShelfEntryRow, ShelfPublicRemovedReason, ShelfRemovedReason } from './shelf.types'

export type ShelfPolicy = {
  /** The most entries a read returns, the most recently scanned. */
  maxEntries: number
}

export const SHELF_POLICY: ShelfPolicy = { maxEntries: 200 }

/** One product on the shelf: a `product` entry carries `product`, a `no-label` entry carries `noLabel`. */
export type ShelfEntryView = {
  id: string
  addedAt: Date
  lastScannedAt: Date
  source: { scanId: string; itemId: string }
  kind: 'product' | 'no-label'
  product?: ProductSummary
  noLabel?: NoLabelView
}

export type ShelfView = { entries: ShelfEntryView[] }

/** A shelf entry as the shelf verdict reads it: ids only, so nothing here is resolved through the catalog or the scans. */
export type ShelfActiveEntry =
  | { id: string; kind: 'product'; addedAt: Date; productId: string; formulationId: string }
  | { id: string; kind: 'no-label'; addedAt: Date; itemId: string }

/** A removed shelf entry as the routines module reads it: its id and the reason it was removed with (null when none was given). */
export type ShelfRemovedEntry = { id: string; reason: ShelfRemovedReason | null }

/** What adding a product came to: it was already on the shelf (this is its entry), or a typed scan was started and the entry follows when its item is ready. */
export type ShelfAddResult = { status: 'exists'; entry: ShelfEntryView } | { status: 'started'; scanId: string; itemId: string }

export type ShelfServiceDeps = {
  repository: ShelfRepository
  /** Asked through its service, never through its repository. */
  catalog: Pick<ProductCatalogService, 'productSummaries' | 'namedProduct'>
  scans: Pick<ScanService, 'noLabelViews' | 'createTyped'>
  /** Where the swap records its wrong-match report: the verdicts' report repository, wired in the container so shelf does not import verdicts. */
  wrongMatches: { record(report: { id: string; profileId: string; entryId: string; oldProductId: string | null; newProductId: string }, now: Date): Promise<void> }
  opsAlerts: Pick<OpsAlertsService, 'raise'>
  now?: () => Date
}

/**
 * The products a profile uses. Rows are written by the scans module as items reach `ready` or `unidentified`; this service reads
 * them back as views and lets the user take one off the shelf.
 */
export class ShelfService {
  private readonly repository: ShelfRepository
  private readonly catalog: Pick<ProductCatalogService, 'productSummaries' | 'namedProduct'>
  private readonly scans: Pick<ScanService, 'noLabelViews' | 'createTyped'>
  private readonly wrongMatches: ShelfServiceDeps['wrongMatches']
  private readonly opsAlerts: Pick<OpsAlertsService, 'raise'>
  private readonly now: () => Date

  constructor(deps: ShelfServiceDeps) {
    this.repository = deps.repository
    this.catalog = deps.catalog
    this.scans = deps.scans
    this.wrongMatches = deps.wrongMatches
    this.opsAlerts = deps.opsAlerts
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * The caller's shelf, most recently scanned first. A product is read through its formulation and a no-label entry through its source
   * item, each in one batched read for the whole list. An entry whose product or answers no longer resolve is left out and logged by id
   * only, so one lost row does not fail the shelf.
   */
  async list(): Promise<ShelfView> {
    const { profileId } = requireUser()
    return { entries: await this.viewsOf(await this.repository.activeFor(profileId, SHELF_POLICY.maxEntries)) }
  }

  /**
   * One of the caller's entries, as `list` shows it (the same view path). 404 `SHELF_ENTRY_NOT_FOUND` for an id that is unknown, removed or another profile's, which are
   * not told apart, and for an entry whose product or answers no longer resolve (logged by id only), which `list` leaves out.
   */
  async entry(entryId: string): Promise<ShelfEntryView> {
    const { profileId } = requireUser()
    const [view] = await this.viewsOf(await this.repository.activeByIds(profileId, [entryId]))
    if (!view) throw new NotFoundError('SHELF_ENTRY_NOT_FOUND', 'Shelf entry not found')
    return view
  }

  /**
   * The views of these entries of the given profile, by entry id, built as `list` builds them, in one batched read of the products and one of the no-label answers
   * for the whole ask. By the profile id given with no session, since a verdict is read by jobs too, and not capped at SHELF_POLICY.maxEntries. An entry that is
   * removed, another profile's, unknown or unresolved is left out of the map (the unresolved logged by id only): the caller decides what that means.
   */
  async viewsFor(profileId: string, entryIds: string[]): Promise<Map<string, ShelfEntryView>> {
    const views = await this.viewsOf(await this.repository.activeByIds(profileId, entryIds))
    return new Map(views.map((view) => [view.id, view]))
  }

  /**
   * The profile's whole active shelf as narrow rows, oldest added first (entries added at the same time by id), so a fingerprint or a response built from them is the same
   * on every read. By the given profile with no session, since the verdict is built by a job. Not capped at SHELF_POLICY.maxEntries, which only bounds what `list` shows.
   * Entries are not resolved: one whose formulation or no-label item no longer resolves is still returned, and the caller (the verdict build) must handle the missing
   * facts. Only a product row with no formulation id at all is left out, since there is nothing to judge.
   */
  async activeEntriesFor(profileId: string): Promise<ShelfActiveEntry[]> {
    const rows = await this.repository.activeFor(profileId)
    rows.sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return rows.flatMap((row): ShelfActiveEntry[] => {
      if (row.kind === 'no-label') return [{ id: row.id, kind: 'no-label', addedAt: row.addedAt, itemId: row.itemId }]
      if (row.productId === null || row.formulationId === null) return []
      return [{ id: row.id, kind: 'product', addedAt: row.addedAt, productId: row.productId, formulationId: row.formulationId }]
    })
  }

  /**
   * The profile's removed entries as narrow rows, the earliest removal first, so the routines module can tell which step-downs go on after their product left the shelf.
   * By the given profile with no session (a build is a job), not capped, and not resolved: only the removal matters, not whether the product still resolves. The reason is the
   * one the entry was first removed with.
   */
  async removedEntriesFor(profileId: string): Promise<ShelfRemovedEntry[]> {
    return (await this.repository.removedFor(profileId)).map((row) => ({ id: row.id, reason: row.removedReason }))
  }

  /**
   * The catalog product of each of these removed entries of the given profile, by entry id, so a step-down for a removed product can be matched to the same product put back on
   * the shelf as a new entry. By the profile given with no session. An id that is not removed, another profile's, or a no-label entry (it has no product) is left out.
   */
  async removedProductIdsFor(profileId: string, entryIds: string[]): Promise<Map<string, string>> {
    const asked = new Set(entryIds)
    return new Map((await this.repository.removedFor(profileId)).flatMap((row): [string, string][] => (asked.has(row.id) && row.productId !== null ? [[row.id, row.productId]] : [])))
  }

  /**
   * Adds a named catalog product, picked from search, to the caller's shelf. One already on it is answered with its entry, as `list`
   * shows it, and nothing else happens: no scan, no allowance used, no model, no push. Otherwise a typed scan is started (see
   * `ScanService.createTyped`, which looks the product up first, so an unknown one is PRODUCT_NOT_FOUND, and takes the daily allowance
   * only when a model is needed) and its ids are returned: the entry appears on the shelf when the scan's item is ready. A product the
   * caller removed earlier is not "on the shelf": it goes through a scan, which puts it back as the same entry.
   *
   * A row whose product no longer resolves is not shown by `list` and so is not "on the shelf" here either: it falls through to a new typed
   * scan (harmless: the latest scan wins).
   *
   * The check and the scan are not one write, so two simultaneous adds can each start a scan; both end on the one entry (latest wins).
   */
  async add(productId: string, clientIp: string): Promise<ShelfAddResult> {
    const { profileId } = requireUser()
    const row = await this.repository.activeForProduct(profileId, productId)
    const [entry] = row ? await this.viewsOf([row]) : []
    if (entry) return { status: 'exists', entry }
    return { status: 'started', ...(await this.scans.createTyped({ productId, clientIp })) }
  }

  /**
   * "This isn't the right product": takes the caller's entry off the shelf as the wrong match and adds the product they name in its place. Checked in this order, and nothing is
   * removed by any of them: the entry is the caller's and active (404 `SHELF_ENTRY_NOT_FOUND`, which does not tell unknown, another profile's and already removed apart); the product is
   * not the entry's own (400 `VALIDATION_FAILED`: that is not a swap); the catalog offers it (404 `PRODUCT_NOT_FOUND`, asked here so a bad id never takes a product off the shelf).
   * Then the entry is removed with the reason `wrong-product`, which only this method writes; a wrong-match report is recorded; `wrong-match-report` is raised once it is written; and the product is added by
   * `add`, so its answer, its daily limit and its research charging are the search add's.
   *
   * The report is in the verdicts module's table and so not in the removal's batch: it is written after the removal and is best-effort, a failure logged by the ids only and the swap going
   * on (the shelf is the person's answer; the report is only for the team). An add that fails after the removal (429 daily limit, a provider error) leaves the removal and the report
   * standing and its error is the caller's: the wrong product stays off the shelf. An entry with no label (no product id) may be swapped; its report has no old product.
   */
  async replace(entryId: string, productId: string, clientIp: string): Promise<ShelfAddResult> {
    const { profileId } = requireUser()
    const [row] = await this.repository.activeByIds(profileId, [entryId])
    if (!row) throw new NotFoundError('SHELF_ENTRY_NOT_FOUND', 'Shelf entry not found')
    if (row.productId === productId) throw new ValidationError('VALIDATION_FAILED', 'That is already the product on this entry')
    await this.catalog.namedProduct(productId)

    const now = this.now()
    // One removed between the read and here is gone: told the same way, and neither reported nor swapped.
    if ((await this.repository.remove(profileId, entryId, 'wrong-product', now)) !== 'removed') throw new NotFoundError('SHELF_ENTRY_NOT_FOUND', 'Shelf entry not found')
    try {
      await this.wrongMatches.record({ id: crypto.randomUUID(), profileId, entryId, oldProductId: row.productId, newProductId: productId }, now)
      // Raised only for a report that was written: an alert that points at a row that is not there would send the team looking for nothing.
      await this.opsAlerts.raise('wrong-match-report')
    } catch {
      console.error({ outcome: 'wrong-match-report-failed', profileId, entryId, productId })
    }
    return this.add(productId, clientIp)
  }

  /** Rows as views, the one path `list`, `entry`, `add` and `viewsFor` share; see `list` for how a row that no longer resolves is treated. */
  private async viewsOf(rows: ShelfEntryRow[]): Promise<ShelfEntryView[]> {
    const formulationIds = rows.flatMap((row) => (row.kind === 'product' && row.formulationId !== null ? [row.formulationId] : []))
    const noLabelItemIds = rows.filter((row) => row.kind === 'no-label').map((row) => row.itemId)
    const [products, noLabels] = await Promise.all([this.catalog.productSummaries(formulationIds), this.scans.noLabelViews(noLabelItemIds)])

    const entries: ShelfEntryView[] = []
    for (const row of rows) {
      const base = { id: row.id, addedAt: row.addedAt, lastScannedAt: row.lastScannedAt, source: { scanId: row.scanId, itemId: row.itemId } }
      if (row.kind === 'product') {
        const product = row.formulationId === null ? undefined : products.get(row.formulationId)
        if (product) entries.push({ ...base, kind: 'product', product })
        else console.error({ outcome: 'shelf-entry-unresolved', entryId: row.id })
      } else {
        const noLabel = noLabels.get(row.itemId)
        if (noLabel) entries.push({ ...base, kind: 'no-label', noLabel })
        else console.error({ outcome: 'shelf-entry-unresolved', entryId: row.id })
      }
    }
    return entries
  }

  /** Takes the caller's entry off the shelf, with the reason if they gave one. Removing it again succeeds and changes nothing; another profile's entry is as unknown as one that never existed. */
  async remove(entryId: string, reason?: ShelfPublicRemovedReason): Promise<void> {
    const { profileId } = requireUser()
    const result = await this.repository.remove(profileId, entryId, reason ?? null, this.now())
    if (result === 'not-found') throw new NotFoundError('SHELF_ENTRY_NOT_FOUND', 'Shelf entry not found')
  }
}
