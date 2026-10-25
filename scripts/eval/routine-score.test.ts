import { describe, expect, it } from 'vitest'
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { GateFailure } from '../../src/modules/routines/routines.types'
import { barExitCode, compare, formatBarLine, type JudgeComparison, judgeComparisonOf, scoreRoutineCase, scoreRun, selectJudge, type RoutineCaseInput } from './routine-score'
import { routineOf } from './routine.fixture'

// The pure half of `npm run eval:routine` (routine-run.ts is the orchestration): a case's gate result, its picks against the labels, and the run's
// percentages, bar and comparison. Everything here is a fixture; nothing calls the API. Expected numbers are worked out by hand from the fixtures in each
// test's comment, never by recomputing with the scorer's own rules. Percentages are exact (not rounded), so a boundary is exact too: 17 of 20 is 85.

type Labels = NonNullable<RoutineCaseInput['labels']>
type GapLabel = Labels[RoutineStep] & object

const label = (candidates: string[], best: string, acceptable: string[] = []): GapLabel => ({ candidates, best, acceptable })
const WORDING: GateFailure = { gate: 'wording', step: 'cleanse' }
const JUDGED = { picksAgreed: 4, picksJudged: 4, fit: 5, simplicity: 5, words: 5 }

/**
 * A case whose routine passes every gate and picks A for its one scored gap (cleanse: A or B), where A is labelled best.
 * Override what a test is about.
 */
const input = (id: string, over: Partial<RoutineCaseInput> = {}): RoutineCaseInput => ({
  id,
  gapCodes: { cleanse: ['A', 'B'] },
  routine: routineOf({ cleanse: 'A' }),
  writerError: null,
  failures: [],
  labels: { cleanse: label(['A', 'B'], 'A', ['B']) },
  judge: JUDGED,
  costMicros: 0,
  ...over,
})

/** `n` such cases with ids case-1..case-n. */
const perfect = (n = 1, over: (i: number) => Partial<RoutineCaseInput> = () => ({})): RoutineCaseInput[] => Array.from({ length: n }, (_, i) => input(`case-${i + 1}`, over(i)))

/** A pick of B, which the default labels do not call best or acceptable: `acceptable` is empty here. */
const WRONG: Partial<RoutineCaseInput> = { routine: routineOf({ cleanse: 'B' }), labels: { cleanse: label(['A', 'B'], 'A') } }

const holdout = (inputs: RoutineCaseInput[], partial = false) => scoreRun(inputs, { set: 'holdout', partial })

describe('scoreRoutineCase: the gates', () => {
  it('passes a routine with no gate failures', () => {
    expect(scoreRoutineCase(input('a')).gatesPassed).toBe(true)
  })

  it('fails a routine with any gate failure', () => {
    expect(scoreRoutineCase(input('a', { failures: [{ gate: 'frequency', step: 'treat' }] })).gatesPassed).toBe(false)
  })

  it('counts a writer error as a failed routine, though it has no failures listed', () => {
    const score = scoreRoutineCase(input('a', { routine: null, writerError: 'AnthropicRequestError', failures: [] }))

    expect(score.gatesPassed).toBe(false)
  })

  it('counts only the wording failures as forbidden wording', () => {
    const failures: GateFailure[] = [WORDING, { gate: 'wording', step: null }, { gate: 'frequency', step: 'treat' }, { gate: 'grounding', step: 'cleanse' }]

    expect(scoreRoutineCase(input('a', { failures })).forbiddenWording).toBe(2)
    expect(scoreRoutineCase(input('b')).forbiddenWording).toBe(0)
  })
})

describe('scoreRun: gates and forbidden wording', () => {
  it('reports the share of cases whose routine passed every gate, a writer error counting as a failure', () => {
    // 4 cases: one clean, one with a parse failure, one with a wording failure, one writer error. 1 of 4 passes.
    const inputs = [
      input('ok'),
      input('parse', { failures: [{ gate: 'parse', step: null }] }),
      input('words', { failures: [WORDING] }),
      input('error', { routine: null, writerError: 'AnthropicRequestError' }),
    ]

    expect(scoreRun(inputs, { set: 'dev', partial: false }).gatesPassed).toBe(25)
  })

  it('sums the wording failures over the run (the wording case above has 1, this one 3)', () => {
    const inputs = [input('a', { failures: [WORDING] }), input('b', { failures: [WORDING, { gate: 'wording', step: null }] }), input('c')]

    expect(scoreRun(inputs, { set: 'dev', partial: false }).forbiddenWording).toBe(3)
  })

  it('sums what the cases cost', () => {
    // 120000 + 80000 + 0
    const inputs = [input('a', { costMicros: 120_000 }), input('b', { costMicros: 80_000 }), input('c')]

    expect(scoreRun(inputs, { set: 'dev', partial: false }).costMicros).toBe(200_000)
  })
})

