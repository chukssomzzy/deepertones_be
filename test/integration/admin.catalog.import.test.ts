import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRITAIN,
  NIGERIA,
  XLSX_MEDIA_TYPE,
  applied,
  archiveKeyPattern,
  archived,
  availabilityRow,
  code,
  counts,
  dataOf,
  diffOf,
  edited,
  errorOf,
  exportLive,
  importRaw,
  latestVersionRow,
  liveRuleNames,
  productRow,
  productsOfBrand,
  rowWith,
  ruleRow,
  rulesVersion,
  sorted,
  upload,
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
      contractVersion: '1.0.0',
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
