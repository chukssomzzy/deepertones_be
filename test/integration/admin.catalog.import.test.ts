import { env } from 'cloudflare:workers'
import type { RawRow, RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import { REFERENCE_VERSION } from '../../src/modules/catalog/catalog.reference'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  APPROVED_ON,
  BRITAIN,
  CONTRACT_VERSION,
  NIGERIA,
  SCHEDULE,
  WORKER_ENV,
  XLSX_MEDIA_TYPE,
  applied,
  archiveKeyPattern,
  archived,
  availabilityRow,
  baseGuideRows,
  baseReintroductionRows,
  claimWordRow,
  code,
  counts,
  dataOf,
  diffOf,
  edited,
  errorOf,
  escalationRow,
  exportLive,
  guideRow,
  importRaw,
  latestVersionRow,
  liveRuleNames,
  liveRules,
  productRow,
  productsOfBrand,
  reintroductionRow,
  responseRow,
  rowWith,
  ruleRow,
  rulesVersion,
  sorted,
  taperRow,
  upload,
  weekRow,
  withCountry,
  without,
  word,
  xlsxBytes,
  EMPTY_DIFF,
  type ImportResult,
} from './admin.catalog.support'

// POST /api/v1/admin/catalog/import through the Worker, against real local D1 and the local private bucket. An upload is the WHOLE catalog: what the
// export gave, edited. So every test builds its workbook by exporting what is live, changing its own rows, and importing; a code the upload leaves
// out is retired, which is why a test never starts from an empty workbook. Versions are compared relative to what was live a moment before, the
// bucket key is the live version plus one, and every product, rule and code is salted, because the database is shared by the whole file.

const RULES_VERSION = /^rules-[0-9a-f]{16}$/

// A fresh catalog has no guides, and the contract refuses a workbook without the four base ones, so the team writes them before the first import. The helpers here add
// any a step lacks (`upload`), which would make the first upload of the file the one that carries them. Done once up front, every test's diff is only what it is about.
let versionBeforeRoles = ''
let versionAfterRoles = ''
beforeAll(async () => {
  versionBeforeRoles = await rulesVersion()
  // This first upload also gives every seeded rule the reviewer_role contract 2.4.0 needs of an approved row (`upload` adds it, as the team does before its first 2.4.0 import).
  await applied(() => {})
  versionAfterRoles = await rulesVersion()
})

/** A product with its availability in Nigeria and the country itself, as one edit. */
const addProduct = (product = productRow(), over: { availability?: boolean } = {}) => {
  return (workbook: Parameters<Parameters<typeof upload>[0]>[0]) => {
    withCountry(workbook, NIGERIA)
    workbook.products.rows.push({ ...product })
    if (over.availability !== false) workbook.availability.rows.push(availabilityRow(product.code as string))
  }
}

describe('a dry run', () => {
  it('returns the diff the upload would make, per tab, with the products that would be new, and writes nothing: no row, no version, no archived file', async () => {
    const product = productRow({ variant: 'Night', form: 'cream' })
    const rule = ruleRow()
    const ghana = { code: 'GH', currency: 'GHS', low_max: 500, mid_max: 1500, status: 'active' }
    const live = await exportLive()
    const before = await counts()

    const { res } = await upload(
      (workbook) => {
        workbook.countries.rows.push({ ...ghana })
        workbook.products.rows.push({ ...product })
        workbook.availability.rows.push(availabilityRow(product.code as string, { country: 'GH', price_min: 400, price_max: 700 }))
        workbook.ingredients.rows.push({ ...rule })
      },
      { dryRun: true, file: xlsxBytes('dry-run') },
    )

    expect(res.status).toBe(200)
    const data = await dataOf<ImportResult>(res)
    expect(data.applied).toBe(false)
    expect(data.catalogVersion).toBe(live.catalogVersion)
    expect(sorted(data.diff)).toEqual({
      products: diffOf({ added: [product.code as string] }),
      availability: diffOf({ added: [`${product.code as string}:GH`] }),
      ingredients: diffOf({ added: [rule.code as string] }),
      countries: diffOf({ added: ['GH'] }),
      claimWords: diffOf({}),
      tapers: diffOf({}),
      guides: diffOf({}),
      reintroductions: diffOf({}),
      escalations: diffOf({}),
      responses: diffOf({}),
      weeks: diffOf({}),
      newProducts: [{ code: product.code, brand: product.brand, name: product.name, variant: 'Night', form: 'cream' }],
    })
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
    expect(await archived(live.catalogVersion + 1)).toBeNull()
    expect(await productsOfBrand(product.brand as string)).toBe(0)
  })

  it('is the default: an upload that does not say dryRun is a dry run', async () => {
    const live = await exportLive()
    const before = await counts()

    const { res } = await upload(addProduct(), { dryRun: undefined, file: xlsxBytes('default') })

    expect(res.status).toBe(200)
    expect(await dataOf<ImportResult>(res)).toMatchObject({ applied: false, catalogVersion: live.catalogVersion })
    expect(await counts()).toEqual(before)
  })

  it('needs no file', async () => {
    const { res } = await upload(addProduct(), { dryRun: true, file: null })

    expect(res.status).toBe(200)
    expect(await dataOf<ImportResult>(res)).toMatchObject({ applied: false })
  })

  it('reports no new product for a product row whose identity the catalog already holds, and an empty diff for an upload that changes nothing', async () => {
    const { res } = await upload(() => {}, { dryRun: true })

    expect((await dataOf<ImportResult>(res)).diff).toEqual(EMPTY_DIFF)
  })
})

describe('applying an upload', () => {
  it('writes it: the next catalog version, the rows live, the file archived under that version, and who uploaded it', async () => {
    const product = productRow()
    const rule = ruleRow()
    const file = xlsxBytes('apply-whole')

    const { before, res } = await upload(
      (workbook) => {
        addProduct(product)(workbook)
        workbook.ingredients.rows.push({ ...rule })
      },
      { dryRun: false, file, uploadedBy: 'Ngozi Admin' },
    )

    expect(res.status).toBe(200)
    const data = await dataOf<ImportResult>(res)
    expect(data).toMatchObject({ applied: true, catalogVersion: before.catalogVersion + 1 })
    expect(sorted(data.diff)).toMatchObject({
      products: diffOf({ added: [product.code as string] }),
      availability: diffOf({ added: [`${product.code as string}:NG`] }),
      ingredients: diffOf({ added: [rule.code as string] }),
      newProducts: [expect.objectContaining({ code: product.code })],
    })
    const live = await exportLive()
    expect(live.catalogVersion).toBe(before.catalogVersion + 1)
    expect(rowWith(live.workbook.products, 'code', product.code)).toEqual(product)
    expect(rowWith(live.workbook.ingredients, 'code', rule.code)).toEqual(rule)
    expect(rowWith(live.workbook.countries, 'code', 'NG')).toEqual(NIGERIA)
    // The original .xlsx, kept in the private bucket under a key for the version it made live, as an .xlsx.
    expect(await archived(before.catalogVersion + 1)).toEqual({ key: expect.stringMatching(archiveKeyPattern(before.catalogVersion + 1)), contentType: XLSX_MEDIA_TYPE, bytes: file })
  })

  // Nothing in the API says who uploaded, so this reads the version row itself, as the one way to see what was recorded.
  it('records the uploader\'s label, the contract version and where the file went, on the new catalog version', async () => {
    const { before } = await applied(addProduct(), { uploadedBy: 'Dr B. Auditor' })

    expect(await latestVersionRow()).toMatchObject({
      version: before.catalogVersion + 1,
      uploadedBy: 'Dr B. Auditor',
      contractVersion: CONTRACT_VERSION,
      archiveKey: expect.stringMatching(archiveKeyPattern(before.catalogVersion + 1)),
    })
  })

  it('adds exactly one catalog version, one archived file and the rows asked for, each time', async () => {
    const before = await counts()

    await applied(addProduct())

    const after = await counts()
    expect(after.versions).toBe(before.versions + 1)
    expect(after.archives).toBe(before.archives + 1)
    expect(after.recommended).toBe(before.recommended + 1)
    expect(after.availability).toBe(before.availability + 1)
  })

  it('refuses an apply that carries no file with a 400, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()

    const { res } = await upload(addProduct(), { dryRun: false, file: null })

    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toEqual(expect.any(String))
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })
})

describe('a stale upload', () => {
  it.each([
    ['an older', (live: number) => live - 1],
    ['a newer', (live: number) => live + 1],
  ])('is refused with 409 CATALOG_STALE when it was made from %s version than is live, and writes nothing', async (_, baseVersion) => {
    // Make sure there is an older version to claim.
    await applied(addProduct())
    const live = await exportLive()
    const before = await counts()

    const { res } = await upload(addProduct(), { baseVersion, dryRun: false, file: xlsxBytes('stale') })

    expect(res.status).toBe(409)
    expect((await errorOf(res)).code).toBe('CATALOG_STALE')
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
    expect(await archived(live.catalogVersion + 1)).toBeNull()
  })

  it('is refused as a dry run too, so a stale copy is told before anyone applies it', async () => {
    await applied(addProduct())
    const live = await exportLive()

    const { res } = await upload(addProduct(), { baseVersion: () => live.catalogVersion - 1, dryRun: true })

    expect(res.status).toBe(409)
    expect((await errorOf(res)).code).toBe('CATALOG_STALE')
  })

  it('refuses a second apply from the same base version: the first stands, the second changes nothing and the archive keeps the first file', async () => {
    const live = await exportLive()
    const [first, second] = [productRow(), productRow()]
    const [firstFile, secondFile] = [xlsxBytes('first'), xlsxBytes('second')]
    const workbook = (product: ReturnType<typeof productRow>) => edited(live.workbook, addProduct(product))

    const one = await importRaw({ workbook: workbook(first), baseVersion: live.catalogVersion, dryRun: false, file: firstFile })
    const two = await importRaw({ workbook: workbook(second), baseVersion: live.catalogVersion, dryRun: false, file: secondFile })

    expect(one.status).toBe(200)
    expect(two.status).toBe(409)
    expect((await errorOf(two)).code).toBe('CATALOG_STALE')
    const now = await exportLive()
    expect(now.catalogVersion).toBe(live.catalogVersion + 1)
    expect(rowWith(now.workbook.products, 'code', first.code)).toBeDefined()
    expect(rowWith(now.workbook.products, 'code', second.code)).toBeUndefined()
    expect(await productsOfBrand(second.brand as string)).toBe(0)
    expect((await archived(live.catalogVersion + 1))?.bytes).toEqual(firstFile)
    expect(await archived(live.catalogVersion + 2)).toBeNull()
  })

  // The two requests are in flight together, so both can read the live version before either writes. The version guard in the one batch decides:
  // exactly one apply stands, and the other leaves NOTHING behind (not its product, not its formulation; its archived file may remain as an orphan under its own key, but never in the winner's place).
  it('lets exactly one of two applies that start together from the same base version stand, and leaves nothing of the other', async () => {
    const live = await exportLive()
    const [a, b] = [productRow(), productRow()]
    const files = { a: xlsxBytes('race-a'), b: xlsxBytes('race-b') }
    const before = await counts()

    const [ra, rb] = await Promise.all([
      importRaw({ workbook: edited(live.workbook, addProduct(a)), baseVersion: live.catalogVersion, dryRun: false, file: files.a }),
      importRaw({ workbook: edited(live.workbook, addProduct(b)), baseVersion: live.catalogVersion, dryRun: false, file: files.b }),
    ])

    expect([ra.status, rb.status].sort()).toEqual([200, 409])
    const [winner, loser, winnerFile] = ra.status === 200 ? [a, b, files.a] : [b, a, files.b]
    expect((await errorOf(ra.status === 200 ? rb : ra)).code).toBe('CATALOG_STALE')
    const now = await exportLive()
    expect(now.catalogVersion).toBe(live.catalogVersion + 1)
    expect(rowWith(now.workbook.products, 'code', winner.code)).toBeDefined()
    expect(rowWith(now.workbook.products, 'code', loser.code)).toBeUndefined()
    expect(await productsOfBrand(winner.brand as string)).toBe(1)
    expect(await productsOfBrand(loser.brand as string)).toBe(0)
    const after = await counts()
    expect(after).toEqual({ ...before, products: before.products + 1, formulations: before.formulations + 1, versions: before.versions + 1, recommended: before.recommended + 1, availability: before.availability + 1, archives: after.archives, countries: after.countries })
    expect((await archived(live.catalogVersion + 1))?.bytes).toEqual(winnerFile)
  })
})