describe('scoreRun: the right product and the exactly best product', () => {
  it('counts a pick that is labelled best or acceptable as right, and only one labelled best as exactly best', () => {
    // case 1: cleanse picks B (labelled not), treat picks D (acceptable) -> 2 scored gaps, 1 right, 0 best.
    //         protect has one candidate, so it is not scored.
    // case 2: cleanse picks A (best) -> 1 scored gap, 1 right, 1 best.
    // Run: 3 scored, 2 right (66.67%), 1 best (33.33%).
    const one = input('one', {
      gapCodes: { cleanse: ['A', 'B'], treat: ['C', 'D', 'E'], protect: ['P'] },
      routine: routineOf({ cleanse: 'B', treat: 'D', protect: 'P' }),
      labels: { cleanse: label(['A', 'B'], 'A'), treat: label(['C', 'D', 'E'], 'C', ['D']), protect: label(['P'], 'P') },
    })
    const two = input('two')

    const run = holdout([one, two])

    expect(run.rightProduct).toBeCloseTo(66.667, 2)
    expect(run.exactlyBest).toBeCloseTo(33.333, 2)
    expect(scoreRoutineCase(one).picks).toBe('wrong')
    expect(scoreRoutineCase(two).picks).toBe('right')
  })

  it('does not score a gap with a single candidate', () => {
    const only = input('only', { gapCodes: { protect: ['P'] }, routine: routineOf({ protect: 'P' }), labels: { protect: label(['P'], 'P') } })

    const run = holdout([only])

    expect(run.rightProduct).toBeNull()
    expect(run.exactlyBest).toBeNull()
    expect(scoreRoutineCase(only).picks).toBe('unscored')
  })

  it('scores the picks of a routine that failed the gates as not right, even when the pick is labelled best', () => {
    // The routine picks A, which is best, but it broke the order gate: 1 scored gap, 0 right.
    const failed = input('failed', { failures: [{ gate: 'order', step: 'protect' }] })

    const run = holdout([failed])

    expect(run.rightProduct).toBe(0)
    expect(run.exactlyBest).toBe(0)
    expect(scoreRoutineCase(failed).picks).toBe('wrong')
  })

  it('scores the labelled gaps of a case whose writer errored as not right', () => {
    // case 1 picks A (best): 1 of 1. case 2 errored: its 1 labelled gap counts, not right. 1 of 2 right, 1 of 2 best.
    const errored = input('errored', { routine: null, writerError: 'AnthropicRequestError' })

    const run = holdout([input('fine'), errored])

    expect(run.rightProduct).toBe(50)
    expect(run.exactlyBest).toBe(50)
  })

  it('leaves a case with no labels out of the percentages', () => {
    // case 1 is right (1 of 1). case 2 picks a wrong product but has no labels, so it is not scored: 100%.
    const unlabelled = input('unlabelled', { ...WRONG, labels: null })

    const run = holdout([input('labelled'), unlabelled])

    expect(run.rightProduct).toBe(100)
    expect(scoreRoutineCase(unlabelled).picks).toBe('unscored')
  })

  it('leaves out of the percentages a gap whose candidates have no labels and does not call it needs-relabel', () => {
    // The gap with zero candidates is "use what you have": nothing to pick, nothing to label.
    const empty = input('empty', { gapCodes: { cleanse: [] }, routine: routineOf({}), labels: null })

    const run = holdout([empty])

    expect(run.rightProduct).toBeNull()
    expect(run.needsRelabel).toEqual([])
  })
})

describe('scoreRun: needs re-label', () => {
  // The labels were made on cleanse [A, B]. Each case below has a skeleton whose candidates no longer match, and picks a wrong product, so scoring it would
  // pull the right-product percentage down: it is left out of the percentage and its id is listed instead.
  const stale: [string, Partial<RoutineCaseInput>][] = [
    ['a candidate was added', { gapCodes: { cleanse: ['A', 'B', 'C'] } }],
    ['a candidate was dropped', { gapCodes: { cleanse: ['A'] } }],
    ['a candidate was swapped', { gapCodes: { cleanse: ['A', 'C'] } }],
    ['the step is no longer a gap', { gapCodes: {} }],
    ['a new step has candidates the labels never covered', { gapCodes: { cleanse: ['A', 'B'], treat: ['X', 'Y'] } }],
  ]

  it.each(stale)('lists the case and leaves it unscored when %s', (_why, over) => {
    const changed = input('changed', { ...WRONG, ...over })

    const run = holdout([input('fine'), changed])

    expect(run.needsRelabel).toEqual(['changed'])
    expect(run.rightProduct).toBe(100)
    expect(scoreRoutineCase(changed).needsRelabel).toBe(true)
    expect(scoreRoutineCase(changed).picks).toBe('unscored')
  })

  it('does not list a case whose gaps with candidates are the ones its labels were made on', () => {
    // treat has no candidates now and had none then: it is not in the labels and does not make the case stale.
    const same = input('same', { gapCodes: { cleanse: ['A', 'B'], treat: [] } })

    expect(holdout([same]).needsRelabel).toEqual([])
  })

  it('lists every such case, in the order the run had them', () => {
    const run = holdout([input('a', { gapCodes: { cleanse: ['A'] } }), input('ok'), input('b', { gapCodes: { cleanse: ['B'] } })])

    expect(run.needsRelabel).toEqual(['a', 'b'])
  })
})

