import { requireUser } from '../../lib/context'
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationError } from '../../lib/errors'
import { describeUnexpectedError } from '../../lib/safe-error'
import type { PhotoStore } from '../../providers/photo-store/photo-store.provider'
import type { ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import { type ShareCard, ShareCardQuotaError, type ShareCardRenderer } from '../../providers/share-card/share-card.provider'
import type { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import { CURRENT_FACE_SHARE_CONSENT_VERSION } from './face-shares.consent'
import { shareCardLayout } from './face-shares.layout'
import type { FaceSharesRepository } from './face-shares.repository'

/** A scan the card draws, as the face scans give it: its stored front photo's key and its calendar date ('YYYY-MM-DD') in the person's own zone. */
export type ShareScan = { scanId: string; frontPhotoKey: string; localDay: string }

export type FaceSharesServiceDeps = {
  repository: FaceSharesRepository
  /** Day one and the asked-for later scan (FaceScanService.beforeAndAfterFor). Structural, so this module never imports face-scans. */
  faceScans: { beforeAndAfterFor(profileId: string, afterScanId: string): Promise<{ before: ShareScan | null; after: ShareScan | null }> }
  /** The private photo store: only `get` is used. */
  photos: Pick<PhotoStore, 'get'>
  renderer: ShareCardRenderer
  /** The brand logo for the card's corner. */
  readLogo: () => Promise<ProductImage>
  /** The owner is told when the image service's free allowance runs out. */
  opsAlerts: Pick<OpsAlertsService, 'raise'>
  now?: () => Date
  newId?: () => string
}

/** The least number of days between day one and a later photo before the pair may be shared: two weeks. */
const MIN_DAYS_APART = 14
const DAY_MS = 24 * 60 * 60 * 1000

class MissingPhotoError extends Error {}

export type FaceShareConsentGiven = { version: number; givenAt: Date }

/** `current` is true while the consent is for the current wording and not withdrawn: the only consent a share accepts. */
export type FaceShareConsentView = { version: number; givenAt: Date; withdrawnAt: Date | null; current: boolean }

/**
 * Sharing a before-and-after card of the face photos (spec #259). The person says yes once, it is remembered, and they can take it back at any time; once it is
 * withdrawn the next share asks again. This holds that consent, and makes the card (`share`). The session methods are for signed-up accounts (401, then 403 `SIGNUP_REQUIRED`
 * for a guest, then the rest); `hasCurrentConsent` is by profile id with no session.
 */
export class FaceSharesService {
  private readonly repository: FaceSharesRepository
  private readonly faceScans: FaceSharesServiceDeps['faceScans']
  private readonly photos: Pick<PhotoStore, 'get'>
  private readonly renderer: ShareCardRenderer
  private readonly readLogo: () => Promise<ProductImage>
  private readonly opsAlerts: Pick<OpsAlertsService, 'raise'>
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: FaceSharesServiceDeps) {
    this.repository = deps.repository
    this.faceScans = deps.faceScans
    this.photos = deps.photos
    this.renderer = deps.renderer
    this.readLogo = deps.readLogo
    this.opsAlerts = deps.opsAlerts
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /** Records the caller's profile's consent for the current wording. Any other version is 400 FACE_SHARE_CONSENT_VERSION_MISMATCH, which says which is current. */
  async giveConsent(version: number): Promise<FaceShareConsentGiven> {
    const { userId, profileId } = FaceSharesService.signedUp()
    if (version !== CURRENT_FACE_SHARE_CONSENT_VERSION) {
      throw new ValidationError('FACE_SHARE_CONSENT_VERSION_MISMATCH', 'That is not the current version of the face share consent', { current: CURRENT_FACE_SHARE_CONSENT_VERSION })
    }
    const at = this.now()
    await this.repository.giveConsent({ profileId, userId, version, at })
    return { version, givenAt: at }
  }

  async consent(): Promise<FaceShareConsentView> {
    const { profileId } = FaceSharesService.signedUp()
    const found = await this.repository.consentOf(profileId)
    if (!found) throw new NotFoundError('FACE_SHARE_CONSENT_NOT_FOUND', 'No face share consent has been given')
    return { version: found.version, givenAt: found.givenAt, withdrawnAt: found.withdrawnAt, current: FaceSharesService.isCurrent(found) }
  }

  /** Withdraws the profile's consent, keeping the record. Nothing to withdraw is not an error. */
  async withdrawConsent(): Promise<void> {
    const { profileId } = FaceSharesService.signedUp()
    await this.repository.withdrawConsent(profileId, this.now())
  }

  /**
   * The before-and-after card of the caller's day-one face photo and the asked-for later one, as a PNG. Refused, in this order and before anything is read or drawn: 401, 403
   * `SIGNUP_REQUIRED` (a guest), 409 `SHARE_CONSENT_REQUIRED`, 409 `NO_DAY_ONE_PHOTO`, 404 `FACE_SCAN_NOT_FOUND` (a scan that is unknown, another profile's, not later in the
   * same chase or without a front photo is not told apart), 409 `SHARE_TOO_EARLY` (under 14 days after day one, counted in the person's own calendar days). The label reads
   * "Day N" with N the days since day one plus one.
   *
   * The card is returned and kept nowhere. The share is recorded only once it is drawn, so a failed attempt leaves nothing behind. The image service's allowance running out
   * tells the owner and answers 503 `SHARE_UNAVAILABLE`; any other failure, a stored photo with no object included, answers the same 503 without an alert. Logs hold ids only:
   * never a photo key, a photo, or the text of an error.
   */
  async share(afterScanId: string): Promise<ShareCard> {
    const { profileId } = FaceSharesService.signedUp()
    const consent = await this.hasCurrentConsent(profileId)
    if (!consent) throw new ConflictError('SHARE_CONSENT_REQUIRED', 'Say yes to sharing a before-and-after card first')
    const { before, after } = await this.faceScans.beforeAndAfterFor(profileId, afterScanId)
    if (!before) throw new ConflictError('NO_DAY_ONE_PHOTO', 'There is no day one photo to compare with yet')
    if (!after) throw new NotFoundError('FACE_SCAN_NOT_FOUND', 'Face scan not found')
    const daysApart = Math.round((Date.parse(`${after.localDay}T00:00:00.000Z`) - Date.parse(`${before.localDay}T00:00:00.000Z`)) / DAY_MS)
    if (daysApart < MIN_DAYS_APART) throw new ConflictError('SHARE_TOO_EARLY', 'Share a photo taken at least two weeks after your first one')

    const card = await this.draw(profileId, before, after, daysApart + 1)
    await this.repository.record({ id: this.newId(), profileId, beforeScanId: before.scanId, afterScanId: after.scanId, consentVersion: consent.version, createdAt: this.now() })
    return card
  }

  /** The version of the profile's consent while it is for the current wording and not withdrawn, else null. By profile id with no session, since the share asks; reads only. */
  async hasCurrentConsent(profileId: string): Promise<{ version: number } | null> {
    const found = await this.repository.consentOf(profileId)
    return found && FaceSharesService.isCurrent(found) ? { version: found.version } : null
  }

  /** Reads the two photos and the logo and draws the card. Every failure is the one 503; only the allowance running out also tells the owner. */
  private async draw(profileId: string, before: ShareScan, after: ShareScan, dayNumber: number): Promise<ShareCard> {
    const ids = { profileId, beforeScanId: before.scanId, afterScanId: after.scanId }
    try {
      const [beforePhoto, afterPhoto, logo] = await Promise.all([this.photos.get(before.frontPhotoKey), this.photos.get(after.frontPhotoKey), this.readLogo()])
      // A stored key whose object is gone: the share cannot be made, and there is nothing for the owner to act on.
      if (!beforePhoto || !afterPhoto) throw new MissingPhotoError()
      return await this.renderer.render({ layout: shareCardLayout(dayNumber), before: beforePhoto, after: afterPhoto, logo })
    } catch (error) {
      if (error instanceof ShareCardQuotaError) {
        console.error({ outcome: 'share-render-quota', ...ids })
        await this.opsAlerts.raise('share-render-quota')
      } else {
        console.error({ outcome: 'share-render-failed', ...ids, error: error instanceof MissingPhotoError ? 'photo missing' : describeUnexpectedError(error) })
      }
      throw new UnavailableError('SHARE_UNAVAILABLE', 'Sharing is busy right now. Try again later.')
    }
  }

  private static signedUp() {
    const user = requireUser()
    if (user.status !== 'verified') throw new ForbiddenError('SIGNUP_REQUIRED', 'Sign up to share your progress')
    return user
  }

  private static isCurrent(consent: { version: number; withdrawnAt: Date | null }): boolean {
    return consent.withdrawnAt === null && consent.version === CURRENT_FACE_SHARE_CONSENT_VERSION
  }
}
