import type { AiJob, AiSpendLedger, AiUsage } from '../../providers/anthropic/ai-spend.provider'
import type { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import type { AiUsageRepository } from './ai-usage.repository'

export type AiUsageServiceDeps = {
  repository: AiUsageRepository
  /** Told when a call takes the day past the cap. Never throws. */
  opsAlerts: OpsAlertsService
  /** The day's spend, in micro-USD (millionths of a dollar), from which the owner is emailed. It refuses nothing. */
  capMicros: number
  now?: () => Date
  newId?: () => string
}

/**
 * The real AiSpendLedger: records what the AI calls cost, and emails the owner (once a UTC day) when a day's spend passes the cap.
 * It never refuses a call: the cap is a signal, not a limit. A reservation counts its estimate until it is settled (then its real
 * cost) or released. The day a call belongs to is the day it was reserved. Only MemoryAiSpendLedger (the eval's) refuses on a cap.
 */
export class AiUsageService implements AiSpendLedger {
  private readonly repository: AiUsageRepository
  private readonly opsAlerts: OpsAlertsService
  private readonly capMicros: number
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: AiUsageServiceDeps) {
    this.repository = deps.repository
    this.opsAlerts = deps.opsAlerts
    this.capMicros = deps.capMicros
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  async reserve(input: { job: AiJob; model: string; estimateMicros: number }): Promise<string> {
    const createdAt = this.now()
    const id = this.newId()
    // The row is always stored. Its own errors pass through: a database that cannot be reached is not a spent budget.
    const { overCap } = await this.repository.insertReservation({
      id,
      ...input,
      createdAt,
      capMicros: this.capMicros,
      since: AiUsageService.startOfUtcDay(createdAt),
    })
    if (overCap) await this.opsAlerts.raise('ai-spend-cap')
    return id
  }

  async settle(reservationId: string, input: { usage: AiUsage; costMicros: number }): Promise<void> {
    await this.repository.settle(reservationId, { ...input, settledAt: this.now() })
  }

  async release(reservationId: string): Promise<void> {
    await this.repository.release(reservationId)
  }

  private static startOfUtcDay(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
  }
}
