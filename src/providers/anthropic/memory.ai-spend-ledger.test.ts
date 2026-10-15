import { describe, expect, it } from 'vitest'
import { aiSpendLedgerContract } from './ai-spend-ledger.contract'
import type { AiUsage } from './ai-spend.provider'
import { MemoryAiSpendLedger } from './memory.ai-spend-ledger'

aiSpendLedgerContract('MemoryAiSpendLedger', (capMicros) => new MemoryAiSpendLedger({ capMicros }))

const USAGE: AiUsage = { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 200, cacheReadTokens: 3000, webSearches: 2 }

describe('MemoryAiSpendLedger', () => {
  it('exposes its cap', () => {
    expect(new MemoryAiSpendLedger({ capMicros: 2_000_000 }).capMicros).toBe(2_000_000)
  })

  it('records a reservation as an entry with its job, model and estimate', async () => {
    const ledger = new MemoryAiSpendLedger({ capMicros: 1_000_000 })

    const id = await ledger.reserve({ job: 'analysis', model: 'claude-haiku-5-5', estimateMicros: 1234 })

    expect(ledger.entries).toEqual([
      { id, status: 'reserved', job: 'analysis', model: 'claude-haiku-5-5', estimateMicros: 1234, costMicros: null, usage: null },
    ])
  })

  it('records the usage and cost on a settled entry, and the status on a released one', async () => {
    const ledger = new MemoryAiSpendLedger({ capMicros: 1_000_000 })
    const settled = await ledger.reserve({ job: 'research', model: 'claude-sonnet-5-5', estimateMicros: 50_000 })
    const released = await ledger.reserve({ job: 'same-product', model: 'claude-sonnet-5-5', estimateMicros: 7 })

    await ledger.settle(settled, { usage: USAGE, costMicros: 27_800 })
    await ledger.release(released)

    expect(ledger.entries.map((e) => [e.status, e.job, e.costMicros, e.usage])).toEqual([
      ['settled', 'research', 27_800, USAGE],
      ['released', 'same-product', null, null],
    ])
  })

  it('counts only settled costs as spent, and spent plus open reservations as committed', async () => {
    const ledger = new MemoryAiSpendLedger({ capMicros: 1_000_000 })
    const a = await ledger.reserve({ job: 'research', model: 'claude-sonnet-5-5', estimateMicros: 300 })
    const b = await ledger.reserve({ job: 'research', model: 'claude-sonnet-5-5', estimateMicros: 200 })
    await ledger.reserve({ job: 'research', model: 'claude-sonnet-5-5', estimateMicros: 90 })
    await ledger.settle(a, { usage: USAGE, costMicros: 120 })
    await ledger.release(b)

    expect(ledger.spentMicros()).toBe(120)
    expect(ledger.committedMicros()).toBe(210)
  })
})
