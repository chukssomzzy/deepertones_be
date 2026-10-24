// Writes the sheet a person fills in to label the routine eval's candidates: `npm run eval:routine:sheet`. One row per case x gap x candidate with an empty
// `label` column (best, acceptable or not; blank is not). No AI call, no model output in the sheet. The rows come from the real candidate rules over the local
// catalog snapshot, so the sheet is local too: it names catalog products and stays in eval-data/ (gitignored).
//   --set dev|holdout|all (default all)    --snapshot PATH    --out PATH (default eval-data/routine/label-sheet-<set>.xlsx)
// A sheet that exists is never overwritten (pick another --out).
// Then `npm run eval:routine:labels -- --sheet <the filled sheet> --version v1` makes the label set. Exit 0 written, 2 could not (arguments or snapshot).
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseSheetArgs, RoutineUsageError } from './eval/routine-args'
import { ROUTINE_DEV, ROUTINE_HOLDOUT } from './eval/routine-cases'
import { LabelSheetError, type SheetEntry, writeLabelSheet } from './eval/routine-labels'
import { buildSkeleton } from './eval/routine-skeleton'
import { loadSnapshot, SnapshotError } from './eval/routine-snapshot'

const main = async (): Promise<number> => {
  let args, snapshot
  try {
    args = parseSheetArgs(process.argv.slice(2))
    snapshot = await loadSnapshot(args.snapshot)
  } catch (error) {
    if (error instanceof RoutineUsageError || error instanceof SnapshotError) {
      console.error(error.message)
      return 2
    }
    throw error
  }
  const cases = args.set === 'dev' ? ROUTINE_DEV : args.set === 'holdout' ? ROUTINE_HOLDOUT : [...ROUTINE_DEV, ...ROUTINE_HOLDOUT]
  const entries: SheetEntry[] = []
  for (const c of cases) entries.push({ id: c.id, country: c.country, skeleton: (await buildSkeleton(c, snapshot, { hintsShown: false })).skeleton })
  mkdirSync(dirname(args.out), { recursive: true })
  try {
    await writeLabelSheet(args.out, entries, snapshot.sha256, snapshot.countries)
  } catch (error) {
    if (!(error instanceof LabelSheetError)) throw error
    console.error(error.message)
    return 2
  }
  const rows = entries.reduce((total, { skeleton }) => total + skeleton.gaps.reduce((n, gap) => n + gap.candidates.length, 0), 0)
  console.log(`Label sheet: ${args.out} (${cases.length} cases, ${rows} rows, snapshot ${snapshot.sha256.slice(0, 12)})`)
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`The sheet stopped on an unexpected ${error instanceof Error ? error.constructor.name : 'error'}.`)
    process.exitCode = 2
  },
)
