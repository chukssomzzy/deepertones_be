import { PermanentJobError } from '../../jobs/job'
import { requireUser } from '../../lib/context'
import { hmacSha256Hex } from '../../lib/crypto'
import { ConflictError, NotFoundError, RateLimitedError, UnavailableError, ValidationError } from '../../lib/errors'
import { readImageHeader } from '../../lib/image-header'
import { PHOTO_LINK_TTL_SECONDS, signPhotoLink, verifyPhotoLink } from '../../lib/photo-link'
import { describeUnexpectedError } from '../../lib/safe-error'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { AnthropicConfigError, AnthropicRefusalError, AnthropicRequestError, AnthropicUnavailableError } from '../../providers/anthropic/anthropic.provider'
import type { LabelReader, LabelReading } from '../../providers/label-reading/label-reader.provider'
import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import type { NameSplit, NameSplitter } from '../../providers/name-splitting/name-splitter.provider'
import type { PhotoEnvironment, PhotoStore } from '../../providers/photo-store/photo-store.provider'
import type { DraftConcern, ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import type { ProductRecognizer, Recognition, ShelfProduct, ShelfRecognition } from '../../providers/product-recognition/product-recognizer.provider'
import type { ProductCategory, ProductForm } from '../../providers/product-research/product-researcher.provider'
import type { ScanEvents } from '../../providers/scan-events/scan-events.provider'
import { AnalysisInProgressError, CatalogBusyError, type ProductCatalogService, type ProductSummary, ResearchInProgressError, type ResolveResult } from '../catalog/catalog.service'
import { CAUTION_RULES_VERSION, cautionFor } from './scans.cautions'
import type { NotificationsService } from '../notifications/notifications.service'
import type { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import { advanceScanItemSpec, type ScanStep } from './scans.job-specs'
import { productPhotoUrl } from './scans.paths'
import type { ScansRepository } from './scans.repository'
import { PHOTO_HELD_STATES } from './scans.types'
import type { ItemPatch, ItemReason, ItemState, NewBackPhoto, NewRetake, NewScanItem, NewScanPhoto, NewSibling, Scan, ScanItem, ScanKind, ScanPhoto } from './scans.types'
import type { NoLabelPurpose, NoLabelSource, NoLabelUsedFor } from './scans.vocabulary'

export type ScanPolicy = {
  maxPhotosPerScan: number
  maxPhotoBytes: number
  /** The longest side, in pixels, of a photo we accept. */
  maxPhotoEdge: number
  dailyPhotosPerUser: number
  dailyPhotosPerIp: number
  /** A front photo that cannot be read is retaken until the item has had this many; the last one sends it to `needs-identification` instead of asking again. */
  maxFrontPhotos: number
  /** An item that has had this many back photos, and still has no readable label, fails as `label-unreadable` instead of asking again. */
  maxBackPhotos: number
  /** A read below this confidence waits for the user to confirm it. */
  confirmBelowConfidence: number
  /**
   * The reaper repairs a lost `done` only for scans created within this long. A repair matters to a client that is connected,
   * a connection lasts 10 minutes at most, and `watch` sends `done` to any client that connects later, so an older scan gains
   * nothing and would only make every sweep read more.
   */
  doneRepairWindowMs: number
  /** A shelf scan holds at most this many photos, each read for up to 5 products. */
  maxShelfPhotos: number
  /** A scan holds at most this many items, whatever it was made of. */
  maxItemsPerScan: number
}

export const SCAN_POLICY: ScanPolicy = {
  maxPhotosPerScan: 10,
  maxPhotoBytes: 2_000_000,
  maxPhotoEdge: 1600,
  dailyPhotosPerUser: 30,
  dailyPhotosPerIp: 100,
  maxFrontPhotos: 3,
  maxBackPhotos: 3,
  confirmBelowConfidence: 0.6,
  doneRepairWindowMs: 3 * 60 * 60 * 1000,
  maxShelfPhotos: 3,
  maxItemsPerScan: 20,
}

/** What the app shows for one item. Built by the service so a presenter, the stream and the events all say the same thing. */
export type NoLabelView = { source: NoLabelSource; purpose: NoLabelPurpose; usedFor: NoLabelUsedFor; description?: string; concerns: DraftConcern[]; rulesVersion: number }

export type ScanItemView = {
  id: string
  /** The scan photo the item was read from; null only for an item from before the column. */
  photoId: string | null
  position: number
  state: ItemState
  reason: ItemReason | null
  /** Only on an item in `needs-retake`: how many more photos it may be sent. */
  retakesLeft?: number
  /** What the photo was read as (or what the user corrected it to); absent until it has been read. */
  recognised?: { brand: string; name: string; variant: string | null; form: ProductForm | null; category: ProductCategory }
  /** Only on a ready item: who the product is, not its ingredients or concerns. */
  product?: ProductSummary
  /** Only on an unidentified item: what the user said about a product with no label, and the cautions those answers earn (worked out now, not stored). */
  noLabel?: NoLabelView
  /** The product's stock image if it has one, else the user's own photo (the item's, or its shelf photo's) through a signed link while it is still stored, else none. */
  image: { kind: 'stock' | 'user'; url: string } | null
}

/** One uploaded photo of a scan, and how its reading went. `skipped` counts what a shelf photo showed that did not become an item; all zero on a product scan. */
export type ScanPhotoView = {
  id: string
  position: number
  state: ScanPhoto['state']
  skipped: { notBeauty: number; unreadable: number; overLimit: number; dailyLimit: number }
}

export type ScanView = { id: string; createdAt: Date; kind: ScanKind; photos: ScanPhotoView[]; items: ScanItemView[] }

export type ConfirmedProduct = { brand: string; name: string; variant?: string; form?: ProductForm; category: ProductCategory }

/** What a user says about a product with no label to read. */
export type NoLabelInput = { source: NoLabelSource; purpose: NoLabelPurpose; usedFor: NoLabelUsedFor; description?: string }

/** How a user names the product of an item they could not photograph: one picked from the catalog (by search), or a name they typed. */
export type ProductNaming = { productId: string } | { text: string }

export type ScanServiceDeps = {
  repository: ScansRepository
  catalog: ProductCatalogService
  recognizer: ProductRecognizer
  labelReader: LabelReader
  nameSplitter: NameSplitter
  photos: PhotoStore
  jobs: JobQueue
  events: ScanEvents
  notifications: NotificationsService
  /** Told when Claude refuses our account, so the owner is emailed. Never throws. */
  opsAlerts: OpsAlertsService
  /** Signs the photo links. photo-link.ts derives its own key from it. */
  photoLinkSecret: string
  /** Keys the IP hash, so a leaked table cannot be reversed by hashing every address. */
  ipHashSecret: string
  environment: PhotoEnvironment
  now?: () => Date
  newId?: () => string
  policy?: ScanPolicy
}

// Spelled out because a type outside the class cannot read its private members (TS2341).
type WorkingState = 'recognising' | 'matching' | 'researching' | 'reading-label' | 'analysing'
/** What a read back photo changes on its item, and whether the list it gave is already analysed by the current versions. */
type Filed = { analysed: boolean; patch: Omit<ItemPatch, 'updatedAt'> }
type ValidPhoto = { image: ProductImage; extension: 'jpg' | 'webp' }

export class ScanService {
  private static readonly MINUTE = 60 * 1000
  private static readonly HOUR = 60 * ScanService.MINUTE
  private static readonly DAY = 24 * ScanService.HOUR
  private static readonly MAX_TEXT_LENGTH = 120
  private static readonly MIN_TYPED_NAME_LENGTH = 2
  private static readonly MAX_DESCRIPTION_LENGTH = 200
  /** Products read from one shelf photo, and so the width of a shelf photo's run of item positions: photo p owns p * 5 to p * 5 + 4, its placeholder first. */
  private static readonly PRODUCTS_PER_PHOTO = 5
  // Names the use of ipHashSecret; a different info derives an unrelated key, so this one is not the device-id hashing key.
  private static readonly IP_HASH_INFO = 'deepertones/ip-hash/v1'
  private static readonly FINAL_STATES: readonly ItemState[] = ['ready', 'rejected', 'failed', 'unidentified']
  // A control character or an invisible format character (a right-to-left override, a zero-width space).
  private static readonly HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u

  /** The step the system owes an item in each state it is working in. A state waiting for the user (confirming, a back photo) or a final one has none. */
  private static readonly STEP_OF_WORKING_STATE = {
    recognising: 'recognise',
    matching: 'match',
    researching: 'research',
    'reading-label': 'read-label',
    analysing: 'analyse',
  } as const satisfies Partial<Record<ItemState, ScanStep>>
  private static readonly WORKING_STATES = Object.keys(ScanService.STEP_OF_WORKING_STATE) as WorkingState[]
  /** The reaper queues a working item's step again once it has sat this long, and fails it as unavailable once it is older than the second. */
  private static readonly STUCK_AFTER_MS = 15 * ScanService.MINUTE
  private static readonly GIVE_UP_AFTER_MS = 2 * ScanService.HOUR
  /** The reaper sends a missing `done` for a scan whose items have all been final for this long, so it never races the publish that is still on its way. */
  private static readonly DONE_SETTLED_AFTER_MS = 5 * ScanService.MINUTE
  /** One sweep looks at this many items at most, oldest first, which keeps its calls well inside a Worker's limit. */
  private static readonly REAP_BATCH = 100
  /** One sweep gives a profile to this many scans that have none, oldest first. */
  private static readonly ADOPT_BATCH = 500
  /** How long a step waits before it asks again whether work another call is doing has finished. */
  private static readonly WAIT_SECONDS = 30
  /** How long a step waits before asking Claude again after it refused our account (no credit, a bad key, permissions): someone has to fix it, so no point asking sooner. */
  private static readonly ACCOUNT_WAIT_SECONDS = 5 * 60

  /** What an item that was named by hand has set and a move back to waiting must clear. */
  private static readonly NOT_NAMED: Omit<ItemPatch, 'updatedAt'> = {
    productId: null,
    formulationId: null,
    recognisedBrand: null,
    recognisedName: null,
    recognisedVariant: null,
    recognisedForm: null,
    recognisedCategory: null,
  }

  private static scanNotFound = () => new NotFoundError('SCAN_NOT_FOUND', 'Scan not found')
  private static photoNotFound = () => new NotFoundError('PHOTO_NOT_FOUND', 'Photo not found')
  private static isFinal = (state: ItemState) => ScanService.FINAL_STATES.includes(state)
  private static isHeld = (state: ItemState) => PHOTO_HELD_STATES.includes(state)

  private readonly repository: ScansRepository
  private readonly catalog: ProductCatalogService
  private readonly recognizer: ProductRecognizer
  private readonly labelReader: LabelReader
  private readonly nameSplitter: NameSplitter
  private readonly photos: PhotoStore
  private readonly jobs: JobQueue
  private readonly events: ScanEvents
  private readonly notifications: NotificationsService
  private readonly opsAlerts: OpsAlertsService
  readonly #photoLinkSecret: string
  readonly #ipHashSecret: string
  private readonly environment: PhotoEnvironment
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly policy: ScanPolicy

  constructor(deps: ScanServiceDeps) {
    this.repository = deps.repository
    this.catalog = deps.catalog
    this.recognizer = deps.recognizer
    this.labelReader = deps.labelReader
    this.nameSplitter = deps.nameSplitter
    this.photos = deps.photos
    this.jobs = deps.jobs
    this.events = deps.events
    this.notifications = deps.notifications
    this.opsAlerts = deps.opsAlerts
    this.#photoLinkSecret = deps.photoLinkSecret
    this.#ipHashSecret = deps.ipHashSecret
    this.environment = deps.environment
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
    this.policy = deps.policy ?? SCAN_POLICY
  }

  /**
   * Starts a scan: one item per photo, each recognised in the background. Every photo is checked before any is stored,
   * and the whole scan is refused if one is bad or a daily quota (per user, per IP) would be passed. The photos are put
   * in the private bucket BEFORE the scan is saved, so a saved item never points at a missing photo; if saving fails
   * they are deleted again. The IP is stored only as a keyed hash.
   *
   * The quota is checked, then the scan written, so simultaneous scans can pass it together by a few photos; the
   * burst limits on the route bound that.
   */
  async create(input: { photos: ProductImage[]; clientIp: string }): Promise<ScanView> {
    return this.startScan('product', this.policy.maxPhotosPerScan, input)
  }

  /**
   * Starts a shelf scan: 1 to `maxShelfPhotos` photos, each read in the background for up to 5 products. Checked, stored and
   * refused exactly as `create` is, with one difference in what is stored: each photo keeps its own image (under its own id), and
   * gets one placeholder item in `recognising`, at position `photo position * 5`, with no image of its own. The placeholder becomes the
   * photo's first product when it is read, and the others become items beside it (see `recogniseShelf`). The quota counts one per photo
   * here; the products found are counted when they are made.
   */
  async createShelf(input: { photos: ProductImage[]; clientIp: string }): Promise<ScanView> {
    return this.startScan('shelf', this.policy.maxShelfPhotos, input)
  }

  /**
   * Starts a typed scan: the user added a named product they found by search, with no photo. Run as the session's user and profile.
   *
   * Nothing is written until the checks pass, in this order: the product (PRODUCT_NOT_FOUND for an unknown or unnamed one), then, only
   * if the catalog says it still needs a model (`needs-research` or `needs-analysis`), the daily allowance for the user and the address
   * with one added (SCAN_DAILY_LIMIT, as a photo scan's). A `ready` or `analysis-failed` product costs no model, so it is neither checked
   * nor counted (see `NewScanItem.counted`).
   *
   * The scan has no photo and one item at position 0. It is created in `needs-identification`, not `recognising`: with no photo the
   * reaper would requeue a recognise that can only fail as photo-missing, whereas this state is one it leaves alone and the app can still
   * identify by hand. The item is then moved on exactly as picking the product for an item is (`identifyByChoice`), so a failure there
   * (the next step cannot be queued) leaves it waiting in `needs-identification`, no longer counted (the client never learns its id, so
   * the slot is given back, best effort), and propagates.
   */
  async createTyped(input: { productId: string; clientIp: string }): Promise<{ scanId: string; itemId: string }> {
    const { userId, profileId } = requireUser()
    const resolved = await this.catalog.choose(input.productId)
    const product = await this.catalog.namedProduct(input.productId)
    const needsModel = resolved.kind === 'needs-research' || resolved.kind === 'needs-analysis'
    const now = this.now()
    const ipHash = await this.hashIp(input.clientIp)
    if (needsModel) await this.assertWithinQuota(userId, ipHash, 1, now)

    const scanId = this.newId()
    const itemId = this.newId()
    await this.repository.createScan(
      { id: scanId, userId, profileId, kind: 'typed', ipHash, createdAt: now },
      [],
      [{ id: itemId, scanId, userId, position: 0, photoId: null, photoKey: null, state: 'needs-identification', counted: needsModel, createdAt: now }],
    )
    const item = await this.repository.findItem(itemId)
    if (!item) throw new Error('typed scan item vanished')
    try {
      // Routed on the answer that was counted above: asking the catalog again could send a model call out uncounted.
      await this.identifyByChoice(item, 'needs-identification', input.productId, { resolved, product })
    } catch (error) {
      // The client never learns the scan id, so it cannot retry this item: give the slot back instead of holding it for 24 hours.
      console.error({ outcome: 'typed-move-failed', scanId, itemId })
      await this.repository.updateItem(itemId, 'needs-identification', { counted: false, updatedAt: this.now() }).catch(() => console.error({ outcome: 'typed-refund-failed', scanId, itemId }))
      throw error
    }
    return { scanId, itemId }
  }

  /** What `create` and `createShelf` share: check every photo, take the quota, put the photos then save the scan, and queue a recognise job per item. */
  private async startScan(kind: ScanKind, maxPhotos: number, input: { photos: ProductImage[]; clientIp: string }): Promise<ScanView> {
    const { userId, profileId } = requireUser()
    if (input.photos.length === 0) throw new ValidationError('NO_IMAGES', 'Send at least one photo')
    if (input.photos.length > maxPhotos) {
      throw new ValidationError('TOO_MANY_IMAGES', `A scan holds at most ${maxPhotos} photos`)
    }
    const valid = input.photos.map((photo) => this.checkPhoto(photo))
    const now = this.now()
    const ipHash = await this.hashIp(input.clientIp)
    await this.assertWithinQuota(userId, ipHash, valid.length, now)

    const scanId = this.newId()
    const stored = valid.map((photo, position) => {
      const id = this.newId()
      const photoId = this.newId()
      // The image lives on the item of a product scan, so its photo row holds no key; on the photo of a shelf scan, so its item holds none.
      const key = this.photoKey(userId, scanId, kind === 'shelf' ? photoId : id, photo.extension)
      const item: NewScanItem = {
        id,
        scanId,
        userId,
        position: kind === 'shelf' ? position * ScanService.PRODUCTS_PER_PHOTO : position,
        photoId,
        photoKey: kind === 'shelf' ? null : key,
        createdAt: now,
      }
      const scanPhoto: NewScanPhoto = { id: photoId, scanId, userId, position, photoKey: kind === 'shelf' ? key : null, createdAt: now }
      return { item, scanPhoto, key, image: photo.image }
    })
    try {
      await Promise.all(stored.map(({ key, image }) => this.photos.put(key, image)))
      await this.repository.createScan(
        { id: scanId, userId, profileId, kind, ipHash, createdAt: now },
        stored.map(({ scanPhoto }) => scanPhoto),
        stored.map(({ item }) => item),
      )
    } catch (error) {
      await this.photos.deleteMany(stored.map(({ key }) => key)).catch(() => console.error({ outcome: 'photo-cleanup-failed', scanId }))
      throw error
    }

    for (const { item } of stored) {
      try {
        await this.jobs.enqueue(advanceScanItemSpec, { itemId: item.id, step: 'recognise', at: now.getTime() })
      } catch {
        // Nothing will ever recognise this item, so say so instead of leaving it recognising for ever.
        console.error({ outcome: 'enqueue-failed', scanId, itemId: item.id })
        await this.repository
          .updateItem(item.id, 'recognising', { state: 'failed', reason: 'unavailable', updatedAt: this.now() })
          .catch(() => console.error({ outcome: 'mark-failed-failed', scanId, itemId: item.id }))
      }
    }
    return this.scanView({ id: scanId, createdAt: now, kind }, await this.repository.itemsOf(scanId), now)
  }

  /** The scan as it now is. A scan made by another profile, of this account or any other, is SCAN_NOT_FOUND, with no hint that it exists. */
  async getScan(scanId: string): Promise<ScanView> {
    const { scan, items } = await this.ownedScan(scanId)
    return this.scanView(scan, items, this.now())
  }

  /**
   * Opens a live stream of the scan for the profile that made it (anyone else's scan is SCAN_NOT_FOUND). The stream starts with the scan
   * as it now is, then carries each item change and `done`.
   *
   * The snapshot is read before the stream opens, and a change stored in between would reach no one: it was published
   * while nobody listened, and the snapshot predates it. So once the stream is open the items are read again, each one
   * that differs from the snapshot (in state or time) is sent as an `item` (a shelf photo whose state or counts differ, as a `photo`, before the items), and if every item is final the scan is marked
   * done (if it was not) and `done` is sent, which also ends the stream. `done` is sent whenever all are final, even for a
   * scan already marked: this client has not had it. That covers a scan finished before the client came, and a `done` lost
   * while nobody was connected. A failure to send any of this is logged and never fails the stream.
   */
  async watch(scanId: string): Promise<Response> {
    const { scan, items } = await this.ownedScan(scanId)
    const view = await this.scanView(scan, items, this.now())
    const stream = await this.events.subscribe(scanId, view)
    await this.catchUp(scanId, items, view.photos)
    return stream
  }

  /** A scan is readable only by the profile that made it; another profile of the same account gets the same 404 as another user. */
  private async ownedScan(scanId: string): Promise<{ scan: Scan; items: ScanItem[] }> {
    const { userId, profileId } = requireUser()
    const scan = await this.repository.findScan(scanId)
    if (!scan || scan.userId !== userId || scan.profileId !== profileId) throw ScanService.scanNotFound()
    return { scan, items: await this.repository.itemsOf(scanId) }
  }

  /** What `watch` owes a client that opened its stream on `snapshot`: every change stored since, then `done` if the scan is over. */
  private async catchUp(scanId: string, snapshot: ScanItem[], snapshotPhotos: ScanPhotoView[]): Promise<void> {
    let items: ScanItem[]
    let photos: ScanPhoto[]
    try {
      ;[items, photos] = await Promise.all([this.repository.itemsOf(scanId), this.repository.photosOf(scanId)])
    } catch {
      console.error({ outcome: 'publish-failed', scanId })
      return
    }
    const shownPhotos = new Map(snapshotPhotos.map((photo) => [photo.id, JSON.stringify(photo)]))
    for (const photo of photos.map(ScanService.photoView)) {
      if (shownPhotos.get(photo.id) === JSON.stringify(photo)) continue
      try {
        await this.events.publish(scanId, { type: 'photo', photo })
      } catch {
        console.error({ outcome: 'publish-failed', scanId, photoId: photo.id })
      }
    }
    const seen = new Map(snapshot.map((item) => [item.id, item]))
    for (const item of items) {
      const before = seen.get(item.id)
      if (before && before.state === item.state && before.updatedAt.getTime() === item.updatedAt.getTime()) continue
      try {
        await this.events.publish(scanId, { type: 'item', item: await this.itemView(item, this.now(), photos) })
      } catch {
        console.error({ outcome: 'publish-failed', scanId, itemId: item.id })
      }
    }
    if (!items.every((item) => ScanService.isFinal(item.state))) return
    try {
      await this.sendDone(scanId, { always: true, items })
    } catch {
      console.error({ outcome: 'publish-failed', scanId })
    }
  }

  /**
   * The user's correction of a doubtful read: the item goes on to matching with the product they typed. Text that
   * ends up in the shared catalog must not carry a link, markup or a hidden character, nor be over 120 characters.
   */
  async confirm(scanId: string, itemId: string, fields: ConfirmedProduct): Promise<ScanItemView> {
    const item = await this.ownedItem(scanId, itemId)
    const variant = fields.variant === undefined ? '' : this.cleanText(fields.variant, 'variant', false)
    const product = { brand: this.cleanText(fields.brand, 'brand', true), name: this.cleanText(fields.name, 'name', true), variant }
    const moved = await this.transition(item, {
      from: 'needs-confirmation',
      change: {
        state: 'matching',
        reason: null,
        recognisedBrand: product.brand,
        recognisedName: product.name,
        recognisedVariant: variant === '' ? null : variant,
        recognisedForm: fields.form ?? null,
        recognisedCategory: fields.category,
      },
      next: 'match',
    })
    if (!moved) throw new ConflictError('ITEM_NOT_AWAITING_CONFIRMATION', 'This item is not waiting for confirmation')
    return this.itemViewOf(itemId)
  }

  /**
   * The photo of the ingredient list, for an item that asked for one, or one that offers identification (its front photo could not be read
   * three times, so the back identifies the product). It counts as one photo against both daily quotas,
   * however many an item has had (each upload is recorded, for the address it came from, in the same write that moves the
   * item on), is checked like a front photo, and is kept next to the front one as `<item id>-back.<jpg|webp>`.
   */
  async addBackPhoto(scanId: string, itemId: string, photo: ProductImage, clientIp: string): Promise<ScanItemView> {
    const item = await this.ownedItem(scanId, itemId)
    const notAwaiting = () => new ConflictError('ITEM_NOT_AWAITING_BACK_PHOTO', 'This item is not waiting for a photo of the back')
    if (item.state !== 'needs-back-photo' && item.state !== 'needs-identification') throw notAwaiting()
    const valid = this.checkPhoto(photo)
    const now = this.now()
    const ipHash = await this.hashIp(clientIp)
    await this.assertWithinQuota(item.userId, ipHash, 1, now)

    const key = this.photoKey(item.userId, scanId, `${itemId}-back`, valid.extension)
    await this.photos.put(key, valid.image)
    let moved = false
    try {
      moved = await this.transition(item, {
        from: item.state,
        change: { state: 'reading-label', reason: null, backPhotoKey: key },
        next: 'read-label',
        undo: { backPhotoKey: null },
        backPhoto: { id: this.newId(), itemId, userId: item.userId, ipHash, uploadedAt: now },
      })
    } catch (error) {
      await this.photos.delete(key).catch(() => console.error({ outcome: 'photo-cleanup-failed', scanId, itemId }))
      throw error
    }
    if (!moved) {
      // Lost a race with another upload. When both wrote the same key the winner owns it, so only a different key is ours to remove.
      if ((await this.repository.findItem(itemId))?.backPhotoKey !== key) await this.photos.delete(key)
      throw notAwaiting()
    }
    return this.itemViewOf(itemId)
  }

  /**
   * A new front photo for an item whose photo could not be read. Counts as one photo against both daily quotas (recorded, for
   * the address it came from, in the same write that moves the item on), is checked like a first photo, and is kept under the
   * front photo's own key scheme, so the photo it replaces (deleted when it failed) never shares a place with it.
   */
  async retake(scanId: string, itemId: string, photo: ProductImage, clientIp: string): Promise<ScanItemView> {
    const item = await this.ownedItem(scanId, itemId)
    const notAwaiting = () => new ConflictError('ITEM_NOT_AWAITING_RETAKE', 'This item is not waiting for a retaken photo')
    if (item.state !== 'needs-retake') throw notAwaiting()
    const valid = this.checkPhoto(photo)
    const now = this.now()
    const ipHash = await this.hashIp(clientIp)
    await this.assertWithinQuota(item.userId, ipHash, 1, now)

    const key = this.photoKey(item.userId, scanId, itemId, valid.extension)
    await this.photos.put(key, valid.image)
    let moved = false
    try {
      moved = await this.transition(item, {
        from: 'needs-retake',
        change: {
          state: 'recognising',
          reason: null,
          photoKey: key,
          recognisedBrand: null,
          recognisedName: null,
          recognisedVariant: null,
          recognisedCategory: null,
          recognisedConfidence: null,
        },
        next: 'recognise',
        undo: { photoKey: null },
        retake: { id: this.newId(), itemId, userId: item.userId, ipHash, uploadedAt: now },
      })
    } catch (error) {
      await this.photos.delete(key).catch(() => console.error({ outcome: 'photo-cleanup-failed', scanId, itemId }))
      throw error
    }
    if (!moved) {
      // Lost a race with another retake. When both wrote the same key the winner owns it, so only a different key is ours to remove.
      if ((await this.repository.findItem(itemId))?.photoKey !== key) await this.photos.delete(key)
      throw notAwaiting()
    }
    return this.itemViewOf(itemId)
  }

  /**
   * Names the product of an item whose front photo could not be read (`needs-retake`, or `needs-identification` once the 3rd could not),
   * either by a product picked from the catalog (`productId`, from search) or by free text. Sends no photo, so no quota and no retake
   * is counted.
   *
   * Checked in this order, and nothing is paid for until all of it passes: the scan is the caller's (SCAN_NOT_FOUND), the item is waiting
   * (ITEM_NOT_AWAITING_IDENTIFICATION), the text is clean (INVALID_PRODUCT_TEXT: 2 to 120 characters, no link, markup or hidden character).
   *
   * A picked product costs no model call: the item goes where the catalog says that product needs to go (`ready`, `analysing`,
   * `researching`, or `failed` as `analysis-failed`), exactly as the match step would send it, and shows the product as what it was
   * recognised as. Typed text costs one split by the model, then goes to `matching` and the match step as a confirmation does. Text the
   * split says is no product's name, or the model refuses, is NOT_A_PRODUCT_NAME; and a model that is down, whose answer cannot be used, or that
   * refuses our account (which also emails the owner) is UnavailableError AI_UNAVAILABLE (503). In every one of those the item stays where it was and nothing is queued, so the user can try again.
   */
  async identifyByName(scanId: string, itemId: string, naming: ProductNaming): Promise<ScanItemView> {
    const item = await this.ownedItem(scanId, itemId)
    const notAwaiting = () => new ConflictError('ITEM_NOT_AWAITING_IDENTIFICATION', 'This item is not waiting to be identified')
    if (item.state !== 'needs-retake' && item.state !== 'needs-identification') throw notAwaiting()
    const moved = 'productId' in naming ? await this.identifyByChoice(item, item.state, naming.productId) : await this.identifyByText(item, item.state, naming.text)
    if (!moved) throw notAwaiting()
    return this.itemViewOf(itemId)
  }

  /**
   * The user has no label to give: the product is not known and will not be looked up. For an item that offers identification (its 3rd front
   * photo could not be read) and no other, the item ends as `unidentified` with the user's answers. Its cautions are not stored: they are
   * worked out from the answers whenever the item is shown. Sends no photo and calls no model, so no quota, retake or job is used.
   *
   * Checked in this order: the scan is the caller's (SCAN_NOT_FOUND), the item is offering identification (ITEM_NOT_AWAITING_NO_LABEL), the
   * description is clean (INVALID_PRODUCT_TEXT, field `description`: at most 200 characters, no link, markup or hidden character). A blank one is none.
   */
  async noLabel(scanId: string, itemId: string, answers: NoLabelInput): Promise<ScanItemView> {
    const item = await this.ownedItem(scanId, itemId)
    const notAwaiting = () => new ConflictError('ITEM_NOT_AWAITING_NO_LABEL', 'This item is not waiting to say it has no label')
    if (item.state !== 'needs-identification') throw notAwaiting()
    const description = answers.description === undefined ? '' : this.cleanText(answers.description, 'description', false, ScanService.MAX_DESCRIPTION_LENGTH)
    const moved = await this.transition(item, {
      from: 'needs-identification',
      change: {
        state: 'unidentified',
        reason: null,
        noLabelSource: answers.source,
        noLabelPurpose: answers.purpose,
        noLabelUsedFor: answers.usedFor,
        noLabelDescription: description === '' ? null : description,
      },
    })
    if (!moved) throw notAwaiting()
    return this.itemViewOf(itemId)
  }

  /** `known` is an answer the caller already has (and acted on), so it is not asked for again. */
  private async identifyByChoice(item: ScanItem, from: ItemState, productId: string, known?: { resolved: ResolveResult; product: ProductSummary }): Promise<boolean> {
    const resolved = known?.resolved ?? (await this.catalog.choose(productId))
    const product = known?.product ?? (await this.catalog.namedProduct(productId))
    return this.moveOn(
      item,
      from,
      resolved,
      { reason: null, recognisedBrand: product.brand, recognisedName: product.name, recognisedVariant: product.variant, recognisedForm: product.form, recognisedCategory: product.category },
      ScanService.NOT_NAMED,
    )
  }

  private async identifyByText(item: ScanItem, from: ItemState, text: string): Promise<boolean> {
    const typed = this.cleanText(text, 'text', true)
    if (typed.length < ScanService.MIN_TYPED_NAME_LENGTH) throw new ValidationError('INVALID_PRODUCT_TEXT', 'The text is not valid', { field: 'text' })
    const split = await this.split(typed)
    if (split.kind !== 'product') throw new ValidationError('NOT_A_PRODUCT_NAME', "We couldn't read that as a product name")
    return this.transition(item, {
      from,
      change: {
        state: 'matching',
        reason: null,
        recognisedBrand: split.brand,
        recognisedName: split.name,
        recognisedVariant: split.variant ?? null,
        recognisedCategory: split.category,
      },
      next: 'match',
      undo: ScanService.NOT_NAMED,
    })
  }

  /** One paid split. A refusal is an answer (this is no product's name); a model that is down, that cannot be used, or that refuses our account is AI_UNAVAILABLE, which blames no limit and tells the user nothing of our account. */
  private async split(text: string): Promise<NameSplit> {
    try {
      return await this.nameSplitter.split(text)
    } catch (error) {
      if (error instanceof AnthropicRefusalError) return { kind: 'not-a-product' }
      if (error instanceof AnthropicConfigError) await this.opsAlerts.raise('ai-account')
      if (error instanceof AnthropicUnavailableError || error instanceof AnthropicRequestError || error instanceof AnthropicConfigError) {
        console.error({ outcome: 'split-name-failed', error: describeUnexpectedError(error) })
        throw new UnavailableError('AI_UNAVAILABLE', "Couldn't read that name right now. Try again in a moment.")
      }
      throw error
    }
  }

  /**
   * The photo a signed link opens: its bytes and media type. The link is the capability: an app image component
   * cannot send an Authorization header, so this takes no user and reads no request context. A link that is
   * malformed, tampered with, signed with another secret or expired, and a link to a photo that has since been
   * deleted, are all PHOTO_NOT_FOUND.
   */
  async photoForLink(token: string): Promise<ProductImage> {
    const link = await verifyPhotoLink(token, this.#photoLinkSecret, this.now())
    if (!link) throw ScanService.photoNotFound()
    const photo = await this.photos.get(link.key)
    if (!photo) throw ScanService.photoNotFound()
    return photo
  }

  /**
   * The queue's entry for one step of one item. Every step runs only while the item is in the state the step starts
   * from and moves it with a guarded update, so a repeated or late message does nothing. An error that is thrown
   * leaves the item where it was, for the queue to retry.
   */
  async advance(itemId: string, step: ScanStep): Promise<void> {
    const item = await this.repository.findItem(itemId)
    if (!item) return
    try {
      await this.runStep(item, step)
    } catch (error) {
      // Claude refused OUR account, whichever call it was: that is ours to fix and never the user's, so the item waits (see waitOnAccount).
      if (!(error instanceof AnthropicConfigError)) throw error
      await this.waitOnAccount(item, step)
    }
  }

  private runStep(item: ScanItem, step: ScanStep): Promise<void> {
    switch (step) {
      case 'recognise':
        return this.recognise(item)
      case 'match':
        return this.match(item)
      case 'research':
        return this.research(item)
      case 'read-label':
        return this.readLabel(item)
      case 'analyse':
        return this.analyse(item)
    }
  }

  /**
   * The dead-letter hook: an item whose step ran out of retries is failed as unavailable, but only while it is in a state the
   * system is working in. One waiting for the user (confirming, a back photo) has no message of ours in flight, so a dead letter
   * for it is a stale message from an earlier state, and a finished one has nothing left to fail.
   */
  async markItemFailed(itemId: string): Promise<void> {
    const item = await this.repository.findItem(itemId)
    if (!item || !(ScanService.WORKING_STATES as readonly ItemState[]).includes(item.state)) return
    await this.transition(item, { from: item.state, change: { state: 'failed', reason: 'unavailable' } })
  }

  /**
   * The scheduled sweep for items the queue lost or never delivered (a message dropped after the item moved, a worker
   * that died between the write and the send). An item the system owes work on (recognising, matching, researching,
   * reading the label, analysing) that has not changed for over 15 minutes has its step queued again, stamped with the
   * time it entered the state, which is the key of the message that first queued it: if that run already finished the
   * dispatcher acknowledges it, if not it runs. One older than 2 hours is failed as unavailable. An item waiting for the
   * user is never touched. A failure on one item is logged by id and does not stop the sweep. The sweep also sends the `done` of
   * a scan, created within `doneRepairWindowMs`, whose items have all been final for over 5 minutes without one.
   *
   * The sweep first gives the scans that have no profile their owner's default (see `adoptOrphanScans`).
   *
   * `now` is passed in so the cutoffs are fixed for the whole sweep; the changes it makes are stamped by the service's clock.
   */
  async reap(now: Date): Promise<{ requeued: number; failed: number }> {
    await this.adoptOrphanScans()
    const stale = await this.repository.staleItems(ScanService.WORKING_STATES, new Date(now.getTime() - ScanService.STUCK_AFTER_MS), ScanService.REAP_BATCH)
    let requeued = 0
    let failed = 0
    for (const item of stale) {
      const step = (ScanService.STEP_OF_WORKING_STATE as Partial<Record<ItemState, ScanStep>>)[item.state]
      if (!step) continue
      try {
        if (item.updatedAt.getTime() < now.getTime() - ScanService.GIVE_UP_AFTER_MS) {
          if (await this.transition(item, { from: item.state, change: { state: 'failed', reason: 'unavailable' } })) failed++
        } else {
          await this.jobs.enqueue(advanceScanItemSpec, { itemId: item.id, step, at: item.updatedAt.getTime() })
          requeued++
        }
      } catch {
        console.error({ outcome: 'reap-failed', scanId: item.scanId, itemId: item.id })
      }
    }
    await this.releaseMissedPhotos()
    await this.sendMissingDone(now)
    return { requeued, failed }
  }

  /**
   * Releases the photos an earlier release missed (the bucket refused the delete, or the worker died between the delete and the clear):
   * product photos still held by an item that no longer needs them, and shelf photos none of whose items needs them. Each read has its
   * own budget of `REAP_BATCH`, oldest first. A failure is logged by id and does not stop the sweep.
   */
  private async releaseMissedPhotos(): Promise<void> {
    try {
      for (const item of await this.repository.itemsWithReleasablePhoto(ScanService.REAP_BATCH)) {
        await this.releaseKey(item.photoKey!, { scanId: item.scanId, itemId: item.id }, (key) => this.repository.clearItemPhotoKey(item.id, key))
      }
      for (const photo of await this.repository.shelfPhotosToRelease(ScanService.REAP_BATCH)) {
        await this.releaseKey(photo.photoKey!, { scanId: photo.scanId, photoId: photo.id }, (key) => this.repository.clearShelfPhotoKey(photo.id, key))
      }
    } catch {
      console.error({ outcome: 'photo-release-sweep-failed' })
    }
  }

  /**
   * Scans written without a profile (by the old Worker, between the profiles migrations and the new Worker going live) can
   * be read by nobody: `ownedScan` needs the actor's profile. This gives each its owner's default; a scan whose owner has
   * none yet waits for a later sweep, after the owner's next session makes one. A failure is logged and never stops the rest
   * of the sweep.
   */
  private async adoptOrphanScans(): Promise<void> {
    try {
      const count = await this.repository.adoptOrphanScans(ScanService.ADOPT_BATCH)
      if (count > 0) console.log({ outcome: 'orphan-scans-adopted', count })
    } catch (error) {
      console.error({ outcome: 'orphan-adopt-failed', error: describeUnexpectedError(error) })
    }
  }

  /**
   * A scan whose items are all final and whose done time is unset had its `done` lost: publishing failed after the last
   * item's change was stored. It is marked and `done` sent, once, by the call whose guarded update sets the time; if the
   * send fails the time is cleared again (see `sendDone`), so the next sweep tries again. Only scans created within
   * `doneRepairWindowMs` are looked at. A failure on one scan is logged by id and does not stop the sweep.
   */
  private async sendMissingDone(now: Date): Promise<void> {
    const createdSince = new Date(now.getTime() - this.policy.doneRepairWindowMs)
    const settled = await this.repository.settledScansNotDone(
      [...ScanService.FINAL_STATES],
      new Date(now.getTime() - ScanService.DONE_SETTLED_AFTER_MS),
      createdSince,
      ScanService.REAP_BATCH,
    )
    for (const scan of settled) {
      try {
        await this.sendDone(scan.id, { always: false })
      } catch {
        console.error({ outcome: 'reap-done-failed', scanId: scan.id })
      }
    }
  }

  /**
   * Marks the scan done and publishes `done`. Normally only the call whose guarded update sets the time publishes; `always`
   * publishes whether or not this call set it (for a client that has not had it yet).
   *
   * The call that sets the time also queues "your scan is ready", BEFORE the publish: the person may have closed the app, so the
   * push must not depend on a live stream that is down or on the publish succeeding. The push is keyed by the scan, so the repeat
   * a cleared and set-again time causes is sent once. A call that did not set the time queues nothing, however many clients ask.
   *
   * A push that cannot be prepared (its reads throw) is logged as `push-failed` and never keeps `done` from going out; the time is
   * cleared again so the reaper re-claims it and queues the push again under the same key. If the publish throws after this call
   * set the time, the time is cleared too, so that `done` is still owed and the reaper finds the scan. The clear applies only while
   * the time is still the one set here, so it never undoes another call's mark. A publish error is rethrown for the caller to log.
   *
   * `items` is the list the caller has just read, every one final; the reaper has none and it is read here. Reusing it keeps this
   * a single read of the scan per call, and the winner of a race makes no read of the items beyond its caller's.
   */
  private async sendDone(scanId: string, { always, items }: { always: boolean; items?: ScanItem[] }): Promise<void> {
    const at = this.now()
    const applied = await this.repository.markScanDone(scanId, at)
    if (!applied && !always) return
    let pushFailed = false
    if (applied) {
      try {
        await this.notifyFinished(scanId, items)
      } catch {
        // Ids only: the error may carry what the database said.
        console.error({ outcome: 'push-failed', scanId })
        pushFailed = true
      }
    }
    const undo = () => this.repository.clearScanDone(scanId, at).catch(() => console.error({ outcome: 'done-undo-failed', scanId }))
    try {
      await this.events.publish(scanId, { type: 'done' })
    } catch (error) {
      if (applied) await undo()
      throw error
    }
    if (pushFailed) await undo()
  }

  /** Queues the finished push for the scan's profile. Only the reads can throw; queuing the push never does (NotificationsService swallows it). */
  private async notifyFinished(scanId: string, known: ScanItem[] | undefined): Promise<void> {
    const [scan, items] = await Promise.all([this.repository.findScan(scanId), known ?? this.repository.itemsOf(scanId)])
    if (!scan) return
    // An orphan, written by the old Worker, has no profile whose phones could be told.
    if (scan.profileId === null) return void console.log({ outcome: 'push-skipped-no-profile', scanId })
    // A typed scan whose item was not counted finished inside the request that made it (the product needed no model), so the person is
    // still looking at the answer: a push would only tell them what they have just seen. A counted one waited for a model, possibly after they left.
    if (scan.kind === 'typed' && items.every((item) => !item.counted)) return
    await this.notifications.scanFinished({
      userId: scan.userId,
      profileId: scan.profileId,
      scanId,
      readyCount: items.filter((item) => item.state === 'ready').length,
    })
  }

  /**
   * Queues "your scan needs you" after the guarded update that put the item in a waiting state applied. The scan row is read
   * for its profile (a step runs as a system actor, so there is no session to take it from); that read is guarded, because the
   * item has already moved and a throw would only be retried into a no-op. Nothing here fails the step.
   */
  private async notifyNeedsYou(item: ScanItem, need: 'back-photo' | 'confirm' | 'identify', ask?: number): Promise<void> {
    try {
      const scan = await this.repository.findScan(item.scanId)
      if (!scan) return
      if (scan.profileId === null) return void console.log({ outcome: 'push-skipped-no-profile', scanId: item.scanId })
      await this.notifications.scanNeedsYou({
        userId: scan.userId,
        profileId: scan.profileId,
        scanId: item.scanId,
        itemId: item.id,
        need,
        ...(ask === undefined ? {} : { ask }),
      })
    } catch {
      console.error({ outcome: 'push-failed', scanId: item.scanId, itemId: item.id })
    }
  }

  private async recognise(item: ScanItem): Promise<void> {
    if (item.state !== 'recognising') return
    // A shelf placeholder holds no image of its own: its photo does.
    const shelfPhoto = item.photoKey === null && item.photoId !== null ? await this.repository.findPhoto(item.photoId) : null
    // Also a photo already read whose image was released: a retry goes on from the stored answer.
    if (shelfPhoto && (shelfPhoto.photoKey || shelfPhoto.recognition !== null)) return this.recogniseShelf(item, shelfPhoto)

    let seen = this.earlierRead(item)
    if (!seen) {
      const photo = item.photoKey === null ? null : await this.photos.get(item.photoKey)
      if (item.photoKey === null || !photo) {
        await this.fail(item, 'recognising', 'photo-missing')
        return
      }
      seen = await this.askRecognizer<Recognition>(item, () => this.recognizer.recognize(photo), { classification: 'unreadable' })
      if (!seen) return
    }

    if (seen.classification === 'beauty-product') {
      const sure = seen.confidence >= this.policy.confirmBelowConfidence
      const moved = await this.transition(item, {
        from: 'recognising',
        change: {
          state: sure ? 'matching' : 'needs-confirmation',
          recognisedBrand: seen.brand,
          recognisedName: seen.name,
          recognisedVariant: seen.variant || null,
          recognisedForm: seen.form ?? null,
          recognisedCategory: seen.category,
          recognisedConfidence: seen.confidence,
        },
        next: sure ? 'match' : undefined,
      })
      if (moved && !sure) await this.notifyNeedsYou(item, 'confirm')
      return
    }

    // A photo we will not use is deleted at once, before the row says so: a failure here is retried while the item is still recognising.
    if (item.photoKey !== null) await this.photos.delete(item.photoKey)
    if (seen.classification === 'unreadable' || seen.classification === 'label-not-visible') {
      // Every photo sent is a try, the first included: the retakes recorded so far plus this one.
      const tries = 1 + (await this.repository.countRetakes(item.id))
      const identify = tries >= this.policy.maxFrontPhotos
      const moved = await this.transition(item, {
        from: 'recognising',
        change: { state: identify ? 'needs-identification' : 'needs-retake', reason: seen.classification, photoKey: null },
      })
      if (moved && identify) await this.notifyNeedsYou(item, 'identify')
      return
    }
    const reason = { 'face-or-person': 'face-or-person', 'other-product': 'not-a-beauty-product' } as const
    await this.transition(item, { from: 'recognising', change: { state: 'rejected', reason: reason[seen.classification], photoKey: null } })
  }

  /**
   * Asks the recognizer about a `recognising` item's photo. A refusal to look at the photo is `onRefusal` (a photo nothing can be read
   * from); an answer that cannot be used fails it as `unavailable` and is permanent
   * (the same photo would get the same answer, so a retry would only pay again). Any other error is left for the queue to retry.
   * Undefined means the item has been failed and there is nothing more to do.
   */
  private async askRecognizer<T>(item: ScanItem, ask: () => Promise<T>, onRefusal: T): Promise<T | undefined> {
    try {
      return await ask()
    } catch (error) {
      if (error instanceof AnthropicRefusalError) return onRefusal
      if (error instanceof AnthropicRequestError) {
        await this.fail(item, 'recognising', 'unavailable')
        throw new PermanentJobError('The model gave no usable answer for this photo', { cause: error })
      }
      throw error
    }
  }

  /**
   * ---- The shelf path of `recognise`: one photo, up to 5 products. ----
   *
   * The placeholder (the photo's item, at its first slot) takes the first product; the others become new items at the photo's
   * following slots (`photo position * 5 + rank`, the same on every retry, so two photos read at once cannot collide). Everything the
   * read changes is written by one `ScansRepository.fanOut` batch, so a retry or a repeated delivery can neither duplicate nor lose a
   * product, and the scan cannot be done before its new items exist. The photo's whole answer is stored with it, so a retry after a
   * failed enqueue reads the stored answer instead of paying for the model again.
   *
   * Nothing readable (decision A): the image is deleted FIRST (a failure is retried while the item is still recognising), then the
   * photo and the placeholder are rejected for the answer's classification. There is never a retake for a shelf photo.
   *
   * Products are first collapsed (the same brand, name, variant and form, ignoring case and spacing, are one product; the first is
   * kept). Then, in turn, three limits drop the least confident (the recognizer lists the most confident first), each counted on the photo:
   * 5 per photo and the scan's `maxItemsPerScan` (both `skippedOverLimit`), then the day's allowance (`skippedDailyLimit`), which is
   * the smaller of the user's and the scan address's, the placeholder already counted. The placeholder is never dropped.
   *
   * One answer per photo: a fresh model answer is stored on the photo (`storeRecognition`, first writer wins) BEFORE anything else is
   * done, and the photo is read back, so every retry and every concurrent delivery goes on with the stored (winner's) answer. A
   * rejection whose `fanOut` failed after the image was deleted therefore retries into the same rejection, not `photo-missing`.
   *
   * Two accepted races, like `create`'s quota: the daily allowance is read, not reserved, so concurrent photos can each pass it and
   * the day may be exceeded by up to 4 extras per concurrent photo; and a sibling the SQL cap guard drops because another photo filled
   * the scan first is not counted in `skippedOverLimit` (the count was made from the items read before the write).
   */
  private async recogniseShelf(item: ScanItem, photo: ScanPhoto): Promise<void> {
    const read = await this.shelfRead(item, photo)
    if (!read) return
    if (read.products.length === 0) return this.rejectShelfPhoto(item, photo, read)

    const at = this.now()
    const scan = await this.repository.findScan(item.scanId)
    if (!scan) return
    const { products, overLimit } = await this.withinScanCap(item.scanId, ScanService.collapse(read.products))
    const extras = products.length - 1
    const allowed = Math.min(extras, await this.dailyAllowanceLeft(scan, at))
    const kept = products.slice(0, 1 + allowed)
    const stateOf = (product: ShelfProduct) => (product.confidence >= this.policy.confirmBelowConfidence ? ('matching' as const) : ('needs-confirmation' as const))
    const siblings: NewSibling[] = kept.slice(1).map((product, index) => ({
      id: this.newId(),
      scanId: item.scanId,
      userId: item.userId,
      position: photo.position * ScanService.PRODUCTS_PER_PHOTO + 1 + index,
      photoId: photo.id,
      photoKey: null,
      createdAt: at,
      state: stateOf(product),
      ...ScanService.recognisedFields(product),
    }))

    const { placeholderMoved } = await this.repository.fanOut({
      photo: { id: photo.id, patch: { state: 'recognised', recognition: JSON.stringify(read), ...ScanService.skipped({ read, overLimit, dailyLimit: extras - allowed }), updatedAt: at } },
      placeholder: { id: item.id, from: 'recognising', patch: { state: stateOf(kept[0]!), ...ScanService.recognisedFields(kept[0]!), updatedAt: at } },
      siblings,
      maxItems: this.policy.maxItemsPerScan,
    })
    if (!placeholderMoved) return
    // Before the placeholder's match is queued, which can fail and put the placeholder back: its retry goes on from the stored answer, not the image.
    // And before any event, so none links an image that is going. Nothing waiting for a confirmation means the image is not needed at all.
    await this.releasePhotos({ ...item, state: stateOf(kept[0]!) })
    await this.startShelfItems(item, photo, stateOf(kept[0]!), at)
  }

  /**
   * The photo's answer: the one stored with it by an earlier attempt or a concurrent delivery, else the recognizer's, stored first
   * and read back so that the answer used is the one that won. Undefined when the item has been failed instead.
   */
  private async shelfRead(item: ScanItem, photo: ScanPhoto): Promise<ShelfRecognition | undefined> {
    const earlier = ScanService.storedShelfRead(photo.recognition)
    if (earlier) return earlier
    const image = photo.photoKey === null ? null : await this.photos.get(photo.photoKey)
    if (!image) {
      await this.fail(item, 'recognising', 'photo-missing')
      return undefined
    }
    const fresh = await this.askRecognizer<ShelfRecognition>(item, () => this.recognizer.recognizeShelf(image), { classification: 'unreadable', products: [], excluded: { otherProducts: 0, unreadable: 0 } })
    await this.repository.storeRecognition(photo.id, JSON.stringify(fresh), this.now())
    const stored = ScanService.storedShelfRead((await this.repository.findPhoto(photo.id))?.recognition ?? null)
    return stored ?? fresh
  }

  /** No readable product: the image goes first, then the photo and its placeholder are rejected, and the scan may be done. */
  private async rejectShelfPhoto(item: ScanItem, photo: ScanPhoto, read: ShelfRecognition): Promise<void> {
    if (photo.photoKey !== null) await this.photos.delete(photo.photoKey)
    const at = this.now()
    const reason = read.classification === 'other-product' ? 'not-a-beauty-product' : read.classification === 'face-or-person' ? 'face-or-person' : 'unreadable'
    const { placeholderMoved } = await this.repository.fanOut({
      photo: { id: photo.id, patch: { state: 'rejected', photoKey: null, recognition: JSON.stringify(read), ...ScanService.skipped({ read, overLimit: 0, dailyLimit: 0 }), updatedAt: at } },
      placeholder: { id: item.id, from: 'recognising', patch: { state: 'rejected', reason, updatedAt: at } },
      siblings: [],
      maxItems: this.policy.maxItemsPerScan,
    })
    if (!placeholderMoved) return
    // Normally a no-op, the photo's key was cleared by the same batch; it matters when the photo had already been read and kept its key.
    await this.releasePhotos({ ...item, state: 'rejected' })
    await this.publishPhoto(item.scanId, photo.id)
    await this.publish(item.scanId, item.id)
  }

  /**
   * What follows a read whose placeholder moved: its `match` first (if it cannot be queued the move is undone and the error rethrown, as
   * `transition` does, and the retry reuses the stored answer), then each new item's, in rank order (a failure is logged by id and
   * left to the reaper, the item stays `matching`), one "needs you" push for the photo if any of its items waits for a confirmation, and
   * the item events. The placeholder's uses this attempt's time `at` (its move just stored it); each new item's uses its own stored `updatedAt`, which on a retry is the first attempt's, the key the reaper reuses.
   */
  private async startShelfItems(item: ScanItem, photo: ScanPhoto, placeholderState: 'matching' | 'needs-confirmation', at: Date): Promise<void> {
    if (placeholderState === 'matching') await this.queueNext(item, { from: 'recognising', to: 'matching', next: 'match', at })
    let all: ScanItem[]
    try {
      all = await this.repository.itemsOf(item.scanId)
    } catch {
      // The placeholder has moved and its step is queued: failing the job now would only be retried into a no-op.
      return void console.error({ outcome: 'publish-failed', scanId: item.scanId, itemId: item.id })
    }
    const mine = all.filter((candidate) => candidate.photoId === photo.id)
    for (const sibling of mine.filter((candidate) => candidate.id !== item.id && candidate.state === 'matching')) {
      try {
        await this.jobs.enqueue(advanceScanItemSpec, { itemId: sibling.id, step: 'match', at: sibling.updatedAt.getTime() })
      } catch {
        console.error({ outcome: 'enqueue-failed', scanId: item.scanId, itemId: sibling.id })
      }
    }
    const waiting = mine.find((candidate) => candidate.state === 'needs-confirmation')
    if (waiting) await this.notifyNeedsYou(waiting, 'confirm')
    await this.publishPhoto(item.scanId, photo.id)
    for (const published of mine) await this.publish(item.scanId, published.id)
  }

  /** Keeps the first 5 products and as many as the scan's cap leaves room for beside the items it holds, counting the rest as over the limit. The first is never dropped. */
  private async withinScanCap(scanId: string, products: ShelfProduct[]): Promise<{ products: ShelfProduct[]; overLimit: number }> {
    const held = (await this.repository.itemsOf(scanId)).length
    const room = Math.max(0, this.policy.maxItemsPerScan - held)
    const kept = products.slice(0, ScanService.PRODUCTS_PER_PHOTO).slice(0, 1 + room)
    return { products: kept, overLimit: products.length - kept.length }
  }

  /** How many more products the scan's user and its address may add today, the smaller of the two; every item already stored (the placeholder too) is counted. */
  private async dailyAllowanceLeft(scan: Scan, at: Date): Promise<number> {
    const totals = await this.dailyTotals(scan.userId, scan.ipHash, at)
    return Math.max(0, Math.min(...totals.map(({ taken, limit }) => limit - taken.count)))
  }

  private static storedShelfRead(json: string | null): ShelfRecognition | undefined {
    if (json === null) return undefined
    try {
      const parsed = JSON.parse(json) as Partial<ShelfRecognition> | null
      return parsed && Array.isArray(parsed.products) && parsed.excluded ? (parsed as ShelfRecognition) : undefined
    } catch {
      return undefined
    }
  }

  /** The same product, whatever its case or spacing, once; the first is kept. */
  private static collapse(products: ShelfProduct[]): ShelfProduct[] {
    const normal = (text: string | undefined) => (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
    const seen = new Set<string>()
    return products.filter((product) => {
      const key = JSON.stringify([product.brand, product.name, product.variant, product.form].map(normal))
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private static recognisedFields(product: ShelfProduct) {
    return {
      recognisedBrand: product.brand,
      recognisedName: product.name,
      recognisedVariant: product.variant || null,
      recognisedForm: product.form ?? null,
      recognisedCategory: product.category,
      recognisedConfidence: product.confidence,
    }
  }

  /** What the photo records of the products left out: the recognizer's own counts, and the ones the limits cut. */
  private static skipped({ read, overLimit, dailyLimit }: { read: ShelfRecognition; overLimit: number; dailyLimit: number }) {
    return { skippedNotBeauty: read.excluded.otherProducts, skippedUnreadable: read.excluded.unreadable, skippedOverLimit: overLimit, skippedDailyLimit: dailyLimit }
  }

  /**
   * What an earlier attempt already got from the model for this photo. Its answer is stored with the move out of
   * `recognising`; when that move was undone (the next step could not be queued) the answer stays, and asking again would pay twice.
   */
  private earlierRead(item: ScanItem): Recognition | undefined {
    if (item.recognisedBrand === null || item.recognisedName === null || item.recognisedCategory === null || item.recognisedConfidence === null) return undefined
    return {
      classification: 'beauty-product',
      brand: item.recognisedBrand,
      name: item.recognisedName,
      category: item.recognisedCategory,
      confidence: item.recognisedConfidence,
      ...(item.recognisedVariant === null ? {} : { variant: item.recognisedVariant }),
      ...(item.recognisedForm === null ? {} : { form: item.recognisedForm }),
    }
  }

  private async match(item: ScanItem): Promise<void> {
    if (item.state !== 'matching') return
    if (item.recognisedBrand === null || item.recognisedName === null || item.recognisedCategory === null) {
      await this.fail(item, 'matching', 'unavailable')
      return
    }
    const resolved = await this.catalog.resolve({
      brand: item.recognisedBrand,
      name: item.recognisedName,
      category: item.recognisedCategory,
      ...(item.recognisedVariant === null ? {} : { variant: item.recognisedVariant }),
      ...(item.recognisedForm === null ? {} : { form: item.recognisedForm }),
    })

    await this.moveOn(item, 'matching', resolved)
  }

  /**
   * Moves an item out of `from` to where the catalog says its product needs to go. `also` is what else the move writes, and `undo` what
   * puts it back if the next step cannot be queued.
   */
  private async moveOn(item: ScanItem, from: ItemState, resolved: ResolveResult, also: Omit<ItemPatch, 'updatedAt'> = {}, undo: Omit<ItemPatch, 'updatedAt'> = {}): Promise<boolean> {
    switch (resolved.kind) {
      case 'ready':
        return this.transition(item, { from, change: { ...also, state: 'ready', productId: resolved.productId, formulationId: resolved.formulationId }, undo })
      case 'needs-analysis':
        return this.transition(item, {
          from,
          change: { ...also, state: 'analysing', productId: resolved.productId, formulationId: resolved.formulationId },
          next: 'analyse',
          undo,
        })
      case 'analysis-failed':
        return this.transition(item, {
          from,
          change: { ...also, state: 'failed', reason: 'analysis-failed', productId: resolved.productId, formulationId: resolved.formulationId },
          undo,
        })
      case 'needs-research':
        return this.transition(item, { from, change: { ...also, state: 'researching', productId: resolved.productId }, next: 'research', undo })
    }
  }

  private async research(item: ScanItem): Promise<void> {
    if (item.state !== 'researching') return
    if (item.productId === null) {
      await this.fail(item, 'researching', 'unavailable')
      return
    }
    let result
    try {
      result = await this.catalog.research(item.productId)
    } catch (error) {
      if (!(error instanceof ResearchInProgressError)) throw error
      await this.waitFor(item, 'research')
      return
    }
    if (result.kind === 'found') {
      await this.transition(item, { from: 'researching', change: { state: 'analysing', formulationId: result.formulationId }, next: 'analyse' })
    } else if (result.fallbackFormulationId !== undefined) {
      // New ingredients could not be had, but an earlier analysed list can still be shown.
      await this.transition(item, { from: 'researching', change: { state: 'ready', formulationId: result.fallbackFormulationId } })
    } else if (result.kind === 'not-found') {
      if (await this.transition(item, { from: 'researching', change: { state: 'needs-back-photo' } })) await this.notifyNeedsYou(item, 'back-photo')
    } else {
      // Only the eval's spend cap answers this (the real ledger never refuses), so it cannot happen here; if it did, the queue would try again later.
      throw new CatalogBusyError()
    }
  }

  private async readLabel(item: ScanItem): Promise<void> {
    if (item.state !== 'reading-label') return
    const key = item.backPhotoKey
    const photo = key === null ? null : await this.photos.get(key)
    if (key === null || !photo) {
      // Nothing to read, and no way to know what the label said: ask for the photo again.
      await this.labelUnreadable(item)
      return
    }

    let reading: LabelReading
    try {
      reading = await this.labelReader.read(photo)
    } catch (error) {
      // A refusal, or an answer that cannot be used, is the same as a label that cannot be read: another photo may do better.
      if (!(error instanceof AnthropicRefusalError || error instanceof AnthropicRequestError)) throw error
      reading = { readable: false }
    }
    // An item with no product is being identified by this photo; one that has a product only needs its list.
    const productId = item.productId
    let filed: Filed | null = null
    if (reading.readable) {
      try {
        filed = productId === null ? await this.identify(reading) : { analysed: false, patch: { formulationId: await this.catalog.addLabelIngredients(productId, reading.ingredients) } }
      } catch (error) {
        // The catalog refuses a list that is empty, over its bounds, or carries a link or markup: the same as unreadable.
        if (!(error instanceof ValidationError && error.code === 'LABEL_UNREADABLE')) throw error
      }
    }
    if (filed === null) {
      // The back photo is deleted; the upload stays counted against the daily quota in its own record.
      await this.photos.delete(key)
      await this.labelUnreadable(item)
      return
    }
    // The photo is deleted after the move, not before: if the next step cannot be queued the move is undone, and the retry needs it.
    const moved = await this.transition(item, {
      from: 'reading-label',
      change: { ...filed.patch, state: filed.analysed ? 'ready' : 'analysing', backPhotoKey: null },
      next: filed.analysed ? undefined : 'analyse',
      undo: { backPhotoKey: key },
    })
    if (moved) await this.photos.delete(key).catch(() => console.error({ outcome: 'photo-cleanup-failed', scanId: item.scanId, itemId: item.id }))
  }

  /**
   * Files what an item's back photo gave when the item has no product: the catalog finds or creates the product the label names,
   * or keeps the bare list. The item shows what the label printed as what it was recognised as, but only when it printed both a
   * brand and a name; a list with no name leaves it absent.
   */
  private async identify(reading: Extract<LabelReading, { readable: true }>): Promise<Filed> {
    const filed = await this.catalog.fromLabel(reading)
    const patch = { productId: filed.productId, formulationId: filed.formulationId }
    if (reading.brand === undefined || reading.name === undefined) return { analysed: filed.analysed, patch }
    return {
      analysed: filed.analysed,
      patch: {
        ...patch,
        recognisedBrand: reading.brand,
        recognisedName: reading.name,
        recognisedVariant: reading.variant ?? null,
        recognisedCategory: reading.category ?? 'other',
      },
    }
  }

  /**
   * The back photo could not give a label. Asks for another, unless the item has had `maxBackPhotos` already: then it ends
   * as failed, keeping its front photo like the other failures. Every upload is counted, so the count includes this one.
   * An item with no product asks by offering identification again; one with a product, for the photo of its ingredients.
   */
  private async labelUnreadable(item: ScanItem): Promise<void> {
    const uploads = await this.repository.countBackPhotos(item.id)
    const ask = uploads < this.policy.maxBackPhotos
    const asking = item.productId === null ? 'needs-identification' : 'needs-back-photo'
    const moved = await this.transition(item, {
      from: 'reading-label',
      change: { state: ask ? asking : 'failed', reason: 'label-unreadable', backPhotoKey: null },
    })
    // The number of uploads so far is which time the item asks again, and the push's key.
    if (moved && ask) await this.notifyNeedsYou(item, item.productId === null ? 'identify' : 'back-photo', uploads)
  }

  private async analyse(item: ScanItem): Promise<void> {
    if (item.state !== 'analysing') return
    if (item.formulationId === null) {
      await this.fail(item, 'analysing', 'unavailable')
      return
    }
    try {
      await this.catalog.analyse(item.formulationId)
    } catch (error) {
      if (error instanceof AnalysisInProgressError) {
        await this.waitFor(item, 'analyse')
        return
      }
      if (error instanceof PermanentJobError) {
        // The catalog has given up on this formulation. Failing the item and rethrowing lets the job runner record the run as failed.
        await this.fail(item, 'analysing', 'analysis-failed')
      }
      throw error
    }
    await this.transition(item, { from: 'analysing', change: { state: 'ready' } })
  }

  private async fail(item: ScanItem, from: ItemState, reason: ItemReason): Promise<void> {
    await this.transition(item, { from, change: { state: 'failed', reason } })
  }

  /**
   * Another call is doing the work this step needs (the catalog says so). The item stays where it is and the same step
   * is queued again 30 seconds on, under a key of its own, so waiting uses none of the message's retries; the reaper's
   * 2 hour limit bounds it. A throw (the message cannot be queued) is left to the queue, which retries this step.
   */
  private async waitFor(item: ScanItem, step: ScanStep): Promise<void> {
    await this.jobs.enqueue(advanceScanItemSpec, { itemId: item.id, step, at: this.now().getTime() }, { delaySeconds: ScanService.WAIT_SECONDS })
  }

  /**
   * Claude refused our account (no credit, a bad key, permissions), which no user can fix. The item stays where it is and the same step
   * is queued again 5 minutes on, under a key of its own, so waiting uses none of the message's retries; the reaper's 2 hour limit
   * bounds it. The owner is emailed, at most once an hour however many items wait. A throw (the message cannot be queued) is left to the queue.
   */
  private async waitOnAccount(item: ScanItem, step: ScanStep): Promise<void> {
    await this.opsAlerts.raise('ai-account')
    await this.jobs.enqueue(advanceScanItemSpec, { itemId: item.id, step, at: this.now().getTime() }, { delaySeconds: ScanService.ACCOUNT_WAIT_SECONDS })
  }

  /**
   * Moves the item out of `from` with a guarded update. When it applied: queues the `next` step (stamped with the time
   * of the move, the key the reaper reuses), then tells watchers (best effort). Returns whether it applied; false means
   * the item had already moved on.
   *
   * If the next step cannot be queued the move is undone and the error rethrown: a retry of this step would otherwise
   * find the item moved on and do nothing, and the item would wait for ever. The undo puts back the item's reason, and
   * whatever else `undo` names (fields the change set that the old state must not keep).
   *
   * `backPhoto` and `retake` are the upload this move records for the daily quotas, written with the update. Neither is
   * undone: the photo was stored and sent, and the quota counts what was sent.
   */
  private async transition(
    item: ScanItem,
    { from, change, next, undo = {}, backPhoto, retake }: {
      from: ItemState
      change: Omit<ItemPatch, 'updatedAt'> & { state: ItemState }
      next?: ScanStep
      undo?: Omit<ItemPatch, 'updatedAt'>
      backPhoto?: NewBackPhoto
      retake?: NewRetake
    },
  ): Promise<boolean> {
    // One reading of the clock for both: the reaper repeats the step with the stored updatedAt, which must be this very key.
    const at = this.now()
    const applied = await this.repository.updateItem(item.id, from, { ...change, updatedAt: at }, backPhoto, retake)
    if (!applied) return false
    if (next) await this.queueNext(item, { from, to: change.state, next, at, undo })
    // After the next step is queued (a move that is undone must still have its photo), before the event, so the event never links a photo that is going.
    await this.releasePhotos({ ...item, state: change.state, photoKey: change.photoKey === undefined ? item.photoKey : change.photoKey })
    await this.publish(item.scanId, item.id)
    return true
  }

  /**
   * Lets go of the front photos an item that has just moved no longer needs; `item` is the item as the move left it. A photo is
   * wanted only while an item using it is `recognising` or `needs-confirmation`, because only then may the user be shown it. So the
   * item's own photo (a product scan's) goes when the item is in any other state, and its scan photo's image (a shelf scan's) goes
   * when no item of that photo is in either. It never fails the move and never undoes it: a photo that stays is found again by
   * the reaper.
   */
  private async releasePhotos(item: ScanItem): Promise<void> {
    const ids = { scanId: item.scanId, itemId: item.id }
    if (item.photoKey !== null && !ScanService.isHeld(item.state)) {
      await this.releaseKey(item.photoKey, ids, (key) => this.repository.clearItemPhotoKey(item.id, key))
    }
    if (item.photoId === null) return
    const photoId = item.photoId
    try {
      const photo = await this.repository.findPhoto(photoId)
      if (!photo?.photoKey) return
      const items = await this.repository.itemsOf(item.scanId)
      if (items.some((candidate) => candidate.photoId === photoId && ScanService.isHeld(candidate.state))) return
      await this.releaseKey(photo.photoKey, ids, (key) => this.repository.clearShelfPhotoKey(photoId, key))
    } catch {
      console.error({ outcome: 'photo-release-failed', ...ids })
    }
  }

  /** Deletes the object, THEN clears the key that named it: a key never points at nothing, and a failure between the two leaves the key for the reaper. Logs ids only, never the key. */
  private async releaseKey(key: string, ids: { scanId: string; itemId?: string; photoId?: string }, clear: (key: string) => Promise<boolean>): Promise<void> {
    try {
      await this.photos.delete(key)
      await clear(key)
    } catch {
      console.error({ outcome: 'photo-release-failed', ...ids })
    }
  }

  /**
   * Queues `next`, stamped `at`, for an item that has just moved from `from` to `to`. If it cannot be queued the move is undone (the item's
   * reason is put back, with whatever else `undo` names) and the error rethrown: see `transition`.
   */
  private async queueNext(item: ScanItem, { from, to, next, at, undo = {} }: { from: ItemState; to: ItemState; next: ScanStep; at: Date; undo?: Omit<ItemPatch, 'updatedAt'> }): Promise<void> {
    try {
      await this.jobs.enqueue(advanceScanItemSpec, { itemId: item.id, step: next, at: at.getTime() })
    } catch (error) {
      await this.repository
        .updateItem(item.id, to, { reason: item.reason, ...undo, state: from, updatedAt: this.now() })
        .catch(() => console.error({ outcome: 'undo-failed', scanId: item.scanId, itemId: item.id }))
      throw error
    }
  }

  /**
   * Sends the item as it now is, then `done` if it was the last to finish. `done` goes out once: only the call whose
   * guarded update sets the scan's done time sends it, so two items finishing together cannot both. If `done` cannot be
   * sent the time is cleared again, for the reaper. A failure is logged, never thrown: the change is already stored.
   */
  private async publish(scanId: string, itemId: string): Promise<void> {
    try {
      const items = await this.repository.itemsOf(scanId)
      const item = items.find((i) => i.id === itemId)
      if (!item) return
      await this.events.publish(scanId, { type: 'item', item: await this.itemView(item, this.now()) })
      if (ScanService.isFinal(item.state) && items.every((i) => ScanService.isFinal(i.state))) await this.sendDone(scanId, { always: false, items })
    } catch {
      console.error({ outcome: 'publish-failed', scanId, itemId })
    }
  }

  /** Sends the shelf photo as it now is, before the events of its items. A failure is logged, never thrown: the change is already stored. */
  private async publishPhoto(scanId: string, photoId: string): Promise<void> {
    try {
      const photo = await this.repository.findPhoto(photoId)
      if (photo) await this.events.publish(scanId, { type: 'photo', photo: ScanService.photoView(photo) })
    } catch {
      console.error({ outcome: 'publish-failed', scanId, photoId })
    }
  }

  /** An item is owned through its scan: the scan's profile decides, not the item's own user_id, which only feeds the quotas. */
  private async ownedItem(scanId: string, itemId: string): Promise<ScanItem> {
    const { items } = await this.ownedScan(scanId)
    const item = items.find((candidate) => candidate.id === itemId)
    if (!item) throw ScanService.scanNotFound()
    return item
  }

  /**
   * The noLabel view of each given item that has one, in one read, keyed by item id. Checks no ownership: the shelf asks only for
   * the items its own profile's rows point at, so the caller has already been decided. An item that is gone, or is not an unidentified
   * one with answers, is absent from the map.
   */
  async noLabelViews(itemIds: string[]): Promise<Map<string, NoLabelView>> {
    const views = new Map<string, NoLabelView>()
    if (itemIds.length === 0) return views
    for (const item of await this.repository.findItems([...new Set(itemIds)])) {
      const { noLabel } = this.noLabelView(item)
      if (noLabel) views.set(item.id, noLabel)
    }
    return views
  }

  private async itemViewOf(itemId: string): Promise<ScanItemView> {
    const item = await this.repository.findItem(itemId)
    if (!item) throw ScanService.scanNotFound()
    return this.itemView(item, this.now())
  }

  private static photoView(photo: ScanPhoto): ScanPhotoView {
    return {
      id: photo.id,
      position: photo.position,
      state: photo.state,
      skipped: { notBeauty: photo.skippedNotBeauty, unreadable: photo.skippedUnreadable, overLimit: photo.skippedOverLimit, dailyLimit: photo.skippedDailyLimit },
    }
  }

  private async scanView(scan: Pick<Scan, 'id' | 'createdAt' | 'kind'>, items: ScanItem[], now: Date): Promise<ScanView> {
    const photos = await this.repository.photosOf(scan.id)
    return { id: scan.id, createdAt: scan.createdAt, kind: scan.kind, photos: photos.map(ScanService.photoView), items: await Promise.all(items.map((item) => this.itemView(item, now, photos))) }
  }

  /** `photos` is the scan's photos when the caller already has them; without them a shelf item's photo is read for itself. */
  private async itemView(item: ScanItem, now: Date, photos?: ScanPhoto[]): Promise<ScanItemView> {
    const product = item.state === 'ready' && item.formulationId !== null ? await this.catalog.productSummary(item.formulationId) : undefined
    const stock = product?.imageUrl ?? null
    let image: ScanItemView['image'] = null
    if (stock !== null) {
      image = { kind: 'stock', url: stock }
    } else {
      // The item's own photo (a product scan), else its scan photo's (a shelf scan), in either case only while it is still stored.
      const photo = item.photoKey !== null || item.photoId === null ? undefined : (photos?.find((candidate) => candidate.id === item.photoId) ?? (await this.repository.findPhoto(item.photoId)))
      const key = item.photoKey ?? photo?.photoKey ?? null
      if (key !== null) {
        const expiresAt = new Date(now.getTime() + PHOTO_LINK_TTL_SECONDS * 1000)
        const token = await signPhotoLink({ key, userId: item.userId, expiresAt }, this.#photoLinkSecret, now)
        image = { kind: 'user', url: productPhotoUrl(token) }
      }
    }
    // A retake whose queueing failed keeps its row (the photo was sent), so a user can retake past the limit and the count must stop at 0.
    const retakesLeft = item.state === 'needs-retake' ? Math.max(0, this.policy.maxFrontPhotos - 1 - (await this.repository.countRetakes(item.id))) : undefined
    return {
      id: item.id,
      photoId: item.photoId,
      position: item.position,
      state: item.state,
      reason: item.reason,
      ...(retakesLeft === undefined ? {} : { retakesLeft }),
      ...(item.recognisedBrand !== null && item.recognisedName !== null && item.recognisedCategory !== null
        ? {
            recognised: {
              brand: item.recognisedBrand,
              name: item.recognisedName,
              variant: item.recognisedVariant,
              form: item.recognisedForm,
              category: item.recognisedCategory,
            },
          }
        : {}),
      ...(product ? { product } : {}),
      ...this.noLabelView(item),
      image,
    }
  }

  private noLabelView(item: ScanItem): Pick<ScanItemView, 'noLabel'> {
    if (item.state !== 'unidentified' || item.noLabelSource === null || item.noLabelPurpose === null || item.noLabelUsedFor === null) return {}
    const answers = { source: item.noLabelSource, purpose: item.noLabelPurpose, usedFor: item.noLabelUsedFor }
    return {
      noLabel: {
        ...answers,
        ...(item.noLabelDescription === null ? {} : { description: item.noLabelDescription }),
        concerns: cautionFor(answers),
        rulesVersion: CAUTION_RULES_VERSION,
      },
    }
  }

  /** Decides the type from the bytes, never from what the caller claims: only JPEG and WebP, within the size and edge limits. */
  private checkPhoto(photo: ProductImage): ValidPhoto {
    if (photo.bytes.length > this.policy.maxPhotoBytes) {
      throw new ValidationError('IMAGE_TOO_LARGE', `A photo is at most ${this.policy.maxPhotoBytes} bytes`)
    }
    const header = readImageHeader(photo.bytes)
    if (!header || header.mediaType === 'image/png') {
      throw new ValidationError('UNSUPPORTED_IMAGE', 'Photos must be JPEG or WebP')
    }
    if (Math.max(header.width, header.height) > this.policy.maxPhotoEdge) {
      throw new ValidationError('IMAGE_TOO_LARGE', `A photo is at most ${this.policy.maxPhotoEdge} pixels on its longest side`)
    }
    return { image: { bytes: photo.bytes, mediaType: header.mediaType }, extension: header.mediaType === 'image/webp' ? 'webp' : 'jpg' }
  }

  private cleanText(text: string, field: 'brand' | 'name' | 'variant' | 'text' | 'description', required: boolean, maxLength = ScanService.MAX_TEXT_LENGTH): string {
    const trimmed = text.trim()
    if ((required && trimmed === '') || trimmed.length > maxLength || hasLinkOrMarkup(trimmed) || ScanService.HIDDEN_CHARACTER.test(trimmed)) {
      throw new ValidationError('INVALID_PRODUCT_TEXT', `The ${field} is not valid`, { field })
    }
    return trimmed
  }

  private photoKey(userId: string, scanId: string, itemId: string, extension: string): string {
    return `photos/${this.environment}/${userId}/${scanId}/${itemId}.${extension}`
  }

  /** HMAC-SHA-256 of the address under a key derived from ipHashSecret. The raw address is never stored or logged. */
  private async hashIp(ip: string): Promise<string> {
    return hmacSha256Hex(await hmacSha256Hex(this.#ipHashSecret, ScanService.IP_HASH_INFO), ip)
  }

  /**
   * Refuses when `adding` more photos would pass the user's or the address's quota over the last 24 hours (a photo taken
   * exactly 24 hours ago still counts). The wait is until the oldest counted photo leaves the window.
   */
  private async assertWithinQuota(userId: string, ipHash: string, adding: number, now: Date): Promise<void> {
    const waits: number[] = []
    for (const { taken, limit } of await this.dailyTotals(userId, ipHash, now)) {
      if (taken.count + adding <= limit) continue
      waits.push(taken.oldest ? Math.max(1, Math.ceil((taken.oldest.getTime() + ScanService.DAY - now.getTime()) / 1000)) : 60)
    }
    if (waits.length > 0) {
      throw new RateLimitedError('SCAN_DAILY_LIMIT', 'You have reached the daily limit for product photos', { retryAfterSeconds: Math.max(...waits) })
    }
  }

  /** What the user and the address have taken in the last 24 hours, each with its limit. */
  private async dailyTotals(userId: string, ipHash: string, now: Date) {
    const since = new Date(now.getTime() - ScanService.DAY)
    const [mine, theirs] = await Promise.all([this.repository.photosSince(userId, since), this.repository.photosSinceIp(ipHash, since)])
    return [
      { taken: mine, limit: this.policy.dailyPhotosPerUser },
      { taken: theirs, limit: this.policy.dailyPhotosPerIp },
    ]
  }
}
