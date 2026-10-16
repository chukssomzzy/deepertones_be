import type { AiJob, AiUsage } from '../../providers/anthropic/ai-spend.provider'
import type { AiUsageRepository } from './ai-usage.repository'

type Row = {
  id: string
  job: AiJob
  model: string
  status: 'reserved' | 'settled' | 'released'
  estimateMicros: number
  costMicros: number | null
  usage: AiUsage | null
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

/**
 * In-memory AiUsageRepository for unit tests. Behaviour is pinned by aiUsageRepositoryContract.
 * insertReservation checks and inserts without awaiting in between, as the one conditional statement on D1 does,
 * so simultaneous callers cannot overshoot the cap here either.
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
  }): Promise<boolean> {
    if (this.committed(input.since) + input.estimateMicros > input.capMicros) return false
    if (this.rows.some((r) => r.id === input.id)) throw new Error(`duplicate reservation id ${input.id}`)
    this.rows.push({
      id: input.id,
      job: input.job,
      model: input.model,
      status: 'reserved',
      estimateMicros: input.estimateMicros,
      costMicros: null,
      usage: null,
      createdAt: input.createdAt,
      settledAt: null,
    })
    return true
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
      if (row.status !== 'settled' || row.createdAt.getTime() < since.getTime()) continue
      const key = `${row.job}\u0000${row.model}`
      const group =
        groups.get(key) ??
        { job: row.job, model: row.model, calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0, costMicros: 0 }
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

  /** Settled calls at what they cost plus open reservations at their estimate; released ones are not counted. */
  private committed(since: Date): number {
    return this.rows
      .filter((r) => r.createdAt.getTime() >= since.getTime())
      .reduce((sum, r) => sum + (r.status === 'settled' ? r.costMicros! : r.status === 'reserved' ? r.estimateMicros : 0), 0)
  }
}
