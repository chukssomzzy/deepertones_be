import { describe, expect, it } from 'vitest'
import type { JobRunsRepository } from './job-runs.repository'

const NOW = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const DAY = 24 * 60 * MINUTE
const LEASE_MS = 2 * MINUTE
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

// Unique per test, so tests never depend on order against a shared D1.
const runSalt = crypto.randomUUID().slice(0, 8)
let counter = 0
export const freshJob = () => `contract-job-${runSalt}-${counter++}`

/** Claims and returns the lease token, failing the test if the claim was not won. */
const claimed = async (repo: JobRunsRepository, job: string, key: string, now: Date) => {
  const result = await repo.claim(job, key, now, LEASE_MS)
  if (result.outcome !== 'claimed') throw new Error(`expected a claimed run, got ${result.outcome}`)
  return result.token
}

/**
 * Behaviour every JobRunsRepository must have. Runs against the fake (unit tier) and
 * real local D1 (integration tier). A claim counts as one attempt, and returns a lease token
 * (the lease expiry in ms) that markDone and release must present, so a stale owner cannot
 * touch a run that has since been reclaimed.
 */
export const jobRunsRepositoryContract = (name: string, make: () => JobRunsRepository | Promise<JobRunsRepository>) => {
  describe(`JobRunsRepository contract: ${name}`, () => {
    it('get returns null for a run that was never claimed', async () => {
      const repo = await make()

      expect(await repo.get(freshJob(), 'k')).toBeNull()
    })

    it('claims a new key, recording it as running with a lease and one attempt, and returns the lease expiry as the token', async () => {
      const repo = await make()
      const job = freshJob()

      expect(await repo.claim(job, 'k', NOW, LEASE_MS)).toEqual({ outcome: 'claimed', token: at(LEASE_MS).getTime() })

      const run = await repo.get(job, 'k')
      expect(run).toMatchObject({ status: 'running', attempts: 1, lastError: null })
      expect(run!.leaseUntil!.getTime()).toBe(at(LEASE_MS).getTime())
      expect(run!.updatedAt.getTime()).toBe(NOW.getTime())
    })

    it('reports busy while another claim holds a live lease', async () => {
      const repo = await make()
      const job = freshJob()
      await repo.claim(job, 'k', NOW, LEASE_MS)

      expect(await repo.claim(job, 'k', at(LEASE_MS - 1), LEASE_MS)).toEqual({ outcome: 'busy' })
      expect((await repo.get(job, 'k'))!.attempts).toBe(1)
    })

    it('lets a claim take over a run whose lease has expired, counting another attempt', async () => {
      const repo = await make()
      const job = freshJob()
      await repo.claim(job, 'k', NOW, LEASE_MS)

      const result = await repo.claim(job, 'k', at(LEASE_MS + 1), LEASE_MS)

      expect(result).toEqual({ outcome: 'claimed', token: at(LEASE_MS + 1 + LEASE_MS).getTime() })
      const run = await repo.get(job, 'k')
      expect(run!.attempts).toBe(2)
      expect(run!.leaseUntil!.getTime()).toBe(at(LEASE_MS + 1 + LEASE_MS).getTime())
    })

    it('treats the same key under different jobs as separate runs', async () => {
      const repo = await make()
      await repo.claim(freshJob(), 'k', NOW, LEASE_MS)

      expect((await repo.claim(freshJob(), 'k', NOW, LEASE_MS)).outcome).toBe('claimed')
    })

    it('markDone makes the key terminal: later claims report done, even after the lease would have expired', async () => {
      const repo = await make()
      const job = freshJob()
      const token = await claimed(repo, job, 'k', NOW)

      expect(await repo.markDone(job, 'k', token, at(SECOND))).toBe(true)

      expect(await repo.get(job, 'k')).toMatchObject({ status: 'done' })
      expect((await repo.get(job, 'k'))!.updatedAt.getTime()).toBe(at(SECOND).getTime())
      expect(await repo.claim(job, 'k', at(LEASE_MS * 10), LEASE_MS)).toEqual({ outcome: 'done' })
    })

    it('markDone is refused with a token that is not the run current lease', async () => {
      const repo = await make()
      const job = freshJob()
      const token = await claimed(repo, job, 'k', NOW)

      expect(await repo.markDone(job, 'k', token + 1, at(SECOND))).toBe(false)
      expect(await repo.markDone(job, 'unknown', token, at(SECOND))).toBe(false)
      expect((await repo.get(job, 'k'))!.status).toBe('running')
    })

    it('markFailed records the error and makes the key terminal', async () => {
      const repo = await make()
      const job = freshJob()
      await repo.claim(job, 'k', NOW, LEASE_MS)

      await repo.markFailed(job, 'k', 'no such number', at(SECOND))

      expect(await repo.get(job, 'k')).toMatchObject({ status: 'failed', lastError: 'no such number' })
      expect(await repo.claim(job, 'k', at(LEASE_MS * 10), LEASE_MS)).toEqual({ outcome: 'failed' })
    })

    it('markFailed creates the run when none exists', async () => {
      const repo = await make()
      const job = freshJob()

      await repo.markFailed(job, 'never-claimed', 'dead-lettered', NOW)

      expect(await repo.get(job, 'never-claimed')).toMatchObject({ status: 'failed', lastError: 'dead-lettered' })
      expect(await repo.claim(job, 'never-claimed', at(MINUTE), LEASE_MS)).toEqual({ outcome: 'failed' })
    })

    it('release keeps the run running but frees it at once, recording the error', async () => {
      const repo = await make()
      const job = freshJob()
      const token = await claimed(repo, job, 'k', NOW)

      expect(await repo.release(job, 'k', token, 'meta timed out', at(SECOND))).toBe(true)

      const run = await repo.get(job, 'k')
      expect(run).toMatchObject({ status: 'running', attempts: 1, lastError: 'meta timed out' })
      expect(run!.leaseUntil!.getTime()).toBeLessThanOrEqual(at(SECOND).getTime())
      expect((await repo.claim(job, 'k', at(SECOND), LEASE_MS)).outcome).toBe('claimed')
      expect((await repo.get(job, 'k'))!.attempts).toBe(2)
    })

    it('counts one attempt per claim across repeated release and reclaim', async () => {
      const repo = await make()
      const job = freshJob()

      for (let i = 1; i <= 3; i++) {
        const token = await claimed(repo, job, 'k', at(i * SECOND))
        await repo.release(job, 'k', token, `failure ${i}`, at(i * SECOND))
      }

      expect(await repo.get(job, 'k')).toMatchObject({ attempts: 3, lastError: 'failure 3' })
    })

    it('stops a stale owner from releasing or completing a run that was reclaimed after its lease expired', async () => {
      const repo = await make()
      const job = freshJob()
      const staleToken = await claimed(repo, job, 'k', NOW)
      const reclaimAt = at(LEASE_MS + 1)
      const currentToken = await claimed(repo, job, 'k', reclaimAt)

      expect(await repo.release(job, 'k', staleToken, 'late failure', at(LEASE_MS + 2))).toBe(false)

      const run = await repo.get(job, 'k')
      expect(run).toMatchObject({ status: 'running', attempts: 2, lastError: null })
      expect(run!.leaseUntil!.getTime()).toBe(currentToken)
      expect(await repo.claim(job, 'k', at(LEASE_MS + 3), LEASE_MS)).toEqual({ outcome: 'busy' })

      expect(await repo.markDone(job, 'k', staleToken, at(LEASE_MS + 4))).toBe(false)
      expect((await repo.get(job, 'k'))!.status).toBe('running')
      expect(await repo.markDone(job, 'k', currentToken, at(LEASE_MS + 5))).toBe(true)
      expect((await repo.get(job, 'k'))!.status).toBe('done')
    })

    it('purgeOlderThan removes runs last updated before the cutoff and keeps the rest', async () => {
      const repo = await make()
      const job = freshJob()
      const cutoff = at(-7 * DAY)
      await repo.markFailed(job, 'old', 'x', new Date(cutoff.getTime() - 1))
      await repo.markFailed(job, 'at-cutoff', 'x', cutoff)
      await repo.markFailed(job, 'recent', 'x', at(-6 * DAY))

      await repo.purgeOlderThan(cutoff)

      expect(await repo.get(job, 'old')).toBeNull()
      expect(await repo.get(job, 'at-cutoff')).not.toBeNull()
      expect(await repo.get(job, 'recent')).not.toBeNull()
    })
  })
}
