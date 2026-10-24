import { AI_JOBS, type AiJob } from '../../src/providers/anthropic/ai-spend.provider'
import { priceOf } from '../../src/providers/anthropic/anthropic.provider'
import type { RoutineSet } from './routine-cases'
import { isLabelVersion, LABEL_STATUSES, type LabelStatus } from './routine-labels'
import { DEFAULT_SNAPSHOT_PATH } from './routine-snapshot'

/** A bad command line: the CLI prints the message, which holds the usage, and exits 2 before anything is spent. */
export class RoutineUsageError extends Error {}

export type RoutineArgs = {
  set: RoutineSet
  limit: number | undefined
  models: Partial<Record<AiJob, string>>
  labels: string | undefined
  maxUsd: number
  snapshot: string
  outDir: string | undefined
  compare: string | undefined
}

const DEFAULT_MAX_USD = 5

export const USAGE =
  'Usage: npm run eval:routine -- [--set dev|holdout] [--limit N] [--model JOB=MODEL]... [--labels VERSION] [--max-usd N] [--snapshot PATH] [--out-dir DIR] [--compare REPORT.json] ' +
  `(JOB is one of ${AI_JOBS.join(', ')}; the default set is holdout, the cap ${DEFAULT_MAX_USD} dollars and the snapshot ${DEFAULT_SNAPSHOT_PATH})`

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

const dollars = (value: string, flag: string, usage: string): number => {
  if (!/^\d+(\.\d+)?$/.test(value) || !(Number(value) > 0) || !Number.isFinite(Number(value))) throw new RoutineUsageError(`${flag} must be a number of dollars above 0. ${usage}`)
  return Number(value)
}

/** Strict, as `eval:catalog`'s are. Every refusal is a RoutineUsageError. */
export const parseRoutineArgs = (argv: string[]): RoutineArgs => {
  const fail = (reason: string): never => {
    throw new RoutineUsageError(`${reason}. ${USAGE}`)
  }
  const args: RoutineArgs = { set: 'holdout', limit: undefined, models: {}, labels: undefined, maxUsd: DEFAULT_MAX_USD, snapshot: DEFAULT_SNAPSHOT_PATH, outDir: undefined, compare: undefined }
  for (const { flag, value } of read(argv, ['--set', '--limit', '--model', '--labels', '--max-usd', '--snapshot', '--out-dir', '--compare'], ['--model'], USAGE)) {
    if (flag === '--set') {
      if (value !== 'dev' && value !== 'holdout') fail(`Unknown set "${value}" (dev or holdout)`)
      args.set = value as RoutineSet
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
    else if (flag === '--snapshot') args.snapshot = value
    else if (flag === '--out-dir') args.outDir = value
    else args.compare = value
  }
  return args
}

/** The model the writer will run on must have a price, or the spend cap could not count its calls: said before any case is run, not as a key problem when the first one is. */
export const requirePricedWriterModel = (model: string): void => {
  if (!priceOf(model)) throw new RoutineUsageError(`No price is known for model "${model}" (the write-routine job), so its spend could not be capped. Use a model with a price. ${USAGE}`)
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
