import { REFERENCE, REFERENCE_VERSION } from './catalog.reference'
import { seedRuleCode } from './catalog.workbook.seed'
import type { CatalogWorkbookRepository, LiveRules } from './catalog.workbook.repository'
import type { RuleRow } from './catalog.workbook.repository.contract'

/** In-memory CatalogWorkbookRepository for unit tests. Behaviour is pinned by catalogWorkbookRepositoryContract. */
export class FakeCatalogWorkbookRepository implements CatalogWorkbookRepository {
  // Starts as the migrated database does: the REFERENCE rules, approved, under the seed rules version, with the codes the seed gave them.
  private version = REFERENCE_VERSION
  private rules: RuleRow[] = REFERENCE.map((entry) => ({
    code: seedRuleCode(entry),
    name: entry.name,
    aliases: [...entry.aliases],
    kind: entry.kind,
    strengthLimit: null,
    statement: entry.rule,
    sourceUrl: entry.source,
    helps: [],
    status: 'approved',
    approvedBy: 'reference seed',
    approvedOn: '2026-10-21',
    auditedBy: null,
    auditedOn: null,
  }))

  async liveRules(): Promise<LiveRules> {
    const approved = this.rules.filter((rule) => rule.status === 'approved').sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    return {
      version: this.version,
      entries: approved.map((rule) => ({ name: rule.name, aliases: [...rule.aliases], kind: rule.kind, rule: rule.statement, source: rule.sourceUrl })),
    }
  }

  /** Makes `rules` the whole rules set under a new rules version, as an applied upload does. Not part of the repository type. */
  publishRules(rulesVersion: string, rules: RuleRow[]): void {
    this.version = rulesVersion
    this.rules = rules.map((rule) => ({ ...rule, aliases: [...rule.aliases] }))
  }
}
