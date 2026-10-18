import { requireUser } from '../../lib/context'
import { NotFoundError } from '../../lib/errors'
import type { ProductCatalogService, ProductSummary } from '../catalog/catalog.service'
import type { NoLabelView, ScanService } from '../scans/scans.service'
import type { ShelfRepository } from './shelf.repository'
import type { ShelfEntryRow, ShelfRemovedReason } from './shelf.types'

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

/** What adding a product came to: it was already on the shelf (this is its entry), or a typed scan was started and the entry follows when its item is ready. */
export type ShelfAddResult = { status: 'exists'; entry: ShelfEntryView } | { status: 'started'; scanId: string; itemId: string }

export type ShelfServiceDeps = {
  repository: ShelfRepository
  /** Asked through its service, never through its repository. */
  catalog: Pick<ProductCatalogService, 'productSummaries'>
  scans: Pick<ScanService, 'noLabelViews' | 'createTyped'>
  now?: () => Date
}

/**
 * The products a profile uses. Rows are written by the scans module as items reach `ready` or `unidentified`; this service reads
 * them back as views and lets the user take one off the shelf.
 */
export class ShelfService {
  private readonly repository: ShelfRepository
  private readonly catalog: Pick<ProductCatalogService, 'productSummaries'>
  private readonly scans: Pick<ScanService, 'noLabelViews' | 'createTyped'>
  private readonly now: () => Date

  constructor(deps: ShelfServiceDeps) {
    this.repository = deps.repository
    this.catalog = deps.catalog
    this.scans = deps.scans
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

  /** Rows as views; see `list` for how a row that no longer resolves is treated. */
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
  async remove(entryId: string, reason?: ShelfRemovedReason): Promise<void> {
    const { profileId } = requireUser()
    const result = await this.repository.remove(profileId, entryId, reason ?? null, this.now())
    if (result === 'not-found') throw new NotFoundError('SHELF_ENTRY_NOT_FOUND', 'Shelf entry not found')
  }
}
