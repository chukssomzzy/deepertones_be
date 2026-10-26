import type { ProfilesRepository } from './profiles.repository'
import type { Profile } from './profiles.types'

export type ProfilesServiceDeps = {
  repository: ProfilesRepository
  now?: () => Date
  newId?: () => string
}

/** Reads profiles. The default is written with its user and goes with it; `defaultFor` also writes it for a user who has none. */
export class ProfilesService {
  private readonly repository: ProfilesRepository
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: ProfilesServiceDeps) {
    this.repository = deps.repository
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * The user's default profile. Every user has one, but migrations 0011 and 0012 run before the Worker that writes the default
   * with the user goes live, and the old Worker creates users without one until then (for ever, if the deploy fails), so a
   * missing default is made here rather than wedging the session. Two callers can both find none: the partial unique index
   * lets one insert win, and the loser reads the winner's. If nothing is there to read the insert failed for another
   * reason (an unknown user, by the foreign key) and that error surfaces.
   */
  async defaultFor(userId: string): Promise<Profile> {
    const existing = await this.repository.defaultFor(userId)
    if (existing) return existing
    const created: Profile = { id: this.newId(), userId, displayName: null, isDefault: true, createdAt: this.now() }
    try {
      await this.repository.insert(created)
    } catch (error) {
      const winner = await this.repository.defaultFor(userId)
      if (winner) return winner
      throw error
    }
    console.log({ outcome: 'default-profile-created', userId })
    return created
  }

  /** The profile's id and the user it belongs to, whoever that is and default or not, or null for an id that is no profile: what a job needs to act as the profile's user. */
  async find(profileId: string): Promise<Pick<Profile, 'id' | 'userId'> | null> {
    const profile = await this.repository.findById(profileId)
    return profile && { id: profile.id, userId: profile.userId }
  }

  /** The profile if it exists and belongs to the user; null for an unknown id or another user's profile. */
  async ownedBy(userId: string, profileId: string): Promise<Profile | null> {
    const profile = await this.repository.findById(profileId)
    return profile && profile.userId === userId ? profile : null
  }

  /** All of the user's profiles, the default first. */
  async of(userId: string): Promise<Profile[]> {
    return this.repository.ofUser(userId)
  }
}
