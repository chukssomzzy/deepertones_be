import { AI_JOBS, type AiJob } from '../../src/providers/anthropic/ai-spend.provider'
import { priceOf } from '../../src/providers/anthropic/anthropic.provider'
import { DEFAULT_MODELS } from './models'
import type { RoutineSet } from './routine-cases'
import { isLabelVersion, LABEL_STATUSES, type LabelStatus } from './routine-labels'
import { DEFAULT_SNAPSHOT_PATH } from './routine-snapshot'

/** A bad command line: the CLI prints the message, which holds the usage, and exits 2 before anything is spent. */
export class RoutineUsageError extends Error {}

/** The rubric judges there can be, and the model each runs on. Nothing else judges a routine. */
export const JUDGE_MODELS = { haiku: 'claude-haiku-5-5', opus: 'claude-opus-5-5' } as const
export type JudgeName = keyof typeof JUDGE_MODELS
const JUDGE_NAMES = Object.keys(JUDGE_MODELS) as JudgeName[]

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
  /** The rubric judges, in the order given: each judges every routine, and the run compares them. */
  judges: JudgeName[]
  snapshot: string
  outDir: string | undefined
  compare: string | undefined
}

const DEFAULT_MAX_USD = 5
const DEFAULT_MAX_GROUNDING = 40
const DEFAULT_REJUDGE_MAX_USD = 1

export const USAGE =
  'Usage: npm run eval:routine -- [--set dev|holdout|hints] [--limit N] [--model JOB=MODEL]... [--labels VERSION] [--max-usd N] [--max-grounding N] [--judges haiku|opus|haiku,opus] [--snapshot PATH] [--out-dir DIR] [--compare REPORT.json] ' +
  `(JOB is one of ${AI_JOBS.join(', ')}; the default set is holdout, the cap ${DEFAULT_MAX_USD} dollars, at most ${DEFAULT_MAX_GROUNDING} page-support checks, the rubric judge haiku (opus can be added to compare; a model never judges its own routines), and the snapshot ${DEFAULT_SNAPSHOT_PATH}; the hints set is built from a label set, so it needs --labels)`

type Reading = { flag: string; value: string }

/**
 * The flags in `argv` as `--flag value` or `--flag=value`, each value non-empty and not another flag. Strict on purpose: a misspelt flag must stop the
 * run before it spends money. `known` are the flags the command takes; `repeatable` may be given more than once; `bare` are the switches among them, which
 * take no value (their reading is `true`) and so cannot be written `--flag=value`.
 */
export const read = (argv: string[], known: readonly string[], repeatable: readonly string[], usage: string, bare: readonly string[] = []): Reading[] => {
  const fail = (reason: string): never => {
    throw new RoutineUsageError(`${reason}. ${usage}`)
  }
  const readings: Reading[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    if (!known.includes(flag) || (bare.includes(flag) && equals !== -1)) fail(`Unrecognised argument "${arg}"`)
    if (bare.includes(flag)) {
      if (readings.some((r) => r.flag === flag)) fail(`${flag} was given twice`)
      readings.push({ flag, value: 'true' })
      continue
    }
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
    if (value === undefined || value === '' || value.startsWith('-')) fail(`${flag} needs a value`)
    if (!repeatable.includes(flag) && readings.some((r) => r.flag === flag)) fail(`${flag} was given twice`)
    readings.push({ flag, value: value! })
  }
  return readings
}

/** The judges in a `--judges` value: a comma list of known names, none empty or twice. */
const judgeNamesOf = (value: string, fail: (reason: string) => never): JudgeName[] => {
  const names = value.split(',')
  if (names.some((name) => !JUDGE_NAMES.includes(name as JudgeName))) fail(`--judges must be a comma list of ${JUDGE_NAMES.join(' and ')} with no empty name`)
  if (new Set(names).size !== names.length) fail('--judges names a judge twice')
  return names as JudgeName[]
}

const wholeNumber = (value: string): boolean => /^\d+$/.test(value)

export const dollars = (value: string, flag: string, usage: string): number => {
  if (!/^\d+(\.\d+)?$/.test(value) || !(Number(value) > 0) || !Number.isFinite(Number(value))) throw new RoutineUsageError(`${flag} must be a number of dollars above 0. ${usage}`)
  return Number(value)
}

