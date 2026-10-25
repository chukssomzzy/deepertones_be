/*
 * The orchestration of `npm run eval:routine`, without the network, the clock or the disk (the script injects them): each case's skeleton is built by the
 * real buildSkeleton, the writer writes a routine, the real checkRoutine checks it, then the scores, the bar, the console lines and report.json. What the
 * console prints is only ids, gate codes, counts, scores and costs: the routines themselves (reasons, expectation, links) go to the report file only.
 */
import { join } from 'node:path'
import { checkRoutine } from '../../src/modules/routines/routines.gates'
import type { GateFailure, Routine, RoutineSkeleton } from '../../src/modules/routines/routines.types'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import type { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import type { RoutineWriter } from '../../src/providers/routine-writing/routine-writer.provider'
import type { RoutineCase, RoutineSet } from './routine-cases'
import type { LabelSet } from './routine-labels'
import { barExitCode, type CaseScore, compare, formatBarLine, type Measures, type RoutineCaseInput, scoreRoutineCase, scoreRun } from './routine-score'
import { buildSkeleton } from './routine-skeleton'
import type { Snapshot } from './routine-snapshot'

export type RunDeps = {
  writer: RoutineWriter
  /** The ledger the writer's client spends on; the run reads what each case cost from it. */
  ledger: MemoryAiSpendLedger
}

export type RunIo = {
  log: (line: string) => void
  mkdir: (dir: string) => Promise<void>
  writeFile: (path: string, text: string) => Promise<void>
}

export type RunArgs = {
  cases: RoutineCase[]
  set: RoutineSet
  /** Run only the first N cases. */
  limit?: number
  /** Where report.json goes; defaultOutDir(startedAt) when left out. */
  outDir?: string
  startedAt: Date
  /** The model the writer ran on, and the hash of its prompt, for the report. */
  model: string
  promptHash: string
  snapshot: Snapshot
  /** The label set, or null for a run with none. */
  labels: LabelSet | null
  /** An earlier report to compare the scores with. */
  previous?: { summary: Measures } | null
  deps: RunDeps
  io: RunIo
}

/** No colons: actions/upload-artifact refuses them in a file name. */
export const defaultOutDir = (startedAt: Date): string => `.eval/routine-${startedAt.toISOString().replace(/:/g, '-')}`

type Stop = 'cap' | 'config' | null
type CaseState = 'done' | 'writer-error' | 'cut-off'

type Reported = {
  id: string
  state: CaseState
  writerError?: string
  skeleton: RoutineSkeleton
  routine: Routine | null
  failures: GateFailure[]
  costMicros: number
  score: CaseScore
}

/** The name of an error's class, for a report: a code identifier, never the message. `constructor.name`, because an instance's `name` is "Error" unless a subclass sets it. */
const classNameOf = (error: unknown): string => {
  const name = (error as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name
  return typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,59}$/.test(name) ? name : 'Error'
}

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`
const shown = (value: number | null, digits = 1): string => (value === null ? 'n/a' : value.toFixed(digits))

const gatesOf = (state: CaseState, writerError: string | undefined, failures: GateFailure[]): string => {
  if (state === 'cut-off') return 'cut-off'
  if (state === 'writer-error') return `error ${writerError}`
  return failures.length === 0 ? 'ok' : failures.map((f) => (f.step === null ? f.gate : `${f.gate}(${f.step})`)).join(',')
}

export const runRoutineEval = async ({ cases: allCases, set, limit, outDir: given, startedAt, model, promptHash, snapshot, labels, previous, deps, io }: RunArgs): Promise<{ exitCode: number; outDir: string }> => {
  const { writer, ledger } = deps
  const cases = allCases.slice(0, limit)
  const outDir = given ?? defaultOutDir(startedAt)
  // Made before anything is spent, so a directory that cannot be made stops the run while it is still free.
  await io.mkdir(outDir)
  io.log(`Routine eval: set ${set}, ${cases.length} cases, cap ${usd(ledger.capMicros)}, labels ${labels?.version ?? 'none'}`)

  let stopped: Stop = null
  const inputs: RoutineCaseInput[] = []
  const reported: Reported[] = []
  let costMicros = 0
  for (const c of cases) {
    const { skeleton, gapCodes } = await buildSkeleton(c, snapshot, { hintsShown: false })
    const caseLabels = labels?.cases[c.id] ?? null
    const base = { id: c.id, gapCodes, labels: caseLabels, judge: null }
    let state: CaseState = 'done'
    let routine: Routine | null = null
    let writerError: string | undefined
    let failures: GateFailure[] = []
    const spentBefore = ledger.spentMicros()

    if (stopped !== null) state = 'cut-off'
    else {
      try {
        routine = await writer.write(skeleton)
        failures = checkRoutine(skeleton, routine)
      } catch (error) {
        if (error instanceof AiBudgetExceededError) [state, stopped] = ['cut-off', 'cap']
        else if (error instanceof AnthropicConfigError) [state, stopped] = ['cut-off', 'config']
        else [state, writerError] = ['writer-error', classNameOf(error)]
      }
    }
    const cost = ledger.spentMicros() - spentBefore
    costMicros += cost
    const input: RoutineCaseInput = { ...base, routine, writerError: writerError ?? null, failures, costMicros: cost }
    // A case the run never reached is left out of every percentage: it is not a failed routine.
    if (state !== 'cut-off') inputs.push(input)
    const score = scoreRoutineCase(input)
    reported.push({ id: c.id, state, ...(writerError === undefined ? {} : { writerError }), skeleton, routine, failures, costMicros: cost, score })
    const picks = state === 'cut-off' ? '' : `  ${score.picks}`
    io.log(`${c.id}  ${gatesOf(state, writerError, failures)}${picks}  ${usd(cost)}`)
  }

  // A run of the first N cases (--limit) is a trial, as one stopped at the cap is: it can fail the bar but never pass it.
  const partial = stopped !== null || cases.length < allCases.length
  const summary = { ...scoreRun(inputs, { set, partial }), costMicros }
  const report = { startedAt: startedAt.toISOString(), set, snapshotSha256: snapshot.sha256, labelVersion: labels?.version ?? null, labelSnapshotSha256: labels?.snapshotSha256 ?? null, model, promptHash, capMicros: ledger.capMicros, partial, cases: reported, summary }
  const reportPath = join(outDir, 'report.json')
  await io.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  if (stopped === 'cap') io.log('Stopped at the spend cap: the cases after this point were not run.')
  if (stopped === 'config') io.log('Stopped: Claude refused our key, billing or permissions. Fix the setup (ANTHROPIC_API_KEY and the account) and run again.')
  io.log(`Gates passed: ${shown(summary.gatesPassed)}%, forbidden wording: ${summary.forbiddenWording}`)
  io.log(`Right product: ${shown(summary.rightProduct)}%, exactly best: ${shown(summary.exactlyBest)}%`)
  io.log(`Judge agreement: ${shown(summary.judgeAgreement)}%, fit ${shown(summary.fit)}, simplicity ${shown(summary.simplicity)}, words ${shown(summary.words)} (n/a: not judged)`)
  if (summary.needsRelabel.length > 0) io.log(`Needs re-label (candidates changed since the labels were made): ${summary.needsRelabel.join(', ')}`)
  io.log(`Spent ${usd(costMicros)} of the ${usd(ledger.capMicros)} cap.`)
  io.log(`Report: ${reportPath}`)
  if (previous) {
    const { verdict, decidedBy } = compare(previous.summary, summary)
    io.log(`Compared with the previous report: ${verdict}${decidedBy === null ? '' : `, decided by ${decidedBy}`}`)
  }
  if (summary.bar.status === 'not-evaluated') io.log('This run is a trial: it cannot pass or fail the bar.')
  io.log(formatBarLine(summary.bar))
  return { exitCode: stopped === 'config' ? 2 : barExitCode(summary.bar), outDir }
}
