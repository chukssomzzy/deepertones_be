import { ConflictError, NotFoundError } from '../../lib/errors'
import type { UsersRepository } from './users.repository'
import type { Device, User, UserIdentifier } from './users.types'

const DAY_MS = 24 * 60 * 60 * 1000
const GUEST_RETENTION_DAYS = 90
const PURGE_BATCH = 500
const PURGE_MAX_PER_RUN = 5000

/** Removes whatever a module stores per user. Must be safe to repeat: a failed run is retried from the same guests. */
export type GuestDataCleaner = { name: string; deleteFor: (userIds: string[]) => Promise<void> }

export type UsersServiceDeps = {
  repository: UsersRepository
  /** One per module that keeps per-user data; each runs for a batch before those users are deleted. */
  guestDataCleaners?: GuestDataCleaner[]
  now?: () => Date
  newId?: () => string
}

export class UsersService {
  private readonly repository: UsersRepository
  private readonly guestDataCleaners: GuestDataCleaner[]
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: UsersServiceDeps) {
    this.repository = deps.repository
    this.guestDataCleaners = deps.guestDataCleaners ?? []
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * The guest for a device (given as the hash of its id, never the raw id). A device id only ever
   * yields a guest: if the device's account has been verified since, it is NOT returned (getting
   * into a verified account always takes a code) and the device gets a new, empty guest instead.
   */
  async guestForDevice(deviceHash: string, platform: Device['platform']): Promise<User> {
    const device = await this.repository.findDevice(deviceHash)
    const linked = device ? await this.repository.findById(device.userId) : null
    const at = this.now()
    if (linked?.status === 'anonymous') {
      await Promise.all([this.repository.touch(linked.id, at), this.repository.touchDevice(deviceHash, at)])
      return { ...linked, lastSeenAt: at }
    }
    return this.repository.createGuestForDevice({
      user: { id: this.newId(), createdAt: at },
      device: { deviceHash, platform },
    })
  }

  /**
   * Verifies a guest with an identifier they proved they own. Promotion never moves data: either
   * the guest row itself becomes verified ('promoted'), or the identifier already belongs to
   * another account and that account is returned as 'existing', the calling guest untouched.
   * A race on the identifier (owner appeared after our lookup) resolves the same way.
   */
  async promote(
    userId: string,
    identifier: UserIdentifier,
  ): Promise<{ outcome: 'promoted' | 'existing'; user: User }> {
    // Also covers a verified user signing in again with their own identifier: nothing is written.
    const owner = await this.repository.findByIdentifier(identifier)
    if (owner) return { outcome: 'existing', user: owner }

    const result = await this.repository.promote(userId, identifier, this.now())
    if (result.outcome === 'promoted') return { outcome: 'promoted', user: result.user }
    if (result.outcome === 'taken') {
      const winner = await this.repository.findByIdentifier(identifier)
      if (winner) return { outcome: 'existing', user: winner }
      throw new NotFoundError('USER_NOT_FOUND', 'No such user')
    }
    await this.get(userId) // unknown user: USER_NOT_FOUND rather than NOT_A_GUEST
    throw new ConflictError('NOT_A_GUEST', 'Only a guest account can be verified this way')
  }

  async get(id: string): Promise<User> {
    const user = await this.repository.findById(id)
    if (!user) throw new NotFoundError('USER_NOT_FOUND', 'No such user')
    return user
  }

  async findByIdentifier(identifier: UserIdentifier): Promise<User | null> {
    return this.repository.findByIdentifier(identifier)
  }

  /** Invalidates every refresh token the user holds (logout everywhere); returns the new version. */
  async bumpTokenVersion(userId: string): Promise<number> {
    const version = await this.repository.bumpTokenVersion(userId)
    if (version === null) throw new NotFoundError('USER_NOT_FOUND', 'No such user')
    return version
  }

  async touch(userId: string): Promise<void> {
    await this.repository.touch(userId, this.now())
  }

  /** Detaches every device from the user, so each gets a fresh guest next time. Returns how many. */
  async unlinkDevices(userId: string): Promise<number> {
    return this.repository.unlinkDevices(userId)
  }

  /**
   * Deletes guests that can no longer be reached: no device points at them and they were last seen more
   * than 90 days ago. Verified users are never selected. Works in batches of 500 and stops after 5000 a run
   * (the next run continues). Each batch goes to every cleaner BEFORE the user rows are deleted, so data
   * never outlives its owner; a cleaner that throws aborts the run and that batch's users stay for the next
   * run. Modules that store per-user data must add a cleaner in the container.
   */
  async purgeUnreachableGuests(): Promise<{ deleted: number }> {
    const cutoff = new Date(this.now().getTime() - GUEST_RETENTION_DAYS * DAY_MS)
    let deleted = 0
    while (deleted < PURGE_MAX_PER_RUN) {
      const ids = await this.repository.unreachableGuestIds(cutoff, Math.min(PURGE_BATCH, PURGE_MAX_PER_RUN - deleted))
      if (ids.length === 0) break
      for (const cleaner of this.guestDataCleaners) await cleaner.deleteFor(ids)
      const count = await this.repository.deleteUsers(ids)
      // Nothing deleted means the ids would be selected again forever.
      if (count === 0) break
      deleted += count
    }
    return { deleted }
  }
}
