import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import { availability, country, ingredient, product, validWorkbook } from '../catalog/workbook.fixture'
import { writeWorkbookFile } from '../catalog/xlsx'
import { catalogFor, DEFAULT_SNAPSHOT_PATH, loadSnapshot, SnapshotError } from './routine-snapshot'

// The routine eval's catalog snapshot: the owner's curated workbook, kept local (the repo is public), read through the same reader `catalog:upload` uses and
// checked by the same contract. Inside the eval only, every row that is not retired counts as approved, drafts included, because the curated rows are all drafts.
// The workbook here is built in the test and written by the same writer the export uses; the owner's file is never read.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routine-snapshot-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const DRAFT = 'PRD-DRAFT-CREAM'
const APPROVED = 'PRD-CERAVE-CLEANSER'
const RETIRED = 'PRD-OLD-GEL'

/** Three products: a draft cream sold in NG and GB at different prices, an approved cleanser sold in NG, and a retired gel that is still listed as sold in NG. */
const workbook = (over: Partial<Record<keyof RawWorkbook, RawWorkbook['products']['rows']>> = {}): RawWorkbook =>
  validWorkbook({
    products: [
      product({
        code: DRAFT,
        brand: 'DraftCo',
        name: 'Draft Cream',
        form: 'cream',
        status: 'draft',
        approved_by: null,
        approved_on: null,
        steps: 'moisturise',
        skin_concerns: 'hd_radiance; hd_moisture',
        skin_types: 'dry; combination',
        frequency: 'am-pm',
        ingredients: 'Aqua; Glycerin',
        ingredients_source_url: 'https://brand.example/draft-cream-ingredients',
        evidence_urls: 'https://evidence.example/a; https://evidence.example/b',
        own_cautions: 'drying',
        origin: 'brand-submitted',
      }),
      product({ skin_types: 'all' }),
      product({ code: RETIRED, brand: 'OldCo', name: 'Old Gel', status: 'retired', steps: 'cleanse' }),
    ],
    availability: [
      availability({ product_code: DRAFT, country: 'NG', price_min: 4000, price_max: 6500, where_sold: 'Pharmacies' }),
      availability({ product_code: DRAFT, country: 'GB', price_min: 10, price_max: 25, where_sold: 'Online' }),
      availability(),
      availability({ product_code: RETIRED }),
    ],
    ingredients: [
      ingredient(),
      ingredient({ code: 'ING-PARFUM-ALLERGEN', name: 'parfum', aliases: 'fragrance', kind: 'allergen', status: 'draft', approved_by: null, approved_on: null, source_url: 'https://rules.example/parfum', statement: 'A known trigger of allergic reactions.' }),
      ingredient({ code: 'ING-OLD-RULE', name: 'old rule', aliases: null, status: 'retired' }),
    ],
    countries: [country(), country({ code: 'GB', currency: 'GBP', low_max: 15, mid_max: 40 })],
    ...over,
  })

const write = async (name: string, book: RawWorkbook = workbook()) => {
  const path = join(dir, name)
  await writeWorkbookFile(path, book, null)
  return path
}