describe('scoreRun: the judge, which D1 does not have', () => {
  it('has no judge agreement, fit, simplicity or words when no case was judged', () => {
    const run = holdout(perfect(2, () => ({ judge: null })))

    expect(run.judgeAgreement).toBeNull()
    expect(run.fit).toBeNull()
    expect(run.simplicity).toBeNull()
    expect(run.words).toBeNull()
  })

  it('pools agreement over all the picks judged, and averages fit, simplicity and words over the cases judged', () => {
    // 3 agreed of 4 judged + 1 of 1 = 4 of 5 = 80%. fit (4 + 3) / 2 = 3.5, simplicity (5 + 2) / 2 = 3.5, words (1 + 2) / 2 = 1.5.
    const inputs = [
      input('a', { judge: { picksAgreed: 3, picksJudged: 4, fit: 4, simplicity: 5, words: 1 } }),
      input('b', { judge: { picksAgreed: 1, picksJudged: 1, fit: 3, simplicity: 2, words: 2 } }),
    ]

    const run = holdout(inputs)

    expect(run.judgeAgreement).toBe(80)
    expect(run.fit).toBe(3.5)
    expect(run.simplicity).toBe(3.5)
    expect(run.words).toBe(1.5)
  })
})

describe('the bar: holdout only, and never a pass on missing data', () => {
  it('passes a full holdout run with every input and every rule holding', () => {
    expect(holdout(perfect(20)).bar).toEqual({ status: 'pass' })
  })

  it.each([
    [20, 17, 'pass'],
    [19, 16, 'fail'],
  ] as const)('judges right product at its threshold of 85%%: %i scored gaps with %i right is %s', (gaps, right, expected) => {
    // 17 of 20 is exactly 85 and passes; 16 of 19 is 84.2 and fails.
    const run = holdout(perfect(gaps, (i) => (i < right ? {} : WRONG)))

    if (expected === 'pass') expect(run.bar).toEqual({ status: 'pass' })
    else expect(run.bar).toEqual({ status: 'fail', rules: ['right-product'], notEvaluated: [] })
  })

  it('fails the gates rule when one routine in 21 breaks a gate (the rest are right: 20 of 21 picks are right, above 85)', () => {
    const run = holdout(perfect(21, (i) => (i === 0 ? { failures: [{ gate: 'frequency', step: 'treat' }] } : {})))

    expect(run.bar).toEqual({ status: 'fail', rules: ['gates'], notEvaluated: [] })
  })

  it('fails on a single forbidden wording, which also breaks the gates', () => {
    const run = holdout(perfect(20, (i) => (i === 0 ? { failures: [WORDING] } : {})))

    expect(run.forbiddenWording).toBe(1)
    expect(run.bar).toEqual({ status: 'fail', rules: ['gates', 'forbidden-wording'], notEvaluated: [] })
  })

  it.each([
    [{ picksAgreed: 4, picksJudged: 5 }, 'pass'],
    [{ picksAgreed: 19, picksJudged: 24 }, 'fail'],
  ] as const)('judges agreement at its threshold of 80%%: %j is %s', (agreement, expected) => {
    // 4 of 5 is exactly 80 and passes; 19 of 24 is 79.2 and fails.
    const run = holdout(perfect(1, () => ({ judge: { ...JUDGED, ...agreement } })))

    if (expected === 'pass') expect(run.bar).toEqual({ status: 'pass' })
    else expect(run.bar).toEqual({ status: 'fail', rules: ['judge-agreement'], notEvaluated: [] })
  })

  it('lists every failed rule, in the order gates, right-product, judge-agreement, forbidden-wording', () => {
    // All 20 cases break the order gate and pick a wrong product, agree with the judge on 1 of 5, and one has a wording failure.
    const run = holdout(perfect(20, (i) => ({ ...WRONG, failures: i === 0 ? [WORDING] : [{ gate: 'order', step: null }], judge: { ...JUDGED, picksAgreed: 1, picksJudged: 5 } })))

    expect(run.bar).toEqual({ status: 'fail', rules: ['gates', 'right-product', 'judge-agreement', 'forbidden-wording'], notEvaluated: [] })
  })

  it('is not evaluated for a partial run, however good the cases that finished were', () => {
    const run = holdout(perfect(20), true)

    expect(run.bar.status).toBe('not-evaluated')
    expect(run.bar).toEqual({ status: 'not-evaluated', reasons: ['partial-run'] })
  })

  it('is not evaluated when no case was judged: D1 has no judge, so a D1 run can never pass', () => {
    const run = holdout(perfect(20, () => ({ judge: null })))

    expect(run.bar).toEqual({ status: 'not-evaluated', reasons: ['no-judge'] })
  })

  it('is not evaluated when a case that has candidates to pick between has no labels', () => {
    const run = holdout(perfect(20, (i) => (i === 3 ? { labels: null } : {})))

    expect(run.bar).toEqual({ status: 'not-evaluated', reasons: ['no-labels'] })
  })

  it('is not evaluated when a case needs re-labelling, because the percentages would leave it out', () => {
    const run = holdout(perfect(20, (i) => (i === 3 ? { gapCodes: { cleanse: ['A', 'B', 'C'] } } : {})))

    expect(run.bar).toEqual({ status: 'not-evaluated', reasons: ['needs-relabel'] })
  })

  it('is never evaluated for the dev set, which is for tuning', () => {
    const run = scoreRun(perfect(20), { set: 'dev', partial: false })

    expect(run.bar).toEqual({ status: 'not-evaluated', reasons: ['dev-set'] })
  })

  it('gives every reason that applies: a D1 trial with no labels, no judge and a stop at the cap', () => {
    const run = holdout(perfect(5, () => ({ labels: null, judge: null })), true)

    expect(run.bar.status).toBe('not-evaluated')
    expect([...(run.bar as { reasons: string[] }).reasons].sort()).toEqual(['no-judge', 'no-labels', 'partial-run'])
  })

  // A rule that CAN be evaluated and fails is never hidden by missing data: the bar is FAIL, and what could not be evaluated is listed beside the rules on
  // the same object as `notEvaluated`. Gates and forbidden wording are always evaluable. Right product is evaluable when no case lacks labels and none needs
  // re-labelling; judge agreement when a judge result exists. A partial run does not stop any of them (a trial can still fail). Only when nothing evaluable
  // fails and something is missing is the bar `not-evaluated`, and the dev set is always `not-evaluated`.
  it('fails on gates even when the judge is missing, and lists the missing judge beside the failure', () => {
    const run = holdout(perfect(21, (i) => ({ judge: null, ...(i === 0 ? { failures: [{ gate: 'frequency' as const, step: 'treat' as const }] } : {}) })))

    expect(run.gatesPassed).toBeCloseTo(95.238, 2)
    expect(run.bar).toEqual({ status: 'fail', rules: ['gates'], notEvaluated: ['no-judge'] })
  })

  it('fails on a forbidden wording even when the run is partial and has no labels and no judge', () => {
    const run = holdout(perfect(5, (i) => ({ labels: null, judge: null, ...(i === 0 ? { failures: [WORDING] } : {}) })), true)

    expect(run.bar.status).toBe('fail')
    const bar = run.bar as { rules: string[]; notEvaluated: string[] }
    expect(bar.rules).toEqual(['gates', 'forbidden-wording'])
    expect([...bar.notEvaluated].sort()).toEqual(['no-judge', 'no-labels', 'partial-run'])
  })

  it('fails on a gate failure in a partial run, listing the partial run beside it', () => {
    const run = holdout(perfect(21, (i) => (i === 0 ? { failures: [{ gate: 'order', step: null }] } : {})), true)

    expect(run.bar).toEqual({ status: 'fail', rules: ['gates'], notEvaluated: ['partial-run'] })
  })

  it('fails on the right product with labels complete and no judge', () => {
    const run = holdout(perfect(19, (i) => (i < 16 ? { judge: null } : { ...WRONG, judge: null })))

    expect(run.bar).toEqual({ status: 'fail', rules: ['right-product'], notEvaluated: ['no-judge'] })
  })

  it('fails on judge agreement with no labels, listing the missing labels beside it', () => {
    const run = holdout(perfect(1, () => ({ labels: null, judge: { ...JUDGED, picksAgreed: 19, picksJudged: 24 } })))

    expect(run.bar).toEqual({ status: 'fail', rules: ['judge-agreement'], notEvaluated: ['no-labels'] })
  })

  it('does not fail the right product it cannot evaluate: with no labels, a wrong pick is not counted against the run', () => {
    const run = holdout(perfect(20, () => ({ ...WRONG, labels: null })))

    expect(run.bar).toEqual({ status: 'not-evaluated', reasons: ['no-labels'] })
  })

  it('does not fail the dev set, whatever it did: the bar is for the holdout', () => {
    const run = scoreRun(perfect(21, (i) => (i === 0 ? { failures: [WORDING] } : {})), { set: 'dev', partial: false })

    expect(run.bar).toEqual({ status: 'not-evaluated', reasons: ['dev-set'] })
  })

  it('does not ask for a judge, or labels, of a case with nothing to judge or label: a writer error, and a case with no candidates', () => {
    // 19 full cases and one writer error. The error has no routine to judge, so it does not make the judge "missing", and the bar is evaluated: gates are
    // 19 of 20 = 95% and fail; right product is 19 of 20 = 95% (the errored case's labelled gap counts as not right) and holds.
    const run = holdout([...perfect(19), input('errored', { routine: null, writerError: 'AnthropicRequestError', judge: null })])
    expect(run.bar).toEqual({ status: 'fail', rules: ['gates'], notEvaluated: [] })

    // A case whose gaps have no candidates needs no labels.
    const nothing = input('nothing', { gapCodes: { cleanse: [] }, routine: routineOf({}), labels: null })
    expect(holdout([...perfect(19), nothing]).bar).toEqual({ status: 'pass' })
  })
})

