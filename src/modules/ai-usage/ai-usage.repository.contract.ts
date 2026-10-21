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

/** More than any test spends: a reservation that is nowhere near the cap. */
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
type VendorCall = Parameters<AiUsageRepository['insertSettled']>[0]

/**
 * Behaviour every AiUsageRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier).
 *
 * insertReservation takes the cap and the window ITSELF, but the cap is only a measure: the row is ALWAYS stored (an environment-wide
 * limit never refuses a call), and the answer says whether the spend committed since `since` plus this estimate passed `capMicros`,
 * so the caller can raise an alert. On D1 the sum and the insert are ONE statement, so the answer is not made stale by a race.
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
      expect(await repo.insertReservation(input)).toEqual({ overCap: false })
      return input.id
    }

    describe('insertReservation', () => {
      it('says the cap is not passed when the reservation exactly fills what the cap has left, and stores it', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        const result = await repo.insertReservation(reservation(since, { estimateMicros: 100, capMicros: before + 100 }))

        expect(result).toEqual({ overCap: false })
        expect(await repo.committedMicrosSince(since)).toBe(before + 100)
      })

      it('says the cap is passed when the reservation is one micro over it, and still stores it', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        const result = await repo.insertReservation(reservation(since, { estimateMicros: 100, capMicros: before + 99 }))

        expect(result).toEqual({ overCap: true })
        expect(await repo.committedMicrosSince(since)).toBe(before + 100)
      })

      it('keeps storing reservations, and keeps saying the cap is passed, once it is well past', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        const first = await repo.insertReservation(reservation(since, { estimateMicros: 500, capMicros: before + 100 }))
        const second = await repo.insertReservation(reservation(since, { estimateMicros: 500, capMicros: before + 100 }))

        expect([first, second]).toEqual([{ overCap: true }, { overCap: true }])
        expect(await repo.committedMicrosSince(since)).toBe(before + 1000)
      })

      it('counts an open reservation at its estimate, to the micro', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        await reserve(repo, since, { estimateMicros: 60 })

        expect(await repo.insertReservation(reservation(since, { estimateMicros: 41, capMicros: before + 100 }))).toEqual({ overCap: true })
      })

      it('says the cap is not passed for a reservation that fits beside an open one, to the micro', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        await reserve(repo, since, { estimateMicros: 60 })

        expect(await repo.insertReservation(reservation(since, { estimateMicros: 40, capMicros: before + 100 }))).toEqual({ overCap: false })
      })

      it('counts a settled reservation at what it cost, not at its estimate', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        const id = await reserve(repo, since, { estimateMicros: 100 })

        await repo.settle(id, { usage: usage(), costMicros: 30, settledAt: since })

        expect(await repo.committedMicrosSince(since)).toBe(before + 30)
        expect(await repo.insertReservation(reservation(since, { estimateMicros: 70, capMicros: before + 100 }))).toEqual({ overCap: false })
        // 30 + 70 are now committed, so one more micro passes the cap.
        expect(await repo.insertReservation(reservation(since, { estimateMicros: 1, capMicros: before + 100 }))).toEqual({ overCap: true })
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
        expect(await repo.insertReservation(reservation(since, { estimateMicros: 100, capMicros: before + 100 }))).toEqual({ overCap: false })
      })

      it('does not count spend from before `since`, and counts spend made exactly at it', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        await reserve(repo, since, { estimateMicros: 1000, createdAt: new Date(since.getTime() - 1) })
        await reserve(repo, since, { estimateMicros: 50, createdAt: since })

        expect(await repo.insertReservation(reservation(since, { estimateMicros: 50, capMicros: before + 100 }))).toEqual({ overCap: false })
        // 100 are now committed since `since`; the 1000 from a millisecond earlier is not among them.
        expect(await repo.insertReservation(reservation(since, { estimateMicros: 1, capMicros: before + 100 }))).toEqual({ overCap: true })
      })

      it('stores every one of a burst of simultaneous reservations, and flags at least those that pass the cap', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        // Room for two reservations of 40 under a cap of 100; eight race for it. Nobody is refused; six pass the cap.
        const results = await Promise.all(
          Array.from({ length: 8 }, () => repo.insertReservation(reservation(since, { estimateMicros: 40, capMicros: before + 100 }))),
        )

        expect(await repo.committedMicrosSince(since)).toBe(before + 320)
        expect(results.filter((r) => r.overCap).length).toBeGreaterThanOrEqual(6)
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
    // A vendor that bills per unit (Perfect Corp) is recorded ONCE, when the call has succeeded and been charged: no reservation held open,
    // because nothing sweeps one. The row is settled from the start, on the same table and under the same daily sum as the Claude rows.
    // Claude's own reserve, settle and release are described above and are unchanged.
    describe('insertSettled and vendorSummary', () => {
      const vendorCall = (since: Date, over: Partial<VendorCall> = {}): VendorCall => ({
        id: freshId(),
        vendor: 'perfect-corp',
        job: 'face-analysis',
        units: 12,
        costMicros: 840_000,
        createdAt: since,
        capMicros: NO_CAP,
        since,
        ...over,
      })

      /** What the vendor summary says about one job, so a shared database's leftovers cannot matter: tests compare with what they read first. */
      const totalFor = async (repo: AiUsageRepository, since: Date, job: string) => {
        const rows = (await repo.vendorSummary(since)).filter((r) => r.vendor === 'perfect-corp' && r.job === job)
        return { calls: rows.reduce((n, r) => n + r.calls, 0), units: rows.reduce((n, r) => n + r.units, 0), costMicros: rows.reduce((n, r) => n + r.costMicros, 0) }
      }

      it('stores a settled row with its vendor, job, units and cost, read back through the vendor summary', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await totalFor(repo, since, 'face-analysis')

        await repo.insertSettled(vendorCall(since, { units: 12, costMicros: 840_000 }))

        const after = await totalFor(repo, since, 'face-analysis')
        expect(after).toEqual({ calls: before.calls + 1, units: before.units + 12, costMicros: before.costMicros + 840_000 })
        expect(await repo.vendorSummary(since)).toContainEqual(expect.objectContaining({ vendor: 'perfect-corp', job: 'face-analysis' }))
      })

      it('adds up the calls, units and cost of a job, and keeps the Fitzpatrick job apart from the analysis job', async () => {
        const repo = await make()
        const since = windowStart()
        const [analysis, fitzpatrick] = [await totalFor(repo, since, 'face-analysis'), await totalFor(repo, since, 'fitzpatrick')]

        await repo.insertSettled(vendorCall(since, { job: 'face-analysis', units: 12, costMicros: 600 }))
        await repo.insertSettled(vendorCall(since, { job: 'face-analysis', units: 12, costMicros: 600 }))
        await repo.insertSettled(vendorCall(since, { job: 'fitzpatrick', units: 10, costMicros: 500 }))

        expect(await totalFor(repo, since, 'face-analysis')).toEqual({ calls: analysis.calls + 2, units: analysis.units + 24, costMicros: analysis.costMicros + 1200 })
        expect(await totalFor(repo, since, 'fitzpatrick')).toEqual({ calls: fitzpatrick.calls + 1, units: fitzpatrick.units + 10, costMicros: fitzpatrick.costMicros + 500 })
      })

      it('counts a vendor call toward the day\'s committed spend at what it cost, from the moment it is stored', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        await repo.insertSettled(vendorCall(since, { costMicros: 840_000 }))

        expect(await repo.committedMicrosSince(since)).toBe(before + 840_000)
      })

      it('adds vendor spend to Claude spend under the same sum', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        await reserve(repo, since, { estimateMicros: 60 })

        await repo.insertSettled(vendorCall(since, { costMicros: 41 }))

        expect(await repo.committedMicrosSince(since)).toBe(before + 101)
      })

      it('says the cap is not passed when the call exactly fills what the cap has left, and stores it', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        const result = await repo.insertSettled(vendorCall(since, { costMicros: 100, capMicros: before + 100 }))

        expect(result).toEqual({ overCap: false })
        expect(await repo.committedMicrosSince(since)).toBe(before + 100)
      })

      it('says the cap is passed when the call is one micro over it, and still stores it', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        const result = await repo.insertSettled(vendorCall(since, { costMicros: 100, capMicros: before + 99 }))

        expect(result).toEqual({ overCap: true })
        expect(await repo.committedMicrosSince(since)).toBe(before + 100)
      })

      it('measures the cap against Claude\'s open reservations and settled calls too, to the micro', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        await reserve(repo, since, { estimateMicros: 60 })

        expect(await repo.insertSettled(vendorCall(since, { costMicros: 40, capMicros: before + 100 }))).toEqual({ overCap: false })
        expect(await repo.insertSettled(vendorCall(since, { costMicros: 1, capMicros: before + 100 }))).toEqual({ overCap: true })
      })

      it('lets a Claude reservation see vendor spend when it measures the cap', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        await repo.insertSettled(vendorCall(since, { costMicros: 70 }))

        expect(await repo.insertReservation(reservation(since, { estimateMicros: 30, capMicros: before + 100 }))).toEqual({ overCap: false })
        expect(await repo.insertReservation(reservation(since, { estimateMicros: 1, capMicros: before + 100 }))).toEqual({ overCap: true })
      })

      it('does not count spend from before `since`, and counts spend made exactly at it', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)

        await repo.insertSettled(vendorCall(since, { costMicros: 1000, createdAt: new Date(since.getTime() - 1) }))
        expect(await repo.committedMicrosSince(since)).toBe(before)

        await repo.insertSettled(vendorCall(since, { costMicros: 7, createdAt: since }))
        expect(await repo.committedMicrosSince(since)).toBe(before + 7)
      })

      it('leaves a vendor call out of the vendor summary of a window that starts after it', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await totalFor(repo, since, 'face-analysis')
        await repo.insertSettled(vendorCall(since, { createdAt: new Date(since.getTime() - 1) }))

        expect(await totalFor(repo, since, 'face-analysis')).toEqual(before)

        await repo.insertSettled(vendorCall(since, { createdAt: since, units: 12, costMicros: 5 }))

        expect(await totalFor(repo, since, 'face-analysis')).toEqual({ calls: before.calls + 1, units: before.units + 12, costMicros: before.costMicros + 5 })
      })

      // A queue job is redelivered and a webhook can arrive twice; the service derives the row id from the vendor's task id, so a repeat
      // arrives here with an id that is already stored. It is a no-op, not an error and not a second charge.
      it('ignores a call whose id is already stored: no error, no second row, nothing added to the day', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await totalFor(repo, since, 'face-analysis')
        const beforeCommitted = await repo.committedMicrosSince(since)
        const first = vendorCall(since, { units: 12, costMicros: 600 })
        await repo.insertSettled(first)

        await expect(repo.insertSettled({ ...first })).resolves.toBeDefined()

        expect(await totalFor(repo, since, 'face-analysis')).toEqual({ calls: before.calls + 1, units: before.units + 12, costMicros: before.costMicros + 600 })
        expect(await repo.committedMicrosSince(since)).toBe(beforeCommitted + 600)
      })

      it('keeps the first call\'s units and cost when the same id comes again with other figures', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await totalFor(repo, since, 'face-analysis')
        const first = vendorCall(since, { units: 12, costMicros: 600 })
        await repo.insertSettled(first)

        await repo.insertSettled({ ...first, units: 5, costMicros: 9_999, job: 'fitzpatrick' })

        expect(await totalFor(repo, since, 'face-analysis')).toEqual({ calls: before.calls + 1, units: before.units + 12, costMicros: before.costMicros + 600 })
        expect((await totalFor(repo, since, 'fitzpatrick')).costMicros).not.toBeGreaterThanOrEqual(9_999)
      })

      it('says the cap is not passed for a repeat, even when the day is already past it: nothing was recorded, so there is nothing to alert about', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        const first = vendorCall(since, { costMicros: 100, capMicros: before + 50 })
        expect(await repo.insertSettled(first)).toEqual({ overCap: true })

        expect(await repo.insertSettled({ ...first })).toEqual({ overCap: false })
      })

      it('stores a call with a new id beside one with an id it already holds', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await totalFor(repo, since, 'face-analysis')
        const first = vendorCall(since, { costMicros: 600 })
        await repo.insertSettled(first)
        await repo.insertSettled({ ...first })

        await repo.insertSettled(vendorCall(since, { costMicros: 600 }))

        expect((await totalFor(repo, since, 'face-analysis')).calls).toBe(before.calls + 2)
      })

      it('keeps Claude\'s calls out of the vendor summary, and vendor calls out of Claude\'s summary', async () => {
        const repo = await make()
        const since = windowStart()
        const model = fresh('model')
        const claude = await reserve(repo, since, { model })
        await repo.settle(claude, { usage: usage(), costMicros: 30, settledAt: since })
        const analysisBefore = await totalFor(repo, since, 'face-analysis')
        const claudeBefore = (await repo.summary(since)).length

        await repo.insertSettled(vendorCall(since))

        const claudeRows = await repo.summary(since)
        expect(claudeRows).toContainEqual(expect.objectContaining({ job: 'research', model, calls: 1, costMicros: 30 }))
        expect(claudeRows).toHaveLength(claudeBefore)
        expect(claudeRows.some((r) => (r.job as string) === 'face-analysis' || (r.job as string) === 'fitzpatrick')).toBe(false)
        expect((await repo.vendorSummary(since)).some((r) => r.job === 'research')).toBe(false)
        expect((await totalFor(repo, since, 'face-analysis')).calls).toBe(analysisBefore.calls + 1)
      })

      it('leaves Claude\'s reserve, settle and release working beside vendor rows', async () => {
        const repo = await make()
        const since = windowStart()
        const before = await repo.committedMicrosSince(since)
        await repo.insertSettled(vendorCall(since, { costMicros: 25 }))
        const settled = await reserve(repo, since, { estimateMicros: 100 })
        const released = await reserve(repo, since, { estimateMicros: 200 })

        await repo.settle(settled, { usage: usage(), costMicros: 30, settledAt: since })
        await repo.release(released)

        expect(await repo.committedMicrosSince(since)).toBe(before + 25 + 30)
      })
    })
  })
}
