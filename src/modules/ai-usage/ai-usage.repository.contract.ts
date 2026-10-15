import { describe, expect, it } from 'vitest'
import type { AiUsage } from '../../providers/anthropic/ai-spend.provider'
import type { AiUsageRepository } from './ai-usage.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

// Each call yields a value no other test (or earlier run against a shared D1) uses.
const runSalt = Number(String(Math.floor(Math.random() * 1e5)).padStart(5, '0'))
let counter = 0
const fresh = (label: string) => `${label}-${runSalt}-${counter++}`
const freshId = () => crypto.randomUUID()

/**
 * A `since` no other test's rows reach: each test gets its own hour, far from BASE and from every other test. Rows a
 * test writes sit within 30 minutes after it. (committedMicrosSince has no upper bound, so a LATER window never sees
 * an earlier one's rows.) Tests still compare with what they read first, so leftovers from an earlier run cannot fail one.
 */
const windowStart = () => at(1000 * HOUR + runSalt * HOUR + counter++ * HOUR)

/** More than any test spends: a reservation that must not be refused by the cap. */
const NO_CAP = Number.MAX_SAFE_INTEGER

const usage = (over: Partial<AiUsage> = {}): AiUsage => ({
  inputTokens: 1000,
  outputTokens: 500,
  cacheWriteTokens: 200,
  cacheReadTokens: 3000,
  webSearches: 2,
  ...over,
})

type Reservation = Parameters<AiUsageRepository['insertReservation']>[0]

/**
 * Behaviour every AiUsageRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier).
 *
 * insertReservation takes the cap and the window ITSELF and decides in one place: the repository inserts the row only if
 * the spend already committed since `since` plus the new estimate fits under `capMicros`. On D1 that is ONE conditional
 * INSERT ... SELECT statement, so two requests racing for the last of the budget cannot both get it. (Check-then-act in
 * the service, a read followed by a write, would let both through.) The concurrency test below is what pins that.
 */