describe('the bar: one precedence rule', () => {
  it('is not evaluated, with no-scored-gaps, when the labels are all there and current but no gap has 2 candidates to pick between', () => {
    const only = (id: string) => input(id, { gapCodes: { protect: ['P'] }, routine: routineOf({ protect: 'P' }), labels: { protect: label(['P'], 'P') } })

    const run = holdout([only('a'), only('b')])

    expect(run.rightProduct).toBeNull()
    expect(run.bar).toEqual({ status: 'not-evaluated', reasons: ['no-scored-gaps'] })
  })

  it('does not say no-scored-gaps when the reason is missing or stale labels', () => {
    expect(holdout(perfect(2, () => ({ labels: null, gapCodes: { cleanse: ['A', 'B'] } }))).bar).toEqual({ status: 'not-evaluated', reasons: ['no-labels'] })
  })

  it('fails on a gate whatever else is missing, no-scored-gaps included', () => {
    const run = holdout([input('a', { gapCodes: { protect: ['P'] }, routine: routineOf({ protect: 'P' }), labels: { protect: label(['P'], 'P') }, failures: [{ gate: 'order', step: null }] })])

    expect(run.bar).toEqual({ status: 'fail', rules: ['gates'], notEvaluated: ['no-scored-gaps'] })
  })

  it('does not fail the right product when one case lacks labels, though the other cases picked wrong: the percentage would leave that case out', () => {
    const run = holdout([input('labelled', WRONG), input('unlabelled', { labels: null })])

    expect(run.bar).toEqual({ status: 'not-evaluated', reasons: ['no-labels'] })
  })
})

