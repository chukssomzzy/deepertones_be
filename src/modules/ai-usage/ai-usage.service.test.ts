import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiJob, AiUsage } from '../../providers/anthropic/ai-spend.provider'
import { MemoryEmailSender } from '../../providers/email/memory.email'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { FakeOpsAlertsRepository } from '../ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import { FakeAiUsageRepository } from './ai-usage.repository.fake'
import { AiUsageService } from './ai-usage.service'

// The repository contract (fake and D1) is mounted by ai-usage.repository.test.ts and its integration twin.
// The hard cap of MemoryAiSpendLedger (which the eval script uses) is pinned by ai-spend-ledger.contract.ts, mounted by its own test:
// this service does not refuse, so it is no longer held to that contract.

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Midnight UTC at the start of the day every test runs in. Written out, so the day's edges do not come from the code under test. */
const MIDNIGHT = new Date('2030-06-15T00:00:00.000Z')
const T0 = new Date(MIDNIGHT.getTime() + 12 * HOUR)
const CAP = 1_000_000

const USAGE: AiUsage = { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 200, cacheReadTokens: 3000, webSearches: 2 }

const request = (estimateMicros: number, job: AiJob = 'research') => ({ job, model: 'claude-sonnet-5-5', estimateMicros })

const setup = (options: { capMicros?: number; repository?: FakeAiUsageRepository; newId?: () => string } = {}) => {
  let clock = T0
  const repository = options.repository ?? new FakeAiUsageRepository()
  // The real alerting service, so what is asserted is what the owner would be emailed about: one job per window.
  const alertJobs = new MemoryJobQueue()
  const opsAlerts = new OpsAlertsService({
    repository: new FakeOpsAlertsRepository(),
    jobs: alertJobs,
    email: new MemoryEmailSender(),
    recipient: 'ops@example.com',
    environment: 'test',
    now: () => clock,
  })
  const service = new AiUsageService({
    repository,
    opsAlerts,
    capMicros: options.capMicros ?? CAP,
    now: () => clock,
    ...(options.newId ? { newId: options.newId } : {}),
  })
  /** The kind and window of every alert queued so far. */
  const alerts = () => alertJobs.enqueued.map((e) => e.body as { kind: string; windowStart: number })
  return { service, repository, alertJobs, alerts, at: (time: Date) => (clock = time) }
}

afterEach(() => vi.restoreAllMocks())

describe('AiUsageService.reserve', () => {
  it('returns the id it made for the reservation', async () => {
    const { service } = setup({ newId: () => 'reservation-1' })

    expect(await service.reserve(request(100))).toBe('reservation-1')
  })

  it('records the reservation as committed spend for the day', async () => {
    const { service, repository } = setup()

    await service.reserve(request(250))

    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(250)
  })

  it('raises no alert while the day\'s spend stays within the cap, up to and including exactly the cap', async () => {
    const { service, alerts } = setup({ capMicros: 1000 })

    await service.reserve(request(600))
    await service.reserve(request(400))

    expect(alerts()).toEqual([])
  })

  it('records the reservation, returns its id and raises the ai-spend-cap alert, when it would pass the cap by one micro', async () => {
    const ids = ['first', 'over-1']
    const { service, repository, alerts } = setup({ capMicros: 1000, newId: () => ids.shift()! })
    await service.reserve(request(600))
    const spendBefore = await repository.committedMicrosSince(MIDNIGHT)

    const id = await service.reserve(request(401))

    expect(id).toBe('over-1')
    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(spendBefore + 401)
    expect(alerts()).toEqual([{ kind: 'ai-spend-cap', windowStart: MIDNIGHT.getTime() }])
  })

  it('never refuses, however far past the cap the day is: every call is reserved and the settled spend is still tracked', async () => {
    const { service, repository } = setup({ capMicros: 100 })

    const ids = [await service.reserve(request(500)), await service.reserve(request(500)), await service.reserve(request(500, 'analysis'))]
    await service.settle(ids[2]!, { usage: USAGE, costMicros: 300 })

    expect(new Set(ids).size).toBe(3)
    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(500 + 500 + 300)
    expect(await repository.summary(MIDNIGHT)).toEqual([
      expect.objectContaining({ job: 'analysis', model: 'claude-sonnet-5-5', calls: 1, costMicros: 300 }),
    ])
  })

  it('raises the alert once for the day, however many calls pass the cap after the first', async () => {
    const { service, alertJobs } = setup({ capMicros: 100 })

    await Promise.all(Array.from({ length: 5 }, () => service.reserve(request(500))))
    await service.reserve(request(500))

    expect(alertJobs.enqueued).toHaveLength(1)
  })

  it('still returns the id when the alert cannot be raised', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { service, alertJobs } = setup({ capMicros: 100, newId: () => 'over-2' })
    alertJobs.failNextWith(new Error('queue is down'))

    await expect(service.reserve(request(500))).resolves.toBe('over-2')
  })

  it('does not wrap a failure of the repository: a database that cannot be reached is not a spent budget', async () => {
    const down = new Error('d1 is down')
    class Down extends FakeAiUsageRepository {
      override async insertReservation(): Promise<{ overCap: boolean }> {
        throw down
      }
    }
    const { service } = setup({ repository: new Down() })

    await expect(service.reserve(request(1))).rejects.toBe(down)
  })
})

