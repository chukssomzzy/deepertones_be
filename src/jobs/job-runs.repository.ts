import { and, eq, lt, lte, sql } from 'drizzle-orm'
import type { Db } from '../lib/db'
import type { PublicOf } from '../lib/types'
import { jobRuns } from './job-runs.table'

export type JobRun = typeof jobRuns.$inferSelect
/** `token` is the lease expiry in ms; markDone and release must present it, so a worker whose lease was taken over cannot touch the new owner's run. */
export type ClaimResult = { outcome: 'claimed'; token: number } | { outcome: 'busy' | 'done' | 'failed' }

export class D1JobRunsRepository {
  constructor(private readonly db: Db) {}

  async get(job: string, key: string): Promise<JobRun | null> {
    const [row] = await this.db
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.job, job), eq(jobRuns.key, key)))
    return row ?? null
  }

  /**
   * Takes the run for one attempt: a new key, or a running one whose lease has run out. One
   * statement, so parallel claims of a key cannot both win. Otherwise says why not.
   */
  async claim(job: string, key: string, now: Date, leaseMs: number): Promise<ClaimResult> {
    const leaseUntil = new Date(now.getTime() + leaseMs)
    const claimed = await this.db
      .insert(jobRuns)
      .values({ job, key, status: 'running', leaseUntil, updatedAt: now, attempts: 1 })
      .onConflictDoUpdate({
        target: [jobRuns.job, jobRuns.key],
        set: { leaseUntil, updatedAt: now, attempts: sql`${jobRuns.attempts} + 1` },
        // <=, not <: a released run (lease ended at the release time) is claimable at once.
        setWhere: and(eq(jobRuns.status, 'running'), lte(jobRuns.leaseUntil, now)),
      })
      .returning({ job: jobRuns.job })
    if (claimed.length === 1) return { outcome: 'claimed', token: leaseUntil.getTime() }

    const run = await this.get(job, key)
    return { outcome: run?.status === 'done' || run?.status === 'failed' ? run.status : 'busy' }
  }

  /** Terminal: later claims of the key report 'done'. False if `token` is not the run's current lease. */
  async markDone(job: string, key: string, token: number, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(jobRuns)
      .set({ status: 'done', leaseUntil: null, updatedAt: at })
      .where(this.ownedBy(job, key, token))
      .returning({ job: jobRuns.job })
    return rows.length === 1
  }

  /** Terminal. Creates the run if none exists (a dead letter may arrive for a key never claimed). */
  async markFailed(job: string, key: string, error: string, at: Date): Promise<void> {
    await this.db
      .insert(jobRuns)
      .values({ job, key, status: 'failed', updatedAt: at, attempts: 0, lastError: error })
      .onConflictDoUpdate({
        target: [jobRuns.job, jobRuns.key],
        set: { status: 'failed', leaseUntil: null, updatedAt: at, lastError: error },
      })
  }

  /**
   * Ends the lease now, keeping the run 'running', so the queue's redelivery can claim it again.
   * False if `token` is not the run's current lease.
   */
  async release(job: string, key: string, token: number, error: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(jobRuns)
      .set({ leaseUntil: at, updatedAt: at, lastError: error })
      .where(this.ownedBy(job, key, token))
      .returning({ job: jobRuns.job })
    return rows.length === 1
  }

  private ownedBy(job: string, key: string, token: number) {
    return and(
      eq(jobRuns.job, job),
      eq(jobRuns.key, key),
      eq(jobRuns.status, 'running'),
      eq(jobRuns.leaseUntil, new Date(token)),
    )
  }

  /** Deletes runs last updated before `cutoff`. */
  async purgeOlderThan(cutoff: Date): Promise<void> {
    await this.db.delete(jobRuns).where(lt(jobRuns.updatedAt, cutoff))
  }
}

// The D1 class is the source of truth; the dispatcher and fakes use this type.
export type JobRunsRepository = PublicOf<D1JobRunsRepository>
