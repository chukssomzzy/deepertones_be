import { describe, expect, it } from 'vitest'
import type { FloorEntry, FloorResult } from '../../src/modules/verdicts/verdicts.floor'
import type { VerdictProduct } from '../../src/modules/verdicts/verdicts.merge'
import type { FitResult } from '../../src/providers/verdict-fitting/verdict-fitter.provider'
import type { CaseLabels, LabelSet } from './verdict-labels'
import { formatVerdictBarLine, scoreVerdictRun, verdictBarExitCode, type VerdictCaseInput } from './verdict-score'

// The scoring of `npm run eval:verdict`: pure, over what a run saved for each case (the same record report.json holds), the labels and three options. No model, no
// disk, no clock. The cases here are built by hand from the rules in the brief (spec #171, slice E), each number worked out in the comment or the name of its test.
//
// Shapes assumed (the contract this file pins):
//   scoreVerdictRun(inputs: VerdictCaseInput[], opts: { set: 'main' | 'holdout'; partial: boolean; floorOnly: boolean; labels: LabelSet | null;
//                                                       tapers: Partial<Record<TaperKind, string>> /* the reference's code for each kind, to read an expectation's taper kind */ })
//   VerdictCaseInput = { id; state: 'done' | 'fit-error' | 'merge-error' | 'cut-off'; expect: VerdictCase['expect']; floor: FloorResult | null; requestSha256: string | null;
//                        fit: FitResult | null /* the judge's RAW answer */; products: VerdictProduct[] | null /* the merged products */ }
//   returns {
//     cases: number                                   the cases scored: every case that was not cut off
//     floor: { accuracy: number | null; missed: string[] }   percent of checked things right (each entry's expectation, and each case's clash pair set);
//                                                     `missed` is the ids of the cases with a floor miss, a merge-error or a stricter-only violation
//     stricterOnly: { violations: { caseId; entryId }[] }    a floor-fixed entry whose merged group or verdict is not the floor's
//     fit: Rate            judge agreement:  count = open products whose RAW label is the label or one of its alsoAcceptable, total = open products scored
//     harmful: Rate        over open products labelled blocking: the judge said helping
//     harmfulAllOpen: Rate over all open products scored: labelled blocking and the judge said helping
//     overStrict: Rate     over open products labelled helping: the judge said blocking
//     confusion: Record<label, Record<said, number>>   3x3, rows the label, columns the judge's raw answer; a product the judge gave no answer for is in no cell
//     sameJobAs: Rate      products labelled AND said redundant: the judge named the same product as the label
//     clashPick: Rate      labelled clash pairs: the judge reduced the labelled product (or any, for 'either'); a pair the judge left out does not agree
//     needsRelabel: string[]   ids of cases whose requestSha256 differs from their labels'
//     bar: Bar }
//   Rate = { count: number; total: number; rate: number | null }   rate is a percent (count * 100 / total), null when total is 0
//   Bar  = { status: 'pass' } | { status: 'fail'; rules: Rule[]; notEvaluated: Reason[] } | { status: 'not-evaluated'; reasons: Reason[] }
//   Rule   = 'floor' | 'fit-agreement' | 'harmful'        (the bars: floor 100%, fit agreement at least 85%, harmful at most 2%)
//   Reason = 'partial-run' | 'no-labels' | 'needs-relabel' | 'provisional-labels' | 'too-few-blocking' | 'no-fit-run', always in that order
//   formatVerdictBarLine(bar): string   `Bar: PASS`, `Bar: FAIL (<rules>[; not evaluated: <reasons>])` or `Bar: not evaluated (<reasons>)`
//   verdictBarExitCode(bar): number     0 for a pass and a trial, 1 for a fail
//
// Decisions pinned here (the brief left them open):
//   * A rule whose figure is on the wrong side of its bar is a FAIL even when the run is also a trial, has provisional labels or leaves cases out: a trial can fail, it cannot pass.
//   * `floor` fails on any floor miss, any merge-error, and any stricter-only violation (all three put the case in `floor.missed`).
//   * An `ignored` expectation is right when the floor has no entry for it. A floor entry that is `taper-missing` is never right.
//   * In a floor-only run the fit is not scored at all and the only reason is `no-fit-run`.
//   * Open products of a case that has no labels, or whose labels are out of date, are not scored.

