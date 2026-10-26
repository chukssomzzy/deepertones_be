import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContainer } from '../../src/container'
import { createDb } from '../../src/lib/db'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { D1CatalogWorkbookRepository } from '../../src/modules/catalog/catalog.workbook.repository'
import { FakeOpsAlertsRepository } from '../../src/modules/ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'
import {
  BRITAIN,
  EMPTY_DIFF,
  NIGERIA,
  ORIGIN,
  applied,
  availabilityRow,
  dataOf,
  diffOf,
  exportLive,
  fetchWorker,
  freshIp,
  guestToken,
  liveRules,
  productRow,
  rowWith,
  sorted,
  upload,
  withCountry,
  without,
  word,
  xlsxBytes,
  type ImportResult,
} from './admin.catalog.support'

// A recommended product is also a catalog product (spec #115, decision 9): an approved or draft Products row finds its product by EXACT identity key,
// then by alias, else creates it, and the workbook's ingredient list is stored as a formulation of source 'workbook' that the row pins. There is no
// near-miss search and no model call. The tests drive that through the upload, then look from where users look: product search, a scan's resolve,
// the formulation itself, and the service the recommendation module will call (approvedFor, countries). The catalog service here is built as the
// scan path builds it, over the same real local D1.

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
  opsAlerts: new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: new MemoryJobQueue(), email: new MemoryEmailSender(), recipient: '', environment: 'test' }),
})
const workbookService = () => buildContainer(env).catalogWorkbook

// An import never asks a model or a web page anything. The Worker under test builds its own Anthropic client, so the one place to see that is the
// network: every outbound request is recorded and refused, and no test here may have made one.
const outbound: string[] = []
beforeEach(() => {
  vi.stubGlobal('fetch', async (input: unknown) => {
    outbound.push(String(input instanceof Request ? input.url : input))
    throw new Error('no outbound request is expected from an import')
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  const made = outbound.splice(0)
  expect(made, 'outbound requests made during the test').toEqual([])
})

type Hit = { id: string; brand: string; name: string; variant: string | null; form: string | null; category: string; imageUrl: string | null }
const search = async (token: string, q: string): Promise<Hit[]> => {
  const res = await fetchWorker(`${ORIGIN}/api/v1/products/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}`, 'cf-connecting-ip': freshIp() } })
  return (await dataOf<{ products: Hit[] }>(res)).products
}

/** A product as a scan makes it: resolved by name, with a list read from a back label. */
const scanned = async (brand: string, name: string, ingredients: string[], over: { variant?: string } = {}) => {
  const { productId } = await catalog.resolve({ brand, name, category: 'skin', ...over })
  const formulationId = await catalog.addLabelIngredients(productId, ingredients)
  return { productId, formulationId }
}

const approvedFor = async (country: string, step: 'cleanse' | 'treat' | 'moisturise' | 'protect') => workbookService().approvedFor({ country, step })

const LIST = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']