describe('formatBarLine and barExitCode', () => {
  it('prints the last line of the run for each outcome', () => {
    expect(formatBarLine({ status: 'pass' })).toBe('Bar: PASS')
    expect(formatBarLine({ status: 'fail', rules: ['gates', 'forbidden-wording'], notEvaluated: [] })).toBe('Bar: FAIL (gates, forbidden-wording)')
    expect(formatBarLine({ status: 'not-evaluated', reasons: ['partial-run', 'no-judge'] })).toBe('Bar: not evaluated (partial-run, no-judge)')
  })

  it('shows what could not be evaluated beside the rules of a failure', () => {
    expect(formatBarLine({ status: 'fail', rules: ['gates', 'right-product'], notEvaluated: ['partial-run', 'no-judge'] })).toBe('Bar: FAIL (gates, right-product; not evaluated: partial-run, no-judge)')
  })

  it('exits 0 for a pass, 1 for a fail (whatever else is missing) and 0 for a run that was not evaluated (a trial)', () => {
    expect(barExitCode({ status: 'pass' })).toBe(0)
    expect(barExitCode({ status: 'fail', rules: ['gates'], notEvaluated: [] })).toBe(1)
    expect(barExitCode({ status: 'fail', rules: ['gates'], notEvaluated: ['no-judge'] })).toBe(1)
    expect(barExitCode({ status: 'not-evaluated', reasons: ['no-judge'] })).toBe(0)
  })
})

