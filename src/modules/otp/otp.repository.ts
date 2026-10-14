import { and, desc, eq, gt, gte, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { otpChallenges } from './otp.table'
import type { NewOtpChallenge, OtpChallenge, OtpRecipient } from './otp.types'

export type { NewOtpChallenge, OtpChallenge }

const PURGE_AFTER_MS = 24 * 60 * 60 * 1000

const forRecipient = (r: OtpRecipient) => and(eq(otpChallenges.channel, r.channel), eq(otpChallenges.address, r.address))

export class D1OtpRepository {
  constructor(private readonly db: Db) {}

  /** The most recently created challenge for the recipient, consumed or not; null if none. */
  async findLatest(recipient: OtpRecipient): Promise<OtpChallenge | null> {
    const [row] = await this.db
      .select()
      .from(otpChallenges)
      .where(forRecipient(recipient))
      .orderBy(desc(otpChallenges.createdAt), sql`rowid desc`) // rowid breaks createdAt ties: the later insert wins
      .limit(1)
    return (row as OtpChallenge | undefined) ?? null
  }

  /** The challenge with this id, whether or not it is the latest for its recipient; null if none. */
  async findById(id: string): Promise<OtpChallenge | null> {
    const [row] = await this.db.select().from(otpChallenges).where(eq(otpChallenges.id, id))
    return (row as OtpChallenge | undefined) ?? null
  }

  /** Creation times of the recipient's challenges at or after `since`, newest first, leaving out those that failed as 'unavailable' (our outage must not use up the person's limits; a rejected recipient still counts). */
  async sendTimes(recipient: OtpRecipient, since: Date): Promise<Date[]> {
    const rows = await this.db
      .select({ createdAt: otpChallenges.createdAt })
      .from(otpChallenges)
      .where(and(forRecipient(recipient), gte(otpChallenges.createdAt, since), or(ne(otpChallenges.deliveryStatus, 'failed'), ne(otpChallenges.failureReason, 'unavailable'))))
      .orderBy(desc(otpChallenges.createdAt))
    return rows.map((r) => r.createdAt)
  }

  /** Stores the challenge and deletes the recipient's challenges more than 24h older than it, atomically. */
  async create(challenge: NewOtpChallenge): Promise<void> {
    const cutoff = new Date(challenge.createdAt.getTime() - PURGE_AFTER_MS)
    await this.db.batch([
      this.db.delete(otpChallenges).where(and(forRecipient(challenge), lt(otpChallenges.createdAt, cutoff))),
      this.db.insert(otpChallenges).values(challenge),
    ])
  }

  /** Adds one failed attempt unless `maxAttempts` were already used. Returns the new count, or null. */
  async recordFailedAttempt(id: string, maxAttempts: number): Promise<number | null> {
    const [row] = await this.db
      .update(otpChallenges)
      .set({ attempts: sql`${otpChallenges.attempts} + 1` })
      .where(and(eq(otpChallenges.id, id), lt(otpChallenges.attempts, maxAttempts)))
      .returning({ attempts: otpChallenges.attempts })
    return row?.attempts ?? null
  }

  /** queued -> delivered, once. False if the challenge is unknown or no longer queued. */
  async markDelivered(id: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(otpChallenges)
      .set({ deliveryStatus: 'delivered', deliveredAt: at })
      .where(and(eq(otpChallenges.id, id), eq(otpChallenges.deliveryStatus, 'queued')))
      .returning({ id: otpChallenges.id })
    return rows.length === 1
  }

  /** queued -> failed with a reason, once. A delivered challenge is never overridden. */
  async markFailed(id: string, reason: NonNullable<OtpChallenge['failureReason']>): Promise<boolean> {
    const rows = await this.db
      .update(otpChallenges)
      .set({ deliveryStatus: 'failed', failureReason: reason })
      .where(and(eq(otpChallenges.id, id), eq(otpChallenges.deliveryStatus, 'queued')))
      .returning({ id: otpChallenges.id })
    return rows.length === 1
  }

  /** Marks the challenge used, only if it is unconsumed, under `maxAttempts` failed tries and unexpired at `at`. False otherwise. */
  async consume(id: string, at: Date, maxAttempts: number): Promise<boolean> {
    const rows = await this.db
      .update(otpChallenges)
      .set({ consumedAt: at })
      .where(
        and(
          eq(otpChallenges.id, id),
          isNull(otpChallenges.consumedAt),
          lt(otpChallenges.attempts, maxAttempts),
          gt(otpChallenges.expiresAt, at),
        ),
      )
      .returning({ id: otpChallenges.id })
    return rows.length === 1
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type OtpRepository = PublicOf<D1OtpRepository>
