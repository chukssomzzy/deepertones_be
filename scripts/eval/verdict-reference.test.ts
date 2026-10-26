import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryWorkbookArchive } from '../../src/providers/workbook-archive/memory.workbook-archive'
import { FakeCatalogWorkbookRepository } from '../../src/modules/catalog/catalog.workbook.repository.fake'
import { CONTRACT_VERSION, type RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import { CatalogWorkbookService } from '../../src/modules/catalog/catalog.workbook.service'
import { availability, claimWord, country, day, dayAsDate, ingredient, product, taper, validWorkbook } from '../catalog/workbook.fixture'
import { writeWorkbookFile } from '../catalog/xlsx'
import { caseOf, product as shelfProduct, noLabel } from './verdict.fixture'
import {
  checkCatalogEntries,
  DEFAULT_VERDICT_SNAPSHOT_PATH,
  loadVerdictReference,
  VerdictReferenceError,
  type CatalogProduct,
} from './verdict-reference'

// The verdict eval's catalog reference: the owner's curated workbook, kept local (the repo is public), read through the same reader `catalog:upload` uses and
// checked by the same contract. It gives the eval the reference the shelf verdict is built against (rules with their groups and clashes, claim phrases and the
// step-down templates) and the products of the workbook, so a case that copies a catalog product can be checked against it. The workbooks here are built in the
// test and written by the same writer the export uses; the owner's file is never read.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verdict-reference-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const DRAFT = 'PRD-DRAFT-SERUM'
const APPROVED = 'PRD-APPROVED-CLEANSER'
const RETIRED = 'PRD-RETIRED-GEL'

/** Three products (a draft, an approved one and a retired one), rules of every status, claim phrases and step-down templates in a mixed order. */
const workbook = (over: Partial<Record<keyof RawWorkbook, RawWorkbook['products']['rows']>> = {}): RawWorkbook =>
  validWorkbook({
    products: [
      product({ code: DRAFT, brand: 'Zenvi', name: 'Draft Serum', variant: 'Night', form: 'serum', status: 'draft', approved_by: null, approved_on: null, steps: 'treat', ingredients: 'Aqua; Glycerin; Niacinamide' }),
      product({ code: APPROVED, brand: 'Quillon', name: 'Approved Cleanser', variant: null, form: null, ingredients: 'Aqua; Glycerin; Cetearyl Alcohol' }),
      product({ code: RETIRED, brand: 'Orrin', name: 'Retired Gel', status: 'retired' }),
    ],
    availability: [availability({ product_code: DRAFT }), availability({ product_code: APPROVED }), availability({ product_code: RETIRED })],
    ingredients: [
      ingredient({ code: 'ING-B-RETINOL', name: 'retinol', aliases: 'vitamin a alcohol', kind: 'pregnancy-caution', group: 'retinoid', clashes_with: 'exfoliating-acid', helps: 'hd_texture', statement: 'Not for use in pregnancy.', source_url: 'https://rules.example/retinol' }),
      ingredient({ code: 'ING-A-GLYCOLIC', name: 'glycolic acid', aliases: null, kind: 'irritation', group: 'exfoliating-acid', clashes_with: 'retinoid', statement: 'Can sting.', source_url: null }),
      ingredient({ code: 'ING-C-PARFUM', name: 'parfum', aliases: 'fragrance', kind: 'allergen', status: 'draft', approved_by: null, approved_on: null, statement: 'A known trigger.', source_url: null }),
      ingredient({ code: 'ING-D-OLD', name: 'old rule', aliases: null, kind: 'irritation', status: 'retired', statement: 'Retired.', source_url: null }),
    ],
    claimWords: [
      claimWord({ code: 'CLM-B-BLEACHING', phrase: 'bleaching' }),
      claimWord({ code: 'CLM-A-WHITENING', phrase: 'whitening' }),
      claimWord({ code: 'CLM-C-OLD', phrase: 'toning', status: 'retired' }),
    ],
    tapers: [
      taper({ code: 'TPR-STEROID-1', kind: 'steroid', approved_on: day(-10) }),
      taper({ code: 'TPR-STEROID-2', kind: 'steroid', approved_on: day(-2) }),
      taper({ code: 'TPR-LIGHT-1', kind: 'lightening-agent', approved_on: day(-5) }),
    ],
    countries: [country()],
    ...over,
  })

const write = async (name: string, book: RawWorkbook = workbook()) => {
  const path = join(dir, name)
  await writeWorkbookFile(path, book, null)
  return path
}

describe('loadVerdictReference', () => {
  it('has the gitignored folder the owner copies the curated workbook into as its default path', () => {
    expect(DEFAULT_VERDICT_SNAPSHOT_PATH).toBe('eval-data/verdict/catalog-snapshot.xlsx')
  })

  it('pins the file by the sha256 of its bytes, the same on every load, and a different one for different content', async () => {
    const path = await write('one.xlsx')
    const expected = createHash('sha256').update(await readFile(path)).digest('hex')

    const first = await loadVerdictReference(path)
    const second = await loadVerdictReference(path)
    const other = await loadVerdictReference(await write('other.xlsx', workbook({ countries: [country({ low_max: 5001 })] })))

    expect(first.sha256).toBe(expected)
    expect(second.sha256).toBe(expected)
    expect(other.sha256).not.toBe(first.sha256)
  })

  describe('the products', () => {
    it('gives each product of the workbook by its code, with the facts a case copies: brand, name, variant, form, category and ingredients', async () => {
      const { products } = await loadVerdictReference(await write('snapshot.xlsx'))

      expect(products.get(DRAFT)).toEqual({ brand: 'Zenvi', name: 'Draft Serum', variant: 'Night', form: 'serum', category: 'skin', ingredients: ['Aqua', 'Glycerin', 'Niacinamide'] })
      expect(products.get(APPROVED)).toEqual({ brand: 'Quillon', name: 'Approved Cleanser', variant: null, form: null, category: 'skin', ingredients: ['Aqua', 'Glycerin', 'Cetearyl Alcohol'] })
    })

    it('includes a draft product as well as an approved one, because the curated rows are all drafts', async () => {
      const { products } = await loadVerdictReference(await write('snapshot.xlsx'))

      expect([...products.keys()]).toEqual(expect.arrayContaining([DRAFT, APPROVED]))
    })
  })

  describe('the rules', () => {
    it('gives the rules in code order, not in the order the rows are written, in the shape the floor reads', async () => {
      const { reference } = await loadVerdictReference(await write('snapshot.xlsx'))

      // ING-A-GLYCOLIC, ING-B-RETINOL, then the draft ING-C-PARFUM; the Ingredients tab lists the retinol row first.
      expect(reference.rules.map((r) => r.name)).toEqual(['glycolic acid', 'retinol', 'parfum'])
      expect(reference.rules.find((r) => r.name === 'retinol')).toEqual({
        name: 'retinol',
        aliases: ['vitamin a alcohol'],
        kind: 'pregnancy-caution',
        rule: 'Not for use in pregnancy.',
        source: 'https://rules.example/retinol',
        group: 'retinoid',
        clashesWith: ['exfoliating-acid'],
        helps: ['hd_texture'],
      })
      expect(reference.rules.find((r) => r.name === 'glycolic acid')).toMatchObject({ group: 'exfoliating-acid', clashesWith: ['retinoid'], helps: [], source: null })
    })

    it('counts a draft rule as approved, as the routine eval does, and leaves a retired one out', async () => {
      const { reference } = await loadVerdictReference(await write('snapshot.xlsx'))

      expect(reference.rules.map((r) => r.name)).toContain('parfum')
      expect(reference.rules.map((r) => r.name)).not.toContain('old rule')
    })
  })

  describe('the claim phrases', () => {
    it('gives the approved phrases in code order, and never a retired one', async () => {
      const { reference } = await loadVerdictReference(await write('snapshot.xlsx'))

      expect(reference.claimPhrases).toEqual(['whitening', 'bleaching'])
    })
  })

  describe('the step-down templates', () => {
    it('names the approved template of each kind, the most recently approved when a kind has more than one', async () => {
      const { reference } = await loadVerdictReference(await write('snapshot.xlsx'))

      expect(reference.tapers).toEqual({ steroid: 'TPR-STEROID-2', 'lightening-agent': 'TPR-LIGHT-1' })
    })

    it.each([
      ['steroid', 'lightening-agent'],
      ['lightening-agent', 'steroid'],
    ] as const)('refuses a workbook with no %s template, naming that kind and not the other', async (missing, present) => {
      const kept = taper({ code: 'TPR-KEPT', kind: present })
      const path = await write('snapshot.xlsx', workbook({ tapers: [kept] }))

      const error = await loadVerdictReference(path).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(VerdictReferenceError)
      expect((error as Error).message).toContain(missing)
      expect((error as Error).message).not.toContain(present)
    })

    it('names both kinds when both are missing', async () => {
      const error = await loadVerdictReference(await write('snapshot.xlsx', workbook({ tapers: [] }))).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(VerdictReferenceError)
      expect((error as Error).message).toContain('steroid')
      expect((error as Error).message).toContain('lightening-agent')
    })

    it('does not count a draft or a retired template: a step-down is approved by a qualified person', async () => {
      const path = await write(
        'snapshot.xlsx',
        workbook({
          tapers: [
            taper({ code: 'TPR-STEROID-D', kind: 'steroid', status: 'draft', approved_by: null, approved_on: null }),
            taper({ code: 'TPR-LIGHT-R', kind: 'lightening-agent', status: 'retired' }),
          ],
        }),
      )

      const error = await loadVerdictReference(path).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(VerdictReferenceError)
      expect((error as Error).message).toContain('steroid')
      expect((error as Error).message).toContain('lightening-agent')
    })
  })

  describe('a file that cannot be used', () => {
    it('is refused with a clear message that says where to copy the curated workbook when the file is missing', async () => {
      const error = await loadVerdictReference(join(dir, 'missing.xlsx')).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(VerdictReferenceError)
      expect((error as Error).message).toContain('eval-data/verdict/catalog-snapshot.xlsx')
      expect((error as Error).message).toMatch(/copy/i)
    })

    it('is refused when the workbook breaks the contract, naming the tab, row, column and rule and never the cell\'s value', async () => {
      const path = await write('bad.xlsx', workbook({ products: [product({ code: DRAFT, category: 'SENTINEL-CELL-VALUE' })], availability: [availability({ product_code: DRAFT })] }))

      const error = await loadVerdictReference(path).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(VerdictReferenceError)
      const message = (error as Error).message
      expect(message).toContain('NOT_IN_VOCABULARY')
      expect(message).toContain('category')
      expect(message).toMatch(/\b2\b/)
      expect(message).not.toContain('SENTINEL-CELL-VALUE')
    })
  })
})

// --- the eval's reference is the live service's reference -----------------------------------------------------------------------------------------------

// The rules, claim phrases and step-down templates the eval judges a shelf by must be what production judges it by, or the eval measures a different floor.
// So the same workbook is imported into the live service (over its fake repository) and written to a file for the eval, and the two are compared. Every row
// added here is approved, since the service reads only approved rows: counting drafts is the eval's own policy and is pinned above, not here.

const FILE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1])

