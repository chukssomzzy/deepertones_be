/*
 * The pure half of `npm run eval:verdict`: what a run saved for each case, scored against the cases' own expectations of the rules floor and against the labels
 * of the products the floor left open; then the run's percentages and the bar. No I/O. Percentages are exact (n * 100 / d, never rounded) and the bar compares
 * whole numbers, so 17 of 20 is 85 and a threshold is exact too.
 *
 * Three things are measured. The FLOOR is deterministic, so it must be right for every case. The FIT is how often the judge's raw label for an open product is the
 * label or one of the labels that would also do. HARMFUL is the judge calling helping a product the labels say is blocking. A rule that is on the wrong side of its
 * bar fails the run whatever else is missing; otherwise anything missing makes the bar "not evaluated". A run can fail, it cannot pass on partial evidence.
 */
import type { TaperKind } from '../../src/modules/catalog/catalog.vocabulary'
import type { FloorEntry, FloorResult } from '../../src/modules/verdicts/verdicts.floor'
import type { VerdictProduct } from '../../src/modules/verdicts/verdicts.merge'
import { stableJson } from '../../src/lib/stable-json'
import type { FitLabel, FitResult } from '../../src/providers/verdict-fitting/verdict-fitter.provider'
import type { VerdictCase, VerdictSet } from './verdict-cases'
import type { CaseLabels, LabelSet } from './verdict-labels'

/** The bars, in percent (the floor's is 100, so any miss fails it). */
export const FIT_AGREEMENT_MIN = 85
export const HARMFUL_MAX = 2
/** Open products labelled blocking that a run needs before its harmful rate can be trusted. */
export const MIN_BLOCKING: Record<VerdictSet, number> = { main: 30, holdout: 8 }

export type VerdictCaseInput = {
  id: string
  /** A case the run never reached (`cut-off`) is left out of everything. */
  state: 'done' | 'fit-error' | 'merge-error' | 'cut-off'
  expect: VerdictCase['expect']
  floor: FloorResult | null
  /** The sha256 of the request the judge was (or would have been) asked; null when the floor needed no judge. */
  requestSha256: string | null
  /** The judge's raw answer, or null when it gave none. */
  fit: FitResult | null
  /** The merged products, or null when the merge failed. */
  products: VerdictProduct[] | null
}

export type Rate = { count: number; total: number; rate: number | null }
export type Rule = 'floor' | 'fit-agreement' | 'harmful'
/** In the order they are listed. */
export const REASONS = ['partial-run', 'no-labels', 'needs-relabel', 'provisional-labels', 'too-few-blocking', 'no-fit-run'] as const
export type Reason = (typeof REASONS)[number]
export type Bar = { status: 'pass' } | { status: 'fail'; rules: Rule[]; notEvaluated: Reason[] } | { status: 'not-evaluated'; reasons: Reason[] }
/** A bar as the line and the exit code read it, so a bar written out as constants reads too. */
type ReadBar = { status: 'pass' } | { status: 'fail'; rules: readonly Rule[]; notEvaluated: readonly Reason[] } | { status: 'not-evaluated'; reasons: readonly Reason[] }

export type VerdictScore = {
  /** The cases scored: every case that was not cut off. */
  cases: number
  floor: { accuracy: number | null; missed: string[] }
  stricterOnly: { violations: { caseId: string; entryId: string }[] }
  fit: Rate
  harmful: Rate
  harmfulAllOpen: Rate
  overStrict: Rate
  confusion: Record<FitLabel, Record<FitLabel, number>>
  sameJobAs: Rate
  clashPick: Rate
  needsRelabel: string[]
  bar: Bar
}

export type ScoreOptions = {
  set: VerdictSet
  /** The run did not cover its whole set (the spend cap, a rejected key, or --limit). */
  partial: boolean
  floorOnly: boolean
  labels: LabelSet | null
  /** The reference's step-down code for each kind, to read the kind an expectation names. */
  tapers: Partial<Record<TaperKind, string>>
}

const rateOf = (count: number, total: number): Rate => ({ count, total, rate: total === 0 ? null : (count * 100) / total })

const LABELS: readonly FitLabel[] = ['helping', 'redundant', 'blocking']

// --- the floor -----------------------------------------------------------------------------------------------------------------------------------------

type Expected = VerdictCase['expect']['entries'][string]

