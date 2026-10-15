import { AiBudgetExceededError, type AiJob, type AiSpendLedger, type AiUsage } from '../../providers/anthropic/ai-spend.provider'
import type { AiUsageRepository } from './ai-usage.repository'

export type AiUsageServiceDeps = {
  repository: AiUsageRepository
  /** The most that may be committed in one UTC day, in micro-USD (millionths of a dollar). */
  capMicros: number
  now?: () => Date
  newId?: () => string
}

/**
 * The real AiSpendLedger: caps what the AI calls may cost in a UTC day. A reservation counts its estimate until it is
 * settled (then its real cost) or released. The day a call belongs to is the day it was reserved.
 */
export class AiUsageService implements AiSpendLedger {
  private readonly repository: AiUsageRepository
  private readonly capMicros: number
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: AiUsageServiceDeps) {
    this.repository = deps.repository
    this.capMicros = deps.capMicros
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  async reserve(input: { job: AiJob; model: string; estimateMicros: number }): Promise<string> {
    const createdAt = this.now()
    const id = this.newId()
    // The repository decides against the cap in the same statement that stores the row. Its own errors pass through:
    // a database that cannot be reached is not a spent budget.
    const reserved = await this.repository.insertReservation({
      id,
      ...input,
      createdAt,
      capMicros: this.capMicros,
      since: startOfUtcDay(createdAt),
    })
    if (!reserved) throw new AiBudgetExceededError('The daily AI spend cap would be exceeded')
    return id
  }

  async settle(reservationId: string, input: { usage: AiUsage; costMicros: number }): Promise<void> {
    await this.repository.settle(reservationId, { ...input, settledAt: this.now() })
  }

  async release(reservationId: string): Promise<void> {
    await this.repository.release(reservationId)
  }
}

const startOfUtcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