describe('the reference the eval builds from a workbook', () => {
  it('equals what CatalogWorkbookService.verdictReference gives for the same workbook: rules, claim phrases and step-down templates', async () => {
    const repository = new FakeCatalogWorkbookRepository()
    const service = new CatalogWorkbookService({ repository, archive: new MemoryWorkbookArchive({ environment: 'test' }), now: () => dayAsDate(0), newId: () => 'id', environment: 'test' })
    const live = await service.exportWorkbook()
    // Written out of code order on purpose: the service reads them from its repository in code order, so the eval must put them in that order itself.
    live.workbook.ingredients.rows.push(
      ingredient({ code: 'ING-ZZ-RETINOL', name: 'zzyzx retinoidum', aliases: 'zzyzx a; zzyzx vit a', kind: 'pregnancy-caution', group: 'retinoid', clashes_with: 'exfoliating-acid', helps: 'hd_texture; hd_age_spot', statement: 'Avoid in pregnancy.', source_url: 'https://rules.example/zz-retinoid' }),
      ingredient({ code: 'ING-ZZ-ACID', name: 'zzyzx acidum', aliases: null, kind: 'irritation', group: 'exfoliating-acid', clashes_with: 'retinoid', statement: 'Can sting.', source_url: null }),
      ingredient({ code: 'ING-ZZ-GREY', name: 'zzyzx neutralum', aliases: null, kind: 'drying', statement: 'Can dry the skin.', source_url: null }),
    )
    live.workbook.claimWords.rows.push(claimWord({ code: 'CLM-ZZ-B', phrase: 'bleaching' }), claimWord({ code: 'CLM-ZZ-A', phrase: 'whitening' }))
    live.workbook.tapers.rows.push(
      taper({ code: 'TPR-ZZ-STEROID-OLD', kind: 'steroid', approved_on: day(-20) }),
      taper({ code: 'TPR-ZZ-STEROID-NEW', kind: 'steroid', approved_on: day(-2) }),
      taper({ code: 'TPR-ZZ-LIGHT-B', kind: 'lightening-agent', approved_on: day(-5) }),
      taper({ code: 'TPR-ZZ-LIGHT-A', kind: 'lightening-agent', approved_on: day(-5) }),
    )
    const result = await service.importWorkbook({ workbook: live.workbook, baseVersion: live.catalogVersion, file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
    expect(result.applied).toBe(true)
    const path = join(dir, 'parity.xlsx')
    await writeWorkbookFile(path, live.workbook, null)

    const fromService = await service.verdictReference()
    const { reference } = await loadVerdictReference(path)

    expect(fromService.rules.length).toBeGreaterThan(3)
    expect(reference.rules).toEqual(fromService.rules)
    expect(reference.claimPhrases).toEqual(fromService.claimPhrases)
    expect(reference.claimPhrases).toEqual(['whitening', 'bleaching'])
    expect(reference.tapers).toEqual(fromService.tapers)
    expect(reference.tapers).toEqual({ steroid: 'TPR-ZZ-STEROID-NEW', 'lightening-agent': 'TPR-ZZ-LIGHT-A' })
  })
})

// --- cases that copy a catalog product -----------------------------------------------------------------------------------------------------------------

// A case entry with `source: { catalogCode }` stands for a product of the workbook, and the verdict is only meaningful if its ingredient list is the workbook's, word
// for word and in the same order (the floor matches on it, and so does the fit judge). The check is $0 and runs before any model is paid for.

describe('checkCatalogEntries', () => {
  const SERUM: CatalogProduct = { brand: 'Zenvi', name: 'Draft Serum', variant: 'Night', form: 'serum', category: 'skin', ingredients: ['Aqua', 'Glycerin', 'Niacinamide'] }
  const CLEANSER: CatalogProduct = { brand: 'Quillon', name: 'Approved Cleanser', variant: null, form: null, category: 'skin', ingredients: ['Aqua', 'Glycerin', 'Cetearyl Alcohol'] }
  const products = new Map<string, CatalogProduct>([
    [DRAFT, SERUM],
    [APPROVED, CLEANSER],
  ])
  const copy = (id: string, code: string, ingredients: string[]) => shelfProduct(id, { brand: 'Whatever', name: 'Whatever', ingredients, source: { catalogCode: code } })

  it('reports nothing when every catalog entry has the snapshot\'s ingredients exactly', () => {
    const cases = [caseOf('main-01', { shelf: [copy('a', DRAFT, [...SERUM.ingredients]), copy('b', APPROVED, [...CLEANSER.ingredients])] })]

    expect(checkCatalogEntries(cases, products)).toEqual([])
  })

  it.each([
    ['an ingredient left out', ['Aqua', 'Glycerin']],
    ['an ingredient added', ['Aqua', 'Glycerin', 'Niacinamide', 'Parfum']],
    ['the same ingredients in another order', ['Glycerin', 'Aqua', 'Niacinamide']],
    ['an ingredient in other capitals', ['Aqua', 'glycerin', 'Niacinamide']],
    ['an ingredient with other spacing', ['Aqua', 'Glycerin ', 'Niacinamide']],
    ['an empty list', []],
  ])('reports an entry whose ingredients differ by %s', (_label, ingredients) => {
    const cases = [caseOf('main-01', { shelf: [copy('a', DRAFT, ingredients)] })]

    expect(checkCatalogEntries(cases, products)).toEqual([{ caseId: 'main-01', entryId: 'a', code: DRAFT, problem: 'ingredients-differ' }])
  })

  it('reports an entry whose code is not in the snapshot', () => {
    const cases = [caseOf('main-01', { shelf: [copy('a', 'PRD-GONE', ['Aqua'])] })]

    expect(checkCatalogEntries(cases, products)).toEqual([{ caseId: 'main-01', entryId: 'a', code: 'PRD-GONE', problem: 'not-in-snapshot' }])
  })

  it('reports every entry that differs, across cases, in case order and then shelf order, and leaves the ones that match out', () => {
    const cases = [
      caseOf('main-01', { shelf: [copy('a', DRAFT, ['Aqua']), copy('b', APPROVED, [...CLEANSER.ingredients]), copy('c', APPROVED, ['Aqua'])] }),
      caseOf('main-02', { shelf: [copy('a', DRAFT, [...SERUM.ingredients])] }),
      caseOf('hold-01', { shelf: [copy('x', 'PRD-GONE', ['Aqua'])] }),
    ]

    expect(checkCatalogEntries(cases, products).map((m) => `${m.caseId}/${m.entryId}`)).toEqual(['main-01/a', 'main-01/c', 'hold-01/x'])
  })

  it('never checks an entry that is made up or has no label: they have no snapshot row to differ from', () => {
    const cases = [caseOf('main-01', { shelf: [shelfProduct('a', { brand: 'Zenvi', name: 'Draft Serum', ingredients: ['Nothing', 'Like', 'The Snapshot'] }), noLabel('b', 'lighten')] })]

    expect(checkCatalogEntries(cases, products)).toEqual([])
  })

  it('does not change the cases or the products it was given', () => {
    const cases = [caseOf('main-01', { shelf: [copy('a', DRAFT, ['Aqua'])] })]
    const before = structuredClone(cases)

    checkCatalogEntries(cases, products)

    expect(cases).toEqual(before)
    expect(products.get(DRAFT)).toEqual(SERUM)
  })
})
