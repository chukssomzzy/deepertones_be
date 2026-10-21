import { env } from 'cloudflare:workers'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { REFERENCE } from '../../src/modules/catalog/catalog.reference'
import { ANALYSIS_VERSION } from '../../src/modules/catalog/catalog.vocabulary'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { D1CatalogWorkbookRepository } from '../../src/modules/catalog/catalog.workbook.repository'
import { ruleRow } from '../../src/modules/catalog/catalog.workbook.repository.contract'
import { catalogVersions, ingredientRules } from '../../src/modules/catalog/catalog.workbook.table'
import { FakeOpsAlertsRepository } from '../../src/modules/ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'

// The catalog service over real local D1 and the migrated, seeded rules: what the migration must not change, and what an approved rule
// added later must change. The rules tables are written straight into here because the workbook import (the only production write path) is a
// later change. The tests on the seed need it untouched, so they sit first and publish nothing; the ones after them replace the rules, and the file runs in order.

/** An alerting service that goes nowhere: these tests are not about ops alerts. */
const quietOpsAlerts = () =>
  new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: new MemoryJobQueue(), email: new MemoryEmailSender(), recipient: '', environment: 'test' })

const db = createDb(env.DB)
const repository = new D1CatalogRepository(db)
const analyst = new MemoryProductAnalyst()
const researcher = new MemoryProductResearcher()
const catalog = new ProductCatalogService({
  repository,
  workbook: new D1CatalogWorkbookRepository(db),
  researcher,
  analyst,
  images: new MemoryCatalogImageStore(),
  imageKeyPrefix: 'catalog/test',
  opsAlerts: quietOpsAlerts(),
})

// The database is shared by the whole file (and by an earlier run), so every product gets a brand no other test has.
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
const identity = () => ({ brand: `Live${runSalt}n${counter++}z`, name: 'Barrier Cream', category: 'skin' as const })

const EUR_LEX = 'https://eur-lex.europa.eu/eli/reg/2009/1223/oj'
const ZZYZX = 'Zzyzx Extractum'

/** A product the way a scan makes it: resolved, researched, with a list nobody has analysed yet. */
const researched = async (ingredients: string[]) => {
  const who = identity()
  researcher.respondWith(() => ({ found: true, ingredients, sourceUrl: 'https://example.com/barrier-cream' }))
  const resolved = await catalog.resolve(who)
  if (resolved.kind !== 'needs-research') throw new Error(`expected needs-research, got ${resolved.kind}`)
  const found = await catalog.research(resolved.productId)
  if (found.kind !== 'found') throw new Error(`expected found, got ${found.kind}`)
  return { who, productId: resolved.productId, formulationId: found.formulationId }
}

/** What the next upload does to the rules: the whole set replaced, and the next catalog version recorded under `rulesVersion`. */
const publish = async (rulesVersion: string, rules: ReturnType<typeof ruleRow>[]) => {
  const [latest] = await db.select({ version: sql<number>`coalesce(max(${catalogVersions.version}), 0)` }).from(catalogVersions)
  const version = (latest?.version ?? 0) + 1
  await db.delete(ingredientRules)
  for (const rule of rules) await db.insert(ingredientRules).values({ ...rule, updatedInVersion: version })
  await db.insert(catalogVersions).values({ version, rulesVersion, contractVersion: '1.0.0', uploadedBy: 'live rules test', archiveKey: null, createdAt: new Date() })
}

describe('the analysis, with the rules the migration seeded', () => {
  it('gives the analyst the facts REFERENCE flagged, now read from the rules in the database', async () => {
    const { formulationId } = await researched(['Aqua', 'Mercury', 'Glycerin'])
    analyst.analyseWith(() => [])

    // Nothing covers the fact, so it is rejected: what is read here is what the analyst was given.
    await catalog.analyse(formulationId).catch(() => undefined)

    expect(analyst.calls.analyse.at(-1)!.flaggedFacts).toEqual([{ kind: 'banned-substance', ingredient: 'Mercury', rule: REFERENCE.find((e) => e.name === 'mercury')!.rule, source: EUR_LEX }])
  })

  it('stamps an analysis made on the freshly migrated database with rules version seed-2026-10', async () => {
    const { formulationId } = await researched(['Aqua', 'Glycerin'])

    await catalog.analyse(formulationId)

    expect(await repository.findFormulation(formulationId)).toMatchObject({ analysisVersion: ANALYSIS_VERSION, referenceVersion: 'seed-2026-10' })
    expect((await catalog.productView(formulationId)).reference.version).toBe('seed-2026-10')
  })

  it('does not analyse again a formulation analysed at seed-2026-10 before the migration', async () => {
    const { who, productId, formulationId } = await researched(['Aqua', 'Glycerin'])
    // Written the way the old code wrote it, since only old code could have: it is the state the migration must leave alone.
    await repository.saveAnalysis(formulationId, { concerns: [], analysisVersion: ANALYSIS_VERSION, referenceVersion: 'seed-2026-10', analysedAt: new Date() })

    expect(await catalog.resolve(who)).toEqual({ kind: 'ready', productId, formulationId })
  })
})

describe('the analysis, after the rules change', () => {
  const seedRules = async () =>
    (await new D1CatalogWorkbookRepository(db).liveRules()).entries.map((e, i) =>
      ruleRow({ code: `ING-LIVE-${String(i).padStart(3, '0')}`, name: e.name, aliases: e.aliases, kind: e.kind, statement: e.rule, sourceUrl: e.source }),
    )

  it('analyses again a formulation analysed under the old rules, and gives the analyst what a newly approved rule flags', async () => {
    const { who, productId, formulationId } = await researched(['Aqua', ZZYZX])
    analyst.analyseWith(() => [])
    await catalog.analyse(formulationId)
    expect(await catalog.resolve(who)).toEqual({ kind: 'ready', productId, formulationId })
    const before = analyst.calls.analyse.length

    await publish('rules-live-1', [
      ...(await seedRules()),
      ruleRow({ name: 'zzyzx extractum', aliases: [], kind: 'irritation', statement: 'A statement from the workbook.', sourceUrl: 'https://example.com/zzyzx' }),
    ])

    expect(await catalog.resolve(who)).toEqual({ kind: 'needs-analysis', productId, formulationId })
    analyst.analyseWith((input) => input.flaggedFacts.map((f) => ({ kind: f.kind, severity: 'low', ingredients: [f.ingredient], why: 'Reported to sting.', whoShouldTakeCare: 'Anyone with reactive skin.', traits: [], sources: f.source === null ? [] : [f.source] })))
    await catalog.analyse(formulationId)
    expect(analyst.calls.analyse).toHaveLength(before + 1)
    expect(analyst.calls.analyse.at(-1)!.flaggedFacts).toEqual([
      { kind: 'irritation', ingredient: ZZYZX, rule: 'A statement from the workbook.', source: 'https://example.com/zzyzx' },
    ])
    expect(await catalog.resolve(who)).toEqual({ kind: 'ready', productId, formulationId })
    expect((await catalog.productView(formulationId)).reference.version).toBe('rules-live-1')
  })

  it('flags nothing for a draft rule, even one that names an ingredient on the label', async () => {
    const { formulationId } = await researched(['Aqua', ZZYZX])
    await publish('rules-live-2', [ruleRow({ name: 'zzyzx extractum', aliases: [], status: 'draft', approvedBy: null, approvedOn: null })])
    analyst.analyseWith(() => [])

    await catalog.analyse(formulationId)

    expect(analyst.calls.analyse.at(-1)!.flaggedFacts).toEqual([])
  })
})
