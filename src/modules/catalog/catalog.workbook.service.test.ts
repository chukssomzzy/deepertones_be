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
const guide = (over: RawRow = {}): RawRow => ({
  step: 'cleanse', goal: null, what_it_does: 'Lifts dirt off your skin.', look_for: 'A gentle, fragrance-free wash.', for_deeper_skin: 'Skip harsh scrubs: they can leave dark marks.',
  look_for_when_pregnant: null, status: 'approved', approved_by: 'Dr A', approved_on: '2030-01-02', audited_by: null, audited_on: null, ...over,
})
/** The four approved base rows, each saying its own step so a test can tell which one it was given. */
const baseGuides = (): RawRow[] =>
  ['cleanse', 'treat', 'moisturise', 'protect'].map((step) => guide({ step, what_it_does: `What ${step} does.`, look_for: `What to look for in ${step}.`, for_deeper_skin: `Deeper skin and ${step}.` }))
const ng: RawRow = { code: 'NG', currency: 'NGN', low_max: 5000, mid_max: 15000, status: 'active' }
const sold = (code = 'PRD-ONE'): RawRow => ({ product_code: code, country: 'NG', price_min: 3000, price_max: 4500, where_sold: null, source_url: null })

const build = () => {
  const repository = new FakeCatalogWorkbookRepository()
  const archive = new MemoryWorkbookArchive({ environment: 'test' })
  let id = 0
  const service = new CatalogWorkbookService({ repository, archive, now: () => new Date('2030-06-15T10:00:00Z'), newId: () => `id-${id++}`, environment: 'test' })
  return { repository, archive, service }
}

/**
 * The live workbook as the export gives it, with `edit` applied. A catalog that has never had guides exports an empty Guides tab, which the contract refuses, so
 * unless the test is about guides (`guides: false`) the base row of each step the edit leaves without one is added, as the team fills them in before an import.
 */
