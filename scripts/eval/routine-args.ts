import { AI_JOBS, type AiJob } from '../../src/providers/anthropic/ai-spend.provider'
import { priceOf } from '../../src/providers/anthropic/anthropic.provider'
import { DEFAULT_MODELS } from './models'
import type { RoutineSet } from './routine-cases'
import { isLabelVersion, LABEL_STATUSES, type LabelStatus } from './routine-labels'
import { DEFAULT_SNAPSHOT_PATH } from './routine-snapshot'

/** A bad command line: the CLI prints the message, which holds the usage, and exits 2 before anything is spent. */
export class RoutineUsageError extends Error {}

/** What a run is over: the dev or holdout cases, or the hint cases built from a label set. */
export type RoutineRunSet = RoutineSet | 'hints'

export type RoutineArgs = {
  set: RoutineRunSet
  limit: number | undefined
  models: Partial<Record<AiJob, string>>
  labels: string | undefined
  maxUsd: number
  /** The most page-support checks (fetch calls) for the whole run. */
  maxGrounding: number
  snapshot: string
  outDir: string | undefined
  compare: string | undefined
}

const DEFAULT_MAX_USD = 5
const DEFAULT_MAX_GROUNDING = 40

export const USAGE =
  'Usage: npm run eval:routine -- [--set dev|holdout|hints] [--limit N] [--model JOB=MODEL]... [--labels VERSION] [--max-usd N] [--max-grounding N] [--snapshot PATH] [--out-dir DIR] [--compare REPORT.json] ' +
  `(JOB is one of ${AI_JOBS.join(', ')}; the default set is holdout, the cap ${DEFAULT_MAX_USD} dollars, at most ${DEFAULT_MAX_GROUNDING} page-support checks, and the snapshot ${DEFAULT_SNAPSHOT_PATH}; the hints set is built from a label set, so it needs --labels)`

type Reading = { flag: string; value: string }

/**
 * The flags in `argv` as `--flag value` or `--flag=value`, each value non-empty and not another flag. Strict on purpose: a misspelt flag must stop the
 * run before it spends money. `known` are the flags the command takes; `repeatable` may be given more than once.
 */
const read = (argv: string[], known: readonly string[], repeatable: readonly string[], usage: string): Reading[] => {
  const fail = (reason: string): never => {
    throw new RoutineUsageError(`${reason}. ${usage}`)
  }
  const readings: Reading[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    if (!known.includes(flag)) fail(`Unrecognised argument "${arg}"`)
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
    if (value === undefined || value === '' || value.startsWith('-')) fail(`${flag} needs a value`)
    if (!repeatable.includes(flag) && readings.some((r) => r.flag === flag)) fail(`${flag} was given twice`)
    readings.push({ flag, value: value! })
  }
  return readings
}

const wholeNumber = (value: string): boolean => /^\d+$/.test(value)

const dollars = (value: string, flag: string, usage: string): number => {
  if (!/^\d+(\.\d+)?$/.test(value) || !(Number(value) > 0) || !Number.isFinite(Number(value))) throw new RoutineUsageError(`${flag} must be a number of dollars above 0. ${usage}`)
  return Number(value)
}

/** Strict, as `eval:catalog`'s are. Every refusal is a RoutineUsageError. */
export const parseRoutineArgs = (argv: string[]): RoutineArgs => {
  const fail = (reason: string): never => {
    throw new RoutineUsageError(`${reason}. ${USAGE}`)
  }
  const args: RoutineArgs = { set: 'holdout', limit: undefined, models: {}, labels: undefined, maxUsd: DEFAULT_MAX_USD, maxGrounding: DEFAULT_MAX_GROUNDING, snapshot: DEFAULT_SNAPSHOT_PATH, outDir: undefined, compare: undefined }
  for (const { flag, value } of read(argv, ['--set', '--limit', '--model', '--labels', '--max-usd', '--max-grounding', '--snapshot', '--out-dir', '--compare'], ['--model'], USAGE)) {
    if (flag === '--set') {
      if (value !== 'dev' && value !== 'holdout' && value !== 'hints') fail(`Unknown set "${value}" (dev, holdout or hints)`)
      args.set = value as RoutineRunSet
    } else if (flag === '--limit') {
      if (!/^\d+$/.test(value) || Number(value) < 1) fail('--limit must be a whole number of at least 1')
      args.limit = Number(value)
    } else if (flag === '--model') {
      const split = value.indexOf('=')
      const job = value.slice(0, split)
      const model = value.slice(split + 1)
      if (split === -1 || !AI_JOBS.includes(job as AiJob) || model === '') fail('--model must be JOB=MODEL with a known job')
      args.models[job as AiJob] = model
    } else if (flag === '--labels') {
      if (!isLabelVersion(value)) fail('--labels must be a plain version name such as v1')
      args.labels = value
    } else if (flag === '--max-usd') args.maxUsd = dollars(value, flag, USAGE)
    // 0 is allowed: it runs the whole eval without the page-support checks.
    else if (flag === '--max-grounding') {
      if (!wholeNumber(value)) fail('--max-grounding must be a whole number of fetch calls (0 for none)')
      args.maxGrounding = Number(value)
    }
    else if (flag === '--snapshot') args.snapshot = value
    else if (flag === '--out-dir') args.outDir = value
    else args.compare = value
  }
  if (args.set === 'hints' && args.labels === undefined) fail('--set hints is built from a label set, so it needs --labels VERSION')
  return args
}

