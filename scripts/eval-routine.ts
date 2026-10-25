// Measures the routine writer against fixed synthetic people: `npm run eval:routine`. Needs ANTHROPIC_API_KEY (environment, else .dev.vars) and makes real,
// billed calls (one Sonnet call per case, one Haiku judge call per routine written (and one Opus call each with --judges opus or haiku,opus), and up to --max-grounding Haiku page-support checks). It is never part of `npm test`,
// and it never prints the key, a prompt, a routine's words, a judge's words or an error message: only case ids, gate codes, counts, scores and costs. The routines and the
// judges' answers go to report.json.
//   --set dev|holdout|hints   the cases to run (default holdout, the only set the bar is judged on; tune on dev; hints is built from the labels, so it needs --labels, and its
//   follow-rate and ignore-rate are not in the bar)    --limit N   run the first N cases    --max-grounding N   at most N page-support checks for the run (default 40)
//   --labels VERSION    the label set in eval-data/routine/labels/ that scores the picks    --snapshot PATH   the catalog snapshot (default eval-data/routine/catalog-snapshot.xlsx)
//   --max-usd N   stop spending at N dollars (default 5)    --model JOB=MODEL   run a job on another model (repeatable; not judge-routine, see --judges)
//   --judges haiku|opus|haiku,opus   the rubric judges (default haiku; Opus is dearer, add it to compare): each judges every routine, the run compares them, and a model never judges its own routines
//   --out-dir DIR   where report.json goes (default .eval/routine-<timestamp>)    --compare REPORT.json   say whether the scores are better or worse than an earlier report
// The last line is `Bar: PASS`, `Bar: FAIL (<rules>)` or `Bar: not evaluated (<reasons>)` (see "Routine eval" in docs/architecture.md).
// Exit: 0 the bar passes or the run was a trial (the bar was not evaluated), 1 the bar fails, 2 the run could not start (arguments, key, snapshot, labels) or Claude rejected the key.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { AnthropicClient } from '../src/providers/anthropic/anthropic.client'
import { MemoryAiSpendLedger } from '../src/providers/anthropic/memory.ai-spend-ledger'
import { AnthropicRoutineWriter } from '../src/providers/routine-writing/anthropic.routine-writer'
import { routineWriterWriteRoutinePrompt } from '../src/prompts/prompts.generated'
import { parseRoutineArgs, requirePricedModel, resolveRoutineJudges, resolveRoutineModels, RoutineUsageError } from './eval/routine-args'
import { ROUTINE_DEV, ROUTINE_HOLDOUT } from './eval/routine-cases'
import { AnthropicGroundingJudge } from './eval/routine-grounding-judge'
import { runHintEval } from './eval/routine-hints-run'
import { AnthropicRoutineJudge } from './eval/routine-judge'
import { type LabelSet, LabelSetError, loadLabelSet } from './eval/routine-labels'
import { runRoutineEval } from './eval/routine-run'
import type { Measures } from './eval/routine-score'
import { loadSnapshot, SnapshotError } from './eval/routine-snapshot'
import { loadEnv, MissingApiKeyError } from './eval/score'

/** Only the scores of an earlier report: what `--compare` needs. */
const readPrevious = (path: string): { summary: Measures } => {
  try {
    const { summary } = JSON.parse(readFileSync(path, 'utf8')) as { summary: Measures }
    const number = (value: unknown) => (typeof value === 'number' ? value : null)
    return { summary: { rightProduct: number(summary.rightProduct), fit: number(summary.fit), simplicity: number(summary.simplicity), words: number(summary.words) } }
  } catch {
    throw new RoutineUsageError(`--compare: ${path} is not a report written by this command.`)
  }
}

const main = async (): Promise<number> => {
  let args, env, snapshot, labels: LabelSet | null, previous
  try {
    args = parseRoutineArgs(process.argv.slice(2))
    const priced = resolveRoutineModels(args.models)
    // A hint run asks the writer alone; the judges are not used, so their models need no price.
    if (args.set === 'hints') requirePricedModel('write-routine', priced['write-routine'])
    else {
      requirePricedModel('write-routine', priced['write-routine'])
      requirePricedModel('judge-grounding', priced['judge-grounding'])
      for (const { model } of resolveRoutineJudges(args.judges)) requirePricedModel('judge-routine', model)
    }
    env = await loadEnv()
    snapshot = await loadSnapshot(args.snapshot)
    labels = args.labels === undefined ? null : await loadLabelSet(args.labels)
    previous = args.compare === undefined ? undefined : readPrevious(args.compare)
  } catch (error) {
    if (error instanceof RoutineUsageError || error instanceof MissingApiKeyError || error instanceof SnapshotError || error instanceof LabelSetError) {
      console.error(error.message)
      return 2
    }
    throw error
  }
  if (labels !== null && labels.snapshotSha256 !== snapshot.sha256) {
    console.log(`Note: label set ${labels.version} was made on another snapshot (${labels.snapshotSha256.slice(0, 12)}, this one is ${snapshot.sha256.slice(0, 12)}); a case whose candidates changed is listed as needing a re-label.`)
  }

  const models = resolveRoutineModels(args.models)
  const judges = resolveRoutineJudges(args.judges)
  const ledger = new MemoryAiSpendLedger({ capMicros: Math.round(args.maxUsd * 1_000_000) })
  const client = new AnthropicClient({ apiKey: env.apiKey, models, ledger })
  console.log(`Models: write-routine ${models['write-routine']}${args.set === 'hints' ? '' : `, judges ${judges.map((j) => `${j.name} ${j.model}`).join(' and ')}, judge-grounding ${models['judge-grounding']}`}, snapshot ${snapshot.sha256.slice(0, 12)}, prompt ${routineWriterWriteRoutinePrompt.hash.slice(0, 12)}`)
  const io = {
    log: (line: string) => console.log(line),
    mkdir: async (dir: string) => void mkdirSync(dir, { recursive: true }),
    writeFile: async (path: string, text: string) => writeFileSync(path, text),
  }
  const writer = new AnthropicRoutineWriter(client)
  if (args.set === 'hints') {
    // parseRoutineArgs refuses --set hints without --labels, so there is a label set here.
    const { exitCode } = await runHintEval({ cases: ROUTINE_HOLDOUT, limit: args.limit, outDir: args.outDir, startedAt: new Date(), model: models['write-routine'], promptHash: routineWriterWriteRoutinePrompt.hash, snapshot, labels: labels!, deps: { writer, ledger }, io })
    return exitCode
  }
  const { exitCode } = await runRoutineEval({
    cases: args.set === 'dev' ? ROUTINE_DEV : ROUTINE_HOLDOUT,
    set: args.set,
    limit: args.limit,
    outDir: args.outDir,
    startedAt: new Date(),
    model: models['write-routine'],
    judges,
    maxGrounding: args.maxGrounding,
    promptHash: routineWriterWriteRoutinePrompt.hash,
    snapshot,
    labels,
    ...(previous === undefined ? {} : { previous }),
    // One client for each judge, because a client holds one model per job; they all spend on the one ledger, so the cap covers the writer and every judge.
    deps: {
      writer,
      judges: judges.map((j) => ({ ...j, judge: new AnthropicRoutineJudge(new AnthropicClient({ apiKey: env.apiKey, models: { ...models, 'judge-routine': j.model }, ledger })) })),
      grounding: new AnthropicGroundingJudge(client),
      ledger,
    },
    io,
  })
  return exitCode
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`The eval stopped on an unexpected ${error instanceof Error ? error.constructor.name : 'error'}.`)
    process.exitCode = 2
  },
)