type Lbl = 'helping' | 'redundant' | 'blocking'
const SHA = '1'.repeat(64)
const OTHER_SHA = '2'.repeat(64)
const TAPERS = { steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' }

// --- builders ------------------------------------------------------------------------------------------------------------------------------------------

type Spec = {
  id: string
  label: Lbl
  /** What the judge said; the label when left out, and no answer at all when null. */
  said?: Lbl | null
  also?: Lbl[]
  /** The product the label says does the job (a redundant label's), and the product the judge named. */
  sameJobAs?: string
  saidSameJobAs?: string
}

const batch = (prefix: string, count: number, label: Lbl, said: Lbl | null = label): Spec[] => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i + 1}`, label, said }))

const pair = (a: string, b: string) => ({ ids: [a, b] as [string, string], groups: ['retinoid', 'exfoliating-acid'] as ['retinoid', 'exfoliating-acid'], fallbackReduceId: b, maxFrequency: 'alternate-days' as const })

const mergedOf = (id: string, said: Lbl | null): VerdictProduct => ({
  entryId: id,
  group: said ?? 'undecided',
  verdict: said === 'blocking' || said === 'redundant' ? { kind: 'drop' } : { kind: 'keep' },
  escalate: false,
  reason: 'A made-up reason.',
  facts: [],
  basis: [],
})

type Built = { input: VerdictCaseInput; labels: CaseLabels | null }

/** A case whose every product is open: the floor leaves them all to the judge, as the case expects. */
const openCase = (
  id: string,
  specs: Spec[],
  over: { state?: VerdictCaseInput['state']; sha?: string; labelSha?: string; noLabels?: boolean; clashes?: { pairs: [string, string][]; labelled: CaseLabels['clashes']; said: NonNullable<FitResult['clashes']> }; labelledBy?: string } = {},
): Built => {
  const state = over.state ?? 'done'
  const answered = state === 'done' || state === 'merge-error'
  const fit: FitResult | null = answered
    ? {
        products: specs.flatMap((s) => {
          const said = s.said === undefined ? s.label : s.said
          return said === null
            ? []
            : [said === 'redundant' ? { id: s.id, label: 'redundant' as const, reason: 'r', sameJobAs: s.saidSameJobAs ?? 'keeper' } : { id: s.id, label: said, reason: 'r', sameJobAs: null }]
        }),
        clashes: over.clashes?.said ?? [],
      }
    : null
  const floor: FloorResult = { entries: specs.map((s) => ({ id: s.id, status: 'open' as const })), clashes: (over.clashes?.pairs ?? []).map(([a, b]) => pair(a, b)) }
  const input: VerdictCaseInput = {
    id,
    state,
    expect: { entries: Object.fromEntries(specs.map((s) => [s.id, { outcome: 'open' as const }])), clashes: over.clashes?.pairs ?? [] },
    floor,
    requestSha256: over.sha ?? SHA,
    fit,
    products: state === 'merge-error' ? null : specs.map((s) => mergedOf(s.id, answered ? (s.said === undefined ? s.label : s.said) : null)),
  }
  const labels: CaseLabels | null = over.noLabels
    ? null
    : {
        caseId: id,
        requestSha256: over.labelSha ?? SHA,
        labelledBy: over.labelledBy ?? 'human',
        entries: Object.fromEntries(specs.map((s) => [s.id, { label: s.label, alsoAcceptable: s.also ?? [], ...(s.label === 'redundant' ? { sameJobAs: s.sameJobAs ?? 'keeper' } : {}), rationale: 'A made-up rationale.' }])),
        clashes: over.clashes?.labelled ?? [],
      }
  return { input, labels }
}

const labelSet = (built: Built[], reviewed = true): LabelSet => ({ version: 'v1', reviewed, cases: Object.fromEntries(built.flatMap((b) => (b.labels === null ? [] : [[b.labels.caseId, b.labels] as const]))) })

type Options = { set?: 'main' | 'holdout'; partial?: boolean; floorOnly?: boolean; reviewed?: boolean; labels?: LabelSet | null }
const score = (built: Built[], { set = 'holdout', partial = false, floorOnly = false, reviewed = true, labels }: Options = {}) =>
  scoreVerdictRun(
    built.map((b) => b.input),
    { set, partial, floorOnly, labels: labels === undefined ? labelSet(built, reviewed) : labels, tapers: TAPERS },
  )

/** 8 blocking (the holdout's minimum) the judge gets right, and 12 helping the judge gets right: a holdout run that passes. */
const good = (over: Parameters<typeof openCase>[2] = {}): Built => openCase('hold-01', [...batch('b', 8, 'blocking'), ...batch('h', 12, 'helping')], over)

describe('scoreVerdictRun: a run that meets every bar', () => {
  it('passes, with the judge in full agreement and nothing harmful', () => {
    const result = score([good()])

    expect(result.bar).toEqual({ status: 'pass' })
    expect(result.cases).toBe(1)
    expect(result.fit).toEqual({ count: 20, total: 20, rate: 100 })
    expect(result.harmful).toEqual({ count: 0, total: 8, rate: 0 })
    expect(result.floor).toEqual({ accuracy: 100, missed: [] })
    expect(result.needsRelabel).toEqual([])
  })
})

describe('scoreVerdictRun: fit agreement, at least 85%', () => {
  const withWrong = (wrong: number) => openCase('hold-01', [...batch('b', 8, 'blocking'), ...batch('r', wrong, 'helping', 'redundant'), ...batch('h', 12 - wrong, 'helping')])

  it('passes at exactly 85%: 17 of 20 agreed', () => {
    const result = score([withWrong(3)])

    expect(result.fit).toEqual({ count: 17, total: 20, rate: 85 })
    expect(result.bar).toEqual({ status: 'pass' })
  })

  it('fails just under 85%: 16 of 20 agreed is 80%', () => {
    const result = score([withWrong(4)])

    expect(result.fit).toEqual({ count: 16, total: 20, rate: 80 })
    expect(result.bar).toEqual({ status: 'fail', rules: ['fit-agreement'], notEvaluated: [] })
  })

  it('counts a label that the product\'s alsoAcceptable lists as agreed', () => {
    const result = score([openCase('hold-01', [{ id: 'a', label: 'helping', said: 'redundant', also: ['redundant'] }, { id: 'b', label: 'helping', said: 'blocking', also: [] }])])

    expect(result.fit).toMatchObject({ count: 1, total: 2 })
  })

  it('compares the judge\'s raw label, not what the merge made of it: a helping that a clash then reduced still agrees with helping', () => {
    const clash: Built = openCase('hold-01', [{ id: 'retinol', label: 'helping' }, { id: 'acid', label: 'helping' }], { clashes: { pairs: [['retinol', 'acid']], labelled: [{ ids: ['retinol', 'acid'], reduce: 'either' }], said: [{ ids: ['retinol', 'acid'], reduceId: 'acid' }] } })
    // The merge saved the acid as conflicting, reduced to alternate days: its group is no longer `helping`.
    clash.input.products = [mergedOf('retinol', 'helping'), { ...mergedOf('acid', 'helping'), group: 'conflicting', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' } }]

    const result = score([clash])

    expect(result.fit).toEqual({ count: 2, total: 2, rate: 100 })
  })

  it('counts a product the judge gave no answer for as not agreed', () => {
    const result = score([openCase('hold-01', [{ id: 'a', label: 'helping', said: null }, { id: 'b', label: 'helping' }])])

    expect(result.fit).toMatchObject({ count: 1, total: 2 })
  })

  it('counts every open product of a case whose judge failed as not agreed, and none of them as harmful', () => {
    const failed = openCase('hold-01', [...batch('b', 2, 'blocking'), ...batch('h', 3, 'helping')], { state: 'fit-error' })

    const result = score([failed])

    expect(result.fit).toEqual({ count: 0, total: 5, rate: 0 })
    expect(result.harmful).toEqual({ count: 0, total: 2, rate: 0 })
    expect(result.cases).toBe(1)
  })

  it('pools the products of every case', () => {
    const result = score([openCase('hold-01', batch('a', 4, 'helping')), openCase('hold-02', [...batch('b', 4, 'helping'), ...batch('c', 2, 'helping', 'blocking')])])

    expect(result.fit).toEqual({ count: 8, total: 10, rate: 80 })
  })
})

describe('scoreVerdictRun: harmful, at most 2% of the open products labelled blocking', () => {
  const blocking50 = (helping: number) => openCase('hold-01', [...batch('x', helping, 'blocking', 'helping'), ...batch('b', 50 - helping, 'blocking')])

  it('passes at exactly 2%: 1 of 50 blocking products called helping', () => {
    const result = score([blocking50(1)])

    expect(result.harmful).toEqual({ count: 1, total: 50, rate: 2 })
    expect(result.bar).toEqual({ status: 'pass' })
  })

  it('fails just over 2%: 2 of 50 is 4%', () => {
    const result = score([blocking50(2)])

    expect(result.harmful).toEqual({ count: 2, total: 50, rate: 4 })
    expect(result.bar).toEqual({ status: 'fail', rules: ['harmful'], notEvaluated: [] })
  })

  it('fails on 1 of 49: 2.04% is over the bar', () => {
    const result = score([openCase('hold-01', [...batch('x', 1, 'blocking', 'helping'), ...batch('b', 48, 'blocking')])])

    expect(result.harmful.rate).toBeCloseTo(100 / 49, 10)
    expect(result.bar.status).toBe('fail')
  })

  it('does not call a redundant answer harmful, nor a blocking product the judge was told is also fine as redundant', () => {
    const result = score([openCase('hold-01', [{ id: 'a', label: 'blocking', said: 'redundant', also: ['redundant'] }, ...batch('b', 7, 'blocking')])])

    expect(result.harmful.count).toBe(0)
    expect(result.fit).toMatchObject({ count: 8, total: 8 })
  })

  it('reports the harmful rate over ALL open products beside it, for the run\'s own picture', () => {
    // 10 blocking, one called helping, and 10 helping: harmful is 1 of 10 blocking, and 1 of all 20 open.
    const result = score([openCase('hold-01', [...batch('x', 1, 'blocking', 'helping'), ...batch('b', 9, 'blocking'), ...batch('h', 10, 'helping')])])

    expect(result.harmful).toEqual({ count: 1, total: 10, rate: 10 })
    expect(result.harmfulAllOpen).toEqual({ count: 1, total: 20, rate: 5 })
  })
})

describe('scoreVerdictRun: what is reported besides the bar', () => {
  it('reports the over-strict rate: blocking where the label says helping, over the products labelled helping', () => {
    const result = score([openCase('hold-01', [...batch('s', 1, 'helping', 'blocking'), ...batch('h', 3, 'helping'), ...batch('b', 2, 'blocking')])])

    expect(result.overStrict).toEqual({ count: 1, total: 4, rate: 25 })
  })

  it('reports a 3x3 confusion matrix of the label against the judge\'s raw answer, leaving out a product the judge did not answer', () => {
    const result = score([
      openCase('hold-01', [
        { id: 'a', label: 'helping', said: 'helping' },
        { id: 'b', label: 'helping', said: 'blocking' },
        { id: 'c', label: 'blocking', said: 'helping' },
        { id: 'd', label: 'redundant', said: 'redundant' },
        { id: 'e', label: 'redundant', said: 'helping' },
        { id: 'f', label: 'redundant', said: null },
      ]),
    ])

    expect(result.confusion).toEqual({
      helping: { helping: 1, redundant: 0, blocking: 1 },
      redundant: { helping: 1, redundant: 1, blocking: 0 },
      blocking: { helping: 1, redundant: 0, blocking: 0 },
    })
  })

  it('reports whether the judge named the same product as the label for a redundant one, when both call it redundant', () => {
    const result = score([
      openCase('hold-01', [
        { id: 'r1', label: 'redundant', sameJobAs: 'keeper', saidSameJobAs: 'keeper' },
        { id: 'r2', label: 'redundant', sameJobAs: 'keeper', saidSameJobAs: 'other' },
        // Labelled redundant but called helping: there is nothing to compare.
        { id: 'r3', label: 'redundant', said: 'helping' },
      ]),
    ])

    expect(result.sameJobAs).toEqual({ count: 1, total: 2, rate: 50 })
  })

  it('reports whether the judge reduced the product the label says to, in either order of the pair, with `either` accepting any pick', () => {
    const pairs: [string, string][] = [['a', 'b'], ['c', 'd'], ['e', 'f']]
    const built = openCase('hold-01', ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, label: 'helping' as const })), {
      clashes: {
        pairs,
        labelled: [{ ids: ['a', 'b'], reduce: 'a' }, { ids: ['c', 'd'], reduce: 'c' }, { ids: ['e', 'f'], reduce: 'either' }],
        said: [{ ids: ['b', 'a'], reduceId: 'a' }, { ids: ['c', 'd'], reduceId: 'd' }, { ids: ['e', 'f'], reduceId: 'f' }],
      },
    })

    const result = score([built])

    expect(result.clashPick).toMatchObject({ count: 2, total: 3 })
    expect(result.clashPick.rate).toBeCloseTo(66.667, 2)
  })

  it('has nothing to report for the informational figures when there is nothing behind them', () => {
    const result = score([openCase('hold-01', batch('h', 2, 'helping'))])

    expect(result.sameJobAs).toEqual({ count: 0, total: 0, rate: null })
    expect(result.clashPick).toEqual({ count: 0, total: 0, rate: null })
  })
})

// --- the floor ---------------------------------------------------------------------------------------------------------------------------------------

type Fixed = Extract<FloorEntry, { status: 'fixed' }>
const steroidStop: Fixed = { id: 'g', status: 'fixed', group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, escalate: false, facts: [] }
const steroidExpected = { outcome: 'fixed' as const, group: 'likely-the-problem' as const, verdict: 'stop' as const, taper: 'steroid' as const }

const mergedFixed = (entry: Fixed): VerdictProduct => ({ entryId: entry.id, group: entry.group, verdict: entry.verdict, escalate: entry.escalate, reason: 'A made-up reason.', facts: [], basis: [] })

/** A case the floor settles whole: one fixed entry and what the case expects of it. Everything is as the rules say unless the test changes one thing. */
const floorCase = (over: { floor?: FloorEntry; expected?: VerdictCaseInput['expect']['entries'][string]; products?: VerdictProduct[] | null; state?: VerdictCaseInput['state']; expectClashes?: [string, string][]; floorClashes?: [string, string][]; id?: string } = {}): Built => {
  const entry = over.floor ?? steroidStop
  return {
    input: {
      id: over.id ?? 'hold-01',
      state: over.state ?? 'done',
      expect: { entries: { g: over.expected ?? steroidExpected }, clashes: over.expectClashes ?? [] },
      floor: { entries: [entry], clashes: (over.floorClashes ?? []).map(([a, b]) => pair(a, b)) },
      requestSha256: null,
      fit: null,
      products: over.products === undefined ? (entry.status === 'fixed' ? [mergedFixed(entry)] : [mergedOf('g', null)]) : over.products,
    },
    labels: null,
  }
}

describe('scoreVerdictRun: the floor, 100% of what the cases expect of it', () => {
  it('is 100% and passes the floor rule when every entry and every clash set is as expected', () => {
    const result = score([floorCase()], { labels: null })

    expect(result.floor).toEqual({ accuracy: 100, missed: [] })
    expect(result.bar.status).not.toBe('fail')
  })

  it.each([
    ['a different group', { floor: { ...steroidStop, group: 'conflicting' } as Fixed }],
    ['a different verdict', { floor: { ...steroidStop, verdict: { kind: 'drop' } } as Fixed }],
    ['a stop with the step-down of the other kind', { floor: { ...steroidStop, verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' } } as Fixed }],
    ['an expectation of the other taper kind', { expected: { ...steroidExpected, taper: 'lightening-agent' as const } }],
    ['an escalation that was not expected', { floor: { ...steroidStop, escalate: true } as Fixed }],
    ['no escalation where one was expected', { expected: { ...steroidExpected, escalate: true as const } }],
    ['an entry left open that was expected fixed', { floor: { id: 'g', status: 'open' } as FloorEntry }],
    ['a step-down that has no approved template', { floor: { id: 'g', status: 'taper-missing', group: 'likely-the-problem', missingTaper: 'steroid', escalate: false, facts: [] } as FloorEntry }],
    ['an entry fixed that was expected open', { expected: { outcome: 'open' as const } }],
    ['an entry the floor decided that was expected to be ignored', { expected: { outcome: 'ignored' as const } }],
    ['a clash the floor found and nobody expected', { floorClashes: [['g', 'h']] as [string, string][] }],
    ['a clash expected and not found', { expectClashes: [['g', 'h']] as [string, string][] }],
    ['a different pair of products clashing', { expectClashes: [['g', 'h']] as [string, string][], floorClashes: [['g', 'i']] as [string, string][] }],
  ])('misses on %s: the floor rule fails whatever else is missing, and names the case', (_what, over) => {
    const result = score([floorCase(over)], { labels: null })

    expect(result.floor.accuracy).toBeLessThan(100)
    expect(result.floor.missed).toEqual(['hold-01'])
    expect(result.bar.status).toBe('fail')
    expect(result.bar).toMatchObject({ rules: ['floor'] })
    expect(verdictBarExitCode(result.bar)).toBe(1)
  })

  it('accepts an expected escalation, a keep with no step-down, and a clash pair written in the other order', () => {
    const prescribed: Fixed = { id: 'g', status: 'fixed', group: 'prescribed', verdict: { kind: 'keep' }, escalate: false, facts: [] }
    const escalating: Fixed = { ...steroidStop, escalate: true }

    expect(score([floorCase({ floor: escalating, expected: { ...steroidExpected, escalate: true } })], { labels: null }).floor.missed).toEqual([])
    expect(score([floorCase({ floor: prescribed, expected: { outcome: 'fixed', group: 'prescribed', verdict: 'keep' } })], { labels: null }).floor.missed).toEqual([])
    expect(score([floorCase({ expectClashes: [['g', 'h']], floorClashes: [['h', 'g']] })], { labels: null }).floor.missed).toEqual([])
  })

  it('is right about an ignored entry when the floor has no entry for it, and a miss when it has', () => {
    const ignored = (floor: FloorEntry[]): Built => {
      const built = floorCase()
      built.input.expect = { entries: { g: steroidExpected, pomade: { outcome: 'ignored' } }, clashes: [] }
      built.input.floor = { entries: [steroidStop, ...floor], clashes: [] }
      built.input.products = [mergedFixed(steroidStop)]
      return built
    }

    expect(score([ignored([])], { labels: null }).floor.missed).toEqual([])
    expect(score([ignored([{ id: 'pomade', status: 'open' }])], { labels: null }).floor.missed).toEqual(['hold-01'])
  })

  it('counts every case: one miss among several lists only the case that missed', () => {
    const result = score([floorCase({ id: 'hold-01' }), floorCase({ id: 'hold-02', floor: { ...steroidStop, group: 'conflicting' } as Fixed }), floorCase({ id: 'hold-03' })], { labels: null })

    expect(result.floor.missed).toEqual(['hold-02'])
    expect(result.floor.accuracy).toBeGreaterThan(0)
    expect(result.floor.accuracy).toBeLessThan(100)
  })

  it('fails the floor rule for a case whose merge failed, and has no products to check for it', () => {
    const result = score([floorCase({ state: 'merge-error', products: null })], { labels: null })

    expect(result.floor.missed).toEqual(['hold-01'])
    expect(result.stricterOnly.violations).toEqual([])
    expect(result.bar).toMatchObject({ status: 'fail', rules: ['floor'] })
  })

  it('has no accuracy to give when nothing was run', () => {
    const result = score([], { labels: null })

    expect(result.floor).toEqual({ accuracy: null, missed: [] })
    expect(result.cases).toBe(0)
  })
})

describe('scoreVerdictRun: the judge may only make a verdict stricter', () => {
  it('finds no violation when each floor-fixed entry comes out of the merge as the floor had it', () => {
    expect(score([floorCase()], { labels: null }).stricterOnly.violations).toEqual([])
  })

  it('names the case and entry when the merged group is not the floor\'s, and fails the floor rule', () => {
    const loosened = floorCase({ products: [{ ...mergedFixed(steroidStop), group: 'helping' }] })

    const result = score([loosened], { labels: null })

    expect(result.stricterOnly.violations).toEqual([{ caseId: 'hold-01', entryId: 'g' }])
    expect(result.floor.missed).toEqual(['hold-01'])
    expect(result.bar).toMatchObject({ status: 'fail', rules: ['floor'] })
  })

  it('names the case and entry when only the merged verdict is not the floor\'s', () => {
    const loosened = floorCase({ products: [{ ...mergedFixed(steroidStop), verdict: { kind: 'keep' } }] })

    expect(score([loosened], { labels: null }).stricterOnly.violations).toEqual([{ caseId: 'hold-01', entryId: 'g' }])
  })

  it('does not hold an open product to the invariant: the judge decides it', () => {
    expect(score([openCase('hold-01', batch('h', 2, 'helping', 'blocking'))]).stricterOnly.violations).toEqual([])
  })
})

describe('scoreVerdictRun: which products the fit is scored on', () => {
  it('scores a product only when it was expected open AND the floor left it open: one the floor fixed is a floor miss and leaves the fit', () => {
    const built = openCase('hold-01', batch('h', 3, 'helping'))
    // Expected open, but the floor decided it: a miss for the floor, and nothing to ask the judge.
    built.input.expect.entries.z = { outcome: 'open' }
    built.input.floor!.entries.push({ ...steroidStop, id: 'z' })
    built.input.products!.push(mergedFixed({ ...steroidStop, id: 'z' }))
    built.labels!.entries.z = { label: 'helping', alsoAcceptable: [], rationale: 'r' }

    const result = score([built])

    expect(result.fit).toEqual({ count: 3, total: 3, rate: 100 })
    expect(result.floor.missed).toEqual(['hold-01'])
  })

  it('does not score a product the floor left open that the case expected fixed: that is the floor\'s miss', () => {
    const built = openCase('hold-01', batch('h', 2, 'helping'))
    built.input.expect.entries.h1 = steroidExpected

    const result = score([built])

    expect(result.fit).toEqual({ count: 1, total: 1, rate: 100 })
    expect(result.floor.missed).toEqual(['hold-01'])
  })

  it('leaves a cut-off case out of everything: it is not a failed case', () => {
    const cut: Built = { input: { id: 'hold-02', state: 'cut-off', expect: { entries: { g: steroidExpected }, clashes: [] }, floor: null, requestSha256: null, fit: null, products: null }, labels: null }

    const result = score([good(), cut])

    expect(result.cases).toBe(1)
    expect(result.floor).toEqual({ accuracy: 100, missed: [] })
    expect(result.fit.total).toBe(20)
  })

  it('does not score the fit of a floor-only run', () => {
    const floorOnly = openCase('hold-01', [...batch('b', 8, 'blocking', null), ...batch('h', 12, 'helping', null)])
    floorOnly.input.fit = null

    const result = score([floorOnly], { floorOnly: true })

    expect(result.fit).toEqual({ count: 0, total: 0, rate: null })
    expect(result.harmful).toEqual({ count: 0, total: 0, rate: null })
  })
})

describe('scoreVerdictRun: labels that are out of date or missing', () => {
  it('lists a case whose request differs from the one its labels were made for, and leaves its fit out, but keeps its floor', () => {
    const stale = openCase('hold-02', batch('s', 4, 'helping', 'blocking'), { labelSha: OTHER_SHA })
    stale.input.expect.entries.s1 = { outcome: 'fixed', group: 'conflicting', verdict: 'drop' }

    const result = score([good(), stale])

    expect(result.needsRelabel).toEqual(['hold-02'])
    // Only the good case is scored: its 20 products; the stale case's 4 wrong answers do not count.
    expect(result.fit).toEqual({ count: 20, total: 20, rate: 100 })
    // The floor still looks at the stale case, and it has a miss.
    expect(result.floor.missed).toEqual(['hold-02'])
    expect(result.bar).toEqual({ status: 'fail', rules: ['floor'], notEvaluated: ['needs-relabel'] })
  })

  it('is not evaluated, with the case listed, when nothing else is wrong', () => {
    const result = score([good(), openCase('hold-02', batch('s', 4, 'helping'), { labelSha: OTHER_SHA })])

    expect(result.needsRelabel).toEqual(['hold-02'])
    expect(result.bar).toEqual({ status: 'not-evaluated', reasons: ['needs-relabel'] })
  })

  it('does not score the open products of a case that has no labels, and says there are none', () => {
    const result = score([good(), openCase('hold-02', batch('u', 4, 'helping', 'blocking'), { noLabels: true })])

    expect(result.fit).toEqual({ count: 20, total: 20, rate: 100 })
    expect(result.needsRelabel).toEqual([])
    expect(result.bar).toEqual({ status: 'not-evaluated', reasons: ['no-labels'] })
  })

  it('says there are no labels when the run had none', () => {
    const result = score([good()], { labels: null })

    expect(result.fit).toEqual({ count: 0, total: 0, rate: null })
    expect(result.bar.status).toBe('not-evaluated')
    expect((result.bar as { reasons: string[] }).reasons).toContain('no-labels')
  })

  it('needs no labels for a case with nothing open', () => {
    const settled = floorCase({ id: 'hold-02' })

    const result = score([good(), settled])

    expect(result.bar).toEqual({ status: 'pass' })
  })
})

describe('scoreVerdictRun: the bar when it cannot pass', () => {
  it('is not evaluated, with provisional-labels, when the labels have not been reviewed by a person', () => {
    const result = score([good()], { reviewed: false })

    expect(result.bar).toEqual({ status: 'not-evaluated', reasons: ['provisional-labels'] })
    expect(verdictBarExitCode(result.bar)).toBe(0)
  })

  it('is not evaluated, with partial-run, for a run that was cut short or limited', () => {
    const result = score([good()], { partial: true })

    expect(result.bar).toEqual({ status: 'not-evaluated', reasons: ['partial-run'] })
  })

  it('is not evaluated, with no-fit-run, for a floor-only run, and says nothing else even when labels were given', () => {
    const floorOnly = openCase('hold-01', batch('h', 3, 'helping', null))

    expect(score([floorOnly], { floorOnly: true, labels: null }).bar).toEqual({ status: 'not-evaluated', reasons: ['no-fit-run'] })
    expect(score([floorOnly], { floorOnly: true }).bar).toEqual({ status: 'not-evaluated', reasons: ['no-fit-run'] })
  })

  it.each([
    ['main with 29', 'main', 29, ['too-few-blocking']],
    ['main with 30', 'main', 30, []],
    ['holdout with 7', 'holdout', 7, ['too-few-blocking']],
    ['holdout with 8', 'holdout', 8, []],
  ] as const)('needs enough open products labelled blocking to trust the harmful rate: %s', (_what, set, blocking, reasons) => {
    // The blocking products are spread over two cases, to show that they are pooled.
    const half = Math.floor(blocking / 2)
    const built = [openCase(set === 'main' ? 'main-01' : 'hold-01', [...batch('a', half, 'blocking'), ...batch('h', 12, 'helping')]), openCase(set === 'main' ? 'main-02' : 'hold-02', batch('b', blocking - half, 'blocking'))]

    const result = score(built, { set })

    expect(result.harmful.total).toBe(blocking)
    expect(result.bar).toEqual(reasons.length === 0 ? { status: 'pass' } : { status: 'not-evaluated', reasons })
  })

  it('counts the blocking products of the cases that are scored, not of one whose labels are out of date', () => {
    const result = score([openCase('hold-01', [...batch('b', 4, 'blocking'), ...batch('h', 12, 'helping')]), openCase('hold-02', batch('s', 8, 'blocking'), { labelSha: OTHER_SHA })])

    expect(result.harmful.total).toBe(4)
    expect(result.bar).toEqual({ status: 'not-evaluated', reasons: ['needs-relabel', 'too-few-blocking'] })
  })

  it('lists every reason there is, once each, in a fixed order', () => {
    const scored = openCase('hold-01', [...batch('b', 1, 'blocking'), ...batch('h', 3, 'helping')])
    const stale = openCase('hold-02', batch('s', 2, 'helping'), { labelSha: OTHER_SHA })
    const unlabelled = openCase('hold-03', batch('u', 2, 'helping'), { noLabels: true })

    const result = score([scored, stale, unlabelled], { partial: true, reviewed: false })

    expect(result.bar).toEqual({ status: 'not-evaluated', reasons: ['partial-run', 'no-labels', 'needs-relabel', 'provisional-labels', 'too-few-blocking'] })
  })

  it('fails on a rule that is below its bar whatever else is missing: a trial, provisional labels and too few blocking products do not excuse it', () => {
    const wrong = openCase('hold-01', [...batch('b', 2, 'blocking'), ...batch('h', 2, 'helping', 'blocking')])

    const result = score([wrong], { partial: true, reviewed: false })

    expect(result.fit.rate).toBe(50)
    expect(result.bar).toEqual({ status: 'fail', rules: ['fit-agreement'], notEvaluated: ['partial-run', 'provisional-labels', 'too-few-blocking'] })
    expect(verdictBarExitCode(result.bar)).toBe(1)
  })

  it('names every rule that failed, in the order floor, fit-agreement, harmful', () => {
    const bad = openCase('hold-01', [...batch('x', 3, 'blocking', 'helping'), ...batch('b', 5, 'blocking'), ...batch('h', 2, 'helping')])
    bad.input.expect.entries.h1 = steroidExpected

    const result = score([bad])

    expect(result.bar).toEqual({ status: 'fail', rules: ['floor', 'fit-agreement', 'harmful'], notEvaluated: [] })
  })
})

describe('the bar line and the exit code', () => {
  it('prints Bar: PASS for a pass, and exits 0', () => {
    expect(formatVerdictBarLine({ status: 'pass' })).toBe('Bar: PASS')
    expect(verdictBarExitCode({ status: 'pass' })).toBe(0)
  })

  it('prints the rules that failed, then what could not be evaluated, for a fail, and exits 1', () => {
    const bar = { status: 'fail', rules: ['floor', 'harmful'], notEvaluated: ['partial-run', 'no-labels'] } as const

    expect(formatVerdictBarLine(bar)).toBe('Bar: FAIL (floor, harmful; not evaluated: partial-run, no-labels)')
    expect(formatVerdictBarLine({ status: 'fail', rules: ['fit-agreement'], notEvaluated: [] })).toBe('Bar: FAIL (fit-agreement)')
    expect(verdictBarExitCode(bar)).toBe(1)
  })

  it('prints the reasons for a run that was not evaluated, and exits 0: a trial is not a failure', () => {
    const bar = { status: 'not-evaluated', reasons: ['provisional-labels', 'too-few-blocking'] } as const

    expect(formatVerdictBarLine(bar)).toBe('Bar: not evaluated (provisional-labels, too-few-blocking)')
    expect(verdictBarExitCode(bar)).toBe(0)
  })
})
