// Turns a filled label sheet into a label set: `npm run eval:routine:labels -- --sheet <xlsx> --version v1 [--status provisional|clinical|outcome]`.
// Writes eval-data/routine/labels/<version>.json (gitignored: it names catalog products) and never overwrites a version. Every gap needs exactly one `best`
// (a gap with one candidate has it automatically); a sheet with a gap that has two or none, or a label that is not best, acceptable or blank, is refused with every
// problem listed by case and step. Exit 0 written, 2 refused or could not run.
import { LABELS_USAGE, parseLabelsArgs, RoutineUsageError } from './eval/routine-args'
import { LabelSetError, LabelSheetError, readLabelSheet, saveLabelSet } from './eval/routine-labels'

const main = async (): Promise<number> => {
  try {
    const args = parseLabelsArgs(process.argv.slice(2))
    const labels = await readLabelSheet(args.sheet, { version: args.version, status: args.status })
    const path = await saveLabelSet(labels)
    const gaps = Object.values(labels.cases).reduce((total, gapLabels) => total + Object.keys(gapLabels).length, 0)
    console.log(`Label set: ${path} (${Object.keys(labels.cases).length} cases, ${gaps} gaps, status ${labels.status}, snapshot ${labels.snapshotSha256.slice(0, 12)})`)
    return 0
  } catch (error) {
    if (error instanceof RoutineUsageError || error instanceof LabelSheetError || error instanceof LabelSetError) {
      console.error(error.message)
      return 2
    }
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
      console.error(`No sheet at that path. ${LABELS_USAGE}`)
      return 2
    }
    throw error
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`The label reader stopped on an unexpected ${error instanceof Error ? error.constructor.name : 'error'}.`)
    process.exitCode = 2
  },
)
