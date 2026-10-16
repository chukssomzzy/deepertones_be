import { PermanentJobError } from '../../jobs/job'
import { requireUser } from '../../lib/context'
import { hmacSha256Hex } from '../../lib/crypto'
import { ConflictError, NotFoundError, RateLimitedError, ValidationError } from '../../lib/errors'
import { readImageHeader } from '../../lib/image-header'
import { PHOTO_LINK_TTL_SECONDS, signPhotoLink, verifyPhotoLink } from '../../lib/photo-link'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { AiBudgetExceededError } from '../../providers/anthropic/ai-spend.provider'
import { AnthropicRefusalError, AnthropicRequestError } from '../../providers/anthropic/anthropic.provider'
import type { LabelReader, LabelReading } from '../../providers/label-reading/label-reader.provider'
import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import type { PhotoEnvironment, PhotoStore } from '../../providers/photo-store/photo-store.provider'
import type { ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import type { ProductRecognizer, Recognition } from '../../providers/product-recognition/product-recognizer.provider'
import type { ProductCategory } from '../../providers/product-research/product-researcher.provider'
import type { ScanEvents } from '../../providers/scan-events/scan-events.provider'
import { AnalysisInProgressError, CatalogBusyError, type ProductCatalogService, type ProductView, ResearchInProgressError } from '../catalog/catalog.service'
import { advanceScanItemSpec, type ScanStep } from './scans.job-specs'
import type { ScansRepository } from './scans.repository'
import type { ItemPatch, ItemReason, ItemState, NewBackPhoto, NewScanItem, Scan, ScanItem } from './scans.types'

export type ScanPolicy = {
  maxPhotosPerScan: number
  maxPhotoBytes: number
  /** The longest side, in pixels, of a photo we accept. */
  maxPhotoEdge: number
  dailyPhotosPerUser: number
  dailyPhotosPerIp: number
  /** A read below this confidence waits for the user to confirm it. */
  confirmBelowConfidence: number
}

export const SCAN_POLICY: ScanPolicy = {
  maxPhotosPerScan: 10,
  maxPhotoBytes: 2_000_000,
  maxPhotoEdge: 1600,
  dailyPhotosPerUser: 30,
  dailyPhotosPerIp: 100,
  confirmBelowConfidence: 0.6,
}

/** What the app shows for one item. Built by the service so a presenter, the stream and the events all say the same thing. */
export type ScanItemView = {
  id: string
  position: number
  state: ItemState
  reason: ItemReason | null
  /** What the photo was read as (or what the user corrected it to); absent until it has been read. */
  recognised?: { brand: string; name: string; variant: string | null; category: ProductCategory }
  /** Only on a ready item. */
  product?: ProductView
  /** The product's stock image if it has one, else the user's own photo through a signed link, else none. */
  image: { kind: 'stock' | 'user'; url: string } | null
}

export type ScanView = { id: string; createdAt: Date; items: ScanItemView[] }

export type ConfirmedProduct = { brand: string; name: string; variant?: string; category: ProductCategory }

export type ScanServiceDeps = {
  repository: ScansRepository
  catalog: ProductCatalogService
  recognizer: ProductRecognizer
  labelReader: LabelReader
  photos: PhotoStore
  jobs: JobQueue
  events: ScanEvents
  /** Signs the photo links. photo-link.ts derives its own key from it. */
  photoLinkSecret: string
  /** Keys the IP hash, so a leaked table cannot be reversed by hashing every address. */
  ipHashSecret: string
  environment: PhotoEnvironment
  now?: () => Date
  newId?: () => string
  policy?: ScanPolicy
}

// Spelled out because a type query cannot name a private member.
type WorkingState = 'recognising' | 'matching' | 'researching' | 'reading-label' | 'analysing'
type ValidPhoto = { image: ProductImage; extension: 'jpg' | 'webp' }

export class ScanService {
  private static readonly MINUTE = 60 * 1000
  private static readonly HOUR = 60 * ScanService.MINUTE
  private static readonly DAY = 24 * ScanService.HOUR
  private static readonly MAX_TEXT_LENGTH = 120
  // Names the use of ipHashSecret; a different info derives an unrelated key, so this one is not the device-id hashing key.
  private static readonly IP_HASH_INFO = 'deepertones/ip-hash/v1'
  private static readonly FINAL_STATES: readonly ItemState[] = ['ready', 'rejected', 'failed']
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
  /** One sweep looks at this many items at most, oldest first, which keeps its calls well inside a Worker's limit. */
  private static readonly REAP_BATCH = 100
  /** How long a step waits before it asks again whether work another call is doing has finished. */
  private static readonly WAIT_SECONDS = 30

  private static scanNotFound = () => new NotFoundError('SCAN_NOT_FOUND', 'Scan not found')
  private static photoNotFound = () => new NotFoundError('PHOTO_NOT_FOUND', 'Photo not found')
  private static isFinal = (state: ItemState) => ScanService.FINAL_STATES.includes(state)

  private readonly repository: ScansRepository
  private readonly catalog: ProductCatalogService
  private readonly recognizer: ProductRecognizer
  private readonly labelReader: LabelReader
  private readonly photos: PhotoStore
  private readonly jobs: JobQueue
  private readonly events: ScanEvents
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
    this.photos = deps.photos
    this.jobs = deps.jobs
    this.events = deps.events
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
    const { userId } = requireUser()
    if (input.photos.length === 0) throw new ValidationError('NO_IMAGES', 'Send at least one photo')
    if (input.photos.length > this.policy.maxPhotosPerScan) {
      throw new ValidationError('TOO_MANY_IMAGES', `A scan holds at most ${this.policy.maxPhotosPerScan} photos`)
    }
    const valid = input.photos.map((photo) => this.checkPhoto(photo))
    const now = this.now()
    const ipHash = await this.hashIp(input.clientIp)
    await this.assertWithinQuota(userId, ipHash, valid.length, now)

    const scanId = this.newId()
    const stored = valid.map((photo, position) => {
      const id = this.newId()
      const item: NewScanItem = { id, scanId, userId, position, photoKey: this.photoKey(userId, scanId, id, photo.extension), createdAt: now }
      return { item, image: photo.image }
    })
    try {
      await Promise.all(stored.map(({ item, image }) => this.photos.put(item.photoKey, image)))
      await this.repository.createScan({ id: scanId, userId, ipHash, createdAt: now }, stored.map(({ item }) => item))
    } catch (error) {
      await this.photos.deleteMany(stored.map(({ item }) => item.photoKey)).catch(() => console.error({ outcome: 'photo-cleanup-failed', scanId }))
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
    return this.scanView({ id: scanId, createdAt: now }, await this.repository.itemsOf(scanId), now)
  }

  /** The scan as it now is. Another user's scan is SCAN_NOT_FOUND, with no hint that it exists. */
  async getScan(scanId: string): Promise<ScanView> {
    const { userId } = requireUser()
    const scan = await this.repository.findScan(scanId)
    if (!scan || scan.userId !== userId) throw ScanService.scanNotFound()
    return this.scanView(scan, await this.repository.itemsOf(scanId), this.now())
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
        recognisedCategory: fields.category,
      },
      next: 'match',
    })
    if (!moved) throw new ConflictError('ITEM_NOT_AWAITING_CONFIRMATION', 'This item is not waiting for confirmation')
    return this.itemViewOf(itemId)
  }

  /**
   * The photo of the ingredient list, for an item that asked for one. It counts as one photo against both daily quotas,
   * however many an item has had (each upload is recorded, for the address it came from, in the same write that moves the
   * item on), is checked like a front photo, and is kept next to the front one as `<item id>-back.<jpg|webp>`.
   */
  async addBackPhoto(scanId: string, itemId: string, photo: ProductImage, clientIp: string): Promise<ScanItemView> {
    const item = await this.ownedItem(scanId, itemId)
    const notAwaiting = () => new ConflictError('ITEM_NOT_AWAITING_BACK_PHOTO', 'This item is not waiting for a photo of the back')
    if (item.state !== 'needs-back-photo') throw notAwaiting()
    const valid = this.checkPhoto(photo)
    const now = this.now()
    const ipHash = await this.hashIp(clientIp)
    await this.assertWithinQuota(item.userId, ipHash, 1, now)

    const key = this.photoKey(item.userId, scanId, `${itemId}-back`, valid.extension)
    await this.photos.put(key, valid.image)
    let moved = false
    try {
      moved = await this.transition(item, {
        from: 'needs-back-photo',
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
   * user is never touched. A failure on one item is logged by id and does not stop the sweep.
   *
   * `now` is passed in so the cutoffs are fixed for the whole sweep; the changes it makes are stamped by the service's clock.
   */
  async reap(now: Date): Promise<{ requeued: number; failed: number }> {
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
    return { requeued, failed }
  }

  private async recognise(item: ScanItem): Promise<void> {
    if (item.state !== 'recognising') return
    let seen = this.earlierRead(item)
    if (!seen) {
      const photo = item.photoKey === null ? null : await this.photos.get(item.photoKey)
      if (item.photoKey === null || !photo) {
        await this.fail(item, 'recognising', 'photo-missing')
        return
      }
      try {
        seen = await this.recognizer.recognize(photo)
      } catch (error) {
        if (error instanceof AiBudgetExceededError) {
          await this.fail(item, 'recognising', 'research-busy')
          return
        }
        // The model declined to look at the photo: a photo nothing can be read from.
        if (!(error instanceof AnthropicRefusalError)) {
          if (error instanceof AnthropicRequestError) {
            // The same photo would get the same answer, so a retry would only pay again.
            await this.fail(item, 'recognising', 'unavailable')
            throw new PermanentJobError('The model gave no usable answer for this photo', { cause: error })
          }
          throw error
        }
        seen = { classification: 'unreadable' }
      }
    }

    if (seen.classification === 'beauty-product') {
      const sure = seen.confidence >= this.policy.confirmBelowConfidence
      await this.transition(item, {
        from: 'recognising',
        change: {
          state: sure ? 'matching' : 'needs-confirmation',
          recognisedBrand: seen.brand,
          recognisedName: seen.name,
          recognisedVariant: seen.variant || null,
          recognisedCategory: seen.category,
          recognisedConfidence: seen.confidence,
        },
        next: sure ? 'match' : undefined,
      })
      return
    }

    // A photo we will not use is deleted at once, before the row says so: a failure here is retried while the item is still recognising.
    if (item.photoKey !== null) await this.photos.delete(item.photoKey)
    const reason = { 'face-or-person': 'face-or-person', 'other-product': 'not-a-beauty-product', unreadable: 'unreadable' } as const
    await this.transition(item, { from: 'recognising', change: { state: 'rejected', reason: reason[seen.classification], photoKey: null } })
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
    }
  }

  private async match(item: ScanItem): Promise<void> {
    if (item.state !== 'matching') return
    if (item.recognisedBrand === null || item.recognisedName === null || item.recognisedCategory === null) {
      await this.fail(item, 'matching', 'unavailable')
      return
    }
    let resolved
    try {
      resolved = await this.catalog.resolve({
        brand: item.recognisedBrand,
        name: item.recognisedName,
        category: item.recognisedCategory,
        ...(item.recognisedVariant === null ? {} : { variant: item.recognisedVariant }),
      })
    } catch (error) {
      if (!(error instanceof CatalogBusyError)) throw error
      await this.fail(item, 'matching', 'research-busy')
      return
    }

    switch (resolved.kind) {
      case 'ready':
        await this.transition(item, { from: 'matching', change: { state: 'ready', productId: resolved.productId, formulationId: resolved.formulationId } })
        return
      case 'needs-analysis':
        await this.transition(item, {
          from: 'matching',
          change: { state: 'analysing', productId: resolved.productId, formulationId: resolved.formulationId },
          next: 'analyse',
        })
        return
      case 'analysis-failed':
        await this.transition(item, {
          from: 'matching',
          change: { state: 'failed', reason: 'analysis-failed', productId: resolved.productId, formulationId: resolved.formulationId },
        })
        return
      case 'needs-research':
        await this.transition(item, { from: 'matching', change: { state: 'researching', productId: resolved.productId }, next: 'research' })
        return
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
      await this.transition(item, { from: 'researching', change: { state: 'needs-back-photo' } })
    } else {
      await this.fail(item, 'researching', 'research-busy')
    }
  }

  private async readLabel(item: ScanItem): Promise<void> {
    if (item.state !== 'reading-label') return
    if (item.productId === null) {
      await this.fail(item, 'reading-label', 'unavailable')
      return
    }
    const key = item.backPhotoKey
    const photo = key === null ? null : await this.photos.get(key)
    if (key === null || !photo) {
      // Nothing to read, and no way to know what the label said: ask for the photo again.
      await this.transition(item, { from: 'reading-label', change: { state: 'needs-back-photo', reason: 'label-unreadable', backPhotoKey: null } })
      return
    }

    let reading: LabelReading
    try {
      reading = await this.labelReader.read(photo)
    } catch (error) {
      if (error instanceof AiBudgetExceededError) {
        await this.fail(item, 'reading-label', 'research-busy')
        return
      }
      // A refusal, or an answer that cannot be used, is the same as a label that cannot be read: another photo may do better.
      if (!(error instanceof AnthropicRefusalError || error instanceof AnthropicRequestError)) throw error
      reading = { readable: false }
    }
    let formulationId: string | null = null
    if (reading.readable) {
      try {
        formulationId = await this.catalog.addLabelIngredients(item.productId, reading.ingredients)
      } catch (error) {
        // The catalog refuses a list that is empty, over its bounds, or carries a link or markup: the same as unreadable.
        if (!(error instanceof ValidationError && error.code === 'LABEL_UNREADABLE')) throw error
      }
    }
    if (formulationId === null) {
      // The back photo is deleted; the upload stays counted against the daily quota in its own record.
      await this.photos.delete(key)
      await this.transition(item, { from: 'reading-label', change: { state: 'needs-back-photo', reason: 'label-unreadable', backPhotoKey: null } })
      return
    }
    // The photo is deleted after the move, not before: if the next step cannot be queued the move is undone, and the retry needs it.
    const moved = await this.transition(item, {
      from: 'reading-label',
      change: { state: 'analysing', formulationId, backPhotoKey: null },
      next: 'analyse',
      undo: { backPhotoKey: key },
    })
    if (moved) await this.photos.delete(key).catch(() => console.error({ outcome: 'photo-cleanup-failed', scanId: item.scanId, itemId: item.id }))
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
      if (error instanceof CatalogBusyError) {
        await this.fail(item, 'analysing', 'research-busy')
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
   * Moves the item out of `from` with a guarded update. When it applied: queues the `next` step (stamped with the time
   * of the move, the key the reaper reuses), then tells watchers (best effort). Returns whether it applied; false means
   * the item had already moved on.
   *
   * If the next step cannot be queued the move is undone and the error rethrown: a retry of this step would otherwise
   * find the item moved on and do nothing, and the item would wait for ever. The undo puts back the item's reason, and
   * whatever else `undo` names (fields the change set that the old state must not keep).
   *
   * `backPhoto` is the upload this move records for the daily quotas, written with the update. It is not undone: the
   * photo was stored and sent, and the quota counts what was sent.
   */
  private async transition(
    item: ScanItem,
    { from, change, next, undo = {}, backPhoto }: {
      from: ItemState
      change: Omit<ItemPatch, 'updatedAt'> & { state: ItemState }
      next?: ScanStep
      undo?: Omit<ItemPatch, 'updatedAt'>
      backPhoto?: NewBackPhoto
    },
  ): Promise<boolean> {
    // One reading of the clock for both: the reaper repeats the step with the stored updatedAt, which must be this very key.
    const at = this.now()
    const applied = await this.repository.updateItem(item.id, from, { ...change, updatedAt: at }, backPhoto)
    if (!applied) return false
    if (next) {
      try {
        await this.jobs.enqueue(advanceScanItemSpec, { itemId: item.id, step: next, at: at.getTime() })
      } catch (error) {
        await this.repository
          .updateItem(item.id, change.state, { reason: item.reason, ...undo, state: from, updatedAt: this.now() })
          .catch(() => console.error({ outcome: 'undo-failed', scanId: item.scanId, itemId: item.id }))
        throw error
      }
    }
    await this.publish(item.scanId, item.id)
    return true
  }

  /**
   * Sends the item as it now is, then `done` if it was the last to finish. `done` goes out once: only the call whose
   * guarded update sets the scan's done time sends it, so two items finishing together cannot both. A failure is logged,
   * never thrown: the change is already stored.
   */
  private async publish(scanId: string, itemId: string): Promise<void> {
    try {
      const items = await this.repository.itemsOf(scanId)
      const item = items.find((i) => i.id === itemId)
      if (!item) return
      await this.events.publish(scanId, { type: 'item', item: await this.itemView(item, this.now()) })
      if (ScanService.isFinal(item.state) && items.every((i) => ScanService.isFinal(i.state)) && (await this.repository.markScanDone(scanId, this.now()))) {
        await this.events.publish(scanId, { type: 'done' })
      }
    } catch {
      console.error({ outcome: 'publish-failed', scanId, itemId })
    }
  }

  private async ownedItem(scanId: string, itemId: string): Promise<ScanItem> {
    const { userId } = requireUser()
    const item = await this.repository.findItem(itemId)
    if (!item || item.scanId !== scanId || item.userId !== userId) throw ScanService.scanNotFound()
    return item
  }

  private async itemViewOf(itemId: string): Promise<ScanItemView> {
    const item = await this.repository.findItem(itemId)
    if (!item) throw ScanService.scanNotFound()
    return this.itemView(item, this.now())
  }

  private async scanView(scan: Pick<Scan, 'id' | 'createdAt'>, items: ScanItem[], now: Date): Promise<ScanView> {
    return { id: scan.id, createdAt: scan.createdAt, items: await Promise.all(items.map((item) => this.itemView(item, now))) }
  }

  private async itemView(item: ScanItem, now: Date): Promise<ScanItemView> {
    const product = item.state === 'ready' && item.formulationId !== null ? await this.catalog.productView(item.formulationId) : undefined
    const stock = product?.product.imageUrl ?? null
    let image: ScanItemView['image'] = null
    if (stock !== null) {
      image = { kind: 'stock', url: stock }
    } else if (item.photoKey !== null) {
      const expiresAt = new Date(now.getTime() + PHOTO_LINK_TTL_SECONDS * 1000)
      const token = await signPhotoLink({ key: item.photoKey, userId: item.userId, expiresAt }, this.#photoLinkSecret, now)
      image = { kind: 'user', url: `/scans/photos/${token}` }
    }
    return {
      id: item.id,
      position: item.position,
      state: item.state,
      reason: item.reason,
      ...(item.recognisedBrand !== null && item.recognisedName !== null && item.recognisedCategory !== null
        ? { recognised: { brand: item.recognisedBrand, name: item.recognisedName, variant: item.recognisedVariant, category: item.recognisedCategory } }
        : {}),
      ...(product ? { product } : {}),
      image,
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

  private cleanText(text: string, field: 'brand' | 'name' | 'variant', required: boolean): string {
    const trimmed = text.trim()
    if ((required && trimmed === '') || trimmed.length > ScanService.MAX_TEXT_LENGTH || hasLinkOrMarkup(trimmed) || ScanService.HIDDEN_CHARACTER.test(trimmed)) {
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
    const since = new Date(now.getTime() - ScanService.DAY)
    const [mine, theirs] = await Promise.all([this.repository.photosSince(userId, since), this.repository.photosSinceIp(ipHash, since)])
    const waits: number[] = []
    for (const [taken, limit] of [
      [mine, this.policy.dailyPhotosPerUser],
      [theirs, this.policy.dailyPhotosPerIp],
    ] as const) {
      if (taken.count + adding <= limit) continue
      waits.push(taken.oldest ? Math.max(1, Math.ceil((taken.oldest.getTime() + ScanService.DAY - now.getTime()) / 1000)) : 60)
    }
    if (waits.length > 0) {
      throw new RateLimitedError('SCAN_DAILY_LIMIT', 'You have reached the daily limit for product photos', { retryAfterSeconds: Math.max(...waits) })
    }
  }
}
