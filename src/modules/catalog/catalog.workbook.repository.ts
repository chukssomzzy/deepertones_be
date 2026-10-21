import { asc, desc, eq } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import type { ReferenceEntry } from './catalog.reference'
import { catalogVersions, ingredientRules } from './catalog.workbook.table'

/** The approved ingredient rules in the shape the matcher reads, and the rules version they are under. */
export type LiveRules = { version: string; entries: ReferenceEntry[] }

export class D1CatalogWorkbookRepository {
  // A rules version names exactly one set of approved rules (it is a hash of them), so the entries are kept per isolate and read again
  // only when the version moves. The version itself is read on every call, so a newly published one is seen at once.
  private static cached: LiveRules | null = null

  constructor(private readonly db: Db) {}

  /** The rules version of the latest catalog version, and the approved rules, in code order. A draft or retired rule is never returned. */
  async liveRules(): Promise<LiveRules> {
    const [latest] = await this.latestRulesVersion()
    // The migration seeds catalog version 1, so none at all means the database was not migrated.
    if (!latest) throw new Error('no catalog version')
    const held = D1CatalogWorkbookRepository.cached
    if (held?.version === latest.rulesVersion) return held

    // The version and the rules are read in one batch, so an upload cannot land between them: the entries are stored under the version they
    // were read with, never under an older one (which would serve the new rules as the old version until the next upload).
    const [versions, rows] = await this.db.batch([
      this.latestRulesVersion(),
      this.db
        .select({ name: ingredientRules.name, aliases: ingredientRules.aliases, kind: ingredientRules.kind, statement: ingredientRules.statement, sourceUrl: ingredientRules.sourceUrl })
        .from(ingredientRules)
        .where(eq(ingredientRules.status, 'approved'))
        .orderBy(asc(ingredientRules.code)),
    ])
    const [current] = versions
    if (!current) throw new Error('no catalog version')
    const live: LiveRules = {
      version: current.rulesVersion,
      entries: rows.map((row) => ({ name: row.name, aliases: row.aliases, kind: row.kind, rule: row.statement, source: row.sourceUrl })),
    }
    D1CatalogWorkbookRepository.cached = live
    return live
  }

  private latestRulesVersion() {
    return this.db.select({ rulesVersion: catalogVersions.rulesVersion }).from(catalogVersions).orderBy(desc(catalogVersions.version)).limit(1)
  }
}

export type CatalogWorkbookRepository = PublicOf<D1CatalogWorkbookRepository>
