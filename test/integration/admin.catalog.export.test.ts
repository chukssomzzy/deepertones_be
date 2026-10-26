import { describe, expect, it } from 'vitest'
import { REFERENCE, REFERENCE_VERSION } from '../../src/modules/catalog/catalog.reference'
import {
  APPROVED_ON,
  BRITAIN,
  CONTRACT_VERSION,
  EMPTY_DIFF,
  HEADERS,
  NIGERIA,
  TABS,
  applied,
  availabilityRow,
  claimWordRow,
  dataOf,
  exportLive,
  exportRaw,
  importRaw,
  productRow,
  rowWith,
  ruleRow,
  rulesVersion,
  sorted,
  taperRow,
  upload,
  withCountry,
  type ImportResult,
} from './admin.catalog.support'

// GET /api/v1/admin/catalog/export through the Worker, against real local D1. What it serves is the workbook as the catalog holds it: every tab with
// its full header row, rows in the form the import takes (lists joined with "; ", dates as YYYY-MM-DD, an empty cell null), retired rows included.
// So an export fed straight back to the import changes nothing. The first tests read the freshly migrated, seeded database and write nothing, so they
// stay first; the file runs in order, and every later test builds on what is live by exporting it first.

describe('GET /api/v1/admin/catalog/export on a freshly migrated database', () => {
  it('serves { catalogVersion, contractVersion, workbook } as a success', async () => {
    const res = await exportRaw()

    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; status: number; data: Record<string, unknown> }
    expect(body).toMatchObject({ success: true, status: 200 })
    expect(Object.keys(body.data).sort()).toEqual(['catalogVersion', 'contractVersion', 'workbook'])
    expect(Object.keys(body.data.workbook as object).sort()).toEqual([...TABS].sort())
  })

  it('is catalog version 1, served under the current contract version 2.1.0 (the migration stamped the version it seeded 1.0.0, which the export does not read)', async () => {
    const live = await exportLive()

    expect(live.catalogVersion).toBe(1)
    expect(live.contractVersion).toBe(CONTRACT_VERSION)
    expect(CONTRACT_VERSION).toBe('2.1.0')
    expect(await rulesVersion()).toBe(REFERENCE_VERSION)
  })

  it.each(TABS)('carries the full header row of the %s tab, in the workbook\'s order, even with no rows', async (tab) => {
    const live = await exportLive()

    expect(live.workbook[tab].headers).toEqual([...HEADERS[tab]])
  })

  it('holds the seeded ingredient rules, one approved row for each REFERENCE entry, and nothing in the other tabs', async () => {
    const { workbook } = await exportLive()

    expect(workbook.products.rows).toEqual([])
    expect(workbook.availability.rows).toEqual([])
    expect(workbook.countries.rows).toEqual([])
    expect(workbook.claimWords.rows).toEqual([])
    expect(workbook.tapers.rows).toEqual([])
    expect(workbook.ingredients.rows).toHaveLength(REFERENCE.length)
    for (const entry of REFERENCE) {
      const rows = workbook.ingredients.rows.filter((row) => row.name === entry.name && row.kind === entry.kind)
      expect(rows, `${entry.name} / ${entry.kind}`).toHaveLength(1)
      expect(rows[0], `${entry.name} / ${entry.kind}`).toMatchObject({
        aliases: entry.aliases.length === 0 ? null : entry.aliases.join('; '),
        statement: entry.rule,
        source_url: entry.source,
        status: 'approved',
        approved_by: 'reference seed',
        approved_on: '2026-10-21',
        strength_limit: null,
        helps: null,
        group: null,
        clashes_with: null,
        audited_by: null,
        audited_on: null,
      })
    }
  })

  it('serves a workbook that passes the contract it declares, so an unedited export is always a valid upload', async () => {
    // Loaded here, not at the top: the schema module is renamed in the change this one builds on, and a missing module should fail this test alone.
    const { validateWorkbook } = await import('../../src/modules/catalog/catalog.workbook.schema')

    const { workbook } = await exportLive()

    expect(validateWorkbook(workbook)).toMatchObject({ ok: true })
  })

  it('round trips: importing the export as a dry run changes nothing, adds no product, and leaves the live version where it was', async () => {
    const live = await exportLive()

    const res = await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: true })

    expect(res.status).toBe(200)
    const data = await dataOf<ImportResult>(res)
    expect(data).toEqual({ applied: false, catalogVersion: live.catalogVersion, diff: EMPTY_DIFF })
  })
})