/** Is the floor's answer for one entry what the case expects? An entry the floor has no answer for is right only when it was expected to be ignored. */
const floorEntryRight = (expected: Expected, entry: FloorEntry | undefined, tapers: ScoreOptions['tapers']): boolean => {
  if (expected.outcome === 'ignored') return entry === undefined
  if (entry === undefined) return false
  if (expected.outcome === 'open') return entry.status === 'open'
  if (entry.status !== 'fixed') return false
  if (entry.group !== expected.group || entry.verdict.kind !== expected.verdict || entry.escalate !== (expected.escalate ?? false)) return false
  return entry.verdict.kind !== 'stop' || (expected.taper !== undefined && entry.verdict.taperTemplateId === tapers[expected.taper])
}

const pairKey = (a: string, b: string): string => JSON.stringify([a, b].sort())

const sameClashes = (expected: readonly (readonly [string, string])[], found: FloorResult['clashes']): boolean => {
  const want = expected.map(([a, b]) => pairKey(a, b)).sort()
  const got = found.map(({ ids }) => pairKey(...ids)).sort()
  return want.length === got.length && want.every((key, i) => key === got[i])
}

/** One check for each entry the case has an expectation for, and one for the case's whole set of clash pairs. */
const floorChecksOf = (input: VerdictCaseInput, tapers: ScoreOptions['tapers']): { right: number; total: number } => {
  const entries = Object.entries(input.expect.entries)
  const byId = new Map((input.floor?.entries ?? []).map((entry) => [entry.id, entry]))
  const right = entries.filter(([id, expected]) => input.floor !== null && floorEntryRight(expected, byId.get(id), tapers)).length + (input.floor !== null && sameClashes(input.expect.clashes, input.floor.clashes) ? 1 : 0)
  return { right, total: entries.length + 1 }
}

/** Floor-fixed entries whose merged group or verdict is not the floor's: the judge may only make a verdict stricter, and it may not touch what the floor decided. */
const stricterViolationsOf = (input: VerdictCaseInput): string[] => {
  if (input.floor === null || input.products === null) return []
  const merged = new Map(input.products.map((product) => [product.entryId, product]))
  return input.floor.entries.flatMap((entry) => {
    if (entry.status !== 'fixed') return []
    const product = merged.get(entry.id)
    return product !== undefined && product.group === entry.group && stableJson(product.verdict) === stableJson(entry.verdict) ? [] : [entry.id]
  })
}

// --- the fit -------------------------------------------------------------------------------------------------------------------------------------------

/** The open products of a case that the fit is scored on: expected open AND left open by the floor. One the floor decided is the floor's miss, and nothing to ask the judge. */
const scoredOpenIds = (input: VerdictCaseInput): string[] => {
  const open = new Set((input.floor?.entries ?? []).filter((entry) => entry.status === 'open').map((entry) => entry.id))
  return Object.entries(input.expect.entries).flatMap(([id, expected]) => (expected.outcome === 'open' && open.has(id) ? [id] : []))
}

/** A case whose labels were made on the request it makes now. A case with no request has nothing to label. */
type Usable = { input: VerdictCaseInput; labels: CaseLabels }

