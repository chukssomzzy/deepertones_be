import { describe, expect, it } from 'vitest'
import type { CatalogWorkbookRepository, PlannedProduct, WorkbookPlan } from './catalog.workbook.repository'
import type { ConcernKind, IngredientGroup } from './catalog.vocabulary'
import type { ProductRow } from './catalog.workbook.schema'
import type { ShownConcern } from '../face-scans/face-scans.tables'

// One ingredient rule as the workbook's Ingredients tab holds it and `ingredient_rules` stores it. The dates are the workbook's own
// `YYYY-MM-DD` text (a date, not an instant), because `approved_on` is a calendar day somebody signed on.
export type RuleRow = {
  code: string
  name: string
  aliases: string[]
  kind: ConcernKind
  strengthLimit: string | null
  statement: string
  sourceUrl: string | null
  helps: ShownConcern[]
  /** Rule metadata the floor reads: null for most rules. Not part of what the matcher reads, so not part of the rules version. */
  group: IngredientGroup | null
  clashesWith: IngredientGroup[]
  status: 'draft' | 'approved' | 'retired'
  approvedBy: string | null
  approvedOn: string | null
  auditedBy: string | null
  auditedOn: string | null
}

/** The day every rule here was signed off; a calendar day, as the workbook writes it. */
const APPROVED_ON = '2030-06-15'

// Each call yields a value no other test (or earlier run against a shared D1) uses.
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
const fresh = (label: string) => `${label}-${runSalt}-${counter++}`

/** An approved rule for an ingredient nobody else names, with every optional cell filled in; override what a test is about. */
export const ruleRow = (over: Partial<RuleRow> = {}): RuleRow => {
  const slug = fresh('zzyzx')
  return {
    code: `ING-${slug.toUpperCase()}-IRRITATION`,
    name: slug,
    aliases: [`${slug} oil`],
    kind: 'irritation',
    strengthLimit: '2% in leave-on products',
    statement: 'Commonly reported to sting skin with a weakened barrier.',
    sourceUrl: null,
    helps: ['hd_redness'],
    group: null,
    clashesWith: [],
    status: 'approved',
    approvedBy: 'Dr A. Reviewer',
    approvedOn: APPROVED_ON,
    auditedBy: null,
    auditedOn: null,
    ...over,
  }
}

/**
 * What a test needs besides the repository: a way to put the catalog in a state. The only write path that exists in production is the
 * workbook import (a later change), so each tier supplies its own: the fake's own method, and rows written straight into D1.
 * `publish` makes `rules` the whole rules set and records a new catalog version carrying `rulesVersion`. `alias` remembers another spelling of a catalog
 * product, as a scan the model matched would, which no workbook write does.
 */
export type RulesHarness = {
  repo: CatalogWorkbookRepository
  publish: (rulesVersion: string, rules: RuleRow[]) => Promise<void>
  alias: (aliasKey: string, identityKey: string) => Promise<void>
}

const DAY = new Date('2030-06-15T00:00:00.000Z')
const NOW = new Date('2030-06-15T10:00:00.000Z')

/** A Products row as an upload makes it, with the new product it would create and the workbook list it would store: all the rows its plan needs. */
export const workbookProduct = (over: Partial<ProductRow> = {}) => {
  const brand = fresh('brand')
  const row: ProductRow = {
    code: `PRD-${runSalt}-${counter++}`,
    brand,
    name: 'Gentle Cleanser',
    variant: null,
    form: null,
    category: 'skin',
    ingredients: ['Aqua', 'Glycerin', 'Cetearyl Alcohol'],
    ingredientsSourceUrl: 'https://example.com/list',
    keyIngredient: 'Azelaic acid',
    strength: '10%',
    skinConcerns: ['hd_moisture', 'hd_redness'],
    skinTypes: ['dry', 'combination'],
    steps: ['cleanse', 'treat'],
    frequency: 'am-pm',
    ownCautions: ['irritation'],
    evidenceUrls: ['https://example.com/a', 'https://example.com/b'],
    origin: 'sourced',
    status: 'approved',
    approvedBy: 'Dr A. Reviewer',
    approvedOn: DAY,
    auditedBy: 'Dr B. Auditor',
    auditedOn: DAY,
    draftCells: [],
    ...over,
  }
  const identityKey = `${row.brand}|${row.name}||`
  const newProduct = { id: fresh('product'), identityKey, brandKey: row.brand.toLowerCase(), kind: 'named' as const, brand: row.brand, name: row.name, variant: null, form: null, category: row.category, searchText: `${row.brand} ${row.name}`, createdAt: NOW }
  const formulation = { id: fresh('formulation'), ingredientsKey: row.ingredients.map((item) => item.toLowerCase()).join('\n') }
  const planned: PlannedProduct = { row, productKey: identityKey, formulation: row.ingredients.length === 0 ? null : formulation }
  return { row, identityKey, newProduct, formulation, planned }
}
type Fixture = ReturnType<typeof workbookProduct>

export const sale = (code: string, country: string, over: Partial<{ priceMin: number; priceMax: number; whereSold: string | null; sourceUrl: string | null }> = {}) => ({
  productCode: code,
  country,
  priceMin: 3000,
  priceMax: 4500,
  whereSold: 'Pharmacies' as string | null,
  sourceUrl: null as string | null,
  ...over,
})
export const country = (code: string, status: 'active' | 'retired' = 'active') => ({ code, currency: 'NGN', lowMax: 5000, midMax: 15000, status })

/** A Claim words row as an upload parses it (the days are Dates). The properties are the contract's camelCased column names. */
export const claimWordRow = (over: Partial<{ code: string; phrase: string; claim: 'lightening'; status: 'approved' | 'retired'; approvedBy: string | null; approvedOn: Date | null; auditedBy: string | null; auditedOn: Date | null }> = {}) => ({
  code: `CLM-${runSalt}-${counter++}`,
  phrase: fresh('zzyzx cream'),
  claim: 'lightening' as const,
  status: 'approved' as 'approved' | 'retired',
  approvedBy: 'Dr A. Reviewer' as string | null,
  approvedOn: DAY as Date | null,
  auditedBy: 'Dr B. Auditor' as string | null,
  auditedOn: DAY as Date | null,
  ...over,
})

