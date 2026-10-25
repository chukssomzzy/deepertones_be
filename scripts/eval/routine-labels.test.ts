import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type LabelSet, LabelSetError, labelSetPath, LabelSheetError, loadLabelSet, readLabelSheet, saveLabelSet, writeLabelSheet } from './routine-labels'
import { candidate, skeletonOf } from './routine.fixture'

// The label sheet and the reader, through a real temp .xlsx: the sheet lists every case x gap x candidate with an empty `label` column, a person fills it in
// (best, acceptable, or leave it blank for "not"), and the reader turns the filled sheet into a label set. The test fills the sheet with exceljs the way a
// person would in a spreadsheet. The columns the test relies on are named `case`, `step`, `code` and `label`; the rest are looked for by what they show.

const SHA = 'f'.repeat(64)

let dir: string
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routine-labels-'))
  path = join(dir, 'sheet.xlsx')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// dev-01: cleanse has three candidates (listed cheapest first: Z, A, M), treat has none, protect has one.
// dev-02: moisturise has three.
// 3 + 1 + 3 = 7 rows.
const ENTRIES = [
  {
    id: 'dev-01',
    skeleton: skeletonOf(
      [
        { step: 'cleanse', candidates: [candidate('C-Z', { priceMin: 900 }), candidate('C-A', { priceMin: 1500 }), candidate('C-M', { priceMin: 2000 })] },
        { step: 'treat', candidates: [] },
        { step: 'protect', candidates: [candidate('P-1')] },
      ],
      {
        goal: 'even-tone',
        person: {
          seen: [{ concern: 'hd_age_spot', level: 'clear' }],
          alsoNoticed: [{ concern: 'hd_acne', level: 'a-little' }],
          skinType: 'combination',
          lowConfidence: [],
          cautions: ['pregnant'],
          budgetBand: 'low',
        },
      },
    ),
  },
  {
    id: 'dev-02',
    skeleton: skeletonOf([{ step: 'moisturise', candidates: [candidate('M-1'), candidate('M-2'), candidate('M-3')] }]),
  },
]

type Sheet = { book: ExcelJS.Workbook; sheet: ExcelJS.Worksheet; columns: Map<string, number> }

const open = async (): Promise<Sheet> => {
  const book = new ExcelJS.Workbook()
  await book.xlsx.readFile(path)
  const sheet = book.worksheets.find((s) => s.state === 'visible')!
  const columns = new Map<string, number>()
  sheet.getRow(1).eachCell((cell, column) => void columns.set(String(cell.value), column))
  return { book, sheet, columns }
}

const text = (cell: ExcelJS.Cell) => (cell.value === null || cell.value === undefined ? '' : String(cell.value))

/** Every data row as { case, step, code, label, all: every cell's text joined }. */
const rowsOf = ({ sheet, columns }: Sheet) => {
  const rows: { number: number; case: string; step: string; code: string; label: string; all: string }[] = []
  for (let number = 2; number <= sheet.rowCount; number++) {
    const row = sheet.getRow(number)
    const cells: string[] = []
    row.eachCell({ includeEmpty: false }, (cell) => void cells.push(text(cell)))
    if (cells.length === 0) continue
    rows.push({ number, case: text(row.getCell(columns.get('case')!)), step: text(row.getCell(columns.get('step')!)), code: text(row.getCell(columns.get('code')!)), label: text(row.getCell(columns.get('label')!)), all: cells.join(' | ') })
  }
  return rows
}

/** Fills the label column the way a person would, then saves. `labels` is `case/step/code` to what they typed; a row not listed is left blank. */
const fill = async (labels: Record<string, string>) => {
  const opened = await open()
  for (const row of rowsOf(opened)) {
    const typed = labels[`${row.case}/${row.step}/${row.code}`]
    if (typed !== undefined) opened.sheet.getRow(row.number).getCell(opened.columns.get('label')!).value = typed
  }
  await opened.book.xlsx.writeFile(path)
}

const written = async () => {
  await writeLabelSheet(path, ENTRIES, SHA)
  return open()
}

