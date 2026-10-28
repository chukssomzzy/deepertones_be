import type { StepPausesRepository } from './skin-care.pauses.repository'
import type { NewStepPause, StepPause } from './skin-care.types'

const OPEN: ReadonlySet<StepPause['state']> = new Set(['paused', 'bringing-back'])

const copyOf = (row: StepPause): StepPause => ({ ...row, productRef: structuredClone(row.productRef), createdAt: new Date(row.createdAt) })

/**
 * In-memory StepPausesRepository for unit tests. Its behaviour is pinned by stepPausesRepositoryContract, which the D1 class also passes. It mirrors the table's partial
 * unique indexes: one open row for a (profile, step, product key), and one open row with no step for a profile. Unlike D1 it has no profiles table,
 * so `insert` accepts a profile id that does not exist, and nothing cascades.
 *
 * Test hook: `failNext(error)` makes the next call of any method reject once, so a test can pin what a service does when storage fails.
 */
export class FakeStepPausesRepository implements StepPausesRepository {
  private rows = new Map<string, StepPause>()
  private failure: Error | null = null

  /** The next call of any method rejects with this error, once. */
  failNext(error: Error = new Error('storage failure')): void {
    this.failure = error
  }

  async insert(pause: NewStepPause): Promise<StepPause> {
    this.maybeFail()
    if (this.rows.has(pause.id)) throw new Error(`step pause ${pause.id} already exists`)
    if (OPEN.has(pause.state)) {
      // Two partial unique indexes over the open states: (profile, step, product key), which never holds a row with no step (SQL nulls are distinct), and (profile) over the rows
      // with no step, so a profile has one open stepless row whatever its key.
      const held = [...this.rows.values()].some(
        (row) => OPEN.has(row.state) && row.profileId === pause.profileId && (pause.step === null ? row.step === null : row.step === pause.step && row.productKey === pause.productKey),
      )
      if (held) throw new Error(`profile ${pause.profileId} already has an open pause for ${pause.step ?? 'no step'} and ${pause.productKey}`)
    }
    this.rows.set(pause.id, copyOf(pause))
    return copyOf(pause)
  }

  async find(profileId: string, id: string): Promise<StepPause | null> {
    this.maybeFail()
    const row = this.rows.get(id)
    return row && row.profileId === profileId ? copyOf(row) : null
  }

  async openFor(profileId: string): Promise<StepPause[]> {
    this.maybeFail()
    return [...this.rows.values()]
      .filter((row) => row.profileId === profileId && OPEN.has(row.state))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(copyOf)
  }

  async update(profileId: string, id: string, patch: Parameters<StepPausesRepository['update']>[2], onlyIfState?: StepPause['state']): Promise<boolean> {
    this.maybeFail()
    const row = this.rows.get(id)
    if (!row || row.profileId !== profileId || (onlyIfState !== undefined && row.state !== onlyIfState)) return false
    Object.assign(row, patch)
    return true
  }

  private maybeFail(): void {
    if (this.failure === null) return
    const error = this.failure
    this.failure = null
    throw error
  }
}
