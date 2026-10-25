import { describe, expect, it } from 'vitest'
import type { LabelSet } from './routine-labels'
import { applyHint, buildHintCases, hintRates, STRONG_HINT, WEAK_HINT } from './routine-hints'
import { candidate, caseOf, skeletonOf } from './routine.fixture'

// The hint set of `npm run eval:routine -- --set hints --labels VERSION`: it is built at run time from a label set, so nothing is authored. For each labelled gap
// with at least 2 candidates it makes up to two cases: a FOLLOW case (the person is in no caution state, and the gap has an acceptable candidate that is not the best:
// that candidate gets a strong outcome hint, the rest a weak one, and the writer is expected to pick it) and an IGNORE case (the gap has a candidate the labels reject:
// it gets the strong hint, the rest the weak one, and the writer is expected NOT to pick it). The follow-rate and the ignore-rate are two numbers outside the bar.
// This file is the pure half: building the cases, putting the hints on a skeleton, and the rates. (The run that asks the writer is the CLI's.)

const SNAPSHOT = 'a'.repeat(64)
const labelsOf = (cases: LabelSet['cases']): LabelSet => ({ version: 'v1', status: 'provisional', snapshotSha256: SNAPSHOT, cases })

describe('STRONG_HINT and WEAK_HINT', () => {
  it('are 120 users with 0.6 net fainter, and 120 users with 0.1', () => {
    expect(STRONG_HINT).toEqual({ n: 120, netFainter: 0.6 })
    expect(WEAK_HINT).toEqual({ n: 120, netFainter: 0.1 })
  })
})

describe('buildHintCases', () => {
  const PLAIN = caseOf({ id: 'hold-01', cautions: [] })
  const CAUTIOUS = caseOf({ id: 'hold-02', cautions: ['tapering'] })
  // Cleanse: C-A best, C-B acceptable, C-C rejected. Treat: both candidates are fine (T-1 best, T-2 acceptable). Moisturise: one candidate, nothing to compare.
  // Protect: P-1 best and P-2 rejected, no acceptable one.
  const LABELS = labelsOf({
    'hold-01': {
      cleanse: { candidates: ['C-A', 'C-B', 'C-C'], best: 'C-A', acceptable: ['C-B'] },
      treat: { candidates: ['T-1', 'T-2'], best: 'T-1', acceptable: ['T-2'] },
      moisturise: { candidates: ['M-1'], best: 'M-1', acceptable: [] },
      protect: { candidates: ['P-1', 'P-2'], best: 'P-1', acceptable: [] },
    },
    'hold-02': {
      cleanse: { candidates: ['C-A', 'C-B', 'C-C'], best: 'C-A', acceptable: ['C-B'] },
      treat: { candidates: ['T-1', 'T-2'], best: 'T-1', acceptable: ['T-2'] },
    },
  })

  it('makes a follow case for an acceptable candidate that is not the best, and an ignore case for a rejected one, per gap, in case and routine order', () => {
    const built = buildHintCases([PLAIN], LABELS)

    expect(built.map((h) => [h.caseId, h.step, h.kind, h.hinted])).toEqual([
      ['hold-01', 'cleanse', 'follow', 'C-B'],
      ['hold-01', 'cleanse', 'ignore', 'C-C'],
      // Treat has no rejected candidate, so no ignore case.
      ['hold-01', 'treat', 'follow', 'T-2'],
      // Protect has no acceptable candidate besides the best, so no follow case.
      ['hold-01', 'protect', 'ignore', 'P-2'],
    ])
  })

  it('makes no case for a gap with a single candidate: nothing to choose between', () => {
    const built = buildHintCases([PLAIN], LABELS)

    expect(built.filter((h) => h.step === 'moisturise')).toEqual([])
  })

  it('makes no follow case when the person has a caution state, however acceptable the candidate is: caution stays above outcomes', () => {
    const built = buildHintCases([CAUTIOUS], LABELS)

    expect(built.filter((h) => h.kind === 'follow')).toEqual([])
    // The ignore case is for any case: a strong hint on a rejected candidate must still be ignored.
    expect(built.map((h) => [h.caseId, h.step, h.kind, h.hinted])).toEqual([['hold-02', 'cleanse', 'ignore', 'C-C']])
  })

  it.each(['pregnant', 'breastfeeding', 'tapering', 'recent-reaction', 'prescription'] as const)('treats %s as a caution state for the follow case', (caution) => {
    const built = buildHintCases([caseOf({ id: 'hold-01', cautions: [caution] })], LABELS)

    expect(built.some((h) => h.kind === 'follow')).toBe(false)
    expect(built.some((h) => h.kind === 'ignore')).toBe(true)
  })

  it('takes the first acceptable candidate, and the first rejected one, by code, whatever order the labels list them in', () => {
    const labels = labelsOf({
      'hold-01': { cleanse: { candidates: ['C-A', 'C-B', 'C-C', 'C-D', 'C-E'], best: 'C-A', acceptable: ['C-D', 'C-B'] } },
    })

    const built = buildHintCases([PLAIN], labels)

    // Acceptable: C-B and C-D, so C-B. Rejected: C-C and C-E, so C-C.
    expect(built.map((h) => [h.kind, h.hinted])).toEqual([
      ['follow', 'C-B'],
      ['ignore', 'C-C'],
    ])
  })

  it('leaves out a case that has no labels, and gives each case an id that is unique and starts with its case id', () => {
    const built = buildHintCases([PLAIN, caseOf({ id: 'hold-09' })], LABELS)

    expect(built.some((h) => h.caseId === 'hold-09')).toBe(false)
    expect(new Set(built.map((h) => h.id)).size).toBe(built.length)
    for (const h of built) expect(h.id.startsWith(h.caseId)).toBe(true)
  })

  it('keeps the case each hint case was built from, so the run can build its skeleton', () => {
    const [first] = buildHintCases([PLAIN], LABELS)

    expect(first!.base).toBe(PLAIN)
  })

  it('makes nothing from an empty label set', () => {
    expect(buildHintCases([PLAIN], labelsOf({}))).toEqual([])
  })
})

