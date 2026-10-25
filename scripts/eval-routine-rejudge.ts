// Judges the routines saved in an earlier `eval:routine` report again, or scores its saved judgements against another label set: `npm run eval:routine:rejudge`.
// The writer is never called, the gates are not run again and no page is fetched; the saved failures and page-support results are carried over. A re-judge makes
// real, billed Haiku (or Opus) calls, one per judge per routine, capped by --max-usd; --rescore makes none, needs no key, and costs nothing. It never prints a key, a
// prompt, a routine's words or a judge's words: only case ids, gate codes, counts, scores and costs. A new report.json is written and an existing one never is.
//   --report PATH/report.json   the report to re-judge (not a hint run)    --labels VERSION   the label set in eval-data/routine/labels/ that scores the picks
//   --judges haiku|opus|haiku,opus   the rubric judges (default haiku; never the model that wrote the routines)    --rescore   no calls: score the saved judgements
//   --max-usd N   stop spending at N dollars (default 1)    --out-dir DIR   where report.json goes (default .eval/routine-rejudge-<timestamp>)
// Exit: as eval:routine: 0 the bar passes or the run was a trial, 1 the bar fails, 2 the run could not start (arguments, report, labels, key, an existing report.json in --out-dir) or Claude rejected the key.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnthropicClient } from '../src/providers/anthropic/anthropic.client'
import { MemoryAiSpendLedger } from '../src/providers/anthropic/memory.ai-spend-ledger'
import { parseRejudgeArgs, refuseSelfJudging, requirePricedModel, REJUDGE_USAGE, resolveRoutineJudges, resolveRoutineModels, RoutineUsageError } from './eval/routine-args'
import { AnthropicRoutineJudge } from './eval/routine-judge'
import { type LabelSet, LabelSetError, loadLabelSet } from './eval/routine-labels'
import { readRejudgeReport, RejudgeReportError, runRejudge, type SourceReport } from './eval/routine-rejudge'
import { loadEnv, MissingApiKeyError } from './eval/score'

const main = async (): Promise<number> => {
  let args, report: SourceReport, labels: LabelSet, apiKey: string | undefined
  const models = resolveRoutineModels({})
  try {
    args = parseRejudgeArgs(process.argv.slice(2))
    report = await readRejudgeReport(args.report)
    if (!args.rescore) {
      refuseSelfJudging(resolveRoutineJudges(args.judges), report.model)
      for (const { model } of resolveRoutineJudges(args.judges)) requirePricedModel('judge-routine', model, REJUDGE_USAGE)
    }
    // A rescore calls nothing, so it needs no key.
    apiKey = args.rescore ? undefined : (await loadEnv()).apiKey
    labels = await loadLabelSet(args.labels)
    // A report is never overwritten: a directory that already holds one is refused before anything is spent.
    if (args.outDir !== undefined && existsSync(join(args.outDir, 'report.json'))) throw new RoutineUsageError(`${join(args.outDir, 'report.json')} already exists; a report is never overwritten. ${REJUDGE_USAGE}`)
  } catch (error) {
    if (error instanceof RoutineUsageError || error instanceof RejudgeReportError || error instanceof MissingApiKeyError || error instanceof LabelSetError) {
      console.error(error.message)
      return 2
    }
    throw error
  }

  const judges = args.rescore ? [] : resolveRoutineJudges(args.judges)
  const ledger = new MemoryAiSpendLedger({ capMicros: Math.round(args.maxUsd * 1_000_000) })
  console.log(args.rescore ? `Rescoring the saved judgements of ${report.judges.map((j) => `${j.name} ${j.model}`).join(' and ') || 'no judge'}` : `Models: judges ${judges.map((j) => `${j.name} ${j.model}`).join(' and ')}`)
  const { exitCode } = await runRejudge({
    report,
    reportPath: args.report,
    labels,
    mode: args.rescore ? 'rescore' : 'rejudge',
    judges,
    // One client for each judge, because a client holds one model per job; they all spend on the one ledger, so the cap covers every judge.
    deps: { judges: judges.map((j) => ({ ...j, judge: new AnthropicRoutineJudge(new AnthropicClient({ apiKey: apiKey!, models: { ...models, 'judge-routine': j.model }, ledger })) })), ledger },
    startedAt: new Date(),
    ...(args.outDir === undefined ? {} : { outDir: args.outDir }),
    io: {
      log: (line: string) => console.log(line),
      mkdir: async (dir: string) => void mkdirSync(dir, { recursive: true }),
      // 'wx': a report.json that appeared since the check above is still never overwritten.
      writeFile: async (path: string, text: string) => writeFileSync(path, text, { flag: 'wx' }),
    },
  })
  return exitCode
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    // RoutineUsageError from the core (a judge that wrote the routines) is a usage error too.
    if (error instanceof RoutineUsageError) {
      console.error(error.message)
      process.exitCode = 2
      return
    }
    console.error(`The re-judge stopped on an unexpected ${error instanceof Error ? error.constructor.name : 'error'}.`)
    process.exitCode = 2
  },
)