/** Strict, as `eval:catalog`'s are. Every refusal is a RoutineUsageError. */
export const parseRoutineArgs = (argv: string[]): RoutineArgs => {
  const fail = (reason: string): never => {
    throw new RoutineUsageError(`${reason}. ${USAGE}`)
  }
  const args: RoutineArgs = { set: 'holdout', limit: undefined, models: {}, labels: undefined, maxUsd: DEFAULT_MAX_USD, maxGrounding: DEFAULT_MAX_GROUNDING, judges: ['haiku'], snapshot: DEFAULT_SNAPSHOT_PATH, outDir: undefined, compare: undefined }
  for (const { flag, value } of read(argv, ['--set', '--limit', '--model', '--labels', '--max-usd', '--max-grounding', '--judges', '--snapshot', '--out-dir', '--compare'], ['--model'], USAGE)) {
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
      if (job === 'judge-routine') fail('--model cannot move the rubric judge: choose the judges with --judges haiku, --judges opus or --judges haiku,opus')
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
    else if (flag === '--judges') args.judges = judgeNamesOf(value, fail)
    else if (flag === '--snapshot') args.snapshot = value
    else if (flag === '--out-dir') args.outDir = value
    else args.compare = value
  }
  // A hint run asks the writer alone, so nothing judges and nothing can judge itself.
  const writer = args.models['write-routine'] ?? DEFAULT_MODELS['write-routine']
  if (args.set !== 'hints' && args.judges.some((name) => JUDGE_MODELS[name] === writer)) {
    const others = JUDGE_NAMES.filter((name) => JUDGE_MODELS[name] !== writer)
    fail(`A model never judges its own routines: write-routine runs on ${writer}, which is also a judge in --judges. Pass --judges ${others.join(',')}`)
  }
  if (args.set === 'hints' && args.labels === undefined) fail('--set hints is built from a label set, so it needs --labels VERSION')
  return args
}

/** The models of a run: the eval defaults, then the `--model` overrides. The rubric judges' models come from `--judges` (resolveRoutineJudges), one client each. */
export const resolveRoutineModels = (overrides: Partial<Record<AiJob, string>>): Record<AiJob, string> => ({ ...DEFAULT_MODELS, ...overrides })

/** The judges of a run with their models, in the order given. */
export const resolveRoutineJudges = (names: readonly JudgeName[]): { name: JudgeName; model: string }[] => names.map((name) => ({ name, model: JUDGE_MODELS[name] }))