describe('a product row with an identity the catalog has not seen', () => {
  it('becomes a catalog product: found by search, found again by a scan of the same label, and holding the workbook\'s list as a workbook formulation the row pins', async () => {
    const token = await guestToken()
    const product = productRow({ name: 'Barrier Repair Cream' })
    const { data } = await applied((workbook) => {
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push({ ...product })
      workbook.availability.rows.push(availabilityRow(product.code as string))
    })

    const [rec] = (await approvedFor('NG', 'cleanse')).filter((r) => r.code === product.code)
    expect(rec).toBeDefined()
    expect(data.diff.newProducts).toEqual([{ code: product.code, brand: product.brand, name: 'Barrier Repair Cream', variant: null, form: null }])
    // Search lists it, as the product it is.
    expect(await search(token, `${product.brand} barrier`)).toEqual([{ id: rec!.productId, brand: product.brand, name: 'Barrier Repair Cream', variant: null, form: null, category: 'skin', imageUrl: null }])
    // A scan of the same label finds the same product, and the list it will analyse is the workbook's.
    expect(await catalog.resolve({ brand: product.brand as string, name: 'Barrier Repair Cream', category: 'skin' })).toEqual({ kind: 'needs-analysis', productId: rec!.productId, formulationId: rec!.formulationId })
    // The formulation is the workbook's, whole and in order, and nothing analysed it: no model was asked.
    expect(await repository.findFormulation(rec!.formulationId)).toMatchObject({ productId: rec!.productId, sourceKind: 'workbook', ingredients: LIST, analysisVersion: null, referenceVersion: null, analysedAt: null })
  })

  it('takes brand, name, variant and form as one identity: a scan with the same four finds the product', async () => {
    const product = productRow({ name: 'Glow Serum', variant: 'Night', form: 'serum' })
    await applied((workbook) => {
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push({ ...product })
      workbook.availability.rows.push(availabilityRow(product.code as string))
    })
    const [rec] = (await approvedFor('NG', 'cleanse')).filter((r) => r.code === product.code)

    const found = await catalog.resolve({ brand: product.brand as string, name: 'Glow Serum', variant: 'Night', form: 'serum', category: 'skin' })

    expect(found).toMatchObject({ productId: rec!.productId, formulationId: rec!.formulationId })
  })

  it('joins a draft row as well, and lists it in the diff, though a draft is never recommended', async () => {
    const token = await guestToken()
    const draft = productRow({ status: 'draft', approved_by: null, approved_on: null })

    const { data } = await applied((workbook) => {
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push({ ...draft })
      workbook.availability.rows.push(availabilityRow(draft.code as string))
    })

    expect(data.diff.newProducts).toEqual([expect.objectContaining({ code: draft.code })])
    expect(await search(token, draft.brand as string)).toHaveLength(1)
    expect((await approvedFor('NG', 'cleanse')).map((r) => r.code)).not.toContain(draft.code)
  })

  it('is new only once: uploading the same row again finds the product it made, adds none, and lists no new product', async () => {
    const token = await guestToken()
    const product = productRow()
    await applied((workbook) => {
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push({ ...product })
      workbook.availability.rows.push(availabilityRow(product.code as string))
    })
    const [first] = (await approvedFor('NG', 'cleanse')).filter((r) => r.code === product.code)

    const { data } = await applied((workbook) => {
      rowWith(workbook.products, 'code', product.code)!.frequency = 'am'
    })

    expect(data.diff.newProducts).toEqual([])
    expect(await search(token, product.brand as string)).toHaveLength(1)
    const [again] = (await approvedFor('NG', 'cleanse')).filter((r) => r.code === product.code)
    expect(again).toMatchObject({ productId: first!.productId, formulationId: first!.formulationId })
  })

  it('is shown in a dry run as a new product, and a dry run makes no product', async () => {
    const token = await guestToken()
    const product = productRow()

    const { res } = await upload(
      (workbook) => {
        withCountry(workbook, NIGERIA)
        workbook.products.rows.push({ ...product })
        workbook.availability.rows.push(availabilityRow(product.code as string))
      },
      { dryRun: true },
    )

    expect((await dataOf<ImportResult>(res)).diff.newProducts).toEqual([expect.objectContaining({ code: product.code, brand: product.brand })])
    expect(await search(token, product.brand as string)).toEqual([])
  })
})