export const scoreVerdictRun = (all: readonly VerdictCaseInput[], { set, partial, floorOnly, labels, tapers }: ScoreOptions): VerdictScore => {
  const inputs = all.filter((input) => input.state !== 'cut-off')

  // The floor: every case, whatever the labels say.
  let right = 0
  let checks = 0
  const missed: string[] = []
  const violations: { caseId: string; entryId: string }[] = []
  for (const input of inputs) {
    const counted = floorChecksOf(input, tapers)
    right += counted.right
    checks += counted.total
    const stricter = stricterViolationsOf(input)
    violations.push(...stricter.map((entryId) => ({ caseId: input.id, entryId })))
    // A merge that failed, or a judge that loosened a floor verdict, is the floor's failure too, though the floor's own answers may all be right.
    if (counted.right < counted.total || input.state === 'merge-error' || stricter.length > 0) missed.push(input.id)
  }

  // The fit: only the cases whose request has a label made for it.
  const usable: Usable[] = []
  const needsRelabel: string[] = []
  let withoutLabels = false
  if (!floorOnly) {
    for (const input of inputs) {
      if (input.requestSha256 === null) continue
      const caseLabels = labels?.cases[input.id]
      if (caseLabels === undefined) {
        if (scoredOpenIds(input).length > 0) withoutLabels = true
      } else if (caseLabels.requestSha256 !== input.requestSha256 || scoredOpenIds(input).some((id) => caseLabels.entries[id] === undefined)) needsRelabel.push(input.id)
      else usable.push({ input, labels: caseLabels })
    }
  }

  let fit = 0
  let fitTotal = 0
  let harmful = 0
  let blocking = 0
  let overStrict = 0
  let helping = 0
  let sameJob = 0
  let sameJobTotal = 0
  let clashAgreed = 0
  let clashTotal = 0
  const confusion = Object.fromEntries(LABELS.map((label) => [label, Object.fromEntries(LABELS.map((said) => [said, 0]))])) as VerdictScore['confusion']
  for (const { input, labels: caseLabels } of usable) {
    for (const id of scoredOpenIds(input)) {
      const entry = caseLabels.entries[id]!
      const answer = input.fit?.products.find((product) => product.id === id)
      const said = answer?.label ?? null
      fitTotal++
      if (said !== null && (said === entry.label || entry.alsoAcceptable.includes(said))) fit++
      if (said !== null) confusion[entry.label][said]++
      if (entry.label === 'blocking') {
        blocking++
        if (said === 'helping') harmful++
      }
      if (entry.label === 'helping') {
        helping++
        if (said === 'blocking') overStrict++
      }
      if (entry.label === 'redundant' && answer?.label === 'redundant') {
        sameJobTotal++
        if (answer.sameJobAs === entry.sameJobAs) sameJob++
      }
    }
    for (const { ids, reduce } of caseLabels.clashes) {
      clashTotal++
      const settled = input.fit?.clashes.find((clash) => pairKey(...clash.ids) === pairKey(...ids))
      if (settled !== undefined && (reduce === 'either' || settled.reduceId === reduce)) clashAgreed++
    }
  }

  const score: Omit<VerdictScore, 'bar'> = {
    cases: inputs.length,
    floor: { accuracy: checks === 0 ? null : (right * 100) / checks, missed },
    stricterOnly: { violations },
    fit: rateOf(fit, fitTotal),
    harmful: rateOf(harmful, blocking),
    // Every open product is the denominator, not only those labelled blocking: the same misses over the larger number, for the run's own picture.
    harmfulAllOpen: rateOf(harmful, fitTotal),
    overStrict: rateOf(overStrict, helping),
    confusion,
    sameJobAs: rateOf(sameJob, sameJobTotal),
    clashPick: rateOf(clashAgreed, clashTotal),
    needsRelabel,
  }

  const rules: Rule[] = []
  if (missed.length > 0) rules.push('floor')
  // Whole numbers, so that exactly on the bar is a pass.
  if (fitTotal > 0 && fit * 100 < FIT_AGREEMENT_MIN * fitTotal) rules.push('fit-agreement')
  if (blocking > 0 && harmful * 100 > HARMFUL_MAX * blocking) rules.push('harmful')

  const reasons = new Set<Reason>()
  if (floorOnly) reasons.add('no-fit-run')
  else {
    if (partial) reasons.add('partial-run')
    if (labels === null || withoutLabels) reasons.add('no-labels')
    if (needsRelabel.length > 0) reasons.add('needs-relabel')
    if (labels !== null && !labels.reviewed) reasons.add('provisional-labels')
    if (blocking < MIN_BLOCKING[set]) reasons.add('too-few-blocking')
  }
  const notEvaluated = REASONS.filter((reason) => reasons.has(reason))

  const bar: Bar = rules.length > 0 ? { status: 'fail', rules, notEvaluated } : notEvaluated.length > 0 ? { status: 'not-evaluated', reasons: notEvaluated } : { status: 'pass' }
  return { ...score, bar }
}

export const formatVerdictBarLine = (bar: ReadBar): string => {
  if (bar.status === 'pass') return 'Bar: PASS'
  if (bar.status === 'fail') return `Bar: FAIL (${bar.rules.join(', ')}${bar.notEvaluated.length === 0 ? '' : `; not evaluated: ${bar.notEvaluated.join(', ')}`})`
  return `Bar: not evaluated (${bar.reasons.join(', ')})`
}

/** 1 only for a FAIL: a trial that could not be evaluated is not a failure. */
export const verdictBarExitCode = (bar: ReadBar): number => (bar.status === 'fail' ? 1 : 0)
