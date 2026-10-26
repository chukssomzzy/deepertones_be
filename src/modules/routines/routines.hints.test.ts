import { describe, expect, it } from 'vitest'
import { GOALS } from '../goals/goals.vocabulary'
import { applyOutcomeHints } from './routines.hints'
import { MIN_USERS, type OutcomeCounts } from './routines.outcomes'
import type { RoutineSkeleton, SkeletonCandidate, SkeletonShelfProduct } from './routines.types'

// applyOutcomeHints(skeleton, counts, shown): the skeleton with each gap candidate's outcomeHint filled from `counts` (by catalog code) and hintsShown set to
// `shown`. Pure: the skeleton it is given is not changed. Assumed: a candidate with no counts row gets no hint (null), like one under MIN_USERS.

const candidate = (code: string): SkeletonCandidate => ({
  code,
  brand: 'Brand',
  name: `Product ${code}`,
  form: 'serum',
  ingredients: ['water', 'niacinamide'],
  skinConcerns: [],
  frequency: 'pm',
  priceMin: 10,
  priceMax: 20,
  evidenceUrls: ['https://example.org/evidence'],
  ingredientsSourceUrl: null,
  outcomeHint: null,
})

const shelfProduct: SkeletonShelfProduct = { id: 'entry-1', brand: 'Shelf', name: 'Own cleanser', ingredients: ['water'], step: 'cleanse', verdict: { kind: 'keep' }, sourceUrls: [] }

const skeletonOf = (): RoutineSkeleton => ({
  goal: GOALS[0],
  person: { seen: [], alsoNoticed: [], skinType: 'oily', lowConfidence: [], cautions: [], budgetBand: null },
  steps: ['cleanse', 'treat', 'moisturise'],
  shelf: [shelfProduct],
  gaps: [
    { step: 'treat', candidates: [candidate('TREAT-1'), candidate('TREAT-2'), candidate('TREAT-3')] },
    { step: 'moisturise', candidates: [candidate('MOIST-1')] },
    { step: 'protect', candidates: [] },
  ],
  limits: { allowed: { cleanse: ['am-pm'], treat: ['pm'], moisturise: ['am-pm'], protect: ['am'] } as RoutineSkeleton['limits']['allowed'], maxNewProducts: 2 },
  hintsShown: false,
})

// n=120, fainter 90, flaredOrStopped 18: net fainter (90 - 18) / 120 = 0.6.
const strong: OutcomeCounts = { n: 120, fainter: 90, flared: 10, flaredOrStopped: 18, fainterAndFlaredOrStopped: 0 }
// n=30 (exactly MIN_USERS), fainter 12, flaredOrStopped 3: net fainter 9 / 30 = 0.3.
const atMinimum: OutcomeCounts = { n: 30, fainter: 12, flared: 2, flaredOrStopped: 3, fainterAndFlaredOrStopped: 0 }
const justUnder: OutcomeCounts = { n: 29, fainter: 12, flared: 2, flaredOrStopped: 3, fainterAndFlaredOrStopped: 0 }
// fainter is more than the users: counts no real group can have, so outcomeHint throws a RangeError.
const corrupt: OutcomeCounts = { n: 40, fainter: 50, flared: 0, flaredOrStopped: 0, fainterAndFlaredOrStopped: 0 }

const hintOf = (skeleton: RoutineSkeleton, step: string, code: string) => skeleton.gaps.find((g) => g.step === step)!.candidates.find((c) => c.code === code)!.outcomeHint

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