describe('a product row whose identity the catalog already holds', () => {
  it('reuses that product, whatever the case and punctuation of the identity, and adds the workbook\'s list as a new formulation without touching the one it had', async () => {
    const token = await guestToken()
    const brand = word('Srch')
    const existing = await scanned(brand, 'Hydrating Cleanser', ['Aqua', 'Glycerin'])
    const product = productRow({ brand: brand.toUpperCase(), name: 'HYDRATING  Cleanser!' })

    const { data } = await applied((workbook) => {
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push({ ...product })
      workbook.availability.rows.push(availabilityRow(product.code as string))
    })

    expect(data.diff.newProducts).toEqual([])
    expect((await search(token, brand)).map((hit) => hit.id)).toEqual([existing.productId])
    const [rec] = (await approvedFor('NG', 'cleanse')).filter((r) => r.code === product.code)
    expect(rec!.productId).toBe(existing.productId)
    expect(rec!.formulationId).not.toBe(existing.formulationId)
    expect(await repository.findFormulation(rec!.formulationId)).toMatchObject({ productId: existing.productId, sourceKind: 'workbook', ingredients: LIST })
    // What the catalog already knew stands as it was.
    expect(await repository.findFormulation(existing.formulationId)).toMatchObject({ productId: existing.productId, sourceKind: 'label', ingredients: ['Aqua', 'Glycerin'] })
    expect(await catalog.resolve({ brand, name: 'Hydrating Cleanser', category: 'skin' })).toMatchObject({ productId: existing.productId, formulationId: rec!.formulationId })
  })

  it('pins the formulation the product already has when the workbook\'s list is the same list, and stores no second one', async () => {
    const brand = word('Srch')
    const existing = await scanned(brand, 'Hydrating Cleanser', LIST)
    const product = productRow({ brand, name: 'Hydrating Cleanser' })

    await applied((workbook) => {
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push({ ...product })
      workbook.availability.rows.push(availabilityRow(product.code as string))
    })

    const [rec] = (await approvedFor('NG', 'cleanse')).filter((r) => r.code === product.code)
    expect(rec).toMatchObject({ productId: existing.productId, formulationId: existing.formulationId })
    expect(await repository.findFormulation(existing.formulationId)).toMatchObject({ sourceKind: 'label' })
  })

  it('reuses the product another spelling of the identity was remembered for (an alias), and not a new one', async () => {
    const token = await guestToken()
    const brand = word('Srch')
    const existing = await scanned(brand, 'Hydrating Facial Cleanser', ['Aqua', 'Glycerin'])
    // A spelling the model confirms as the same product is remembered as an alias (the scan path, as in life). The two spellings must say as much
    // as each other ("Face" for "Facial": neither reading's words are inside the other's), or the catalog does not remember the shorter one.
    analyst.sameProductWith(() => true)
    expect((await catalog.resolve({ brand, name: 'Hydrating Face Cleanser', category: 'skin' })).productId).toBe(existing.productId)
    analyst.sameProductWith(() => false)
    const product = productRow({ brand, name: 'Hydrating Face Cleanser' })

    const { data } = await applied((workbook) => {
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push({ ...product })
      workbook.availability.rows.push(availabilityRow(product.code as string))
    })

    expect(data.diff.newProducts).toEqual([])
    expect((await search(token, brand)).map((hit) => hit.id)).toEqual([existing.productId])
    const [rec] = (await approvedFor('NG', 'cleanse')).filter((r) => r.code === product.code)
    expect(rec!.productId).toBe(existing.productId)
  })

  it('makes a second product for a differently spelled identity, never a guess at a merge, and lists it as a new product', async () => {
    const token = await guestToken()
    const brand = word('Srch')
    const existing = await scanned(brand, 'Hydrating Facial Cleanser', ['Aqua', 'Glycerin'])
    const product = productRow({ brand, name: 'Hydrating Face Cleanser' })

    const { data } = await applied((workbook) => {
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push({ ...product })
      workbook.availability.rows.push(availabilityRow(product.code as string))
    })

    expect(data.diff.newProducts).toEqual([{ code: product.code, brand, name: 'Hydrating Face Cleanser', variant: null, form: null }])
    const hits = await search(token, brand)
    expect(hits).toHaveLength(2)
    const [rec] = (await approvedFor('NG', 'cleanse')).filter((r) => r.code === product.code)
    expect(rec!.productId).not.toBe(existing.productId)
    expect(hits.map((hit) => hit.id).sort()).toEqual([existing.productId, rec!.productId].sort())
  })
})

