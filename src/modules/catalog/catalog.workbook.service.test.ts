import { describe, expect, it } from 'vitest'
import { MemoryWorkbookArchive } from '../../providers/workbook-archive/memory.workbook-archive'
import { REFERENCE_VERSION } from './catalog.reference'
import { diffWorkbooks } from './catalog.workbook.diff'
import { toRawWorkbook } from './catalog.workbook.raw'
import { FakeCatalogWorkbookRepository } from './catalog.workbook.repository.fake'
import { nextRulesVersion } from './catalog.workbook.rules-version'
import { CONTRACT_VERSION, validateWorkbook, type RawRow, type RawWorkbook, type Workbook } from './catalog.workbook.schema'
import { CatalogWorkbookService } from './catalog.workbook.service'

// The service over the fake repository and the memory archive: what the import decides (validation, staleness, the diff, the file, the rules
// version, the lost race) without a database. The same behaviour through the real routes and D1 is in test/integration/admin.catalog.*.test.ts.

const FILE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1])

const product = (over: RawRow = {}): RawRow => ({
  code: 'PRD-ONE', brand: 'Acme', name: 'Gentle Cleanser', variant: null, form: null, category: 'skin', ingredients: 'Aqua; Glycerin', ingredients_source_url: 'https://example.com/one',
  skin_concerns: 'hd_moisture', skin_types: 'all', steps: 'cleanse', frequency: 'am-pm', own_cautions: null, evidence_urls: null, origin: 'sourced', status: 'approved',
  approved_by: 'Dr A', approved_on: '2030-01-02', audited_by: null, audited_on: null, draft_cells: null, ...over,
})
const rule = (over: RawRow = {}): RawRow => ({
  code: 'ING-ZZ-ONE', name: 'zzyzx extractum', aliases: null, kind: 'irritation', strength_limit: null, statement: 'Commonly reported to sting.', source_url: null, helps: null, group: null, clashes_with: null,
  status: 'approved', approved_by: 'Dr A', approved_on: '2030-01-02', audited_by: null, audited_on: null, ...over,
})
const claimWord = (over: RawRow = {}): RawRow => ({ code: 'CLM-WHITENING', phrase: 'whitening', claim: 'lightening', status: 'approved', approved_by: 'Dr A', approved_on: '2030-01-02', audited_by: null, audited_on: null, ...over })
const taper = (over: RawRow = {}): RawRow => ({
  code: 'TPR-STEROID-1', kind: 'steroid', schedule: '1-2: alternate-days; 3-4: weekly; 5: stop', what_to_expect: 'Skin may flare for a few days after each step down. This is expected.',
  see_a_professional_if: 'The redness spreads, or the skin weeps or blisters.', status: 'approved', approved_by: 'Dr A', approved_on: '2030-01-02', audited_by: null, audited_on: null, ...over,
})
const ng: RawRow = { code: 'NG', currency: 'NGN', low_max: 5000, mid_max: 15000, status: 'active' }
const sold = (code = 'PRD-ONE'): RawRow => ({ product_code: code, country: 'NG', price_min: 3000, price_max: 4500, where_sold: null, source_url: null })

const build = () => {
  const repository = new FakeCatalogWorkbookRepository()
  const archive = new MemoryWorkbookArchive({ environment: 'test' })
  let id = 0
  const service = new CatalogWorkbookService({ repository, archive, now: () => new Date('2030-06-15T10:00:00Z'), newId: () => `id-${id++}`, environment: 'test' })
  return { repository, archive, service }
}

/** The live workbook as the export gives it, with `edit` applied. */
const edited = async (service: CatalogWorkbookService, edit: (workbook: RawWorkbook) => void): Promise<{ workbook: RawWorkbook; baseVersion: number }> => {
  const live = await service.exportWorkbook()
  edit(live.workbook)
  return { workbook: live.workbook, baseVersion: live.catalogVersion }
}
const addProduct = (workbook: RawWorkbook, ...rows: RawRow[]) => {
  if (!workbook.countries.rows.some((row) => row.code === 'NG')) workbook.countries.rows.push({ ...ng })
  workbook.products.rows.push(...rows.map((row) => ({ ...row })))
  workbook.availability.rows.push(...rows.map((row) => sold(row.code as string)))
}