describe('writeLabelSheet', () => {
  it('writes one row for each case x gap x candidate, and none for a gap with no candidates', async () => {
    const rows = rowsOf(await written())

    expect(rows.map((r) => `${r.case}/${r.step}/${r.code}`).sort()).toEqual(
      ['dev-01/cleanse/C-A', 'dev-01/cleanse/C-M', 'dev-01/cleanse/C-Z', 'dev-01/protect/P-1', 'dev-02/moisturise/M-1', 'dev-02/moisturise/M-2', 'dev-02/moisturise/M-3'].sort(),
    )
  })

  it('leaves the label column empty on every row, for a person to fill in', async () => {
    const rows = rowsOf(await written())

    expect(rows).toHaveLength(7)
    for (const row of rows) expect(row.label, `${row.case}/${row.code}`).toBe('')
  })

  it('shows what a person needs to judge a candidate: brand and name, form, ingredients, skin concerns, price range and frequency', async () => {
    const spec = candidate('SHOWN', { brand: 'Glow Co', name: 'Night Cream', form: 'serum', ingredients: ['Aqua', 'Niacinamide'], skinConcerns: ['hd_texture'], frequency: 'alternate-days', priceMin: 2500, priceMax: 4000 })
    await writeLabelSheet(path, [{ id: 'dev-09', skeleton: skeletonOf([{ step: 'treat', candidates: [spec, candidate('OTHER')] }]) }], SHA)

    const row = rowsOf(await open()).find((r) => r.code === 'SHOWN')!

    for (const shown of ['Glow Co', 'Night Cream', 'serum', 'Niacinamide', 'hd_texture', 'alternate-days', '2500', '4000']) expect(row.all, shown).toContain(shown)
  })

  it('summarises the person on each of their rows: goal, skin type, what was seen and also noticed with levels, cautions and budget', async () => {
    const rows = rowsOf(await written()).filter((r) => r.case === 'dev-01')

    expect(rows).toHaveLength(4)
    for (const row of rows) {
      for (const shown of ['even-tone', 'combination', 'hd_age_spot', 'clear', 'hd_acne', 'a-little', 'pregnant', 'low']) expect(row.all, `${row.code} ${shown}`).toContain(shown)
    }
  })

  it('stamps the snapshot\'s sha256 on a hidden _meta sheet', async () => {
    const { book } = await written()

    const meta = book.getWorksheet('_meta')!
    expect(meta.state).not.toBe('visible')
    const pairs = new Map<string, string>()
    meta.eachRow((row) => void pairs.set(text(row.getCell(1)), text(row.getCell(2))))
    expect(pairs.get('snapshotSha256')).toBe(SHA)
  })
})

describe('writeLabelSheet: country, currency and not overwriting', () => {
  it('shows each case\'s country and the currency the snapshot\'s Countries tab gives it, beside the prices', async () => {
    await writeLabelSheet(path, [{ id: 'dev-01', country: 'NG', skeleton: ENTRIES[0]!.skeleton }, { id: 'dev-02', country: 'GB', skeleton: ENTRIES[1]!.skeleton }], SHA, [
      { code: 'NG', currency: 'NGN' },
      { code: 'GB', currency: 'GBP' },
    ])

    const opened = await open()
    const cell = (id: string, column: string) => {
      const row = rowsOf(opened).find((r) => r.case === id)!
      return text(opened.sheet.getRow(row.number).getCell(opened.columns.get(column)!))
    }
    expect([cell('dev-01', 'country'), cell('dev-01', 'currency')]).toEqual(['NG', 'NGN'])
    expect([cell('dev-02', 'country'), cell('dev-02', 'currency')]).toEqual(['GB', 'GBP'])
  })

  it('refuses to overwrite a sheet that exists, with a message that says so, and leaves it as it was', async () => {
    await writeLabelSheet(path, ENTRIES, SHA)
    await fill({ 'dev-01/cleanse/C-A': 'best' })

    const error = await writeLabelSheet(path, ENTRIES, SHA).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LabelSheetError)
    expect((error as Error).message).toMatch(/exists already/)
    expect(rowsOf(await open()).find((r) => r.code === 'C-A')!.label).toBe('best')
  })
})