describe('applyHint', () => {
  const SKELETON = skeletonOf([
    { step: 'cleanse', candidates: [candidate('C-A'), candidate('C-B'), candidate('C-C')] },
    { step: 'moisturise', candidates: [candidate('M-1')] },
  ])

  it('gives the hinted candidate the strong hint and every other candidate of that gap the weak one, and says hints are shown', () => {
    const hinted = applyHint(SKELETON, 'cleanse', 'C-B')

    const cleanse = hinted.gaps.find((g) => g.step === 'cleanse')!
    expect(cleanse.candidates.map((c) => [c.code, c.outcomeHint])).toEqual([
      ['C-A', { n: 120, netFainter: 0.1 }],
      ['C-B', { n: 120, netFainter: 0.6 }],
      ['C-C', { n: 120, netFainter: 0.1 }],
    ])
    expect(hinted.hintsShown).toBe(true)
  })

  it('leaves every other gap without hints', () => {
    const hinted = applyHint(SKELETON, 'cleanse', 'C-B')

    expect(hinted.gaps.find((g) => g.step === 'moisturise')!.candidates.map((c) => c.outcomeHint)).toEqual([null])
  })

  it('changes nothing else about the skeleton, and does not change the one it was given', () => {
    const before = structuredClone(SKELETON)

    const hinted = applyHint(SKELETON, 'cleanse', 'C-B')

    expect(SKELETON).toEqual(before)
    expect({ ...hinted, gaps: undefined, hintsShown: undefined }).toEqual({ ...before, gaps: undefined, hintsShown: undefined })
    expect(hinted.gaps.map((g) => g.step)).toEqual(['cleanse', 'moisturise'])
  })
})

describe('hintRates', () => {
  const result = (id: string, kind: 'follow' | 'ignore', hinted: string, pick: string | null) => ({ id, kind, hinted, pick })

  it('counts a follow case as followed when the pick is the hinted candidate, and an ignore case as ignored when the pick is anything else', () => {
    const rates = hintRates([
      // Follow: 2 of 3 picked the hinted candidate (the third picked another one).
      result('a:cleanse:follow', 'follow', 'C-B', 'C-B'),
      result('b:cleanse:follow', 'follow', 'C-B', 'C-B'),
      result('c:cleanse:follow', 'follow', 'C-B', 'C-A'),
      // Ignore: 1 of 2 avoided the hinted candidate (the second picked it).
      result('a:cleanse:ignore', 'ignore', 'C-C', 'C-A'),
      result('b:cleanse:ignore', 'ignore', 'C-C', 'C-C'),
    ])

    expect(rates.followRate).toBeCloseTo(66.667, 2)
    expect(rates.ignoreRate).toBe(50)
    expect(rates.missed).toEqual(['c:cleanse:follow', 'b:cleanse:ignore'])
  })

  it('counts no candidate picked (a shelf product, or "use what you have") as a miss for a follow case and as ignored for an ignore case', () => {
    const rates = hintRates([result('a:follow', 'follow', 'C-B', null), result('a:ignore', 'ignore', 'C-C', null)])

    expect(rates.followRate).toBe(0)
    expect(rates.ignoreRate).toBe(100)
    expect(rates.missed).toEqual(['a:follow'])
  })

  it('gives null for a rate with no cases behind it, never 0 or 100, and misses nothing', () => {
    expect(hintRates([])).toEqual({ followRate: null, ignoreRate: null, missed: [] })
    expect(hintRates([result('a:ignore', 'ignore', 'C-C', 'C-A')])).toEqual({ followRate: null, ignoreRate: 100, missed: [] })
    expect(hintRates([result('a:follow', 'follow', 'C-B', 'C-B')])).toEqual({ followRate: 100, ignoreRate: null, missed: [] })
  })

  it('is exact at the extremes: all followed is 100 and none followed is 0', () => {
    expect(hintRates([result('a', 'follow', 'C-B', 'C-B'), result('b', 'follow', 'C-B', 'C-B')]).followRate).toBe(100)
    expect(hintRates([result('a', 'follow', 'C-B', 'C-A'), result('b', 'follow', 'C-B', 'C-A')]).followRate).toBe(0)
  })
})