/** A Tapers row as an upload parses it: the schedule is its steps, as the contract reads them. */
export const taperRow = (
  over: Partial<{
    code: string
    kind: 'steroid' | 'lightening-agent'
    schedule: { fromWeek: number; toWeek: number; frequency: string }[]
    whatToExpect: string
    seeAProfessionalIf: string
    status: 'draft' | 'approved' | 'retired'
    approvedBy: string | null
    approvedOn: Date | null
    auditedBy: string | null
    auditedOn: Date | null
  }> = {},
) => ({
  code: `TPR-${runSalt}-${counter++}`,
  kind: 'steroid' as 'steroid' | 'lightening-agent',
  schedule: [
    { fromWeek: 1, toWeek: 2, frequency: 'alternate-days' },
    { fromWeek: 3, toWeek: 4, frequency: 'weekly' },
    { fromWeek: 5, toWeek: 5, frequency: 'stop' },
  ],
  whatToExpect: 'Skin may flare for a few days after each step down. This is expected.',
  seeAProfessionalIf: 'The redness spreads, or the skin weeps or blisters.',
  status: 'approved' as 'draft' | 'approved' | 'retired',
  approvedBy: 'Dr A. Reviewer' as string | null,
  approvedOn: DAY as Date | null,
  auditedBy: null as string | null,
  auditedOn: null as Date | null,
  ...over,
})

