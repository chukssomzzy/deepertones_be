import { requireUser } from '../../lib/context'
import { ConflictError, NotFoundError, RateLimitedError, ValidationError } from '../../lib/errors'
import { readImageHeader } from '../../lib/image-header'
import { PHOTO_LINK_TTL_SECONDS, signPhotoLink, verifyPhotoLink } from '../../lib/photo-link'
import { describeUnexpectedError } from '../../lib/safe-error'
import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import type { PhotoEnvironment, PhotoStore } from '../../providers/photo-store/photo-store.provider'
import type { ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import type { GoalsService } from '../goals/goals.service'
import type { Goal } from '../goals/goals.vocabulary'
import { facePhotoUrl } from '../scans/scans.paths'
import { CURRENT_FACE_CONSENT_VERSION } from './face-scans.consent'
import { analyseFaceScanSpec } from './face-scans.job-specs'
import { mayScanNow } from './face-scans.policy'
import type { FaceScansRepository } from './face-scans.repository'
import type { FacePhotoPosition, FaceScan, FaceScanPhoto, FaceScanReason, FaceScanState, NewFacePhoto } from './face-scans.types'

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

/** What the app shows for a face scan. There is no result in it yet. */
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

export type FaceScanServiceDeps = {
  repository: FaceScansRepository
  goals: Pick<GoalsService, 'requireGoal' | 'current'>
  photos: PhotoStore
  jobs: JobQueue
  /** Signs the photo links. photo-link.ts derives its own key from it. */
  photoLinkSecret: string
  environment: PhotoEnvironment
  now?: () => Date
  newId?: () => string
  policy?: FaceScanPolicy
}

const POSITIONS: readonly FacePhotoPosition[] = ['front', 'right', 'left']

export class FaceScanService {
  private static faceScanNotFound = () => new NotFoundError('FACE_SCAN_NOT_FOUND', 'Face scan not found')
  private static notDue = (reason: 'already-scanned-for-goal') => new RateLimitedError('FACE_SCAN_NOT_DUE', 'A face scan is not due yet', { reason })
  private static photoNotFound = () => new NotFoundError('PHOTO_NOT_FOUND', 'Photo not found')

  private readonly repository: FaceScansRepository
  private readonly goals: Pick<GoalsService, 'requireGoal' | 'current'>
  private readonly photos: PhotoStore
  private readonly jobs: JobQueue
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
    const consent = await this.repository.consentOf(profileId)
    if (!consent || !FaceScanService.isCurrent(consent)) {
      throw new ConflictError('FACE_CONSENT_REQUIRED', 'Say yes to the face photo consent first')
    }
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

  /** Fails a scan that is still analysing as unavailable. A scan that has moved on is left alone, so a repeat or a late message does nothing. */
  async markFailed(faceScanId: string): Promise<void> {
    await this.repository.updateFaceScan(faceScanId, 'analysing', { state: 'failed', reason: 'unavailable', updatedAt: this.now() })
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