describe('an invalid workbook', () => {
  it('is refused with 400 CATALOG_INVALID listing every problem as { tab, row, column, rule } in error.details.problems, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()
    const product = productRow({ category: 'nonsense' })
    const dangling = availabilityRow(code('PRD-NOWHERE'))
    const linked = ruleRow({ statement: 'See https://example.com/buy-now for more.' })
    const bad = edited(live.workbook, (workbook) => {
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push({ ...product })
      workbook.availability.rows.push({ ...dangling })
      workbook.ingredients.rows.push({ ...linked })
    })
    const rowOf = (tab: keyof typeof bad, code: unknown) => bad[tab].rows.findIndex((row) => row.code === code || row.product_code === code) + 2

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: false, file: xlsxBytes('invalid') })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('CATALOG_INVALID')
    const byPosition = (problems: { tab: string; row: number; column: string; rule: string }[]) => [...problems].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
    expect(byPosition((error.details as { problems: never[] }).problems)).toEqual(
      byPosition([
        { tab: 'products', row: rowOf('products', product.code), column: 'category', rule: 'NOT_IN_VOCABULARY' },
        { tab: 'availability', row: rowOf('availability', dangling.product_code), column: 'product_code', rule: 'UNKNOWN_PRODUCT' },
        { tab: 'ingredients', row: rowOf('ingredients', linked.code), column: 'statement', rule: 'HAS_LINK_OR_MARKUP' },
      ]),
    )
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
    expect(await productsOfBrand(product.brand as string)).toBe(0)
  })

  it('is refused whole when the header row is wrong, because the server checks the contract itself and never trusts the script', async () => {
    const live = await exportLive()
    const before = await counts()
    const bad = edited(live.workbook, (workbook) => {
      workbook.products.headers = workbook.products.headers.filter((header) => header !== 'status')
    })

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: false, file: xlsxBytes('no-status') })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('CATALOG_INVALID')
    expect((error.details as { problems: unknown[] }).problems).toContainEqual({ tab: 'products', row: 1, column: 'status', rule: 'MISSING_COLUMN' })
    expect(await counts()).toEqual(before)
  })

  it('is refused as a dry run too, with the same problems', async () => {
    const { res } = await upload(
      (workbook) => {
        workbook.products.rows.push(productRow({ category: 'nonsense' }))
      },
      { dryRun: true },
    )

    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('CATALOG_INVALID')
  })

  it('holds no cell value in what it says about a problem', async () => {
    const SENTINEL = word('sentinel')

    const { res } = await upload(
      (workbook) => {
        workbook.products.rows.push(productRow({ category: SENTINEL }))
      },
      { dryRun: true },
    )

    expect(JSON.stringify(await res.json())).not.toContain(SENTINEL)
  })
})

describe('the request', () => {
  const sent = async (over: Partial<Parameters<typeof importRaw>[0]>) => {
    const live = await exportLive()
    return importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: true, ...over })
  }

  it.each([
    ['empty', ''],
    ['81 characters', 'a'.repeat(81)],
  ])('refuses an uploadedBy that is %s with a 400', async (_, uploadedBy) => {
    expect((await sent({ uploadedBy })).status).toBe(400)
  })

  it('refuses an upload with no uploadedBy with a 400', async () => {
    expect((await sent({ uploadedBy: null })).status).toBe(400)
  })

  it.each([
    ['1 character', 'a'],
    ['80 characters', 'a'.repeat(80)],
  ])('accepts an uploadedBy of %s', async (_, uploadedBy) => {
    expect((await sent({ uploadedBy })).status).toBe(200)
  })

  it.each([
    ['not a number', 'abc'],
    ['a fraction', '1.5'],
    ['empty', ''],
  ])('refuses a baseVersion that is %s with a 400', async (_, baseVersion) => {
    expect((await sent({ baseVersion })).status).toBe(400)
  })

  it.each([
    ['not JSON', 'this is not json'],
    ['JSON that is not a workbook', '{}'],
    ['JSON that is not an object', '[1, 2]'],
  ])('refuses a workbook that is %s with a 400', async (_, workbook) => {
    expect((await sent({ workbook })).status).toBe(400)
  })

  it('refuses a dryRun that is neither "true" nor "false" with a 400', async () => {
    expect((await sent({ dryRun: 'maybe' })).status).toBe(400)
  })
})

describe('retiring and reactivating', () => {
  it('retires a product whose code is left out of the upload, keeping its row, and reactivates it when the code comes back', async () => {
    const product = productRow()
    await applied(addProduct(product))
    const kept = rowWith((await exportLive()).workbook.products, 'code', product.code)!

    const gone = await applied((workbook) => {
      without(workbook.availability, 'product_code', product.code)
      without(workbook.products, 'code', product.code)
    })

    expect(sorted(gone.data.diff)).toMatchObject({ products: diffOf({ retired: [product.code as string] }), availability: diffOf({ retired: [`${product.code as string}:NG`] }), newProducts: [] })
    const retired = rowWith((await exportLive()).workbook.products, 'code', product.code)
    expect(retired).toEqual({ ...kept, status: 'retired' })

    const back = await applied((workbook) => {
      workbook.products.rows = workbook.products.rows.filter((row) => row.code !== product.code)
      workbook.products.rows.push({ ...kept })
      workbook.availability.rows.push(availabilityRow(product.code as string))
    })

    expect(sorted(back.data.diff)).toMatchObject({ products: diffOf({ reactivated: [product.code as string] }), availability: diffOf({ added: [`${product.code as string}:NG`] }), newProducts: [] })
    expect(rowWith((await exportLive()).workbook.products, 'code', product.code)).toEqual(kept)
  })

  it('reports an availability row that leaves, changes and arrives, keyed "<product code>:<country>"', async () => {
    const product = productRow()
    await applied((workbook) => {
      withCountry(workbook, NIGERIA)
      withCountry(workbook, BRITAIN)
      workbook.products.rows.push({ ...product })
      workbook.availability.rows.push(availabilityRow(product.code as string, { country: 'NG' }), availabilityRow(product.code as string, { country: 'GB', price_min: 8, price_max: 12 }))
    })
    const key = (country: string) => `${product.code as string}:${country}`

    const { data } = await applied((workbook) => {
      workbook.availability.rows = workbook.availability.rows.filter((row) => !(row.product_code === product.code && row.country === 'GB'))
      const ng = workbook.availability.rows.find((row) => row.product_code === product.code && row.country === 'NG')!
      ng.price_max = 4501
    })

    expect(sorted(data.diff).availability).toEqual(diffOf({ retired: [key('GB')], updated: [key('NG')] }))
    expect(sorted(data.diff).products).toEqual(diffOf({}))
  })

  it('reports a changed cell of a product as updated, and only that product', async () => {
    const [one, other] = [productRow(), productRow()]
    await applied((workbook) => {
      addProduct(one)(workbook)
      addProduct(other)(workbook)
    })

    const { data } = await applied((workbook) => {
      rowWith(workbook.products, 'code', one.code)!.frequency = 'pm'
    })

    expect(sorted(data.diff).products).toEqual(diffOf({ updated: [one.code as string] }))
    expect(data.diff.newProducts).toEqual([])
  })

  it('retires an ingredient rule whose code is left out, keeping its row, and reactivates it when the code comes back, with the rule applied exactly while it is live', async () => {
    const rule = ruleRow()
    await applied((workbook) => {
      workbook.ingredients.rows.push({ ...rule })
    })
    const liveVersion = await rulesVersion()
    expect(await liveRuleNames()).toContain(rule.name)

    const gone = await applied((workbook) => without(workbook.ingredients, 'code', rule.code))

    expect(sorted(gone.data.diff).ingredients).toEqual(diffOf({ retired: [rule.code as string] }))
    expect(rowWith((await exportLive()).workbook.ingredients, 'code', rule.code)).toEqual({ ...rule, status: 'retired' })
    expect(await liveRuleNames()).not.toContain(rule.name)
    expect(await rulesVersion()).not.toBe(liveVersion)

    const back = await applied((workbook) => {
      without(workbook.ingredients, 'code', rule.code)
      workbook.ingredients.rows.push({ ...rule })
    })

    expect(sorted(back.data.diff).ingredients).toEqual(diffOf({ reactivated: [rule.code as string] }))
    expect(await liveRuleNames()).toContain(rule.name)
    expect(await rulesVersion()).toBe(liveVersion)
  })

  it('retires a country whose code is left out, keeping its row, and reactivates it when the code comes back', async () => {
    await applied((workbook) => withCountry(workbook, BRITAIN))

    const gone = await applied((workbook) => without(workbook.countries, 'code', 'GB'))

    expect(sorted(gone.data.diff).countries).toEqual(diffOf({ retired: ['GB'] }))
    expect(rowWith((await exportLive()).workbook.countries, 'code', 'GB')).toEqual({ ...BRITAIN, status: 'retired' })

    const back = await applied((workbook) => {
      without(workbook.countries, 'code', 'GB')
      workbook.countries.rows.push({ ...BRITAIN })
    })

    expect(sorted(back.data.diff).countries).toEqual(diffOf({ reactivated: ['GB'] }))
    expect(rowWith((await exportLive()).workbook.countries, 'code', 'GB')).toEqual(BRITAIN)
  })
})

