import { and, eq, gte, ne, sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import type { AiJob, AiUsage } from '../../providers/anthropic/ai-spend.provider'
import { aiUsage } from './ai-usage.table'

/** The vendor of every Claude row, and the column's default. */
const ANTHROPIC = 'anthropic'

/** Spend committed since a moment: settled calls at what they cost plus open reservations at their estimate. Released ones are nothing. */
const committed = sql`coalesce(sum(case ${aiUsage.status} when 'settled' then ${aiUsage.costMicros} when 'reserved' then ${aiUsage.estimateMicros} else 0 end), 0)`

export class D1AiUsageRepository {
  constructor(private readonly db: Db) {}

  /**
   * Stores the reservation, always: an environment-wide limit never refuses a call. Says whether what is committed since `since`,
   * this reservation included, passes `capMicros`, so the caller can raise an alert. The insert and the sum are ONE batch (a
   * transaction on D1), so the answer is not made stale by a call that lands between them.
   */
  async insertReservation(input: {
    id: string
    job: AiJob
    model: string
    estimateMicros: number
    createdAt: Date
    capMicros: number
    since: Date
  }): Promise<{ overCap: boolean }> {
    const [, [total]] = await this.db.batch([
      this.db.insert(aiUsage).values({
        id: input.id,
        job: input.job,
        model: input.model,
        status: 'reserved',
        estimateMicros: input.estimateMicros,
        createdAt: input.createdAt,
      }),
      this.db.select({ micros: sql<number>`${committed}` }).from(aiUsage).where(gte(aiUsage.createdAt, input.since)),
    ])
    return { overCap: (total?.micros ?? 0) > input.capMicros }
  }

  /**
   * Stores one call of a per-unit vendor that has already succeeded, as a settled row: nothing is reserved first, because nothing would
   * ever release it. Stored, and says whether what is committed since `since`, this call included, passes `capMicros`; the insert
   * and the sum are ONE batch, as in `insertReservation`. An `id` that is already stored is a repeat of the same vendor task: nothing is
   * written, and the answer is `{ overCap: false }` since this call added nothing to alert about.
   */
  async insertSettled(input: {
    id: string
    vendor: string
    job: string
    units: number
    costMicros: number
    createdAt: Date
    capMicros: number
    since: Date
  }): Promise<{ overCap: boolean }> {
    const [inserted, [total]] = await this.db.batch([
      this.db.insert(aiUsage).values({
        id: input.id,
        vendor: input.vendor,
        job: input.job,
        // A vendor call has no model and no estimate (both columns are NOT NULL): the model column names the vendor, and the estimate is what it cost.
        model: input.vendor,
        status: 'settled',
        estimateMicros: input.costMicros,
        costMicros: input.costMicros,
        units: input.units,
        createdAt: input.createdAt,
        settledAt: input.createdAt,
      }).onConflictDoNothing({ target: aiUsage.id }).returning({ id: aiUsage.id }),
      this.db.select({ micros: sql<number>`${committed}` }).from(aiUsage).where(gte(aiUsage.createdAt, input.since)),
    ])
    return { overCap: inserted.length > 0 && (total?.micros ?? 0) > input.capMicros }
  }

  /** Only a reservation that is still open can be settled, so the first settlement stands and a released one stays unbilled. */
  async settle(id: string, input: { usage: AiUsage; costMicros: number; settledAt: Date }): Promise<void> {
    await this.db
      .update(aiUsage)
      .set({
        status: 'settled',
        costMicros: input.costMicros,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        cacheWriteTokens: input.usage.cacheWriteTokens,
        cacheReadTokens: input.usage.cacheReadTokens,
        webSearches: input.usage.webSearches,
        settledAt: input.settledAt,
      })
      .where(and(eq(aiUsage.id, id), eq(aiUsage.status, 'reserved')))
  }

  /** Only a reservation that is still open can be released; a settled call stays billed. */
  async release(id: string): Promise<void> {
    await this.db
      .update(aiUsage)
      .set({ status: 'released' })
      .where(and(eq(aiUsage.id, id), eq(aiUsage.status, 'reserved')))
  }

  /** What is committed to the cap for requests reserved at or after `since`, by when they were reserved and not when they settled. */
  async committedMicrosSince(since: Date): Promise<number> {
    const [row] = await this.db.select({ micros: sql<number>`${committed}` }).from(aiUsage).where(gte(aiUsage.createdAt, since))
    return row?.micros ?? 0
  }

  /** Settled Claude calls reserved at or after `since`, added up per job and model. Other vendors' calls are in `vendorSummary`. */
  async summary(since: Date): Promise<
    {
      job: AiJob
      model: string
      calls: number
      inputTokens: number
      outputTokens: number
      cacheWriteTokens: number
      cacheReadTokens: number
      webSearches: number
      costMicros: number
    }[]
  > {
    const rows = await this.db
      .select({
        job: aiUsage.job,
        model: aiUsage.model,
        calls: sql<number>`count(*)`,
        inputTokens: sql<number>`sum(${aiUsage.inputTokens})`,
        outputTokens: sql<number>`sum(${aiUsage.outputTokens})`,
        cacheWriteTokens: sql<number>`sum(${aiUsage.cacheWriteTokens})`,
        cacheReadTokens: sql<number>`sum(${aiUsage.cacheReadTokens})`,
        webSearches: sql<number>`sum(${aiUsage.webSearches})`,
        costMicros: sql<number>`sum(${aiUsage.costMicros})`,
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.status, 'settled'), eq(aiUsage.vendor, ANTHROPIC), gte(aiUsage.createdAt, since)))
      .groupBy(aiUsage.job, aiUsage.model)
    return rows.map((row) => ({ ...row, job: row.job as AiJob }))
  }

  /** Settled calls of the per-unit vendors at or after `since`, added up per vendor and job. */
  async vendorSummary(since: Date): Promise<{ vendor: string; job: string; calls: number; units: number; costMicros: number }[]> {
    return this.db
      .select({
        vendor: aiUsage.vendor,
        job: aiUsage.job,
        calls: sql<number>`count(*)`,
        units: sql<number>`sum(${aiUsage.units})`,
        costMicros: sql<number>`sum(${aiUsage.costMicros})`,
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.status, 'settled'), ne(aiUsage.vendor, ANTHROPIC), gte(aiUsage.createdAt, since)))
      .groupBy(aiUsage.vendor, aiUsage.job)
  }
}

// The D1 class is the source of truth; the service and the fake use this type.
export type AiUsageRepository = PublicOf<D1AiUsageRepository>
