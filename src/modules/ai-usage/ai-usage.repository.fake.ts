import type { AiJob, AiUsage } from '../../providers/anthropic/ai-spend.provider'
import type { AiUsageRepository } from './ai-usage.repository'

type Row = {
  id: string
  vendor: string
  job: string
  model: string
  status: 'reserved' | 'settled' | 'released'
  estimateMicros: number
  costMicros: number | null
  usage: AiUsage | null
  units: number | null
  createdAt: Date
  settledAt: Date | null
}

type SummaryRow = {
  job: AiJob
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  webSearches: number
  costMicros: number
}

type VendorSummaryRow = { vendor: string; job: string; calls: number; units: number; costMicros: number }

/**
 * In-memory AiUsageRepository for unit tests. Behaviour is pinned by aiUsageRepositoryContract.
 * insertReservation inserts and sums without awaiting in between, as the one batch on D1 does.
 */
export class FakeAiUsageRepository implements AiUsageRepository {
  private rows: Row[] = []

  async insertReservation(input: {
    id: string
    job: AiJob
    model: string
    estimateMicros: number
    createdAt: Date
    capMicros: number
    since: Date
  }): Promise<{ overCap: boolean }> {
    if (this.rows.some((r) => r.id === input.id)) throw new Error(`duplicate reservation id ${input.id}`)
    this.rows.push({
      id: input.id,
      vendor: 'anthropic',
      job: input.job,
      model: input.model,
      status: 'reserved',
      estimateMicros: input.estimateMicros,
      costMicros: null,
      usage: null,
      units: null,
      createdAt: input.createdAt,
      settledAt: null,
    })
    return { overCap: this.committed(input.since) > input.capMicros }
  }

  async insertSettled(input: {
    id: string
    vendor: string
    job: string
    units: number
    costMicros: number
    createdAt: Date
    capMicros: number
    since: Date
  }): Promise<{ overCap: boolean }> {
    // A repeat of the same vendor task: nothing is stored and nothing is over the cap, as on D1.
    if (this.rows.some((r) => r.id === input.id)) return { overCap: false }
    this.rows.push({
      id: input.id,
      vendor: input.vendor,
      job: input.job,
      model: input.vendor,
      status: 'settled',
      estimateMicros: input.costMicros,
      costMicros: input.costMicros,
      usage: null,
      units: input.units,
      createdAt: input.createdAt,
      settledAt: input.createdAt,
    })
    return { overCap: this.committed(input.since) > input.capMicros }
  }

  async settle(id: string, input: { usage: AiUsage; costMicros: number; settledAt: Date }): Promise<void> {
    const row = this.rows.find((r) => r.id === id)
    if (row?.status !== 'reserved') return
    row.status = 'settled'
    row.costMicros = input.costMicros
    row.usage = input.usage
    row.settledAt = input.settledAt
  }

  async release(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id)
    if (row?.status === 'reserved') row.status = 'released'
  }

  async committedMicrosSince(since: Date): Promise<number> {
    return this.committed(since)
  }

  async summary(since: Date): Promise<SummaryRow[]> {
    const groups = new Map<string, SummaryRow>()
    for (const row of this.rows) {
      if (row.status !== 'settled' || row.vendor !== 'anthropic' || row.createdAt.getTime() < since.getTime()) continue
      const key = `${row.job}\u0000${row.model}`
      const group =
        groups.get(key) ??
        { job: row.job as AiJob, model: row.model, calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0, costMicros: 0 }
      group.calls += 1
      group.inputTokens += row.usage!.inputTokens
      group.outputTokens += row.usage!.outputTokens
      group.cacheWriteTokens += row.usage!.cacheWriteTokens
      group.cacheReadTokens += row.usage!.cacheReadTokens
      group.webSearches += row.usage!.webSearches
      group.costMicros += row.costMicros!
      groups.set(key, group)
    }
    return [...groups.values()]
  }

  async vendorSummary(since: Date): Promise<VendorSummaryRow[]> {
    const groups = new Map<string, VendorSummaryRow>()
    for (const row of this.rows) {
      if (row.status !== 'settled' || row.vendor === 'anthropic' || row.createdAt.getTime() < since.getTime()) continue
      const key = `${row.vendor}\u0000${row.job}`
      const group = groups.get(key) ?? { vendor: row.vendor, job: row.job, calls: 0, units: 0, costMicros: 0 }
      group.calls += 1
      group.units += row.units!
      group.costMicros += row.costMicros!
      groups.set(key, group)
    }
    return [...groups.values()]
  }

  /** Settled calls at what they cost plus open reservations at their estimate; released ones are not counted. */
  private committed(since: Date): number {
    return this.rows
      .filter((r) => r.createdAt.getTime() >= since.getTime())
      .reduce((sum, r) => sum + (r.status === 'settled' ? r.costMicros! : r.status === 'reserved' ? r.estimateMicros : 0), 0)
  }
}