describe('the first 2.4.0 import of a catalog stored before it', () => {
  it('gives every seeded rule its reviewer_role without moving the rules version: the seed rules apply exactly as they did', async () => {
    const { workbook } = await exportLive()

    expect(workbook.ingredients.rows.length).toBeGreaterThan(0)
    for (const row of workbook.ingredients.rows) expect(row.reviewer_role, String(row.code)).toEqual(expect.stringMatching(/\S/))
    expect(versionBeforeRoles).toBe(REFERENCE_VERSION)
    expect(versionAfterRoles).toBe(REFERENCE_VERSION)
  })

  it('refuses an approved rule or claim word with no reviewer_role, 400 CATALOG_INVALID with REQUIRED_WHEN_APPROVED on that cell, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()
    const bad = edited(live.workbook, (workbook) => {
      workbook.ingredients.rows.push(ruleRow({ reviewer_role: null }))
      workbook.claimWords.rows.push(claimWordRow({ reviewer_role: null }))
    })
    const rule = bad.ingredients.rows.length + 1
    const claim = bad.claimWords.rows.length + 1

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: false, file: xlsxBytes('no-reviewer-role') })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('CATALOG_INVALID')
    expect((error.details as { problems: unknown[] }).problems).toEqual([
      { tab: 'ingredients', row: rule, column: 'reviewer_role', rule: 'REQUIRED_WHEN_APPROVED' },
      { tab: 'claimWords', row: claim, column: 'reviewer_role', rule: 'REQUIRED_WHEN_APPROVED' },
    ])
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })
})

describe('the rules version', () => {
  it('does not change when a Products-only upload is applied, so no product is analysed again', async () => {
    const version = await rulesVersion()

    await applied(addProduct())
    await applied((workbook) => {
      workbook.products.rows.push(productRow())
    })

    expect(await rulesVersion()).toBe(version)
  })

  it('does not change when an upload changes nothing about the approved rules', async () => {
    const version = await rulesVersion()

    await applied(() => {})

    expect(await rulesVersion()).toBe(version)
  })

  it('becomes rules-<16 hex digits> when an approved rule is added, and the matcher applies it', async () => {
    const before = await rulesVersion()
    const rule = ruleRow({ aliases: 'zq oil' })

    await applied((workbook) => {
      workbook.ingredients.rows.push({ ...rule })
    })

    const version = await rulesVersion()
    expect(version).toMatch(RULES_VERSION)
    expect(version).not.toBe(before)
    expect(await liveRuleNames()).toContain(rule.name)
  })

  it.each([
    ['statement', (rule: ReturnType<typeof ruleRow>) => (rule.statement = 'Commonly advised to patch test first.')],
    ['aliases', (rule: ReturnType<typeof ruleRow>) => (rule.aliases = `${rule.name} oil`)],
    ['kind', (rule: ReturnType<typeof ruleRow>) => (rule.kind = 'allergen')],
    ['status (approved to draft)', (rule: ReturnType<typeof ruleRow>) => (rule.status = 'draft')],
  ])('changes when an approved rule\'s %s changes', async (_, change) => {
    const rule = ruleRow()
    await applied((workbook) => {
      workbook.ingredients.rows.push({ ...rule })
    })
    const before = await rulesVersion()

    await applied((workbook) => {
      change(rowWith(workbook.ingredients, 'code', rule.code)!)
    })

    const after = await rulesVersion()
    expect(after).toMatch(RULES_VERSION)
    expect(after).not.toBe(before)
  })

  it('does not change when only the reviewer_role of an approved rule changes: it is metadata the verdict reads, and the matcher does not', async () => {
    const rule = ruleRow({ reviewer_role: 'a pharmacist' })
    await applied((workbook) => {
      workbook.ingredients.rows.push({ ...rule })
    })
    const before = await rulesVersion()

    const { data } = await applied((workbook) => {
      rowWith(workbook.ingredients, 'code', rule.code)!.reviewer_role = 'a consultant dermatologist'
    })

    expect(sorted(data.diff).ingredients).toEqual(diffOf({ updated: [rule.code as string] }))
    expect(rowWith((await exportLive()).workbook.ingredients, 'code', rule.code)).toMatchObject({ reviewer_role: 'a consultant dermatologist' })
    expect(await rulesVersion()).toBe(before)
  })

  it('does not change when only the reviewer_role and the source_url of an approved claim word change', async () => {
    const claim = claimWordRow({ reviewer_role: 'a pharmacist', source_url: null })
    await applied((workbook) => {
      workbook.claimWords.rows.push({ ...claim })
    })
    const before = await rulesVersion()

    const { data } = await applied((workbook) => {
      Object.assign(rowWith(workbook.claimWords, 'code', claim.code)!, { reviewer_role: 'a consultant dermatologist', source_url: 'https://example.com/why-flagged' })
    })

    expect(sorted(data.diff).claimWords).toEqual(diffOf({ updated: [claim.code as string] }))
    expect(rowWith((await exportLive()).workbook.claimWords, 'code', claim.code)).toMatchObject({ reviewer_role: 'a consultant dermatologist', source_url: 'https://example.com/why-flagged' })
    expect(await rulesVersion()).toBe(before)
  })

  it('does not change when a draft rule is added or edited, because a draft applies to nothing', async () => {
    const before = await rulesVersion()
    const draft = ruleRow({ status: 'draft', approved_by: null, approved_on: null })

    await applied((workbook) => {
      workbook.ingredients.rows.push({ ...draft })
    })
    await applied((workbook) => {
      rowWith(workbook.ingredients, 'code', draft.code)!.statement = 'A reworded draft.'
    })

    expect(await rulesVersion()).toBe(before)
    expect(await liveRuleNames()).not.toContain(draft.name)
  })

  it('changes when a draft rule is approved', async () => {
    const draft = ruleRow({ status: 'draft', approved_by: null, approved_on: null })
    await applied((workbook) => {
      workbook.ingredients.rows.push({ ...draft })
    })
    const before = await rulesVersion()

    await applied((workbook) => {
      Object.assign(rowWith(workbook.ingredients, 'code', draft.code)!, ruleRow({ code: draft.code, name: draft.name, statement: draft.statement }))
    })

    expect(await rulesVersion()).not.toBe(before)
    expect(await liveRuleNames()).toContain(draft.name)
  })

  it('names a set of approved rules, not a moment: restoring a rule to what it was gives back exactly the version it had', async () => {
    const rule = ruleRow()
    await applied((workbook) => {
      workbook.ingredients.rows.push({ ...rule })
    })
    const first = await rulesVersion()

    await applied((workbook) => {
      rowWith(workbook.ingredients, 'code', rule.code)!.statement = 'A different statement.'
    })
    const second = await rulesVersion()
    await applied((workbook) => {
      rowWith(workbook.ingredients, 'code', rule.code)!.statement = rule.statement
    })

    expect(second).not.toBe(first)
    expect(await rulesVersion()).toBe(first)
  })
})

describe('the contract version', () => {
  it.each([
    ['an older contract', '1.0.0'],
    ['the 2.0.0 contract, before key_ingredient and strength', '2.0.0'],
    ['the 2.1.0 contract, before the Guides tab', '2.1.0'],
    ['the 2.2.0 contract, before the Reintroductions, Escalations, Responses and Weeks tabs', '2.2.0'],
    ['the 2.3.0 contract, before reviewer_role, the claim word source_url and the about-a-product escalation', '2.3.0'],
    ['a newer contract', '9.9.9'],
  ])('refuses a file made for %s with 409 CONTRACT_MISMATCH, as a dry run and as an apply, and writes nothing', async (_what, contractVersion) => {
    const live = await exportLive()
    const before = await counts()

    for (const dryRun of [true, false]) {
      const { res } = await upload(addProduct(), { dryRun, file: dryRun ? null : xlsxBytes('contract-mismatch'), contractVersion })

      expect(res.status).toBe(409)
      expect((await errorOf(res)).code).toBe('CONTRACT_MISMATCH')
    }
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })

  it('says so before it says the workbook is invalid or stale', async () => {
    const live = await exportLive()
    const bad = edited(live.workbook, (workbook) => {
      workbook.products.rows.push(productRow({ category: 'nonsense' }))
    })

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion - 1, dryRun: true, contractVersion: '1.0.0' })

    expect(res.status).toBe(409)
    expect((await errorOf(res)).code).toBe('CONTRACT_MISMATCH')
  })

  it('refuses a genuine 1.0.0 workbook, which has four tabs and no claimWords or tapers, with 409 CONTRACT_MISMATCH and not a 400 for its shape, as a dry run and as an apply', async () => {
    const live = await exportLive()
    const { claimWords: _claimWords, tapers: _tapers, ...fourTabs } = live.workbook
    const before = await counts()

    for (const dryRun of [true, false]) {
      const res = await importRaw({ workbook: fourTabs as unknown as RawWorkbook, baseVersion: live.catalogVersion, dryRun, file: dryRun ? null : xlsxBytes('four-tabs'), contractVersion: '1.0.0' })

      expect(res.status).toBe(409)
      expect((await errorOf(res)).code).toBe('CONTRACT_MISMATCH')
    }
    expect(await counts()).toEqual(before)
  })

  it('refuses a genuine 2.1.0 workbook, which has six tabs and no guides, with 409 CONTRACT_MISMATCH and not a 400 for its shape, as a dry run and as an apply', async () => {
    const live = await exportLive()
    const { guides: _guides, ...sixTabs } = live.workbook
    const before = await counts()

    for (const dryRun of [true, false]) {
      const res = await importRaw({ workbook: sixTabs as unknown as RawWorkbook, baseVersion: live.catalogVersion, dryRun, file: dryRun ? null : xlsxBytes('six-tabs'), contractVersion: '2.1.0' })

      expect(res.status).toBe(409)
      expect((await errorOf(res)).code).toBe('CONTRACT_MISMATCH')
    }
    expect(await counts()).toEqual(before)
  })

  it('refuses a genuine 2.2.0 workbook, which has seven tabs and none of the four reviewed ones, with 409 CONTRACT_MISMATCH and not a 400 for its shape, as a dry run and as an apply', async () => {
    const live = await exportLive()
    const { reintroductions: _r, escalations: _e, responses: _s, weeks: _w, ...sevenTabs } = live.workbook
    const before = await counts()

    for (const dryRun of [true, false]) {
      const res = await importRaw({ workbook: sevenTabs as unknown as RawWorkbook, baseVersion: live.catalogVersion, dryRun, file: dryRun ? null : xlsxBytes('seven-tabs'), contractVersion: '2.2.0' })

      expect(res.status).toBe(409)
      expect((await errorOf(res)).code).toBe('CONTRACT_MISMATCH')
    }
    expect(await counts()).toEqual(before)
  })

  /** What a workbook exported at 2.3.0 is: the 2.4.0 export without the reviewer_role columns, the claim word source_url and the about-a-product escalation. */
  const asExportedAt230 = (workbook: RawWorkbook): RawWorkbook =>
    edited(workbook, (copy) => {
      const dropColumn = (tab: RawWorkbook['ingredients'], column: string) => {
        tab.headers = tab.headers.filter((header) => header !== column)
        for (const row of tab.rows) delete row[column]
      }
      dropColumn(copy.ingredients, 'reviewer_role')
      dropColumn(copy.claimWords, 'reviewer_role')
      dropColumn(copy.claimWords, 'source_url')
      copy.escalations.rows = copy.escalations.rows.filter((row) => row.reason !== 'about-a-product')
    })

  it('refuses a genuine 2.3.0 workbook, which has no reviewer_role column and no about-a-product escalation, with 409 CONTRACT_MISMATCH and not a 400 for its shape, as a dry run and as an apply', async () => {
    const live = await exportLive()
    const old = asExportedAt230(live.workbook)
    expect(old.ingredients.headers).not.toContain('reviewer_role')
    const before = await counts()

    for (const dryRun of [true, false]) {
      const res = await importRaw({ workbook: old, baseVersion: live.catalogVersion, dryRun, file: dryRun ? null : xlsxBytes('two-three-zero'), contractVersion: '2.3.0' })

      expect(res.status).toBe(409)
      expect((await errorOf(res)).code).toBe('CONTRACT_MISMATCH')
    }
    expect(await counts()).toEqual(before)
  })

  it('refuses a 2.3.0-shaped workbook that says it is 2.4.0 with a 400: the columns and the escalation row it lacks are told as problems, not as a contract mismatch', async () => {
    const live = await exportLive()

    const res = await importRaw({ workbook: asExportedAt230(live.workbook), baseVersion: live.catalogVersion, dryRun: true, contractVersion: CONTRACT_VERSION })

    expect(res.status).toBe(400)
    expect(((await errorOf(res)).details as { problems: unknown[] }).problems).toEqual(
      expect.arrayContaining([
        { tab: 'ingredients', row: 1, column: 'reviewer_role', rule: 'MISSING_COLUMN' },
        { tab: 'claimWords', row: 1, column: 'reviewer_role', rule: 'MISSING_COLUMN' },
        { tab: 'claimWords', row: 1, column: 'source_url', rule: 'MISSING_COLUMN' },
        { tab: 'escalations', row: 1, column: 'reason', rule: 'ESCALATION_MISSING' },
      ]),
    )
  })

  it.each(['reintroductions', 'escalations', 'responses', 'weeks'] as const)('refuses a workbook of the current contract version that has no %s tab, with a 400 and not a 409', async (tab) => {
    const live = await exportLive()
    const { [tab]: _gone, ...tenTabs } = live.workbook

    const res = await importRaw({ workbook: tenTabs as unknown as RawWorkbook, baseVersion: live.catalogVersion, dryRun: true, contractVersion: live.contractVersion })

    expect(res.status).toBe(400)
  })

  it('refuses a workbook of the current contract version that has no Guides tab, with a 400 and not a 409', async () => {
    const live = await exportLive()
    const { guides: _guides, ...sixTabs } = live.workbook

    const res = await importRaw({ workbook: sixTabs as unknown as RawWorkbook, baseVersion: live.catalogVersion, dryRun: true, contractVersion: live.contractVersion })

    expect(res.status).toBe(400)
  })

  it('still refuses a workbook of the current contract version whose shape is wrong, with a 400 and not a 409', async () => {
    const live = await exportLive()
    const { tapers: _tapers, ...fiveTabs } = live.workbook

    const res = await importRaw({ workbook: fiveTabs as unknown as RawWorkbook, baseVersion: live.catalogVersion, dryRun: true, contractVersion: live.contractVersion })

    expect(res.status).toBe(400)
  })

  it('refuses an upload that does not say which contract it was made for with a 400', async () => {
    const live = await exportLive()

    const res = await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: true, contractVersion: null })

    expect(res.status).toBe(400)
  })

  it('takes the version the export gave', async () => {
    const live = await exportLive()

    const res = await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: true, contractVersion: live.contractVersion })

    expect(res.status).toBe(200)
  })
})

