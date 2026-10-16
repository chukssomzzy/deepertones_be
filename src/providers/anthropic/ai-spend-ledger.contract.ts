import { describe, expect, it } from 'vitest'
import { AiBudgetExceededError, type AiSpendLedger, type AiUsage } from './ai-spend.provider'

const USAGE: AiUsage = { inputTokens: 10, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 }
const CAP = 1_000_000

const reservation = (estimateMicros: number) => ({ job: 'research' as const, model: 'claude-sonnet-5-5', estimateMicros })

const refused = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

/**
 * What every AiSpendLedger must do about the cap. `make(capMicros)` returns a ledger with nothing spent and that cap.
 * Runs against MemoryAiSpendLedger (which the eval script uses) and AiUsageService (the real ledger on a fake repository),
 * so the in-memory one cannot drift from the real one.
 */
export const aiSpendLedgerContract = (name: string, make: (capMicros: number) => AiSpendLedger) => {
  describe(`AiSpendLedger contract: ${name}`, () => {
    it('allows a reservation of exactly the cap', async () => {
      const ledger = make(CAP)

      await expect(ledger.reserve(reservation(CAP))).resolves.toEqual(expect.any(String))
    })

    it('refuses a reservation one micro over the cap with AiBudgetExceededError', async () => {
      const ledger = make(CAP)

      const error = await refused(ledger.reserve(reservation(CAP + 1)))

      expect(error).toBeInstanceOf(AiBudgetExceededError)
      expect((error as Error).name).toBe('AiBudgetExceededError')
    })

    it('gives each reservation its own id', async () => {
      const ledger = make(CAP)

      const [a, b] = [await ledger.reserve(reservation(1)), await ledger.reserve(reservation(1))]

      expect(a).not.toBe(b)
    })

    it('counts an open reservation against the cap, to the micro', async () => {
      const ledger = make(CAP)
      await ledger.reserve(reservation(600_000))

      await expect(ledger.reserve(reservation(400_000))).resolves.toEqual(expect.any(String))
      expect(await refused(ledger.reserve(reservation(1)))).toBeInstanceOf(AiBudgetExceededError)
    })

    it('counts a refused reservation as nothing', async () => {
      const ledger = make(CAP)
      await ledger.reserve(reservation(600_000))
      await refused(ledger.reserve(reservation(500_000)))

      await expect(ledger.reserve(reservation(400_000))).resolves.toEqual(expect.any(String))
    })

    it('frees the room of a released reservation', async () => {
      const ledger = make(CAP)
      const first = await ledger.reserve(reservation(600_000))
      expect(await refused(ledger.reserve(reservation(500_000)))).toBeInstanceOf(AiBudgetExceededError)

      await ledger.release(first)

      await expect(ledger.reserve(reservation(CAP))).resolves.toEqual(expect.any(String))
    })

    it('counts a settled call at its actual cost, not its estimate', async () => {
      const ledger = make(CAP)
      const first = await ledger.reserve(reservation(600_000))
      await ledger.settle(first, { usage: USAGE, costMicros: 100_000 })

      await expect(ledger.reserve(reservation(900_000))).resolves.toEqual(expect.any(String))
      expect(await refused(ledger.reserve(reservation(1)))).toBeInstanceOf(AiBudgetExceededError)
    })

    it('counts a call that cost more than its estimate at what it cost', async () => {
      const ledger = make(CAP)
      const first = await ledger.reserve(reservation(100_000))
      await ledger.settle(first, { usage: USAGE, costMicros: 400_000 })

      await expect(ledger.reserve(reservation(600_000))).resolves.toEqual(expect.any(String))
      expect(await refused(ledger.reserve(reservation(1)))).toBeInstanceOf(AiBudgetExceededError)
    })

    it('keeps the first settlement when a call is settled twice', async () => {
      const ledger = make(CAP)
      const first = await ledger.reserve(reservation(100_000))
      await ledger.settle(first, { usage: USAGE, costMicros: 100_000 })
      await ledger.settle(first, { usage: USAGE, costMicros: 1 })

      expect(await refused(ledger.reserve(reservation(900_001)))).toBeInstanceOf(AiBudgetExceededError)
    })

    it('does not un-spend a settled call when it is released afterwards', async () => {
      const ledger = make(CAP)
      const first = await ledger.reserve(reservation(500_000))
      await ledger.settle(first, { usage: USAGE, costMicros: 500_000 })
      await ledger.release(first)

      expect(await refused(ledger.reserve(reservation(500_001)))).toBeInstanceOf(AiBudgetExceededError)
    })

    it('does not bill a released reservation when it is settled afterwards', async () => {
      const ledger = make(CAP)
      const first = await ledger.reserve(reservation(500_000))
      await ledger.release(first)
      await ledger.settle(first, { usage: USAGE, costMicros: 500_000 })

      await expect(ledger.reserve(reservation(CAP))).resolves.toEqual(expect.any(String))
    })
  })
}
