import { describe, expect, it } from 'vitest'
import { REFERENCE, REFERENCE_VERSION } from './catalog.reference'
import { seedRuleCode } from './catalog.workbook.seed'
import { FakeCatalogWorkbookRepository } from './catalog.workbook.repository.fake'
import { catalogWorkbookRepositoryContract } from './catalog.workbook.repository.contract'

catalogWorkbookRepositoryContract('fake', () => {
  const repo = new FakeCatalogWorkbookRepository()
  return { repo, publish: async (rulesVersion, rules) => repo.publishRules(rulesVersion, rules), alias: async (aliasKey, identityKey) => repo.addAlias(aliasKey, identityKey) }
})

// The fake stands in for the migrated database, so it must start as the database does: the same codes (ING-<NAME>-<KIND>, from the one seed
// function), so listing by code gives the same order, and the same rules version. catalogWorkbookRepositoryContract cannot say this, since
// a state it reads has to be published first; the D1 twin of this check is test/integration/catalog.rules.facts-order.test.ts.
describe('FakeCatalogWorkbookRepository before anything is published', () => {
  it('serves every REFERENCE rule under seed-2026-10, ordered by the code the seed gives it', async () => {
    const byCode = [...REFERENCE].sort((a, b) => (seedRuleCode(a) < seedRuleCode(b) ? -1 : seedRuleCode(a) > seedRuleCode(b) ? 1 : 0))

    expect(await new FakeCatalogWorkbookRepository().liveRules()).toEqual({ version: REFERENCE_VERSION, entries: byCode })
  })
})