describe('GET /api/v1/admin/catalog/export after an upload', () => {
  const product = productRow({ variant: 'Night', form: 'cream', key_ingredient: 'Azelaic acid', strength: '10%', skin_types: 'all', own_cautions: 'irritation; drying', evidence_urls: 'https://example.com/study-1; https://example.com/study-2', audited_by: 'Dr B. Auditor', audited_on: APPROVED_ON })
  const rule = ruleRow({ aliases: 'zq extractum oil; zq extract', strength_limit: '2% in leave-on products', source_url: 'https://example.com/rule', helps: 'hd_redness; hd_texture', audited_by: 'Dr B. Auditor', audited_on: APPROVED_ON })
  const availability = availabilityRow(product.code as string, { where_sold: null, source_url: 'https://example.com/price-list' })

  it('gives back every row as it was uploaded, in the form the import takes, with numbers as numbers and an empty cell as null', async () => {
    await applied((workbook) => {
      withCountry(workbook, NIGERIA)
      workbook.products.rows.push({ ...product })
      workbook.availability.rows.push({ ...availability })
      workbook.ingredients.rows.push({ ...rule })
    })

    const live = await exportLive()

    expect(rowWith(live.workbook.products, 'code', product.code)).toEqual(product)
    expect(rowWith(live.workbook.availability, 'product_code', product.code)).toEqual(availability)
    expect(rowWith(live.workbook.ingredients, 'code', rule.code)).toEqual(rule)
    expect(rowWith(live.workbook.countries, 'code', 'NG')).toEqual(NIGERIA)
  })

  it('gives back a claim word, a taper and a rule\'s group and clashes_with as they were uploaded, the schedule written one way whatever way it was typed', async () => {
    const claim = claimWordRow({ audited_by: 'Dr B. Auditor', audited_on: APPROVED_ON })
    const taper = taperRow({ kind: 'lightening-agent', audited_by: 'Dr B. Auditor', audited_on: APPROVED_ON })
    const [one, other] = [ruleRow({ group: 'retinoid', clashes_with: 'exfoliating-acid' }), ruleRow({ group: 'exfoliating-acid', clashes_with: 'retinoid' })]

    await applied((workbook) => {
      workbook.claimWords.rows.push({ ...claim })
      workbook.tapers.rows.push({ ...taper, schedule: '1-2:alternate-days;3-4:  weekly ;5:stop' })
      workbook.ingredients.rows.push({ ...one }, { ...other })
    })

    const live = await exportLive()
    expect(rowWith(live.workbook.claimWords, 'code', claim.code)).toEqual(claim)
    expect(rowWith(live.workbook.tapers, 'code', taper.code)).toEqual({ ...taper, schedule: '1-2: alternate-days; 3-4: weekly; 5: stop' })
    expect(rowWith(live.workbook.ingredients, 'code', one.code)).toEqual(one)
    expect(rowWith(live.workbook.ingredients, 'code', other.code)).toEqual(other)
  })

  it('joins lists with "; " however the upload separated them, and the dates stay YYYY-MM-DD', async () => {
    const tight = productRow({ ingredients: 'Aqua;Glycerin ;  Cetearyl Alcohol;', skin_concerns: 'hd_redness;hd_moisture', skin_types: 'combination;dry', approved_on: APPROVED_ON })

    await applied((workbook) => {
      workbook.products.rows.push({ ...tight })
    })

    const exported = rowWith((await exportLive()).workbook.products, 'code', tight.code)
    expect(exported).toMatchObject({ ingredients: 'Aqua; Glycerin; Cetearyl Alcohol', skin_concerns: 'hd_redness; hd_moisture', skin_types: 'combination; dry', approved_on: APPROVED_ON })
  })

  it('serves the next catalog version after an apply, and the same one after a dry run', async () => {
    const before = await exportLive()

    await applied((workbook) => {
      workbook.products.rows.push(productRow())
    })
    const afterApply = await exportLive()
    await upload((workbook) => {
      workbook.products.rows.push(productRow())
    }, { dryRun: true })
    const afterDryRun = await exportLive()

    expect(afterApply.catalogVersion).toBe(before.catalogVersion + 1)
    expect(afterDryRun.catalogVersion).toBe(afterApply.catalogVersion)
  })

  it('still round trips: the export of a catalog that holds products, availability, rules and countries imports as an empty diff', async () => {
    const live = await exportLive()

    const data = await dataOf<ImportResult>(await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: true }))

    expect(sorted(data.diff)).toEqual(EMPTY_DIFF)
    expect(data.catalogVersion).toBe(live.catalogVersion)
  })

  it('round trips whatever way the lists are separated: "a;b" where the export has "a; b" is no change, because rows are compared by what they mean', async () => {
    const live = await exportLive()
    const reseparated = structuredClone(live.workbook)
    for (const row of reseparated.products.rows) {
      for (const column of ['ingredients', 'skin_concerns', 'skin_types', 'steps', 'own_cautions', 'evidence_urls'] as const) {
        const cell = row[column]
        if (typeof cell === 'string') row[column] = cell.replaceAll('; ', ';')
      }
    }

    const data = await dataOf<ImportResult>(await importRaw({ workbook: reseparated, baseVersion: live.catalogVersion, dryRun: true }))

    expect(sorted(data.diff)).toEqual(EMPTY_DIFF)
  })

  it('includes a retired country, and keeps it as it was, so the export always holds every code that ever was', async () => {
    await applied((workbook) => withCountry(workbook, BRITAIN))
    await applied((workbook) => {
      workbook.countries.rows = workbook.countries.rows.filter((row) => row.code !== 'GB')
    })

    const retired = rowWith((await exportLive()).workbook.countries, 'code', 'GB')

    expect(retired).toEqual({ ...BRITAIN, status: 'retired' })
  })
})
