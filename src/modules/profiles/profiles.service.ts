import { NotFoundError } from '../../lib/errors'
import type { ProfilesRepository } from './profiles.repository'
import type { Profile } from './profiles.types'

export type ProfilesServiceDeps = { repository: ProfilesRepository }

/** Reads profiles. Creating and deleting them is not a service concern yet: the default is written with its user, and goes with it. */
export class ProfilesService {
  private readonly repository: ProfilesRepository

  constructor(deps: ProfilesServiceDeps) {
    this.repository = deps.repository
  }

  /** The user's default profile. Every user has one, so a user without one is a wiring bug. */
  async defaultFor(userId: string): Promise<Profile> {
    const profile = await this.repository.defaultFor(userId)
    if (!profile) throw new NotFoundError('PROFILE_NOT_FOUND', 'No such profile')
    return profile
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