/** The models of a run: the eval defaults, with the rubric judge on Opus (it grades the writer, so it should be the stronger model; `--model judge-routine=...` moves it), then the `--model` overrides. */
export const resolveRoutineModels = (overrides: Partial<Record<AiJob, string>>): Record<AiJob, string> => ({ ...DEFAULT_MODELS, 'judge-routine': 'claude-opus-5-5', ...overrides })

/** The model a job will run on must have a price, or the spend cap could not count its calls: said before any case is run, not as a key problem when the first one is. */
export const requirePricedModel = (job: AiJob, model: string): void => {
  if (!priceOf(model)) throw new RoutineUsageError(`No price is known for model "${model}" (the ${job} job), so its spend could not be capped. Use a model with a price. ${USAGE}`)
}

export const SHEET_USAGE = `Usage: npm run eval:routine:sheet -- [--set dev|holdout|all] [--snapshot PATH] [--out PATH] (default: all cases, the snapshot ${DEFAULT_SNAPSHOT_PATH}, out eval-data/routine/label-sheet-<set>.xlsx)`

export type SheetArgs = { set: RoutineSet | 'all'; snapshot: string; out: string }

export const parseSheetArgs = (argv: string[]): SheetArgs => {
  let set: SheetArgs['set'] = 'all'
  let snapshot = DEFAULT_SNAPSHOT_PATH
  let out: string | undefined
  for (const { flag, value } of read(argv, ['--set', '--snapshot', '--out'], [], SHEET_USAGE)) {
    if (flag === '--set') {
      if (value !== 'dev' && value !== 'holdout' && value !== 'all') throw new RoutineUsageError(`Unknown set "${value}" (dev, holdout or all). ${SHEET_USAGE}`)
      set = value
    } else if (flag === '--snapshot') snapshot = value
    else out = value
  }
  return { set, snapshot, out: out ?? `eval-data/routine/label-sheet-${set}.xlsx` }
}

export const LABELS_USAGE = 'Usage: npm run eval:routine:labels -- --sheet SHEET.xlsx --version VERSION [--status provisional|clinical|outcome] (writes eval-data/routine/labels/VERSION.json; the default status is provisional)'

export type LabelsArgs = { sheet: string; version: string; status: LabelStatus }

export const parseLabelsArgs = (argv: string[]): LabelsArgs => {
  const fail = (reason: string): never => {
    throw new RoutineUsageError(`${reason}. ${LABELS_USAGE}`)
  }
  let sheet: string | undefined
  let version: string | undefined
  let status: LabelStatus = 'provisional'
  for (const { flag, value } of read(argv, ['--sheet', '--version', '--status'], [], LABELS_USAGE)) {
    if (flag === '--sheet') sheet = value
    else if (flag === '--version') {
      if (!isLabelVersion(value)) fail('--version must be a plain version name such as v1')
      version = value
    } else {
      if (!LABEL_STATUSES.includes(value as LabelStatus)) fail(`Unknown status "${value}"`)
      status = value as LabelStatus
    }
  }
  if (sheet === undefined) fail('--sheet is needed')
  if (version === undefined) fail('--version is needed')
  return { sheet: sheet!, version: version!, status }
}

export const OUTCOMES_USAGE = 'Usage: npm run eval:routine:outcomes -- --counts FILE.json --labels VERSION --out NEWVERSION (reads eval-data/routine/labels/VERSION.json, writes NEWVERSION.json with status outcome and NEWVERSION.note.md beside it)'

export type OutcomesArgs = { counts: string; labels: string; out: string }

export const parseOutcomesArgs = (argv: string[]): OutcomesArgs => {
  const fail = (reason: string): never => {
    throw new RoutineUsageError(`${reason}. ${OUTCOMES_USAGE}`)
  }
  let counts: string | undefined
  let labels: string | undefined
  let out: string | undefined
  for (const { flag, value } of read(argv, ['--counts', '--labels', '--out'], [], OUTCOMES_USAGE)) {
    if (flag === '--counts') counts = value
    else if (flag === '--labels') {
      if (!isLabelVersion(value)) fail('--labels must be a plain version name such as v1')
      labels = value
    } else {
      if (!isLabelVersion(value)) fail('--out must be a plain version name such as v2')
      out = value
    }
  }
  if (counts === undefined) fail('--counts is needed')
  if (labels === undefined) fail('--labels is needed')
  if (out === undefined) fail('--out is needed')
  if (out === labels) fail('--out must be a new version: a label set is never overwritten')
  return { counts: counts!, labels: labels!, out: out! }
}
