import { and, asc, eq, inArray, lt, notExists, sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { profiles } from '../profiles/profiles.table'
import { devices, users } from './users.table'
import type { Device, User, UserIdentifier } from './users.types'

export type PromoteResult = { outcome: 'promoted'; user: User } | { outcome: 'taken' } | { outcome: 'not-guest' }

const matches = (identifier: UserIdentifier) =>
  identifier.kind === 'email' ? eq(users.email, identifier.email) : eq(users.phone, identifier.phone)

// Only the email/phone unique indexes mean "taken"; any other constraint failure is a bug and must surface.
// Drizzle wraps the driver error, so the SQLite message may be on the cause.
const isIdentifierTaken = (error: unknown): boolean => {
  for (let e = error as { message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (typeof e.message === 'string' && /UNIQUE constraint failed: users\.(email|phone)\b/.test(e.message)) return true
  }
  return false
}

// D1 allows 100 bound parameters per statement; the status literal and headroom leave this many ids.
const DELETE_CHUNK = 90

export class D1UsersRepository {
  constructor(private readonly db: Db) {}

  /**
   * Creates a guest with its default profile and points the device at it (creating or re-pointing the device row), in ONE
   * batch: a user never exists without its profile, and a profile id that is taken rolls everything back.
   */
  async createGuestForDevice(input: {
    user: { id: string; createdAt: Date }
    device: { deviceHash: string; platform: Device['platform'] }
    profile: { id: string }
  }): Promise<User> {
    const { id, createdAt } = input.user
    const { deviceHash, platform } = input.device
    await this.db.batch([
      this.db.insert(users).values({ id, createdAt, lastSeenAt: createdAt }),
      this.db.insert(profiles).values({ id: input.profile.id, userId: id, displayName: null, isDefault: true, createdAt }),
      this.db
        .insert(devices)
        .values({ deviceHash, platform, userId: id, createdAt, lastSeenAt: createdAt })
        .onConflictDoUpdate({ target: devices.deviceHash, set: { platform, userId: id, lastSeenAt: createdAt } }),
    ])
    return { id, status: 'anonymous', email: null, phone: null, tokenVersion: 0, createdAt, lastSeenAt: createdAt }
  }

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id))
    return (row as User | undefined) ?? null
  }

  async findDevice(deviceHash: string): Promise<Device | null> {
    const [row] = await this.db.select().from(devices).where(eq(devices.deviceHash, deviceHash))
    return row ?? null
  }

  async findByIdentifier(identifier: UserIdentifier): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(matches(identifier))
    return (row as User | undefined) ?? null
  }

  /**
   * Verifies a guest in place: status, identifier, token version + 1 and lastSeenAt in ONE conditional
   * UPDATE that applies only while the row is still a guest. `taken` when another user owns the identifier
   * (the unique index decides, so a race cannot slip through); `not-guest` when the user is unknown or already verified.
   */
  async promote(userId: string, identifier: UserIdentifier, at: Date): Promise<PromoteResult> {
    try {
      const [row] = await this.db
        .update(users)
        .set({
          status: 'verified',
          ...(identifier.kind === 'email' ? { email: identifier.email } : { phone: identifier.phone }),
          tokenVersion: sql`${users.tokenVersion} + 1`,
          lastSeenAt: at,
        })
        .where(and(eq(users.id, userId), eq(users.status, 'anonymous')))
        .returning()
      return row ? { outcome: 'promoted', user: row as User } : { outcome: 'not-guest' }
    } catch (error) {
      if (isIdentifierTaken(error)) return { outcome: 'taken' }
      throw error
    }
  }

  /** Adds one to the user's token version and returns the new value; null if the user is unknown. */
  async bumpTokenVersion(userId: string): Promise<number | null> {
    const [row] = await this.db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, userId))
      .returning({ tokenVersion: users.tokenVersion })
    return row?.tokenVersion ?? null
  }

  /** Records that the device was seen at `at`. */
  async touchDevice(deviceHash: string, at: Date): Promise<void> {
    await this.db.update(devices).set({ lastSeenAt: at }).where(eq(devices.deviceHash, deviceHash))
  }

  async touch(userId: string, at: Date): Promise<void> {
    await this.db.update(users).set({ lastSeenAt: at }).where(eq(users.id, userId))
  }

  /** Removes every device row pointing at the user and returns how many there were. */
  async unlinkDevices(userId: string): Promise<number> {
    const rows = await this.db.delete(devices).where(eq(devices.userId, userId)).returning({ deviceHash: devices.deviceHash })
    return rows.length
  }

  /** Ids of guests no device points at and nobody has seen since before the cutoff, oldest first. */
  async unreachableGuestIds(lastSeenBefore: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.status, 'anonymous'),
          lt(users.lastSeenAt, lastSeenBefore),
          notExists(this.db.select({ one: sql`1` }).from(devices).where(eq(devices.userId, users.id))),
        ),
      )
      .orderBy(asc(users.lastSeenAt))
      .limit(limit)
    return rows.map((row) => row.id)
  }

  /**
   * Deletes guests (never a verified user, even if its id is passed) and returns how many went. Their device
   * rows go with them through the foreign key's ON DELETE CASCADE. Chunked under D1's bound-parameter limit, in
   * ONE batch so the whole call is all-or-nothing.
   */
  async deleteUsers(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const statements = []
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      statements.push(
        this.db
          .delete(users)
          .where(and(inArray(users.id, ids.slice(i, i + DELETE_CHUNK)), eq(users.status, 'anonymous')))
          .returning({ id: users.id }),
      )
    }
    const results = await this.db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]])
    return results.reduce((total, rows) => total + rows.length, 0)
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type UsersRepository = PublicOf<D1UsersRepository>