describe('claim words and tapers', () => {
  it('reports the added claim word and taper in a dry run, per tab, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()
    const [claim, taper] = [claimWordRow(), taperRow()]

    const { res } = await upload(
      (workbook) => {
        workbook.claimWords.rows.push({ ...claim })
        workbook.tapers.rows.push({ ...taper })
      },
      { dryRun: true },
    )

    expect(res.status).toBe(200)
    const data = await dataOf<ImportResult>(res)
    expect(data.applied).toBe(false)
    expect(sorted(data.diff)).toEqual({ ...EMPTY_DIFF, claimWords: diffOf({ added: [claim.code as string] }), tapers: diffOf({ added: [taper.code as string] }) })
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })

  it('stores them on apply: the next catalog version, the rows in the export, the rules version where it was', async () => {
    const [claim, taper] = [claimWordRow(), taperRow({ kind: 'lightening-agent', schedule: '1: am-pm; 2-3: am; 4: stop' })]
    const version = await rulesVersion()

    const { before, data } = await applied((workbook) => {
      workbook.claimWords.rows.push({ ...claim })
      workbook.tapers.rows.push({ ...taper })
    })

    expect(data.catalogVersion).toBe(before.catalogVersion + 1)
    expect(sorted(data.diff)).toMatchObject({ claimWords: diffOf({ added: [claim.code as string] }), tapers: diffOf({ added: [taper.code as string] }) })
    const live = await exportLive()
    expect(rowWith(live.workbook.claimWords, 'code', claim.code)).toEqual(claim)
    expect(rowWith(live.workbook.tapers, 'code', taper.code)).toEqual(taper)
    expect(await rulesVersion()).toBe(version)
  })

  it('reports an edit as updated, and only the row edited', async () => {
    const [claim, other, taper] = [claimWordRow(), claimWordRow(), taperRow()]
    await applied((workbook) => {
      workbook.claimWords.rows.push({ ...claim }, { ...other })
      workbook.tapers.rows.push({ ...taper })
    })

    const { res } = await upload(
      (workbook) => {
        rowWith(workbook.claimWords, 'code', claim.code)!.phrase = word('zqedited')
        rowWith(workbook.tapers, 'code', taper.code)!.schedule = '1-3: alternate-days; 4: stop'
      },
      { dryRun: true },
    )

    const data = await dataOf<ImportResult>(res)
    expect(sorted(data.diff)).toEqual({ ...EMPTY_DIFF, claimWords: diffOf({ updated: [claim.code as string] }), tapers: diffOf({ updated: [taper.code as string] }) })
  })

  it('compares a schedule by what it means: the same steps with other spaces are no change', async () => {
    const taper = taperRow({ schedule: SCHEDULE })
    await applied((workbook) => {
      workbook.tapers.rows.push({ ...taper })
    })

    const { res } = await upload(
      (workbook) => {
        rowWith(workbook.tapers, 'code', taper.code)!.schedule = '1-2:alternate-days;3-4:weekly;5:stop'
      },
      { dryRun: true },
    )

    expect((await dataOf<ImportResult>(res)).diff.tapers).toEqual(diffOf({}))
  })

  it('never deletes: a claim word or taper left out of the upload is retired in place, with its cells, and reactivated when the code comes back', async () => {
    const [claim, taper] = [claimWordRow(), taperRow()]
    await applied((workbook) => {
      workbook.claimWords.rows.push({ ...claim })
      workbook.tapers.rows.push({ ...taper })
    })

    const { data: retired } = await applied((workbook) => {
      without(workbook.claimWords, 'code', claim.code)
      without(workbook.tapers, 'code', taper.code)
    })

    expect(sorted(retired.diff)).toMatchObject({ claimWords: diffOf({ retired: [claim.code as string] }), tapers: diffOf({ retired: [taper.code as string] }) })
    const live = await exportLive()
    expect(rowWith(live.workbook.claimWords, 'code', claim.code)).toEqual({ ...claim, status: 'retired' })
    expect(rowWith(live.workbook.tapers, 'code', taper.code)).toEqual({ ...taper, status: 'retired' })

    const { data: back } = await applied((workbook) => {
      workbook.claimWords.rows = workbook.claimWords.rows.filter((row) => row.code !== claim.code).concat({ ...claim })
      workbook.tapers.rows = workbook.tapers.rows.filter((row) => row.code !== taper.code).concat({ ...taper })
    })
    expect(sorted(back.diff)).toMatchObject({ claimWords: diffOf({ reactivated: [claim.code as string] }), tapers: diffOf({ reactivated: [taper.code as string] }) })
    expect(rowWith((await exportLive()).workbook.tapers, 'code', taper.code)).toEqual(taper)
  })

  it('refuses a taper whose schedule is not allowed, with its row and the rule, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()
    const bad = edited(live.workbook, (workbook) => {
      workbook.tapers.rows.push(taperRow({ schedule: '1: weekly; 2: alternate-days; 3: stop' }))
    })

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: false, file: xlsxBytes('bad-schedule') })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('CATALOG_INVALID')
    expect((error.details as { problems: unknown[] }).problems).toEqual([{ tab: 'tapers', row: bad.tapers.rows.length + 1, column: 'schedule', rule: 'SCHEDULE_FREQUENCY_INCREASES' }])
    expect(await counts()).toEqual(before)
  })

  it('refuses two live claim words with one phrase, naming both rows', async () => {
    const phrase = word('zqtwice')
    const live = await exportLive()
    const bad = edited(live.workbook, (workbook) => {
      workbook.claimWords.rows.push(claimWordRow({ phrase }), claimWordRow({ phrase }))
    })
    const [first, second] = [bad.claimWords.rows.length, bad.claimWords.rows.length - 1]

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: true })

    expect(res.status).toBe(400)
    expect((((await errorOf(res)).details as { problems: unknown[] }).problems)).toEqual(
      expect.arrayContaining([
        { tab: 'claimWords', row: first + 1, column: 'phrase', rule: 'DUPLICATE_PHRASE' },
        { tab: 'claimWords', row: second + 1, column: 'phrase', rule: 'DUPLICATE_PHRASE' },
      ]),
    )
  })

  afterEach(() => vi.restoreAllMocks())

  it('does not log a phrase or the words of a taper', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    const [phrase, expectWords, see] = [word('zqlogphrase'), word('Logexpect'), word('Logsee')]

    await applied((workbook) => {
      workbook.claimWords.rows.push(claimWordRow({ phrase }))
      workbook.tapers.rows.push(taperRow({ what_to_expect: `Mild ${expectWords}.`, see_a_professional_if: `Severe ${see}.` }))
    })

    const text = JSON.stringify(logs.flatMap((spy) => spy.mock.calls))
    for (const secret of [phrase, expectWords, see]) expect(text, secret).not.toContain(secret)
  })
})

