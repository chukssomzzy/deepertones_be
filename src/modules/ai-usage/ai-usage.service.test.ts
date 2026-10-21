import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_JOBS, type AiJob, type AiUsage } from '../../providers/anthropic/ai-spend.provider'
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

/** What one Perfect Corp unit costs in these tests. Chosen so that units x price is not exact in floating point (12 x 0.07 is 0.8400000000000001). */
const USD_PER_UNIT = 0.07

const setup = (options: { capMicros?: number; repository?: FakeAiUsageRepository; newId?: () => string; perfectCorpUsdPerUnit?: number | string } = {}) => {
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
    perfectCorpUsdPerUnit: options.perfectCorpUsdPerUnit ?? USD_PER_UNIT,
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

// Perfect Corp (face scans) is paid per unit, and only when a result succeeds. So its spend is recorded ONCE, already settled, when the
// result is in: nothing is reserved across the wait for a webhook, since no sweeper would ever release a reservation held open. It lands
// in the same table and the same daily sum as the Claude calls.
describe('AiUsageService.record (a vendor call that succeeded)', () => {
  // Each call gets a task id of its own unless a test names one: the key is the Perfect Corp task id, and two tasks are two charges.
  let tasks = 0
  const analysis = (units = 12, key = `task-analysis-${tasks++}`) => ({ vendor: 'perfect-corp' as const, job: 'face-analysis' as const, units, key })
  const fitzpatrick = (units = 10, key = `task-fitzpatrick-${tasks++}`) => ({ vendor: 'perfect-corp' as const, job: 'fitzpatrick' as const, units, key })

  it('writes one settled row with the vendor, job, units and cost of units x price in micro-USD', async () => {
    const { service, repository } = setup()

    await service.record(analysis(12))

    // 12 units at $0.07 is $0.84.
    expect(await repository.vendorSummary(MIDNIGHT)).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', calls: 1, units: 12, costMicros: 840_000 }])
  })

  it('records the Fitzpatrick job under its own name', async () => {
    const { service, repository } = setup()

    await service.record(fitzpatrick(10))

    // 10 units at $0.07 is $0.70.
    expect(await repository.vendorSummary(MIDNIGHT)).toEqual([{ vendor: 'perfect-corp', job: 'fitzpatrick', calls: 1, units: 10, costMicros: 700_000 }])
  })

  it('takes the price from its configuration, so a changed unit price changes the cost', async () => {
    const dear = setup({ perfectCorpUsdPerUnit: 0.1 })
    const cheap = setup({ perfectCorpUsdPerUnit: 0.01 })

    await dear.service.record(analysis(12))
    await cheap.service.record(analysis(12))

    expect(await dear.repository.committedMicrosSince(MIDNIGHT)).toBe(1_200_000)
    expect(await cheap.repository.committedMicrosSince(MIDNIGHT)).toBe(120_000)
  })

  it('costs an exact whole number of micro-USD when the arithmetic is inexact in floating point', async () => {
    // 12 x 0.07 x 1e6 is 840000.0000000001 and 7 x 0.29 x 1e6 is 2029999.9999999998: neither a rounding up nor a cutting off may show.
    const above = setup({ perfectCorpUsdPerUnit: 0.07 })
    const below = setup({ perfectCorpUsdPerUnit: 0.29 })

    await above.service.record(analysis(12))
    await below.service.record(analysis(7))

    expect(await above.repository.committedMicrosSince(MIDNIGHT)).toBe(840_000)
    expect(await below.repository.committedMicrosSince(MIDNIGHT)).toBe(2_030_000)
  })

  it('stores a whole number of micros even when the price has a fraction of one', async () => {
    // 3 units at $0.0000004 is 1.2 micros: a whole micro, one or two of them, never a fraction.
    const { service, repository } = setup({ perfectCorpUsdPerUnit: 0.0000004 })

    await service.record(analysis(3))

    const cost = await repository.committedMicrosSince(MIDNIGHT)
    expect(Number.isInteger(cost)).toBe(true)
    expect(cost).toBeGreaterThanOrEqual(1)
    expect(cost).toBeLessThanOrEqual(2)
  })

  it('counts toward the day\'s committed spend, beside Claude\'s, exactly as a Claude call does', async () => {
    const { service, repository } = setup()
    const id = await service.reserve(request(100_000))
    await service.settle(id, { usage: USAGE, costMicros: 60_000 })

    await service.record(analysis(12))

    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(60_000 + 840_000)
  })

  it('raises no alert while the day\'s spend, Claude and Perfect Corp together, stays within the cap, up to and including exactly the cap', async () => {
    const { service, alerts } = setup({ capMicros: 1_000_000 })
    await service.reserve(request(160_000))

    await service.record(analysis(12))

    // 160_000 + 840_000 is exactly the cap.
    expect(alerts()).toEqual([])
  })

  it('raises the ai-spend-cap alert, once for the day, when a Perfect Corp call takes the day past a cap it had exactly filled', async () => {
    const { service, alerts } = setup({ capMicros: 1_000_000, perfectCorpUsdPerUnit: 0.0001 })
    await service.reserve(request(999_900))

    // One unit costs 100 micros: 999_900 + 100 is exactly the cap.
    await service.record(analysis(1))
    expect(alerts()).toEqual([])
    await service.record(analysis(1))
    await service.record(analysis(1))

    // The second call passes the cap by 100 and alerts; the third passes it again and does not alert again.
    expect(alerts()).toEqual([{ kind: 'ai-spend-cap', windowStart: MIDNIGHT.getTime() }])
  })

  it('raises the alert when Perfect Corp spend alone passes the cap', async () => {
    const { service, alerts } = setup({ capMicros: 500_000 })

    await service.record(analysis(12))

    expect(alerts()).toEqual([{ kind: 'ai-spend-cap', windowStart: MIDNIGHT.getTime() }])
  })

  it('still records the call, and does not refuse it, however far past the cap the day is', async () => {
    const { service, repository } = setup({ capMicros: 100 })

    await service.record(analysis(12))
    await service.record(analysis(12))
    await service.record(fitzpatrick(10))

    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(840_000 + 840_000 + 700_000)
  })

  it('puts a call in the UTC day it was made: the last millisecond counts for that day, midnight starts the next', async () => {
    const lastMillisecond = new Date(MIDNIGHT.getTime() + DAY - 1)
    const nextMidnight = new Date(MIDNIGHT.getTime() + DAY)
    const { service, repository, at, alerts } = setup({ capMicros: 840_000 })
    at(lastMillisecond)
    await service.record(analysis(12))
    expect(alerts()).toEqual([])

    at(nextMidnight)
    await service.record(analysis(12))

    expect(alerts()).toEqual([])
    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(2 * 840_000)
    expect(await repository.committedMicrosSince(nextMidnight)).toBe(840_000)
  })

  it('does not wrap a failure of the repository: a database that cannot be reached is not a spent budget', async () => {
    const down = new Error('d1 is down')
    class Down extends FakeAiUsageRepository {
      override async insertSettled(): Promise<{ overCap: boolean }> {
        throw down
      }
    }
    const { service } = setup({ repository: new Down() })

    await expect(service.record(analysis())).rejects.toBe(down)
  })

  it('leaves Claude\'s summary alone: a Perfect Corp call is not a Claude call', async () => {
    const { service, repository } = setup()
    const id = await service.reserve(request(50_000, 'analysis'))
    await service.settle(id, { usage: USAGE, costMicros: 27_800 })

    await service.record(analysis(12))

    expect(await repository.summary(MIDNIGHT)).toEqual([
      { job: 'analysis', model: 'claude-sonnet-5-5', calls: 1, inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 200, cacheReadTokens: 3000, webSearches: 2, costMicros: 27_800 },
    ])
  })
})

// A queue job is redelivered, and a webhook can arrive twice: the task id is the key, so one task is charged once however often it is recorded.
describe('AiUsageService.record is idempotent per vendor task', () => {
  const analysis = (key: string, units = 12) => ({ vendor: 'perfect-corp' as const, job: 'face-analysis' as const, units, key })

  it('stores one row when the same task is recorded twice, and the second call changes nothing', async () => {
    const { service, repository } = setup()

    await service.record(analysis('task-1'))
    await service.record(analysis('task-1'))

    expect(await repository.vendorSummary(MIDNIGHT)).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', calls: 1, units: 12, costMicros: 840_000 }])
    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(840_000)
  })

  it('keeps the first record when the same task is recorded again with other units', async () => {
    const { service, repository } = setup()

    await service.record(analysis('task-1', 12))
    await service.record(analysis('task-1', 5))

    expect(await repository.vendorSummary(MIDNIGHT)).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', calls: 1, units: 12, costMicros: 840_000 }])
  })

  it('stores one row each for two different tasks', async () => {
    const { service, repository } = setup()

    await service.record(analysis('task-1'))
    await service.record(analysis('task-2'))

    expect(await repository.vendorSummary(MIDNIGHT)).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', calls: 2, units: 24, costMicros: 1_680_000 }])
  })

  it('stores one row when the same task is recorded by two calls at once', async () => {
    const { service, repository } = setup()

    await Promise.all([service.record(analysis('task-1')), service.record(analysis('task-1')), service.record(analysis('task-1'))])

    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(840_000)
  })

  it('does not count a task again toward the cap, so a redelivery cannot push the day past it', async () => {
    const { service, alerts } = setup({ capMicros: 840_000 })

    await service.record(analysis('task-1'))
    await service.record(analysis('task-1'))

    expect(alerts()).toEqual([])
  })

  it('raises the cap alert once for a task that passed the cap, however often it is recorded', async () => {
    const raise = vi.spyOn(OpsAlertsService.prototype, 'raise')
    const { service } = setup({ capMicros: 100 })

    await service.record(analysis('task-1'))
    await service.record(analysis('task-1'))
    await service.record(analysis('task-1'))

    expect(raise).toHaveBeenCalledTimes(1)
    expect(raise).toHaveBeenCalledWith('ai-spend-cap')
  })

  it('does not disturb the Claude calls beside it, which are still one row per reservation', async () => {
    const { service, repository } = setup()
    const first = await service.reserve(request(100))
    const second = await service.reserve(request(100))
    await service.settle(first, { usage: USAGE, costMicros: 30 })
    await service.release(second)

    await service.record(analysis('task-1'))
    await service.record(analysis('task-1'))

    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(30 + 840_000)
  })
})

describe('AiUsageService.record refuses units that are not a positive whole number', () => {
  const withUnits = (units: number) => ({ vendor: 'perfect-corp' as const, job: 'face-analysis' as const, units, key: 'task-1' })

  it.each([0, -1, -12, 1.5, 0.5, 12.0000001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('throws for %s units and stores nothing', async (units) => {
    const { service, repository, alerts } = setup({ capMicros: 1 })

    await expect(service.record(withUnits(units))).rejects.toThrow()

    expect(await repository.vendorSummary(MIDNIGHT)).toEqual([])
    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(0)
    expect(alerts()).toEqual([])
  })

  it('does not use up the task: a bad record leaves the same task free to be recorded properly after', async () => {
    const { service, repository } = setup()
    await expect(service.record(withUnits(0))).rejects.toThrow()

    await service.record(withUnits(12))

    expect(await repository.vendorSummary(MIDNIGHT)).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', calls: 1, units: 12, costMicros: 840_000 }])
  })

  it('accepts one unit, the smallest whole number', async () => {
    const { service, repository } = setup()

    await service.record(withUnits(1))

    expect(await repository.vendorSummary(MIDNIGHT)).toEqual([expect.objectContaining({ calls: 1, units: 1 })])
  })
})

// The price is read when a call is recorded, not when the service is built: a missing or unreadable price must not take the Claude calls
// down with it, since the same ledger serves them. Only recording a Perfect Corp call fails.
describe('AiUsageService with a price that is not a positive number', () => {
  const task = { vendor: 'perfect-corp' as const, job: 'face-analysis' as const, units: 12, key: 'task-1' }
  const BAD_PRICES: (number | string)[] = ['not-a-number', '', '   ', '0', '-0.07', '0x', 'NaN', 'Infinity', Number.NaN, 0, -0.07, Number.POSITIVE_INFINITY]

  it.each(BAD_PRICES)('builds, and still reserves, settles and releases Claude calls, with a price of %j', async (price) => {
    const { service, repository } = setup({ perfectCorpUsdPerUnit: price })

    const settled = await service.reserve(request(100))
    const released = await service.reserve(request(200))
    await service.settle(settled, { usage: USAGE, costMicros: 60 })
    await service.release(released)

    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(60)
    expect(await repository.summary(MIDNIGHT)).toEqual([expect.objectContaining({ calls: 1, costMicros: 60 })])
  })

  it.each(BAD_PRICES)('throws when asked to record a Perfect Corp call, with a price of %j, and stores nothing', async (price) => {
    const { service, repository, alerts } = setup({ perfectCorpUsdPerUnit: price, capMicros: 1 })

    await expect(service.record(task)).rejects.toThrow()

    expect(await repository.vendorSummary(MIDNIGHT)).toEqual([])
    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(0)
    expect(alerts()).toEqual([])
  })

  it('names the setting in the error, so the owner knows what to fix, and never records the call at nothing', async () => {
    const { service } = setup({ perfectCorpUsdPerUnit: 'not-a-number' })

    await expect(service.record(task)).rejects.toThrow(/PERFECT_CORP_USD_PER_UNIT/)
  })

  it('reads a price given as the text of a number, as the environment holds it', async () => {
    const { service, repository } = setup({ perfectCorpUsdPerUnit: '0.07' })

    await service.record(task)

    expect(await repository.vendorSummary(MIDNIGHT)).toEqual([expect.objectContaining({ units: 12, costMicros: 840_000 })])
  })

  it('reads a price given as a number', async () => {
    const { service, repository } = setup({ perfectCorpUsdPerUnit: 0.07 })

    await service.record(task)

    expect(await repository.vendorSummary(MIDNIGHT)).toEqual([expect.objectContaining({ units: 12, costMicros: 840_000 })])
  })
})

describe('AI_JOBS', () => {
  it('does not list the Perfect Corp jobs: they are not Claude calls, so no model, price or prompt is wired for them', () => {
    expect(AI_JOBS).not.toContain('face-analysis')
    expect(AI_JOBS).not.toContain('fitzpatrick')
  })
})
