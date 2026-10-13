import type { ClaimResult, JobRun, JobRunsRepository } from './job-runs.repository'

export class FakeJobRunsRepository implements JobRunsRepository {
  private readonly runs = new Map<string, JobRun>()

  private static id(job: string, key: string) {
    return JSON.stringify([job, key])
  }

  async get(job: string, key: string): Promise<JobRun | null> {
    const run = this.runs.get(FakeJobRunsRepository.id(job, key))
    return run ? { ...run } : null
  }

  async claim(job: string, key: string, now: Date, leaseMs: number): Promise<ClaimResult> {
    const id = FakeJobRunsRepository.id(job, key)
    const run = this.runs.get(id)
    const leaseUntil = new Date(now.getTime() + leaseMs)
    if (!run) {
      this.runs.set(id, { job, key, status: 'running', leaseUntil, updatedAt: now, attempts: 1, lastError: null })
      return { outcome: 'claimed', token: leaseUntil.getTime() }
    }
    if (run.status !== 'running') return { outcome: run.status }
    if (run.leaseUntil && run.leaseUntil > now) return { outcome: 'busy' }
    Object.assign(run, { leaseUntil, updatedAt: now, attempts: run.attempts + 1 })
    return { outcome: 'claimed', token: leaseUntil.getTime() }
  }

  private owned(job: string, key: string, token: number) {
    const run = this.runs.get(FakeJobRunsRepository.id(job, key))
    return run?.status === 'running' && run.leaseUntil?.getTime() === token ? run : undefined
  }

  async markDone(job: string, key: string, token: number, at: Date): Promise<boolean> {
    const run = this.owned(job, key, token)
    if (!run) return false
    Object.assign(run, { status: 'done', leaseUntil: null, updatedAt: at })
    return true
  }

  async markFailed(job: string, key: string, error: string, at: Date): Promise<void> {
    const id = FakeJobRunsRepository.id(job, key)
    const run = this.runs.get(id)
    if (run) Object.assign(run, { status: 'failed', leaseUntil: null, updatedAt: at, lastError: error })
    else this.runs.set(id, { job, key, status: 'failed', leaseUntil: null, updatedAt: at, attempts: 0, lastError: error })
  }

  async release(job: string, key: string, token: number, error: string, at: Date): Promise<boolean> {
    const run = this.owned(job, key, token)
    if (!run) return false
    Object.assign(run, { leaseUntil: at, updatedAt: at, lastError: error })
    return true
  }

  async purgeOlderThan(cutoff: Date): Promise<void> {
    for (const [id, run] of this.runs) if (run.updatedAt < cutoff) this.runs.delete(id)
  }
}