describe('CatalogWorkbookService.exportWorkbook', () => {
  it('gives the seeded rules under catalog version 1 and the contract version, with every header', async () => {
    const { service } = build()

    const live = await service.exportWorkbook()

    expect(live).toMatchObject({ catalogVersion: 1, contractVersion: '2.0.0' })
    expect(live.workbook.products).toEqual({ headers: expect.arrayContaining(['code', 'status', 'draft_cells']), rows: [] })
    expect(live.workbook.ingredients.rows.length).toBeGreaterThan(0)
    expect(validateWorkbook(live.workbook)).toMatchObject({ ok: true })
  })

  it('gives the two new tabs with their headers, empty, and the two new Ingredients columns on every seeded rule, empty', async () => {
    const { service } = build()

    const { workbook } = await service.exportWorkbook()

    expect(workbook.claimWords).toEqual({ headers: ['code', 'phrase', 'claim', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'], rows: [] })
    expect(workbook.tapers).toEqual({
      headers: ['code', 'kind', 'schedule', 'what_to_expect', 'see_a_professional_if', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
      rows: [],
    })
    expect(workbook.ingredients.headers).toEqual(expect.arrayContaining(['group', 'clashes_with']))
    expect(workbook.ingredients.rows.every((row) => row.group === null && row.clashes_with === null)).toBe(true)
  })
})

describe('CatalogWorkbookService.importWorkbook', () => {
  it('reports an unchanged export as an empty diff, applied nothing, and writes no file', async () => {
    const { service, archive } = build()
    const { workbook, baseVersion } = await edited(service, () => {})

    const result = await service.importWorkbook({ workbook, file: null, baseVersion, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(result).toEqual({
      applied: false,
      catalogVersion: 1,
      diff: { ...Object.fromEntries(['products', 'availability', 'ingredients', 'countries', 'claimWords', 'tapers'].map((tab) => [tab, { added: [], updated: [], retired: [], reactivated: [] }])), newProducts: [] },
    })
    expect(archive.stored.size).toBe(0)
  })

  it('lists a new product row in a dry run, and writes nothing', async () => {
    const { service, repository, archive } = build()
    const { workbook, baseVersion } = await edited(service, (w) => addProduct(w, product()))

    const result = await service.importWorkbook({ workbook, file: null, baseVersion, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(result.diff.products.added).toEqual(['PRD-ONE'])
    expect(result.diff.availability.added).toEqual(['PRD-ONE:NG'])
    expect(result.diff.newProducts).toEqual([{ code: 'PRD-ONE', brand: 'Acme', name: 'Gentle Cleanser', variant: null, form: null }])
    expect(await repository.catalogVersion()).toBe(1)
    expect(archive.stored.size).toBe(0)
  })

  it('applies with a file: the next version, the file archived under it, the rows live and the rules version unchanged', async () => {
    const { service, repository, archive } = build()
    const { workbook, baseVersion } = await edited(service, (w) => addProduct(w, product()))

    const result = await service.importWorkbook({ workbook, file: FILE, baseVersion, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(result).toMatchObject({ applied: true, catalogVersion: 2 })
    expect([...archive.stored.keys()]).toEqual([expect.stringMatching(/^workbooks\/test\/2-[0-9a-f-]{36}\.xlsx$/)])
    expect(await repository.liveRules().then((rules) => rules.version)).toBe(REFERENCE_VERSION)
    expect((await service.approvedFor({ country: 'NG', step: 'cleanse' })).map((row) => row.code)).toEqual(['PRD-ONE'])
    expect((await service.exportWorkbook()).catalogVersion).toBe(2)
  })

  it('refuses an apply without a file (or with an empty one) as a ValidationError, and writes nothing', async () => {
    const { service, repository } = build()
    const { workbook, baseVersion } = await edited(service, (w) => addProduct(w, product()))

    for (const file of [null, new Uint8Array(0)]) {
      await expect(service.importWorkbook({ workbook, file, baseVersion, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })).rejects.toMatchObject({ name: 'ValidationError', code: 'CATALOG_FILE_REQUIRED' })
    }
    expect(await repository.catalogVersion()).toBe(1)
  })

  it.each([
    ['over 10 MB', new Uint8Array(10 * 1024 * 1024 + 1).fill(0x50), 'CATALOG_FILE_TOO_LARGE'],
    ['not a zip', new TextEncoder().encode('just some text'), 'CATALOG_FILE_NOT_XLSX'],
    ['a zip that is cut short', new Uint8Array([0x50, 0x4b, 0x03]), 'CATALOG_FILE_NOT_XLSX'],
  ])('refuses a file that is %s as a ValidationError, archives nothing and writes nothing', async (_, file, code) => {
    const { service, repository, archive } = build()
    const { workbook, baseVersion } = await edited(service, (w) => addProduct(w, product()))

    await expect(service.importWorkbook({ workbook, file, baseVersion, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })).rejects.toMatchObject({ name: 'ValidationError', code })

    expect(archive.stored.size).toBe(0)
    expect(await repository.catalogVersion()).toBe(1)
  })

  it('answers 503 CATALOG_ARCHIVE_FAILED as an UnavailableError when the file cannot be archived, and writes nothing', async () => {
    const { repository } = build()
    const archive = { put: async () => Promise.reject(new Error('r2 is down')) }
    const service = new CatalogWorkbookService({ repository, archive, now: () => new Date('2030-06-15T10:00:00Z'), newId: () => 'id', environment: 'test' })
    const { workbook, baseVersion } = await edited(service, (w) => addProduct(w, product()))

    await expect(service.importWorkbook({ workbook, file: FILE, baseVersion, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })).rejects.toMatchObject({ name: 'UnavailableError', code: 'CATALOG_ARCHIVE_FAILED' })

    expect(await repository.catalogVersion()).toBe(1)
    expect((await service.exportWorkbook()).workbook.products.rows).toEqual([])
  })

  it('refuses a change that would need more statements than one batch may hold as CATALOG_TOO_LARGE, for a dry run too, before it archives anything', async () => {
    const { service, repository, archive } = build()
    const { workbook, baseVersion } = await edited(service, (w) => addProduct(w, product()))
    repository.statementCount = () => 901

    for (const dryRun of [true, false]) {
      await expect(service.importWorkbook({ workbook, file: FILE, baseVersion, dryRun, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })).rejects.toMatchObject({ name: 'ValidationError', code: 'CATALOG_TOO_LARGE' })
    }
    expect(archive.stored.size).toBe(0)
    expect(await repository.catalogVersion()).toBe(1)
  })

  it('takes a change of exactly 900 statements', async () => {
    const { service, repository } = build()
    const { workbook, baseVersion } = await edited(service, (w) => addProduct(w, product()))
    repository.statementCount = () => 900

    await expect(service.importWorkbook({ workbook, file: null, baseVersion, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })).resolves.toMatchObject({ applied: false })
  })

  it('throws CATALOG_INVALID with the problems for a workbook that breaks the contract, before anything else', async () => {
    const { service } = build()
    const { workbook, baseVersion } = await edited(service, (w) => addProduct(w, product({ category: 'nonsense' })))

    await expect(service.importWorkbook({ workbook, file: FILE, baseVersion: baseVersion + 5, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'CATALOG_INVALID',
      details: { problems: [{ tab: 'products', row: 2, column: 'category', rule: 'NOT_IN_VOCABULARY' }] },
    })
  })

  it.each([0, 2])('throws CATALOG_STALE as a ConflictError for base version %i when 1 is live', async (base) => {
    const { service } = build()
    const { workbook } = await edited(service, () => {})

    await expect(service.importWorkbook({ workbook, file: FILE, baseVersion: base, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })).rejects.toMatchObject({ name: 'ConflictError', code: 'CATALOG_STALE' })
  })

  it('reports CATALOG_STALE when the repository says the batch lost the race, and leaves nothing applied', async () => {
    const { service, repository } = build()
    const { workbook, baseVersion } = await edited(service, (w) => addProduct(w, product()))
    // Another upload lands between this one's read and its write.
    const apply = repository.applyWorkbook.bind(repository)
    repository.applyWorkbook = async (plan) => apply({ ...plan, baseVersion: plan.baseVersion - 1 })

    await expect(service.importWorkbook({ workbook, file: FILE, baseVersion, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })).rejects.toMatchObject({ code: 'CATALOG_STALE' })
    expect(await repository.catalogVersion()).toBe(1)
  })

  it('retires a product and its availability when the code is left out, and reactivates it when it comes back', async () => {
    const { service } = build()
    const first = await edited(service, (w) => addProduct(w, product()))
    await service.importWorkbook({ ...first, file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    const gone = await edited(service, (w) => {
      w.products.rows = []
      w.availability.rows = []
    })
    const retired = await service.importWorkbook({ ...gone, file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
    const back = await edited(service, (w) => {
      w.products.rows = w.products.rows.filter((row) => row.code !== 'PRD-ONE')
      addProduct(w, product())
    })
    const reactivated = await service.importWorkbook({ ...back, file: null, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(retired.diff.products.retired).toEqual(['PRD-ONE'])
    expect(retired.diff.availability.retired).toEqual(['PRD-ONE:NG'])
    expect(reactivated.diff.products.reactivated).toEqual(['PRD-ONE'])
  })

  it('moves the rules version only when the approved rules do', async () => {
    const { service, repository } = build()
    const versionNow = async () => (await repository.liveRules()).version
    const draft = await edited(service, (w) => w.ingredients.rows.push(rule({ status: 'draft', approved_by: null, approved_on: null })))
    await service.importWorkbook({ ...draft, file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
    expect(await versionNow()).toBe(REFERENCE_VERSION)

    const approved = await edited(service, (w) => {
      Object.assign(w.ingredients.rows.find((row) => row.code === 'ING-ZZ-ONE')!, rule())
    })
    await service.importWorkbook({ ...approved, file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
    const added = await versionNow()
    expect(added).toMatch(/^rules-[0-9a-f]{16}$/)

    const removed = await edited(service, (w) => {
      w.ingredients.rows = w.ingredients.rows.filter((row) => row.code !== 'ING-ZZ-ONE')
    })
    await service.importWorkbook({ ...removed, file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
    // Back to the seed set: the seed's version, not a new one.
    expect(await versionNow()).toBe(REFERENCE_VERSION)
  })
})

describe('CatalogWorkbookService.importWorkbook: the contract version', () => {
  it.each([
    ['an older contract', '1.0.0'],
    ['a newer contract', '9.9.9'],
    ['no version at all', ''],
  ])('refuses a file made for %s with a ConflictError CONTRACT_MISMATCH, for a dry run and an apply alike, and writes nothing', async (_what, contractVersion) => {
    const { service, repository, archive } = build()
    const { workbook, baseVersion } = await edited(service, (w) => addProduct(w, product()))

    for (const dryRun of [true, false]) {
      await expect(service.importWorkbook({ workbook, file: FILE, baseVersion, dryRun, uploadedBy: 'T', contractVersion })).rejects.toMatchObject({ name: 'ConflictError', code: 'CONTRACT_MISMATCH' })
    }
    expect(archive.stored.size).toBe(0)
    expect(await repository.catalogVersion()).toBe(1)
  })

  it('takes the contract version of this checkout', async () => {
    const { service } = build()
    const { workbook, baseVersion } = await edited(service, () => {})

    await expect(service.importWorkbook({ workbook, file: null, baseVersion, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })).resolves.toMatchObject({ applied: false })
  })

  it('says so before it says the workbook is invalid or stale, since a file made for another contract cannot be judged by this one', async () => {
    const { service } = build()
    const { workbook, baseVersion } = await edited(service, (w) => addProduct(w, product({ category: 'nonsense' })))

    await expect(service.importWorkbook({ workbook, file: FILE, baseVersion: baseVersion + 5, dryRun: true, uploadedBy: 'T', contractVersion: '1.0.0' })).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' })
  })
})

describe('CatalogWorkbookService.importWorkbook: claim words and tapers', () => {
  const emptyTab = { added: [], updated: [], retired: [], reactivated: [] }

  it('reports a new claim word and a new taper as added in a dry run, per tab, and writes nothing', async () => {
    const { service, repository } = build()
    const { workbook, baseVersion } = await edited(service, (w) => {
      w.claimWords.rows.push(claimWord())
      w.tapers.rows.push(taper())
    })

    const result = await service.importWorkbook({ workbook, file: null, baseVersion, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(result.diff.claimWords).toEqual({ ...emptyTab, added: ['CLM-WHITENING'] })
    expect(result.diff.tapers).toEqual({ ...emptyTab, added: ['TPR-STEROID-1'] })
    expect(result.diff.products).toEqual(emptyTab)
    expect((await service.exportWorkbook()).workbook.tapers.rows).toEqual([])
    expect(await repository.catalogVersion()).toBe(1)
  })

  it('stores them on apply, and the export gives them back exactly as the import took them, schedule written the canonical way', async () => {
    const { service } = build()
    const first = await edited(service, (w) => {
      w.claimWords.rows.push(claimWord({ audited_by: 'Nneka Audit', audited_on: '2030-01-03' }))
      w.tapers.rows.push(taper({ schedule: '1-2:alternate-days;3-4:  weekly;5:stop' }))
    })

    const applied = await service.importWorkbook({ ...first, file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(applied).toMatchObject({ applied: true, catalogVersion: 2 })
    const live = await service.exportWorkbook()
    expect(live.workbook.claimWords.rows).toEqual([claimWord({ audited_by: 'Nneka Audit', audited_on: '2030-01-03' })])
    expect(live.workbook.tapers.rows).toEqual([taper({ schedule: '1-2: alternate-days; 3-4: weekly; 5: stop' })])
    // Exported and imported again, nothing is left to change.
    const again = await service.importWorkbook({ workbook: live.workbook, file: null, baseVersion: live.catalogVersion, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
    expect(again.diff).toMatchObject({ claimWords: emptyTab, tapers: emptyTab })
  })

  it('reports an edited claim word or taper as updated, and only that one', async () => {
    const { service } = build()
    await service.importWorkbook({
      ...(await edited(service, (w) => {
        w.claimWords.rows.push(claimWord(), claimWord({ code: 'CLM-BLEACHING', phrase: 'bleaching' }))
        w.tapers.rows.push(taper(), taper({ code: 'TPR-LIGHTENING-1', kind: 'lightening-agent' }))
      })),
      file: FILE,
      dryRun: false,
      uploadedBy: 'T',
      contractVersion: CONTRACT_VERSION,
    })

    const change = await edited(service, (w) => {
      w.claimWords.rows.find((row) => row.code === 'CLM-BLEACHING')!.phrase = 'skin bleaching'
      w.tapers.rows.find((row) => row.code === 'TPR-STEROID-1')!.schedule = '1-3: alternate-days; 4: stop'
    })
    const result = await service.importWorkbook({ ...change, file: null, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(result.diff.claimWords).toEqual({ ...emptyTab, updated: ['CLM-BLEACHING'] })
    expect(result.diff.tapers).toEqual({ ...emptyTab, updated: ['TPR-STEROID-1'] })
  })

  it('compares a schedule by what it means, not by how the spaces were typed', async () => {
    const { service } = build()
    await service.importWorkbook({ ...(await edited(service, (w) => w.tapers.rows.push(taper()))), file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    const loose = await edited(service, (w) => {
      w.tapers.rows[0]!.schedule = '1-2:alternate-days ;3-4 : weekly;  5:stop'
    })
    const result = await service.importWorkbook({ ...loose, file: null, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(result.diff.tapers).toEqual(emptyTab)
  })

  it('never deletes: a claim word or a taper the upload leaves out is retired in place, still in the export, and comes back as reactivated', async () => {
    const { service } = build()
    await service.importWorkbook({
      ...(await edited(service, (w) => {
        w.claimWords.rows.push(claimWord())
        w.tapers.rows.push(taper())
      })),
      file: FILE,
      dryRun: false,
      uploadedBy: 'T',
      contractVersion: CONTRACT_VERSION,
    })

    const gone = await edited(service, (w) => {
      w.claimWords.rows = []
      w.tapers.rows = []
    })
    const retired = await service.importWorkbook({ ...gone, file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(retired.diff.claimWords).toEqual({ ...emptyTab, retired: ['CLM-WHITENING'] })
    expect(retired.diff.tapers).toEqual({ ...emptyTab, retired: ['TPR-STEROID-1'] })
    const live = await service.exportWorkbook()
    expect(live.workbook.claimWords.rows).toEqual([expect.objectContaining({ code: 'CLM-WHITENING', phrase: 'whitening', status: 'retired' })])
    expect(live.workbook.tapers.rows).toEqual([expect.objectContaining({ code: 'TPR-STEROID-1', schedule: '1-2: alternate-days; 3-4: weekly; 5: stop', status: 'retired' })])

    const back = await edited(service, (w) => {
      w.claimWords.rows = [claimWord()]
      w.tapers.rows = [taper()]
    })
    const reactivated = await service.importWorkbook({ ...back, file: null, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
    expect(reactivated.diff.claimWords).toEqual({ ...emptyTab, reactivated: ['CLM-WHITENING'] })
    expect(reactivated.diff.tapers).toEqual({ ...emptyTab, reactivated: ['TPR-STEROID-1'] })
  })

  it('reports a row that is retired by its status as retired, not as updated', async () => {
    const { service } = build()
    await service.importWorkbook({ ...(await edited(service, (w) => w.tapers.rows.push(taper()))), file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    const change = await edited(service, (w) => {
      w.tapers.rows[0]!.status = 'retired'
    })
    const result = await service.importWorkbook({ ...change, file: null, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(result.diff.tapers).toEqual({ ...emptyTab, retired: ['TPR-STEROID-1'] })
  })

  it('does not move the rules version: claim words and tapers are not ingredient rules', async () => {
    const { service, repository } = build()

    await service.importWorkbook({
      ...(await edited(service, (w) => {
        w.claimWords.rows.push(claimWord())
        w.tapers.rows.push(taper())
      })),
      file: FILE,
      dryRun: false,
      uploadedBy: 'T',
      contractVersion: CONTRACT_VERSION,
    })

    expect((await repository.liveRules()).version).toBe(REFERENCE_VERSION)
  })
})

describe('CatalogWorkbookService.importWorkbook: rule metadata (group and clashes_with) is not part of the rules version', () => {
  /** Puts a retinoid and an exfoliating acid on two rules, with the clash each way: the same two rules, now with metadata. */
  const withGroups = (workbook: RawWorkbook) => {
    Object.assign(workbook.ingredients.rows[0]!, { group: 'retinoid', clashes_with: 'exfoliating-acid' })
    Object.assign(workbook.ingredients.rows[1]!, { group: 'exfoliating-acid', clashes_with: 'retinoid' })
  }

  it('keeps the seed version seed-2026-10 when groups and clashes are put on the seeded rules, and stores them, reporting those rules as updated', async () => {
    const { service, repository } = build()
    const seeded = await edited(service, () => {})
    const [one, two] = [seeded.workbook.ingredients.rows[0]!.code as string, seeded.workbook.ingredients.rows[1]!.code as string]

    const result = await service.importWorkbook({ ...(await edited(service, withGroups)), file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(result).toMatchObject({ applied: true, catalogVersion: 2 })
    expect([...result.diff.ingredients.updated].sort()).toEqual([one, two].sort())
    expect((await repository.liveRules()).version).toBe(REFERENCE_VERSION)
    const live = await service.exportWorkbook()
    expect(live.workbook.ingredients.rows.find((row) => row.code === one)).toMatchObject({ group: 'retinoid', clashes_with: 'exfoliating-acid' })
    expect(live.workbook.ingredients.rows.find((row) => row.code === two)).toMatchObject({ group: 'exfoliating-acid', clashes_with: 'retinoid' })
  })

  it('keeps a version that is not the seed\'s when the metadata of an approved rule changes, and changes it only when what the matcher reads changes', async () => {
    const { service, repository } = build()
    await service.importWorkbook({ ...(await edited(service, (w) => w.ingredients.rows.push(rule({ group: 'steroid' })))), file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
    const before = (await repository.liveRules()).version
    expect(before).toMatch(/^rules-[0-9a-f]{16}$/)

    const regrouped = await service.importWorkbook({
      ...(await edited(service, (w) => Object.assign(w.ingredients.rows.find((row) => row.code === 'ING-ZZ-ONE')!, { group: 'lightening-agent' }))),
      file: FILE,
      dryRun: false,
      uploadedBy: 'T',
      contractVersion: CONTRACT_VERSION,
    })
    expect(regrouped.diff.ingredients.updated).toEqual(['ING-ZZ-ONE'])
    expect((await repository.liveRules()).version).toBe(before)

    await service.importWorkbook({
      ...(await edited(service, (w) => Object.assign(w.ingredients.rows.find((row) => row.code === 'ING-ZZ-ONE')!, { statement: 'Commonly reported to burn.' }))),
      file: FILE,
      dryRun: false,
      uploadedBy: 'T',
      contractVersion: CONTRACT_VERSION,
    })
    expect((await repository.liveRules()).version).not.toBe(before)
  })

  it('still restores the seed version when the seed rules come back, whatever groups they carry', async () => {
    const { service, repository } = build()
    await service.importWorkbook({ ...(await edited(service, (w) => w.ingredients.rows.push(rule({ group: 'steroid' })))), file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
    expect((await repository.liveRules()).version).not.toBe(REFERENCE_VERSION)

    await service.importWorkbook({ ...(await edited(service, (w) => (w.ingredients.rows = w.ingredients.rows.filter((row) => row.code !== 'ING-ZZ-ONE')))), file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect((await repository.liveRules()).version).toBe(REFERENCE_VERSION)
  })
})

describe('nextRulesVersion', () => {
  const entry = (name: string, rule = 'Commonly reported.') => ({ name, aliases: [], kind: 'irritation' as const, rule, source: null })

  it('keeps the current version for the same set, and gives one hash for one set however it is reached', async () => {
    const current = { version: 'rules-custom', entries: [entry('a')] }

    expect(await nextRulesVersion(current, [entry('a')])).toBe('rules-custom')
    const [one, two] = [await nextRulesVersion(current, [entry('a'), entry('b')]), await nextRulesVersion({ version: 'rules-other', entries: [entry('z')] }, [entry('a'), entry('b')])]
    expect(one).toMatch(/^rules-[0-9a-f]{16}$/)
    expect(two).toBe(one)
  })

  it('does not change with the order of a rule\'s aliases, which are a set', async () => {
    const current = { version: 'rules-custom', entries: [{ ...entry('a'), aliases: ['x', 'y'] }] }

    expect(await nextRulesVersion(current, [{ ...entry('a'), aliases: ['y', 'x'] }])).toBe('rules-custom')
    expect(await nextRulesVersion({ version: 'rules-old', entries: [] }, [{ ...entry('a'), aliases: ['x', 'y'] }])).toBe(await nextRulesVersion({ version: 'rules-old', entries: [] }, [{ ...entry('a'), aliases: ['y', 'x'] }]))
  })

  it('changes with any field the matcher reads', async () => {
    const current = { version: 'rules-custom', entries: [entry('a')] }

    expect(await nextRulesVersion(current, [entry('a', 'Another statement.')])).not.toBe('rules-custom')
    expect(await nextRulesVersion(current, [{ ...entry('a'), source: 'https://example.com' }])).not.toBe('rules-custom')
    expect(await nextRulesVersion(current, [{ ...entry('a'), aliases: ['b'] }])).not.toBe('rules-custom')
  })
})

describe('diffWorkbooks and toRawWorkbook', () => {
  const parse = (raw: RawWorkbook): Workbook => {
    const result = validateWorkbook(raw)
    if (!result.ok) throw new Error(JSON.stringify(result.problems))
    return result.workbook
  }

  it('reads a workbook back from its raw form unchanged, so an export is always an empty diff', async () => {
    const { service } = build()
    const { workbook } = await edited(service, (w) => addProduct(w, product({ own_cautions: 'irritation; drying', evidence_urls: 'https://example.com/a; https://example.com/b' })))
    const parsed = parse(workbook)

    expect(parse(toRawWorkbook(parsed))).toEqual(parsed)
    expect(Object.values(diffWorkbooks(parsed, parse(toRawWorkbook(parsed)))).every((tab) => Object.values(tab).every((codes) => codes.length === 0))).toBe(true)
  })

  it('compares lists by what they mean, not by how the separators were typed', async () => {
    const { service } = build()
    const { workbook } = await edited(service, (w) => addProduct(w, product({ ingredients: 'Aqua; Glycerin' })))
    const loose = structuredClone(workbook)
    loose.products.rows[0]!.ingredients = ' Aqua ;Glycerin;'

    expect(diffWorkbooks(parse(workbook), parse(loose)).products).toEqual({ added: [], updated: [], retired: [], reactivated: [] })
  })
})
