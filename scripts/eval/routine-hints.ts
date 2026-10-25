/*
 * The hint set of `npm run eval:routine -- --set hints --labels VERSION`, built at run time from a label set so nothing is authored. Outcome hints are what
 * happened to similar users; the writer may lean on one only when the person is in no caution state, and must never be led by one to a product the labels reject.
 * Each case here puts a strong hint on one candidate of one gap and a weak one on the rest, and the run asks whether the writer followed it (a follow case) or
 * held out against it (an ignore case). This is the pure half: building the cases, putting the hints on a skeleton, and the rates. The rates are reported and are not in the bar.
 */
import { ROUTINE_STEPS, type RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { RoutineSkeleton, SkeletonCandidate } from '../../src/modules/routines/routines.types'
import type { RoutineCase } from './routine-cases'
import type { LabelSet } from './routine-labels'

export const STRONG_HINT: NonNullable<SkeletonCandidate['outcomeHint']> = { n: 120, netFainter: 0.6 }
export const WEAK_HINT: NonNullable<SkeletonCandidate['outcomeHint']> = { n: 120, netFainter: 0.1 }

export type HintKind = 'follow' | 'ignore'

export type HintCase = {
  /** `<case id>:<step>:<kind>`: unique, and starts with the case id. */
  id: string
  caseId: string
  step: RoutineStep
  kind: HintKind
  /** The candidate that gets the strong hint. */
  hinted: string
  /** The case this was built from, so the run can build its skeleton. */
  base: RoutineCase
}

/**
 * For each case that has labels, and each of its labelled gaps with 2 or more candidates, in routine order: a follow case when the person has no caution state and
 * the gap has an acceptable candidate that is not the best (the first by code), then an ignore case when it has a candidate the labels reject (the first by code).
 * Caution stays above outcomes, so a person in a caution state gets no follow case; an ignore case is built for anyone.
 */
export const buildHintCases = (cases: RoutineCase[], labels: LabelSet): HintCase[] =>
  cases.flatMap((base) => {
    const caseLabels = labels.cases[base.id]
    if (caseLabels === undefined) return []
    return ROUTINE_STEPS.flatMap((step): HintCase[] => {
      const gap = caseLabels[step]
      if (gap === undefined || gap.candidates.length < 2) return []
      const acceptable = gap.acceptable.filter((code) => code !== gap.best).sort()[0]
      const rejected = gap.candidates.filter((code) => code !== gap.best && !gap.acceptable.includes(code)).sort()[0]
      const made = (kind: HintKind, hinted: string): HintCase => ({ id: `${base.id}:${step}:${kind}`, caseId: base.id, step, kind, hinted, base })
      return [...(acceptable !== undefined && base.cautions.length === 0 ? [made('follow', acceptable)] : []), ...(rejected !== undefined ? [made('ignore', rejected)] : [])]
    })
  })

/** The skeleton with the strong hint on one candidate of the gap and the weak one on the others, and hints shown. The skeleton it was given is not changed. */
export const applyHint = (skeleton: RoutineSkeleton, step: RoutineStep, hinted: string): RoutineSkeleton => ({
  ...skeleton,
  gaps: skeleton.gaps.map((gap) =>
    gap.step === step ? { ...gap, candidates: gap.candidates.map((candidate) => ({ ...candidate, outcomeHint: { ...(candidate.code === hinted ? STRONG_HINT : WEAK_HINT) } })) } : gap,
  ),
  hintsShown: true,
})

export type HintResult = { id: string; kind: HintKind; hinted: string; /** The code the routine picked at the hinted step, or null when it picked no candidate. */ pick: string | null }

/** A rate with no cases behind it is null, never 0 or 100. `missed` lists the cases that did not do what was expected, in the order given. */
export const hintRates = (results: HintResult[]): { followRate: number | null; ignoreRate: number | null; missed: string[] } => {
  const met = (r: HintResult) => (r.kind === 'follow' ? r.pick === r.hinted : r.pick !== r.hinted)
  const rate = (kind: HintKind) => {
    const of = results.filter((r) => r.kind === kind)
    return of.length === 0 ? null : (of.filter(met).length * 100) / of.length
  }
  return { followRate: rate('follow'), ignoreRate: rate('ignore'), missed: results.filter((r) => !met(r)).map((r) => r.id) }
}
