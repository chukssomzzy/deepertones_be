/*
 * The core of `npm run eval:routine:rejudge`: a report written by `eval:routine` already holds the routines the writer wrote, so when only the labels or the judge
 * prompt have changed they are judged again (or, with --rescore, only scored again from the saved judgements) with no writer, no gates and no page fetches. The
 * saved failures and page-support results are carried over as they were. Like routine-run.ts it takes its I/O injected and prints only ids, gate codes, counts,
 * scores and costs, never a routine's words or a judge's.
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { ROUTINE_STEPS, type RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import { RoutineSchema } from '../../src/modules/routines/routines.schema'
import type { RoutineSkeleton } from '../../src/modules/routines/routines.types'
import { routineJudgeJudgeRoutinePrompt } from '../../src/prompts/prompts.generated'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import type { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import { refuseSelfJudging } from './routine-args'
import { judgeResultOf, PICK_CLASSES, type RoutineJudge, type RoutineJudgement } from './routine-judge'
import type { LabelSet } from './routine-labels'
import { classNameOf, finishRun, gatesOf, type GroundingTally, type Reported, type RunIo, type Stop, usd } from './routine-run'
import { type JudgeResult, type RoutineCaseInput, scoreRoutineCase } from './routine-score'

/** A report that cannot be re-judged: missing, unreadable, not written by eval:routine, or a hint run. The CLI turns it into exit 2; the message never quotes the file. */
export class RejudgeReportError extends Error {}

const StepSchema = z.enum(ROUTINE_STEPS)
const JudgementSchema = z.object({
  picks: z.array(z.object({ step: StepSchema, pickClass: z.enum(PICK_CLASSES) })),
  fit: z.number(),
  simplicity: z.number(),
  words: z.number(),
  problems: z.array(z.string()),
})
// Only what the re-judge reads is checked: the skeleton's gaps (for the labels' candidates) and the routine, which RoutineSchema holds to the shape the judge is shown. The rest is passed through.
const SkeletonSchema = z.looseObject({ gaps: z.array(z.looseObject({ step: StepSchema, candidates: z.array(z.looseObject({ code: z.string() })) })) })
const CaseSchema = z.object({
  id: z.string(),
  state: z.enum(['done', 'writer-error', 'cut-off']),
  writerError: z.string().optional(),
  skeleton: SkeletonSchema,
  routine: RoutineSchema.nullable(),
  failures: z.array(z.looseObject({ gate: z.string(), step: StepSchema.nullable() })),
  costMicros: z.number(),
  judgements: z.record(z.string(), JudgementSchema.nullable()),
  judgeErrors: z.record(z.string(), z.string()),
  judgeCostMicros: z.record(z.string(), z.number()),
  grounding: z.array(z.looseObject({ step: StepSchema, sourceUrl: z.string(), verdict: z.looseObject({ fetched: z.boolean(), supports: z.enum(['yes', 'no', 'unclear']) }) })),
})
const ReportSchema = z.object({
  startedAt: z.string(),
  set: z.enum(['dev', 'holdout']),
  partial: z.boolean(),
  model: z.string(),
  promptHash: z.string(),
  snapshotSha256: z.string(),
  judgePromptHash: z.string().optional(),
  judges: z.array(z.object({ name: z.string(), model: z.string() })),
  cases: z.array(CaseSchema),
  summary: z.object({ groundingSkipped: z.number().default(0), groundingSkippedGate: z.number().default(0) }).default({ groundingSkipped: 0, groundingSkippedGate: 0 }),
})

/** A case as the run that made the report saved it (its score is worked out again). */
export type SourceCase = Omit<Reported, 'score'>

export type SourceReport = {
  startedAt: string
  set: 'dev' | 'holdout'
  partial: boolean
  /** The writer's model. */
  model: string
  promptHash: string
  snapshotSha256: string
  /** The hash of the judge prompt the saved judgements came from; null for a report from before it was recorded. */
  judgePromptHash: string | null
  judges: { name: string; model: string }[]
  cases: SourceCase[]
  groundingSkipped: number
  groundingSkippedGate: number
}

export const readRejudgeReport = async (path: string): Promise<SourceReport> => {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new RejudgeReportError(`${path} could not be read as a report: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'there is no such file' : 'it is not JSON'}.`)
  }
  if ((raw as { set?: unknown } | null)?.set === 'hints') throw new RejudgeReportError(`${path} is a hint run (set hints): it holds follow-rates, not routines to judge.`)
  const parsed = ReportSchema.safeParse(raw)
  if (!parsed.success) {
    // The paths of the fields at fault and nothing of their contents.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(report)'))].slice(0, 5).join(', ')
    throw new RejudgeReportError(`${path} is not a report written by eval:routine (fields at fault: ${fields}).`)
  }
  const { summary, judgePromptHash, ...rest } = parsed.data
  // The schemas above hold the fields this command reads; the cast only restores the types of what they let through.
  return { ...rest, judgePromptHash: judgePromptHash ?? null, groundingSkipped: summary.groundingSkipped, groundingSkippedGate: summary.groundingSkippedGate, cases: rest.cases as unknown as SourceCase[] }
}

/** No colons, as eval:routine's: actions/upload-artifact refuses them in a file name. */
export const defaultRejudgeOutDir = (startedAt: Date): string => `.eval/routine-rejudge-${startedAt.toISOString().replace(/:/g, '-')}`

