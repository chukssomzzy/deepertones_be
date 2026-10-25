import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1CatalogWorkbookRepository, type WorkbookPlan } from '../../src/modules/catalog/catalog.workbook.repository'
import { claimWordRow, country, ruleRow, sale, taperRow, workbookProduct } from '../../src/modules/catalog/catalog.workbook.repository.contract'

// How applyWorkbook meets D1 itself: what its one batch is made of, and what it does with a batch that fails. The behaviour a repository must have
// is in catalogWorkbookRepositoryContract (catalog.workbook.repository.test.ts); these need the real driver to be spied on.

const db = createDb(env.DB)
const repo = new D1CatalogWorkbookRepository(db)

const planOf = async (over: Partial<WorkbookPlan> = {}): Promise<WorkbookPlan> => ({
  baseVersion: await repo.catalogVersion(),
  rulesVersion: (await repo.liveRules()).version,
  contractVersion: '1.0.0',
  uploadedBy: 'apply test',
  archiveKey: `workbooks/test/apply-${crypto.randomUUID()}.xlsx`,
  now: new Date('2030-06-15T10:00:00.000Z'),
  newProducts: [],
  products: [],
  availability: null,
  ingredients: [],
  countries: [],
  retiredProducts: [],
  retiredIngredients: [],
  retiredCountries: [],
  claimWords: [],
  tapers: [],
  retiredClaimWords: [],
  retiredTapers: [],
  ...over,
})

type Built = { toSQL(): { sql: string; params: unknown[] } }

afterEach(() => vi.restoreAllMocks())

describe('the batch applyWorkbook sends', () => {
  it('is one db.batch, with the catalog version first and no statement binding more than the 100 parameters D1 allows, for every table the plan writes', async () => {
    const products = Array.from({ length: 30 }, () => workbookProduct({ variant: 'A fairly long variant name', draftCells: [{ column: 'frequency', url: 'https://example.com/a-source-page' }] }))
    const where = `AP-${crypto.randomUUID().slice(0, 6)}`
    const rules = Array.from({ length: 14 }, () => {
      const { approvedOn: _day, ...rule } = ruleRow()
      return { ...rule, approvedOn: new Date('2030-06-15T00:00:00.000Z'), auditedOn: null }
    })

    const plan = await planOf({
      rulesVersion: `rules-apply-${crypto.randomUUID().slice(0, 8)}`,
      countries: [country(where), ...Array.from({ length: 20 }, () => country(`AP-${crypto.randomUUID().slice(0, 6)}`))],
      newProducts: products.map((one) => one.newProduct),
      products: products.map((one) => one.planned),
      availability: products.map((one) => sale(one.row.code, where)),
      ingredients: rules,
      retiredProducts: Array.from({ length: 95 }, (_, i) => `PRD-NONE-${i}`),
      // The new tabs are written in chunks too: a Tapers row binds the most of any row here (its steps are a list), and none may go over D1's 100.
      claimWords: Array.from({ length: 40 }, () => claimWordRow()),
      tapers: Array.from({ length: 40 }, () => taperRow({ auditedBy: 'Dr B. Auditor', auditedOn: new Date('2030-06-15T00:00:00.000Z') })),
      retiredClaimWords: Array.from({ length: 95 }, (_, i) => `CLM-NONE-${i}`),
      retiredTapers: Array.from({ length: 95 }, (_, i) => `TPR-NONE-${i}`),
    })
    const count = repo.statementCount(plan)
    // After the plan is made: building it reads the rules in a batch of its own.
    const batch = vi.spyOn(db, 'batch')
    expect(await repo.applyWorkbook(plan)).toBe(true)

    expect(batch).toHaveBeenCalledTimes(1)
    const statements = batch.mock.calls[0]![0] as unknown as Built[]
    expect(statements).toHaveLength(count)
    expect(statements[0]!.toSQL().sql).toContain('"catalog_versions"')
    const widest = Math.max(...statements.map((statement) => statement.toSQL().params.length))
    expect(widest).toBeLessThanOrEqual(100)
    // Many rows to a statement: far fewer statements than rows.
    expect(count).toBeLessThan(products.length * 2)
  })
})

describe('applyWorkbook when the batch throws', () => {
  it('rethrows a failure that is not a lost race, and the live version is where it was', async () => {
    const base = await repo.catalogVersion()
    const plan = await planOf()
    vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('D1 is unavailable'))

    await expect(repo.applyWorkbook(plan)).rejects.toThrow('D1 is unavailable')

    expect(await repo.catalogVersion()).toBe(base)
  })

  it('reports success, not a lost race, when the batch committed and only its answer was lost: the version row is this upload\'s own', async () => {
    const base = await repo.catalogVersion()
    const plan = await planOf()
    const real = db.batch.bind(db) as (statements: never) => Promise<unknown>
    vi.spyOn(db, 'batch').mockImplementationOnce((async (statements: never) => {
      await real(statements)
      throw new Error('the connection dropped after the commit')
    }) as never)

    expect(await repo.applyWorkbook(plan)).toBe(true)

    expect(await repo.catalogVersion()).toBe(base + 1)
  })

  it('reports a lost race when the version is another upload\'s, even if the error says otherwise', async () => {
    const first = await planOf()
    expect(await repo.applyWorkbook(first)).toBe(true)
    const stale = { ...(await planOf()), baseVersion: first.baseVersion, archiveKey: `workbooks/test/apply-${crypto.randomUUID()}.xlsx` }
    vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('SQLITE_CONSTRAINT'))

    expect(await repo.applyWorkbook(stale)).toBe(false)
  })
})
