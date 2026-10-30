import type { FaceSharesRepository } from './face-shares.repository'
import type { FaceShare, FaceShareConsent, GiveFaceShareConsent, NewFaceShare } from './face-shares.types'

/**
 * In-memory FaceSharesRepository for unit tests. Its behaviour is pinned by faceSharesRepositoryContract, which the D1 class also passes: the doc comments on
 * the D1 class say what each method promises, and this one keeps the same promises. It holds no profiles, so any profile id counts as existing (the D1 twin
 * enforces that the profile is real).
 */
export class FakeFaceSharesRepository implements FaceSharesRepository {
  private consents = new Map<string, FaceShareConsent>()
  private shares: FaceShare[] = []

  async consentOf(profileId: string): Promise<FaceShareConsent | null> {
    const found = this.consents.get(profileId)
    return found ? { ...found } : null
  }

  async giveConsent({ profileId, userId, version, at }: GiveFaceShareConsent): Promise<void> {
    this.consents.set(profileId, { profileId, userId, version, givenAt: at, withdrawnAt: null })
  }

  async withdrawConsent(profileId: string, at: Date): Promise<void> {
    const found = this.consents.get(profileId)
    if (found && found.withdrawnAt === null) this.consents.set(profileId, { ...found, withdrawnAt: at })
  }

  async record(share: NewFaceShare): Promise<void> {
    if (this.shares.some((held) => held.id === share.id)) throw new Error('duplicate id')
    this.shares.push({ ...share })
  }

  async sharesOf(profileId: string): Promise<FaceShare[]> {
    return this.shares.filter((share) => share.profileId === profileId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((share) => ({ ...share }))
  }
}