/** The model a job will run on must have a price, or the spend cap could not count its calls: said before any case is run, not as a key problem when the first one is. */
export const requirePricedModel = (job: AiJob, model: string, usage: string = USAGE): void => {
  if (!priceOf(model)) throw new RoutineUsageError(`No price is known for model "${model}" (the ${job} job), so its spend could not be capped. Use a model with a price. ${usage}`)
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

const DEFAULT_AUTO_LABEL_MODEL = 'claude-opus-5-5'
const DEFAULT_AUTO_LABEL_MAX_USD = 10

export const AUTO_LABEL_USAGE = `Usage: npm run eval:routine:auto-label -- --version VERSION [--set all|dev|holdout] [--snapshot PATH] [--model label-routine=MODEL] [--max-usd N] [--limit N] (an AI labeller labels the cases as a dermatologist would; writes eval-data/routine/labels/VERSION.json, status provisional, and a filled copy of the label sheet; the default set is all, the model ${DEFAULT_AUTO_LABEL_MODEL}, the cap ${DEFAULT_AUTO_LABEL_MAX_USD} dollars and the snapshot ${DEFAULT_SNAPSHOT_PATH})`

export type AutoLabelArgs = { version: string; set: RoutineSet | 'all'; snapshot: string; model: string; maxUsd: number; limit: number | undefined }

/**
 * The labelling model is not in DEFAULT_MODELS (that table is held to wrangler.jsonc, which has the job on Haiku): the command defaults it to Opus itself, so the
 * parsed args carry it. `--model` takes only the label-routine job here.
 */
export const parseAutoLabelArgs = (argv: string[]): AutoLabelArgs => {
  const fail = (reason: string): never => {
    throw new RoutineUsageError(`${reason}. ${AUTO_LABEL_USAGE}`)
  }
  let version: string | undefined
  const args: Omit<AutoLabelArgs, 'version'> = { set: 'all', snapshot: DEFAULT_SNAPSHOT_PATH, model: DEFAULT_AUTO_LABEL_MODEL, maxUsd: DEFAULT_AUTO_LABEL_MAX_USD, limit: undefined }
  for (const { flag, value } of read(argv, ['--version', '--set', '--snapshot', '--model', '--max-usd', '--limit'], [], AUTO_LABEL_USAGE)) {
    if (flag === '--version') {
      if (!isLabelVersion(value)) fail('--version must be a plain version name such as v1')
      version = value
    } else if (flag === '--set') {
      if (value !== 'all' && value !== 'dev' && value !== 'holdout') fail(`Unknown set "${value}" (all, dev or holdout)`)
      args.set = value as AutoLabelArgs['set']
    } else if (flag === '--snapshot') args.snapshot = value
    else if (flag === '--model') {
      const split = value.indexOf('=')
      if (split === -1 || value.slice(0, split) !== 'label-routine' || split === value.length - 1) fail('--model must be label-routine=MODEL')
      args.model = value.slice(split + 1)
    } else if (flag === '--max-usd') args.maxUsd = dollars(value, flag, AUTO_LABEL_USAGE)
    else {
      if (!wholeNumber(value) || Number(value) < 1) fail('--limit must be a whole number of at least 1')
      args.limit = Number(value)
    }
  }
  if (version === undefined) fail('--version is needed')
  return { version: version!, ...args }
}

export const REJUDGE_USAGE = `Usage: npm run eval:routine:rejudge -- --report PATH/report.json --labels VERSION [--judges haiku|opus|haiku,opus] [--rescore] [--max-usd N] [--out-dir DIR] (judges the routines saved in a report written by eval:routine again, or with --rescore only scores its saved judgements against the labels, which costs nothing and takes no --judges or --max-usd; the default judge is haiku and the cap ${DEFAULT_REJUDGE_MAX_USD} dollar; the writer is never called)`

export type RejudgeArgs = { report: string; labels: string; judges: JudgeName[]; rescore: boolean; maxUsd: number; outDir: string | undefined }

export const parseRejudgeArgs = (argv: string[]): RejudgeArgs => {
  const fail = (reason: string): never => {
    throw new RoutineUsageError(`${reason}. ${REJUDGE_USAGE}`)
  }
  let report: string | undefined
  let labels: string | undefined
  const args = { judges: ['haiku'] as JudgeName[], rescore: false, maxUsd: DEFAULT_REJUDGE_MAX_USD, outDir: undefined as string | undefined }
  const given = new Set<string>()
  for (const { flag, value } of read(argv, ['--report', '--labels', '--judges', '--rescore', '--max-usd', '--out-dir'], [], REJUDGE_USAGE, ['--rescore'])) {
    given.add(flag)
    if (flag === '--report') report = value
    else if (flag === '--labels') {
      if (!isLabelVersion(value)) fail('--labels must be a plain version name such as v1')
      labels = value
    } else if (flag === '--judges') args.judges = judgeNamesOf(value, fail)
    else if (flag === '--max-usd') args.maxUsd = dollars(value, flag, REJUDGE_USAGE)
    else if (flag === '--out-dir') args.outDir = value
    else args.rescore = true
  }
  if (report === undefined) fail('--report is needed')
  if (labels === undefined) fail('--labels is needed')
  if (args.rescore && (given.has('--judges') || given.has('--max-usd'))) fail('--rescore makes no calls, so it takes no --judges or --max-usd')
  return { report: report!, labels: labels!, ...args }
}

/** A model never judges its own routines: `judges` are the ones asked, `writerModel` the one that wrote the saved routines (known once the report is read). */
export const refuseSelfJudging = (judges: readonly { name: string; model: string }[], writerModel: string): void => {
  if (!judges.some((judge) => judge.model === writerModel)) return
  const others = JUDGE_NAMES.filter((name) => JUDGE_MODELS[name] !== writerModel)
  throw new RoutineUsageError(`Refused, because a model never judges its own routines: the saved report's writer ran on ${writerModel}, which is also a judge in --judges. Pass --judges ${others.join(',')}. ${REJUDGE_USAGE}`)
}
