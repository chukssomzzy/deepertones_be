import { env } from 'cloudflare:workers'
import { sql } from 'drizzle-orm'
import { createDb } from '../../src/lib/db'
import { D1CatalogWorkbookRepository } from '../../src/modules/catalog/catalog.workbook.repository'
import { catalogWorkbookRepositoryContract } from '../../src/modules/catalog/catalog.workbook.repository.contract'
import { catalogVersions, ingredientRules } from '../../src/modules/catalog/catalog.workbook.table'

const db = createDb(env.DB)

// The workbook import is the only production write path to these tables and it comes later, so the contract's states are written straight
// into the tables here. `publish` replaces the whole rules set and adds the next catalog version, which is what an applied upload does.
catalogWorkbookRepositoryContract('D1', () => ({
  repo: new D1CatalogWorkbookRepository(db),
  publish: async (rulesVersion, rules) => {
    const [latest] = await db.select({ version: sql<number>`coalesce(max(${catalogVersions.version}), 0)` }).from(catalogVersions)
    const version = (latest?.version ?? 0) + 1
    await db.delete(ingredientRules)
    // One insert per rule: a rule binds many columns and D1 allows 100 bound parameters a statement.
    for (const rule of rules) await db.insert(ingredientRules).values({ ...rule, updatedInVersion: version })
    await db.insert(catalogVersions).values({ version, rulesVersion, contractVersion: '1.0.0', uploadedBy: 'contract test', archiveKey: null, createdAt: new Date() })
  },
  // As ProductCatalogService.addAlias writes one: the product is found by its identity key.
  alias: async (aliasKey, identityKey) => {
    await env.DB.prepare('insert into product_aliases (alias_key, product_id) select ?, id from products where identity_key = ?').bind(aliasKey, identityKey).run()
  },
}))