describe('AiUsageService the day (UTC)', () => {
  const lastMillisecond = new Date(MIDNIGHT.getTime() + DAY - 1)
  const nextMidnight = new Date(MIDNIGHT.getTime() + DAY)

  it('still counts the day\'s spend at its last millisecond', async () => {
    const { service, at, alerts } = setup({ capMicros: 1000 })
    await service.reserve(request(1000))

    at(lastMillisecond)
    await service.reserve(request(1))

    expect(alerts()).toEqual([{ kind: 'ai-spend-cap', windowStart: MIDNIGHT.getTime() }])
  })

  it('starts the count again at midnight UTC: the full cap is available at 00:00:00.000, and passing it then alerts for the new day', async () => {
    const { service, at, alerts } = setup({ capMicros: 1000 })
    await service.reserve(request(1000))
    await service.reserve(request(1))
    expect(alerts()).toHaveLength(1)

    at(nextMidnight)
    await service.reserve(request(1000))
    expect(alerts()).toHaveLength(1)
    await service.reserve(request(1))

    expect(alerts()).toEqual([
      { kind: 'ai-spend-cap', windowStart: MIDNIGHT.getTime() },
      { kind: 'ai-spend-cap', windowStart: nextMidnight.getTime() },
    ])
  })

  it('counts a reservation made exactly at midnight toward the day that begins there, for that whole day', async () => {
    const { service, at, alerts } = setup({ capMicros: 1000 })
    at(nextMidnight)
    await service.reserve(request(1000))

    at(new Date(nextMidnight.getTime() + DAY - 1))
    await service.reserve(request(1))

    expect(alerts()).toEqual([{ kind: 'ai-spend-cap', windowStart: nextMidnight.getTime() }])
  })

  it('does not count a reservation made a millisecond before midnight in the new day', async () => {
    const { service, at, alerts } = setup({ capMicros: 1000 })
    at(lastMillisecond)
    await service.reserve(request(1000))

    at(nextMidnight)
    await service.reserve(request(1000))

    expect(alerts()).toEqual([])
  })

  it('counts a call settled after midnight in the day it was reserved', async () => {
    const { service, at, alerts } = setup({ capMicros: 1000 })
    at(lastMillisecond)
    const id = await service.reserve(request(1000))
    at(nextMidnight)
    await service.settle(id, { usage: USAGE, costMicros: 900 })

    // Yesterday's call, settled today, does not take today's room.
    await service.reserve(request(1000))

    expect(alerts()).toEqual([])
  })
})

describe('AiUsageService.settle and release', () => {
  it('records the usage and cost of a settled call for the day\'s summary', async () => {
    const { service, repository } = setup()
    const id = await service.reserve(request(50_000, 'analysis'))

    await service.settle(id, { usage: USAGE, costMicros: 27_800 })

    expect(await repository.summary(MIDNIGHT)).toEqual([
      { job: 'analysis', model: 'claude-sonnet-5-5', calls: 1, inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 200, cacheReadTokens: 3000, webSearches: 2, costMicros: 27_800 },
    ])
  })

  it('stops counting a released reservation', async () => {
    const { service, repository } = setup()
    const id = await service.reserve(request(50_000))

    await service.release(id)

    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(0)
    expect(await repository.summary(MIDNIGHT)).toEqual([])
  })
})
