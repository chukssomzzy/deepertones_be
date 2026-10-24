/*
 * The pure half of `npm run eval:routine`: a case's gate result and its picks against the labels, the run's percentages, the bar and the comparison with an
 * earlier run. No I/O. Percentages are exact (not rounded) and worked out as n * 100 / d, so a threshold is exact too: 17 of 20 is 85.
 */
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { GateFailure, Routine } from '../../src/modules/routines/routines.types'
import type { GapLabel } from './routine-labels'
import type { RoutineSet } from './routine-cases'

/** What the rubric judge said of one routine, as the score takes it: picks agreed of judged, and the three scores. */
export type JudgeResult = { picksAgreed: number; picksJudged: number; fit: number; simplicity: number; words: number }

export type RoutineCaseInput = {
  id: string
  /** For each gap, its candidates' codes (sorted): a gap with none is "use what you have". */
  gapCodes: Partial<Record<RoutineStep, string[]>>
  /** The routine, or null when the writer failed. */
  routine: Routine | null
  /** The class name of the writer's error, or null. */
  writerError: string | null
  failures: GateFailure[]
  /** The labels of this case, or null when it has none. */
  labels: Partial<Record<RoutineStep, GapLabel>> | null
  /** Null when there was no judge. */
  judge: JudgeResult | null
  costMicros: number
}

export type CasePicks = 'right' | 'wrong' | 'unscored'

export type CaseScore = {
  gatesPassed: boolean
  forbiddenWording: number
  picks: CasePicks
  /** The labels were made on other candidates than this skeleton has. */
  needsRelabel: boolean
  /** Scored gaps: labelled, at least 2 candidates, labels not out of date. */
  scoredGaps: number
  rightGaps: number
  bestGaps: number
}

export type BarRule = 'gates' | 'right-product' | 'judge-agreement' | 'forbidden-wording'
export type BarReason = 'dev-set' | 'partial-run' | 'no-labels' | 'needs-relabel' | 'no-scored-gaps' | 'no-judge'
export type Bar = { status: 'pass' } | { status: 'fail'; rules: BarRule[]; notEvaluated: BarReason[] } | { status: 'not-evaluated'; reasons: BarReason[] }

export type RunScore = {
  cases: number
  gatesPassed: number | null
  forbiddenWording: number
  rightProduct: number | null
  exactlyBest: number | null
  needsRelabel: string[]
  judgeAgreement: number | null
  fit: number | null
  simplicity: number | null
  words: number | null
  costMicros: number
  bar: Bar
}

const percent = (n: number, d: number): number | null => (d === 0 ? null : (n * 100) / d)
const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length)
const sameCodes = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((code, i) => code === b[i])

/** The gaps that have candidates, with their codes sorted. */
const withCandidates = (gapCodes: RoutineCaseInput['gapCodes']): [RoutineStep, string[]][] =>
  (Object.entries(gapCodes) as [RoutineStep, string[]][]).filter(([, codes]) => codes.length > 0).map(([step, codes]) => [step, [...codes].sort()])

export const needsRelabelOf = ({ gapCodes, labels }: Pick<RoutineCaseInput, 'gapCodes' | 'labels'>): boolean => {
  if (labels === null) return false
  const now = withCandidates(gapCodes)
  const labelled = (Object.entries(labels) as [RoutineStep, GapLabel][]).filter(([, label]) => label !== undefined)
  return now.length !== labelled.length || now.some(([step, codes]) => labels[step] === undefined || !sameCodes(codes, [...labels[step]!.candidates].sort()))
}

/**
 * The gaps a case is scored on: labelled, at least 2 candidates, and the labels not out of date. Both the picks and the judge's agreement count over exactly these,
 * so a gap the labels cannot speak for is never in one and not the other.
 */
export const scoredGapsOf = (input: Pick<RoutineCaseInput, 'gapCodes' | 'labels'>): [RoutineStep, GapLabel][] => {
  const { labels } = input
  if (labels === null || needsRelabelOf(input)) return []
  return withCandidates(input.gapCodes).flatMap(([step]) => (labels[step] !== undefined && labels[step]!.candidates.length >= 2 ? [[step, labels[step]!] as [RoutineStep, GapLabel]] : []))
}

export const scoreRoutineCase = (input: RoutineCaseInput): CaseScore => {
  const gatesPassed = input.routine !== null && input.writerError === null && input.failures.length === 0
  const forbiddenWording = input.failures.filter((failure) => failure.gate === 'wording').length
  const needsRelabel = needsRelabelOf(input)
  const scored = scoredGapsOf(input)
  let rightGaps = 0
  let bestGaps = 0
  for (const [step, label] of scored) {
    // A routine that failed the gates, or was never written, has no pick that counts.
    const product = gatesPassed ? input.routine!.steps.find((entry) => entry.step === step)?.product : undefined
    if (product?.kind !== 'candidate') continue
    if (product.code === label.best) {
      rightGaps++
      bestGaps++
    } else if (label.acceptable.includes(product.code)) rightGaps++
  }
  const picks: CasePicks = scored.length === 0 ? 'unscored' : rightGaps === scored.length ? 'right' : 'wrong'
  return { gatesPassed, forbiddenWording, picks, needsRelabel, scoredGaps: scored.length, rightGaps, bestGaps }
}