const edited = async (service: CatalogWorkbookService, edit: (workbook: RawWorkbook) => void, options: { guides?: boolean } = {}): Promise<{ workbook: RawWorkbook; baseVersion: number }> => {
  const live = await service.exportWorkbook()
  edit(live.workbook)
  if (options.guides !== false) {
    for (const base of baseGuides()) {
      if (!live.workbook.guides.rows.some((row) => row.step === base.step && row.goal === null && row.status === 'approved')) live.workbook.guides.rows.push(base)
    }
  }
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

    expect(live).toMatchObject({ catalogVersion: 1, contractVersion: '2.2.0' })
    expect(live.workbook.products).toEqual({ headers: expect.arrayContaining(['code', 'status', 'draft_cells']), rows: [] })
    expect(live.workbook.ingredients.rows.length).toBeGreaterThan(0)
  })

  it('has no guides until the team writes them, so a fresh export fails the contract on nothing but the base rows of the Guides tab', async () => {
    const { service } = build()

    const { workbook } = await service.exportWorkbook()

    expect(workbook.guides.rows).toEqual([])
    expect(validateWorkbook(workbook)).toEqual({ ok: false, problems: [{ tab: 'guides', row: 1, column: 'step', rule: 'GUIDE_BASE_MISSING' }] })
  })

  it('gives the Guides tab with its headers, empty', async () => {
    const { service } = build()

    const { workbook } = await service.exportWorkbook()

    expect(workbook.guides).toEqual({
      headers: ['step', 'goal', 'what_it_does', 'look_for', 'for_deeper_skin', 'look_for_when_pregnant', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
      rows: [],
    })
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
    await service.importWorkbook({ ...(await edited(service, () => {})), file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
    archive.stored.clear()
    const { workbook, baseVersion } = await edited(service, () => {})

    const result = await service.importWorkbook({ workbook, file: null, baseVersion, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(result).toEqual({
      applied: false,
      catalogVersion: 2,
      diff: { ...Object.fromEntries(['products', 'availability', 'ingredients', 'countries', 'claimWords', 'tapers', 'guides'].map((tab) => [tab, { added: [], updated: [], retired: [], reactivated: [] }])), newProducts: [] },
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
    ['the 2.0.0 contract (before key_ingredient and strength)', '2.0.0'],
    ['the 2.1.0 contract (before the Guides tab)', '2.1.0'],
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

// ---- the reads the shelf verdict builds on (spec #171, slice D1): what the floor and the fit judge are given, read by the system with no session ----

/** Applies `edit` to the live export and imports it, as an owner's upload does. */
const applied = async (service: CatalogWorkbookService, edit: (workbook: RawWorkbook) => void) => {
  const result = await service.importWorkbook({ ...(await edited(service, edit)), file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
  expect(result.applied).toBe(true)
  return result
}

describe('CatalogWorkbookService.verdictReference', () => {
  const seeded = async () => {
    const built = build()
    await applied(built.service, (w) => {
      w.ingredients.rows.push(
        rule({ code: 'ING-ZZ-ONE', name: 'zzyzx extractum', aliases: 'zzyzx oil', kind: 'irritation', group: 'steroid', clashes_with: 'retinoid', helps: 'hd_redness; hd_texture', source_url: 'https://example.com/zz' }),
        // A clash is listed on both sides, as the contract requires.
        rule({ code: 'ING-ZZ-TWO', name: 'zzyzx retinoidum', kind: 'allergen', group: 'retinoid', clashes_with: 'steroid' }),
        rule({ code: 'ING-ZZ-DRAFT', name: 'zzyzx draftum', status: 'draft', approved_by: null, approved_on: null }),
        rule({ code: 'ING-ZZ-OLD', name: 'zzyzx retiredum', status: 'retired' }),
      )
      w.claimWords.rows.push(
        claimWord({ code: 'CLM-WHITENING', phrase: 'whitening' }),
        claimWord({ code: 'CLM-BLEACHING', phrase: 'bleaching' }),
        claimWord({ code: 'CLM-OLD', phrase: 'toning', status: 'retired' }),
      )
    })
    return built
  }

  it('gives the live rules version and catalog version together, the approved rules in code order with their group, clashes and what they help, and the approved claim phrases', async () => {
    const { service, repository } = await seeded()

    const reference = await service.verdictReference()

    const live = await repository.liveRules()
    expect(reference.rulesVersion).toBe(live.version)
    expect(reference.catalogVersion).toBe(await repository.catalogVersion())
    expect(reference.rules.map((r) => r.name)).toEqual(live.entries.map((entry) => entry.name))
    expect(reference.rules.find((r) => r.name === 'zzyzx extractum')).toEqual({
      name: 'zzyzx extractum',
      aliases: ['zzyzx oil'],
      kind: 'irritation',
      rule: 'Commonly reported to sting.',
      source: 'https://example.com/zz',
      group: 'steroid',
      clashesWith: ['retinoid'],
      helps: ['hd_redness', 'hd_texture'],
    })
    expect(reference.claimPhrases).toEqual(['bleaching', 'whitening'])
  })

  it('leaves out a draft rule, a retired rule and a retired claim phrase: only what is approved applies', async () => {
    const { service } = await seeded()

    const { rules, claimPhrases } = await service.verdictReference()

    expect(rules.map((r) => r.name)).not.toContain('zzyzx draftum')
    expect(rules.map((r) => r.name)).not.toContain('zzyzx retiredum')
    expect(claimPhrases).not.toContain('toning')
  })

  it('gives a rule with no group, no clash and nothing it helps an empty shape the floor can read: a null group, empty lists', async () => {
    const { service } = await seeded()

    const { rules } = await service.verdictReference()

    expect(rules.find((r) => r.name === 'zzyzx extractum')).toBeDefined()
    expect(rules.filter((r) => r.group === null).every((r) => Array.isArray(r.clashesWith) && Array.isArray(r.helps))).toBe(true)
    expect(rules.some((r) => r.group === null && r.clashesWith.length === 0 && r.helps.length === 0)).toBe(true)
  })

  it('reads the verdict reference with one question to the repository, readVerdictReference, and never reads the whole workbook for it', async () => {
    const { repository } = await seeded()
    const asked: string[] = []
    const spied = new Proxy(repository, {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver)
        if (typeof member !== 'function') return member
        return (...args: unknown[]) => {
          asked.push(String(property))
          return member.apply(target, args)
        }
      },
    })
    const service = new CatalogWorkbookService({ repository: spied, archive: new MemoryWorkbookArchive({ environment: 'test' }), now: () => new Date('2030-06-15T10:00:00Z'), newId: () => 'id', environment: 'test' })

    const reference = await service.verdictReference()

    expect(asked.filter((name) => name === 'readVerdictReference')).toHaveLength(1)
    expect(asked).not.toContain('readWorkbook')
    // The whole answer comes from that one read: no second question for the versions or the live rules.
    expect(asked).toEqual(['readVerdictReference'])
    expect(reference.rules.length).toBeGreaterThan(0)
    expect(reference.claimPhrases).toEqual(['bleaching', 'whitening'])
  })

  it('reads the rules version and the catalog version in one consistent read, even when an upload lands between two questions to the repository', async () => {
    const repository = new FakeCatalogWorkbookRepository()
    // Every rules version here names its own catalog version (rv-N is catalog N), so a pair that does not match is a read made in two halves.
    repository.publishRules('rv-2', [])
    const racing = new Proxy(repository, {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver)
        if (typeof member !== 'function' || property === 'publishRules') return member
        return (...args: unknown[]) => {
          const outcome = member.apply(target, args)
          if (!(outcome instanceof Promise)) return outcome
          // An upload lands as soon as any question to the repository has been answered.
          return outcome.then(async (answer: unknown) => {
            target.publishRules(`rv-${(await target.catalogVersion()) + 1}`, [])
            return answer
          })
        }
      },
    })
    const service = new CatalogWorkbookService({ repository: racing, archive: new MemoryWorkbookArchive({ environment: 'test' }), now: () => new Date('2030-06-15T10:00:00Z'), newId: () => 'id', environment: 'test' })

    const reference = await service.verdictReference()

    expect(reference.rulesVersion).toBe(`rv-${reference.catalogVersion}`)
  })

  describe('the step-down templates', () => {
    const taperKinds = async (edit: (w: RawWorkbook) => void) => {
      const { service } = build()
      await applied(service, edit)
      return (await service.verdictReference()).tapers
    }

    it('names the one approved template of each kind', async () => {
      const tapers = await taperKinds((w) => w.tapers.rows.push(taper({ code: 'TPR-STEROID-1' }), taper({ code: 'TPR-LIGHTENING-1', kind: 'lightening-agent' })))

      expect(tapers).toEqual({ steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' })
    })

    it('chooses the template approved most recently when a kind has more than one', async () => {
      const tapers = await taperKinds((w) =>
        w.tapers.rows.push(taper({ code: 'TPR-STEROID-1', approved_on: '2030-01-02' }), taper({ code: 'TPR-STEROID-2', approved_on: '2030-03-01' }), taper({ code: 'TPR-STEROID-0', approved_on: '2029-12-31' })),
      )

      expect(tapers).toEqual({ steroid: 'TPR-STEROID-2' })
    })

    it('chooses the lower code when two templates of a kind were approved on the same day', async () => {
      const tapers = await taperKinds((w) =>
        w.tapers.rows.push(
          taper({ code: 'TPR-LIGHT-B', kind: 'lightening-agent', approved_on: '2030-02-02' }),
          taper({ code: 'TPR-LIGHT-A', kind: 'lightening-agent', approved_on: '2030-02-02' }),
          taper({ code: 'TPR-LIGHT-C', kind: 'lightening-agent', approved_on: '2030-02-02' }),
        ),
      )

      expect(tapers).toEqual({ 'lightening-agent': 'TPR-LIGHT-A' })
    })

    it('never chooses a retired or draft template, however recently it was approved or drafted', async () => {
      const tapers = await taperKinds((w) =>
        w.tapers.rows.push(
          taper({ code: 'TPR-STEROID-1', approved_on: '2030-01-02' }),
          taper({ code: 'TPR-STEROID-NEW-RETIRED', approved_on: '2030-09-09', status: 'retired' }),
          taper({ code: 'TPR-STEROID-NEW-DRAFT', approved_by: null, approved_on: null, status: 'draft' }),
        ),
      )

      expect(tapers).toEqual({ steroid: 'TPR-STEROID-1' })
    })

    it('leaves out a kind that has no approved template, so the floor sees a step-down it cannot name', async () => {
      const tapers = await taperKinds((w) => w.tapers.rows.push(taper({ code: 'TPR-STEROID-1' }), taper({ code: 'TPR-LIGHT-OLD', kind: 'lightening-agent', status: 'retired' })))

      expect(tapers).toEqual({ steroid: 'TPR-STEROID-1' })
      expect(tapers).not.toHaveProperty('lightening-agent')
    })

    it('is empty before any template exists', async () => {
      expect(await taperKinds(() => {})).toEqual({})
    })
  })
})

describe('CatalogWorkbookService.tapersByCode', () => {
  it('gives each template asked for by code, retired ones included, with the schedule as steps and everything the user is told', async () => {
    const { service } = build()
    await applied(service, (w) => w.tapers.rows.push(taper({ code: 'TPR-STEROID-1' }), taper({ code: 'TPR-STEROID-2', approved_on: '2030-03-01' })))
    // The second upload leaves the first template out, which retires it in place.
    await applied(service, (w) => (w.tapers.rows = w.tapers.rows.filter((row) => row.code !== 'TPR-STEROID-1')))

    const found = await service.tapersByCode(['TPR-STEROID-1', 'TPR-STEROID-2', 'TPR-NO-SUCH'])

    expect([...found.keys()].sort()).toEqual(['TPR-STEROID-1', 'TPR-STEROID-2'])
    expect(found.get('TPR-STEROID-1')).toMatchObject({
      code: 'TPR-STEROID-1',
      kind: 'steroid',
      status: 'retired',
      schedule: [
        { fromWeek: 1, toWeek: 2, frequency: 'alternate-days' },
        { fromWeek: 3, toWeek: 4, frequency: 'weekly' },
        { fromWeek: 5, toWeek: 5, frequency: 'stop' },
      ],
      whatToExpect: 'Skin may flare for a few days after each step down. This is expected.',
      seeAProfessionalIf: 'The redness spreads, or the skin weeps or blisters.',
    })
    expect(found.get('TPR-STEROID-2')).toMatchObject({ status: 'approved' })
  })

  it('answers an empty map for no codes', async () => {
    const { service } = build()

    expect((await service.tapersByCode([])).size).toBe(0)
  })
})

describe('CatalogWorkbookService.recommendedByCode', () => {
  it('gives each row asked for by code, an approved one and a retired one, with its facts and every country it is sold in, and leaves an unknown code out of the map', async () => {
    const { service } = build()
    await applied(service, (w) => {
      addProduct(w, product({ key_ingredient: 'Azelaic acid', strength: '10%' }), product({ code: 'PRD-TWO', brand: 'Beta', key_ingredient: null, strength: null }))
      w.countries.rows.push({ ...ng, code: 'GH', currency: 'GHS' })
      w.availability.rows.push({ product_code: 'PRD-ONE', country: 'GH', price_min: 20, price_max: 40, where_sold: 'Markets', source_url: null })
    })
    const [one] = await service.approvedFor({ country: 'NG', step: 'cleanse' })
    // The next upload leaves PRD-TWO out, which retires it in place.
    await applied(service, (w) => {
      w.products.rows = w.products.rows.filter((row) => row.code !== 'PRD-TWO')
      w.availability.rows = w.availability.rows.filter((row) => row.product_code !== 'PRD-TWO')
    })

    const found = await service.recommendedByCode(['PRD-ONE', 'PRD-TWO', 'PRD-NO-SUCH'])

    expect([...found.keys()].sort()).toEqual(['PRD-ONE', 'PRD-TWO'])
    expect(found.get('PRD-ONE')).toEqual({
      code: 'PRD-ONE',
      status: 'approved',
      productId: one!.productId,
      formulationId: one!.formulationId,
      origin: 'sourced',
      keyIngredient: 'Azelaic acid',
      strength: '10%',
      availability: [
        { country: 'GH', priceMin: 20, priceMax: 40, whereSold: 'Markets' },
        { country: 'NG', priceMin: 3000, priceMax: 4500, whereSold: null },
      ],
    })
    expect(found.get('PRD-TWO')).toMatchObject({ code: 'PRD-TWO', status: 'retired', keyIngredient: null, strength: null, availability: [] })
  })

  it('answers an empty map for no codes', async () => {
    const { service } = build()

    expect((await service.recommendedByCode([])).size).toBe(0)
  })
})

describe('CatalogWorkbookService.stepsFor', () => {
  it('gives the routine steps an approved recommended product fills, by the id of its catalog product', async () => {
    const { service } = build()
    await applied(service, (w) => addProduct(w, product({ steps: 'cleanse; treat' })))
    const [row] = await service.approvedFor({ country: 'NG', step: 'cleanse' })

    const steps = await service.stepsFor([row!.productId, 'product-nobody-recommends'])

    expect([...steps.keys()]).toEqual([row!.productId])
    expect(steps.get(row!.productId)).toEqual(['cleanse', 'treat'])
  })

  it('leaves out a product whose recommended row was retired', async () => {
    const { service } = build()
    await applied(service, (w) => addProduct(w, product()))
    const [row] = await service.approvedFor({ country: 'NG', step: 'cleanse' })
    await applied(service, (w) => Object.assign(w.products.rows.find((p) => p.code === 'PRD-ONE')!, { status: 'retired' }))

    expect((await service.stepsFor([row!.productId])).size).toBe(0)
  })

  it('answers an empty map for no products', async () => {
    const { service } = build()

    expect((await service.stepsFor([])).size).toBe(0)
  })
})

describe('CatalogWorkbookService.skinConcernsFor', () => {
  it('gives the skin concerns an approved recommended product is for, in the vocabulary order, by the id of its catalog product', async () => {
    const { service } = build()
    await applied(service, (w) => addProduct(w, product({ skin_concerns: 'hd_moisture; hd_redness' })))
    const [row] = await service.approvedFor({ country: 'NG', step: 'cleanse' })

    const concerns = await service.skinConcernsFor([row!.productId, 'product-nobody-recommends'])

    expect([...concerns.keys()]).toEqual([row!.productId])
    // Redness comes before moisture in the vocabulary, though the Products tab lists moisture first.
    expect(concerns.get(row!.productId)).toEqual(['hd_redness', 'hd_moisture'])
  })

  it('leaves out a product whose recommended row was retired', async () => {
    const { service } = build()
    await applied(service, (w) => addProduct(w, product()))
    const [row] = await service.approvedFor({ country: 'NG', step: 'cleanse' })
    await applied(service, (w) => Object.assign(w.products.rows.find((p) => p.code === 'PRD-ONE')!, { status: 'retired' }))

    expect((await service.skinConcernsFor([row!.productId])).size).toBe(0)
  })

  it('answers an empty map for no products', async () => {
    const { service } = build()

    expect((await service.skinConcernsFor([])).size).toBe(0)
  })
})

describe('CatalogWorkbookService: key_ingredient and strength', () => {
  const rowOf = (workbook: RawWorkbook) => workbook.products.rows.find((row) => row.code === 'PRD-ONE')!

  it('exports both columns in the Products header row, empty on a product that has neither', async () => {
    const { service } = build()
    await applied(service, (w) => addProduct(w, product()))

    const { workbook } = await service.exportWorkbook()

    expect(workbook.products.headers).toEqual(expect.arrayContaining(['key_ingredient', 'strength']))
    expect(rowOf(workbook)).toMatchObject({ key_ingredient: null, strength: null })
  })

  it('stores what an import holds and writes it back on the next export, so exporting and importing again changes nothing', async () => {
    const { service } = build()
    await applied(service, (w) => addProduct(w, product({ key_ingredient: 'Azelaic acid', strength: '10%' })))

    const live = await service.exportWorkbook()
    const again = await service.importWorkbook({ workbook: live.workbook, file: null, baseVersion: live.catalogVersion, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(rowOf(live.workbook)).toMatchObject({ key_ingredient: 'Azelaic acid', strength: '10%' })
    expect(again.diff.products).toEqual({ added: [], updated: [], retired: [], reactivated: [] })
  })

  it('reports a changed key_ingredient as an update of that product, in a dry run that applies nothing', async () => {
    const { service, repository } = build()
    await applied(service, (w) => addProduct(w, product({ key_ingredient: 'Azelaic acid', strength: '10%' })))
    const edit = await edited(service, (w) => Object.assign(rowOf(w), { key_ingredient: 'Niacinamide' }))

    const result = await service.importWorkbook({ ...edit, file: null, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

    expect(result.diff.products).toEqual({ added: [], updated: ['PRD-ONE'], retired: [], reactivated: [] })
    expect(await repository.catalogVersion()).toBe(2)
  })

  it('reports a changed strength as an update, and a strength cleared as an update', async () => {
    const { service } = build()
    await applied(service, (w) => addProduct(w, product({ key_ingredient: 'Azelaic acid', strength: '10%' })))

    for (const strength of ['15%', null]) {
      const edit = await edited(service, (w) => Object.assign(rowOf(w), { strength }))
      const result = await service.importWorkbook({ ...edit, file: null, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })

      expect(result.diff.products.updated).toEqual(['PRD-ONE'])
    }
  })

  it('refuses an import that holds a strength with no key_ingredient, with the problem on that row and column, and applies nothing', async () => {
    const { service, repository } = build()
    const edit = await edited(service, (w) => addProduct(w, product({ strength: '10%' })))

    await expect(service.importWorkbook({ ...edit, file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'CATALOG_INVALID',
      details: { problems: [{ tab: 'products', row: 2, column: 'strength', rule: 'STRENGTH_WITHOUT_INGREDIENT' }] },
    })
    expect(await repository.catalogVersion()).toBe(1)
  })

  it('gives both on the approved row a consumer reads for a country and step (approvedFor), and null for a product that has neither', async () => {
    const { service } = build()
    await applied(service, (w) => addProduct(w, product({ code: 'PRD-WITH', name: 'With', key_ingredient: 'Azelaic acid', strength: '10%' }), product({ code: 'PRD-BARE', name: 'Bare' })))

    const rows = await service.approvedFor({ country: 'NG', step: 'cleanse' })

    expect(rows.find((row) => row.code === 'PRD-WITH')).toMatchObject({ keyIngredient: 'Azelaic acid', strength: '10%' })
    expect(rows.find((row) => row.code === 'PRD-BARE')).toMatchObject({ keyIngredient: null, strength: null })
  })
})

// ---- the Guides tab (spec #217, PR 1): what a step is for, what to look for and what suits deeper skin, written by the team and never by a model ----

describe('CatalogWorkbookService: the Guides tab', () => {
  const emptyTab = { added: [], updated: [], retired: [], reactivated: [] }
  const dry = (service: CatalogWorkbookService, edit: { workbook: RawWorkbook; baseVersion: number }) => service.importWorkbook({ ...edit, file: null, dryRun: true, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
  const apply = (service: CatalogWorkbookService, edit: { workbook: RawWorkbook; baseVersion: number }) => service.importWorkbook({ ...edit, file: FILE, dryRun: false, uploadedBy: 'T', contractVersion: CONTRACT_VERSION })
  /** The rows of the Guides tab as the export gives them, in a fixed order (the order the export lists them in is not part of the contract). */
  const exportedGuides = async (service: CatalogWorkbookService) => {
    const rows = (await service.exportWorkbook()).workbook.guides.rows
    return [...rows].sort((a, b) => `${a.step}:${a.goal ?? ''}`.localeCompare(`${b.step}:${b.goal ?? ''}`))
  }
  const sortedByKey = (rows: RawRow[]) => [...rows].sort((a, b) => `${a.step}:${a.goal ?? ''}`.localeCompare(`${b.step}:${b.goal ?? ''}`))
  const override = (over: RawRow = {}): RawRow => guide({ step: 'treat', goal: 'fade-dark-marks', what_it_does: 'Helps dark marks fade.', look_for: 'Niacinamide or azelaic acid.', for_deeper_skin: 'Go slowly.', look_for_when_pregnant: 'Azelaic acid only.', ...over })

  describe('importing', () => {
    it('refuses a workbook with no approved base row for a step as CATALOG_INVALID, naming the Guides tab, and applies nothing', async () => {
      const { service, repository } = build()
      const edit = await edited(service, (w) => w.guides.rows.push(...baseGuides().filter((row) => row.step !== 'protect')), { guides: false })

      await expect(apply(service, edit)).rejects.toMatchObject({
        name: 'ValidationError',
        code: 'CATALOG_INVALID',
        details: { problems: [{ tab: 'guides', row: 1, column: 'step', rule: 'GUIDE_BASE_MISSING' }] },
      })
      expect(await repository.catalogVersion()).toBe(1)
      expect(await exportedGuides(service)).toEqual([])
    })

    it('refuses a guide that breaks the routine wording gate, with the problem on the cell, and applies nothing', async () => {
      const { service, repository } = build()
      const edit = await edited(service, (w) => w.guides.rows.push(...baseGuides(), guide({ step: 'treat', goal: 'glow', look_for: 'Something for lighter skin.' })), { guides: false })

      await expect(apply(service, edit)).rejects.toMatchObject({
        name: 'ValidationError',
        code: 'CATALOG_INVALID',
        details: { problems: [{ tab: 'guides', row: 6, column: 'look_for', rule: 'GUIDE_WORDING' }] },
      })
      expect(await repository.catalogVersion()).toBe(1)
    })

    it('reports new guides as added in a dry run, keyed by step for a base row and by step and goal for a goal row, and writes nothing', async () => {
      const { service, repository, archive } = build()
      const edit = await edited(service, (w) => w.guides.rows.push(...baseGuides(), override()), { guides: false })

      const result = await dry(service, edit)

      expect(result.applied).toBe(false)
      expect([...result.diff.guides.added].sort()).toEqual(['cleanse', 'moisturise', 'protect', 'treat', 'treat:fade-dark-marks'])
      expect({ ...result.diff.guides, added: [] }).toEqual(emptyTab)
      expect(await repository.catalogVersion()).toBe(1)
      expect(archive.stored.size).toBe(0)
      expect(await exportedGuides(service)).toEqual([])
    })

    it('stores the guides it applies, and the export gives them back exactly as the upload had them, for the next edit to start from', async () => {
      const { service } = build()
      const rows = [...baseGuides(), override(), override({ goal: 'glow', look_for_when_pregnant: null, audited_by: 'Nneka Audit', audited_on: '2030-02-03' })]

      const result = await apply(service, await edited(service, (w) => w.guides.rows.push(...rows), { guides: false }))

      expect(result).toMatchObject({ applied: true, catalogVersion: 2 })
      expect(await exportedGuides(service)).toEqual(sortedByKey(rows))
    })

    it('reads a guide cell as the contract reads it, so the export holds it trimmed and an empty pregnancy cell as null', async () => {
      const { service } = build()
      const messy = guide({ step: 'treat', goal: 'glow', look_for: '  Niacinamide.  ', look_for_when_pregnant: '   ' })

      await apply(service, await edited(service, (w) => w.guides.rows.push(messy)))

      expect((await exportedGuides(service)).find((row) => row.goal === 'glow')).toEqual({ ...messy, look_for: 'Niacinamide.', look_for_when_pregnant: null })
    })

    it('reports an unchanged export as an empty diff for Guides, and a text spelt with other spaces as the same guide', async () => {
      const { service } = build()
      await apply(service, await edited(service, (w) => w.guides.rows.push(...baseGuides(), override()), { guides: false }))

      const same = await dry(service, await edited(service, () => {}, { guides: false }))
      const spaced = await dry(service, await edited(service, (w) => Object.assign(w.guides.rows.find((row) => row.goal === 'fade-dark-marks')!, { look_for: ' Niacinamide or azelaic acid. ' })))

      expect(same.diff.guides).toEqual(emptyTab)
      expect(spaced.diff.guides).toEqual(emptyTab)
    })

    it('reports a changed base guide and a changed goal guide as updated, and only those', async () => {
      const { service } = build()
      await apply(service, await edited(service, (w) => w.guides.rows.push(...baseGuides(), override()), { guides: false }))

      const result = await dry(
        service,
        await edited(service, (w) => {
          Object.assign(w.guides.rows.find((row) => row.step === 'cleanse' && row.goal === null)!, { for_deeper_skin: 'Use lukewarm water.' })
          Object.assign(w.guides.rows.find((row) => row.goal === 'fade-dark-marks')!, { look_for_when_pregnant: null })
        }),
      )

      expect([...result.diff.guides.updated].sort()).toEqual(['cleanse', 'treat:fade-dark-marks'])
      expect({ ...result.diff.guides, updated: [] }).toEqual(emptyTab)
    })

    it('changes the stored guide when a changed one is applied, in place, with no second row for the step and goal', async () => {
      const { service } = build()
      await apply(service, await edited(service, (w) => w.guides.rows.push(...baseGuides(), override()), { guides: false }))

      await apply(service, await edited(service, (w) => Object.assign(w.guides.rows.find((row) => row.goal === 'fade-dark-marks')!, { look_for: 'Azelaic acid.' })))

      const rows = await exportedGuides(service)
      expect(rows).toHaveLength(5)
      expect(rows.find((row) => row.goal === 'fade-dark-marks')).toMatchObject({ look_for: 'Azelaic acid.' })
    })

    it('never deletes: a goal guide the upload leaves out is retired in place, stays in the export, and comes back as reactivated', async () => {
      const { service } = build()
      await apply(service, await edited(service, (w) => w.guides.rows.push(...baseGuides(), override()), { guides: false }))

      const gone = await edited(service, (w) => (w.guides.rows = w.guides.rows.filter((row) => row.goal !== 'fade-dark-marks')))
      const retired = await apply(service, gone)

      expect(retired.diff.guides).toEqual({ ...emptyTab, retired: ['treat:fade-dark-marks'] })
      expect((await exportedGuides(service)).find((row) => row.goal === 'fade-dark-marks')).toEqual({ ...override(), status: 'retired' })

      const back = await edited(service, (w) => (w.guides.rows = w.guides.rows.filter((row) => row.goal !== 'fade-dark-marks').concat(override())))
      expect((await apply(service, back)).diff.guides).toEqual({ ...emptyTab, reactivated: ['treat:fade-dark-marks'] })
      expect((await exportedGuides(service)).find((row) => row.goal === 'fade-dark-marks')).toEqual(override())
    })

    it('reports a goal guide set to retired as retired, once, and not again when it is uploaded retired again', async () => {
      const { service } = build()
      await apply(service, await edited(service, (w) => w.guides.rows.push(...baseGuides(), override()), { guides: false }))

      const result = await apply(service, await edited(service, (w) => Object.assign(w.guides.rows.find((row) => row.goal === 'fade-dark-marks')!, { status: 'retired' })))
      const again = await dry(service, await edited(service, () => {}))

      expect(result.diff.guides).toEqual({ ...emptyTab, retired: ['treat:fade-dark-marks'] })
      expect(again.diff.guides).toEqual(emptyTab)
    })

    it('does not move the rules version: a guide is not an ingredient rule', async () => {
      const { service, repository } = build()

      await apply(service, await edited(service, (w) => w.guides.rows.push(...baseGuides(), override()), { guides: false }))

      expect((await repository.liveRules()).version).toBe(REFERENCE_VERSION)
    })
  })

  describe('the approver gate in production', () => {
    const QUALIFIED = 'Dr Q. Approver'
    const inProduction = (qualifiedApprovers: string | undefined) =>
      new CatalogWorkbookService({
        repository: new FakeCatalogWorkbookRepository(),
        archive: new MemoryWorkbookArchive({ environment: 'production' }),
        now: () => new Date('2030-06-15T10:00:00Z'),
        newId: () => 'id',
        environment: 'production',
        qualifiedApprovers,
      })
    const bases = (approver: string): RawRow[] => baseGuides().map((row) => ({ ...row, approved_by: approver }))

    it('refuses an approved guide whose approver is not on the list, row by row, naming the approved_by cell and never the name', async () => {
      const service = inProduction(QUALIFIED)
      const edit = await edited(service, (w) => w.guides.rows.push(...bases(QUALIFIED).slice(0, 2), ...bases('Somebody Else').slice(2), override({ approved_by: 'Somebody Else' })), { guides: false })

      const error = await dry(service, edit).catch((caught: unknown) => caught)

      expect(error).toMatchObject({
        name: 'ValidationError',
        code: 'CATALOG_INVALID',
        details: {
          problems: [
            { tab: 'guides', row: 4, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' },
            { tab: 'guides', row: 5, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' },
            { tab: 'guides', row: 6, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' },
          ],
        },
      })
      expect(JSON.stringify(error)).not.toContain('Somebody Else')
    })

    it('takes guides approved by someone on the list, and a draft or retired guide by anyone', async () => {
      const service = inProduction(`${QUALIFIED}, Dr Other`)
      const edit = await edited(
        service,
        (w) =>
          w.guides.rows.push(
            ...bases(QUALIFIED),
            override({ approved_by: 'Dr Other' }),
            override({ goal: 'glow', status: 'draft', approved_by: 'Somebody Else' }),
            override({ goal: 'even-tone', status: 'retired', approved_by: 'Somebody Else' }),
          ),
        { guides: false },
      )

      await expect(dry(service, edit)).resolves.toMatchObject({ applied: false })
    })

    it('lets nobody approve a guide when no list is held', async () => {
      const service = inProduction(undefined)
      const edit = await edited(service, (w) => w.guides.rows.push(...bases(QUALIFIED)), { guides: false })

      await expect(dry(service, edit)).rejects.toMatchObject({ code: 'CATALOG_INVALID', details: { problems: expect.arrayContaining([{ tab: 'guides', row: 2, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' }]) } })
    })

    it('is not asked for outside production, where any approver does', async () => {
      const { service } = build()
      const edit = await edited(service, (w) => w.guides.rows.push(...bases('Somebody Else')), { guides: false })

      await expect(dry(service, edit)).resolves.toMatchObject({ applied: false })
    })
  })

  describe('guideFor', () => {
    const live = async (...extra: RawRow[]) => {
      const { service } = build()
      await apply(service, await edited(service, (w) => w.guides.rows.push(...baseGuides(), ...extra), { guides: false }))
      return service
    }

    it('gives the step and goal guide when there is an approved one, as exactly the four texts and nothing else', async () => {
      const service = await live(override())

      expect(await service.guideFor('treat', 'fade-dark-marks')).toEqual({
        whatItDoes: 'Helps dark marks fade.',
        lookFor: 'Niacinamide or azelaic acid.',
        forDeeperSkin: 'Go slowly.',
        lookForWhenPregnant: 'Azelaic acid only.',
      })
    })

    it('falls back to the step\'s base guide for a goal that has no guide of its own', async () => {
      const service = await live(override())

      expect(await service.guideFor('treat', 'glow')).toEqual({
        whatItDoes: 'What treat does.',
        lookFor: 'What to look for in treat.',
        forDeeperSkin: 'Deeper skin and treat.',
        lookForWhenPregnant: null,
      })
    })

    it('gives each step its own base guide', async () => {
      const service = await live()

      for (const step of ['cleanse', 'treat', 'moisturise', 'protect'] as const) expect(await service.guideFor(step, 'even-tone')).toMatchObject({ whatItDoes: `What ${step} does.` })
    })

    it('gives a goal guide only for its own step: the same goal on another step gets that step\'s base', async () => {
      const service = await live(override())

      expect(await service.guideFor('protect', 'fade-dark-marks')).toMatchObject({ whatItDoes: 'What protect does.' })
    })

    it('ignores a goal guide that is still a draft, and one that has been retired, and gives the base guide', async () => {
      const service = await live(override({ goal: 'glow', status: 'draft', approved_by: null, approved_on: null }), override({ goal: 'even-tone' }))
      await apply(service, await edited(service, (w) => (w.guides.rows = w.guides.rows.filter((row) => row.goal !== 'even-tone'))))

      expect(await service.guideFor('treat', 'glow')).toMatchObject({ whatItDoes: 'What treat does.' })
      expect(await service.guideFor('treat', 'even-tone')).toMatchObject({ whatItDoes: 'What treat does.' })
    })

    it('gives a goal guide whole, with no pregnancy text borrowed from the base guide', async () => {
      const { service } = build()
      await apply(
        service,
        await edited(
          service,
          (w) => w.guides.rows.push(...baseGuides().map((row) => (row.step === 'treat' ? { ...row, look_for_when_pregnant: 'Azelaic acid only.' } : row)), override({ look_for_when_pregnant: null })),
          { guides: false },
        ),
      )

      expect(await service.guideFor('treat', 'fade-dark-marks')).toMatchObject({ lookForWhenPregnant: null })
      expect(await service.guideFor('treat', 'glow')).toMatchObject({ lookForWhenPregnant: 'Azelaic acid only.' })
    })

    it('gives null when the catalog has no guide at all, as it has before the team fills the Guides tab in', async () => {
      const { service } = build()

      expect(await service.guideFor('cleanse', 'glow')).toBeNull()
      expect(await service.guideFor('protect', 'fade-dark-marks')).toBeNull()
    })

    it('reads what is live now: a changed guide is given as changed after the upload that changed it', async () => {
      const service = await live(override())
      expect(await service.guideFor('treat', 'fade-dark-marks')).toMatchObject({ lookFor: 'Niacinamide or azelaic acid.' })

      await apply(service, await edited(service, (w) => Object.assign(w.guides.rows.find((row) => row.goal === 'fade-dark-marks')!, { look_for: 'Azelaic acid.' })))

      expect(await service.guideFor('treat', 'fade-dark-marks')).toMatchObject({ lookFor: 'Azelaic acid.' })
    })
  })
})
