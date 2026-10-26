import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import type { UsersRepository } from './users.repository'
import type { Device, User, UserIdentifier } from './users.types'

const clash = (users: Map<string, User>, userId: string, identifier: UserIdentifier) =>
  [...users.values()].some((u) =>
    u.id !== userId && (identifier.kind === 'email' ? u.email === identifier.email : u.phone === identifier.phone),
  )

export class FakeUsersRepository implements UsersRepository {
  private users = new Map<string, User>()
  private devices = new Map<string, Device>()
  private readonly profiles: FakeProfilesRepository

  /** Pass the fake profiles repository a test reads from: this one writes each guest's default profile into it, and deleting users removes theirs. */
  constructor(options: { profiles?: FakeProfilesRepository } = {}) {
    this.profiles = options.profiles ?? new FakeProfilesRepository()
  }

  async createGuestForDevice(input: {
    user: { id: string; createdAt: Date }
    device: { deviceHash: string; platform: Device['platform'] }
    profile: { id: string }
  }): Promise<User> {
    const profile = { id: input.profile.id, userId: input.user.id, displayName: null, isDefault: true, createdAt: input.user.createdAt }
    // All or nothing, like the D1 batch: a profile that cannot be stored leaves no user and no device change behind.
    this.profiles.assertInsertable(profile)
    const user: User = {
      id: input.user.id,
      status: 'anonymous',
      email: null,
      phone: null,
      tokenVersion: 0,
      createdAt: input.user.createdAt,
      lastSeenAt: input.user.createdAt,
    }
    this.users.set(user.id, user)
    await this.profiles.insert(profile)
    const existing = this.devices.get(input.device.deviceHash)
    this.devices.set(input.device.deviceHash, {
      deviceHash: input.device.deviceHash,
      platform: input.device.platform,
      userId: user.id,
      createdAt: existing?.createdAt ?? input.user.createdAt,
      lastSeenAt: input.user.createdAt,
    })
    return { ...user }
  }

  async findById(id: string): Promise<User | null> {
    const user = this.users.get(id)
    return user ? { ...user } : null
  }

  async findDevice(deviceHash: string): Promise<Device | null> {
    const device = this.devices.get(deviceHash)
    return device ? { ...device } : null
  }

  async findByIdentifier(identifier: UserIdentifier): Promise<User | null> {
    const found = [...this.users.values()].find((u) =>
      identifier.kind === 'email' ? u.email === identifier.email : u.phone === identifier.phone,
    )
    return found ? { ...found } : null
  }

  async promote(
    userId: string,
    identifier: UserIdentifier,
    at: Date,
  ): Promise<{ outcome: 'promoted'; user: User } | { outcome: 'taken' } | { outcome: 'not-guest' }> {
    const user = this.users.get(userId)
    if (!user || user.status !== 'anonymous') return { outcome: 'not-guest' }
    if (clash(this.users, userId, identifier)) return { outcome: 'taken' }
    user.status = 'verified'
    this.profiles.markVerified(userId)
    if (identifier.kind === 'email') user.email = identifier.email
    else user.phone = identifier.phone
    user.tokenVersion += 1
    user.lastSeenAt = at
    return { outcome: 'promoted', user: { ...user } }
  }

  async bumpTokenVersion(userId: string): Promise<number | null> {
    const user = this.users.get(userId)
    if (!user) return null
    return ++user.tokenVersion
  }

  async touch(userId: string, at: Date): Promise<void> {
    const user = this.users.get(userId)
    if (user) user.lastSeenAt = at
  }

  async touchDevice(deviceHash: string, at: Date): Promise<void> {
    const device = this.devices.get(deviceHash)
    if (device) device.lastSeenAt = at
  }

  async unlinkDevices(userId: string): Promise<number> {
    let count = 0
    for (const [hash, device] of this.devices) {
      if (device.userId === userId) {
        this.devices.delete(hash)
        count++
      }
    }
    return count
  }

  async unreachableGuestIds(lastSeenBefore: Date, limit: number): Promise<string[]> {
    const linked = new Set([...this.devices.values()].map((d) => d.userId))
    return [...this.users.values()]
      .filter((u) => u.status === 'anonymous' && !linked.has(u.id) && u.lastSeenAt.getTime() < lastSeenBefore.getTime())
      .sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime())
      .slice(0, limit)
      .map((u) => u.id)
  }

  async deleteUsers(ids: string[]): Promise<number> {
    let count = 0
    for (const id of ids) {
      if (this.users.get(id)?.status !== 'anonymous') continue
      this.users.delete(id)
      this.profiles.deleteForUsers([id])
      for (const [hash, device] of this.devices) if (device.userId === id) this.devices.delete(hash)
      count++
    }
    return count
  }
}