export type RejudgeRunArgs = {
  report: SourceReport
  /** Where the report was read from, for the new report's `source`. */
  reportPath: string
  labels: LabelSet
  mode: 'rejudge' | 'rescore'
  /** The judges to ask (rejudge); empty for a rescore, which scores the saved judgements of the source report's own judges. */
  judges: { name: string; model: string }[]
  /** There is no writer and no page-support judge here: a re-judge has nothing to write and nothing to fetch. */
  deps: { judges: { name: string; model: string; judge: RoutineJudge }[]; ledger: MemoryAiSpendLedger }
  io: RunIo
  startedAt: Date
  outDir?: string
}

/** For each gap, its candidates' codes sorted: what the label set pins, read from the saved skeleton. */
const gapCodesOf = (skeleton: RoutineSkeleton): RoutineCaseInput['gapCodes'] =>
  Object.fromEntries(skeleton.gaps.map((gap) => [gap.step, gap.candidates.map((candidate) => candidate.code).sort()])) as Partial<Record<RoutineStep, string[]>>

export const runRejudge = async ({ report, reportPath, labels, mode, judges, deps, io, startedAt, outDir: given }: RejudgeRunArgs): Promise<{ exitCode: number; outDir: string }> => {
  const { judges: judgeDeps, ledger } = deps
  refuseSelfJudging(judges, report.model)
  const outDir = given ?? defaultRejudgeOutDir(startedAt)
  // Made before anything is spent, so a directory that cannot be made stops the run while it is still free.
  await io.mkdir(outDir)
  const rescore = mode === 'rescore'
  const asked = rescore ? report.judges : judges
  io.log(`Routine ${mode}: set ${report.set}, ${report.cases.length} cases from ${reportPath}, cap ${usd(ledger.capMicros)}, labels ${labels.version}`)

  const labelledBy = labels.labelledBy ?? 'human'
  let stopped: Stop = null
  const inputs: RoutineCaseInput[] = []
  const judgeResults: Record<string, (JudgeResult | null)[]> = Object.fromEntries(asked.map((j) => [j.name, []]))
  const judgeTotals: Record<string, number> = Object.fromEntries(asked.map((j) => [j.name, 0]))
  const reported: Reported[] = []
  const tally: GroundingTally = { checked: 0, supported: 0, unverifiable: 0, skipped: report.groundingSkipped, skippedGate: report.groundingSkippedGate }
  for (const c of report.cases) {
    const gapCodes = gapCodesOf(c.skeleton)
    const caseLabels = labels.cases[c.id] ?? null
    const judgements: Record<string, RoutineJudgement | null> = Object.fromEntries(asked.map((j) => [j.name, rescore ? (c.judgements[j.name] ?? null) : null]))
    const judgeErrors: Record<string, string> = rescore ? { ...c.judgeErrors } : {}
    const judgeCostMicros: Record<string, number> = Object.fromEntries(asked.map((j) => [j.name, rescore ? (c.judgeCostMicros[j.name] ?? 0) : 0]))
    const spentBefore = ledger.spentMicros()

    // A case with no routine (the writer failed, or the run was cut off before it) has nothing to judge. A cap or a rejected key ends the run; any other failure is only that call's.
    if (!rescore && c.routine !== null) {
      for (const { name, judge } of judgeDeps) {
        if (stopped !== null) break
        const before = ledger.spentMicros()
        try {
          judgements[name] = await judge.judge({ skeleton: c.skeleton, routine: c.routine })
        } catch (error) {
          judgeErrors[name] = classNameOf(error)
          if (error instanceof AiBudgetExceededError) stopped = 'cap'
          else if (error instanceof AnthropicConfigError) stopped = 'config'
        }
        judgeCostMicros[name] = ledger.spentMicros() - before
      }
    }
    for (const { name } of asked) judgeTotals[name] = judgeTotals[name]! + judgeCostMicros[name]!
    for (const entry of c.grounding) {
      tally.checked++
      if (entry.verdict.fetched && entry.verdict.supports === 'yes') tally.supported++
      if (!entry.verdict.fetched) tally.unverifiable++
    }

    const input: RoutineCaseInput = { id: c.id, gapCodes, labels: caseLabels, judge: null, routine: c.routine, writerError: c.writerError ?? null, failures: c.failures, costMicros: c.costMicros }
    // A case the source run never reached is left out of every percentage: it is not a failed routine.
    if (c.state !== 'cut-off') {
      inputs.push(input)
      for (const { name } of asked) {
        const judgement = judgements[name]
        judgeResults[name]!.push(!judgement || c.routine === null ? null : judgeResultOf(judgement, { routine: c.routine, gapCodes, labels: caseLabels }))
      }
    }
    const score = scoreRoutineCase(input)
    reported.push({ ...c, score, judgements, judgeErrors, judgeCostMicros })
    io.log(`${c.id}  ${gatesOf(c.state, c.writerError, c.failures)}${c.state === 'cut-off' ? '' : `  ${score.picks}`}  ${usd(ledger.spentMicros() - spentBefore)}`)
  }

  const header = {
    startedAt: startedAt.toISOString(),
    set: report.set,
    snapshotSha256: report.snapshotSha256,
    labelVersion: labels.version,
    labelSnapshotSha256: labels.snapshotSha256,
    labelledBy,
    model: report.model,
    judges: asked.map(({ name, model }) => ({ name, model })),
    promptHash: report.promptHash,
    judgePromptHash: rescore ? report.judgePromptHash : routineJudgeJudgeRoutinePrompt.hash,
    source: { report: reportPath, startedAt: report.startedAt },
    mode,
  }
  // The bar is the source run's: the same routines, so the same set, and a source that was a trial stays one.
  return finishRun({ header, set: report.set, trial: report.partial, stopped, judges: asked, judgeResults, judgeTotals, labelledBy, inputs, costMicros: ledger.spentMicros(), tally, reported, ledger, outDir, io })
}
