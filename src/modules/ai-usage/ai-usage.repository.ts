import { and, eq, gte, sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import type { AiJob, AiUsage } from '../../providers/anthropic/ai-spend.provider'
import { aiUsage } from './ai-usage.table'

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

  /** Settled calls reserved at or after `since`, added up per job and model. */
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
      .where(and(eq(aiUsage.status, 'settled'), gte(aiUsage.createdAt, since)))
      .groupBy(aiUsage.job, aiUsage.model)
    return rows.map((row) => ({ ...row, job: row.job as AiJob }))
  }
}

// The D1 class is the source of truth; the service and the fake use this type.
export type AiUsageRepository = PublicOf<D1AiUsageRepository>
