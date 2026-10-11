import type { PhoneNumber } from '../../lib/phone'
import type { NewOtpChallenge, OtpChallenge, OtpRepository } from './otp.repository'

const PURGE_AFTER_MS = 24 * 60 * 60 * 1000

export class FakeOtpRepository implements OtpRepository {
  private rows: OtpChallenge[] = []

  async findLatest(phone: PhoneNumber): Promise<OtpChallenge | null> {
    const mine = this.rows.filter((r) => r.phone === phone)
    const latest = mine.reduce<OtpChallenge | null>((a, r) => (!a || r.createdAt >= a.createdAt ? r : a), null)
    return latest && { ...latest }
  }

  async sendTimes(phone: PhoneNumber, since: Date): Promise<Date[]> {
    return this.rows
      .filter((r) => r.phone === phone && r.createdAt >= since && !(r.deliveryStatus === 'failed' && r.failureReason === 'unavailable'))
      .map((r) => r.createdAt)
      .sort((a, b) => b.getTime() - a.getTime())
  }

  async create(challenge: NewOtpChallenge): Promise<void> {
    const cutoff = challenge.createdAt.getTime() - PURGE_AFTER_MS
    this.rows = this.rows.filter((r) => r.phone !== challenge.phone || r.createdAt.getTime() >= cutoff)
    this.rows.push({ ...challenge, attempts: 0, consumedAt: null, deliveryStatus: 'queued', failureReason: null, deliveredAt: null })
  }

  async findById(id: string): Promise<OtpChallenge | null> {
    const row = this.rows.find((r) => r.id === id)
    return row ? { ...row } : null
  }

  async markDelivered(id: string, at: Date): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id)
    if (!row || row.deliveryStatus !== 'queued') return false
    Object.assign(row, { deliveryStatus: 'delivered', deliveredAt: at })
    return true
  }

  async markFailed(id: string, reason: NonNullable<OtpChallenge['failureReason']>): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id)
    if (!row || row.deliveryStatus !== 'queued') return false
    Object.assign(row, { deliveryStatus: 'failed', failureReason: reason })
    return true
  }

  async recordFailedAttempt(id: string, maxAttempts: number): Promise<number | null> {
    const row = this.rows.find((r) => r.id === id)
    if (!row || row.attempts >= maxAttempts) return null
    return ++row.attempts
  }

  async consume(id: string, at: Date, maxAttempts: number): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id)
    if (!row || row.consumedAt || row.attempts >= maxAttempts || row.expiresAt <= at) return false
    row.consumedAt = at
    return true
  }
}