/** Behaviour every CatalogWorkbookRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const catalogWorkbookRepositoryContract = (name: string, make: () => RulesHarness | Promise<RulesHarness>) => {
  describe(`CatalogWorkbookRepository contract: ${name}`, () => {
    describe('liveRules', () => {
      it('returns the rules version of the latest catalog version, with the approved rules in the shape the matcher reads', async () => {
        const { repo, publish } = await make()
        const rule = ruleRow({
          name: 'zzyzx extractum',
          aliases: ['zzyzx oil', 'zzyzx'],
          kind: 'pregnancy-caution',
          statement: 'Commonly advised against while pregnant.',
          sourceUrl: 'https://example.com/zzyzx',
        })
        await publish('rules-contract-1', [rule])

        const live = await repo.liveRules()

        expect(live).toEqual({
          version: 'rules-contract-1',
          entries: [
            {
              name: 'zzyzx extractum',
              aliases: ['zzyzx oil', 'zzyzx'],
              kind: 'pregnancy-caution',
              rule: 'Commonly advised against while pregnant.',
              source: 'https://example.com/zzyzx',
            },
          ],
        })
      })

      it('gives a rule with no source a source of null, and a rule with no aliases an empty list', async () => {
        const { repo, publish } = await make()
        await publish('rules-contract-2', [ruleRow({ name: 'zzyzx plain', aliases: [], sourceUrl: null })])

        const { entries } = await repo.liveRules()

        expect(entries).toEqual([expect.objectContaining({ name: 'zzyzx plain', aliases: [], source: null })])
      })

      it('leaves out every rule that is not approved: a draft applies to nothing, and neither does a retired one', async () => {
        const { repo, publish } = await make()
        const approved = ruleRow({ name: 'zzyzx approved' })
        await publish('rules-contract-3', [
          approved,
          ruleRow({ name: 'zzyzx draft', status: 'draft', approvedBy: null, approvedOn: null }),
          ruleRow({ name: 'zzyzx retired', status: 'retired' }),
        ])

        const { entries } = await repo.liveRules()

        expect(entries.map((e) => e.name)).toEqual(['zzyzx approved'])
      })

      it('returns no entries, and still the version, when no rule is approved', async () => {
        const { repo, publish } = await make()
        await publish('rules-contract-4', [ruleRow({ status: 'draft', approvedBy: null, approvedOn: null })])

        expect(await repo.liveRules()).toEqual({ version: 'rules-contract-4', entries: [] })
      })

      it('lists the rules in the order of their codes, so the same set always reads the same', async () => {
        const { repo, publish } = await make()
        const rules = [ruleRow({ code: 'ING-ZZ-C', name: 'zzyzx c' }), ruleRow({ code: 'ING-ZZ-A', name: 'zzyzx a' }), ruleRow({ code: 'ING-ZZ-B', name: 'zzyzx b' })]
        await publish('rules-contract-5', rules)

        const { entries } = await repo.liveRules()

        expect(entries.map((e) => e.name)).toEqual(['zzyzx a', 'zzyzx b', 'zzyzx c'])
      })

      it('reports the newest version and its rules each time it is asked, never an earlier one it has already read', async () => {
        const { repo, publish } = await make()
        await publish('rules-contract-6a', [ruleRow({ name: 'zzyzx first' })])
        expect((await repo.liveRules()).version).toBe('rules-contract-6a')

        await publish('rules-contract-6b', [ruleRow({ name: 'zzyzx second' })])

        const live = await repo.liveRules()
        expect(live.version).toBe('rules-contract-6b')
        expect(live.entries.map((e) => e.name)).toEqual(['zzyzx second'])
      })

      it('reads the same version again when nothing was published in between', async () => {
        const { repo, publish } = await make()
        await publish('rules-contract-7', [ruleRow({ name: 'zzyzx steady' })])

        expect(await repo.liveRules()).toEqual(await repo.liveRules())
      })
    })

    // The upload's one atomic write, and the reads the recommendation module and the export use. The database is shared by the whole run, so every
    // code, brand and country here is salted and each test looks only at its own rows.
    describe('applyWorkbook, readWorkbook, matchProducts and approvedFor', () => {
      /** A plan from the live version, leaving the rules as they are, with whatever the test is about. */
      const planOf = async (repo: CatalogWorkbookRepository, over: Partial<WorkbookPlan> = {}): Promise<WorkbookPlan> => ({
        baseVersion: await repo.catalogVersion(),
        rulesVersion: (await repo.liveRules()).version,
        contractVersion: '1.0.0',
        uploadedBy: 'contract test',
        archiveKey: fresh('workbooks/test/1'),
        now: NOW,
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
      const stored = async (repo: CatalogWorkbookRepository, code: string) => (await repo.readWorkbook()).workbook.products.find((row) => row.code === code)
      const sold = async (repo: CatalogWorkbookRepository, where: string, step: 'cleanse' | 'treat' | 'moisturise' | 'protect' = 'cleanse') =>
        (await repo.approvedFor({ country: where, step })).map((row) => row.code)

      it('stores a new product, the workbook list as its formulation, the row that pins it, its availability and country, and moves to the next version and rules version', async () => {
        const { repo } = await make()
        const one = workbookProduct()
        const nigeria = country(fresh('N'))
        const base = await repo.catalogVersion()

        const applied = await repo.applyWorkbook(
          await planOf(repo, { rulesVersion: fresh('rules-contract-apply'), countries: [nigeria], newProducts: [one.newProduct], products: [one.planned], availability: [sale(one.row.code, nigeria.code)] }),
        )

        expect(applied).toBe(true)
        expect(await repo.catalogVersion()).toBe(base + 1)
        const read = await repo.readWorkbook()
        expect(read.catalogVersion).toBe(base + 1)
        expect(read.workbook.products.find((row) => row.code === one.row.code)).toEqual(one.row)
        expect(read.workbook.availability.filter((row) => row.productCode === one.row.code)).toEqual([sale(one.row.code, nigeria.code)])
        expect(read.workbook.countries.find((row) => row.code === nigeria.code)).toEqual(nigeria)
        expect((await repo.matchProducts([one.identityKey])).get(one.identityKey)).toBe(one.identityKey)
        const [recommendation] = await repo.approvedFor({ country: nigeria.code, step: 'cleanse' })
        expect(recommendation).toMatchObject({ code: one.row.code, formulationId: one.formulation.id, ingredients: ['Aqua', 'Glycerin', 'Cetearyl Alcohol'], skinTypes: ['dry', 'combination'], priceMin: 3000, whereSold: 'Pharmacies' })
        expect((await repo.liveRules()).version).toMatch(/^rules-contract-apply/)
      })

      it('stores key_ingredient and strength with the row, reads them back, changes them in place, and clears them to null', async () => {
        const { repo } = await make()
        const one = workbookProduct({ keyIngredient: 'Azelaic acid', strength: '10%' })
        const where = fresh('N')
        await repo.applyWorkbook(await planOf(repo, { countries: [country(where)], newProducts: [one.newProduct], products: [one.planned], availability: [sale(one.row.code, where)] }))
        expect(await stored(repo, one.row.code)).toMatchObject({ keyIngredient: 'Azelaic acid', strength: '10%' })

        await repo.applyWorkbook(await planOf(repo, { products: [{ ...one.planned, row: { ...one.row, keyIngredient: 'Niacinamide', strength: '4%' } }] }))
        expect(await stored(repo, one.row.code)).toMatchObject({ keyIngredient: 'Niacinamide', strength: '4%' })

        await repo.applyWorkbook(await planOf(repo, { products: [{ ...one.planned, row: { ...one.row, keyIngredient: null, strength: null } }] }))
        expect(await stored(repo, one.row.code)).toMatchObject({ keyIngredient: null, strength: null })
      })

      it('gives key_ingredient and strength on the row approvedFor returns, and null when the product has neither', async () => {
        const { repo } = await make()
        const [with_, without] = [workbookProduct({ keyIngredient: 'Azelaic acid', strength: '10%' }), workbookProduct({ keyIngredient: null, strength: null })]
        const where = fresh('N')
        await repo.applyWorkbook(
          await planOf(repo, { countries: [country(where)], newProducts: [with_.newProduct, without.newProduct], products: [with_.planned, without.planned], availability: [sale(with_.row.code, where), sale(without.row.code, where)] }),
        )

        const rows = await repo.approvedFor({ country: where, step: 'cleanse' })

        expect(rows.find((row) => row.code === with_.row.code)).toMatchObject({ keyIngredient: 'Azelaic acid', strength: '10%' })
        expect(rows.find((row) => row.code === without.row.code)).toMatchObject({ keyIngredient: null, strength: null })
      })

      it('applied twice from the same base version, the second is a lost race: it returns false and writes nothing, not its product, row, availability or version', async () => {
        const { repo } = await make()
        const [first, second] = [workbookProduct(), workbookProduct()]
        const where = fresh('N')
        const base = await repo.catalogVersion()
        const winner = await planOf(repo, { countries: [country(where)], newProducts: [first.newProduct], products: [first.planned], availability: [sale(first.row.code, where)] })
        const loser = await planOf(repo, { countries: [country(fresh('N'))], newProducts: [second.newProduct], products: [second.planned], availability: [sale(second.row.code, where)] })

        expect(await repo.applyWorkbook(winner)).toBe(true)
        const before = await repo.readWorkbook()
        expect(await repo.applyWorkbook(loser)).toBe(false)

        expect(await repo.readWorkbook()).toEqual(before)
        expect(await repo.catalogVersion()).toBe(base + 1)
        expect((await repo.matchProducts([second.identityKey])).size).toBe(0)
        expect(await stored(repo, second.row.code)).toBeUndefined()
        expect(await sold(repo, where)).toEqual([first.row.code])
      })

      it('rejects, and writes nothing, for a row whose product does not exist: a failure that is not a lost race is not hidden', async () => {
        const { repo } = await make()
        const orphan = workbookProduct()
        const base = await repo.catalogVersion()

        await expect(repo.applyWorkbook(await planOf(repo, { products: [orphan.planned] }))).rejects.toThrow()

        expect(await repo.catalogVersion()).toBe(base)
        expect(await stored(repo, orphan.row.code)).toBeUndefined()
      })

      it('updates a row in place and keeps the formulation it pins when the list is the same, and pins a new one when the list changes', async () => {
        const { repo } = await make()
        const one = workbookProduct()
        const where = fresh('N')
        await repo.applyWorkbook(await planOf(repo, { countries: [country(where)], newProducts: [one.newProduct], products: [one.planned], availability: [sale(one.row.code, where)] }))

        const sameList = { ...one.planned, row: { ...one.row, frequency: 'pm' as const }, formulation: { id: fresh('formulation'), ingredientsKey: one.formulation.ingredientsKey } }
        await repo.applyWorkbook(await planOf(repo, { products: [sameList] }))

        expect((await stored(repo, one.row.code))?.frequency).toBe('pm')
        expect((await repo.approvedFor({ country: where, step: 'cleanse' }))[0]?.formulationId).toBe(one.formulation.id)

        const newList = { ...one.planned, row: { ...one.row, ingredients: ['Aqua', 'Squalane'] }, formulation: { id: fresh('formulation'), ingredientsKey: 'aqua\nsqualane' } }
        await repo.applyWorkbook(await planOf(repo, { products: [newList] }))

        const [recommendation] = await repo.approvedFor({ country: where, step: 'cleanse' })
        expect(recommendation?.formulationId).toBe(newList.formulation.id)
        expect(recommendation?.ingredients).toEqual(['Aqua', 'Squalane'])
      })

      it('gives two rows of one product the one formulation when their lists are the same', async () => {
        const { repo } = await make()
        const one = workbookProduct()
        const other = workbookProduct({ ingredients: one.row.ingredients })
        const twin: PlannedProduct = { row: other.row, productKey: one.identityKey, formulation: other.formulation }
        const where = fresh('N')

        await repo.applyWorkbook(await planOf(repo, { countries: [country(where)], newProducts: [one.newProduct], products: [one.planned, twin], availability: [sale(one.row.code, where), sale(other.row.code, where)] }))

        const recommended = (await repo.approvedFor({ country: where, step: 'cleanse' })).filter((row) => [one.row.code, other.row.code].includes(row.code))
        expect(recommended).toHaveLength(2)
        expect(recommended[0]?.formulationId).toBe(recommended[1]?.formulationId)
        expect(recommended[0]?.productId).toBe(recommended[1]?.productId)
      })

      it('retires the rows it is told to, keeping them, with their cells, in the workbook', async () => {
        const { repo } = await make()
        const one = workbookProduct()
        const where = fresh('N')
        await repo.applyWorkbook(await planOf(repo, { countries: [country(where)], newProducts: [one.newProduct], products: [one.planned], availability: [sale(one.row.code, where)] }))
        expect(await sold(repo, where)).toEqual([one.row.code])

        await repo.applyWorkbook(await planOf(repo, { retiredProducts: [one.row.code], retiredCountries: [where], availability: [] }))

        expect(await stored(repo, one.row.code)).toEqual({ ...one.row, status: 'retired' })
        expect((await repo.countries()).find((row) => row.code === where)).toMatchObject({ status: 'retired' })
        expect(await sold(repo, where)).toEqual([])
      })

      it('leaves availability as it is for null, and replaces the whole table for a list, an empty one included', async () => {
        const { repo } = await make()
        const [one, other] = [workbookProduct(), workbookProduct()]
        const where = fresh('N')
        await repo.applyWorkbook(await planOf(repo, { countries: [country(where)], newProducts: [one.newProduct, other.newProduct], products: [one.planned, other.planned], availability: [sale(one.row.code, where)] }))

        await repo.applyWorkbook(await planOf(repo))
        expect(await sold(repo, where)).toEqual([one.row.code])

        await repo.applyWorkbook(await planOf(repo, { availability: [sale(other.row.code, where, { priceMin: 1, priceMax: 2, whereSold: null })] }))
        expect(await sold(repo, where)).toEqual([other.row.code])
        expect((await repo.readWorkbook()).workbook.availability).toEqual([sale(other.row.code, where, { priceMin: 1, priceMax: 2, whereSold: null })])

        await repo.applyWorkbook(await planOf(repo, { availability: [] }))
        expect((await repo.readWorkbook()).workbook.availability).toEqual([])
      })

      it('writes and retires ingredient rules by code, and reads them back with their days as dates', async () => {
        const { repo } = await make()
        const rule = ruleRow({ code: `ING-${runSalt}-${counter++}`, name: fresh('zzyzx'), aliases: [], helps: [], strengthLimit: null, auditedBy: null, auditedOn: null })
        const { approvedOn, ...rest } = rule

        // A rules version names one set of rules (the live rules are kept per isolate by it), so a change of the set comes with a new version.
        await repo.applyWorkbook(await planOf(repo, { rulesVersion: fresh('rules-contract-set'), ingredients: [{ ...rest, approvedOn: DAY, auditedOn: null }] }))
        expect((await repo.readWorkbook()).workbook.ingredients.find((row) => row.code === rule.code)).toEqual({ ...rest, approvedOn: DAY, auditedOn: null })
        expect(approvedOn).toBe('2030-06-15')
        expect((await repo.liveRules()).entries.map((entry) => entry.name)).toContain(rule.name)

        await repo.applyWorkbook(await planOf(repo, { rulesVersion: fresh('rules-contract-set'), retiredIngredients: [rule.code] }))
        expect((await repo.readWorkbook()).workbook.ingredients.find((row) => row.code === rule.code)?.status).toBe('retired')
        expect((await repo.liveRules()).entries.map((entry) => entry.name)).not.toContain(rule.name)
      })

      it('stores the group and clashes_with of a rule and reads them back, while the live rules stay exactly what the matcher reads', async () => {
        const { repo } = await make()
        const rule = ruleRow({ code: `ING-${runSalt}-${counter++}`, name: fresh('zzyzx'), aliases: [], helps: [], strengthLimit: null, auditedBy: null, auditedOn: null, group: 'retinoid', clashesWith: ['exfoliating-acid', 'benzoyl-peroxide'] })
        const { approvedOn, ...rest } = rule
        expect(approvedOn).toBe('2030-06-15')

        await repo.applyWorkbook(await planOf(repo, { rulesVersion: fresh('rules-contract-group'), ingredients: [{ ...rest, approvedOn: DAY, auditedOn: null }] }))

        expect((await repo.readWorkbook()).workbook.ingredients.find((row) => row.code === rule.code)).toMatchObject({ group: 'retinoid', clashesWith: ['exfoliating-acid', 'benzoyl-peroxide'] })
        expect((await repo.liveRules()).entries.find((entry) => entry.name === rule.name)).toEqual({ name: rule.name, aliases: [], kind: rule.kind, rule: rule.statement, source: null })
      })

      it('changes the group of a rule in place, and clears it, without adding a rule', async () => {
        const { repo } = await make()
        const rule = ruleRow({ code: `ING-${runSalt}-${counter++}`, name: fresh('zzyzx'), aliases: [], helps: [], strengthLimit: null, auditedBy: null, auditedOn: null, group: 'steroid' })
        const { approvedOn: _day, ...rest } = rule
        const version = fresh('rules-contract-regroup')
        await repo.applyWorkbook(await planOf(repo, { rulesVersion: version, ingredients: [{ ...rest, approvedOn: DAY, auditedOn: null }] }))
        const rowsBefore = (await repo.readWorkbook()).workbook.ingredients.length

        await repo.applyWorkbook(await planOf(repo, { rulesVersion: version, ingredients: [{ ...rest, group: 'lightening-agent', approvedOn: DAY, auditedOn: null }] }))
        expect((await repo.readWorkbook()).workbook.ingredients.find((row) => row.code === rule.code)?.group).toBe('lightening-agent')

        await repo.applyWorkbook(await planOf(repo, { rulesVersion: version, ingredients: [{ ...rest, group: null, approvedOn: DAY, auditedOn: null }] }))
        expect((await repo.readWorkbook()).workbook.ingredients.find((row) => row.code === rule.code)?.group).toBeNull()
        expect((await repo.readWorkbook()).workbook.ingredients).toHaveLength(rowsBefore)
      })

      describe('claim words and tapers', () => {
        const claimsOf = async (repo: CatalogWorkbookRepository, codes: string[]) => (await repo.readWorkbook()).workbook.claimWords.filter((row) => codes.includes(row.code))
        const tapersOf = async (repo: CatalogWorkbookRepository, codes: string[]) => (await repo.readWorkbook()).workbook.tapers.filter((row) => codes.includes(row.code))

        it('stores the claim words and tapers of a plan and reads them back whole, with their steps and their days as dates, and moves to the next version', async () => {
          const { repo } = await make()
          const claim = claimWordRow()
          const taper = taperRow({ auditedBy: 'Dr B. Auditor', auditedOn: DAY })
          const base = await repo.catalogVersion()

          expect(await repo.applyWorkbook(await planOf(repo, { claimWords: [claim], tapers: [taper] }))).toBe(true)

          expect(await repo.catalogVersion()).toBe(base + 1)
          expect(await claimsOf(repo, [claim.code])).toEqual([claim])
          expect(await tapersOf(repo, [taper.code])).toEqual([taper])
        })

        it('leaves them, and the rules version, alone when the plan names none: a plan that writes products does not touch claim words or tapers', async () => {
          const { repo } = await make()
          const [claim, taper] = [claimWordRow(), taperRow()]
          await repo.applyWorkbook(await planOf(repo, { claimWords: [claim], tapers: [taper] }))
          const one = workbookProduct()
          const version = (await repo.liveRules()).version

          await repo.applyWorkbook(await planOf(repo, { newProducts: [one.newProduct], products: [one.planned] }))

          expect(await claimsOf(repo, [claim.code])).toEqual([claim])
          expect(await tapersOf(repo, [taper.code])).toEqual([taper])
          expect((await repo.liveRules()).version).toBe(version)
        })

        it('updates a claim word and a taper by code, in place, without adding a second row', async () => {
          const { repo } = await make()
          const [claim, taper] = [claimWordRow(), taperRow()]
          await repo.applyWorkbook(await planOf(repo, { claimWords: [claim], tapers: [taper] }))
          const before = (await repo.readWorkbook()).workbook

          const longer = [{ fromWeek: 1, toWeek: 3, frequency: 'alternate-days' }, { fromWeek: 4, toWeek: 4, frequency: 'stop' }]
          await repo.applyWorkbook(await planOf(repo, { claimWords: [{ ...claim, phrase: `${claim.phrase} soap` }], tapers: [{ ...taper, schedule: longer }] }))

          const after = (await repo.readWorkbook()).workbook
          expect(after.claimWords).toHaveLength(before.claimWords.length)
          expect(after.tapers).toHaveLength(before.tapers.length)
          expect(await claimsOf(repo, [claim.code])).toEqual([{ ...claim, phrase: `${claim.phrase} soap` }])
          expect(await tapersOf(repo, [taper.code])).toEqual([{ ...taper, schedule: longer }])
        })

        it('retires the ones it is told to, keeping the rows and every cell but the status, and never deletes', async () => {
          const { repo } = await make()
          const [claim, taper, other] = [claimWordRow(), taperRow(), taperRow()]
          await repo.applyWorkbook(await planOf(repo, { claimWords: [claim], tapers: [taper, other] }))
          const before = (await repo.readWorkbook()).workbook

          await repo.applyWorkbook(await planOf(repo, { retiredClaimWords: [claim.code], retiredTapers: [taper.code] }))

          const after = (await repo.readWorkbook()).workbook
          expect(await claimsOf(repo, [claim.code])).toEqual([{ ...claim, status: 'retired' }])
          expect(await tapersOf(repo, [taper.code])).toEqual([{ ...taper, status: 'retired' }])
          expect(await tapersOf(repo, [other.code])).toEqual([other])
          expect(after.claimWords).toHaveLength(before.claimWords.length)
          expect(after.tapers).toHaveLength(before.tapers.length)
        })

        it('reads them in code order, retired ones included', async () => {
          const { repo } = await make()
          const [b, a] = [taperRow({ code: `TPR-${runSalt}-B`, status: 'retired' }), taperRow({ code: `TPR-${runSalt}-A` })]
          await repo.applyWorkbook(await planOf(repo, { tapers: [b, a] }))

          const { tapers } = (await repo.readWorkbook()).workbook

          expect(tapers.map((row) => row.code)).toEqual([...tapers.map((row) => row.code)].sort())
          expect(tapers.filter((row) => [a.code, b.code].includes(row.code))).toEqual([a, b])
        })

        it('writes none of them for a plan that lost the race', async () => {
          const { repo } = await make()
          const [first, second] = [claimWordRow(), claimWordRow()]
          const [taperOne, taperTwo] = [taperRow(), taperRow()]
          const winner = await planOf(repo, { claimWords: [first], tapers: [taperOne] })
          const loser = await planOf(repo, { claimWords: [second], tapers: [taperTwo] })

          expect(await repo.applyWorkbook(winner)).toBe(true)
          expect(await repo.applyWorkbook(loser)).toBe(false)

          expect(await claimsOf(repo, [second.code])).toEqual([])
          expect(await tapersOf(repo, [taperTwo.code])).toEqual([])
          expect(await claimsOf(repo, [first.code])).toEqual([first])
        })

        it('counts their statements in the batch: more rows to write, more statements', async () => {
          const { repo } = await make()
          const none = repo.statementCount(await planOf(repo))

          const withRows = repo.statementCount(await planOf(repo, { claimWords: [claimWordRow()], tapers: [taperRow()] }))
          const withRetire = repo.statementCount(await planOf(repo, { retiredClaimWords: ['CLM-GONE'], retiredTapers: ['TPR-GONE'] }))

          expect(withRows).toBeGreaterThan(none)
          expect(withRetire).toBeGreaterThan(none)
        })
      })

      describe('approvedFor', () => {
        const rows = async (repo: CatalogWorkbookRepository, where: string) => {
          const fixtures: Record<string, Fixture> = {
            approved: workbookProduct({ steps: ['cleanse'], skinTypes: ['all'] }),
            draft: workbookProduct({ status: 'draft', approvedBy: null, approvedOn: null, steps: ['cleanse'] }),
            retired: workbookProduct({ status: 'retired', steps: ['cleanse'] }),
            treat: workbookProduct({ steps: ['treat'] }),
            elsewhere: workbookProduct({ steps: ['cleanse'] }),
            noList: workbookProduct({ ingredients: [], steps: ['cleanse'] }),
          }
          const all = Object.values(fixtures)
          await repo.applyWorkbook(
            await planOf(repo, {
              countries: [country(where), country(`${where}-other`)],
              newProducts: all.map((fixture) => fixture.newProduct),
              products: all.map((fixture) => fixture.planned),
              availability: all.map((fixture) => sale(fixture.row.code, fixture === fixtures.elsewhere ? `${where}-other` : where)),
            }),
          )
          return fixtures
        }

        it('returns approved rows with a pinned formulation, sold in the country, for the step: not a draft, a retired row, another step, another country or a row with no list', async () => {
          const { repo } = await make()
          const where = fresh('N')
          const fixtures = await rows(repo, where)

          expect(await sold(repo, where, 'cleanse')).toEqual([fixtures.approved!.row.code])
          expect(await sold(repo, where, 'treat')).toEqual([fixtures.treat!.row.code])
          expect(await sold(repo, `${where}-other`, 'cleanse')).toEqual([fixtures.elsewhere!.row.code])
          expect(await sold(repo, where, 'protect')).toEqual([])
          expect(await sold(repo, fresh('NOWHERE'))).toEqual([])
        })

        it('gives skin types "all" as the string, and a list as an array', async () => {
          const { repo } = await make()
          const where = fresh('N')
          const fixtures = await rows(repo, where)

          const byCode = new Map((await repo.approvedFor({ country: where, step: 'cleanse' })).map((row) => [row.code, row]))
          expect(byCode.get(fixtures.approved!.row.code)?.skinTypes).toBe('all')
          expect((await repo.approvedFor({ country: where, step: 'treat' }))[0]?.skinTypes).toEqual(['dry', 'combination'])
        })

        // The links are context for the AI and the team, not for a screen. They are read here so a candidate can carry them; nothing returns them to the app.
        it('gives the evidence links, in the order written, and the ingredient list\'s source link, as they were uploaded', async () => {
          const { repo } = await make()
          const where = fresh('N')
          const one = workbookProduct({ steps: ['cleanse'], evidenceUrls: ['https://example.com/study-b', 'https://example.com/study-a'], ingredientsSourceUrl: 'https://example.com/the-label' })
          await repo.applyWorkbook(await planOf(repo, { countries: [country(where)], newProducts: [one.newProduct], products: [one.planned], availability: [sale(one.row.code, where)] }))

          const [recommendation] = await repo.approvedFor({ country: where, step: 'cleanse' })

          expect(recommendation).toMatchObject({ code: one.row.code, evidenceUrls: ['https://example.com/study-b', 'https://example.com/study-a'], ingredientsSourceUrl: 'https://example.com/the-label' })
        })

        it('gives a row with no evidence links an empty list, and a row with no source link for its ingredients a null, and still returns the row', async () => {
          const { repo } = await make()
          const where = fresh('N')
          const one = workbookProduct({ steps: ['cleanse'], evidenceUrls: [], ingredientsSourceUrl: null })
          await repo.applyWorkbook(await planOf(repo, { countries: [country(where)], newProducts: [one.newProduct], products: [one.planned], availability: [sale(one.row.code, where)] }))

          const [recommendation] = await repo.approvedFor({ country: where, step: 'cleanse' })

          expect(recommendation).toMatchObject({ code: one.row.code, evidenceUrls: [], ingredientsSourceUrl: null })
        })
      })

      it('reads every row in code order, retired and draft ones included, with lists, dates and draft cells as they were written', async () => {
        const { repo } = await make()
        const [b, a] = [workbookProduct({ status: 'draft', approvedBy: null, approvedOn: null, auditedBy: null, auditedOn: null, draftCells: [{ column: 'frequency', url: 'https://example.com/source' }] }), workbookProduct({ status: 'retired' })]
        await repo.applyWorkbook(await planOf(repo, { newProducts: [a.newProduct, b.newProduct], products: [b.planned, a.planned] }))

        const { products } = (await repo.readWorkbook()).workbook
        const mine = products.filter((row) => [a.row.code, b.row.code].includes(row.code))

        expect(mine).toEqual([a.row, b.row].sort((x, y) => (x.code < y.code ? -1 : 1)))
        expect(products.map((row) => row.code)).toEqual([...products.map((row) => row.code)].sort())
      })

      it('counts the statements of its one batch: a statement for each chunk of rows, with the version first', async () => {
        const { repo } = await make()
        const many = Array.from({ length: 7 }, () => workbookProduct())
        const where = fresh('N')

        const plan = await planOf(repo, {
          countries: [country(where)],
          newProducts: many.map((one) => one.newProduct),
          products: many.map((one) => one.planned),
          availability: many.map((one) => sale(one.row.code, where)),
          retiredProducts: ['PRD-GONE'],
        })

        // 1 version + 1 country + 1 products (8 a statement) + 1 formulations (12) + 3 rows (3 a statement) + 1 retire + 1 delete and 1 availability (15)
        expect(repo.statementCount(plan)).toBe(1 + 1 + 1 + 1 + 3 + 1 + 1 + 1)
        expect(await repo.applyWorkbook({ ...plan, retiredProducts: [] })).toBe(true)
      })

      it('reads the rules version of the catalog version it reads the rows at, with the catalog version', async () => {
        const { repo } = await make()
        const rulesVersion = fresh('rules-contract-read')
        await repo.applyWorkbook(await planOf(repo, { rulesVersion }))

        const read = await repo.readWorkbook()

        expect(read.rulesVersion).toBe(rulesVersion)
        expect(read.catalogVersion).toBe(await repo.catalogVersion())
      })

      describe('readVerdictReference', () => {
        /** A rule as a plan writes it: the days are dates. */
        const planned = (rule: RuleRow) => {
          const { approvedOn, ...rest } = rule
          return { ...rest, approvedOn: approvedOn === null ? null : DAY, auditedOn: null }
        }

        it('gives the rules, claim words and tapers of every status, with both versions, as one read of the catalog version they belong to', async () => {
          const { repo } = await make()
          const [approved, draft, retired] = [
            ruleRow({ code: `ING-${runSalt}-${counter++}`, name: fresh('zzyzx'), group: 'retinoid', clashesWith: ['exfoliating-acid'], helps: ['hd_texture'] }),
            ruleRow({ code: `ING-${runSalt}-${counter++}`, name: fresh('zzyzx'), status: 'draft', approvedBy: null, approvedOn: null }),
            ruleRow({ code: `ING-${runSalt}-${counter++}`, name: fresh('zzyzx') }),
          ]
          const [claim, oldClaim] = [claimWordRow(), claimWordRow()]
          const [taper, oldTaper] = [taperRow(), taperRow({ kind: 'lightening-agent' })]
          await repo.applyWorkbook(await planOf(repo, { rulesVersion: fresh('rules-contract-ref'), ingredients: [approved, draft, retired].map(planned), claimWords: [claim, oldClaim], tapers: [taper, oldTaper] }))
          const rulesVersion = fresh('rules-contract-ref')
          await repo.applyWorkbook(await planOf(repo, { rulesVersion, retiredIngredients: [retired.code], retiredClaimWords: [oldClaim.code], retiredTapers: [oldTaper.code] }))

          const reference = await repo.readVerdictReference()

          expect(reference.catalogVersion).toBe(await repo.catalogVersion())
          expect(reference.rulesVersion).toBe(rulesVersion)
          expect(reference.rulesVersion).toBe((await repo.liveRules()).version)
          const mine = <T extends { code: string }>(rows: T[], codes: string[]): T[] => rows.filter((row) => codes.includes(row.code))
          expect(mine(reference.rules, [approved.code, draft.code, retired.code]).map((row) => [row.code, row.status])).toEqual(
            [[approved.code, 'approved'], [draft.code, 'draft'], [retired.code, 'retired']].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
          )
          expect(reference.rules.find((row) => row.code === approved.code)).toMatchObject({ name: approved.name, group: 'retinoid', clashesWith: ['exfoliating-acid'], helps: ['hd_texture'], statement: approved.statement })
          expect(mine(reference.claimWords, [claim.code, oldClaim.code])).toEqual([claim, { ...oldClaim, status: 'retired' }].sort((a, b) => (a.code < b.code ? -1 : 1)))
          expect(mine(reference.tapers, [taper.code, oldTaper.code])).toEqual([taper, { ...oldTaper, status: 'retired' }].sort((a, b) => (a.code < b.code ? -1 : 1)))
        })

        it('gives exactly the rows the whole-workbook read gives for those three tabs, in the same order, and not the products, availability or countries', async () => {
          const { repo } = await make()
          const one = workbookProduct()
          await repo.applyWorkbook(await planOf(repo, { rulesVersion: fresh('rules-contract-ref'), ingredients: [planned(ruleRow({ code: `ING-${runSalt}-${counter++}`, name: fresh('zzyzx') }))], claimWords: [claimWordRow()], tapers: [taperRow()], newProducts: [one.newProduct], products: [one.planned] }))

          const reference = await repo.readVerdictReference()
          const { workbook } = await repo.readWorkbook()

          expect(reference.rules).toEqual(workbook.ingredients)
          expect(reference.claimWords).toEqual(workbook.claimWords)
          expect(reference.tapers).toEqual(workbook.tapers)
          expect(Object.keys(reference).sort()).toEqual(['catalogVersion', 'claimWords', 'rules', 'rulesVersion', 'tapers'])
        })
      })

      describe('tapersByCode', () => {
        it('gives the templates with the codes asked for, retired ones included, in code order, and leaves out a code that names none', async () => {
          const { repo } = await make()
          const [b, a, retired, other] = [taperRow({ code: `TPR-${runSalt}-B` }), taperRow({ code: `TPR-${runSalt}-A` }), taperRow({ status: 'retired' }), taperRow()]
          await repo.applyWorkbook(await planOf(repo, { tapers: [b, a, retired, other] }))

          const found = await repo.tapersByCode([b.code, a.code, retired.code, fresh('TPR-NONE')])

          expect(found).toEqual([a, b, retired].sort((x, y) => (x.code < y.code ? -1 : 1)))
        })

        it('answers for more codes than one query binds, and for none', async () => {
          const { repo } = await make()
          const one = taperRow()
          await repo.applyWorkbook(await planOf(repo, { tapers: [one] }))
          const codes = [...Array.from({ length: 250 }, (_, i) => `TPR-MISSING-${runSalt}-${i}`), one.code]

          expect((await repo.tapersByCode(codes)).map((row) => row.code)).toEqual([one.code])
          expect(await repo.tapersByCode([])).toEqual([])
        })
      })

      describe('stepsOf', () => {
        it('gives the steps of the approved rows of each product named, by the id of its catalog product, and leaves out a draft row, a retired row and a product nobody names', async () => {
          const { repo } = await make()
          const [approved, draft, retired, unasked] = [
            workbookProduct({ steps: ['cleanse', 'treat'] }),
            workbookProduct({ status: 'draft', approvedBy: null, approvedOn: null, steps: ['cleanse'] }),
            workbookProduct({ status: 'retired', steps: ['cleanse'] }),
            workbookProduct({ steps: ['protect'] }),
          ]
          const all = [approved, draft, retired, unasked]
          await repo.applyWorkbook(await planOf(repo, { newProducts: all.map((one) => one.newProduct), products: all.map((one) => one.planned) }))

          const found = await repo.stepsOf([approved, draft, retired].map((one) => one.newProduct.id).concat('product-nobody-has'))

          expect([...found]).toEqual([[approved.newProduct.id, ['cleanse', 'treat']]])
        })

        it('gives a step once when more than one approved row of a product fills it, and answers for none', async () => {
          const { repo } = await make()
          const first = workbookProduct({ steps: ['cleanse', 'treat'] })
          const second = workbookProduct({ steps: ['treat', 'protect'] })
          // The same catalog product under two codes.
          const same = { ...second.planned, productKey: first.identityKey }
          await repo.applyWorkbook(await planOf(repo, { newProducts: [first.newProduct], products: [first.planned, same] }))

          const found = await repo.stepsOf([first.newProduct.id])

          expect(new Set(found.get(first.newProduct.id))).toEqual(new Set(['cleanse', 'treat', 'protect']))
          expect(found.get(first.newProduct.id)).toHaveLength(3)
          expect((await repo.stepsOf([])).size).toBe(0)
        })
      })

      describe('skinConcernsOf', () => {
        it('gives the skin concerns of the approved rows of each product named, by the id of its catalog product, and leaves out a draft row, a retired row and a product nobody names', async () => {
          const { repo } = await make()
          const [approved, draft, retired, unasked] = [
            workbookProduct({ skinConcerns: ['hd_moisture', 'hd_redness'] }),
            workbookProduct({ status: 'draft', approvedBy: null, approvedOn: null, skinConcerns: ['hd_acne'] }),
            workbookProduct({ status: 'retired', skinConcerns: ['hd_acne'] }),
            workbookProduct({ skinConcerns: ['hd_pore'] }),
          ]
          const all = [approved, draft, retired, unasked]
          await repo.applyWorkbook(await planOf(repo, { newProducts: all.map((one) => one.newProduct), products: all.map((one) => one.planned) }))

          const found = await repo.skinConcernsOf([approved, draft, retired].map((one) => one.newProduct.id).concat('product-nobody-has'))

          // In the vocabulary's order (redness before moisture), not the order the row listed them in.
          expect([...found]).toEqual([[approved.newProduct.id, ['hd_redness', 'hd_moisture']]])
        })

        it('gives the union of the approved rows of one product, each concern once and in the vocabulary order, and ignores a draft row of the same product', async () => {
          const { repo } = await make()
          const first = workbookProduct({ skinConcerns: ['hd_redness', 'hd_acne'] })
          const second = workbookProduct({ skinConcerns: ['hd_moisture', 'hd_redness'] })
          const draft = workbookProduct({ status: 'draft', approvedBy: null, approvedOn: null, skinConcerns: ['hd_texture'] })
          // The same catalog product under three codes.
          const [sameSecond, sameDraft] = [{ ...second.planned, productKey: first.identityKey }, { ...draft.planned, productKey: first.identityKey }]
          await repo.applyWorkbook(await planOf(repo, { newProducts: [first.newProduct], products: [first.planned, sameSecond, sameDraft] }))

          const found = await repo.skinConcernsOf([first.newProduct.id])

          // The vocabulary order is acne, redness, moisture: not the order the rows list them in (redness, acne, moisture).
          expect(found.get(first.newProduct.id)).toEqual(['hd_acne', 'hd_redness', 'hd_moisture'])
        })

        it('answers for more products than one query binds, and for none', async () => {
          const { repo } = await make()
          const one = workbookProduct({ skinConcerns: ['hd_pore'] })
          await repo.applyWorkbook(await planOf(repo, { newProducts: [one.newProduct], products: [one.planned] }))
          const ids = [...Array.from({ length: 250 }, (_, i) => `product-missing-${runSalt}-${i}`), one.newProduct.id]

          expect([...(await repo.skinConcernsOf(ids))]).toEqual([[one.newProduct.id, ['hd_pore']]])
          expect((await repo.skinConcernsOf([])).size).toBe(0)
        })
      })

      describe('matchProducts', () => {
        it('maps each key to the identity key of the product it names, exactly, and leaves out a key that names none', async () => {
          const { repo } = await make()
          const one = workbookProduct()
          await repo.applyWorkbook(await planOf(repo, { newProducts: [one.newProduct], products: [one.planned] }))
          const nobody = fresh('nobody|key||')

          const found = await repo.matchProducts([one.identityKey, nobody])

          expect([...found]).toEqual([[one.identityKey, one.identityKey]])
        })

        it('finds a product by another spelling that was remembered for it, and gives the product\'s own identity key', async () => {
          const { repo, alias } = await make()
          const one = workbookProduct()
          await repo.applyWorkbook(await planOf(repo, { newProducts: [one.newProduct], products: [one.planned] }))
          const spelling = fresh('another|spelling||')
          await alias(spelling, one.identityKey)

          const found = await repo.matchProducts([spelling, one.identityKey])

          expect(found.get(spelling)).toBe(one.identityKey)
          expect(found.get(one.identityKey)).toBe(one.identityKey)
        })

        it('answers for more keys than one query binds, and for none', async () => {
          const { repo } = await make()
          const one = workbookProduct()
          await repo.applyWorkbook(await planOf(repo, { newProducts: [one.newProduct], products: [one.planned] }))
          const keys = [...Array.from({ length: 250 }, (_, i) => `missing|${runSalt}|${i}|`), one.identityKey]

          expect([...(await repo.matchProducts(keys)).keys()]).toEqual([one.identityKey])
          expect((await repo.matchProducts([])).size).toBe(0)
        })
      })
    })
  })
}
