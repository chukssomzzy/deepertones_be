import { requireUser } from '../../lib/context'
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors'
import { CURRENT_FACE_SHARE_CONSENT_VERSION } from './face-shares.consent'
import type { FaceSharesRepository } from './face-shares.repository'

export type FaceSharesServiceDeps = {
  repository: FaceSharesRepository
  now?: () => Date
}

export type FaceShareConsentGiven = { version: number; givenAt: Date }

/** `current` is true while the consent is for the current wording and not withdrawn: the only consent a share accepts. */
export type FaceShareConsentView = { version: number; givenAt: Date; withdrawnAt: Date | null; current: boolean }

/**
 * Sharing a before-and-after card of the face photos (spec #259). The person says yes once, it is remembered, and they can take it back at any time; once it is
 * withdrawn the next share asks again. This holds that consent. The three session methods are for signed-up accounts (401, then 403 `SIGNUP_REQUIRED` for a guest, then
 * the rest); `hasCurrentConsent` is for the share itself, by profile id with no session.
 */
export class FaceSharesService {
  private readonly repository: FaceSharesRepository
  private readonly now: () => Date

  constructor(deps: FaceSharesServiceDeps) {
    this.repository = deps.repository
    this.now = deps.now ?? (() => new Date())
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

  /** The version of the profile's consent while it is for the current wording and not withdrawn, else null. By profile id with no session, since the share asks; reads only. */
  async hasCurrentConsent(profileId: string): Promise<{ version: number } | null> {
    const found = await this.repository.consentOf(profileId)
    return found && FaceSharesService.isCurrent(found) ? { version: found.version } : null
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
