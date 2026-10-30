import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { faceShareConsents, faceShares } from './face-shares.table'
import type { FaceShare, FaceShareConsent, GiveFaceShareConsent, NewFaceShare } from './face-shares.types'

export type { FaceShare, FaceShareConsent, GiveFaceShareConsent, NewFaceShare }

export class D1FaceSharesRepository {
  constructor(private readonly db: Db) {}

  /** The profile's consent, or null if it never gave one. A withdrawn consent is still here, with its withdrawal time. */
  async consentOf(profileId: string): Promise<FaceShareConsent | null> {
    const [row] = await this.db.select().from(faceShareConsents).where(eq(faceShareConsents.profileId, profileId))
    return row ?? null
  }

  /** Records consent at `at`: a profile has one row, and giving again replaces its version and time and clears any withdrawal. Rejects a profile that does not exist. */
  async giveConsent(consent: GiveFaceShareConsent): Promise<void> {
    const { profileId, userId, version, at } = consent
    await this.db
      .insert(faceShareConsents)
      .values({ profileId, userId, version, givenAt: at, withdrawnAt: null })
      .onConflictDoUpdate({ target: faceShareConsents.profileId, set: { userId, version, givenAt: at, withdrawnAt: null } })
  }

  /** Stamps the time of the withdrawal and keeps the row. The first withdrawal's time stands; a profile with no consent gets no row. */
  async withdrawConsent(profileId: string, at: Date): Promise<void> {
    await this.db
      .update(faceShareConsents)
      .set({ withdrawnAt: at })
      .where(and(eq(faceShareConsents.profileId, profileId), isNull(faceShareConsents.withdrawnAt)))
  }

  /** Inserts a share. Shares are not one per profile: every one is kept. Rejects a profile that does not exist or an id that is taken. */
  async record(share: NewFaceShare): Promise<void> {
    await this.db.insert(faceShares).values(share)
  }

  /** The profile's shares, oldest first. */
  async sharesOf(profileId: string): Promise<FaceShare[]> {
    return this.db.select().from(faceShares).where(eq(faceShares.profileId, profileId)).orderBy(asc(faceShares.createdAt))
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type FaceSharesRepository = PublicOf<D1FaceSharesRepository>
