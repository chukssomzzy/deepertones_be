import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1JobRunsRepository } from '../../src/jobs/job-runs.repository'
import { freshJob, jobRunsRepositoryContract } from '../../src/jobs/job-runs.repository.contract'

const NOW = new Date('2030-06-15T12:00:00.000Z')
const make = () => new D1JobRunsRepository(createDb(env.DB))

jobRunsRepositoryContract('D1', make)

describe('D1JobRunsRepository under concurrency', () => {
  it('lets exactly one of 20 parallel claims of one key win', async () => {
    const repo = make()
    const job = freshJob()

    const outcomes = await Promise.all(Array.from({ length: 20 }, () => repo.claim(job, 'k', NOW, 2 * 60 * 1000)))

    expect(outcomes.filter((o) => o.outcome === 'claimed')).toHaveLength(1)
    expect(outcomes.filter((o) => o.outcome === 'busy')).toHaveLength(19)
    expect((await repo.get(job, 'k'))!.attempts).toBe(1)
  })
})