describe('group and clashes_with', () => {
  const pair = () => {
    const retinoid = ruleRow({ group: 'retinoid', clashes_with: 'exfoliating-acid' })
    const acid = ruleRow({ group: 'exfoliating-acid', clashes_with: 'retinoid' })
    return { retinoid, acid }
  }

  it('are stored with the rule and exported as they were written', async () => {
    const { retinoid, acid } = pair()

    await applied((workbook) => {
      workbook.ingredients.rows.push({ ...retinoid }, { ...acid })
    })

    const live = await exportLive()
    expect(rowWith(live.workbook.ingredients, 'code', retinoid.code)).toEqual(retinoid)
    expect(rowWith(live.workbook.ingredients, 'code', acid.code)).toEqual(acid)
  })

  it('refuse a clash that is not returned: 400 CATALOG_INVALID with the rows on both sides', async () => {
    const { retinoid, acid } = pair()
    acid.clashes_with = null
    const live = await exportLive()
    const bad = edited(live.workbook, (workbook) => {
      // Rules an earlier test left in groups would answer the clash (the upload is the whole catalog), so these two stand alone.
      for (const row of workbook.ingredients.rows) Object.assign(row, { group: null, clashes_with: null })
      workbook.ingredients.rows.push({ ...retinoid }, { ...acid })
    })
    const at = bad.ingredients.rows.length + 1

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: true })

    expect(res.status).toBe(400)
    expect((((await errorOf(res)).details as { problems: unknown[] }).problems)).toEqual(
      expect.arrayContaining([
        { tab: 'ingredients', row: at - 1, column: 'clashes_with', rule: 'CLASH_NOT_SYMMETRIC' },
        { tab: 'ingredients', row: at, column: 'group', rule: 'CLASH_NOT_SYMMETRIC' },
      ]),
    )
  })

  it('do not change the rules version when they are added, changed or cleared on an approved rule, while a change the matcher reads still does', async () => {
    const { retinoid, acid } = pair()
    await applied((workbook) => {
      workbook.ingredients.rows.push({ ...retinoid }, { ...acid })
    })
    const version = await rulesVersion()

    const { data: regrouped } = await applied((workbook) => {
      Object.assign(rowWith(workbook.ingredients, 'code', retinoid.code)!, { group: 'steroid', clashes_with: null })
      Object.assign(rowWith(workbook.ingredients, 'code', acid.code)!, { group: 'lightening-agent', clashes_with: null })
    })
    expect(sorted(regrouped.diff).ingredients).toEqual(diffOf({ updated: [retinoid.code as string, acid.code as string].sort() }))
    expect(await rulesVersion()).toBe(version)

    await applied((workbook) => {
      Object.assign(rowWith(workbook.ingredients, 'code', retinoid.code)!, { group: null })
      Object.assign(rowWith(workbook.ingredients, 'code', acid.code)!, { group: null })
    })
    expect(await rulesVersion()).toBe(version)

    await applied((workbook) => {
      rowWith(workbook.ingredients, 'code', retinoid.code)!.statement = 'Commonly advised to patch test first.'
    })
    expect(await rulesVersion()).not.toBe(version)
  })

  it('leave the rules the matcher applies exactly as they were', async () => {
    const rule = ruleRow({ aliases: 'zq matcher oil' })
    await applied((workbook) => {
      workbook.ingredients.rows.push({ ...rule })
    })
    const entries = async () => (await liveRules()).entries.filter((entry) => entry.name === rule.name)
    const before = await entries()

    await applied((workbook) => {
      Object.assign(rowWith(workbook.ingredients, 'code', rule.code)!, { group: 'mercury' })
    })

    expect(await entries()).toEqual(before)
    expect(before).toHaveLength(1)
  })
})

describe('guides', () => {
  const treatGlow = (over: RawRow = {}) => guideRow({ step: 'treat', goal: 'glow', what_it_does: 'Helps skin look even.', look_for: 'Niacinamide.', for_deeper_skin: 'Go slowly.', ...over })
  const dryRun = (edit: (workbook: RawWorkbook) => void) => upload(edit, { dryRun: true })

  it('reports an added guide in a dry run, keyed by step and goal, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()

    const { res } = await dryRun((workbook) => workbook.guides.rows.push(treatGlow()))

    expect(res.status).toBe(200)
    expect(sorted((await dataOf<ImportResult>(res)).diff)).toEqual({ ...EMPTY_DIFF, guides: diffOf({ added: ['treat:glow'] }) })
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })

  it('stores a guide on apply: the next catalog version, the row in the export as uploaded, the rules version where it was', async () => {
    const guide = treatGlow({ goal: 'even-tone', look_for_when_pregnant: 'Azelaic acid only.', audited_by: 'Dr B. Auditor', audited_on: APPROVED_ON })
    const version = await rulesVersion()

    const { before, data } = await applied((workbook) => workbook.guides.rows.push({ ...guide }))

    expect(data.catalogVersion).toBe(before.catalogVersion + 1)
    expect(sorted(data.diff).guides).toEqual(diffOf({ added: ['treat:even-tone'] }))
    const live = await exportLive()
    expect(live.workbook.guides.rows.find((row) => row.step === 'treat' && row.goal === 'even-tone')).toEqual(guide)
    expect(await rulesVersion()).toBe(version)
  })

  it('reports an edit as updated, for a base guide as for a goal guide, and only the row edited; a text with other spaces is no change', async () => {
    await applied((workbook) => workbook.guides.rows.push(treatGlow({ goal: 'brighter' })))

    const edit = await dryRun((workbook) => {
      workbook.guides.rows.find((row) => row.step === 'protect' && row.goal === null)!.for_deeper_skin = 'Choose a finish that leaves no grey film.'
      workbook.guides.rows.find((row) => row.goal === 'brighter')!.look_for = '  Niacinamide.  '
    })
    const spaced = await dryRun((workbook) => {
      workbook.guides.rows.find((row) => row.goal === 'brighter')!.look_for = '  Niacinamide.  '
    })

    expect(sorted((await dataOf<ImportResult>(edit.res)).diff)).toEqual({ ...EMPTY_DIFF, guides: diffOf({ updated: ['protect'] }) })
    expect((await dataOf<ImportResult>(spaced.res)).diff.guides).toEqual(diffOf({}))
  })

  it('never deletes: a goal guide left out of the upload is retired in place, with its cells, and reactivated when it comes back', async () => {
    const guide = treatGlow({ goal: 'calm-repair' })
    await applied((workbook) => workbook.guides.rows.push({ ...guide }))

    const { data: retired } = await applied((workbook) => {
      workbook.guides.rows = workbook.guides.rows.filter((row) => row.goal !== 'calm-repair')
    })

    expect(retired.diff.guides).toEqual(diffOf({ retired: ['treat:calm-repair'] }))
    expect((await exportLive()).workbook.guides.rows.find((row) => row.goal === 'calm-repair')).toEqual({ ...guide, status: 'retired' })
    const { data: back } = await applied((workbook) => {
      workbook.guides.rows = workbook.guides.rows.filter((row) => row.goal !== 'calm-repair').concat({ ...guide })
    })
    expect(back.diff.guides).toEqual(diffOf({ reactivated: ['treat:calm-repair'] }))
    expect((await exportLive()).workbook.guides.rows.find((row) => row.goal === 'calm-repair')).toEqual(guide)
  })

  it('refuses a workbook without a base guide for each step, 400 CATALOG_INVALID with GUIDE_BASE_MISSING on the Guides header row, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()
    const bad = edited(live.workbook, (workbook) => {
      workbook.guides.rows = workbook.guides.rows.filter((row) => !(row.step === 'treat' && row.goal === null))
    })

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: false, file: xlsxBytes('no-base-guide') })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('CATALOG_INVALID')
    expect((error.details as { problems: unknown[] }).problems).toEqual([{ tab: 'guides', row: 1, column: 'step', rule: 'GUIDE_BASE_MISSING' }])
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })

  it('refuses a guide that says lighter skin, with the problem on the cell, and two guides for one step and goal, naming both rows', async () => {
    const live = await exportLive()
    const bad = edited(live.workbook, (workbook) => {
      workbook.guides.rows.push(treatGlow({ goal: 'clear-skin', look_for: 'A serum for lighter skin.' }), treatGlow({ goal: 'fade-dark-marks' }), treatGlow({ goal: 'fade-dark-marks' }))
    })
    // The three rows are the last three of the tab; the first data row is row 2.
    const first = bad.guides.rows.length - 1

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: true })

    expect(res.status).toBe(400)
    expect(((await errorOf(res)).details as { problems: unknown[] }).problems).toEqual(
      expect.arrayContaining([
        { tab: 'guides', row: first, column: 'look_for', rule: 'GUIDE_WORDING' },
        { tab: 'guides', row: first + 1, column: 'step', rule: 'GUIDE_DUPLICATE' },
        { tab: 'guides', row: first + 2, column: 'step', rule: 'GUIDE_DUPLICATE' },
      ]),
    )
  })
})

// ---- the four reviewed tabs of contract 2.3.0 (spec #233, PR 1) ----
// A ladder is named in a diff by its group ("default" for the one with none), an escalation by its reason, a response by its outcome, and a week card by its band, then
// ":<goal>" when it has a goal, then ":step-down" when it is for a step-down. The database is shared by the whole file, so each test writes keys no other test does.

describe('reintroductions', () => {
  const ladder = (over: RawRow = {}) => reintroductionRow({ group: 'retinoid', schedule: '1-2: as-needed; 3-4: weekly; 5: am; 6: back', ...over })
  const dryRun = (edit: (workbook: RawWorkbook) => void) => upload(edit, { dryRun: true })

  it('reports an added ladder in a dry run, keyed by its group, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()

    const { res } = await dryRun((workbook) => workbook.reintroductions.rows.push(ladder()))

    expect(res.status).toBe(200)
    expect(sorted((await dataOf<ImportResult>(res)).diff)).toEqual({ ...EMPTY_DIFF, reintroductions: diffOf({ added: ['retinoid'] }) })
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })

  it('stores a ladder on apply: the next catalog version, the row in the export as uploaded, the rules version where it was', async () => {
    const row = ladder({ group: 'exfoliating-acid', schedule: '1-3: as-needed; 4: back', audited_by: 'Dr B. Auditor', audited_on: APPROVED_ON })
    const version = await rulesVersion()

    const { before, data } = await applied((workbook) => workbook.reintroductions.rows.push({ ...row }))

    expect(data.catalogVersion).toBe(before.catalogVersion + 1)
    expect(sorted(data.diff).reintroductions).toEqual(diffOf({ added: ['exfoliating-acid'] }))
    const live = await exportLive()
    expect(rowWith(live.workbook.reintroductions, 'group', 'exfoliating-acid')).toEqual(row)
    expect(live.workbook.reintroductions.rows.find((one) => one.group === null)).toEqual(baseReintroductionRows()[0])
    expect(await rulesVersion()).toBe(version)
  })

  it('reports an edit as updated, the default ladder as "default", and only the row edited; a schedule with other spaces is no change', async () => {
    await applied((workbook) => workbook.reintroductions.rows.push(ladder()))

    const edit = await dryRun((workbook) => {
      workbook.reintroductions.rows.find((row) => row.group === null)!.schedule = '1: weekly; 2: back'
    })
    const spaced = await dryRun((workbook) => {
      workbook.reintroductions.rows.find((row) => row.group === 'retinoid')!.schedule = ' 1-2:as-needed ;  3-4 : weekly; 5:am;6: back '
    })

    expect(sorted((await dataOf<ImportResult>(edit.res)).diff)).toEqual({ ...EMPTY_DIFF, reintroductions: diffOf({ updated: ['default'] }) })
    expect((await dataOf<ImportResult>(spaced.res)).diff.reintroductions).toEqual(diffOf({}))
  })

  it('never deletes: a group ladder left out of the upload is retired in place, with its cells, and reactivated when it comes back', async () => {
    const row = ladder({ group: 'benzoyl-peroxide', schedule: '1: weekly; 2: back' })
    await applied((workbook) => workbook.reintroductions.rows.push({ ...row }))

    const { data: retired } = await applied((workbook) => {
      workbook.reintroductions.rows = workbook.reintroductions.rows.filter((one) => one.group !== 'benzoyl-peroxide')
    })

    expect(retired.diff.reintroductions).toEqual(diffOf({ retired: ['benzoyl-peroxide'] }))
    expect(rowWith((await exportLive()).workbook.reintroductions, 'group', 'benzoyl-peroxide')).toEqual({ ...row, status: 'retired' })
    const { data: back } = await applied((workbook) => {
      workbook.reintroductions.rows = workbook.reintroductions.rows.filter((one) => one.group !== 'benzoyl-peroxide').concat({ ...row })
    })
    expect(back.diff.reintroductions).toEqual(diffOf({ reactivated: ['benzoyl-peroxide'] }))
    expect(rowWith((await exportLive()).workbook.reintroductions, 'group', 'benzoyl-peroxide')).toEqual(row)
  })

  it('refuses a workbook without the default ladder, 400 CATALOG_INVALID with REINTRO_DEFAULT_MISSING on the Reintroductions header row, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()
    const bad = edited(live.workbook, (workbook) => {
      workbook.reintroductions.rows = workbook.reintroductions.rows.filter((row) => row.group !== null)
    })

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: false, file: xlsxBytes('no-default-ladder') })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('CATALOG_INVALID')
    expect((error.details as { problems: unknown[] }).problems).toEqual([{ tab: 'reintroductions', row: 1, column: 'group', rule: 'REINTRO_DEFAULT_MISSING' }])
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })

  it('refuses a ladder for a group that is only ever stopped, a ladder that goes down, and two ladders for one group, each on its row', async () => {
    const live = await exportLive()
    const bad = edited(live.workbook, (workbook) => {
      workbook.reintroductions.rows = [
        ...baseReintroductionRows(),
        reintroductionRow({ group: 'steroid', schedule: '1: weekly; 2: back' }),
        reintroductionRow({ group: 'retinoid', schedule: '1: alternate-days; 2: weekly; 3: back' }),
        reintroductionRow({ group: 'exfoliating-acid' }),
        reintroductionRow({ group: 'exfoliating-acid' }),
      ]
    })

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: true })

    expect(res.status).toBe(400)
    expect(((await errorOf(res)).details as { problems: unknown[] }).problems).toEqual(
      expect.arrayContaining([
        { tab: 'reintroductions', row: 3, column: 'group', rule: 'REINTRO_GROUP_NEVER_BACK' },
        { tab: 'reintroductions', row: 4, column: 'schedule', rule: 'REINTRO_FREQUENCY_DECREASES' },
        { tab: 'reintroductions', row: 5, column: 'group', rule: 'REINTRO_DUPLICATE' },
        { tab: 'reintroductions', row: 6, column: 'group', rule: 'REINTRO_DUPLICATE' },
      ]),
    )
  })
})