/**
 * Why the bar cannot be fully evaluated, in a fixed order. `no-scored-gaps` is for labels that are all there and current but leave no gap to score (every gap
 * has a single candidate, or none): the right product has nothing to be measured on, which is not the same as being 100%.
 */
const missingOf = (inputs: RoutineCaseInput[], scores: CaseScore[], judgeAgreement: number | null, scoredGaps: number, partial: boolean): BarReason[] => {
  const reasons: BarReason[] = []
  if (partial) reasons.push('partial-run')
  const noLabels = inputs.some((input) => input.labels === null && withCandidates(input.gapCodes).length > 0)
  const needsRelabel = scores.some((score) => score.needsRelabel)
  if (noLabels) reasons.push('no-labels')
  if (needsRelabel) reasons.push('needs-relabel')
  if (!noLabels && !needsRelabel && scoredGaps === 0) reasons.push('no-scored-gaps')
  // A case with no routine (the writer failed) has nothing to judge.
  if (judgeAgreement === null || inputs.some((input) => input.routine !== null && input.judge === null)) reasons.push('no-judge')
  return reasons
}

const RIGHT_PRODUCT_MIN = 85
const JUDGE_AGREEMENT_MIN = 80

export const scoreRun = (inputs: RoutineCaseInput[], { set, partial }: { set: RoutineSet; partial: boolean }): RunScore => {
  const scores = inputs.map(scoreRoutineCase)
  const sum = (pick: (score: CaseScore) => number) => scores.reduce((total, score) => total + pick(score), 0)
  const scoredGaps = sum((s) => s.scoredGaps)
  const judged = inputs.flatMap((input) => (input.judge === null ? [] : [input.judge]))
  const pickedJudged = judged.reduce((total, j) => total + j.picksJudged, 0)

  const gatesPassed = percent(scores.filter((s) => s.gatesPassed).length, scores.length)
  const forbiddenWording = sum((s) => s.forbiddenWording)
  const rightProduct = percent(sum((s) => s.rightGaps), scoredGaps)
  const judgeAgreement = percent(
    judged.reduce((total, j) => total + j.picksAgreed, 0),
    pickedJudged,
  )

  const missing = missingOf(inputs, scores, judgeAgreement, scoredGaps, partial)
  // One rule for the whole bar: a rule that can be evaluated and fails is a FAIL, whatever else is missing, and a trial (a partial run) can fail but never pass.
  // Gates and forbidden wording can always be evaluated; judge agreement when some case was judged; right product only when every case with candidates has
  // labels and none needs re-labelling, because otherwise the percentage would leave cases out and could look better than the run was.
  const rules: BarRule[] = []
  if (gatesPassed !== null && gatesPassed < 100) rules.push('gates')
  if (rightProduct !== null && rightProduct < RIGHT_PRODUCT_MIN && !missing.includes('no-labels') && !missing.includes('needs-relabel')) rules.push('right-product')
  if (judgeAgreement !== null && judgeAgreement < JUDGE_AGREEMENT_MIN) rules.push('judge-agreement')
  if (forbiddenWording > 0) rules.push('forbidden-wording')
  // The dev set is for tuning: it is never the bar, and says nothing else.
  const bar: Bar = set === 'dev' ? { status: 'not-evaluated', reasons: ['dev-set'] } : rules.length > 0 ? { status: 'fail', rules, notEvaluated: missing } : missing.length > 0 ? { status: 'not-evaluated', reasons: missing } : { status: 'pass' }

  return {
    cases: inputs.length,
    gatesPassed,
    forbiddenWording,
    rightProduct,
    exactlyBest: percent(sum((s) => s.bestGaps), scoredGaps),
    needsRelabel: inputs.filter((_, i) => scores[i]!.needsRelabel).map((input) => input.id),
    judgeAgreement,
    fit: mean(judged.map((j) => j.fit)),
    simplicity: mean(judged.map((j) => j.simplicity)),
    words: mean(judged.map((j) => j.words)),
    costMicros: inputs.reduce((total, input) => total + input.costMicros, 0),
    bar,
  }
}

export const formatBarLine = (bar: Bar): string => {
  if (bar.status === 'pass') return 'Bar: PASS'
  if (bar.status === 'fail') return `Bar: FAIL (${bar.rules.join(', ')}${bar.notEvaluated.length > 0 ? `; not evaluated: ${bar.notEvaluated.join(', ')}` : ''})`
  return `Bar: not evaluated (${bar.reasons.join(', ')})`
}

/** 0 for a pass and for a run that was not evaluated (a trial); 1 for a fail, whatever else is missing. */
export const barExitCode = (bar: Bar): number => (bar.status === 'fail' ? 1 : 0)

export type Measures = Pick<RunScore, 'rightProduct' | 'fit' | 'simplicity' | 'words'>
export type Comparison = { verdict: 'better' | 'worse' | 'same'; decidedBy: keyof Measures | null }

const ORDER: (keyof Measures)[] = ['rightProduct', 'fit', 'simplicity', 'words']

/** Right product first, then fit, simplicity and words: the first measure that is there on both sides and differs decides. Higher is better. */
export const compare = (previous: Measures, current: Measures): Comparison => {
  for (const measure of ORDER) {
    const before = previous[measure]
    const now = current[measure]
    if (before === null || now === null || before === now) continue
    return { verdict: now > before ? 'better' : 'worse', decidedBy: measure }
  }
  return { verdict: 'same', decidedBy: null }
}
