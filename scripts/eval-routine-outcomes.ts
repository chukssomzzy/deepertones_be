// Updates a label set with real outcomes: `npm run eval:routine:outcomes -- --counts <file.json> --labels v1 --out v2`.
// The counts file holds, per group (goal, skin type, country), each product's counts of users: n, fainter, flared, flaredOrStopped, fainterAndFlaredOrStopped.
// Where a challenger leads the labelled best by labelChange (30 users each, at least 0.1 net fainter, and not noise), it becomes the best and the old best acceptable;
// a case in a caution state is never changed. Writes eval-data/routine/labels/<out>.json (status outcome, never overwriting a version) and <out>.note.md beside it
// (every change, and the products flagged for flares), both gitignored. It prints the counts of changes and never a case, a product code or a number from the file.
// Exit 0 written, 2 refused or could not run.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseOutcomesArgs, RoutineUsageError } from './eval/routine-args'
import { ROUTINE_DEV, ROUTINE_HOLDOUT } from './eval/routine-cases'
import { loadLabelSet, saveLabelSet } from './eval/routine-labels'
import { runOutcomes } from './eval/routine-outcomes'

const main = async (): Promise<number> => {
  let args
  try {
    args = parseOutcomesArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof RoutineUsageError) {
      console.error(error.message)
      return 2
    }
    throw error
  }
  return runOutcomes(args, {
    cases: [...ROUTINE_DEV, ...ROUTINE_HOLDOUT],
    readCounts: async (path) => readFileSync(path, 'utf8'),
    loadLabelSet,
    saveLabelSet,
    writeNote: async (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
    log: (line) => console.log(line),
  })
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`The outcomes update stopped on an unexpected ${error instanceof Error ? error.constructor.name : 'error'}.`)
    process.exitCode = 2
  },
)