describe('escalations', () => {
  const dryRun = (edit: (workbook: RawWorkbook) => void) => upload(edit, { dryRun: true })
  const edit = (reason: string, over: RawRow) => (workbook: RawWorkbook) => Object.assign(workbook.escalations.rows.find((row) => row.reason === reason)!, over)

  it('reports an edited escalation as updated, keyed by its reason, in a dry run, and writes nothing; a text with other spaces is no change', async () => {
    const live = await exportLive()
    const before = await counts()

    const changed = await dryRun(edit('swelling', { how_soon: word('Soon') }))
    const spaced = await dryRun((workbook) => {
      const row = workbook.escalations.rows.find((one) => one.reason === 'swelling')!
      row.how_soon = `  ${String(row.how_soon)}  `
    })

    expect(sorted((await dataOf<ImportResult>(changed.res)).diff)).toEqual({ ...EMPTY_DIFF, escalations: diffOf({ updated: ['swelling'] }) })
    expect((await dataOf<ImportResult>(spaced.res)).diff.escalations).toEqual(diffOf({}))
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })

  it('stores an edited escalation on apply: the next catalog version, the row in the export as uploaded, in place, the rules version where it was', async () => {
    const soon = word('Soon')
    const version = await rulesVersion()

    const { before, data } = await applied(edit('near-eyes', { how_soon: soon, audited_by: 'Dr B. Auditor', audited_on: APPROVED_ON }))

    expect(data.catalogVersion).toBe(before.catalogVersion + 1)
    expect(sorted(data.diff).escalations).toEqual(diffOf({ updated: ['near-eyes'] }))
    const live = (await exportLive()).workbook.escalations
    expect(live.rows.filter((row) => row.reason === 'near-eyes')).toEqual([expect.objectContaining({ how_soon: soon, audited_by: 'Dr B. Auditor', audited_on: APPROVED_ON })])
    expect(live.rows).toHaveLength(8)
    expect(await rulesVersion()).toBe(version)
  })

  it('refuses a workbook without a row for each reason, 400 CATALOG_INVALID with ESCALATION_MISSING on the Escalations header row, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()
    const bad = edited(live.workbook, (workbook) => {
      workbook.escalations.rows = workbook.escalations.rows.filter((row) => row.reason !== 'harm-while-two-paused')
    })

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: false, file: xlsxBytes('no-escalation') })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('CATALOG_INVALID')
    expect((error.details as { problems: unknown[] }).problems).toEqual([{ tab: 'escalations', row: 1, column: 'reason', rule: 'ESCALATION_MISSING' }])
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })

  it('refuses an escalation that says lighter skin, with the problem on the cell, and two rows for one reason, naming both rows', async () => {
    const live = await exportLive()
    const bad = edited(live.workbook, (workbook) => {
      workbook.escalations.rows.find((row) => row.reason === 'swelling')!.what_to_tell_them = 'That your skin is going lighter skin.'
      workbook.escalations.rows.push(escalationRow({ reason: 'near-eyes' }))
    })
    const swelling = bad.escalations.rows.findIndex((row) => row.reason === 'swelling') + 2
    const nearEyes = bad.escalations.rows.findIndex((row) => row.reason === 'near-eyes') + 2

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: true })

    expect(res.status).toBe(400)
    expect(((await errorOf(res)).details as { problems: unknown[] }).problems).toEqual(
      expect.arrayContaining([
        { tab: 'escalations', row: swelling, column: 'what_to_tell_them', rule: 'ESCALATION_WORDING' },
        { tab: 'escalations', row: nearEyes, column: 'reason', rule: 'ESCALATION_DUPLICATE' },
        { tab: 'escalations', row: bad.escalations.rows.length + 1, column: 'reason', rule: 'ESCALATION_DUPLICATE' },
      ]),
    )
  })
})

describe('responses', () => {
  const dryRun = (edit: (workbook: RawWorkbook) => void) => upload(edit, { dryRun: true })
  const edit = (outcome: string, over: RawRow) => (workbook: RawWorkbook) => Object.assign(workbook.responses.rows.find((row) => row.outcome === outcome)!, over)

  it('reports an edited response as updated, keyed by its outcome, in a dry run, and writes nothing; a text with other spaces is no change', async () => {
    const live = await exportLive()
    const before = await counts()

    const changed = await dryRun(edit('check-same', { body: word('Body') }))
    const spaced = await dryRun((workbook) => {
      const row = workbook.responses.rows.find((one) => one.outcome === 'check-same')!
      row.body = `  ${String(row.body)}  `
    })

    expect(sorted((await dataOf<ImportResult>(changed.res)).diff)).toEqual({ ...EMPTY_DIFF, responses: diffOf({ updated: ['check-same'] }) })
    expect((await dataOf<ImportResult>(spaced.res)).diff.responses).toEqual(diffOf({}))
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })

  it('stores an edited response on apply: the row in the export as uploaded, {step} untouched, an empty what-to-do-now as null, the rules version where it was', async () => {
    const body = `${word('Body')} for your {step}.`
    const version = await rulesVersion()

    const { before, data } = await applied(edit('check-calmer', { body, what_to_do_now: null }))

    expect(data.catalogVersion).toBe(before.catalogVersion + 1)
    expect(sorted(data.diff).responses).toEqual(diffOf({ updated: ['check-calmer'] }))
    const live = (await exportLive()).workbook.responses
    expect(live.rows.filter((row) => row.outcome === 'check-calmer')).toEqual([expect.objectContaining({ body, what_to_do_now: null })])
    expect(live.rows).toHaveLength(9)
    expect(await rulesVersion()).toBe(version)
  })

  it('refuses a workbook without a row for each outcome, 400 CATALOG_INVALID with RESPONSE_MISSING on the Responses header row, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()
    const bad = edited(live.workbook, (workbook) => {
      workbook.responses.rows = workbook.responses.rows.filter((row) => row.outcome !== 'expected-flare')
    })

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: false, file: xlsxBytes('no-response') })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('CATALOG_INVALID')
    expect((error.details as { problems: unknown[] }).problems).toEqual([{ tab: 'responses', row: 1, column: 'outcome', rule: 'RESPONSE_MISSING' }])
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })

  it('refuses a placeholder other than {step} and a text that says lighter skin, each on its cell, and two rows for one outcome, naming both rows', async () => {
    const live = await exportLive()
    const bad = edited(live.workbook, (workbook) => {
      workbook.responses.rows.find((row) => row.outcome === 'paused')!.title = 'We paused your {product}'
      workbook.responses.rows.find((row) => row.outcome === 'advice-itching')!.body = 'This gives you lighter skin.'
      workbook.responses.rows.push(responseRow({ outcome: 'check-worse' }))
    })
    const at = (outcome: string) => bad.responses.rows.findIndex((row) => row.outcome === outcome) + 2

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: true })

    expect(res.status).toBe(400)
    expect(((await errorOf(res)).details as { problems: unknown[] }).problems).toEqual(
      expect.arrayContaining([
        { tab: 'responses', row: at('paused'), column: 'title', rule: 'RESPONSE_PLACEHOLDER' },
        { tab: 'responses', row: at('advice-itching'), column: 'body', rule: 'RESPONSE_WORDING' },
        { tab: 'responses', row: at('check-worse'), column: 'outcome', rule: 'RESPONSE_DUPLICATE' },
        { tab: 'responses', row: bad.responses.rows.length + 1, column: 'outcome', rule: 'RESPONSE_DUPLICATE' },
      ]),
    )
  })
})