describe('compare', () => {
  const scores = (over: Partial<Parameters<typeof compare>[0]> = {}) => ({ rightProduct: 80, fit: 4, simplicity: 4, words: 4, ...over })

  it('is better when the right product went up, and says that decided it', () => {
    expect(compare(scores(), scores({ rightProduct: 85 }))).toEqual({ verdict: 'better', decidedBy: 'rightProduct' })
  })

  it('is worse when the right product went down, whatever the other measures did', () => {
    expect(compare(scores(), scores({ rightProduct: 75, fit: 5, simplicity: 5, words: 5 }))).toEqual({ verdict: 'worse', decidedBy: 'rightProduct' })
  })

  it('goes on to fit when the right product is the same', () => {
    expect(compare(scores(), scores({ fit: 4.5 }))).toEqual({ verdict: 'better', decidedBy: 'fit' })
    expect(compare(scores(), scores({ fit: 3.5, simplicity: 5 }))).toEqual({ verdict: 'worse', decidedBy: 'fit' })
  })

  it('goes on to simplicity, then words', () => {
    expect(compare(scores(), scores({ simplicity: 3 }))).toEqual({ verdict: 'worse', decidedBy: 'simplicity' })
    expect(compare(scores(), scores({ words: 4.5 }))).toEqual({ verdict: 'better', decidedBy: 'words' })
  })

  it('is the same, decided by nothing, when every measure is equal', () => {
    expect(compare(scores(), scores())).toEqual({ verdict: 'same', decidedBy: null })
  })

  it('skips a measure that is null on either side', () => {
    // D1 reports have no fit; the right product decides, and when it is equal there is nothing else to decide on.
    const noJudge = { rightProduct: 80, fit: null, simplicity: null, words: null }
    expect(compare(noJudge, { ...noJudge, rightProduct: 90 })).toEqual({ verdict: 'better', decidedBy: 'rightProduct' })
    expect(compare(noJudge, noJudge)).toEqual({ verdict: 'same', decidedBy: null })
    // fit is null before and 5 now: it is skipped, so simplicity decides.
    expect(compare(scores({ fit: null }), scores({ fit: 5, simplicity: 3 }))).toEqual({ verdict: 'worse', decidedBy: 'simplicity' })
    // The right product is null now (nothing was scored): it is skipped, and fit decides.
    expect(compare(scores(), scores({ rightProduct: null, fit: 5 }))).toEqual({ verdict: 'better', decidedBy: 'fit' })
  })
})

// --- selectJudge (#152, PR 4c) -------------------------------------------------------------------------------------------------------------------
// The run judges every routine with each judge on the list and compares them. The one that feeds the bar is the CHEAPEST judge whose agreement with the labels is at
// least 80% (80 itself counts: the bar's own rule fails only below 80). When none reaches 80, the judge with the highest agreement; a judge with no agreement
// (it produced no result) is neither trusted nor highest. With no judge that produced results: null. It returns the whole comparison row, because the run
// feeds that row's agreement, fit, simplicity and words to scoreRun.

const judgeRow = (name: string, agreement: number | null, costMicros: number, over: Partial<JudgeComparison> = {}): JudgeComparison => ({
  name,
  model: `claude-${name}-5-5`,
  agreement,
  fit: agreement === null ? null : 4,
  simplicity: agreement === null ? null : 4,
  words: agreement === null ? null : 4,
  costMicros,
  agreementPerDollar: agreement === null || costMicros === 0 ? null : agreement / (costMicros / 1_000_000),
  // Changed for the follow-up to PR D2: every row says whether its judge's model made the labels (see judgeComparisonOf below). Human labels, and every test above, are false.
  selfAgreement: false,
  ...over,
})

describe('selectJudge: the cheapest judge that is trusted', () => {
  it('picks the cheaper of two judges that both reach 80% (85 at 4000 micros beats 95 at 18000), whichever order they are listed in', () => {
    const haiku = judgeRow('haiku', 85, 4000)
    const opus = judgeRow('opus', 95, 18000)

    expect(selectJudge([haiku, opus])?.name).toBe('haiku')
    expect(selectJudge([opus, haiku])?.name).toBe('haiku')
  })

  it('picks the dearer judge when only it reaches 80% (haiku 75 is not trusted, opus 90 is)', () => {
    expect(selectJudge([judgeRow('haiku', 75, 4000), judgeRow('opus', 90, 18000)])?.name).toBe('opus')
    expect(selectJudge([judgeRow('opus', 90, 18000), judgeRow('haiku', 75, 4000)])?.name).toBe('opus')
  })

  it('counts exactly 80% as trusted: the boundary, with 79.99 on the other side of it', () => {
    // 80 at the lower cost is trusted and wins over 100 at the higher cost.
    expect(selectJudge([judgeRow('haiku', 80, 4000), judgeRow('opus', 100, 18000)])?.name).toBe('haiku')
    // 79.99 is not trusted: the dearer judge that is trusted (exactly 80) wins.
    expect(selectJudge([judgeRow('haiku', 79.99, 4000), judgeRow('opus', 80, 18000)])?.name).toBe('opus')
  })

  it('returns the whole comparison row of the judge it picked, so the run can feed its agreement, fit, simplicity and words to the bar', () => {
    const haiku = judgeRow('haiku', 85, 4000, { fit: 3.5, simplicity: 4.5, words: 2.5 })

    expect(selectJudge([haiku, judgeRow('opus', 95, 18000)])).toEqual(haiku)
  })

  it('picks the only judge there is when it is trusted, and when it is not', () => {
    expect(selectJudge([judgeRow('opus', 90, 18000)])?.name).toBe('opus')
    expect(selectJudge([judgeRow('opus', 40, 18000)])?.name).toBe('opus')
  })
})

