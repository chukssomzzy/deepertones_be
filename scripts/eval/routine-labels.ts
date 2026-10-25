/*
 * The labels of the routine eval: for each case and each gap, which of the gap's candidates is the best one, which are acceptable, and which are not. A
 * person makes them in a sheet (writeLabelSheet) that lists every case x gap x candidate with an empty `label` column and no model output, then
 * readLabelSheet turns the filled sheet into a LabelSet pinned to the snapshot it was made on. Label sets name catalog products, so they live in the
 * gitignored eval-data/ folder and are never committed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { ROUTINE_STEPS, type RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { RoutineSkeleton } from '../../src/modules/routines/routines.types'

export const LABEL_STATUSES = ['provisional', 'clinical', 'outcome'] as const
export type LabelStatus = (typeof LABEL_STATUSES)[number]

export type GapLabel = { candidates: string[]; best: string; acceptable: string[] }
export type LabelSet = {
  version: string
  status: LabelStatus
  snapshotSha256: string
  /** Per case, a label for each gap that has candidates (a gap with none is "use what you have" and has nothing to label). */
  cases: Record<string, Partial<Record<RoutineStep, GapLabel>>>
}

export type LabelProblem =
  | { caseId: string; step: RoutineStep; problem: 'two-bests' | 'no-best' }
  | { caseId: string; step: RoutineStep; code: string; problem: 'unknown-label' }

/** A sheet that cannot become a label set. `problems` lists every one by case and step (never a cell's text), so a person fixes them all in one go. */
export class LabelSheetError extends Error {
  constructor(
    message: string,
    readonly problems: LabelProblem[] = [],
  ) {
    super(message)
  }
}

/** A label set file that is missing or not a label set. */
export class LabelSetError extends Error {}

const LABELS_DIR = 'eval-data/routine/labels'

/** A plain name for a file: letters, digits, dash and underscore, starting with a letter or digit. No path, no dot, no space. */
export const isLabelVersion = (version: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(version)

export const labelSetPath = (version: string): string => {
  if (!isLabelVersion(version)) throw new Error(`"${version}" is not a plain label set version (letters, digits, - and _)`)
  return `${LABELS_DIR}/${version}.json`
}

const GapLabelSchema = z.object({ candidates: z.array(z.string()), best: z.string(), acceptable: z.array(z.string()) })
const LabelSetSchema = z.object({
  version: z.string(),
  status: z.enum(LABEL_STATUSES),
  snapshotSha256: z.string(),
  cases: z.record(z.string(), z.object(Object.fromEntries(ROUTINE_STEPS.map((step) => [step, GapLabelSchema.optional()])))),
})

/** The label set of a version, from the gitignored folder. */
export const loadLabelSet = async (version: string): Promise<LabelSet> => {
  const path = labelSetPath(version)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') throw new LabelSetError(`No label set at ${path}. Make one with npm run eval:routine:sheet, then npm run eval:routine:labels.`)
    throw error
  }
  try {
    return LabelSetSchema.parse(JSON.parse(text)) as LabelSet
  } catch {
    throw new LabelSetError(`${path} is not a label set.`)
  }
}

/** Writes a label set to its path, making the folder. Refuses a version that exists: a version is a record, and a new set gets a new version. */
export const saveLabelSet = async (labels: LabelSet): Promise<string> => {
  const path = labelSetPath(labels.version)
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, `${JSON.stringify(labels, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'EEXIST') throw new LabelSetError(`${path} exists already. A label set is never overwritten: pick a new version.`)
    throw error
  }
  return path
}

// --- the sheet ---------------------------------------------------------------------------------------------------------------------------------

const SHEET = 'Labels'
const META = '_meta'
const COLUMNS = ['case', 'country', 'currency', 'goal', 'skin type', 'seen', 'also noticed', 'cautions', 'budget', 'step', 'code', 'brand', 'name', 'form', 'ingredients', 'skin concerns', 'price min', 'price max', 'frequency', 'label'] as const
type Column = (typeof COLUMNS)[number]
const LABEL_WORDS = ['best', 'acceptable', 'not'] as const

const WIDTHS: Partial<Record<Column, number>> = { case: 9, country: 8, currency: 9, goal: 16, 'skin type': 12, seen: 30, 'also noticed': 24, cautions: 18, budget: 8, step: 10, code: 26, brand: 18, name: 30, form: 9, ingredients: 60, 'skin concerns': 24, frequency: 14, label: 12 }

/** A case for the sheet: its skeleton, and its country (the skeleton does not name it) so the prices shown can be read in the right money. */
export type SheetEntry = { id: string; skeleton: RoutineSkeleton; country?: string }

/**
 * One row per case x gap x candidate, in the skeleton's order, with the label column empty. Nothing in it comes from a model. `countries` (the snapshot's
 * Countries tab) gives each case's currency. A sheet that exists is never overwritten: it may hold hours of someone's labels, so this refuses.
 */
export const writeLabelSheet = async (path: string, entries: SheetEntry[], snapshotSha256: string, countries: readonly { code: string; currency: string }[] = []): Promise<void> => {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet(SHEET)
  sheet.addRow([...COLUMNS])
  sheet.getRow(1).font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  COLUMNS.forEach((column, index) => {
    const width = WIDTHS[column]
    if (width !== undefined) sheet.getColumn(index + 1).width = width
  })
  const labelColumn = COLUMNS.indexOf('label') + 1
  for (const { id, skeleton, country } of entries) {
    const currency = countries.find((c) => c.code === country)?.currency
    const { person } = skeleton
    const levels = (list: { concern: string; level: string }[]) => list.map((s) => `${s.concern}: ${s.level}`).join('; ')
    for (const gap of skeleton.gaps) {
      for (const candidate of gap.candidates) {
        const row = sheet.addRow([
          id,
          country ?? '',
          currency ?? '',
          skeleton.goal,
          person.skinType ?? '',
          levels(person.seen),
          levels(person.alsoNoticed),
          person.cautions.join('; '),
          person.budgetBand ?? '',
          gap.step,
          candidate.code,
          candidate.brand,
          candidate.name,
          candidate.form ?? '',
          candidate.ingredients.join('; '),
          candidate.skinConcerns.join('; '),
          candidate.priceMin,
          candidate.priceMax,
          candidate.frequency,
          null,
        ])
        row.getCell(labelColumn).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${LABEL_WORDS.join(',')}"`] }
      }
    }
  }
  const meta = book.addWorksheet(META)
  meta.state = 'veryHidden'
  meta.addRow(['snapshotSha256', snapshotSha256])
  try {
    await writeFile(path, Buffer.from(await book.xlsx.writeBuffer()), { flag: 'wx' })
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'EEXIST') throw new LabelSheetError(`${path} exists already. A label sheet is never overwritten: pick another --out, or move the old one.`)
    throw error
  }
}

