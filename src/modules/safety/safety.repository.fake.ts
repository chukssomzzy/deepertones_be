import type { MentionResolution, SafetyRepository } from './safety.repository'
import type { ParseState, SafetyMentionRow, SafetyRow } from './safety.types'

/** In-memory SafetyRepository for unit tests. Its behaviour is pinned by safetyRepositoryContract, which the D1 class also passes. */
export class FakeSafetyRepository implements SafetyRepository {
  private rows: SafetyRow[] = []
  private mentionRows: SafetyMentionRow[] = []

  async append(row: SafetyRow): Promise<void> {
    this.rows.push({ ...row, choices: [...row.choices] })
  }

  async find(id: string): Promise<SafetyRow | null> {
    const row = this.rows.find((candidate) => candidate.id === id)
    return row ? { ...row, choices: [...row.choices] } : null
  }

  async current(profileId: string): Promise<SafetyRow | null> {
    return (await this.history(profileId))[0] ?? null
  }

  async history(profileId: string): Promise<SafetyRow[]> {
    // Rows that share a time come back in reverse insertion order, as D1's rowid tiebreak does.
    return this.rows
      .filter((row) => row.profileId === profileId)
      .reverse()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({ ...row, choices: [...row.choices] }))
  }

  async setParseState(id: string, parseState: ParseState): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id)
    if (row) row.parseState = parseState
  }

  async appendMentions(mentions: SafetyMentionRow[]): Promise<void> {
    this.mentionRows.push(...mentions.map((mention) => ({ ...mention })))
  }

  async mentions(safetyId: string): Promise<SafetyMentionRow[]> {
    return this.mentionRows
      .filter((mention) => mention.safetyId === safetyId)
      .sort((a, b) => a.position - b.position)
      .map((mention) => ({ ...mention }))
  }

  async resolveMention(id: string, { resolution, productId }: MentionResolution): Promise<void> {
    const mention = this.mentionRows.find((candidate) => candidate.id === id)
    if (mention) Object.assign(mention, { resolution, productId })
  }
}