export const aiUsageRepositoryContract = (name: string, make: () => AiUsageRepository | Promise<AiUsageRepository>) => {
  describe(`AiUsageRepository contract: ${name}`, () => {
    const reservation = (since: Date, over: Partial<Reservation> = {}): Reservation => ({
      id: freshId(),
      job: 'research',
      model: 'claude-sonnet-5-5',
      estimateMicros: 100,
      createdAt: since,
      capMicros: NO_CAP,
      since,
      ...over,
    })

    /** Reserves with no cap in the way and returns the id. */
    const reserve = async (repo: AiUsageRepository, since: Date, over: Partial<Reservation> = {}) => {
      const input = reservation(since, over)
      expect(await repo.insertReservation(input)).toBe(true)
      return input.id
    }

    describe('insertReservation', () => {
      it('inserts a reservation that exactly fills what the cap has left, and says so', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        const inserted = await repo.insertReservation(reservation(since, { estimateMicros: 100, capMicros: before + 100 }))

        expect(inserted).toBe(true)
        expect(await repo.committedMicrosSince(since)).toBe(before + 100)
      })

      it('refuses a reservation one micro over the cap, and stores nothing', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        const inserted = await repo.insertReservation(reservation(since, { estimateMicros: 100, capMicros: before + 99 }))

        expect(inserted).toBe(false)
        expect(await repo.committedMicrosSince(since)).toBe(before)
      })

      it('does not use up the id of a reservation it refused', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        const id = freshId()
        await repo.insertReservation(reservation(since, { id, estimateMicros: 100, capMicros: before + 99 }))

        const inserted = await repo.insertReservation(reservation(since, { id, estimateMicros: 100, capMicros: before + 100 }))

        expect(inserted).toBe(true)
      })

      it('counts an open reservation at its estimate, to the micro', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        await reserve(repo, since, { estimateMicros: 60 })

        expect(await repo.insertReservation(reservation(since, { estimateMicros: 41, capMicros: before + 100 }))).toBe(false)
        expect(await repo.insertReservation(reservation(since, { estimateMicros: 40, capMicros: before + 100 }))).toBe(true)
        expect(await repo.insertReservation(reservation(since, { estimateMicros: 1, capMicros: before + 100 }))).toBe(false)
      })

      it('counts a settled reservation at what it cost, not at its estimate', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        const id = await reserve(repo, since, { estimateMicros: 100 })

        await repo.settle(id, { usage: usage(), costMicros: 30, settledAt: since })

        expect(await repo.committedMicrosSince(since)).toBe(before + 30)
        expect(await repo.insertReservation(reservation(since, { estimateMicros: 70, capMicros: before + 100 }))).toBe(true)
        expect(await repo.insertReservation(reservation(since, { estimateMicros: 1, capMicros: before + 100 }))).toBe(false)
      })

      it('counts a call that cost more than its estimate at what it cost', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        const id = await reserve(repo, since, { estimateMicros: 100 })

        await repo.settle(id, { usage: usage(), costMicros: 250, settledAt: since })

        expect(await repo.committedMicrosSince(since)).toBe(before + 250)
      })

      it('gives back the room of a released reservation', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        const id = await reserve(repo, since, { estimateMicros: 100 })

        await repo.release(id)

        expect(await repo.committedMicrosSince(since)).toBe(before)
        expect(await repo.insertReservation(reservation(since, { estimateMicros: 100, capMicros: before + 100 }))).toBe(true)
      })

      it('does not count spend from before `since`, and counts spend made exactly at it', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        await reserve(repo, since, { estimateMicros: 1000, createdAt: new Date(since.getTime() - 1) })
        await reserve(repo, since, { estimateMicros: 50, createdAt: since })

        expect(await repo.insertReservation(reservation(since, { estimateMicros: 51, capMicros: before + 100 }))).toBe(false)
        expect(await repo.insertReservation(reservation(since, { estimateMicros: 50, capMicros: before + 100 }))).toBe(true)
      })

      it('lets exactly as many of a burst of simultaneous reservations in as the cap has room for', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        // Room for two reservations of 40 under a cap of 100; eight race for it.
        const results = await Promise.all(
          Array.from({ length: 8 }, () => repo.insertReservation(reservation(since, { estimateMicros: 40, capMicros: before + 100 }))),
        )

        expect(results.filter(Boolean)).toHaveLength(2)
        expect(await repo.committedMicrosSince(since)).toBe(before + 80)
      })
    })

    describe('settle and release', () => {
      it('keeps the first settlement when a reservation is settled twice', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        const id = await reserve(repo, since)

        await repo.settle(id, { usage: usage(), costMicros: 30, settledAt: since })
        await repo.settle(id, { usage: usage(), costMicros: 99, settledAt: since })

        expect(await repo.committedMicrosSince(since)).toBe(before + 30)
      })

      it('leaves a settled reservation counted when it is released afterwards', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        const id = await reserve(repo, since)
        await repo.settle(id, { usage: usage(), costMicros: 30, settledAt: since })

        await repo.release(id)

        expect(await repo.committedMicrosSince(since)).toBe(before + 30)
      })

      it('leaves a released reservation unbilled when it is settled afterwards', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        const id = await reserve(repo, since)
        await repo.release(id)

        await repo.settle(id, { usage: usage(), costMicros: 30, settledAt: since })

        expect(await repo.committedMicrosSince(since)).toBe(before)
      })

      it('does nothing, and does not fail, for a reservation it never made', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        await expect(repo.settle(freshId(), { usage: usage(), costMicros: 30, settledAt: since })).resolves.toBeUndefined()
        await expect(repo.release(freshId())).resolves.toBeUndefined()

        expect(await repo.committedMicrosSince(since)).toBe(before)
      })
    })

    describe('committedMicrosSince', () => {
      it('counts a reservation made exactly at the cutoff and later, not one a millisecond before', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        await reserve(repo, since, { estimateMicros: 7, createdAt: new Date(since.getTime() - 1) })
        expect(await repo.committedMicrosSince(since)).toBe(before)

        await reserve(repo, since, { estimateMicros: 7, createdAt: since })
        expect(await repo.committedMicrosSince(since)).toBe(before + 7)

        await reserve(repo, since, { estimateMicros: 7, createdAt: new Date(since.getTime() + 1) })
        expect(await repo.committedMicrosSince(since)).toBe(before + 14)
      })

      it('counts a settled call by when it was reserved, not when it was settled', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        const id = await reserve(repo, since, { estimateMicros: 100, createdAt: new Date(since.getTime() - 1) })

        await repo.settle(id, { usage: usage(), costMicros: 30, settledAt: new Date(since.getTime() + MINUTE) })

        expect(await repo.committedMicrosSince(since)).toBe(before)
      })
    })

    describe('summary', () => {
      // Rows are told apart by a model name no other test uses, so what else is in a shared database does not matter.
      const settled = async (repo: AiUsageRepository, since: Date, over: Partial<Reservation> & { cost: number; usage?: AiUsage }) => {
        const { cost, usage: used = usage(), ...rest } = over
        const id = await reserve(repo, since, rest)
        await repo.settle(id, { usage: used, costMicros: cost, settledAt: since })
        return id
      }
      const ofModel = async (repo: AiUsageRepository, since: Date, ...models: string[]) =>
        (await repo.summary(since)).filter((row) => models.includes(row.model)).sort((a, b) => `${a.job}/${a.model}`.localeCompare(`${b.job}/${b.model}`))

      it('adds up the settled calls of each job and model: calls, every token count, searches and cost', async () => {
        const repo = await make()
        const since = windowStart()
        const [a, b] = [fresh('model-a'), fresh('model-b')]
        await settled(repo, since, { job: 'research', model: a, cost: 1000, usage: usage({ inputTokens: 100, outputTokens: 10, cacheWriteTokens: 1, cacheReadTokens: 5, webSearches: 1 }) })
        await settled(repo, since, { job: 'research', model: a, cost: 2000, usage: usage({ inputTokens: 200, outputTokens: 20, cacheWriteTokens: 2, cacheReadTokens: 6, webSearches: 3 }) })
        await settled(repo, since, { job: 'analysis', model: a, cost: 400, usage: usage({ inputTokens: 40, outputTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 }) })
        await settled(repo, since, { job: 'research', model: b, cost: 50, usage: usage({ inputTokens: 5, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 }) })

        const rows = await ofModel(repo, since, a, b)

        expect(rows).toEqual([
          { job: 'analysis', model: a, calls: 1, inputTokens: 40, outputTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0, costMicros: 400 },
          { job: 'research', model: a, calls: 2, inputTokens: 300, outputTokens: 30, cacheWriteTokens: 3, cacheReadTokens: 11, webSearches: 4, costMicros: 3000 },
          { job: 'research', model: b, calls: 1, inputTokens: 5, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0, costMicros: 50 },
        ])
      })

      it('leaves out reservations that are still open and ones that were released', async () => {
        const repo = await make()
        const since = windowStart()
        const model = fresh('model')
        await settled(repo, since, { model, cost: 10 })
        await reserve(repo, since, { model, estimateMicros: 5000 })
        const released = await reserve(repo, since, { model, estimateMicros: 6000 })
        await repo.release(released)

        const rows = await ofModel(repo, since, model)

        expect(rows).toEqual([expect.objectContaining({ model, calls: 1, costMicros: 10 })])
      })

      it('leaves out a call reserved a millisecond before `since` and includes one reserved exactly at it', async () => {
        const repo = await make()
        const since = windowStart()
        const model = fresh('model')
        await settled(repo, since, { model, cost: 1, createdAt: new Date(since.getTime() - 1) })
        expect(await ofModel(repo, since, model)).toEqual([])

        await settled(repo, since, { model, cost: 2, createdAt: since })

        expect(await ofModel(repo, since, model)).toEqual([expect.objectContaining({ calls: 1, costMicros: 2 })])
      })

      it('has no row for a model nothing was settled on', async () => {
        expect(await ofModel(await make(), windowStart(), fresh('never-used'))).toEqual([])
      })
    })
  })
}
