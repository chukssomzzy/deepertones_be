import type { AiJob, AiSpendLedger, AiUsage } from '../../providers/anthropic/ai-spend.provider'
import type { VendorSpendLedger } from '../../providers/perfect-corp/vendor-spend.provider'
import type { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import type { AiUsageRepository } from './ai-usage.repository'

export type AiUsageServiceDeps = {
  repository: AiUsageRepository
  /** Told when a call takes the day past the cap. Never throws. */
  opsAlerts: OpsAlertsService
  /** The day's spend, in micro-USD (millionths of a dollar), from which the owner is emailed. It refuses nothing. */
  capMicros: number
  /**
   * What one Perfect Corp unit costs, in US dollars: a number, or the text of one as the environment holds it. It is read when a Perfect Corp
   * call is recorded, not here, so a missing or unreadable price fails only that call and never the Claude calls this ledger also serves.
   */
  perfectCorpUsdPerUnit: number | string
  now?: () => Date
  newId?: () => string
}

/**
 * The real AiSpendLedger: records what the AI calls cost, and emails the owner (once a UTC day) when a day's spend passes the cap.
 * It never refuses a call: the cap is a signal, not a limit. A reservation counts its estimate until it is settled (then its real
 * cost) or released. The day a call belongs to is the day it was reserved. Only MemoryAiSpendLedger (the eval's) refuses on a cap.
 *
 * It is also the VendorSpendLedger: a Perfect Corp call is recorded once, already settled, when its result succeeded, on the same table and
 * under the same daily sum and alert as the Claude calls.
 */
export class AiUsageService implements AiSpendLedger, VendorSpendLedger {
  private readonly repository: AiUsageRepository
  private readonly opsAlerts: OpsAlertsService
  private readonly capMicros: number
  private readonly perfectCorpUsdPerUnit: number | string
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: AiUsageServiceDeps) {
    this.repository = deps.repository
    this.opsAlerts = deps.opsAlerts
    this.capMicros = deps.capMicros
    this.perfectCorpUsdPerUnit = deps.perfectCorpUsdPerUnit
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

  async record(input: Parameters<VendorSpendLedger['record']>[0]): Promise<void> {
    const { key, ...call } = input
    if (!Number.isInteger(call.units) || call.units <= 0) throw new Error('Vendor units must be a positive whole number')
    if (key === '') throw new Error('A vendor call needs the vendor task id as its key')
    const price = this.priceOfAUnit()
    const createdAt = this.now()
    // Rounded once, at the end: units x price is inexact in floating point (12 x 0.07 x 1e6 is 840000.0000000001), and the column holds whole micros.
    const costMicros = Math.round(call.units * price * 1_000_000)
    const { overCap } = await this.repository.insertSettled({
      // Derived from the vendor's task id, so a task recorded twice is one row: the repository ignores an id it already holds.
      id: `${call.vendor}:${key}`,
      ...call,
      costMicros,
      createdAt,
      capMicros: this.capMicros,
      since: AiUsageService.startOfUtcDay(createdAt),
    })
    if (overCap) await this.opsAlerts.raise('ai-spend-cap')
  }

  async settle(reservationId: string, input: { usage: AiUsage; costMicros: number }): Promise<void> {
    await this.repository.settle(reservationId, { ...input, settledAt: this.now() })
  }

  async release(reservationId: string): Promise<void> {
    await this.repository.release(reservationId)
  }

  /** A missing price must not quietly cost every face scan nothing, so anything but a positive number throws, naming the setting. */
  private priceOfAUnit(): number {
    const raw = this.perfectCorpUsdPerUnit
    const price = typeof raw === 'string' ? (/^\s*\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : Number.NaN) : raw
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('PERFECT_CORP_USD_PER_UNIT must be a positive number of US dollars, e.g. "0.05"')
    }
    return price
  }

  private static startOfUtcDay(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
  }
}
