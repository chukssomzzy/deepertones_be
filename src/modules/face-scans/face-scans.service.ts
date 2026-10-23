import { PermanentJobError } from '../../jobs/job'
import { requireUser, requireVerified } from '../../lib/context'
import { ConflictError, NotFoundError, RateLimitedError, UnauthorizedError, UnavailableError, ValidationError } from '../../lib/errors'
import { describeImageBytes, readImageHeader } from '../../lib/image-header'
import { PHOTO_LINK_TTL_SECONDS, signPhotoLink, verifyPhotoLink } from '../../lib/photo-link'
import { describeUnexpectedError } from '../../lib/safe-error'
import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import {
  type ConcernScore,
  type FitzpatrickResult,
  type PerfectCorpClient,
  PerfectCorpBadRequestError,
  PerfectCorpCreditError,
  PerfectCorpRejectedPhotoError,
  type RejectedPhotoReason,
  type SkinAnalysisResult,
} from '../../providers/perfect-corp/perfect-corp.provider'
import type { VendorSpendLedger } from '../../providers/perfect-corp/vendor-spend.provider'
import type { PhotoEnvironment, PhotoStore } from '../../providers/photo-store/photo-store.provider'
import type { ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import type { FaceScanFrame, ScanEvents } from '../../providers/scan-events/scan-events.provider'
import type { GoalsService } from '../goals/goals.service'
import type { Goal } from '../goals/goals.vocabulary'
import type { NotificationsService } from '../notifications/notifications.service'
import type { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import { facePhotoUrl } from '../scans/scans.paths'
import { CURRENT_FACE_CONSENT_VERSION } from './face-scans.consent'
import { type AnalyseFaceScanMessage, analyseFaceScanSpec } from './face-scans.job-specs'
import { mayScanNow } from './face-scans.policy'
import type { FaceScansRepository } from './face-scans.repository'
import { concernsForGoal, hdActionsForGoal, measuredConcernsForGoal, noticedConcerns, type ResultView, resultView, shownConcerns, type SkinTypeLabel, skinTypeLabel, TABLES_VERSION } from './face-scans.tables'
import type { FaceMask, FacePhotoPosition, FaceResult, FaceScan, FaceScanPhoto, FaceScanReason, FaceScanState, NewFacePhoto } from './face-scans.types'

export type FaceScanPolicy = {
  /** The most bytes one face photo may be. */
  maxPhotoBytes: number
  /** The shortest short side, in pixels, of a face photo: Perfect Corp needs this much face to read. */
  minShortSide: number
}

// The longest side is capped at 4096 px by readImageHeader, which reads a larger header as no image at all.
export const FACE_SCAN_POLICY: FaceScanPolicy = { maxPhotoBytes: 6_000_000, minShortSide: 1080 }

/** How many scans `listFaceScans` returns: the latest ones. Face scans are rare (one per goal or check-in), so this covers years. */
export const FACE_SCAN_LIST_LIMIT = 20

/** The photos of a scan, by position. Only the front one is required. */
export type FacePhotos = { front: ProductImage; right?: ProductImage; left?: ProductImage }

export type FaceConsentGiven = { version: number; givenAt: Date }

/** `current` is true while the consent is for the current wording and not withdrawn. */
export type FaceConsentView = { version: number; givenAt: Date; withdrawnAt: Date | null; current: boolean }

/** What the app shows for a face scan. `result` is there once the scan is ready and null before. */
export type FaceScanView = {
  id: string
  state: FaceScanState
  reason: FaceScanReason | null
  /** The goal the scan was taken under, whatever the profile's goal is now. */
  goal: Goal
  createdAt: Date
  photos: Partial<Record<FacePhotoPosition, { url: string }>>
  /** True when the profile's latest scan was taken under a goal other than its current one. Worked out when read, never stored. */
  rescanSuggested: boolean
  result: ResultView | null
}

/** The view of a scan that was retaken: it always has its front photo. */
export type RetakenFaceScanView = FaceScanView & { photos: { front: { url: string } } }

export type FaceScanServiceDeps = {
  repository: FaceScansRepository
  goals: Pick<GoalsService, 'requireGoal' | 'current'>
  photos: PhotoStore
  jobs: JobQueue
  perfectCorp: PerfectCorpClient
  /** Records what each Perfect Corp result cost. */
  aiUsage: VendorSpendLedger
  /** Tells whoever is watching a scan that it changed. */
  events: ScanEvents
  /** Tells the person's phone when a scan is ready or needs a retake. Never throws: a push that cannot be queued does not fail a step. */
  notifications: Pick<NotificationsService, 'faceScanReady' | 'faceScanNeedsRetake'>
  /** A Perfect Corp account problem is raised to the owner here. */
  opsAlerts: Pick<OpsAlertsService, 'raise'>
  /** Signs the photo links. photo-link.ts derives its own key from it. */
  photoLinkSecret: string
  environment: PhotoEnvironment
  now?: () => Date
  newId?: () => string
  policy?: FaceScanPolicy
}

const POSITIONS: readonly FacePhotoPosition[] = ['front', 'right', 'left']

/** What Perfect Corp charges for an HD skin analysis, by the number of actions asked for (1 to 4, 5 to 8, 9 to 12, 13 to 16). Every goal asks for 5 to 8. */
const unitsForActions = (actions: number): number => (actions <= 4 ? 12 : actions <= 8 ? 16 : actions <= 12 ? 20 : 22)
/** What a Fitzpatrick read costs. */
const FITZPATRICK_UNITS = 10

export class FaceScanService {
  private static faceScanNotFound = () => new NotFoundError('FACE_SCAN_NOT_FOUND', 'Face scan not found')
  private static notDue = (reason: 'already-scanned-for-goal') => new RateLimitedError('FACE_SCAN_NOT_DUE', 'A face scan is not due yet', { reason })
  private static photoNotFound = () => new NotFoundError('PHOTO_NOT_FOUND', 'Photo not found')
  private static notAwaitingRetake = () => new ConflictError('FACE_SCAN_NOT_AWAITING_RETAKE', 'This face scan is not waiting for a retake')
  private static consentRequired = () => new ConflictError('FACE_CONSENT_REQUIRED', 'Say yes to the face photo consent first')

  private static readonly MINUTE = 60 * 1000
  /** The reaper looks once at an analysing scan that has sat this long (the webhook normally comes long before), and fails it once it has sat the second. */
  private static readonly STUCK_AFTER_MS = 15 * FaceScanService.MINUTE
  private static readonly GIVE_UP_AFTER_MS = 120 * FaceScanService.MINUTE
  private static readonly REAP_BATCH = 100

  private readonly repository: FaceScansRepository
  private readonly goals: Pick<GoalsService, 'requireGoal' | 'current'>
  private readonly photos: PhotoStore
  private readonly jobs: JobQueue
  private readonly perfectCorp: PerfectCorpClient
  private readonly aiUsage: VendorSpendLedger
  private readonly events: ScanEvents
  private readonly notifications: Pick<NotificationsService, 'faceScanReady' | 'faceScanNeedsRetake'>
  private readonly opsAlerts: Pick<OpsAlertsService, 'raise'>
  readonly #photoLinkSecret: string
  private readonly environment: PhotoEnvironment
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly policy: FaceScanPolicy

  constructor(deps: FaceScanServiceDeps) {
    this.repository = deps.repository
    this.goals = deps.goals
    this.photos = deps.photos
    this.jobs = deps.jobs
    this.perfectCorp = deps.perfectCorp
    this.aiUsage = deps.aiUsage
    this.events = deps.events
    this.notifications = deps.notifications
    this.opsAlerts = deps.opsAlerts
    this.#photoLinkSecret = deps.photoLinkSecret
    this.environment = deps.environment
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
    this.policy = deps.policy ?? FACE_SCAN_POLICY
  }

  /** Records the caller's profile's consent for the current wording. Any other version is 400 FACE_CONSENT_VERSION_MISMATCH, which says which is current. */
  async giveConsent(version: number): Promise<FaceConsentGiven> {
    const { userId, profileId } = requireUser()
    if (version !== CURRENT_FACE_CONSENT_VERSION) {
      throw new ValidationError('FACE_CONSENT_VERSION_MISMATCH', 'That is not the current version of the face photo consent', { current: CURRENT_FACE_CONSENT_VERSION })
    }
    const at = this.now()
    await this.repository.giveConsent({ profileId, userId, version, at })
    return { version, givenAt: at }
  }

  /** Withdraws the profile's consent, keeping the record. Nothing to withdraw is not an error. */
  async withdrawConsent(): Promise<void> {
    const { profileId } = requireVerified()
    await this.repository.withdrawConsent(profileId, this.now())
  }

  async consent(): Promise<FaceConsentView> {
    const { profileId } = requireVerified()
    const found = await this.repository.consentOf(profileId)
    if (!found) throw new NotFoundError('FACE_CONSENT_NOT_FOUND', 'No face photo consent has been given')
    return { version: found.version, givenAt: found.givenAt, withdrawnAt: found.withdrawnAt, current: FaceScanService.isCurrent(found) }
  }

  /**
   * Starts a face scan. The checks run in this order, and nothing is stored or queued until all pass: consent (409 FACE_CONSENT_REQUIRED),
   * the goal (409 GOAL_REQUIRED), whether a scan is due (429 FACE_SCAN_NOT_DUE) and then every photo (400). The photos are put in the
   * private bucket BEFORE the scan is saved, so a saved scan never points at a missing photo; if saving fails they are deleted again. When
   * the job cannot be queued the scan is marked failed as unavailable and still returned, so the user can see and delete it.
   */
  async create(photos: FacePhotos): Promise<FaceScanView> {
    const { userId, profileId } = requireUser()
    await this.requireCurrentConsent(profileId)
    const goal = (await this.goals.requireGoal()).goal
    if (goal === null) throw new ConflictError('GOAL_REQUIRED', 'Pick a goal first')
    const latest = await this.repository.latestForProfile(profileId)
    const verdict = mayScanNow({ goal, latest })
    if (!verdict.allowed) throw FaceScanService.notDue(verdict.reason)

    const valid = POSITIONS.flatMap((position) => {
      const photo = photos[position]
      return photo ? [{ position, image: this.checkPhoto(photo) }] : []
    })

    const now = this.now()
    const scanId = this.newId()
    const rows: NewFacePhoto[] = valid.map(({ position }) => ({
      faceScanId: scanId,
      userId,
      position,
      photoKey: this.objectKey({ id: scanId, userId, profileId }, `${position}.jpg`),
      createdAt: now,
    }))
    const keys = rows.map(({ photoKey }) => photoKey)
    let refused = false
    try {
      // Settled, not all: when one put fails the others may still be on their way, and every key must be deleted below.
      const puts = await Promise.allSettled(rows.map(({ photoKey }, i) => this.photos.put(photoKey, valid[i]!.image)))
      const failed = puts.find((put) => put.status === 'rejected')
      if (failed) throw failed.reason
      // Two requests can both read "not scanned yet" before either writes, so the write itself refuses the second: it stores the scan only while the
      // latest scan is still the one read above.
      const stored = await this.repository.createFaceScan({ id: scanId, userId, profileId, goalAtScan: goal, createdAt: now }, rows, { expectLatestId: latest?.id ?? null })
      if (!stored) refused = true
    } catch (error) {
      await this.photos.deleteMany(keys).catch((cleanup: unknown) => console.error({ outcome: 'photo-cleanup-failed', faceScanId: scanId, error: describeUnexpectedError(cleanup) }))
      throw error
    }
    if (refused) {
      // Lost to a request that stored a scan first: its photos are the ones that count.
      await this.photos.deleteMany(keys).catch((cleanup: unknown) => console.error({ outcome: 'photo-cleanup-failed', faceScanId: scanId, error: describeUnexpectedError(cleanup) }))
      throw FaceScanService.notDue('already-scanned-for-goal')
    }

    try {
      await this.jobs.enqueue(analyseFaceScanSpec, { faceScanId: scanId, step: 'upload', at: now.getTime() })
    } catch (error) {
      // Nothing will ever analyse this scan, so say so instead of leaving it analysing for ever.
      console.error({ outcome: 'enqueue-failed', faceScanId: scanId, error: describeUnexpectedError(error) })
      await this.markFailed(scanId).catch((marking: unknown) => console.error({ outcome: 'mark-failed-failed', faceScanId: scanId, error: describeUnexpectedError(marking) }))
    }
    const scan = await this.repository.findFaceScan(scanId)
    if (!scan) throw new Error('face scan vanished')
    return this.view(scan, await this.repository.photosOf(scanId))
  }

  /** The scan as it now is. A scan made by another profile, of this account or any other, is FACE_SCAN_NOT_FOUND, with no hint that it exists. */
  async getFaceScan(id: string): Promise<FaceScanView> {
    requireVerified()
    const scan = await this.ownedScan(id)
    return this.view(scan, await this.repository.photosOf(id))
  }

  /**
   * The skin type of the caller's profile's newest ready scan, or null (no ready scan, or Perfect Corp sent none for it). A newer scan that is still
   * being analysed or needs a retake does not hide an older ready one, and a newer ready scan with no skin type is not skipped for an older reading: it is the
   * profile's latest word on the face. Needs no consent and no goal, so it still answers after the consent is withdrawn. Reads only.
   */
  async latestSkinType(): Promise<SkinTypeLabel | null> {
    const { profileId } = requireUser()
    return (await this.repository.latestReadyForProfile(profileId))?.skinType ?? null
  }

  /**
   * The profile's latest scans, newest first, in every state, each the view `getFaceScan` gives. Needs no consent and no goal, so it still works after the consent
   * is withdrawn. `rescanSuggested` is a fact about the profile, not the scan, so it is worked out once for all of them.
   */
  async listFaceScans(): Promise<FaceScanView[]> {
    const { profileId } = requireVerified()
    const scans = await this.repository.listForProfile(profileId, FACE_SCAN_LIST_LIMIT)
    if (scans.length === 0) return []
    const rescanSuggested = await this.rescanSuggested(profileId)
    // Scans under one goal share a day one, so its scores are read once for the list.
    const dayOneResults = new Map<string, Promise<FaceResult[]>>()
    return Promise.all(scans.map(async (scan) => this.view(scan, await this.repository.photosOf(scan.id), rescanSuggested, dayOneResults)))
  }

  /**
   * Deletes the scan's photos and masks from the bucket, then its rows, so a bucket that fails leaves the scan to delete again. The keys a scan can have are
   * fixed, so they are deleted once more after the rows: an analysis that committed its masks after the keys were read has rows no longer, and its masks
   * would otherwise stay in the bucket for ever. Perfect Corp's copies of the photo go too, best effort.
   */
  async deleteFaceScan(id: string): Promise<void> {
    requireVerified()
    const scan = await this.ownedScan(id)
    await this.photos.deleteMany(await this.repository.keysOfFaceScan(id))
    await this.repository.deleteFaceScan(id)
    // The rows are gone, so a failure here cannot be retried by the user (the next delete is a 404): log it and finish.
    const fixedKeys = [...POSITIONS.map((position) => this.objectKey(scan, `${position}.jpg`)), ...measuredConcernsForGoal(scan.goalAtScan).map((concern) => this.objectKey(scan, FaceScanService.maskName(concern)))]
    await this.photos.deleteMany(fixedKeys).catch((cleanup: unknown) => console.error({ outcome: 'photo-cleanup-failed', faceScanId: id, error: describeUnexpectedError(cleanup) }))
    await this.deleteTasks(scan)
  }

  /**
   * The image a face photo link opens, for the public photo route. The link is the credential, so no sign-in is needed. A link that is
   * malformed, tampered with, signed with another secret or expired, one for a product photo, and one to a photo since deleted, are all
   * PHOTO_NOT_FOUND. (The link names the profile too, and verifyPhotoLink has already checked it against the key.)
   */
  async photoForLink(token: string): Promise<ProductImage> {
    const link = await verifyPhotoLink(token, this.#photoLinkSecret, this.now())
    if (!link || !link.key.startsWith('faces/')) throw FaceScanService.photoNotFound()
    const photo = await this.photos.get(link.key)
    if (!photo) throw FaceScanService.photoNotFound()
    return photo
  }

  /** Fails a scan that is still analysing as unavailable and tells the stream. A scan that has moved on is left alone, so a repeat or a late message does nothing. */
  async markFailed(faceScanId: string): Promise<void> {
    await this.fail(faceScanId, 'unavailable')
  }

  /** What the queue does with a step whose retries ran out: the scan fails, except for a Fitzpatrick step, which never changes the scan. */
  async giveUp(body: AnalyseFaceScanMessage): Promise<void> {
    if (body.step === 'fitzpatrick') return
    await this.markFailed(body.faceScanId)
  }

  /**
   * Runs one step of a scan's analysis, as the queue delivers it. A step for a scan that is gone or has moved on does nothing, so a message taken over
   * after its lease, or a webhook that comes twice, costs nothing. Perfect Corp's errors are mapped alike in every step that calls it: a photo it cannot
   * read sends the scan to a retake; an outage is rethrown for the queue to retry; our account or request being refused fails the scan and ends the
   * message as permanent (the account also raises an ops alert).
   */
  async advance(body: AnalyseFaceScanMessage): Promise<void> {
    switch (body.step) {
      case 'upload':
        return this.upload(body.faceScanId)
      case 'fetch':
        return this.fetch(body.faceScanId)
      case 'fitzpatrick':
        return this.readFitzpatrick(body.faceScanId)
    }
  }

  /**
   * Queues the step a verified Perfect Corp webhook is for: `fetch` for a scan's analysis task, `fitzpatrick` for its Fitzpatrick task. The signature is
   * checked on the raw body first (401 WEBHOOK_SIGNATURE_INVALID, with the reason logged as `perfect-corp-webhook-rejected`, never the body, a header value or a
   * secret). A task no scan of this environment holds is answered and ignored. A step that cannot be queued is 503, so Perfect Corp sends the webhook again.
   */
  async receiveWebhook(rawBody: string, headers: Headers): Promise<void> {
    const check = await this.perfectCorp.checkWebhook(rawBody, headers)
    if (!check.ok) {
      console.warn({ outcome: 'perfect-corp-webhook-rejected', ...check.rejection, bodyBytes: rawBody.length })
      throw new UnauthorizedError('WEBHOOK_SIGNATURE_INVALID', 'The webhook signature is not valid')
    }
    const { delivery } = check
    const scan = await this.repository.findByTaskId(delivery.taskId)
    if (!scan || scan.pcEnvironment !== this.environment) return
    const step = scan.pcAnalysisTaskId === delivery.taskId ? 'fetch' : 'fitzpatrick'
    try {
      await this.jobs.enqueue(analyseFaceScanSpec, { faceScanId: scan.id, step, at: this.now().getTime(), webhookId: delivery.webhookId })
    } catch (error) {
      console.error({ outcome: 'enqueue-failed', faceScanId: scan.id, step, error: describeUnexpectedError(error) })
      throw new UnavailableError('WEBHOOK_UNAVAILABLE', 'The webhook could not be queued; send it again')
    }
  }

  /**
   * Replaces the front photo of a scan that needs a retake and sends it for analysis again, with no limit on how often. The checks run in this order: the scan is
   * the caller's (404), consent is current (409 FACE_CONSENT_REQUIRED), the scan is waiting for a retake (409 FACE_SCAN_NOT_AWAITING_RETAKE), then the photo (400).
   * Nothing changes until all pass. When the analysis cannot be queued the scan is marked failed as unavailable and still returned, as `create` does.
   */
  async retake(id: string, photos: { front: ProductImage }): Promise<RetakenFaceScanView> {
    const scan = await this.ownedScan(id)
    await this.requireCurrentConsent(scan.profileId)
    if (scan.state !== 'needs-retake') throw FaceScanService.notAwaitingRetake()
    const image = this.checkPhoto(photos.front)
    const front = (await this.repository.photosOf(id)).find((photo) => photo.position === 'front')
    if (!front) throw new Error('face scan has no front photo')
    // The same key, so the scan's photo rows and the bucket stay as they were. A key is only ever replaced once the new photo is known to be good.
    await this.photos.put(front.photoKey, image)
    const now = this.now()
    // Cleared with the task: the retaken photo gets a task of its own and the reaper a check of its own.
    const moved = await this.repository.updateFaceScan(id, 'needs-retake', { state: 'analysing', reason: null, pcAnalysisTaskId: null, reaperCheckedAt: null, updatedAt: now })
    if (!moved) {
      // Deleted since the scan was read: the photo just written belongs to nothing, and nothing else will ever delete it.
      if (!(await this.repository.findFaceScan(id))) {
        await this.photos.delete(front.photoKey).catch((cleanup: unknown) => console.error({ outcome: 'photo-cleanup-failed', faceScanId: id, error: describeUnexpectedError(cleanup) }))
        throw FaceScanService.faceScanNotFound()
      }
      throw FaceScanService.notAwaitingRetake()
    }
    try {
      await this.jobs.enqueue(analyseFaceScanSpec, { faceScanId: id, step: 'upload', at: now.getTime() })
    } catch (error) {
      console.error({ outcome: 'enqueue-failed', faceScanId: id, error: describeUnexpectedError(error) })
      await this.markFailed(id).catch((marking: unknown) => console.error({ outcome: 'mark-failed-failed', faceScanId: id, error: describeUnexpectedError(marking) }))
    }
    const retaken = await this.repository.findFaceScan(id)
    if (!retaken) throw new Error('face scan vanished')
    const view = await this.view(retaken, await this.repository.photosOf(id))
    if (!view.photos.front) throw new Error('face scan has no front photo')
    return { ...view, photos: { ...view.photos, front: view.photos.front } }
  }

  /**
   * The reaper's one check of the scans still analysing. A scan that has sat 2 hours since it last moved is failed as unavailable. A scan that has sat 15
   * minutes without its webhook, and has not been checked, is looked at once: the step that would have run is queued again (`fetch` when Perfect Corp has its
   * task, else `upload`, because the first message was lost) and the check is noted, so it is never repeated. The check does not move the scan's updated time,
   * or the 2 hours would start again. These are two queries, because one over the 15-minute cut-off would fill its batch with scans already checked that
   * have not yet reached 2 hours, and keep newer ones from being looked at. A failure on one scan is logged by id and does not stop the sweep.
   */
  async reap(now: Date): Promise<{ checked: number; failed: number }> {
    let checked = 0
    let failed = 0
    for (const scan of await this.repository.staleAnalysing(new Date(now.getTime() - FaceScanService.GIVE_UP_AFTER_MS), FaceScanService.REAP_BATCH)) {
      try {
        if (await this.fail(scan.id, 'unavailable')) failed++
      } catch (error) {
        console.error({ outcome: 'reap-failed', faceScanId: scan.id, error: describeUnexpectedError(error) })
      }
    }
    for (const scan of await this.repository.staleAnalysing(new Date(now.getTime() - FaceScanService.STUCK_AFTER_MS), FaceScanService.REAP_BATCH, { unchecked: true })) {
      try {
        // Only the sweep that notes the check queues the step, and only while the scan has not been checked: it may have moved on since it was read.
        if (!(await this.repository.markReaperChecked(scan.id, now))) continue
        await this.jobs.enqueue(analyseFaceScanSpec, { faceScanId: scan.id, step: scan.pcAnalysisTaskId ? 'fetch' : 'upload', at: now.getTime() })
        checked++
      } catch (error) {
        console.error({ outcome: 'reap-failed', faceScanId: scan.id, error: describeUnexpectedError(error) })
      }
    }
    return { checked, failed }
  }

  /**
   * Opens a live stream of the scan for the profile that made it (anyone else's scan is FACE_SCAN_NOT_FOUND). It starts with the scan's frame as it now is,
   * then carries each change, and `done` once the scan is over: ready, failed, or waiting for a retake. The snapshot is read before the stream opens, so the
   * scan is read again once it is open: a change stored in between is sent, and a scan that is over gets `done` straight away. A failure to send is logged.
   */
  async watch(id: string): Promise<Response> {
    const scan = await this.ownedScan(id)
    const stream = await this.events.subscribe(id, FaceScanService.frameOf(scan))
    try {
      const latest = (await this.repository.findFaceScan(id)) ?? scan
      if (latest.state !== scan.state || latest.reason !== scan.reason) await this.events.publish(id, { type: 'face', faceScan: FaceScanService.frameOf(latest) })
      if (latest.state !== 'analysing') await this.events.publish(id, { type: 'done' })
    } catch {
      console.error({ outcome: 'publish-failed', faceScanId: id })
    }
    return stream
  }

  private async upload(id: string): Promise<void> {
    const scan = await this.repository.findFaceScan(id)
    if (!scan || scan.state !== 'analysing') return
    const consent = await this.repository.consentOf(scan.profileId)
    if (!consent || !FaceScanService.isCurrent(consent)) {
      await this.fail(id, 'consent-withdrawn')
      return
    }
    // Already has its task: this is a message taken over after its lease, and sending the photo again would pay twice.
    if (scan.pcAnalysisTaskId) return
    const front = (await this.repository.photosOf(id)).find((photo) => photo.position === 'front')
    const photo = front ? await this.photos.get(front.photoKey) : null
    if (!photo) {
      await this.fail(id, 'unavailable')
      return
    }
    await this.guarded(scan, async () => {
      const fileId = await this.perfectCorp.uploadFile(photo.bytes, { contentType: 'image/jpeg', fileName: 'front.jpg' })
      const taskId = await this.perfectCorp.createSkinAnalysis({ fileId, actions: hdActionsForGoal(scan.goalAtScan) })
      const now = this.now()
      // At once, before anything else can fail: a task Perfect Corp holds that we do not know of is one we cannot fetch or pay for. Only while the scan has no
      // task: of two uploads of one scan the first to store keeps its task.
      const stored = await this.repository.updateFaceScan(id, 'analysing', { pcAnalysisTaskId: taskId, pcEnvironment: this.environment, updatedAt: now }, { onlyIfNoAnalysisTask: true })
      if (!stored) {
        // The scan was deleted or failed while the photo was on its way, or another upload stored its task first: nothing will ever fetch this task, so their copy of the photo goes now.
        await this.deleteTaskQuietly(taskId)
        return
      }
      await this.startFitzpatrick(scan, fileId, now)
      await this.publishFrame(id, 'analysing', null)
    })
  }

  /** A profile's first scan also asks for its Fitzpatrick type. Any failure here is logged by name and leaves the scan to its analysis. */
  private async startFitzpatrick(scan: FaceScan, fileId: string, now: Date): Promise<void> {
    try {
      if (scan.pcFitzpatrickTaskId || (await this.repository.fitzpatrickOf(scan.profileId))) return
      const taskId = await this.perfectCorp.createFitzpatrick({ fileId })
      await this.repository.updateFaceScan(scan.id, 'analysing', { pcFitzpatrickTaskId: taskId, updatedAt: now })
    } catch (error) {
      console.error({ outcome: 'fitzpatrick-start-failed', faceScanId: scan.id, error: describeUnexpectedError(error) })
      // The same account problem as the analysis would have, and it must reach the owner even though this read never fails the scan.
      if (error instanceof PerfectCorpCreditError) {
        await this.opsAlerts.raise('face-scan-account').catch((raising: unknown) => console.error({ outcome: 'ops-alert-failed', faceScanId: scan.id, error: describeUnexpectedError(raising) }))
      }
    }
  }

  private async fetch(id: string): Promise<void> {
    const scan = await this.repository.findFaceScan(id)
    const taskId = scan?.pcAnalysisTaskId
    if (!scan || scan.state !== 'analysing' || !taskId) return
    await this.guarded(scan, async () => {
      const analysis = await this.perfectCorp.getSkinAnalysis(taskId)
      // Not done yet: the webhook or the reaper comes back.
      if (analysis.status === 'running') return
      // Perfect Corp charges when the task succeeds, not when we store the result, so the spend is recorded now: a mask that will not download, a scan deleted
      // meanwhile or a failed write must not leave a charge off the books. The ledger is keyed by the task, so a retry does not record it twice.
      try {
        await this.aiUsage.record({ vendor: 'perfect-corp', job: 'face-analysis', units: unitsForActions(hdActionsForGoal(scan.goalAtScan).length), key: taskId })
      } catch (error) {
        // Not worth losing the result for: the books are caught up from the ledger's side, and a retry would only fail the same way.
        console.error({ outcome: 'spend-record-failed', faceScanId: id, taskId, error: describeUnexpectedError(error) })
      }
      await this.copyResults(scan, taskId, analysis)
    })
  }

  /**
   * Stores a finished analysis. The masks are downloaded and put in the bucket first, then the rows and the state change go in as one write that holds only
   * while the scan is still analysing; when it does not (the scan was deleted or moved on meanwhile) the masks just written are deleted again, so nothing is
   * left in the bucket for a scan that is gone. Perfect Corp's copy of the task is then deleted, best effort. (The spend was recorded before, by `fetch`.)
   */
  private async copyResults(scan: FaceScan, taskId: string, analysis: Extract<SkinAnalysisResult, { status: 'success' }>): Promise<void> {
    const { id, userId, profileId } = scan
    const masks: FaceMask[] = []
    await this.logFrontPhotoSize(scan)
    try {
      for (const concern of measuredConcernsForGoal(scan.goalAtScan)) {
        const url = FaceScanService.maskUrlOf(analysis.concerns, concern)
        if (!url) continue
        const maskKey = this.objectKey(scan, FaceScanService.maskName(concern))
        const bytes = await this.perfectCorp.downloadMask(url)
        console.log({ outcome: 'mask-read', faceScanId: id, concern, ...describeImageBytes(bytes), bytes: bytes.length })
        await this.photos.put(maskKey, { bytes, mediaType: 'image/png' })
        masks.push({ faceScanId: id, userId, concern, maskKey })
      }
      const written = await this.repository.completeFaceScan(id, {
        results: FaceScanService.resultRows(scan, analysis),
        masks,
        skinType: skinTypeLabel(analysis.skinTypes),
        skinAge: analysis.skinAge === null ? null : Math.round(analysis.skinAge),
        tablesVersion: TABLES_VERSION,
        updatedAt: this.now(),
      })
      if (!written) {
        await this.deleteMasks(masks)
        return
      }
    } catch (error) {
      // A retry writes the same keys again, but a scan deleted before it comes would be left with these.
      await this.deleteMasks(masks)
      throw error
    }
    FaceScanService.warnMissingConcerns(scan, analysis)
    // Only the step whose write won gets here, and a ready scan is never fetched again: once per scan. At most once: a push lost here (the worker dies, or the queue refuses it) is not sent again.
    await this.notifications.faceScanReady({ userId, profileId, faceScanId: id })
    await this.queueFitzpatrickBackstop(scan)
    await this.deleteTaskQuietly(taskId)
    await this.publishFrame(id, 'ready', null, { done: true })
  }

  /** A goal concern Perfect Corp did not return is not an error (the scan is ready with what came back), but ops needs to see it. Names only: no scores, links or photo. */
  private static warnMissingConcerns(scan: FaceScan, analysis: Extract<SkinAnalysisResult, { status: 'success' }>): void {
    const present = new Set(analysis.concerns.map((item) => item.concern))
    const returned = [...present].sort()
    for (const concern of concernsForGoal(scan.goalAtScan)) {
      if (!present.has(concern)) console.warn({ outcome: 'face-scan-concern-missing', faceScanId: scan.id, concern, returned, skipped: analysis.skipped })
    }
  }

  /** The size of the photo Perfect Corp was given, to set beside what it measured. Best effort: a photo that cannot be read is logged without a size, never a failure. */
  private async logFrontPhotoSize(scan: FaceScan): Promise<void> {
    try {
      const photo = await this.photos.get(this.objectKey(scan, 'front.jpg'))
      const header = photo ? readImageHeader(photo.bytes) : null
      console.log({ outcome: 'front-photo-read', faceScanId: scan.id, width: header?.width ?? null, height: header?.height ?? null })
    } catch (error) {
      console.error({ outcome: 'front-photo-read-failed', faceScanId: scan.id, error: describeUnexpectedError(error) })
    }
  }

  /** The Fitzpatrick webhook may have been lost, and nothing else asks for that task again: when the analysis is in and the profile still has no type, ask now. */
  private async queueFitzpatrickBackstop(scan: FaceScan): Promise<void> {
    if (!scan.pcFitzpatrickTaskId) return
    try {
      if (await this.repository.fitzpatrickOf(scan.profileId)) return
      await this.jobs.enqueue(analyseFaceScanSpec, { faceScanId: scan.id, step: 'fitzpatrick', at: this.now().getTime() })
    } catch (error) {
      console.error({ outcome: 'enqueue-failed', faceScanId: scan.id, step: 'fitzpatrick', error: describeUnexpectedError(error) })
    }
  }

  private async readFitzpatrick(id: string): Promise<void> {
    const scan = await this.repository.findFaceScan(id)
    const taskId = scan?.pcFitzpatrickTaskId
    if (!scan || !taskId) return
    const held = await this.repository.fitzpatrickOf(scan.profileId)
    // This very task gave the profile its type, and was paid for then: only its copy at Perfect Corp is left.
    if (held?.taskId === taskId) {
      await this.deleteTaskQuietly(taskId)
      return
    }
    let read: FitzpatrickResult
    try {
      read = await this.perfectCorp.getFitzpatrick(taskId)
    } catch (error) {
      // Never changes the scan: only an outage is worth another try.
      if (error instanceof PerfectCorpCreditError) await this.opsAlerts.raise('face-scan-account')
      if (!(error instanceof PerfectCorpCreditError || error instanceof PerfectCorpBadRequestError || error instanceof PerfectCorpRejectedPhotoError)) throw error
      console.error({ outcome: 'fitzpatrick-read-failed', faceScanId: id, error: describeUnexpectedError(error) })
      return
    }
    if (read.status === 'running') return
    if (held) {
      // Another task gave the profile its type first, but this one succeeded all the same, and Perfect Corp charges for that.
      try {
        await this.aiUsage.record({ vendor: 'perfect-corp', job: 'fitzpatrick', units: FITZPATRICK_UNITS, key: taskId })
      } catch (error) {
        console.error({ outcome: 'spend-record-failed', faceScanId: id, taskId, error: describeUnexpectedError(error) })
      }
      await this.deleteTaskQuietly(taskId)
      return
    }
    // Recorded before it is stored: a failure in between is retried, and the retry finds the type missing and records it again as the same task.
    await this.aiUsage.record({ vendor: 'perfect-corp', job: 'fitzpatrick', units: FITZPATRICK_UNITS, key: taskId })
    await this.repository.saveFitzpatrick({ profileId: scan.profileId, userId: scan.userId, fitzpatrick: read.fitzpatrick, taskId, createdAt: this.now() })
    await this.deleteTaskQuietly(taskId)
  }

  /** Runs a step's Perfect Corp work and maps its errors, the same in every step (see `advance`). */
  private async guarded(scan: FaceScan, work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error) {
      if (error instanceof PerfectCorpRejectedPhotoError) {
        await this.needRetake(scan, error.reason)
      } else if (error instanceof PerfectCorpCreditError) {
        await this.opsAlerts.raise('face-scan-account')
        await this.fail(scan.id, 'unavailable')
        throw new PermanentJobError('Perfect Corp refused our account')
      } else if (error instanceof PerfectCorpBadRequestError) {
        await this.fail(scan.id, 'unavailable')
        throw new PermanentJobError('Perfect Corp refused the request')
      } else {
        throw error
      }
    }
  }

  private async needRetake(scan: FaceScan, reason: RejectedPhotoReason): Promise<void> {
    const { id, userId, profileId } = scan
    const at = this.now()
    if (await this.repository.updateFaceScan(id, 'analysing', { state: 'needs-retake', reason, updatedAt: at })) {
      // Only the step that wins this conditional update gets here, so a redelivered step cannot send it twice; `at` keeps each rejection of the scan apart.
      await this.notifications.faceScanNeedsRetake({ userId, profileId, faceScanId: id, reason, at: at.getTime() })
      await this.publishFrame(id, 'needs-retake', reason, { done: true })
      // The photo will be replaced, so the analysis task is dead weight. A Fitzpatrick task is kept while the profile has no type: it is a read of the same face,
      // it may still complete, and its own step deletes it.
      await this.deleteTasksOf(id, { keepPendingFitzpatrick: true })
    }
  }

  /** Fails a scan that is still analysing, and says whether it did. */
  private async fail(id: string, reason: 'unavailable' | 'consent-withdrawn'): Promise<boolean> {
    const failed = await this.repository.updateFaceScan(id, 'analysing', { state: 'failed', reason, updatedAt: this.now() })
    if (failed) {
      await this.publishFrame(id, 'failed', reason, { done: true })
      await this.deleteTasksOf(id)
    }
    return failed
  }

  /** Tells the stream, best effort: the change is already stored, and a client that missed it sees it in the snapshot when it reconnects. */
  private async publishFrame(id: string, state: FaceScanState, reason: FaceScanReason | null, options: { done?: true } = {}): Promise<void> {
    try {
      await this.events.publish(id, { type: 'face', faceScan: { id, state, reason } })
      if (options.done) await this.events.publish(id, { type: 'done' })
    } catch {
      console.error({ outcome: 'publish-failed', faceScanId: id })
    }
  }

  /** Perfect Corp's copy of the photo and the result goes with the task. A failure is logged by name and never fails the step: it is only housekeeping. */
  private async deleteTaskQuietly(taskId: string): Promise<void> {
    try {
      await this.perfectCorp.deleteTask(taskId)
    } catch (error) {
      console.error({ outcome: 'task-delete-failed', error: describeUnexpectedError(error) })
    }
  }

  /** Where a scan's object `name` (`front.jpg`, `mask-<concern>.png`) lives in the private bucket. */
  private objectKey(scan: Pick<FaceScan, 'id' | 'userId' | 'profileId'>, name: string): string {
    return `faces/${this.environment}/${scan.userId}/${scan.profileId}/${scan.id}/${name}`
  }

  private static maskName(concern: string): string {
    return `mask-${concern.replaceAll('_', '-')}.png`
  }

  /** Deletes the tasks a scan holds at Perfect Corp, reading it for them. Best effort like `deleteTaskQuietly`: whatever goes wrong here is logged, never thrown. */
  private async deleteTasksOf(id: string, options: { keepPendingFitzpatrick?: true } = {}): Promise<void> {
    try {
      const scan = await this.repository.findFaceScan(id)
      if (scan) await this.deleteTasks(scan, options)
    } catch (error) {
      console.error({ outcome: 'task-delete-failed', faceScanId: id, error: describeUnexpectedError(error) })
    }
  }

  /** The face photo must not outlive the scan at Perfect Corp: both of the scan's tasks go, except (with `keepPendingFitzpatrick`) a Fitzpatrick task the profile still waits for. */
  private async deleteTasks(scan: FaceScan, options: { keepPendingFitzpatrick?: true } = {}): Promise<void> {
    if (scan.pcAnalysisTaskId) await this.deleteTaskQuietly(scan.pcAnalysisTaskId)
    if (!scan.pcFitzpatrickTaskId) return
    if (options.keepPendingFitzpatrick && !(await this.repository.fitzpatrickOf(scan.profileId))) return
    await this.deleteTaskQuietly(scan.pcFitzpatrickTaskId)
  }

  private async deleteMasks(masks: FaceMask[]): Promise<void> {
    if (masks.length === 0) return
    await this.photos.deleteMany(masks.map((mask) => mask.maskKey)).catch((cleanup: unknown) => console.error({ outcome: 'photo-cleanup-failed', error: describeUnexpectedError(cleanup) }))
  }

  /** The link to a concern's overlay: the whole-face item's if it has a mask, else the first item that does. */
  private static maskUrlOf(concerns: ConcernScore[], concern: string): string | undefined {
    const withMask = concerns.filter((item) => item.concern === concern && item.maskUrls.length > 0)
    return (withMask.find((item) => item.region === 'whole') ?? withMask[0])?.maskUrls[0]
  }

  /** Every concern item the vendor sent, each region, and the overall score as the concern `all` of the `whole` region (it has one score, kept in both columns). */
  private static resultRows(scan: FaceScan, analysis: Extract<SkinAnalysisResult, { status: 'success' }>): FaceResult[] {
    const rows = new Map<string, FaceResult>()
    const add = (concern: string, region: string, rawScore: number, uiScore: number) => {
      // The first of a repeated concern and region stands, so a vendor that repeats one cannot fail the whole write.
      if (!rows.has(`${concern}\n${region}`)) rows.set(`${concern}\n${region}`, { faceScanId: scan.id, userId: scan.userId, concern, region, rawScore, uiScore })
    }
    for (const item of analysis.concerns) add(item.concern, item.region, item.rawScore, item.uiScore)
    if (analysis.all !== null) add('all', 'whole', analysis.all, analysis.all)
    return [...rows.values()]
  }

  private static frameOf(scan: FaceScan): FaceScanFrame {
    return { id: scan.id, state: scan.state, reason: scan.reason }
  }

  private async requireCurrentConsent(profileId: string): Promise<void> {
    const consent = await this.repository.consentOf(profileId)
    if (!consent || !FaceScanService.isCurrent(consent)) throw FaceScanService.consentRequired()
  }

  private static isCurrent(consent: { version: number; withdrawnAt: Date | null }): boolean {
    return consent.withdrawnAt === null && consent.version === CURRENT_FACE_CONSENT_VERSION
  }

  private async ownedScan(id: string): Promise<FaceScan> {
    const { userId, profileId } = requireUser()
    const scan = await this.repository.findFaceScan(id)
    if (!scan || scan.userId !== userId || scan.profileId !== profileId) throw FaceScanService.faceScanNotFound()
    return scan
  }

  /** The bytes decide the type, never what the caller says it is: a face photo is a JPEG, big enough to read a face from. */
  private checkPhoto(photo: ProductImage): ProductImage {
    if (photo.bytes.length > this.policy.maxPhotoBytes) {
      throw new ValidationError('IMAGE_TOO_LARGE', `A photo is at most ${this.policy.maxPhotoBytes} bytes`)
    }
    const header = readImageHeader(photo.bytes)
    if (!header || header.mediaType !== 'image/jpeg') {
      throw new ValidationError('UNSUPPORTED_IMAGE', 'Face photos must be JPEG, at most 4096 pixels on the longest side')
    }
    if (Math.min(header.width, header.height) < this.policy.minShortSide) {
      throw new ValidationError('IMAGE_TOO_SMALL', `A photo is at least ${this.policy.minShortSide} pixels on its shorter side`)
    }
    return { bytes: photo.bytes, mediaType: 'image/jpeg' }
  }

  /** `rescanSuggested` and `dayOneResults` (the day-one scans' scores read so far, by scan id) are worked out here unless the caller, building many views for one profile, shares them. */
  private async view(scan: FaceScan, photos: FaceScanPhoto[], rescanSuggested?: boolean, dayOneResults?: Map<string, Promise<FaceResult[]>>): Promise<FaceScanView> {
    const now = this.now()
    const expiresAt = new Date(now.getTime() + PHOTO_LINK_TTL_SECONDS * 1000)
    const link = async (key: string) => facePhotoUrl(await signPhotoLink({ key, userId: scan.userId, profileId: scan.profileId, expiresAt }, this.#photoLinkSecret, now))
    const links: FaceScanView['photos'] = {}
    for (const photo of photos) links[photo.position] = { url: await link(photo.photoKey) }
    return {
      id: scan.id,
      state: scan.state,
      reason: scan.reason,
      goal: scan.goalAtScan,
      createdAt: scan.createdAt,
      photos: links,
      rescanSuggested: rescanSuggested ?? (await this.rescanSuggested(scan.profileId)),
      result: scan.state === 'ready' ? await this.result(scan, link, dayOneResults ?? new Map()) : null,
    }
  }

  /** The result of a ready scan, worked out from its stored rows now. Day one is the scan itself when it is the earliest, which is no day one to compare with. */
  private async result(scan: FaceScan, link: (key: string) => Promise<string>, dayOneResults: Map<string, Promise<FaceResult[]>>): Promise<ResultView> {
    const [results, masks, found] = await Promise.all([
      this.repository.resultsOf(scan.id),
      this.repository.masksOf(scan.id),
      this.repository.dayOneFor({ profileId: scan.profileId, goal: scan.goalAtScan, at: scan.createdAt, scanId: scan.id }),
    ])
    // Only the concerns that are shown get a link (the goal's own, faint ones too, and the extras that can be seen): a signature per mask that is then dropped is work for nothing.
    const shown = new Set<string>([
      ...shownConcerns(scan.goalAtScan, results).map(({ concern }) => concern),
      ...noticedConcerns(scan.goalAtScan, results).map(({ concern }) => concern),
    ])
    const overlays: Record<string, { url: string }> = {}
    for (const mask of masks) if (shown.has(mask.concern)) overlays[mask.concern] = { url: await link(mask.maskKey) }
    const dayOne = found && found.id !== scan.id ? found : null
    return resultView({
      goal: scan.goalAtScan,
      results,
      overlays,
      skinType: scan.skinType,
      skinAge: scan.skinAge,
      dayOne: dayOne && { id: dayOne.id, createdAt: dayOne.createdAt, results: await this.dayOneResultsOf(dayOne.id, dayOneResults), skinAge: dayOne.skinAge },
    })
  }

  private dayOneResultsOf(id: string, cache: Map<string, Promise<FaceResult[]>>): Promise<FaceResult[]> {
    let read = cache.get(id)
    if (!read) {
      read = this.repository.resultsOf(id)
      cache.set(id, read)
    }
    return read
  }

  /** Whether the profile's latest scan was taken under another goal than the one it has now. No goal, or typed words nobody sorted into one, suggests nothing. */
  private async rescanSuggested(profileId: string): Promise<boolean> {
    const goal = await this.goals.current().then(
      (view) => view.goal,
      (error: unknown) => {
        if (error instanceof NotFoundError) return null
        throw error
      },
    )
    if (goal === null) return false
    const latest = await this.repository.latestForProfile(profileId)
    return latest !== null && latest.goalAtScan !== goal
  }
}
