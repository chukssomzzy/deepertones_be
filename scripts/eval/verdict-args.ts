import type { AiJob } from '../../src/providers/anthropic/ai-spend.provider'
import { priceOf } from '../../src/providers/anthropic/anthropic.provider'
import { DEFAULT_MODELS } from './models'
import { dollars, read, RoutineUsageError } from './routine-args'
import { isLabelVersion } from './routine-labels'
import { DEFAULT_VERDICT_ROOT, type VerdictSet } from './verdict-cases'
import { DEFAULT_VERDICT_SNAPSHOT_PATH } from './verdict-reference'

/** A bad command line: the CLI prints the message, which holds the usage, and exits 2 before anything is spent. */
export class VerdictUsageError extends Error {}

const DEFAULT_MAX_USD = 3
const DEFAULT_OUT_DIR = '.eval'

/** The one AI job this eval runs, and the only one `--model` may move. */
const FIT_JOB = 'fit-verdict'

export type VerdictArgs = {
  set: VerdictSet
  limit: number | undefined
  labels: string | undefined
  snapshot: string
  root: string
  maxUsd: number
  models: { 'fit-verdict'?: string }
  outDir: string
  floorOnly: boolean
}

export const VERDICT_USAGE =
  'Usage: npm run eval:verdict -- [--set main|holdout] [--limit N] [--labels VERSION] [--snapshot PATH] [--root DIR] [--max-usd N] [--model fit-verdict=MODEL] [--out-dir DIR] [--floor-only] ' +
  `(the default set is main, the cap ${DEFAULT_MAX_USD} dollars, the root ${DEFAULT_VERDICT_ROOT}, the snapshot ${DEFAULT_VERDICT_SNAPSHOT_PATH} and the out directory ${DEFAULT_OUT_DIR}; --floor-only runs the rules floor alone: no key, no call, no cost)`

export const VERDICT_RESCORE_USAGE = `Usage: npm run eval:verdict:rescore -- --report PATH/report.json --labels VERSION [--root DIR] [--out-dir DIR] (scores the answers saved in a report written by eval:verdict against another version of the labels; it makes no call and costs nothing; the default root is ${DEFAULT_VERDICT_ROOT} and the out directory ${DEFAULT_OUT_DIR})`

/** The shared reader and dollar check of eval:routine, with their refusals turned into this command's. */
const asUsageError = <T>(work: () => T): T => {
  try {
    return work()
  } catch (error) {
    if (error instanceof RoutineUsageError) throw new VerdictUsageError(error.message)
    throw error
  }
}

/** Strict, as `eval:routine`'s are. Every refusal is a VerdictUsageError. */
export const parseVerdictArgs = (argv: string[]): VerdictArgs => {
  const fail = (reason: string): never => {
    throw new VerdictUsageError(`${reason}. ${VERDICT_USAGE}`)
  }
  const args: VerdictArgs = { set: 'main', limit: undefined, labels: undefined, snapshot: DEFAULT_VERDICT_SNAPSHOT_PATH, root: DEFAULT_VERDICT_ROOT, maxUsd: DEFAULT_MAX_USD, models: {}, outDir: DEFAULT_OUT_DIR, floorOnly: false }
  const readings = asUsageError(() => read(argv, ['--set', '--limit', '--labels', '--snapshot', '--root', '--max-usd', '--model', '--out-dir', '--floor-only'], [], VERDICT_USAGE, ['--floor-only']))
  for (const { flag, value } of readings) {
    if (flag === '--set') {
      if (value !== 'main' && value !== 'holdout') fail(`Unknown set "${value}" (main or holdout)`)
      args.set = value as VerdictSet
    } else if (flag === '--limit') {
      if (!/^\d+$/.test(value) || Number(value) < 1) fail('--limit must be a whole number of at least 1')
      args.limit = Number(value)
    } else if (flag === '--labels') {
      if (!isLabelVersion(value)) fail('--labels must be a plain version name such as v1')
      args.labels = value
    } else if (flag === '--snapshot') args.snapshot = value
    else if (flag === '--root') args.root = value
    else if (flag === '--max-usd') args.maxUsd = asUsageError(() => dollars(value, flag, VERDICT_USAGE))
    else if (flag === '--model') {
      const split = value.indexOf('=')
      const model = value.slice(split + 1)
      if (split === -1 || value.slice(0, split) !== FIT_JOB || model === '') fail(`--model must be ${FIT_JOB}=MODEL: the fit judge is the only AI job this eval runs`)
      // Said before any case is run: a model with no price could not be held to the cap.
      if (!priceOf(model)) fail(`No price is known for model "${model}" (the ${FIT_JOB} job), so its spend could not be capped. Use a model with a price`)
      args.models[FIT_JOB] = model
    } else if (flag === '--out-dir') args.outDir = value
    else args.floorOnly = true
  }
  return args
}

/** The models of a run: the eval defaults (the fit judge on Sonnet), then the `--model` override. */
export const resolveVerdictModels = (overrides: Partial<Record<AiJob, string>>): Record<AiJob, string> => ({ ...DEFAULT_MODELS, ...overrides })

export type VerdictRescoreArgs = { report: string; labels: string; root: string; outDir: string }

/** The arguments of `eval:verdict:rescore`: nothing else is accepted, since a rescore makes no call. */
export const parseVerdictRescoreArgs = (argv: string[]): VerdictRescoreArgs => {
  const fail = (reason: string): never => {
    throw new VerdictUsageError(`${reason}. ${VERDICT_RESCORE_USAGE}`)
  }
  let report: string | undefined
  let labels: string | undefined
  let root = DEFAULT_VERDICT_ROOT
  let outDir = DEFAULT_OUT_DIR
  for (const { flag, value } of asUsageError(() => read(argv, ['--report', '--labels', '--root', '--out-dir'], [], VERDICT_RESCORE_USAGE))) {
    if (flag === '--report') report = value
    else if (flag === '--labels') {
      if (!isLabelVersion(value)) fail('--labels must be a plain version name such as v1')
      labels = value
    } else if (flag === '--root') root = value
    else outDir = value
  }
  if (report === undefined) fail('--report is needed')
  if (labels === undefined) fail('--labels is needed')
  return { report: report!, labels: labels!, root, outDir }
}