const textOf = (cell: ExcelJS.Cell): string => (cell.value === null || cell.value === undefined ? '' : cell.text)

type SheetRow = { caseId: string; step: RoutineStep; code: string; typed: string }

/**
 * A filled sheet as a label set. A blank label is `not`; best, acceptable and not are read whatever the case or spacing. Every gap needs exactly one best
 * (a gap with a single candidate has it automatically), and a word that is none of the three is refused rather than read as `not`. Every problem is
 * listed by case and step in the error.
 */
export const readLabelSheet = async (path: string, { version, status }: { version: string; status: LabelStatus }): Promise<LabelSet> => {
  const book = new ExcelJS.Workbook()
  await book.xlsx.readFile(path)
  const sheet = book.worksheets.find((s) => s.state === 'visible')
  const meta = book.getWorksheet(META)
  let snapshotSha256: string | undefined
  meta?.eachRow((row) => {
    if (textOf(row.getCell(1)) === 'snapshotSha256') snapshotSha256 = textOf(row.getCell(2))
  })
  if (!sheet || !snapshotSha256) throw new LabelSheetError('This is not a label sheet made by npm run eval:routine:sheet (no Labels sheet, or no snapshot stamp).')

  const at = new Map<string, number>()
  sheet.getRow(1).eachCell((cell, column) => void at.set(textOf(cell), column))
  const missing = (['case', 'step', 'code', 'label'] as const).filter((name) => !at.has(name))
  if (missing.length > 0) throw new LabelSheetError(`The label sheet lacks the column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}.`)
  const cell = (row: ExcelJS.Row, name: Column) => textOf(row.getCell(at.get(name)!)).trim()

  const rows: SheetRow[] = []
  for (let number = 2; number <= sheet.rowCount; number++) {
    const row = sheet.getRow(number)
    const caseId = cell(row, 'case')
    if (caseId === '') continue
    const step = cell(row, 'step') as RoutineStep
    if (!ROUTINE_STEPS.includes(step)) throw new LabelSheetError(`Row ${number} of the label sheet names a step that is not one of the routine's.`)
    rows.push({ caseId, step, code: cell(row, 'code'), typed: cell(row, 'label').toLowerCase() })
  }

  const gaps = new Map<string, SheetRow[]>()
  for (const row of rows) gaps.set(`${row.caseId}\u0000${row.step}`, [...(gaps.get(`${row.caseId}\u0000${row.step}`) ?? []), row])

  const problems: LabelProblem[] = []
  const cases: LabelSet['cases'] = {}
  for (const members of gaps.values()) {
    const { caseId, step } = members[0]!
    const unknown = members.filter((m) => m.typed !== '' && !(LABEL_WORDS as readonly string[]).includes(m.typed))
    for (const m of unknown) problems.push({ caseId, step, code: m.code, problem: 'unknown-label' })
    const candidates = members.map((m) => m.code).sort()
    const bests = members.filter((m) => m.typed === 'best').map((m) => m.code)
    // A word nobody could read might have been the best, so the gap is not also told it has none.
    if (bests.length > 1) problems.push({ caseId, step, problem: 'two-bests' })
    else if (bests.length === 0 && members.length > 1 && unknown.length === 0) problems.push({ caseId, step, problem: 'no-best' })
    if (bests.length === 1 || members.length === 1) {
      cases[caseId] = {
        ...cases[caseId],
        [step]: { candidates, best: members.length === 1 ? members[0]!.code : bests[0]!, acceptable: members.filter((m) => m.typed === 'acceptable').map((m) => m.code).sort() },
      }
    }
  }
  if (problems.length > 0) {
    const shown = problems.map((p) => `  ${p.caseId} ${p.step}${p.problem === 'unknown-label' ? ` ${p.code}` : ''}: ${p.problem}`)
    throw new LabelSheetError(`The label sheet has ${problems.length} problem${problems.length > 1 ? 's' : ''} (best, acceptable or not; one best per gap):\n${shown.join('\n')}`, problems)
  }
  return { version, status, snapshotSha256, cases }
}
