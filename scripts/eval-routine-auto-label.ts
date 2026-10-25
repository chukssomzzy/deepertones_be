// Labels the routine eval's cases with a model acting as a dermatologist experienced with skin of colour: `npm run eval:routine:auto-label -- --version v1`.
// Needs ANTHROPIC_API_KEY (environment, else .dev.vars) and makes real, billed calls (one Opus call per case). It never prints the key, a prompt, an error message or
// anything the model chose: only case ids, gap counts and costs.
//   --version VERSION   the label set to write (eval-data/routine/labels/VERSION.json, status provisional, `labelledBy` the model; never overwritten)
//   --set all|dev|holdout   the cases to label (default all)    --limit N   label the first N cases    --snapshot PATH   the catalog snapshot
//   --model label-routine=MODEL   the labelling model (default claude-opus-5-5)    --max-usd N   stop spending at N dollars (default 10)
// Also writes a filled copy of the label sheet, eval-data/routine/label-sheet-<version>-<model>.xlsx, to spot-check or correct and read back with
// `npm run eval:routine:labels`. A judge on the labeller's own model does not count toward choosing the judge (see "Routine eval" in docs/architecture.md).
// Exit: 0 saved, 1 a case failed or the spend cap stopped the run (nothing is saved), 2 could not start or Claude rejected the key.
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { AnthropicClient } from '../src/providers/anthropic/anthropic.client'
import { MemoryAiSpendLedger } from '../src/providers/anthropic/memory.ai-spend-ledger'
import { DEFAULT_MODELS } from './eval/models'
import { AUTO_LABEL_USAGE, parseAutoLabelArgs, requirePricedModel, RoutineUsageError } from './eval/routine-args'
import { ROUTINE_DEV, ROUTINE_HOLDOUT } from './eval/routine-cases'
import { AnthropicRoutineLabeller, runAutoLabel } from './eval/routine-labeller'
import { saveLabelSet, writeLabelSheet } from './eval/routine-labels'
import { loadSnapshot, SnapshotError } from './eval/routine-snapshot'
import { loadEnv, MissingApiKeyError } from './eval/score'

const main = async (): Promise<number> => {
  let args, env, snapshot
  try {
    args = parseAutoLabelArgs(process.argv.slice(2))
    requirePricedModel('label-routine', args.model, AUTO_LABEL_USAGE)
    env = await loadEnv()
    snapshot = await loadSnapshot(args.snapshot)
  } catch (error) {
    if (error instanceof RoutineUsageError || error instanceof MissingApiKeyError || error instanceof SnapshotError) {
      console.error(error.message)
      return 2
    }
    throw error
  }
  const ledger = new MemoryAiSpendLedger({ capMicros: Math.round(args.maxUsd * 1_000_000) })
  const client = new AnthropicClient({ apiKey: env.apiKey, models: { ...DEFAULT_MODELS, 'label-routine': args.model }, ledger })
  console.log(`Model: label-routine ${args.model}, snapshot ${snapshot.sha256.slice(0, 12)}`)
  const { exitCode } = await runAutoLabel({
    version: args.version,
    cases: args.set === 'dev' ? ROUTINE_DEV : args.set === 'holdout' ? ROUTINE_HOLDOUT : [...ROUTINE_DEV, ...ROUTINE_HOLDOUT],
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    model: args.model,
    snapshot,
    deps: { labeller: new AnthropicRoutineLabeller(client), ledger },
    io: {
      log: (line) => console.log(line),
      exists: async (path) => existsSync(path),
      saveLabelSet,
      writeSheet: async (path, entries, sha, countries, filled) => {
        mkdirSync(dirname(path), { recursive: true })
        await writeLabelSheet(path, entries, sha, countries, filled)
      },
    },
  })
  return exitCode
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`The auto-labeller stopped on an unexpected ${error instanceof Error ? error.constructor.name : 'error'}.`)
    process.exitCode = 2
  },
)
