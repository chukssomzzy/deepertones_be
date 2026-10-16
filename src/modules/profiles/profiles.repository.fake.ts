import type { ProfilesRepository } from './profiles.repository'
import type { Profile } from './profiles.types'

/**
 * In-memory ProfilesRepository for unit tests. Its behaviour is pinned by profilesRepositoryContract, which the D1 class also passes.
 *
 * `insert` rejects a second default for a user, as the unique index does in D1. `assertInsertable` and `deleteForUsers` are NOT part of
 * the repository: they are how FakeUsersRepository checks, writes and removes profiles in step with its users, the way D1 does with one
 * batch and a cascade.
 */
export class FakeProfilesRepository implements ProfilesRepository {
  private profiles = new Map<string, Profile>()

  async findById(id: string): Promise<Profile | null> {
    const profile = this.profiles.get(id)
    return profile ? { ...profile } : null
  }

  async defaultFor(userId: string): Promise<Profile | null> {
    const found = [...this.profiles.values()].find((p) => p.userId === userId && p.isDefault)
    return found ? { ...found } : null
  }

  /** The user's profiles: the default first, then the others oldest first. */
  async ofUser(userId: string): Promise<Profile[]> {
    return [...this.profiles.values()]
      .filter((p) => p.userId === userId)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.getTime() - b.createdAt.getTime())
      .map((p) => ({ ...p }))
  }

  /** Rejects an id that is taken, and a second default for the same user. */
  async insert(profile: Profile): Promise<void> {
    if (this.profiles.has(profile.id)) throw new Error('duplicate profile id')
    if (profile.isDefault && [...this.profiles.values()].some((p) => p.userId === profile.userId && p.isDefault)) {
      throw new Error('user already has a default profile')
    }
    this.profiles.set(profile.id, { ...profile })
  }

  /** Test-support, used by FakeUsersRepository: throws when `insert` would, for an id that is taken, so the caller can check before it writes anything. */
  assertInsertable(profile: Profile): void {
    if (this.profiles.has(profile.id)) throw new Error('duplicate profile id')
  }

  /** Test-support, used by FakeUsersRepository: what the cascade does when users are deleted. */
  deleteForUsers(userIds: string[]): void {
    for (const [id, profile] of this.profiles) if (userIds.includes(profile.userId)) this.profiles.delete(id)
  }
}
