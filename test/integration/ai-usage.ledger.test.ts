import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1AiUsageRepository } from '../../src/modules/ai-usage/ai-usage.repository'
import { AiUsageService } from '../../src/modules/ai-usage/ai-usage.service'
import { FakeOpsAlertsRepository } from '../../src/modules/ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'

const DAY = 24 * 60 * 60 * 1000
const FIRST_DAY = Date.UTC(2031, 0, 1)
const runSalt = Math.floor(Math.random() * 36_500)
let counter = 0

/** Each service gets a UTC day nobody else used, because the cap and the alert are per day. */
const ledger = (capMicros: number) => {
  const dayStart = new Date(FIRST_DAY + (runSalt + counter++) * DAY)
  const today = new Date(dayStart.getTime() + 12 * 60 * 60 * 1000)
  const db = createDb(env.DB)
  const jobs = new MemoryJobQueue()
  const opsAlerts = new OpsAlertsService({
    // The claim table has its own D1 twin; this file is about the ledger on D1.
    repository: new FakeOpsAlertsRepository(),
    jobs,
    email: new MemoryEmailSender(),
    recipient: 'ops@example.com',
    environment: 'test',
    now: () => today,
  })
  const repository = new D1AiUsageRepository(db)
  const service = new AiUsageService({ repository, opsAlerts, capMicros, now: () => today })
  return { service, jobs, repository, dayStart }
}

const request = (estimateMicros: number) => ({ job: 'research' as const, model: 'claude-sonnet-5-5', estimateMicros })

/** The real ledger (service + D1 + the migrations' tables) alerts at the cap and never refuses. */
describe('AiUsageService on D1', () => {
  it('reserves past the cap instead of refusing, and records the spend', async () => {
    const { service, repository, dayStart } = ledger(1000)
    await service.reserve(request(600))

    const id = await service.reserve(request(401))

    expect(id).toEqual(expect.any(String))
    expect(await repository.committedMicrosSince(dayStart)).toBe(1001)
  })

  it('queues one ai-spend-cap alert for the day, however many calls pass the cap, and none while under it', async () => {
    const { service, jobs } = ledger(1000)
    await service.reserve(request(1000))
    expect(jobs.enqueued).toEqual([])

    await Promise.all(Array.from({ length: 4 }, () => service.reserve(request(1))))

    expect(jobs.enqueued).toHaveLength(1)
    expect(jobs.enqueued[0]!.body).toMatchObject({ kind: 'ai-spend-cap' })
  })
})
