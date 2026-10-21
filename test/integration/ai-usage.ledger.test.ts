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
  const service = new AiUsageService({ repository, opsAlerts, capMicros, perfectCorpUsdPerUnit: 0.07, now: () => today })
  return { service, jobs, repository, dayStart }
}

/** More than any test spends. */
const NO_CAP = Number.MAX_SAFE_INTEGER

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

/** Perfect Corp calls land in the same table, under the same daily sum and the same alert, as Claude's. */
describe('AiUsageService.record on D1', () => {
  // The key is the Perfect Corp task id. A fresh one each time, because D1 is shared and a task is recorded once.
  const analysis = (units = 12, key = `task-${crypto.randomUUID()}`) => ({ vendor: 'perfect-corp' as const, job: 'face-analysis' as const, units, key })

  it('stores a settled Perfect Corp row with its vendor, job, units and cost, and counts it toward the day', async () => {
    const { service, repository, dayStart } = ledger(NO_CAP)
    const before = await repository.committedMicrosSince(dayStart)

    await service.record(analysis(12))

    // 12 units at $0.07: 840000 micro-USD, not 840000.0000000001 and not 840001.
    expect(await repository.vendorSummary(dayStart)).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', calls: 1, units: 12, costMicros: 840_000 }])
    expect(await repository.committedMicrosSince(dayStart)).toBe(before + 840_000)
  })

  it('queues one ai-spend-cap alert when Perfect Corp spend passes the cap beside Claude\'s, and none up to the cap', async () => {
    const { service, jobs } = ledger(1_000_000)
    await service.reserve(request(160_000))
    await service.record(analysis(12))
    expect(jobs.enqueued).toEqual([])

    await service.record(analysis(1))
    await service.record(analysis(1))

    expect(jobs.enqueued).toHaveLength(1)
    expect(jobs.enqueued[0]!.body).toMatchObject({ kind: 'ai-spend-cap' })
  })

  it('records a task once on D1 however often it is recorded, and counts it once toward the day and the alert', async () => {
    const { service, repository, jobs, dayStart } = ledger(840_000)
    const before = await repository.committedMicrosSince(dayStart)
    const task = analysis(12, `task-${crypto.randomUUID()}`)

    await service.record(task)
    await service.record(task)
    await Promise.all([service.record(task), service.record(task)])

    expect(await repository.vendorSummary(dayStart)).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', calls: 1, units: 12, costMicros: 840_000 }])
    expect(await repository.committedMicrosSince(dayStart)).toBe(before + 840_000)
    expect(jobs.enqueued).toEqual([])
  })

  it('refuses units that are not a positive whole number on D1 and stores nothing', async () => {
    const { service, repository, dayStart } = ledger(NO_CAP)

    for (const units of [0, -3, 1.5]) await expect(service.record(analysis(units))).rejects.toThrow()

    expect(await repository.vendorSummary(dayStart)).toEqual([])
  })

  it('keeps Claude\'s reserve, settle and release working beside a Perfect Corp row, and keeps the two summaries apart', async () => {
    const { service, repository, dayStart } = ledger(NO_CAP)
    const settled = await service.reserve(request(500))
    const released = await service.reserve(request(700))
    await service.settle(settled, { usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 }, costMicros: 300 })
    await service.release(released)
    await service.record(analysis(12))

    expect(await repository.committedMicrosSince(dayStart)).toBe(300 + 840_000)
    expect(await repository.summary(dayStart)).toEqual([expect.objectContaining({ job: 'research', model: 'claude-sonnet-5-5', calls: 1, costMicros: 300 })])
    expect(await repository.vendorSummary(dayStart)).toEqual([expect.objectContaining({ vendor: 'perfect-corp', calls: 1 })])
  })
})
