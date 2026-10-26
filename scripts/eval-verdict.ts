// Measures the shelf verdict against synthetic shelves: `npm run eval:verdict`. The rules floor is deterministic and must be right for every case; the fit judge
// (`AnthropicVerdictFitter`, one Sonnet call for each case with a product the floor left open or a clash) is scored against labels. Needs ANTHROPIC_API_KEY (environment,
// else .dev.vars) and makes real, billed calls, except with --floor-only. It is never part of `npm test`, and it never prints the key, a prompt, a product, a reason, a
// label's words or an error message: only case ids, states, counts, scores and costs, and for the holdout no id at all. The answers go to report.json.
//   --set main|holdout   the cases to run (default main, which you tune on; holdout is the bar and is printed as aggregates only)    --limit N   run the first N cases
//   --labels VERSION   the labels in <root>/labels/ that score the fit    --snapshot PATH   the catalog snapshot (default eval-data/verdict/catalog-snapshot.xlsx)
//   --root DIR   where the cases and labels are (default eval-data/verdict)    --max-usd N   stop spending at N dollars (default 3)
//   --model fit-verdict=MODEL   run the fit judge on another model    --out-dir DIR   where the run's directory goes (default .eval)
//   --floor-only   run the rules floor alone: no key is read, no call is made, nothing is spent, and the fit is not scored
// The last line is `Bar: PASS`, `Bar: FAIL (<rules>)` or `Bar: not evaluated (<reasons>)` (see "Verdict eval" in docs/architecture.md).
// Exit: 0 the bar passes or the run was a trial (the bar was not evaluated), 1 the bar fails, 2 the run could not start (arguments, key, cases, snapshot, labels) or Claude rejected the key.
import { mkdirSync, writeFileSync } from 'node:fs'
import { AnthropicClient } from '../src/providers/anthropic/anthropic.client'
import { MemoryAiSpendLedger } from '../src/providers/anthropic/memory.ai-spend-ledger'
import { AnthropicVerdictFitter } from '../src/providers/verdict-fitting/anthropic.verdict-fitter'
import { loadEnv, MissingApiKeyError } from './eval/score'
import { parseVerdictArgs, resolveVerdictModels, VerdictUsageError } from './eval/verdict-args'
import { loadVerdictCases, VerdictCaseError } from './eval/verdict-cases'
import { type LabelSet, loadVerdictLabels, VerdictLabelError } from './eval/verdict-labels'
import { loadVerdictReference, VerdictReferenceError } from './eval/verdict-reference'
import { runVerdictEval } from './eval/verdict-run'

const main = async (): Promise<number> => {
  let args, apiKey: string | undefined, cases, loaded, labels: LabelSet | null
  try {
    args = parseVerdictArgs(process.argv.slice(2))
    // A floor-only run calls nothing, so it needs no key and does not look for one.
    apiKey = args.floorOnly ? undefined : (await loadEnv()).apiKey
    cases = (await loadVerdictCases(args.root))[args.set]
    loaded = await loadVerdictReference(args.snapshot)
    labels = args.labels === undefined ? null : await loadVerdictLabels(args.root, args.labels)
  } catch (error) {
    if (error instanceof VerdictUsageError || error instanceof MissingApiKeyError || error instanceof VerdictCaseError || error instanceof VerdictReferenceError || error instanceof VerdictLabelError) {
      console.error(error.message)
      return 2
    }
    throw error
  }

  const models = resolveVerdictModels(args.models)
  const ledger = new MemoryAiSpendLedger({ capMicros: Math.round(args.maxUsd * 1_000_000) })
  const fitter = apiKey === undefined ? null : new AnthropicVerdictFitter(new AnthropicClient({ apiKey, models, ledger }))
  console.log(fitter === null ? `Floor only: no model is called, snapshot ${loaded.sha256.slice(0, 12)}` : `Models: fit-verdict ${fitter.identity.model}, snapshot ${loaded.sha256.slice(0, 12)}, prompt ${fitter.identity.promptHash.slice(0, 12)}`)
  const { exitCode } = await runVerdictEval({
    cases,
    set: args.set,
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    outDir: args.outDir,
    startedAt: new Date(),
    floorOnly: args.floorOnly,
    reference: loaded.reference,
    snapshotSha256: loaded.sha256,
    labels,
    deps: { fitter, ledger },
    io: {
      log: (line: string) => console.log(line),
      mkdir: async (dir: string) => void mkdirSync(dir, { recursive: true }),
      writeFile: async (path: string, text: string) => writeFileSync(path, text),
    },
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
