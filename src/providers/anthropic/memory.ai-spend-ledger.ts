import { type AiJob, AiBudgetExceededError, type AiSpendLedger, type AiUsage } from './ai-spend.provider'

export type LedgerEntry = {
  id: string
  status: 'reserved' | 'settled' | 'released'
  job: AiJob
  model: string
  estimateMicros: number
  /** Null until settled. */
  costMicros: number | null
  /** Null until settled. */
  usage: AiUsage | null
}

/**
 * An AiSpendLedger in memory, for tests and for the eval script (which gives itself a `--max-usd` cap with it).
 * The cap applies to the whole life of the ledger (no day boundary). Behaviour is pinned by aiSpendLedgerContract.
 */
export class MemoryAiSpendLedger implements AiSpendLedger {
  readonly capMicros: number
  /** Every reservation, in order, with its current status. Mutated in place as it settles or is released. */
  readonly entries: LedgerEntry[] = []

  constructor(options: { capMicros: number }) {
    this.capMicros = options.capMicros
  }

  /** What has actually been spent: the cost of every settled call. Open reservations are not spent yet (see committedMicros). */
  spentMicros(): number {
    return this.entries.reduce((sum, e) => sum + (e.status === 'settled' ? (e.costMicros ?? 0) : 0), 0)
  }

  /** What the cap is measured against: settled costs plus the estimates of reservations still open. Released ones are excluded. */
  committedMicros(): number {
    return this.entries.reduce((sum, e) => sum + (e.status === 'settled' ? (e.costMicros ?? 0) : e.status === 'reserved' ? e.estimateMicros : 0), 0)
  }

  async reserve(input: { job: AiJob; model: string; estimateMicros: number }): Promise<string> {
    if (this.committedMicros() + input.estimateMicros > this.capMicros) {
      throw new AiBudgetExceededError('The AI spend cap would be exceeded')
    }
    const id = `mem-${this.entries.length + 1}`
    this.entries.push({ id, status: 'reserved', ...input, costMicros: null, usage: null })
    return id
  }

  async settle(reservationId: string, input: { usage: AiUsage; costMicros: number }): Promise<void> {
    const entry = this.#openEntry(reservationId)
    if (!entry) return
    entry.status = 'settled'
    entry.costMicros = input.costMicros
    entry.usage = input.usage
  }

  async release(reservationId: string): Promise<void> {
    const entry = this.#openEntry(reservationId)
    if (entry) entry.status = 'released'
  }

  /** Only a reservation that is still open can be settled or released; anything else is left as it is. */
  #openEntry(id: string): LedgerEntry | undefined {
    const entry = this.entries.find((e) => e.id === id)
    return entry?.status === 'reserved' ? entry : undefined
  }
}
