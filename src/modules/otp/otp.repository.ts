import { and, desc, eq, gt, gte, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PhoneNumber } from '../../lib/phone'
import { otpChallenges } from './otp.table'
import type { NewOtpChallenge, OtpChallenge } from './otp.types'

export type { NewOtpChallenge, OtpChallenge }

const PURGE_AFTER_MS = 24 * 60 * 60 * 1000

export interface OtpRepository {
  /** The most recently created challenge for the phone, consumed or not; null if none. */
  findLatest(phone: PhoneNumber): Promise<OtpChallenge | null>
  /** Creation times of the phone's challenges at or after `since`, newest first. */
  sendTimes(phone: PhoneNumber, since: Date): Promise<Date[]>
  /** Stores the challenge and deletes the phone's challenges more than 24h older than it, atomically. */
  create(challenge: NewOtpChallenge): Promise<void>
  /** Adds one failed attempt unless `maxAttempts` were already used. Returns the new count, or null. */
  recordFailedAttempt(id: string, maxAttempts: number): Promise<number | null>
  /** Marks the challenge used, only if it is unconsumed, under `maxAttempts` failed tries and unexpired at `at`. False otherwise. */
  consume(id: string, at: Date, maxAttempts: number): Promise<boolean>
}

export class D1OtpRepository implements OtpRepository {
  constructor(private readonly db: Db) {}

  async findLatest(phone: PhoneNumber): Promise<OtpChallenge | null> {
    const [row] = await this.db
      .select()
      .from(otpChallenges)
      .where(eq(otpChallenges.phone, phone))
      .orderBy(desc(otpChallenges.createdAt), sql`rowid desc`) // rowid breaks createdAt ties: the later insert wins
      .limit(1)
    return (row as OtpChallenge | undefined) ?? null
  }

  async sendTimes(phone: PhoneNumber, since: Date): Promise<Date[]> {
    const rows = await this.db
      .select({ createdAt: otpChallenges.createdAt })
      .from(otpChallenges)
      .where(and(eq(otpChallenges.phone, phone), gte(otpChallenges.createdAt, since)))
      .orderBy(desc(otpChallenges.createdAt))
    return rows.map((r) => r.createdAt)
  }

  async create(challenge: NewOtpChallenge): Promise<void> {
    const cutoff = new Date(challenge.createdAt.getTime() - PURGE_AFTER_MS)
    await this.db.batch([
      this.db.delete(otpChallenges).where(and(eq(otpChallenges.phone, challenge.phone), lt(otpChallenges.createdAt, cutoff))),
      this.db.insert(otpChallenges).values(challenge),
    ])
  }

  async recordFailedAttempt(id: string, maxAttempts: number): Promise<number | null> {
    const [row] = await this.db
      .update(otpChallenges)
      .set({ attempts: sql`${otpChallenges.attempts} + 1` })
      .where(and(eq(otpChallenges.id, id), lt(otpChallenges.attempts, maxAttempts)))
      .returning({ attempts: otpChallenges.attempts })
    return row?.attempts ?? null
  }

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