describe('weeks', () => {
  const dryRun = (edit: (workbook: RawWorkbook) => void) => upload(edit, { dryRun: true })
  const card = (over: RawRow = {}) => weekRow({ band: '5-8', goal: 'glow', title: 'Glow, weeks 5 to 8', text: 'Glow text.', ...over })

  it('reports added cards in a dry run, keyed by band, then goal, then step-down, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()

    const { res } = await dryRun((workbook) => workbook.weeks.rows.push(card(), card({ step_down: 'yes' }), card({ goal: null, step_down: 'yes' })))

    expect(res.status).toBe(200)
    expect(sorted((await dataOf<ImportResult>(res)).diff)).toEqual({ ...EMPTY_DIFF, weeks: diffOf({ added: ['5-8:glow', '5-8:glow:step-down', '5-8:step-down'] }) })
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })

  it('stores cards on apply: the next catalog version, the rows in the export as uploaded (an empty step_down as no), the rules version where it was', async () => {
    const goalCard = card({ band: '9-12', goal: 'even-tone', audited_by: 'Dr B. Auditor', audited_on: APPROVED_ON })
    const stepDown = card({ band: '9-12', goal: null, step_down: 'yes', title: 'Step-down', text: 'Step-down text.' })
    const version = await rulesVersion()

    const { before, data } = await applied((workbook) => workbook.weeks.rows.push({ ...goalCard }, { ...stepDown }, card({ band: '2', goal: 'brighter', step_down: null })))

    expect(data.catalogVersion).toBe(before.catalogVersion + 1)
    expect(sorted(data.diff).weeks).toEqual(diffOf({ added: ['2:brighter', '9-12:even-tone', '9-12:step-down'] }))
    const live = (await exportLive()).workbook.weeks
    expect(live.rows.find((row) => row.band === '9-12' && row.goal === 'even-tone')).toEqual(goalCard)
    expect(live.rows.find((row) => row.band === '9-12' && row.step_down === 'yes')).toEqual(stepDown)
    expect(live.rows.find((row) => row.band === '2' && row.goal === 'brighter')).toMatchObject({ step_down: 'no' })
    expect(await rulesVersion()).toBe(version)
  })

  it('reports an edit as updated, a base card as its band, and only the row edited; a text with other spaces is no change', async () => {
    await applied((workbook) => workbook.weeks.rows.push(card({ band: '9-12', goal: 'fade-dark-marks' })))

    const edit = await dryRun((workbook) => {
      workbook.weeks.rows.find((row) => row.band === '3-4' && row.goal === null && row.step_down === 'no')!.text = word('Text')
    })
    const spaced = await dryRun((workbook) => {
      const row = workbook.weeks.rows.find((one) => one.band === '9-12' && one.goal === 'fade-dark-marks')!
      row.text = `  ${String(row.text)}  `
    })

    expect(sorted((await dataOf<ImportResult>(edit.res)).diff)).toEqual({ ...EMPTY_DIFF, weeks: diffOf({ updated: ['3-4'] }) })
    expect((await dataOf<ImportResult>(spaced.res)).diff.weeks).toEqual(diffOf({}))
  })

  it('never deletes: a card left out of the upload is retired in place, with its cells, and reactivated when it comes back', async () => {
    const row = card({ band: '1', goal: 'calm-repair', step_down: 'yes', title: 'Calm', text: 'Calm text.' })
    const mine = (one: RawRow) => one.band === '1' && one.goal === 'calm-repair'
    await applied((workbook) => workbook.weeks.rows.push({ ...row }))

    const { data: retired } = await applied((workbook) => {
      workbook.weeks.rows = workbook.weeks.rows.filter((one) => !mine(one))
    })

    expect(retired.diff.weeks).toEqual(diffOf({ retired: ['1:calm-repair:step-down'] }))
    expect((await exportLive()).workbook.weeks.rows.find(mine)).toEqual({ ...row, status: 'retired' })
    const { data: back } = await applied((workbook) => {
      workbook.weeks.rows = workbook.weeks.rows.filter((one) => !mine(one)).concat({ ...row })
    })
    expect(back.diff.weeks).toEqual(diffOf({ reactivated: ['1:calm-repair:step-down'] }))
    expect((await exportLive()).workbook.weeks.rows.find(mine)).toEqual(row)
  })

  it('refuses a workbook without a base card for each band, 400 CATALOG_INVALID with WEEK_BASE_MISSING on the Weeks header row, and writes nothing', async () => {
    const live = await exportLive()
    const before = await counts()
    const bad = edited(live.workbook, (workbook) => {
      workbook.weeks.rows = workbook.weeks.rows.filter((row) => !(row.band === '5-8' && row.goal === null && row.step_down === 'no'))
    })

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: false, file: xlsxBytes('no-base-card') })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('CATALOG_INVALID')
    expect((error.details as { problems: unknown[] }).problems).toEqual([{ tab: 'weeks', row: 1, column: 'band', rule: 'WEEK_BASE_MISSING' }])
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
  })

  it('refuses a card that says lighter skin, with the problem on the cell, and two cards for one band, goal and step-down, naming both rows', async () => {
    const live = await exportLive()
    const bad = edited(live.workbook, (workbook) => {
      workbook.weeks.rows.push(card({ band: '3-4', goal: 'clear-skin', text: 'Lighter skin by week four.' }), card({ band: '3-4', goal: 'fade-dark-marks' }), card({ band: '3-4', goal: 'fade-dark-marks' }))
    })
    // The three rows are the last three of the tab; the first data row is row 2.
    const first = bad.weeks.rows.length - 1

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: true })

    expect(res.status).toBe(400)
    expect(((await errorOf(res)).details as { problems: unknown[] }).problems).toEqual(
      expect.arrayContaining([
        { tab: 'weeks', row: first, column: 'text', rule: 'WEEK_WORDING' },
        { tab: 'weeks', row: first + 1, column: 'band', rule: 'WEEK_DUPLICATE' },
        { tab: 'weeks', row: first + 2, column: 'band', rule: 'WEEK_DUPLICATE' },
      ]),
    )
  })
})