describe('CatalogWorkbookService', () => {
  it('is built by the container, with the four calls the rest of the app uses', () => {
    const service = workbookService()

    for (const call of ['exportWorkbook', 'importWorkbook', 'countries', 'approvedFor', 'liveRules'] as const) expect(typeof service[call], call).toBe('function')
  })

  describe('approvedFor({ country, step })', () => {
    const cheap = productRow({ steps: 'cleanse; treat', skin_types: 'all', frequency: 'pm' })
    const moisturiser = productRow({ steps: 'moisturise' })
    const draft = productRow({ status: 'draft', approved_by: null, approved_on: null })
    const britishOnly = productRow()
    const nowhere = productRow()
    const both = productRow({ own_cautions: 'irritation; drying', origin: 'brand-submitted', skin_concerns: 'hd_acne', steps: 'cleanse', skin_types: 'oily' })
    const mine = new Set([cheap, moisturiser, draft, britishOnly, nowhere, both].map((row) => row.code as string))
    const codesOf = async (country: string, step: Parameters<typeof approvedFor>[1]) => (await approvedFor(country, step)).map((r) => r.code).filter((c) => mine.has(c as string))

    it('is loaded by one upload', async () => {
      await applied((workbook) => {
        withCountry(workbook, NIGERIA)
        withCountry(workbook, BRITAIN)
        for (const row of [cheap, moisturiser, draft, britishOnly, nowhere, both]) workbook.products.rows.push({ ...row })
        workbook.availability.rows.push(
          availabilityRow(cheap.code as string),
          availabilityRow(moisturiser.code as string, { price_min: 6000, price_max: 9000 }),
          availabilityRow(draft.code as string),
          availabilityRow(britishOnly.code as string, { country: 'GB', price_min: 7, price_max: 9 }),
          availabilityRow(both.code as string, { price_min: 12000, price_max: 18000, where_sold: null }),
          availabilityRow(both.code as string, { country: 'GB', price_min: 9, price_max: 14 }),
        )
      })
    })

    it('returns approved rows sold in the country, for the step asked, and nothing else: not a draft, not another country\'s row, not a row with no availability, not another step', async () => {
      expect(new Set(await codesOf('NG', 'cleanse'))).toEqual(new Set([cheap.code, both.code]))
      expect(new Set(await codesOf('NG', 'treat'))).toEqual(new Set([cheap.code]))
      expect(new Set(await codesOf('NG', 'moisturise'))).toEqual(new Set([moisturiser.code]))
      expect(await codesOf('NG', 'protect')).toEqual([])
      expect(new Set(await codesOf('GB', 'cleanse'))).toEqual(new Set([britishOnly.code, both.code]))
    })

    it('returns [] for a country nobody sells in, not an error', async () => {
      expect(await approvedFor('ZZ', 'cleanse')).toEqual([])
    })

    it('gives each row as { code, productId, formulationId, ingredients, keyIngredient, strength, skinConcerns, skinTypes, steps, frequency, ownCautions, evidenceUrls, ingredientsSourceUrl, origin, priceMin, priceMax, whereSold }', async () => {
      const [rec] = (await approvedFor('NG', 'treat')).filter((r) => r.code === cheap.code)
      const found = await catalog.resolve({ brand: cheap.brand as string, name: cheap.name as string, category: 'skin' })

      expect(rec).toEqual({
        code: cheap.code,
        productId: found.productId,
        formulationId: found.kind === 'needs-research' ? undefined : found.formulationId,
        ingredients: LIST,
        keyIngredient: null,
        strength: null,
        skinConcerns: ['hd_moisture', 'hd_redness'],
        skinTypes: 'all',
        steps: ['cleanse', 'treat'],
        frequency: 'pm',
        ownCautions: [],
        evidenceUrls: [],
        ingredientsSourceUrl: 'https://example.com/hydrating-cleanser',
        origin: 'sourced',
        priceMin: 3000,
        priceMax: 4500,
        whereSold: 'Pharmacies and online',
      })
    })

    it('gives a list of skin types as an array, cautions and origin as written, and no place of sale as null', async () => {
      const [rec] = (await approvedFor('NG', 'cleanse')).filter((r) => r.code === both.code)

      expect(rec).toMatchObject({ skinTypes: ['oily'], skinConcerns: ['hd_acne'], ownCautions: ['irritation', 'drying'], origin: 'brand-submitted', priceMin: 12000, priceMax: 18000, whereSold: null })
    })

    it('gives the price and place of the country asked for, for a product sold in two', async () => {
      const [uk] = (await approvedFor('GB', 'cleanse')).filter((r) => r.code === both.code)
      const [ng] = (await approvedFor('NG', 'cleanse')).filter((r) => r.code === both.code)

      expect(uk).toMatchObject({ priceMin: 9, priceMax: 14, whereSold: 'Pharmacies and online' })
      expect(ng).toMatchObject({ priceMin: 12000, priceMax: 18000, whereSold: null })
      expect(uk!.productId).toBe(ng!.productId)
      expect(uk!.formulationId).toBe(ng!.formulationId)
    })

    it('stops returning a retired row, and returns it again, as the same product on the same formulation, when it is reactivated', async () => {
      const before = (await approvedFor('GB', 'cleanse')).find((r) => r.code === britishOnly.code)!
      const kept = rowWith((await exportLive()).workbook.products, 'code', britishOnly.code)!

      await applied((workbook) => {
        without(workbook.availability, 'product_code', britishOnly.code)
        without(workbook.products, 'code', britishOnly.code)
      })
      expect(await codesOf('GB', 'cleanse')).not.toContain(britishOnly.code)

      await applied((workbook) => {
        workbook.products.rows = workbook.products.rows.filter((row) => row.code !== britishOnly.code)
        workbook.products.rows.push({ ...kept })
        workbook.availability.rows.push(availabilityRow(britishOnly.code as string, { country: 'GB', price_min: 7, price_max: 9 }))
      })

      const after = (await approvedFor('GB', 'cleanse')).find((r) => r.code === britishOnly.code)
      expect(after).toEqual(before)
    })

    it('stops returning a row that is edited back to a draft', async () => {
      await applied((workbook) => {
        rowWith(workbook.products, 'code', moisturiser.code)!.status = 'draft'
      })

      expect(await codesOf('NG', 'moisturise')).toEqual([])
    })
  })

  describe('countries()', () => {
    it('lists every country with its currency, band limits and status, retired ones included', async () => {
      await applied((workbook) => {
        withCountry(workbook, NIGERIA)
        withCountry(workbook, BRITAIN)
      })
      // Earlier tests in this file sell products in GB, and an availability row of a country the workbook lacks is invalid: the rows go in the same upload.
      await applied((workbook) => {
        without(workbook.availability, 'country', 'GB')
        without(workbook.countries, 'code', 'GB')
      })

      const countries = await workbookService().countries()

      expect(countries.find((country) => country.code === 'NG')).toEqual({ code: 'NG', currency: 'NGN', lowMax: 5000, midMax: 15000, status: 'active' })
      expect(countries.find((country) => country.code === 'GB')).toEqual({ code: 'GB', currency: 'GBP', lowMax: 10, midMax: 25, status: 'retired' })
    })
  })

  describe('liveRules()', () => {
    it('passes through what the repository reads: the rules version and the approved rules', async () => {
      expect(await workbookService().liveRules()).toEqual(await liveRules())
    })
  })

  describe('exportWorkbook() and importWorkbook(), the calls the routes make', () => {
    it('exportWorkbook gives what the export route serves', async () => {
      expect(await workbookService().exportWorkbook()).toEqual(await exportLive())
    })

    it('importWorkbook of an unchanged export is a dry run with an empty diff, and needs no file', async () => {
      const live = await exportLive()

      const result = await workbookService().importWorkbook({ workbook: live.workbook, file: null, baseVersion: live.catalogVersion, dryRun: true, uploadedBy: 'Service Caller', contractVersion: live.contractVersion })

      expect(result).toEqual({ applied: false, catalogVersion: live.catalogVersion, diff: EMPTY_DIFF })
    })

    it('importWorkbook applies with a file, and refuses to apply without one', async () => {
      const live = await exportLive()
      const product = productRow()
      const workbook = structuredClone(live.workbook)
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push({ ...product })
      workbook.availability.rows.push(availabilityRow(product.code as string))

      await expect(workbookService().importWorkbook({ workbook, file: null, baseVersion: live.catalogVersion, dryRun: false, uploadedBy: 'Service Caller', contractVersion: live.contractVersion })).rejects.toMatchObject({ name: 'ValidationError' })
      const result = await workbookService().importWorkbook({ workbook, file: xlsxBytes('service'), baseVersion: live.catalogVersion, dryRun: false, uploadedBy: 'Service Caller', contractVersion: live.contractVersion })

      expect(result).toMatchObject({ applied: true, catalogVersion: live.catalogVersion + 1 })
      expect(sorted(result.diff).products).toEqual(diffOf({ added: [product.code as string] }))
    })

    it('importWorkbook throws CATALOG_STALE for a base version that is not live, and CATALOG_INVALID with the problems for a bad workbook', async () => {
      await applied(() => {})
      const live = await exportLive()
      const bad = structuredClone(live.workbook)
      bad.products.rows.push(productRow({ category: 'nonsense' }))

      await expect(workbookService().importWorkbook({ workbook: live.workbook, file: null, baseVersion: live.catalogVersion - 1, dryRun: true, uploadedBy: 'Service Caller', contractVersion: live.contractVersion })).rejects.toMatchObject({ code: 'CATALOG_STALE' })
      await expect(workbookService().importWorkbook({ workbook: bad, file: null, baseVersion: live.catalogVersion, dryRun: true, uploadedBy: 'Service Caller', contractVersion: live.contractVersion })).rejects.toMatchObject({
        code: 'CATALOG_INVALID',
        details: { problems: [{ tab: 'products', row: bad.products.rows.length + 1, column: 'category', rule: 'NOT_IN_VOCABULARY' }] },
      })
    })
  })
})
