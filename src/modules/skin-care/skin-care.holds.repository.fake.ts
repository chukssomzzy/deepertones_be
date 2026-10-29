import type { EscalationHoldsRepository } from './skin-care.holds.repository'
import type { EscalationHold, NewEscalationHold } from './skin-care.types'
import type { HoldCloseHow } from './skin-care.vocabulary'

const copyOf = (row: EscalationHold): EscalationHold => ({ ...row, openedAt: new Date(row.openedAt), closedAt: row.closedAt === null ? null : new Date(row.closedAt) })

/**
 * In-memory EscalationHoldsRepository for unit tests. Its behaviour is pinned by escalationHoldsRepositoryContract, which the D1 class also passes. It mirrors the table's
 * partial unique index (one open hold per profile): `open` while one is open answers it and writes nothing. Unlike D1 it has no profiles table, so `open` accepts a profile id
 * that does not exist, and nothing cascades.
 *
 * Test hook: `failNext(error)` makes the next call of any method reject once, so a test can pin what a service does when storage fails.
 */
export class FakeEscalationHoldsRepository implements EscalationHoldsRepository {
  private rows = new Map<string, EscalationHold>()
  private failure: Error | null = null

  /** The next call of any method rejects with this error, once. */
  failNext(error: Error = new Error('storage failure')): void {
    this.failure = error
  }

  async open(hold: NewEscalationHold): Promise<EscalationHold> {
    this.maybeFail()
    if (this.rows.has(hold.id)) throw new Error(`escalation hold ${hold.id} already exists`)
    const existing = this.openRow(hold.profileId)
    if (existing) return copyOf(existing)
    const row: EscalationHold = { ...hold, closedAt: null, closedHow: null }
    this.rows.set(row.id, copyOf(row))
    return copyOf(row)
  }

  async openFor(profileId: string): Promise<EscalationHold | null> {
    this.maybeFail()
    const row = this.openRow(profileId)
    return row ? copyOf(row) : null
  }

  async close(profileId: string, holdId: string, how: HoldCloseHow, at: Date): Promise<boolean> {
    this.maybeFail()
    const row = this.rows.get(holdId)
    if (!row || row.profileId !== profileId || row.closedAt !== null) return false
    row.closedAt = new Date(at)
    row.closedHow = how
    return true
  }

  private openRow(profileId: string): EscalationHold | undefined {
    return [...this.rows.values()].find((row) => row.profileId === profileId && row.closedAt === null)
  }

  private maybeFail(): void {
    if (this.failure === null) return
    const error = this.failure
    this.failure = null
    throw error
  }
}