describe('selectJudge: when neither judge is trusted, the highest agreement', () => {
  it('picks the judge with the higher agreement, though it costs more (haiku 70 at 4000, opus 75 at 18000)', () => {
    expect(selectJudge([judgeRow('haiku', 70, 4000), judgeRow('opus', 75, 18000)])?.name).toBe('opus')
    expect(selectJudge([judgeRow('haiku', 79.99, 4000), judgeRow('opus', 60, 18000)])?.name).toBe('haiku')
  })
})

describe('selectJudge: ties and missing results', () => {
  it('picks the higher agreement when the two trusted judges cost the same (90 beats 85 at 5000 micros each)', () => {
    expect(selectJudge([judgeRow('haiku', 85, 5000), judgeRow('opus', 90, 5000)])?.name).toBe('opus')
    expect(selectJudge([judgeRow('opus', 90, 5000), judgeRow('haiku', 85, 5000)])?.name).toBe('opus')
  })

  it('picks the higher agreement when neither is trusted and they cost the same', () => {
    expect(selectJudge([judgeRow('haiku', 50, 5000), judgeRow('opus', 60, 5000)])?.name).toBe('opus')
  })

  it('returns null when no judge produced results: an empty list, and judges whose agreement is null', () => {
    expect(selectJudge([])).toBeNull()
    expect(selectJudge([judgeRow('haiku', null, 4000), judgeRow('opus', null, 18000)])).toBeNull()
  })

  it('never picks a judge with no result, however cheap: it is neither trusted nor the highest', () => {
    // The failed judge is the cheapest (0 micros) and would win a plain sort by cost.
    expect(selectJudge([judgeRow('haiku', null, 0), judgeRow('opus', 85, 18000)])?.name).toBe('opus')
    expect(selectJudge([judgeRow('haiku', null, 0), judgeRow('opus', 40, 18000)])?.name).toBe('opus')
    expect(selectJudge([judgeRow('opus', 40, 18000), judgeRow('haiku', null, 0)])?.name).toBe('opus')
  })
})

// --- a judge never counts agreement with labels from its own model (#152, follow-up to PR D2) -----------------------------------------------------------
// Opus can make the labels (`npm run eval:routine:auto-label`), and the owner's rule is that a model never grades its own work. So a judge whose MODEL made the labels is
// reported but does not count toward choosing the judge: its row says `selfAgreement: true`, and selectJudge leaves it out. The labels' maker comes from the label set
// (`labelledBy`: a model id, or 'human' for labels from a sheet, which no judge is).
//   judgeComparisonOf(judge, results, costMicros, labelledBy?: string): JudgeComparison   (the new last argument; a row gets `selfAgreement: boolean`, true exactly when judge.model === labelledBy)
//   selectJudge(rows): reads the row's flag, so its signature is as it was
//   scoreRun(inputs, { set, partial, judgeSelfLabelled?: boolean }): when true, the bar's reason for having no judge is 'judge-self-labelled' in place of 'no-judge'

const RESULT = (agreed: number, judged: number) => ({ picksAgreed: agreed, picksJudged: judged, fit: 4, simplicity: 5, words: 3 })

describe('judgeComparisonOf: self-agreement', () => {
  const opus = { name: 'opus', model: 'claude-opus-5-5' }
  const haiku = { name: 'haiku', model: 'claude-haiku-5-5' }

  it('marks a judge whose model made the labels, and still reports its agreement and cost', () => {
    // 3 of 4 + 1 of 1 = 4 of 5 = 80%.
    const row = judgeComparisonOf(opus, [RESULT(3, 4), RESULT(1, 1)], 18000, 'claude-opus-5-5')

    expect(row.selfAgreement).toBe(true)
    expect(row).toMatchObject({ name: 'opus', model: 'claude-opus-5-5', agreement: 80, fit: 4, simplicity: 5, words: 3, costMicros: 18000 })
  })

  it('does not mark a judge of another model than the one that made the labels', () => {
    expect(judgeComparisonOf(haiku, [RESULT(4, 4)], 4000, 'claude-opus-5-5').selfAgreement).toBe(false)
  })

  it('compares the model, not the name: a judge named for one model that runs on another is judged by what it runs on', () => {
    expect(judgeComparisonOf({ name: 'opus', model: 'claude-haiku-5-5' }, [RESULT(4, 4)], 4000, 'claude-opus-5-5').selfAgreement).toBe(false)
    expect(judgeComparisonOf({ name: 'haiku', model: 'claude-opus-5-5' }, [RESULT(4, 4)], 4000, 'claude-opus-5-5').selfAgreement).toBe(true)
  })

  it.each([['human'], [undefined]])('never marks a judge when the labels were made by %s', (labelledBy) => {
    expect(judgeComparisonOf(opus, [RESULT(4, 4)], 18000, labelledBy).selfAgreement).toBe(false)
    expect(judgeComparisonOf(haiku, [RESULT(4, 4)], 4000, labelledBy).selfAgreement).toBe(false)
  })

  it('marks a self-agreeing judge that produced nothing, too', () => {
    expect(judgeComparisonOf(opus, [null, null], 900, 'claude-opus-5-5')).toMatchObject({ selfAgreement: true, agreement: null })
  })
})

