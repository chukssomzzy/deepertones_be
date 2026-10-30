import type { NewMistakeReport, NewWrongMatchReport, VerdictReport, VerdictReportsRepository } from './verdicts.reports.repository'

const copyOf = (row: VerdictReport): VerdictReport => ({ ...row, verdict: structuredClone(row.verdict), basis: structuredClone(row.basis), createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) })

/**
 * In-memory VerdictReportsRepository for unit tests. Its behaviour is pinned by verdictReportsRepositoryContract, which the D1 class also passes. It mirrors the table's partial
 * unique index (one mistake per profile, entry and fingerprint). Unlike D1 it has no profiles table, so it accepts a profile that does not exist, and nothing cascades.
 */
export class FakeVerdictReportsRepository implements VerdictReportsRepository {
  private rows = new Map<string, VerdictReport>()

  async upsertMistake(report: NewMistakeReport, now: Date): Promise<{ id: string; created: boolean }> {
    const held = [...this.rows.values()].find((row) => row.kind === 'mistake' && row.profileId === report.profileId && row.entryId === report.entryId && row.fingerprint === report.fingerprint)
    if (held) {
      held.note = report.note
      held.updatedAt = new Date(now)
      return { id: held.id, created: false }
    }
    if (this.rows.has(report.id)) throw new Error(`verdict report ${report.id} already exists`)
    this.rows.set(report.id, copyOf({ ...report, kind: 'mistake', oldProductId: null, newProductId: null, createdAt: now, updatedAt: now }))
    return { id: report.id, created: true }
  }

  async recordWrongMatch(report: NewWrongMatchReport, now: Date): Promise<void> {
    if (this.rows.has(report.id)) throw new Error(`verdict report ${report.id} already exists`)
    this.rows.set(report.id, copyOf({ ...report, kind: 'wrong-match', group: null, verdict: null, basis: null, fingerprint: null, note: null, createdAt: now, updatedAt: now }))
  }

  async find(id: string): Promise<VerdictReport | null> {
    const row = this.rows.get(id)
    return row ? copyOf(row) : null
  }
}
