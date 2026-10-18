import { asc, desc, eq, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { profileSafety, safetyMentions } from './safety.table'
import type { ParseState, SafetyMentionRow, SafetyRow } from './safety.types'

/** How a product mention ended up: found in the catalog with ingredients, or not (the catalog's product id, when it has one, is kept either way). */
export type MentionResolution = { resolution: 'resolved' | 'unresolved'; productId: string | null }

export class D1SafetyRepository {
  // Rows can share a created_at (the clock has millisecond resolution), and then the one appended later must still win. `rowid` grows
  // with each insert into this table, so it breaks the tie the same way every time; without it SQLite may return either row.
  private static readonly NEWEST_FIRST = [desc(profileSafety.createdAt), sql`rowid desc`] as const

  constructor(private readonly db: Db) {}

  /** Adds a row to the profile's history. Rejects a profile that does not exist. */
  async append(row: SafetyRow): Promise<void> {
    await this.db.insert(profileSafety).values(row)
  }

  /** The row with this id, whoever it belongs to and whether or not it is still the current one; null when there is none. */
  async find(id: string): Promise<SafetyRow | null> {
    const [row] = await this.db.select().from(profileSafety).where(eq(profileSafety.id, id)).limit(1)
    return row ?? null
  }

  /** The profile's newest row by time, or null when it never answered. */
  async current(profileId: string): Promise<SafetyRow | null> {
    const [row] = await this.db
      .select()
      .from(profileSafety)
      .where(eq(profileSafety.profileId, profileId))
      .orderBy(...D1SafetyRepository.NEWEST_FIRST)
      .limit(1)
    return row ?? null
  }

  /** Every row the profile ever saved, newest first. */
  async history(profileId: string): Promise<SafetyRow[]> {
    return this.db.select().from(profileSafety).where(eq(profileSafety.profileId, profileId)).orderBy(...D1SafetyRepository.NEWEST_FIRST)
  }

  /** Moves the row's parse to `parseState`, changing nothing else. A row that does not exist is ignored (the profile may have gone while a message waited). */
  async setParseState(id: string, parseState: ParseState): Promise<void> {
    await this.db.update(profileSafety).set({ parseState }).where(eq(profileSafety.id, id))
  }

  /**
   * Stores the mentions, all or none (one batch). Rejects a mention whose safety row does not exist. One INSERT per mention keeps each
   * statement under D1's bound-parameter limit. An empty list does nothing.
   */
  async appendMentions(mentions: SafetyMentionRow[]): Promise<void> {
    const [first, ...rest] = mentions.map((mention) => this.db.insert(safetyMentions).values(mention))
    if (first) await this.db.batch([first, ...rest] as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  }

  /** The mentions parsed from a row, in the order they were found. */
  async mentions(safetyId: string): Promise<SafetyMentionRow[]> {
    return this.db.select().from(safetyMentions).where(eq(safetyMentions.safetyId, safetyId)).orderBy(asc(safetyMentions.position))
  }

  /** Records how a product mention was looked up, changing nothing else of it. A mention that does not exist is ignored. */
  async resolveMention(id: string, { resolution, productId }: MentionResolution): Promise<void> {
    await this.db.update(safetyMentions).set({ resolution, productId }).where(eq(safetyMentions.id, id))
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type SafetyRepository = PublicOf<D1SafetyRepository>
