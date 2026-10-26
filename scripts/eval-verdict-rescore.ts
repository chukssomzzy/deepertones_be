// Scores the answers saved in an earlier `eval:verdict` report against another version of the labels: `npm run eval:verdict:rescore`. It makes no call, spends nothing
// and has no use for a key; the floor part of the score is the saved run's, and a case whose saved request is not the one its labels were made for is listed for
// re-labelling and left out of the fit. It never prints a product, a reason, a label's words or an error message: only case ids, states, counts and scores, and for the
// holdout no id at all. A new report.json is written and an existing one never is.
//   --report PATH/report.json   the report to score again    --labels VERSION   the labels in <root>/labels/ to score it against
//   --root DIR   where the labels are (default eval-data/verdict)    --out-dir DIR   where the rescore's directory goes (default .eval)
// Exit: as eval:verdict: 0 the bar passes or the report was a trial, 1 the bar fails, 2 the rescore could not start (arguments, report, labels).
import { mkdirSync, writeFileSync } from 'node:fs'
import { parseVerdictRescoreArgs, VerdictUsageError } from './eval/verdict-args'
import { loadVerdictLabels, VerdictLabelError } from './eval/verdict-labels'
import { readVerdictReport, runVerdictRescore, VerdictReportError } from './eval/verdict-rescore'

const main = async (): Promise<number> => {
  let args, report, labels
  try {
    args = parseVerdictRescoreArgs(process.argv.slice(2))
    report = await readVerdictReport(args.report)
    labels = await loadVerdictLabels(args.root, args.labels)
  } catch (error) {
    if (error instanceof VerdictUsageError || error instanceof VerdictReportError || error instanceof VerdictLabelError) {
      console.error(error.message)
      return 2
    }
    throw error
  }
  console.log(`Rescoring the saved answers of a ${report.floorOnly ? 'floor-only' : report.model ?? 'unnamed'} run`)
  const { exitCode } = await runVerdictRescore({
    report,
    reportPath: args.report,
    labels,
    startedAt: new Date(),
    outDir: args.outDir,
    io: {
      log: (line: string) => console.log(line),
      mkdir: async (dir: string) => void mkdirSync(dir, { recursive: true }),
      // 'wx': a report that appeared since the run began is never overwritten.
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
    console.error(`The rescore stopped on an unexpected ${error instanceof Error ? error.constructor.name : 'error'}.`)
    process.exitCode = 2
  },
)
