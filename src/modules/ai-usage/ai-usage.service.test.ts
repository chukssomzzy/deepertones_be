import { describe, expect, it } from 'vitest'
import { aiSpendLedgerContract } from '../../providers/anthropic/ai-spend-ledger.contract'
import { AiBudgetExceededError, type AiJob, type AiUsage } from '../../providers/anthropic/ai-spend.provider'
import { FakeAiUsageRepository } from './ai-usage.repository.fake'
import { AiUsageService } from './ai-usage.service'

// The repository contract (fake and D1) is mounted by ai-usage.repository.test.ts and its integration twin.

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
  const service = new AiUsageService({
    repository,
    capMicros: options.capMicros ?? CAP,
    now: () => clock,
    ...(options.newId ? { newId: options.newId } : {}),
  })
  return { service, repository, at: (time: Date) => (clock = time) }
}

const refused = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

// The same behaviour as MemoryAiSpendLedger, which the eval script uses: if the two ever differ, one of them is wrong.
aiSpendLedgerContract('AiUsageService on FakeAiUsageRepository', (capMicros) => new AiUsageService({ repository: new FakeAiUsageRepository(), capMicros, now: () => T0 }))

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

  it('refuses with AiBudgetExceededError, and records nothing, when the reservation would pass the cap', async () => {
    const { service, repository } = setup({ capMicros: 1000 })
    await service.reserve(request(600))

    const error = await refused(service.reserve(request(401)))

    expect(error).toBeInstanceOf(AiBudgetExceededError)
    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(600)
  })

  it('does not wrap a failure of the repository: a database that cannot be reached is not a spent budget', async () => {
    const down = new Error('d1 is down')
    class Down extends FakeAiUsageRepository {
      override async insertReservation(): Promise<boolean> {
        throw down
      }
    }
    const { service } = setup({ repository: new Down() })

    expect(await refused(service.reserve(request(1)))).toBe(down)
  })

  it('lets exactly as many of a burst of simultaneous reservations through as the cap has room for', async () => {
    const { service, repository } = setup({ capMicros: 100 })

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.reserve(request(40))))

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    for (const result of results.filter((r) => r.status === 'rejected')) expect(result.reason).toBeInstanceOf(AiBudgetExceededError)
    expect(await repository.committedMicrosSince(MIDNIGHT)).toBe(80)
  })
})

describe('AiUsageService the day (UTC)', () => {
  const lastMillisecond = new Date(MIDNIGHT.getTime() + DAY - 1)
  const nextMidnight = new Date(MIDNIGHT.getTime() + DAY)

  it('still counts the day\'s spend at its last millisecond', async () => {
    const { service, at } = setup({ capMicros: 1000 })
    await service.reserve(request(1000))

    at(lastMillisecond)

    expect(await refused(service.reserve(request(1)))).toBeInstanceOf(AiBudgetExceededError)
  })

  it('starts the cap again at midnight UTC: the full cap is available at 00:00:00.000', async () => {
    const { service, at } = setup({ capMicros: 1000 })
    await service.reserve(request(1000))

    at(nextMidnight)

    await expect(service.reserve(request(1000))).resolves.toEqual(expect.any(String))
    expect(await refused(service.reserve(request(1)))).toBeInstanceOf(AiBudgetExceededError)
  })

  it('counts a reservation made exactly at midnight toward the day that begins there, for that whole day', async () => {
    const { service, at } = setup({ capMicros: 1000 })
    at(nextMidnight)
    await service.reserve(request(1000))

    at(new Date(nextMidnight.getTime() + DAY - 1))
    expect(await refused(service.reserve(request(1)))).toBeInstanceOf(AiBudgetExceededError)

    at(new Date(nextMidnight.getTime() + DAY))
    await expect(service.reserve(request(1000))).resolves.toEqual(expect.any(String))
  })

  it('does not count a reservation made a millisecond before midnight in the new day', async () => {
    const { service, at } = setup({ capMicros: 1000 })
    at(lastMillisecond)
    await service.reserve(request(1000))

    at(nextMidnight)

    await expect(service.reserve(request(1000))).resolves.toEqual(expect.any(String))
  })

  it('counts a call settled after midnight in the day it was reserved', async () => {
    const { service, at } = setup({ capMicros: 1000 })
    at(lastMillisecond)
    const id = await service.reserve(request(1000))
    at(nextMidnight)
    await service.settle(id, { usage: USAGE, costMicros: 900 })

    // Yesterday's call, settled today, does not take today's room.
    await expect(service.reserve(request(1000))).resolves.toEqual(expect.any(String))
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