// The server knows which environment it is. In production only, a Tapers row that is approved must have been approved by someone on the list of
// qualified approvers; elsewhere anyone may approve, so the owner or Claude can approve on staging. It is a process control, not authentication:
// the approver is a label in a cell. Each call here hands the Worker its own bindings.
describe('the production approver gate', () => {
  const QUALIFIED = 'Dr Q. Dermatologist'
  const asProduction = (approvers: string | undefined): typeof env => ({ ...WORKER_ENV, ENVIRONMENT: 'production', QUALIFIED_APPROVERS: approvers }) as unknown as typeof env
  const asEnvironment = (environment: string, approvers = ''): typeof env => ({ ...WORKER_ENV, ENVIRONMENT: environment, QUALIFIED_APPROVERS: approvers }) as unknown as typeof env
  const problemsOf = async (res: Response) => ((await errorOf(res)).details as { problems: { tab: string; row: number; column: string; rule: string }[] }).problems

  /**
   * Dry runs, which the gate applies to as much as to an apply. The upload is the whole catalog, and the Tapers tab of an earlier test is part of
   * what is live, so each starts from no templates (a template left out is retired, and retired ones are not checked): the only approved
   * templates in an upload are the ones the test is about.
   */
  const noTapers = (workbook: RawWorkbook) => {
    workbook.tapers.rows = []
    // The guides in force are approved too, and the gate is for them as much as for templates: theirs are approved by someone on the list, so a test is about what it adds.
    workbook.guides.rows = baseGuideRows().map((row) => ({ ...row, approved_by: QUALIFIED }))
    signReviewed(workbook)
  }
  /**
   * The ladders, escalations, responses and week cards in force are approved too, and the gate is for them as much as for templates: they are signed by someone on the list. So are
   * the approved rules and claim words (the seed signed its rules as itself), which the gate checks since contract 2.4.0.
   */
  const signReviewed = (workbook: RawWorkbook) => {
    for (const tab of ['reintroductions', 'escalations', 'responses', 'weeks'] as const) workbook[tab].rows = workbook[tab].rows.map((row) => ({ ...row, approved_by: QUALIFIED }))
    for (const tab of ['ingredients', 'claimWords'] as const) workbook[tab].rows = workbook[tab].rows.map((row) => (row.status === 'approved' ? { ...row, approved_by: QUALIFIED } : row))
  }
  const dry = (edit: (workbook: RawWorkbook) => void, workerEnv: typeof env) =>
    upload(
      (workbook) => {
        noTapers(workbook)
        edit(workbook)
      },
      { dryRun: true, workerEnv },
    )

  it('refuses an approved taper whose approver is not on the list, 400 CATALOG_INVALID with one UNQUALIFIED_APPROVER problem at that row and column, and never the approver\'s name', async () => {
    const approver = word('Owner')
    const taper = taperRow({ approved_by: approver })
    let row = 0

    const { res } = await dry(
      (workbook) => {
        workbook.tapers.rows.push({ ...taper })
        row = workbook.tapers.rows.length + 1
      },
      asProduction(QUALIFIED),
    )

    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toContain(approver)
    const body = JSON.parse(text) as { error: { code: string; details: { problems: unknown[] } } }
    expect(body.error.code).toBe('CATALOG_INVALID')
    expect(body.error.details.problems).toEqual([{ tab: 'tapers', row, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' }])
  })

  it('names every approved taper that is refused, one problem each, and not the ones that pass', async () => {
    const rows = [taperRow({ approved_by: 'Somebody Else' }), taperRow({ approved_by: QUALIFIED }), taperRow({ approved_by: 'Another Person' })]
    let first = 0

    const { res } = await dry(
      (workbook) => {
        first = workbook.tapers.rows.length + 2
        workbook.tapers.rows.push(...rows.map((row) => ({ ...row })))
      },
      asProduction(QUALIFIED),
    )

    expect(res.status).toBe(400)
    expect(await problemsOf(res)).toEqual([
      { tab: 'tapers', row: first, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' },
      { tab: 'tapers', row: first + 2, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' },
    ])
  })

  it('accepts an approved taper whose approver is on the list', async () => {
    const { res } = await dry((workbook) => workbook.tapers.rows.push(taperRow({ approved_by: QUALIFIED })), asProduction(QUALIFIED))

    expect(res.status).toBe(200)
    expect((await dataOf<ImportResult>(res)).applied).toBe(false)
  })

  it('reads the list as comma-separated labels, spaces around them ignored, and matches a label whole: a part of a name is not the name', async () => {
    const list = ` Dr B. Other ,${QUALIFIED}  ,Dr C. Third`

    const whole = await dry((workbook) => workbook.tapers.rows.push(taperRow({ approved_by: QUALIFIED })), asProduction(list))
    const other = await dry((workbook) => workbook.tapers.rows.push(taperRow({ approved_by: 'Dr C. Third' })), asProduction(list))
    const part = await dry((workbook) => workbook.tapers.rows.push(taperRow({ approved_by: 'Dr Q.' })), asProduction(list))
    const longer = await dry((workbook) => workbook.tapers.rows.push(taperRow({ approved_by: `${QUALIFIED} Jr` })), asProduction(list))

    expect(whole.res.status).toBe(200)
    expect(other.res.status).toBe(200)
    expect(part.res.status).toBe(400)
    expect(longer.res.status).toBe(400)
  })

  it.each([
    ['an empty list', ''],
    ['a list of only spaces and commas', ' , ,'],
    ['no list at all', undefined],
  ])('refuses every approved taper when the list is %s: nobody is qualified', async (_what, approvers) => {
    const { res } = await dry((workbook) => workbook.tapers.rows.push(taperRow({ approved_by: QUALIFIED })), asProduction(approvers))

    expect(res.status).toBe(400)
    // Nobody is qualified, so the guides in force are refused too: the tab's own tests are below.
    expect((await problemsOf(res)).filter((problem) => problem.tab === 'tapers').map((problem) => problem.rule)).toEqual(['UNQUALIFIED_APPROVER'])
  })

  it('checks only a taper that is approved: a draft and a retired template may name anyone, since neither is in force', async () => {
    const { res } = await dry((workbook) => {
      workbook.tapers.rows.push(
        taperRow({ status: 'draft', approved_by: null, approved_on: null }),
        taperRow({ status: 'draft', approved_by: 'Somebody Else' }),
        taperRow({ status: 'retired', approved_by: 'Somebody Else' }),
      )
    }, asProduction(QUALIFIED))

    expect(res.status).toBe(200)
  })

  it('does not check Products: a product approved by anyone is accepted in production', async () => {
    const { res } = await dry((workbook) => {
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push(productRow({ approved_by: 'Somebody Else' }))
    }, asProduction(QUALIFIED))

    expect(res.status).toBe(200)
  })

  // Contract 2.4.0 shows a rule's and a claim word's reviewer role as "Reviewed by" (spec #259), so their approver is checked too (the owner, 2026-10-30).
  it('refuses an approved rule and an approved claim word whose approver is not on the list, one problem each, and never the name', async () => {
    let rows = { ingredients: 0, claimWords: 0 }
    const { res } = await dry((workbook) => {
      workbook.ingredients.rows.push(ruleRow({ approved_by: 'Somebody Else' }))
      workbook.claimWords.rows.push(claimWordRow({ approved_by: 'Somebody Else' }))
      rows = { ingredients: workbook.ingredients.rows.length + 1, claimWords: workbook.claimWords.rows.length + 1 }
    }, asProduction(QUALIFIED))

    expect(res.status).toBe(400)
    const body = await res.clone().text()
    expect(body).not.toContain('Somebody Else')
    expect((await problemsOf(res)).filter((problem) => problem.tab === 'ingredients' || problem.tab === 'claimWords')).toEqual([
      { tab: 'ingredients', row: rows.ingredients, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' },
      { tab: 'claimWords', row: rows.claimWords, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' },
    ])
  })

  it('accepts a rule and a claim word approved by someone on the list, whatever reviewer role they write', async () => {
    const { res } = await dry((workbook) => {
      workbook.ingredients.rows.push(ruleRow({ approved_by: QUALIFIED, reviewer_role: 'Claude draft, not reviewed' }))
      workbook.claimWords.rows.push(claimWordRow({ approved_by: QUALIFIED, reviewer_role: 'Claude draft, not reviewed' }))
    }, asProduction(QUALIFIED))

    expect(res.status).toBe(200)
  })

  it('refuses an apply too, and writes nothing: no version, no row, no archived file', async () => {
    const live = await exportLive()
    const before = await counts()
    const bad = edited(live.workbook, (workbook) => {
      noTapers(workbook)
      workbook.tapers.rows.push(taperRow({ approved_by: 'Somebody Else' }))
    })

    const res = await importRaw({ workbook: bad, baseVersion: live.catalogVersion, dryRun: false, file: xlsxBytes('unqualified'), workerEnv: asProduction(QUALIFIED) })

    expect(res.status).toBe(400)
    expect((await problemsOf(res)).map((problem) => problem.rule)).toEqual(['UNQUALIFIED_APPROVER'])
    expect(await exportLive()).toEqual(live)
    expect(await counts()).toEqual(before)
    expect(await archived(live.catalogVersion + 1)).toBeNull()
  })

  describe('for guides', () => {
    /** A dry run whose Guides tab is exactly what the test gives: no template, and none of the base rows the helper would add. */
    const dryGuides = (guides: RawRow[], workerEnv: typeof env) =>
      upload(
        (workbook) => {
          workbook.tapers.rows = []
          workbook.guides.rows = guides
          signReviewed(workbook)
        },
        { dryRun: true, workerEnv, baseGuides: false },
      )
    const bases = (approver: string) => baseGuideRows().map((row) => ({ ...row, approved_by: approver }))

    it('refuses an approved guide whose approver is not on the list, 400 CATALOG_INVALID with one UNQUALIFIED_APPROVER problem for each, at its row, and never the approver\'s name', async () => {
      const approver = word('Owner')

      const { res } = await dryGuides([...bases(QUALIFIED).slice(0, 2), ...bases(approver).slice(2), guideRow({ step: 'treat', goal: 'glow', approved_by: approver })], asProduction(QUALIFIED))

      expect(res.status).toBe(400)
      const text = await res.text()
      expect(text).not.toContain(approver)
      const body = JSON.parse(text) as { error: { code: string; details: { problems: unknown[] } } }
      expect(body.error.code).toBe('CATALOG_INVALID')
      expect(body.error.details.problems).toEqual([
        { tab: 'guides', row: 4, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' },
        { tab: 'guides', row: 5, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' },
        { tab: 'guides', row: 6, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' },
      ])
    })

    it('accepts guides approved by someone on the list, and a draft or retired guide by anyone', async () => {
      const { res } = await dryGuides(
        [
          ...bases(QUALIFIED),
          guideRow({ step: 'treat', goal: 'glow', status: 'draft', approved_by: 'Somebody Else' }),
          guideRow({ step: 'treat', goal: 'even-tone', status: 'retired', approved_by: 'Somebody Else' }),
        ],
        asProduction(QUALIFIED),
      )

      expect(res.status).toBe(200)
    })

    it.each([['staging'], ['development']])('accepts any approver in %s', async (environment) => {
      const { res } = await dryGuides(bases('Somebody Else'), asEnvironment(environment, QUALIFIED))

      expect(res.status).toBe(200)
    })
  })

  describe('for the four reviewed tabs', () => {
    /** The edit that signs one row of the tab with `approver`, and the row of the tab it is, as the problem would name it. */
    const SIGNED = [
      ['reintroductions', 'group', null, 'a ladder'],
      ['escalations', 'reason', 'swelling', 'an escalation'],
      ['responses', 'outcome', 'check-worse', 'a response'],
      ['weeks', 'band', '5-8', 'a week card'],
    ] as const
    const rowOf = (workbook: RawWorkbook, tab: (typeof SIGNED)[number][0], key: string, value: string | null) =>
      workbook[tab].rows.findIndex((row) => row[key] === value && (tab !== 'weeks' || (row.goal === null && row.step_down === 'no')) && row.status === 'approved') + 2

    it.each(SIGNED)('refuses an approved row of %s (%s %s, %s) whose approver is not on the list, 400 CATALOG_INVALID with one UNQUALIFIED_APPROVER problem at its row, and never the approver\'s name', async (tab, key, value) => {
      const approver = word('Owner')
      let row = 0

      const { res } = await dry((workbook) => {
        const found = workbook[tab].rows.find((one) => one[key] === value && (tab !== 'weeks' || (one.goal === null && one.step_down === 'no')))!
        found.approved_by = approver
        row = rowOf(workbook, tab, key, value as string | null)
      }, asProduction(QUALIFIED))

      expect(res.status).toBe(400)
      const text = await res.text()
      expect(text).not.toContain(approver)
      const body = JSON.parse(text) as { error: { code: string; details: { problems: unknown[] } } }
      expect(body.error.code).toBe('CATALOG_INVALID')
      expect(body.error.details.problems).toEqual([{ tab, row, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' }])
    })

    it('accepts all four tabs approved by someone on the list, and a draft or retired ladder or week card by anyone', async () => {
      const { res } = await dry((workbook) => {
        // Only the rows the contract needs are kept, so the draft and retired rows below are for keys no row of the tab already has.
        workbook.reintroductions.rows = workbook.reintroductions.rows.filter((row) => row.group === null)
        workbook.weeks.rows = workbook.weeks.rows.filter((row) => row.goal === null && row.step_down === 'no')
        workbook.reintroductions.rows.push(
          reintroductionRow({ group: 'exfoliating-acid', status: 'draft', approved_by: 'Somebody Else' }),
          reintroductionRow({ group: 'benzoyl-peroxide', status: 'retired', approved_by: 'Somebody Else' }),
        )
        workbook.weeks.rows.push(
          weekRow({ band: '3-4', goal: 'brighter', status: 'draft', approved_by: 'Somebody Else' }),
          weekRow({ band: '3-4', goal: 'even-tone', status: 'retired', approved_by: 'Somebody Else' }),
        )
      }, asProduction(QUALIFIED))

      expect(res.status).toBe(200)
    })

    it.each([['staging'], ['development']])('accepts any approver in %s', async (environment) => {
      const { res } = await upload(
        (workbook) => {
          for (const tab of ['reintroductions', 'escalations', 'responses', 'weeks'] as const) workbook[tab].rows = workbook[tab].rows.map((row) => ({ ...row, approved_by: 'Somebody Else' }))
        },
        { dryRun: true, workerEnv: asEnvironment(environment, QUALIFIED) },
      )

      expect(res.status).toBe(200)
    })
  })

  it.each([['staging'], ['development']])('accepts any approver in %s, whatever the list says', async (environment) => {
    for (const approvers of ['', QUALIFIED]) {
      const { res } = await dry((workbook) => workbook.tapers.rows.push(taperRow({ approved_by: 'Somebody Else' })), asEnvironment(environment, approvers))

      expect(res.status, `${environment} / ${JSON.stringify(approvers)}`).toBe(200)
    }
  })

  it('applies in staging: an approved taper by anyone is stored', async () => {
    const taper = taperRow({ approved_by: 'The Owner' })
    const file = xlsxBytes('staging-approval')

    const { res } = await upload(
      (workbook) => {
        workbook.tapers.rows.push({ ...taper })
      },
      { dryRun: false, file, workerEnv: asEnvironment('staging') },
    )

    expect((await dataOf<ImportResult>(res)).applied).toBe(true)
    expect(rowWith((await exportLive()).workbook.tapers, 'code', taper.code)).toEqual(taper)
  })

  it('is the Worker\'s own environment that decides: the same upload that production refuses is accepted by the Worker as the tests run it', async () => {
    const edit = (workbook: RawWorkbook) => {
      workbook.tapers.rows.push(taperRow({ approved_by: 'Somebody Else' }))
    }

    const production = await dry(edit, asProduction(QUALIFIED))
    const testing = await dry(edit, WORKER_ENV)

    expect(production.res.status).toBe(400)
    expect(testing.res.status).toBe(200)
  })
})

describe('what the import logs', () => {
  const spyOnConsole = () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    return () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls.map((call) => call.map((part) => (part instanceof Error ? `${part.name}:${part.message}` : part)))))
  }

  afterEach(() => vi.restoreAllMocks())

  it('never carries a brand, a product name, an ingredient, a rule or a place of sale, whether the upload is applied, dry or refused', async () => {
    const logged = spyOnConsole()
    const [brand, name, ingredient, ruleName, statement, place, invalid] = [word('LogBrand'), word('LogName'), word('Logredient'), word('zqlog'), word('Logstatement'), word('Logplace'), word('Logbad')]
    const product = productRow({ brand, name, ingredients: `Aqua; ${ingredient}` })
    const rule = ruleRow({ name: ruleName, statement: `Commonly reported ${statement}.` })

    await applied((workbook) => {
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push({ ...product })
      workbook.availability.rows.push(availabilityRow(product.code as string, { where_sold: place }))
      workbook.ingredients.rows.push({ ...rule })
    })
    await upload(
      (workbook) => {
        workbook.products.rows.push(productRow({ category: invalid }))
      },
      { dryRun: false, file: xlsxBytes('logs') },
    )
    await upload(() => {}, { baseVersion: (live) => live - 1, dryRun: false, file: xlsxBytes('logs-stale') })

    const text = logged()
    for (const secret of [brand, name, ingredient, ruleName, statement, place, invalid]) expect(text, secret).not.toContain(secret)
  })
})