describe('selectJudge: a judge whose model made the labels is never selected', () => {
  it('selects Haiku when Opus made the labels, even though Opus agrees more AND costs less', () => {
    // Opus (self-agreeing) 100% at 1000 micros; Haiku 85% at 4000. Without the rule Opus wins on both counts.
    const opus = judgeRow('opus', 100, 1000, { selfAgreement: true })
    const haiku = judgeRow('haiku', 85, 4000)

    expect(selectJudge([opus, haiku])?.name).toBe('haiku')
    expect(selectJudge([haiku, opus])?.name).toBe('haiku')
  })

  it('selects the other judge even when it is below 80% and the self-agreeing one is above it: the rule beats the threshold', () => {
    const selected = selectJudge([judgeRow('opus', 95, 18000, { selfAgreement: true }), judgeRow('haiku', 70, 4000)])

    expect(selected?.name).toBe('haiku')
  })

  it('still picks the highest agreement among the judges that count when none of them reaches 80%', () => {
    const rows = [judgeRow('a', 99, 1000, { selfAgreement: true }), judgeRow('b', 60, 1000), judgeRow('c', 70, 9000)]

    expect(selectJudge(rows)?.name).toBe('c')
  })

  it('selects nothing when every judge made the labels', () => {
    expect(selectJudge([judgeRow('opus', 100, 1000, { selfAgreement: true })])).toBeNull()
    expect(selectJudge([judgeRow('opus', 100, 1000, { selfAgreement: true }), judgeRow('opus2', 90, 500, { selfAgreement: true })])).toBeNull()
  })

  it('selects nothing when the only other judge produced no result: the self-agreeing one is not a fallback', () => {
    expect(selectJudge([judgeRow('opus', 100, 1000, { selfAgreement: true }), judgeRow('haiku', null, 4000)])).toBeNull()
  })

  it('behaves as it did with human labels: no row is self-agreeing, so the cheapest trusted judge is still selected', () => {
    expect(selectJudge([judgeRow('haiku', 85, 4000), judgeRow('opus', 95, 18000)])?.name).toBe('haiku')
    expect(selectJudge([judgeRow('haiku', 75, 4000), judgeRow('opus', 90, 18000)])?.name).toBe('opus')
  })
})

describe('scoreRun: when every judge made the labels', () => {
  const unjudged = () => perfect(20, () => ({ judge: null }))

  it('is not evaluated for judge-self-labelled, which says why there is no judge, in place of no-judge', () => {
    const run = scoreRun(unjudged(), { set: 'holdout', partial: false, judgeSelfLabelled: true })

    expect(run.bar).toEqual({ status: 'not-evaluated', reasons: ['judge-self-labelled'] })
  })

  it('keeps no-judge when the judges are simply missing', () => {
    expect(scoreRun(unjudged(), { set: 'holdout', partial: false }).bar).toEqual({ status: 'not-evaluated', reasons: ['no-judge'] })
    expect(scoreRun(unjudged(), { set: 'holdout', partial: false, judgeSelfLabelled: false }).bar).toEqual({ status: 'not-evaluated', reasons: ['no-judge'] })
  })

  it('still fails on a rule that can be evaluated, and lists judge-self-labelled beside it as not evaluated', () => {
    const inputs = perfect(20, (i) => ({ judge: null, ...(i === 0 ? { failures: [WORDING] } : {}) }))

    expect(scoreRun(inputs, { set: 'holdout', partial: false, judgeSelfLabelled: true }).bar).toEqual({ status: 'fail', rules: ['gates', 'forbidden-wording'], notEvaluated: ['judge-self-labelled'] })
  })

  it('prints the reason on the bar line, and a trial exits 0', () => {
    const bar = scoreRun(unjudged(), { set: 'holdout', partial: false, judgeSelfLabelled: true }).bar

    expect(formatBarLine(bar)).toBe('Bar: not evaluated (judge-self-labelled)')
    expect(barExitCode(bar)).toBe(0)
  })
})