describe('applyOutcomeHints', () => {
  it('gives a candidate with at least 30 users a hint of its users and net fainter score', () => {
    const out = applyOutcomeHints(skeletonOf(), new Map([['TREAT-1', strong]]), true)

    const hint = hintOf(out, 'treat', 'TREAT-1')
    expect(hint?.n).toBe(120)
    expect(hint?.netFainter).toBeCloseTo(0.6, 10)
  })

  it('gives a hint at exactly the minimum of users and none one user under it', () => {
    expect(MIN_USERS).toBe(30)

    const out = applyOutcomeHints(skeletonOf(), new Map([['TREAT-1', atMinimum], ['TREAT-2', justUnder]]), true)

    expect(hintOf(out, 'treat', 'TREAT-1')?.n).toBe(30)
    expect(hintOf(out, 'treat', 'TREAT-1')?.netFainter).toBeCloseTo(0.3, 10)
    expect(hintOf(out, 'treat', 'TREAT-2')).toBeNull()
  })

  it('gives no hint to a candidate with no counts row, and hints the others of its gap and the other gaps', () => {
    const out = applyOutcomeHints(skeletonOf(), new Map([['TREAT-2', strong], ['MOIST-1', atMinimum]]), true)

    expect(hintOf(out, 'treat', 'TREAT-1')).toBeNull()
    expect(hintOf(out, 'treat', 'TREAT-2')?.n).toBe(120)
    expect(hintOf(out, 'treat', 'TREAT-3')).toBeNull()
    expect(hintOf(out, 'moisturise', 'MOIST-1')?.n).toBe(30)
  })

  it('records that hints were shown', () => {
    expect(applyOutcomeHints(skeletonOf(), new Map(), true).hintsShown).toBe(true)
  })

  it('gives every candidate no hint when hints are not shown, whatever the counts say, and records that', () => {
    const counts = new Map([['TREAT-1', strong], ['TREAT-2', atMinimum], ['MOIST-1', strong]])

    const out = applyOutcomeHints(skeletonOf(), counts, false)

    expect(out.hintsShown).toBe(false)
    expect(out.gaps.flatMap((g) => g.candidates).map((c) => c.outcomeHint)).toEqual([null, null, null, null])
  })

  it('ignores counts entirely when hints are not shown, even a corrupt row', () => {
    const out = applyOutcomeHints(skeletonOf(), new Map([['TREAT-1', corrupt]]), false)

    expect(hintOf(out, 'treat', 'TREAT-1')).toBeNull()
  })

  it('gives no hint to a candidate whose counts are corrupt, without throwing and without touching the others', () => {
    const counts = new Map([['TREAT-1', corrupt], ['TREAT-2', strong], ['MOIST-1', atMinimum]])

    let out: RoutineSkeleton | undefined
    expect(() => {
      out = applyOutcomeHints(skeletonOf(), counts, true)
    }).not.toThrow()

    expect(hintOf(out!, 'treat', 'TREAT-1')).toBeNull()
    expect(hintOf(out!, 'treat', 'TREAT-2')?.n).toBe(120)
    expect(hintOf(out!, 'moisturise', 'MOIST-1')?.n).toBe(30)
    expect(out!.hintsShown).toBe(true)
  })

  it('tells the caller the code of each corrupt row, and only those, so a broken collector is seen', () => {
    const heard: string[] = []
    applyOutcomeHints(skeletonOf(), new Map([['TREAT-1', corrupt], ['TREAT-2', strong]]), true, (code) => heard.push(code))

    expect(heard).toEqual(['TREAT-1'])
  })

  it('does not change the skeleton it is given', () => {
    const input = deepFreeze(skeletonOf())
    const before = structuredClone(input)

    const out = applyOutcomeHints(input, new Map([['TREAT-1', strong]]), true)

    expect(input).toEqual(before)
    expect(out).not.toBe(input)
    expect(hintOf(input, 'treat', 'TREAT-1')).toBeNull()
  })

  it('leaves the shelf, the person, the limits, the steps and every other candidate field as they were', () => {
    const input = skeletonOf()

    const out = applyOutcomeHints(input, new Map([['TREAT-1', strong]]), true)

    expect(out.shelf).toEqual([shelfProduct])
    expect(out.person).toEqual(input.person)
    expect(out.limits).toEqual(input.limits)
    expect(out.steps).toEqual(input.steps)
    expect(out.goal).toBe(input.goal)
    expect(out.gaps.map((g) => g.step)).toEqual(['treat', 'moisturise', 'protect'])
    expect(out.gaps.flatMap((g) => g.candidates).map(({ outcomeHint: _hint, ...rest }) => rest)).toEqual(
      input.gaps.flatMap((g) => g.candidates).map(({ outcomeHint: _hint, ...rest }) => rest),
    )
  })
})
