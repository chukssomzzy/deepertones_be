/*
 * The orchestration of `npm run eval:routine`, without the network, the clock or the disk (the script injects them): each case's skeleton is built by the
 * real buildSkeleton, the writer writes a routine, the real checkRoutine checks it, the rubric judge judges it once, and the page-support judge checks each of
 * its grounding links (up to --max-grounding for the run); then the scores, the bar, the console lines and report.json. What the console prints is only ids,
 * gate codes, counts, scores and costs: the routines themselves (reasons, expectation, links) and everything the judges said go to the report file only.
 */
import { join } from 'node:path'
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import { checkRoutine } from '../../src/modules/routines/routines.gates'
import type { GateFailure, Routine, RoutineSkeleton } from '../../src/modules/routines/routines.types'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import type { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import type { RoutineWriter } from '../../src/providers/routine-writing/routine-writer.provider'
import type { RoutineCase, RoutineSet } from './routine-cases'
import { type GroundingJudge, type GroundingVerdict, unverifiableGrounding } from './routine-grounding-judge'
import { judgeResultOf, type RoutineJudge, type RoutineJudgement } from './routine-judge'
import type { LabelSet } from './routine-labels'
import { barExitCode, type CaseScore, compare, formatBarLine, type JudgeComparison, judgeComparisonOf, type JudgeResult, JUDGE_AGREEMENT_MIN, type Measures, type RoutineCaseInput, scoreRoutineCase, scoreRun, selectJudge } from './routine-score'
import { buildSkeleton } from './routine-skeleton'
import type { Snapshot } from './routine-snapshot'

export type RunDeps = {
  writer: RoutineWriter
  /** The rubric judges, in the order they judge each routine. Each has its own model, and all spend on the same ledger. */
  judges: { name: string; model: string; judge: RoutineJudge }[]
  grounding: GroundingJudge
  /** The ledger the clients of the writer and the judges spend on; the run reads what each case cost from it. */
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
  /** The rubric judges that were asked, in order. The models differ from the writer's: parseRoutineArgs refuses a judge that is the writer. */
  judges: { name: string; model: string }[]
  /** The most page-support checks (calls to the grounding judge) for the whole run. */
  maxGrounding: number
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
  /** What each rubric judge said, whole (its problem codes are here and nowhere else), or null where it judged nothing. Every judge of the run has a key. */
  judgements: Record<string, RoutineJudgement | null>
  /** The class name of the error of each judge that had one. */
  judgeErrors: Record<string, string>
  /** What each judge's calls cost on this case, a failed call included. */
  judgeCostMicros: Record<string, number>
  /** The links that were checked, with the verdict on each. */
  grounding: { step: RoutineStep; sourceUrl: string; verdict: GroundingVerdict }[]
}

/** The name of an error's class, for a report: a code identifier, never the message. `constructor.name`, because an instance's `name` is "Error" unless a subclass sets it. */
export const classNameOf = (error: unknown): string => {
  const name = (error as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name
  return typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,59}$/.test(name) ? name : 'Error'
}

export const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`
const shown = (value: number | null, digits = 1): string => (value === null ? 'n/a' : value.toFixed(digits))

const gatesOf = (state: CaseState, writerError: string | undefined, failures: GateFailure[]): string => {
  if (state === 'cut-off') return 'cut-off'
  if (state === 'writer-error') return `error ${writerError}`
  return failures.length === 0 ? 'ok' : failures.map((f) => (f.step === null ? f.gate : `${f.gate}(${f.step})`)).join(',')
}

const judgeLine = (row: JudgeComparison): string =>
  `Judge ${row.name} (${row.model}): agreement ${row.agreement === null ? 'n/a' : `${row.agreement.toFixed(1)}%`}, fit ${shown(row.fit)}, simplicity ${shown(row.simplicity)}, words ${shown(row.words)}, cost ${usd(row.costMicros)}, ${shown(row.agreementPerDollar)} agreement per dollar${row.selfAgreement ? ' (self-agreement: made the labels)' : ''}`

type GroundingTally = { checked: number; supported: number; unverifiable: number; skipped: number; skippedGate: number }

export const runRoutineEval = async ({ cases: allCases, set, limit, outDir: given, startedAt, model, judges, maxGrounding, promptHash, snapshot, labels, previous, deps, io }: RunArgs): Promise<{ exitCode: number; outDir: string }> => {
  const { writer, judges: judgeDeps, grounding, ledger } = deps
  const cases = allCases.slice(0, limit)
  const outDir = given ?? defaultOutDir(startedAt)
  // Made before anything is spent, so a directory that cannot be made stops the run while it is still free.
  await io.mkdir(outDir)
  io.log(`Routine eval: set ${set}, ${cases.length} cases, cap ${usd(ledger.capMicros)}, labels ${labels?.version ?? 'none'}`)

  // Who made the labels: a model id, 'human' (a sheet, or a legacy set), or null with none.
  const labelledBy = labels === null ? null : (labels.labelledBy ?? 'human')
  let stopped: Stop = null
  const inputs: RoutineCaseInput[] = []
  // Each judge's result on each case in `inputs` (null where it judged nothing), in the same order, so the selected judge's can be set on the inputs once it is known.
  const judgeResults: Record<string, (JudgeResult | null)[]> = Object.fromEntries(judges.map((j) => [j.name, []]))
  const judgeTotals: Record<string, number> = Object.fromEntries(judges.map((j) => [j.name, 0]))
  const reported: Reported[] = []
  const tally: GroundingTally = { checked: 0, supported: 0, unverifiable: 0, skipped: 0, skippedGate: 0 }
  let costMicros = 0
  // A cap or a refused key ends the run; any other failure of a call is only that call's.
  const stopFor = (error: unknown): boolean => {
    if (error instanceof AiBudgetExceededError) stopped = 'cap'
    else if (error instanceof AnthropicConfigError) stopped = 'config'
    return stopped !== null
  }
  for (const c of cases) {
    const { skeleton, gapCodes } = await buildSkeleton(c, snapshot, { hintsShown: false })
    const caseLabels = labels?.cases[c.id] ?? null
    let state: CaseState = 'done'
    let routine: Routine | null = null
    let writerError: string | undefined
    const judgements: Record<string, RoutineJudgement | null> = Object.fromEntries(judges.map((j) => [j.name, null]))
    const judgeErrors: Record<string, string> = {}
    const judgeCostMicros: Record<string, number> = Object.fromEntries(judges.map((j) => [j.name, 0]))
    const checked: Reported['grounding'] = []
    let failures: GateFailure[] = []
    const spentBefore = ledger.spentMicros()

    if (stopped !== null) state = 'cut-off'
    else {
      try {
        routine = await writer.write(skeleton)
        failures = checkRoutine(skeleton, routine)
      } catch (error) {
        if (stopFor(error)) state = 'cut-off'
        else [state, writerError] = ['writer-error', classNameOf(error)]
      }
    }

    // Every written routine is judged by every judge, whether or not it passed the gates: they are different checks. Each judge is given the skeleton and the routine and nothing else.
    if (routine !== null) {
      for (const { name, judge } of judgeDeps) {
        if (stopped !== null) break
        const before = ledger.spentMicros()
        try {
          judgements[name] = await judge.judge({ skeleton, routine })
        } catch (error) {
          // Set before the stop check, so a case the cap or a rejected key left unjudged says why.
          judgeErrors[name] = classNameOf(error)
          stopFor(error)
        }
        judgeCostMicros[name] = ledger.spentMicros() - before
        judgeTotals[name] = judgeTotals[name]! + judgeCostMicros[name]!
      }
      // A routine that failed the grounding gate cites links that are not the product's own, so a fetch of them would be spent on nothing.
      const badLinks = failures.some((failure) => failure.gate === 'grounding')
      for (const entry of routine.steps) {
        for (const sourceUrl of entry.grounding) {
          if (stopped !== null) break
          if (badLinks) {
            tally.skippedGate++
            continue
          }
          if (tally.checked >= maxGrounding) {
            tally.skipped++
            continue
          }
          let verdict: GroundingVerdict
          try {
            verdict = await grounding.judge({ step: entry.step, reason: entry.reason, sourceUrl })
          } catch (error) {
            if (stopFor(error)) break
            verdict = unverifiableGrounding('api-error')
          }
          tally.checked++
          if (verdict.fetched && verdict.supports === 'yes') tally.supported++
          if (!verdict.fetched) tally.unverifiable++
          checked.push({ step: entry.step, sourceUrl, verdict })
        }
      }
    }

    const cost = ledger.spentMicros() - spentBefore
    costMicros += cost
    const input: RoutineCaseInput = { id: c.id, gapCodes, labels: caseLabels, judge: null, routine, writerError: writerError ?? null, failures, costMicros: cost }
    // A case the run never reached is left out of every percentage: it is not a failed routine.
    if (state !== 'cut-off') {
      inputs.push(input)
      for (const { name } of judges) {
        const judgement = judgements[name]
        judgeResults[name]!.push(!judgement || routine === null ? null : judgeResultOf(judgement, { routine, gapCodes, labels: caseLabels }))
      }
    }
    const score = scoreRoutineCase(input)
    reported.push({
      id: c.id,
      state,
      ...(writerError === undefined ? {} : { writerError }),
      skeleton,
      routine,
      failures,
      costMicros: cost,
      score,
      judgements,
      judgeErrors,
      judgeCostMicros,
      grounding: checked,
    })
    const picks = state === 'cut-off' ? '' : `  ${score.picks}`
    io.log(`${c.id}  ${gatesOf(state, writerError, failures)}${picks}  ${usd(cost)}`)
  }

  // A run of the first N cases (--limit) is a trial, as one stopped at the cap is: it can fail the bar but never pass it.
  const partial = stopped !== null || cases.length < allCases.length
  // The judges are compared on the same routines, and the cheapest one the labels trust (else the one that agrees most) is the one whose numbers feed the bar.
  const judgeComparison = judges.map((j) => judgeComparisonOf(j, judgeResults[j.name]!, judgeTotals[j.name]!, labelledBy ?? undefined))
  const selected = selectJudge(judgeComparison)
  // When every judge made the labels, none may count, and that is why the bar has no judge.
  const judgeSelfLabelled = judgeComparison.length > 0 && judgeComparison.every((row) => row.selfAgreement)
  const scored = inputs.map((input, i) => ({ ...input, judge: selected === null ? null : judgeResults[selected.name]![i]! }))
  // The page-support share is reported beside the words, and is not in the bar. A link that could not be verified counts as not supported.
  const groundingSupport = tally.checked === 0 ? null : (tally.supported * 100) / tally.checked
  const summary = {
    ...scoreRun(scored, { set, partial, judgeSelfLabelled }),
    costMicros,
    judgeComparison,
    selectedJudge: selected?.name ?? null,
    groundingSupport,
    groundingChecked: tally.checked,
    groundingSupported: tally.supported,
    groundingUnverifiable: tally.unverifiable,
    groundingSkipped: tally.skipped,
    groundingSkippedGate: tally.skippedGate,
  }
  const report = { startedAt: startedAt.toISOString(), set, snapshotSha256: snapshot.sha256, labelVersion: labels?.version ?? null, labelSnapshotSha256: labels?.snapshotSha256 ?? null, labelledBy, model, judges: judges.map(({ name, model }) => ({ name, model })), promptHash, capMicros: ledger.capMicros, partial, cases: reported, summary }
  const reportPath = join(outDir, 'report.json')
  await io.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  if (stopped === 'cap') io.log('Stopped at the spend cap: the cases after this point were not run.')
  if (stopped === 'config') io.log('Stopped: Claude refused our key, billing or permissions. Fix the setup (ANTHROPIC_API_KEY and the account) and run again.')
  io.log(`Gates passed: ${shown(summary.gatesPassed)}%, forbidden wording: ${summary.forbiddenWording}`)
  io.log(`Right product: ${shown(summary.rightProduct)}%, exactly best: ${shown(summary.exactlyBest)}%`)
  for (const row of judgeComparison) io.log(judgeLine(row))
  io.log(
    selected === null
      ? `Selected judge: none (${judgeSelfLabelled ? 'every judge made the labels' : 'no judge produced a result'}), so the bar has no judge to take agreement from`
      : `Selected judge: ${selected.name}, ${selected.agreement! >= JUDGE_AGREEMENT_MIN ? `the cheapest with agreement of at least ${JUDGE_AGREEMENT_MIN}%` : `the highest agreement (none reached ${JUDGE_AGREEMENT_MIN}%)`}`,
  )
  io.log(
    tally.checked === 0
      ? `Grounding support: n/a (no link checked), ${tally.skipped} not checked, ${tally.skippedGate} skipped for the grounding gate (not in the bar)`
      : `Grounding support: ${tally.supported} of ${tally.checked} links checked are supported (${shown(groundingSupport)}%), ${tally.unverifiable} could not be verified, ${tally.skipped} not checked, ${tally.skippedGate} skipped for the grounding gate (not in the bar)`,
  )
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