describe('readLabelSheet', () => {
  it('reads best, acceptable and a blank (not) into a label set that names the snapshot, the version and the status', async () => {
    await writeLabelSheet(path, ENTRIES, SHA)
    await fill({
      'dev-01/cleanse/C-A': 'best',
      'dev-01/cleanse/C-M': 'acceptable',
      'dev-01/cleanse/C-Z': 'acceptable',
      'dev-02/moisturise/M-1': 'best',
      'dev-02/moisturise/M-3': 'acceptable',
      // M-2 and every other row are left blank.
    })

    const labels = await readLabelSheet(path, { version: 'v1', status: 'provisional' })

    // A person made this set in the sheet, so it says so: `labelledBy: 'human'` (changed for #152's follow-up; the judge selection reads it).
    expect(labels).toEqual({
      version: 'v1',
      status: 'provisional',
      snapshotSha256: SHA,
      labelledBy: 'human',
      cases: {
        // Sorted by code, whatever order the sheet listed them in (cheapest first: Z, A, M).
        'dev-01': {
          cleanse: { candidates: ['C-A', 'C-M', 'C-Z'], best: 'C-A', acceptable: ['C-M', 'C-Z'] },
          // A gap with one candidate has that candidate as best, though its label was left blank.
          protect: { candidates: ['P-1'], best: 'P-1', acceptable: [] },
        },
        'dev-02': { moisturise: { candidates: ['M-1', 'M-2', 'M-3'], best: 'M-1', acceptable: ['M-3'] } },
      },
    })
  })

  it('reads a blank label as not: it is neither the best nor acceptable', async () => {
    await writeLabelSheet(path, ENTRIES, SHA)
    await fill({ 'dev-01/cleanse/C-A': 'best', 'dev-02/moisturise/M-2': 'best', 'dev-02/moisturise/M-1': 'not' })

    const labels = await readLabelSheet(path, { version: 'v2', status: 'clinical' })

    expect(labels.status).toBe('clinical')
    expect(labels.cases['dev-01']!.cleanse).toEqual({ candidates: ['C-A', 'C-M', 'C-Z'], best: 'C-A', acceptable: [] })
    expect(labels.cases['dev-02']!.moisturise).toEqual({ candidates: ['M-1', 'M-2', 'M-3'], best: 'M-2', acceptable: [] })
  })

  it('gives a gap with one candidate that candidate as best when nothing was typed, and leaves a gap with no candidates out', async () => {
    await writeLabelSheet(path, ENTRIES, SHA)
    await fill({ 'dev-01/cleanse/C-A': 'best', 'dev-02/moisturise/M-1': 'best' })

    const labels = await readLabelSheet(path, { version: 'v1', status: 'provisional' })

    expect(labels.cases['dev-01']!.protect).toEqual({ candidates: ['P-1'], best: 'P-1', acceptable: [] })
    expect(labels.cases['dev-01']).not.toHaveProperty('treat')
  })

  it('refuses a sheet with a gap that has two bests, or a gap of 2 or more candidates that has none, and lists every problem by case and step', async () => {
    await writeLabelSheet(path, ENTRIES, SHA)
    await fill({
      // dev-01 cleanse: two bests.
      'dev-01/cleanse/C-A': 'best',
      'dev-01/cleanse/C-Z': 'best',
      // dev-02 moisturise: acceptable products, but no best.
      'dev-02/moisturise/M-1': 'acceptable',
    })

    const error = await readLabelSheet(path, { version: 'v1', status: 'provisional' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LabelSheetError)
    expect((error as LabelSheetError).problems).toEqual([
      { caseId: 'dev-01', step: 'cleanse', problem: 'two-bests' },
      { caseId: 'dev-02', step: 'moisturise', problem: 'no-best' },
    ])
    const message = (error as Error).message
    for (const shown of ['dev-01', 'cleanse', 'dev-02', 'moisturise']) expect(message, shown).toContain(shown)
  })

  it.each([
    ['Best ', 'a capital letter and a trailing space'],
    ['  BEST', 'capitals and a leading space'],
  ])('reads %j (%s) as best', async (typed) => {
    await writeLabelSheet(path, ENTRIES, SHA)
    await fill({ 'dev-01/cleanse/C-A': typed, 'dev-02/moisturise/M-1': 'best' })

    const labels = await readLabelSheet(path, { version: 'v1', status: 'provisional' })

    expect(labels.cases['dev-01']!.cleanse!.best).toBe('C-A')
  })

  it('reads ACCEPTABLE and " Not " as acceptable and not, whatever the case or spacing', async () => {
    await writeLabelSheet(path, ENTRIES, SHA)
    await fill({ 'dev-01/cleanse/C-A': 'best', 'dev-01/cleanse/C-M': 'ACCEPTABLE', 'dev-01/cleanse/C-Z': ' Not ', 'dev-02/moisturise/M-1': 'Acceptable ', 'dev-02/moisturise/M-2': ' BEST' })

    const labels = await readLabelSheet(path, { version: 'v1', status: 'provisional' })

    expect(labels.cases['dev-01']!.cleanse).toEqual({ candidates: ['C-A', 'C-M', 'C-Z'], best: 'C-A', acceptable: ['C-M'] })
    expect(labels.cases['dev-02']!.moisturise).toEqual({ candidates: ['M-1', 'M-2', 'M-3'], best: 'M-2', acceptable: ['M-1'] })
  })

  it('refuses a label it does not know, such as a misspelt "acceptible", naming the case, step and code, rather than reading it as "not"', async () => {
    await writeLabelSheet(path, ENTRIES, SHA)
    await fill({ 'dev-01/cleanse/C-A': 'best', 'dev-01/cleanse/C-M': 'acceptible', 'dev-02/moisturise/M-1': 'best', 'dev-02/moisturise/M-2': 'maybe' })

    const error = await readLabelSheet(path, { version: 'v1', status: 'provisional' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LabelSheetError)
    expect((error as LabelSheetError).problems).toEqual([
      { caseId: 'dev-01', step: 'cleanse', code: 'C-M', problem: 'unknown-label' },
      { caseId: 'dev-02', step: 'moisturise', code: 'M-2', problem: 'unknown-label' },
    ])
    const message = (error as Error).message
    for (const shown of ['dev-01', 'cleanse', 'C-M', 'dev-02', 'moisturise', 'M-2']) expect(message, shown).toContain(shown)
  })

  it('refuses a sheet nobody has labelled at all', async () => {
    await writeLabelSheet(path, ENTRIES, SHA)

    const error = await readLabelSheet(path, { version: 'v1', status: 'provisional' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LabelSheetError)
    expect((error as LabelSheetError).problems.map((p) => `${p.caseId}/${p.step}`)).toEqual(['dev-01/cleanse', 'dev-02/moisturise'])
  })
})

describe('readLabelSheet: who labelled', () => {
  it.each(['provisional', 'clinical', 'outcome'] as const)('says a set read from a sheet was labelled by a human, whatever its status (%s)', async (status) => {
    await writeLabelSheet(path, ENTRIES, SHA)
    await fill({ 'dev-01/cleanse/C-A': 'best', 'dev-02/moisturise/M-1': 'best' })

    const labels = await readLabelSheet(path, { version: 'v1', status })

    expect(labels.labelledBy).toBe('human')
  })
})

// An AI-made label set comes with a filled copy of the sheet, so a person can spot-check or correct it and read it back with `eval:routine:labels`. writeLabelSheet takes the
// labels as a last, optional argument and fills the `label` column from them: best, acceptable, or blank (which the reader takes as not). The proof is the reader's own:
// what it reads back is the labels that were put in.
describe('writeLabelSheet: a sheet filled from labels', () => {
  // dev-01 cleanse: C-A best, C-M acceptable, C-Z not. dev-02 moisturise: M-2 best, M-3 acceptable, M-1 not. Single-candidate gaps (dev-01 protect) are best, as the reader makes them.
  const FILLED: LabelSet['cases'] = {
    'dev-01': {
      cleanse: { candidates: ['C-A', 'C-M', 'C-Z'], best: 'C-A', acceptable: ['C-M'] },
      protect: { candidates: ['P-1'], best: 'P-1', acceptable: [] },
    },
    'dev-02': { moisturise: { candidates: ['M-1', 'M-2', 'M-3'], best: 'M-2', acceptable: ['M-3'] } },
  }

  it('writes best, acceptable and a blank into the label column of each candidate row', async () => {
    await writeLabelSheet(path, ENTRIES, SHA, [], FILLED)

    const rows = rowsOf(await open())

    const labelOf = (caseId: string, code: string) => rows.find((r) => r.case === caseId && r.code === code)!.label
    expect(labelOf('dev-01', 'C-A')).toBe('best')
    expect(labelOf('dev-01', 'C-M')).toBe('acceptable')
    expect(labelOf('dev-01', 'C-Z')).toBe('')
    expect(labelOf('dev-02', 'M-2')).toBe('best')
    expect(labelOf('dev-02', 'M-3')).toBe('acceptable')
    expect(labelOf('dev-02', 'M-1')).toBe('')
  })

  it('reads back, through readLabelSheet, as exactly the labels that were put in', async () => {
    await writeLabelSheet(path, ENTRIES, SHA, [], FILLED)

    const labels = await readLabelSheet(path, { version: 'v2', status: 'provisional' })

    expect(labels.cases).toEqual(FILLED)
    expect(labels.snapshotSha256).toBe(SHA)
  })

  it('still lists every row and leaves the sheet empty when no labels are given, as before', async () => {
    await writeLabelSheet(path, ENTRIES, SHA, [])

    const rows = rowsOf(await open())

    expect(rows).toHaveLength(7)
    expect(rows.every((r) => r.label === '')).toBe(true)
  })

  it('does not overwrite a sheet that exists, filled or not', async () => {
    await writeLabelSheet(path, ENTRIES, SHA)

    const error = await writeLabelSheet(path, ENTRIES, SHA, [], FILLED).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LabelSheetError)
    expect(rowsOf(await open()).every((r) => r.label === '')).toBe(true)
  })
})

// The label set file. Its path is the gitignored eval-data/ folder, relative to where the command runs, so these tests run from a temporary working directory: they never
// read or write the real folder. (Scripts tests run in plain Node processes, where a process may change its directory.)
describe('saveLabelSet and loadLabelSet: who labelled', () => {
  const SET: LabelSet = {
    version: 'v7',
    status: 'provisional',
    snapshotSha256: SHA,
    labelledBy: 'claude-opus-5-5',
    cases: { 'dev-01': { cleanse: { candidates: ['C-A', 'C-M'], best: 'C-A', acceptable: ['C-M'] } } },
  }
  let before: string
  beforeEach(() => {
    before = process.cwd()
    process.chdir(dir)
  })
  afterEach(() => {
    process.chdir(before)
  })

  /** Writes a label set file the way an earlier version of the eval did, by hand: that is the only way to get a legacy set. */
  const writeRaw = async (version: string, body: unknown) => {
    const file = labelSetPath(version)
    await mkdir(join(dir, 'eval-data/routine/labels'), { recursive: true })
    await writeFile(join(dir, file), JSON.stringify(body))
  }

  it('keeps who made the labels through a save and a load: labelledBy is the model that made them', async () => {
    await saveLabelSet(SET)

    expect(await loadLabelSet('v7')).toEqual(SET)
    expect(JSON.parse(await readFile(join(dir, labelSetPath('v7')), 'utf8')).labelledBy).toBe('claude-opus-5-5')
  })

  it('keeps a set that a human made as human through a save and a load', async () => {
    await saveLabelSet({ ...SET, version: 'v8', labelledBy: 'human' })

    expect((await loadLabelSet('v8')).labelledBy).toBe('human')
  })

  it('loads a legacy set written before labelledBy existed, and treats it as made by a human', async () => {
    const { labelledBy: _left, ...legacy } = SET
    await writeRaw('v1', legacy)

    const loaded = await loadLabelSet('v1')

    expect(loaded.labelledBy).toBe('human')
    expect(loaded.cases).toEqual(SET.cases)
    expect(loaded.status).toBe('provisional')
  })

  it.each([
    ['a number', 5],
    ['an empty string', ''],
    ['null', null],
  ])('refuses a set whose labelledBy is %s: it is not a label set', async (_label, labelledBy) => {
    await writeRaw('v9', { ...SET, version: 'v9', labelledBy })

    const error = await loadLabelSet('v9').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LabelSetError)
  })

  it('never overwrites a version that exists, and leaves the first set as it was', async () => {
    await saveLabelSet(SET)

    const error = await saveLabelSet({ ...SET, labelledBy: 'human' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LabelSetError)
    expect((error as Error).message).toMatch(/exists already/)
    expect((await loadLabelSet('v7')).labelledBy).toBe('claude-opus-5-5')
  })
})

describe('labelSetPath', () => {
  it('puts a version under the gitignored eval-data folder', () => {
    expect(labelSetPath('v1')).toBe('eval-data/routine/labels/v1.json')
    expect(labelSetPath('v2-derm')).toBe('eval-data/routine/labels/v2-derm.json')
  })

  it.each(['', '../v1', 'a/b', '.hidden', 'v1.json', 'v 1'])('refuses the version %j, which is not a plain name for a file', (version) => {
    expect(() => labelSetPath(version)).toThrow()
  })
})
