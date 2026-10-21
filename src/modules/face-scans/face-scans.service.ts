import { PermanentJobError } from '../../jobs/job'
import { requireUser } from '../../lib/context'
import { ConflictError, NotFoundError, RateLimitedError, UnauthorizedError, UnavailableError, ValidationError } from '../../lib/errors'
import { readImageHeader } from '../../lib/image-header'
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
import type { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import { facePhotoUrl } from '../scans/scans.paths'
import { CURRENT_FACE_CONSENT_VERSION } from './face-scans.consent'
import { type AnalyseFaceScanMessage, analyseFaceScanSpec } from './face-scans.job-specs'
import { mayScanNow } from './face-scans.policy'
import type { FaceScansRepository } from './face-scans.repository'
import { concernsForGoal, hdActionsForGoal, skinTypeLabel, TABLES_VERSION } from './face-scans.tables'
import type { FaceMask, FacePhotoPosition, FaceResult, FaceScan, FaceScanPhoto, FaceScanReason, FaceScanState, NewFacePhoto } from './face-scans.types'

export type FaceScanPolicy = {
  /** The most bytes one face photo may be. */
  maxPhotoBytes: number
  /** The shortest short side, in pixels, of a face photo: Perfect Corp needs this much face to read. */
  minShortSide: number
}

// The longest side is capped at 4096 px by readImageHeader, which reads a larger header as no image at all.
export const FACE_SCAN_POLICY: FaceScanPolicy = { maxPhotoBytes: 6_000_000, minShortSide: 1080 }

/** The photos of a scan, by position. Only the front one is required. */
export type FacePhotos = { front: ProductImage; right?: ProductImage; left?: ProductImage }

export type FaceConsentGiven = { version: number; givenAt: Date }

/** `current` is true while the consent is for the current wording and not withdrawn. */
export type FaceConsentView = { version: number; givenAt: Date; withdrawnAt: Date | null; current: boolean }

/** What the app shows for a face scan. There is no result in it yet: the result view is a later change. */
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

/** What Perfect Corp charges for an HD skin analysis, by the number of actions asked for (1 to 4, 5 to 8, 9 to 12, 13 to 16). */
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
    const { profileId } = requireUser()
    await this.repository.withdrawConsent(profileId, this.now())
  }

  async consent(): Promise<FaceConsentView> {
    const { profileId } = requireUser()
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
      photoKey: `faces/${this.environment}/${userId}/${profileId}/${scanId}/${position}.jpg`,
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
    const scan = await this.ownedScan(id)
    return this.view(scan, await this.repository.photosOf(id))
  }

  /** Deletes the scan's photos and masks from the bucket, then its rows, so a bucket that fails leaves the scan to delete again. */
  async deleteFaceScan(id: string): Promise<void> {
    await this.ownedScan(id)
    await this.photos.deleteMany(await this.repository.keysOfFaceScan(id))
    await this.repository.deleteFaceScan(id)
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
   * checked on the raw body first (401 WEBHOOK_SIGNATURE_INVALID). A task no scan of this environment holds is answered and ignored. A step that cannot be
   * queued is 503, so Perfect Corp sends the webhook again.
   */
  async receiveWebhook(rawBody: string, headers: Headers): Promise<void> {
    const delivery = await this.perfectCorp.verifyWebhook(rawBody, headers)
    if (!delivery) throw new UnauthorizedError('WEBHOOK_SIGNATURE_INVALID', 'The webhook signature is not valid')
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
    if (!moved) throw FaceScanService.notAwaitingRetake()
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
   * The reaper's one check of the scans still analysing. A scan that has sat 15 minutes without its webhook is looked at once: the step that would have
   * run is queued again (`fetch` when Perfect Corp has its task, else `upload`, because the first message was lost) and the check is noted, so it is
   * never repeated. A scan that has sat 2 hours since it last moved is failed as unavailable. The check does not move the scan's updated time, or the
   * 2 hours would start again. A failure on one scan is logged by id and does not stop the sweep.
   */
  async reap(now: Date): Promise<{ checked: number; failed: number }> {
    const stale = await this.repository.staleAnalysing(new Date(now.getTime() - FaceScanService.STUCK_AFTER_MS), FaceScanService.REAP_BATCH)
    let checked = 0
    let failed = 0
    for (const scan of stale) {
      try {
        if (scan.updatedAt.getTime() < now.getTime() - FaceScanService.GIVE_UP_AFTER_MS) {
          if (await this.fail(scan.id, 'unavailable')) failed++
        } else if (scan.reaperCheckedAt === null) {
          if (!(await this.repository.updateFaceScan(scan.id, 'analysing', { reaperCheckedAt: now, updatedAt: scan.updatedAt }))) continue
          await this.jobs.enqueue(analyseFaceScanSpec, { faceScanId: scan.id, step: scan.pcAnalysisTaskId ? 'fetch' : 'upload', at: now.getTime() })
          checked++
        }
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
      // At once, before anything else can fail: a task Perfect Corp holds that we do not know of is one we cannot fetch or pay for.
      const stored = await this.repository.updateFaceScan(id, 'analysing', { pcAnalysisTaskId: taskId, pcEnvironment: this.environment, updatedAt: now })
      if (!stored) {
        // The scan was deleted or failed while the photo was on its way: nothing will ever fetch this task, so their copy of the photo goes now.
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
      await this.copyResults(scan, taskId, analysis)
    })
  }

  /**
   * Stores a finished analysis. The masks are downloaded and put in the bucket first, then the rows and the state change go in as one write that holds only
   * while the scan is still analysing; when it does not (the scan was deleted or moved on meanwhile) the masks just written are deleted again, so nothing is
   * left in the bucket for a scan that is gone. The spend is recorded only once the write held. Perfect Corp's copy of the task is then deleted, best effort.
   */
  private async copyResults(scan: FaceScan, taskId: string, analysis: Extract<SkinAnalysisResult, { status: 'success' }>): Promise<void> {
    const { id, userId, profileId } = scan
    const masks: FaceMask[] = []
    try {
      for (const concern of concernsForGoal(scan.goalAtScan)) {
        const url = FaceScanService.maskUrlOf(analysis.concerns, concern)
        if (!url) continue
        const maskKey = `faces/${this.environment}/${userId}/${profileId}/${id}/mask-${concern.replaceAll('_', '-')}.png`
        await this.photos.put(maskKey, { bytes: await this.perfectCorp.downloadMask(url), mediaType: 'image/png' })
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
    try {
      await this.aiUsage.record({ vendor: 'perfect-corp', job: 'face-analysis', units: unitsForActions(hdActionsForGoal(scan.goalAtScan).length), key: taskId })
    } catch (error) {
      // The scan is ready and a retry would find it so: the user must not wait on, nor lose a result to, the books.
      console.error({ outcome: 'spend-record-failed', faceScanId: id, error: describeUnexpectedError(error) })
    }
    await this.deleteTaskQuietly(taskId)
    await this.publishFrame(id, 'ready', null, { done: true })
  }

  private async readFitzpatrick(id: string): Promise<void> {
    const scan = await this.repository.findFaceScan(id)
    const taskId = scan?.pcFitzpatrickTaskId
    if (!scan || !taskId) return
    if (await this.repository.fitzpatrickOf(scan.profileId)) {
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
        await this.needRetake(scan.id, error.reason)
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

  private async needRetake(id: string, reason: RejectedPhotoReason): Promise<void> {
    if (await this.repository.updateFaceScan(id, 'analysing', { state: 'needs-retake', reason, updatedAt: this.now() })) {
      await this.publishFrame(id, 'needs-retake', reason, { done: true })
    }
  }

  /** Fails a scan that is still analysing, and says whether it did. */
  private async fail(id: string, reason: 'unavailable' | 'consent-withdrawn'): Promise<boolean> {
    const failed = await this.repository.updateFaceScan(id, 'analysing', { state: 'failed', reason, updatedAt: this.now() })
    if (failed) await this.publishFrame(id, 'failed', reason, { done: true })
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

  private async view(scan: FaceScan, photos: FaceScanPhoto[]): Promise<FaceScanView> {
    const now = this.now()
    const expiresAt = new Date(now.getTime() + PHOTO_LINK_TTL_SECONDS * 1000)
    const links: FaceScanView['photos'] = {}
    for (const photo of photos) {
      const token = await signPhotoLink({ key: photo.photoKey, userId: scan.userId, profileId: scan.profileId, expiresAt }, this.#photoLinkSecret, now)
      links[photo.position] = { url: facePhotoUrl(token) }
    }
    return {
      id: scan.id,
      state: scan.state,
      reason: scan.reason,
      goal: scan.goalAtScan,
      createdAt: scan.createdAt,
      photos: links,
      rescanSuggested: await this.rescanSuggested(scan.profileId),
    }
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