describe('loadSnapshot', () => {
  it('offers a draft row and an approved one, and never a retired one', async () => {
    const snapshot = await loadSnapshot(await write('snapshot.xlsx'))

    const offered = snapshot.offers.map((o) => `${o.country}:${o.row.code}`).sort()
    expect(offered).toEqual([`GB:${DRAFT}`, `NG:${APPROVED}`, `NG:${DRAFT}`])
  })

  it('makes one offer per availability row, each with that country\'s price and place, and a synthetic product and formulation id', async () => {
    const snapshot = await loadSnapshot(await write('snapshot.xlsx'))

    const ng = snapshot.offers.find((o) => o.country === 'NG' && o.row.code === DRAFT)!
    const gb = snapshot.offers.find((o) => o.country === 'GB' && o.row.code === DRAFT)!
    expect(ng.row).toEqual({
      code: DRAFT,
      productId: `snap-${DRAFT}`,
      formulationId: `snap-f-${DRAFT}`,
      ingredients: ['Aqua', 'Glycerin'],
      skinConcerns: ['hd_radiance', 'hd_moisture'],
      skinTypes: ['dry', 'combination'],
      steps: ['moisturise'],
      frequency: 'am-pm',
      ownCautions: ['drying'],
      evidenceUrls: ['https://evidence.example/a', 'https://evidence.example/b'],
      ingredientsSourceUrl: 'https://brand.example/draft-cream-ingredients',
      origin: 'brand-submitted',
      priceMin: 4000,
      priceMax: 6500,
      whereSold: 'Pharmacies',
    })
    expect(gb.row).toMatchObject({ code: DRAFT, productId: `snap-${DRAFT}`, formulationId: `snap-f-${DRAFT}`, priceMin: 10, priceMax: 25, whereSold: 'Online' })
  })

  it('reads a row for all skin types as "all", as the live catalog does', async () => {
    const snapshot = await loadSnapshot(await write('snapshot.xlsx'))

    expect(snapshot.offers.find((o) => o.row.code === APPROVED)!.row.skinTypes).toBe('all')
  })

  it('gives each offer the product facts a candidate shows: brand, name and form', async () => {
    const snapshot = await loadSnapshot(await write('snapshot.xlsx'))

    const draft = snapshot.offers.find((o) => o.row.code === DRAFT)!
    expect(draft.summary).toMatchObject({ id: `snap-${DRAFT}`, brand: 'DraftCo', name: 'Draft Cream', variant: null, form: 'cream', category: 'skin' })
  })

  it('reads the Countries tab, in the order it is written', async () => {
    const snapshot = await loadSnapshot(await write('snapshot.xlsx'))

    expect(snapshot.countries).toEqual([
      { code: 'NG', currency: 'NGN', lowMax: 5000, midMax: 15000, status: 'active' },
      { code: 'GB', currency: 'GBP', lowMax: 15, midMax: 40, status: 'active' },
    ])
  })

  it('reads the Ingredients tab as rules in the shape the live rules have, draft rules included and retired ones left out', async () => {
    const snapshot = await loadSnapshot(await write('snapshot.xlsx'))

    // In code order (ING-PARFUM-ALLERGEN before ING-RETINOL-SUN-SENSITIVITY), as the live rules are, not in the order the rows are written.
    expect(snapshot.rules).toEqual([
      { name: 'parfum', aliases: ['fragrance'], kind: 'allergen', rule: 'A known trigger of allergic reactions.', source: 'https://rules.example/parfum' },
      {
        name: 'retinol',
        aliases: ['vitamin a alcohol'],
        kind: 'sun-sensitivity',
        rule: 'Can make skin burn more easily in the sun, so sunscreen matters while using it.',
        source: null,
      },
    ])
  })

  it('pins the file by the sha256 of its bytes, the same on every load', async () => {
    const path = await write('snapshot.xlsx')
    const expected = createHash('sha256').update(await readFile(path)).digest('hex')

    const first = await loadSnapshot(path)
    const second = await loadSnapshot(path)

    expect(first.sha256).toBe(expected)
    expect(second.sha256).toBe(expected)
  })

  it('gives a different sha256 to a file with different content', async () => {
    const one = await loadSnapshot(await write('one.xlsx'))
    const other = await loadSnapshot(await write('other.xlsx', workbook({ countries: [country(), country({ code: 'GB', currency: 'GBP', low_max: 16, mid_max: 40 })] })))

    expect(other.sha256).not.toBe(one.sha256)
  })

  it('fails with a clear message that says where to copy the curated workbook when the file is missing', async () => {
    const error = await loadSnapshot(join(dir, 'missing.xlsx')).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SnapshotError)
    expect((error as Error).message).toContain('eval-data/routine/catalog-snapshot.xlsx')
    expect((error as Error).message).toMatch(/copy/i)
  })

  it('fails when the workbook breaks the contract, naming the tab, row, column and rule and never the cell\'s value', async () => {
    const path = await write('bad.xlsx', workbook({ products: [product({ category: 'SENTINEL-CELL-VALUE' })] }))

    const error = await loadSnapshot(path).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SnapshotError)
    const message = (error as Error).message
    expect(message).toContain('NOT_IN_VOCABULARY')
    expect(message).toContain('category')
    expect(message).toMatch(/\b2\b/)
    expect(message).not.toContain('SENTINEL-CELL-VALUE')
  })
})

describe('DEFAULT_SNAPSHOT_PATH', () => {
  it('is the gitignored folder the owner copies the curated workbook into', () => {
    expect(DEFAULT_SNAPSHOT_PATH).toBe('eval-data/routine/catalog-snapshot.xlsx')
  })
})

describe('catalogFor', () => {
  it('seeds a FakeCatalogWorkbook that answers like the live catalog: only rows sold in the country that fill the step', async () => {
    const catalog = catalogFor(await loadSnapshot(await write('snapshot.xlsx')))

    expect((await catalog.approvedFor({ country: 'NG', step: 'moisturise' })).map((r) => r.code)).toEqual([DRAFT])
    expect((await catalog.approvedFor({ country: 'NG', step: 'cleanse' })).map((r) => r.code)).toEqual([APPROVED])
    expect(await catalog.approvedFor({ country: 'GB', step: 'cleanse' })).toEqual([])
    expect((await catalog.approvedFor({ country: 'GB', step: 'moisturise' })).map((r) => [r.code, r.priceMin])).toEqual([[DRAFT, 10]])
  })

  it('serves the snapshot\'s countries and rules', async () => {
    const snapshot = await loadSnapshot(await write('snapshot.xlsx'))
    const catalog = catalogFor(snapshot)

    expect((await catalog.countries()).map((c) => c.code)).toEqual(['NG', 'GB'])
    expect((await catalog.liveRules()).entries).toEqual(snapshot.rules)
  })
})
