import { describe, expect, it } from 'vitest'
import { ROUTINE_STEPS, type Frequency, type RoutineStep } from '../catalog/catalog.vocabulary'
import { GOALS, type Goal } from '../goals/goals.vocabulary'
import { maxNewProductsFor } from './routines.rules'
import { sameProductBefore, spliceFixed, stableMerge } from './routines.stable'
import type { Routine, RoutineSkeleton, ShelfVerdict, SkeletonCandidate, SkeletonGap, SkeletonShelfProduct, StoredRoutineStep, StoredTaper } from './routines.types'

// The stable merge is what keeps a started routine steady (spec #189, pr2-design-notes.md). After Start, a rebuild must not reshuffle what still works: a previous step
// is FIXED when the gates find nothing wrong with it against the new skeleton, and only the broken steps go back to the writer. This file pins the pure part: which
// steps are fixed, the skeleton the writer sees, the tapers (recomputed from the rules, dates carried), and the splice of the fixed steps over the writer's answer.
// Expected values are worked out by hand from the rules in the brief, never by calling checkRoutine.
//
// ---- PROPOSED CONTRACT (the types of routines.stable.ts; the implementer owns the final shape) ----
//
// stableMerge(previous, skeleton, carry): StableMerge
//   previous: the current ready version: its id (the origin of a step carried over), its goal, expectation, stored steps and stored tapers.
//   skeleton: the NEW skeleton, from assembleSkeleton, untouched.
//   carry: what only the caller can look up.
//     candidates: each previous recommended candidate the new skeleton's gaps lost to the country/budget filter, found by code across countries, by the step the
//                 previous entry was at. A code found nowhere (retired or unsafe) is simply absent.
//     onShelf:    previous candidate code -> the shelf entry id of the same formulation, when the person now has that product on the shelf (after "I got it").
//                 Neither SkeletonCandidate nor SkeletonShelfProduct carries a formulation id, so the caller must say.
// StableMerge:
//   fixed:          previous steps kept whole, in previous order, with fixedFrom set to the version they came from (the step's own fixedFrom when it already had one).
//   checking:       the skeleton plus each carried candidate re-added to its step's existing gap. The real skeleton for every final gate check.
//   writerSkeleton: null when no step is broken and the goal is unchanged; else `checking` with each fixed recommended step's gap narrowed to its one candidate.
//   carriedTapers:  one per stopped shelf product of the new skeleton, in shelf order; startedOn kept when the template is unchanged, else null.
//   expectation:    previous.expectation, or null when the goal changed or the routine failed a gate as a whole, so it is rebuilt whole (the writer's / rules-only words are used then).
// spliceFixed(merge, answer): the fixed steps replace, whole and by step, the answer's entries for that step; the other steps are the answer's, with gotIt false and
//   fixedFrom null; tapers are merge.carriedTapers (the answer's tapers are ignored); expectation is merge.expectation ?? answer.expectation.

type StablePrevious = { id: string; goal: Goal; expectation: string; steps: StoredRoutineStep[]; tapers: StoredTaper[] }
type StableCarry = { candidates: Partial<Record<RoutineStep, SkeletonCandidate[]>>; onShelf: Record<string, string> }
type StableMerge = {
  fixed: StoredRoutineStep[]
  checking: RoutineSkeleton
  writerSkeleton: RoutineSkeleton | null
  carriedTapers: StoredTaper[]
  expectation: string | null
}
type Spliced = { steps: StoredRoutineStep[]; tapers: StoredTaper[]; expectation: string }

// Compile-time pin: the real functions must match the proposal above.
const _merge: (previous: StablePrevious, skeleton: RoutineSkeleton, carry: StableCarry) => StableMerge = stableMerge
const _splice: (merge: StableMerge, answer: Routine) => Spliced = spliceFixed
void _merge
void _splice

// ---- dates: one anchor, everything an offset from it ----
const BASE = new Date('2026-10-26T09:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

// ---- builders ----
const [GOAL, OTHER_GOAL] = GOALS as readonly [Goal, Goal, ...Goal[]]

const candidate = (code: string, over: Partial<SkeletonCandidate> = {}): SkeletonCandidate => ({
  code,
  brand: `Brand ${code}`,
  name: `Name ${code}`,
  form: 'cream',
  ingredients: ['Aqua', 'Glycerin'],
  skinConcerns: ['hd_radiance'],
  frequency: 'am',
  priceMin: 1000,
  priceMax: 2000,
  evidenceUrls: [`https://evidence.example/${code}/a`, `https://evidence.example/${code}/b`],
  ingredientsSourceUrl: null,
  outcomeHint: null,
  ...over,
})

const shelfProduct = (id: string, step: RoutineStep | null, verdict: ShelfVerdict = { kind: 'keep' }): SkeletonShelfProduct => ({
  id,
  brand: 'Shelf Brand',
  name: `Shelf ${id}`,
  ingredients: ['Aqua'],
  step,
  verdict,
  sourceUrls: [`https://rules.example/${id}`],
})

/** A skeleton whose gaps are exactly the steps no kept or reduced shelf product fills, each with the candidates given for it. */
const skeletonOf = (shelf: SkeletonShelfProduct[], offers: Partial<Record<RoutineStep, SkeletonCandidate[]>> = {}, over: Partial<RoutineSkeleton> = {}): RoutineSkeleton => {
  const filled = new Set(shelf.filter((p) => p.verdict.kind === 'keep' || p.verdict.kind === 'reduce').map((p) => p.step))
  const gaps: SkeletonGap[] = ROUTINE_STEPS.filter((step) => !filled.has(step)).map((step) => ({ step, candidates: offers[step] ?? [] }))
  return {
    goal: GOAL,
    person: { seen: [{ concern: 'hd_age_spot', level: 'some' }], alsoNoticed: [], skinType: 'combination', lowConfidence: [], cautions: [], budgetBand: 'mid' },
    steps: [...ROUTINE_STEPS],
    shelf,
    gaps,
    limits: {
      allowed: { cleanse: ['am', 'pm', 'am-pm'], treat: ['pm', 'alternate-days', 'weekly', 'am', 'am-pm'], moisturise: ['am', 'pm', 'am-pm'], protect: ['am'] },
      maxNewProducts: maxNewProductsFor(gaps),
    },
    hintsShown: false,
    ...over,
  }
}

const entry = (step: RoutineStep, product: StoredRoutineStep['product'], frequency: Frequency, grounding: string[], over: Partial<StoredRoutineStep> = {}): StoredRoutineStep => ({
  step,
  product,
  frequency,
  reason: `Reason for ${step} ${product.kind === 'none' ? 'none' : product.kind === 'shelf' ? product.id : product.code}.`,
  grounding,
  gotIt: false,
  fixedFrom: null,
  changedOn: null,
  ...over,
})

const PREVIOUS_ID = 'v-prev'
const EXPECTATION = 'Most people see a change in 8 to 12 weeks.'

const links = (code: string) => [`https://evidence.example/${code}/a`, `https://evidence.example/${code}/b`]

// The previous routine: the kept cleanser, then a recommended product at each of the other three steps.
const previousSteps = (): StoredRoutineStep[] => [
  entry('cleanse', { kind: 'shelf', id: 'cleanser-1' }, 'am-pm', ['https://rules.example/cleanser-1']),
  entry('treat', { kind: 'candidate', code: 'tr-1' }, 'pm', links('tr-1')),
  entry('moisturise', { kind: 'candidate', code: 'mo-1' }, 'am-pm', links('mo-1')),
  entry('protect', { kind: 'candidate', code: 'pr-1' }, 'am', links('pr-1')),
]

const previousOf = (over: Partial<StablePrevious> = {}): StablePrevious => ({ id: PREVIOUS_ID, goal: GOAL, expectation: EXPECTATION, steps: previousSteps(), tapers: [], ...over })

/** The skeleton the previous routine was valid for: a kept cleanser, and gaps for the other three steps (treat and moisturise with two candidates, protect with one). */
const baseSkeleton = (shelf: SkeletonShelfProduct[] = [shelfProduct('cleanser-1', 'cleanse')], over: Partial<RoutineSkeleton> = {}): RoutineSkeleton =>
  skeletonOf(shelf, { treat: [candidate('tr-1'), candidate('tr-2')], moisturise: [candidate('mo-1'), candidate('mo-2')], protect: [candidate('pr-1')] }, over)

const NO_CARRY: StableCarry = { candidates: {}, onShelf: {} }

const fixedSteps = (merge: StableMerge) => merge.fixed.map((e) => e.step)
const gapCodes = (skeleton: RoutineSkeleton | null) => skeleton?.gaps.map((g) => [g.step, g.candidates.map((c) => c.code)])

describe('stableMerge: which previous steps stay as they are', () => {
  it('fixes every step, changes nothing and asks no writer when the new skeleton is the one the routine was valid for', () => {
    const skeleton = baseSkeleton()

    const merge = stableMerge(previousOf(), skeleton, NO_CARRY)

    expect(merge.fixed).toEqual(previousSteps().map((e) => ({ ...e, fixedFrom: PREVIOUS_ID })))
    expect(merge.writerSkeleton).toBeNull()
    expect(merge.checking).toEqual(baseSkeleton())
    expect(merge.carriedTapers).toEqual([])
    expect(merge.expectation).toBe(EXPECTATION)
  })

  it('does not fail a step for its got-it flag, its fixedFrom or a taper start date, which the gates would reject as unknown fields', () => {
    const skeleton = baseSkeleton([shelfProduct('cleanser-1', 'cleanse'), shelfProduct('steroid-1', 'treat', { kind: 'stop', taperTemplateId: 'tpl-steroid' })])
    const steps = previousSteps()
    steps[1] = { ...steps[1]!, gotIt: true }
    steps[2] = { ...steps[2]!, fixedFrom: 'v-older' }
    const tapers: StoredTaper[] = [{ shelfProductId: 'steroid-1', templateId: 'tpl-steroid', startedOn: at(-3 * DAY) }]

    const merge = stableMerge(previousOf({ steps, tapers }), skeleton, NO_CARRY)

    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
    expect(merge.fixed[1]).toMatchObject({ product: { kind: 'candidate', code: 'tr-1' }, gotIt: true, fixedFrom: PREVIOUS_ID })
    expect(merge.fixed[2]).toMatchObject({ product: { kind: 'candidate', code: 'mo-1' }, gotIt: false, fixedFrom: 'v-older' })
    expect(merge.carriedTapers).toEqual([{ shelfProductId: 'steroid-1', templateId: 'tpl-steroid', startedOn: at(-3 * DAY) }])
    expect(merge.writerSkeleton).toBeNull()
  })

  it('breaks every entry of a step when one of them breaks, and narrows the fixed steps to their one product for the writer', () => {
    // Two kept cleansers were in the routine; the second is now dropped. The first entry is fine alone, but the step is re-picked as a whole.
    const steps = [entry('cleanse', { kind: 'shelf', id: 'cleanser-1' }, 'am', ['https://rules.example/cleanser-1']), entry('cleanse', { kind: 'shelf', id: 'cleanser-2' }, 'pm', ['https://rules.example/cleanser-2']), ...previousSteps().slice(1)]
    const skeleton = baseSkeleton([shelfProduct('cleanser-1', 'cleanse'), shelfProduct('cleanser-2', 'cleanse', { kind: 'drop' })])

    const merge = stableMerge(previousOf({ steps }), skeleton, NO_CARRY)

    expect(fixedSteps(merge)).toEqual(['treat', 'moisturise', 'protect'])
    expect(merge.writerSkeleton).not.toBeNull()
    expect(gapCodes(merge.writerSkeleton)).toEqual([
      ['treat', ['tr-1']],
      ['moisturise', ['mo-1']],
      ['protect', ['pr-1']],
    ])
    // The checking skeleton is never narrowed: the final gate check runs against all of each gap's candidates.
    expect(gapCodes(merge.checking)).toEqual([
      ['treat', ['tr-1', 'tr-2']],
      ['moisturise', ['mo-1', 'mo-2']],
      ['protect', ['pr-1']],
    ])
    expect(merge.writerSkeleton!.shelf).toEqual(skeleton.shelf)
  })

  it('breaks the step of a shelf product the rules now drop, and leaves the other steps fixed', () => {
    const skeleton = baseSkeleton([shelfProduct('cleanser-1', 'cleanse', { kind: 'drop' })])

    const merge = stableMerge(previousOf(), skeleton, NO_CARRY)

    expect(fixedSteps(merge)).toEqual(['treat', 'moisturise', 'protect'])
    // The cleanse step is now a gap with no candidates, so the writer is asked for it and it is not narrowed to anything.
    expect(gapCodes(merge.writerSkeleton)).toEqual([
      ['cleanse', []],
      ['treat', ['tr-1']],
      ['moisturise', ['mo-1']],
      ['protect', ['pr-1']],
    ])
  })

  it('breaks the step of a kept shelf product the rules now stop, gives the step back its whole gap, and adds the taper with no start date', () => {
    const steps = [previousSteps()[0]!, entry('treat', { kind: 'shelf', id: 'serum-1' }, 'pm', ['https://rules.example/serum-1']), ...previousSteps().slice(2)]
    const skeleton = baseSkeleton([shelfProduct('cleanser-1', 'cleanse'), shelfProduct('serum-1', 'treat', { kind: 'stop', taperTemplateId: 'tpl-serum' })])

    const merge = stableMerge(previousOf({ steps }), skeleton, NO_CARRY)

    expect(fixedSteps(merge)).toEqual(['cleanse', 'moisturise', 'protect'])
    expect(gapCodes(merge.writerSkeleton)).toEqual([
      ['treat', ['tr-1', 'tr-2']],
      ['moisturise', ['mo-1']],
      ['protect', ['pr-1']],
    ])
    expect(merge.carriedTapers).toEqual([{ shelfProductId: 'serum-1', templateId: 'tpl-serum', startedOn: null }])
  })

  it('breaks a step that has a gap in the new skeleton and no entry in the previous routine', () => {
    const steps = previousSteps().slice(0, 3)

    const merge = stableMerge(previousOf({ steps }), baseSkeleton(), NO_CARRY)

    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'moisturise'])
    expect(gapCodes(merge.writerSkeleton)).toEqual([
      ['treat', ['tr-1']],
      ['moisturise', ['mo-1']],
      ['protect', ['pr-1']],
    ])
  })

  it('keeps a "use what you have" step while its gap has no candidates, and breaks it once the gap has some', () => {
    const none = entry('treat', { kind: 'none' }, 'pm', [])
    const steps = [previousSteps()[0]!, none, ...previousSteps().slice(2)]
    const stillEmpty = skeletonOf([shelfProduct('cleanser-1', 'cleanse')], { moisturise: [candidate('mo-1')], protect: [candidate('pr-1')] })
    const nowOffered = skeletonOf([shelfProduct('cleanser-1', 'cleanse')], { treat: [candidate('tr-1')], moisturise: [candidate('mo-1')], protect: [candidate('pr-1')] })

    const kept = stableMerge(previousOf({ steps }), stillEmpty, NO_CARRY)
    const rebuilt = stableMerge(previousOf({ steps }), nowOffered, NO_CARRY)

    expect(fixedSteps(kept)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
    expect(kept.writerSkeleton).toBeNull()
    expect(fixedSteps(rebuilt)).toEqual(['cleanse', 'moisturise', 'protect'])
    expect(gapCodes(rebuilt.writerSkeleton)?.[0]).toEqual(['treat', ['tr-1']])
  })

  it('fixes nothing and sends the whole checking skeleton to the writer when the routine as a whole fails a gate (here the expectation names a condition)', () => {
    const previous = previousOf({ expectation: 'Most people with rosacea see a change in 8 to 12 weeks.' })

    const merge = stableMerge(previous, baseSkeleton(), NO_CARRY)

    expect(merge.fixed).toEqual([])
    expect(merge.writerSkeleton).toEqual(merge.checking)
    expect(gapCodes(merge.writerSkeleton)).toEqual([
      ['treat', ['tr-1', 'tr-2']],
      ['moisturise', ['mo-1', 'mo-2']],
      ['protect', ['pr-1']],
    ])
  })

  it('does not soften a fixed step when a caution is added: the frequency stays and no writer is asked', () => {
    const skeleton = baseSkeleton(undefined, { person: { ...baseSkeleton().person, cautions: ['pregnant'] } })

    const merge = stableMerge(previousOf(), skeleton, NO_CARRY)

    expect(merge.fixed.map((e) => [e.step, e.frequency])).toEqual([
      ['cleanse', 'am-pm'],
      ['treat', 'pm'],
      ['moisturise', 'am-pm'],
      ['protect', 'am'],
    ])
    expect(merge.writerSkeleton).toBeNull()
    expect(merge.checking.person.cautions).toEqual(['pregnant'])
  })
})

describe('stableMerge: the same product no longer in the same place', () => {
  it('keeps a recommended product the country or budget filter dropped from its gap, by re-adding it to the checking skeleton', () => {
    // The person moved country: the protect gap now offers only pr-ng. The routine's pr-uk is found by the caller in the other country.
    const steps = [...previousSteps().slice(0, 3), entry('protect', { kind: 'candidate', code: 'pr-uk' }, 'am', links('pr-uk'))]
    const skeleton = skeletonOf([shelfProduct('cleanser-1', 'cleanse')], { treat: [candidate('tr-1')], moisturise: [candidate('mo-1')], protect: [candidate('pr-ng')] })
    const before = structuredClone(skeleton)

    const merge = stableMerge(previousOf({ steps }), skeleton, { candidates: { protect: [candidate('pr-uk')] }, onShelf: {} })

    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
    expect(merge.fixed[3]!.product).toEqual({ kind: 'candidate', code: 'pr-uk' })
    expect(merge.checking.gaps.find((g) => g.step === 'protect')!.candidates.map((c) => c.code).sort()).toEqual(['pr-ng', 'pr-uk'])
    expect(merge.writerSkeleton).toBeNull()
    // The skeleton the caller passed is not changed in place.
    expect(skeleton).toEqual(before)
  })

  it('narrows a re-added step to that one product for the writer while the checking skeleton keeps the whole gap', () => {
    // Moisturise is broken (its product is found nowhere, so it is retired or unsafe and is not re-added); protect is fixed by its re-added product.
    const steps = [...previousSteps().slice(0, 2), entry('moisturise', { kind: 'candidate', code: 'mo-gone' }, 'am-pm', []), entry('protect', { kind: 'candidate', code: 'pr-uk' }, 'am', links('pr-uk'))]
    const skeleton = skeletonOf([shelfProduct('cleanser-1', 'cleanse')], { treat: [candidate('tr-1')], moisturise: [candidate('mo-1'), candidate('mo-2')], protect: [candidate('pr-ng')] })

    const merge = stableMerge(previousOf({ steps }), skeleton, { candidates: { protect: [candidate('pr-uk')] }, onShelf: {} })

    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'protect'])
    expect(gapCodes(merge.writerSkeleton)).toEqual([
      ['treat', ['tr-1']],
      ['moisturise', ['mo-1', 'mo-2']],
      ['protect', ['pr-uk']],
    ])
    expect(merge.checking.gaps.find((g) => g.step === 'protect')!.candidates.map((c) => c.code).sort()).toEqual(['pr-ng', 'pr-uk'])
    // Narrowing does not change how many new products the routine may ask for.
    expect(merge.writerSkeleton!.limits.maxNewProducts).toBe(3)
    expect(merge.checking.limits.maxNewProducts).toBe(3)
  })

  it('breaks the step of a recommended product that is in no gap and was not re-added', () => {
    const steps = [...previousSteps().slice(0, 3), entry('protect', { kind: 'candidate', code: 'pr-gone' }, 'am', [])]
    const skeleton = skeletonOf([shelfProduct('cleanser-1', 'cleanse')], { treat: [candidate('tr-1')], moisturise: [candidate('mo-1')], protect: [candidate('pr-ng')] })

    const merge = stableMerge(previousOf({ steps }), skeleton, NO_CARRY)

    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'moisturise'])
    expect(gapCodes(merge.writerSkeleton)?.[2]).toEqual(['protect', ['pr-ng']])
  })

  it('offers a step that is broken only the products the person\'s country sells: a re-added product stays in the gaps of the fixed steps', async () => {
    // Protect keeps its re-added pr-uk. Moisturise is broken (its reason uses forbidden wording) and also had a re-added mo-uk: the writer must not be offered it.
    const steps = [...previousSteps().slice(0, 2), entry('moisturise', { kind: 'candidate', code: 'mo-uk' }, 'am-pm', links('mo-uk'), { reason: 'A fairer tone.' }), entry('protect', { kind: 'candidate', code: 'pr-uk' }, 'am', links('pr-uk'))]
    const skeleton = skeletonOf([shelfProduct('cleanser-1', 'cleanse')], { treat: [candidate('tr-1')], moisturise: [candidate('mo-1')], protect: [candidate('pr-ng')] })

    const merge = stableMerge(previousOf({ steps }), skeleton, { candidates: { moisturise: [candidate('mo-uk')], protect: [candidate('pr-uk')] }, onShelf: {} })

    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'protect'])
    expect(gapCodes(merge.writerSkeleton)).toEqual([
      ['treat', ['tr-1']],
      ['moisturise', ['mo-1']],
      ['protect', ['pr-uk']],
    ])
    // The final check still knows every product the routine may keep.
    expect(merge.checking.gaps.find((g) => g.step === 'moisturise')!.candidates.map((c) => c.code)).toEqual(['mo-1', 'mo-uk'])
  })

  it('does not put a re-added product in a gap twice when the gap already offers it', () => {
    const merge = stableMerge(previousOf(), baseSkeleton(), { candidates: { moisturise: [candidate('mo-1')] }, onShelf: {} })

    expect(merge.checking.gaps.find((g) => g.step === 'moisturise')!.candidates.map((c) => c.code)).toEqual(['mo-1', 'mo-2'])
  })

  it('swaps a recommended product the person now has on the shelf for the shelf entry, keeping its frequency and reason, with no got-it flag', () => {
    // After "I got it" the person added mo-1 to the shelf; it is shelf entry cream-1, kept, and the moisturise gap is gone. Its sources share one link with mo-1's.
    const steps = [previousSteps()[0]!, previousSteps()[1]!, entry('moisturise', { kind: 'candidate', code: 'mo-1' }, 'am-pm', links('mo-1'), { gotIt: true, reason: 'Moisturise reason to keep.' }), previousSteps()[3]!]
    const cream = { ...shelfProduct('cream-1', 'moisturise'), sourceUrls: ['https://evidence.example/mo-1/a', 'https://rules.example/cream-1'] }
    const skeleton = skeletonOf([shelfProduct('cleanser-1', 'cleanse'), cream], { treat: [candidate('tr-1')], protect: [candidate('pr-1')] })

    const merge = stableMerge(previousOf({ steps }), skeleton, { candidates: {}, onShelf: { 'mo-1': 'cream-1' } })

    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
    expect(merge.fixed[2]).toMatchObject({
      step: 'moisturise',
      product: { kind: 'shelf', id: 'cream-1' },
      frequency: 'am-pm',
      reason: 'Moisturise reason to keep.',
      // The previous grounding (mo-1's two links) cut to the links the shelf product has now.
      grounding: ['https://evidence.example/mo-1/a'],
      gotIt: false,
    })
    expect(merge.writerSkeleton).toBeNull()
  })

  it('breaks the step when the product was not swapped to the shelf (the caller named no shelf entry for it)', () => {
    const cream = shelfProduct('cream-1', 'moisturise')
    const skeleton = skeletonOf([shelfProduct('cleanser-1', 'cleanse'), cream], { treat: [candidate('tr-1')], protect: [candidate('pr-1')] })

    const merge = stableMerge(previousOf(), skeleton, NO_CARRY)

    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'protect'])
    expect(merge.writerSkeleton).not.toBeNull()
  })

  it('breaks a swapped step whose shelf product is now capped below the kept frequency', () => {
    const cream = shelfProduct('cream-1', 'moisturise', { kind: 'reduce', maxFrequency: 'pm' })
    const skeleton = skeletonOf([shelfProduct('cleanser-1', 'cleanse'), cream], { treat: [candidate('tr-1')], protect: [candidate('pr-1')] })

    const merge = stableMerge(previousOf(), skeleton, { candidates: {}, onShelf: { 'mo-1': 'cream-1' } })

    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'protect'])
  })
})

describe('stableMerge: edits to the catalog do not churn a started routine', () => {
  it('keeps a step whose product lost one of the links its reason drew on, and cuts the grounding to the links still held', () => {
    const steps = previousSteps()
    steps[1] = { ...steps[1]!, grounding: ['https://evidence.example/tr-1/a', 'https://evidence.example/tr-1/b'] }
    const skeleton = skeletonOf([shelfProduct('cleanser-1', 'cleanse')], {
      treat: [candidate('tr-1', { evidenceUrls: ['https://evidence.example/tr-1/b', 'https://evidence.example/tr-1/c'] }), candidate('tr-2')],
      moisturise: [candidate('mo-1')],
      protect: [candidate('pr-1')],
    })

    const merge = stableMerge(previousOf({ steps }), skeleton, NO_CARRY)

    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
    expect(merge.fixed[1]).toMatchObject({ frequency: 'pm', reason: steps[1]!.reason, grounding: ['https://evidence.example/tr-1/b'] })
    expect(merge.writerSkeleton).toBeNull()
  })
})

describe('stableMerge: tapers are recomputed from the rules, and the start dates carry', () => {
  const skeletonWithStops = (stops: [string, string][]) => baseSkeleton([shelfProduct('cleanser-1', 'cleanse'), ...stops.map(([id, template]) => shelfProduct(id, null, { kind: 'stop', taperTemplateId: template }))])

  it('keeps the start date of a stop whose template is unchanged, clears it when the template changed, starts a new stop undated and drops a stop that is gone', () => {
    const tapers: StoredTaper[] = [
      { shelfProductId: 'a', templateId: 'tpl-a', startedOn: at(-3 * DAY) },
      { shelfProductId: 'b', templateId: 'tpl-b', startedOn: at(-1 * DAY) },
      { shelfProductId: 'c', templateId: 'tpl-c', startedOn: at(-2 * DAY) },
    ]
    const skeleton = skeletonWithStops([
      ['a', 'tpl-a'],
      ['b', 'tpl-b-new'],
      ['d', 'tpl-d'],
    ])

    const merge = stableMerge(previousOf({ tapers }), skeleton, NO_CARRY)

    expect(merge.carriedTapers).toEqual([
      { shelfProductId: 'a', templateId: 'tpl-a', startedOn: at(-3 * DAY) },
      { shelfProductId: 'b', templateId: 'tpl-b-new', startedOn: null },
      { shelfProductId: 'd', templateId: 'tpl-d', startedOn: null },
    ])
    // A taper that no longer matches the rules is recomputed, never a reason to rebuild a step.
    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
    expect(merge.writerSkeleton).toBeNull()
  })

  it('keeps a taper that has not started as not started', () => {
    const tapers: StoredTaper[] = [{ shelfProductId: 'a', templateId: 'tpl-a', startedOn: null }]

    const merge = stableMerge(previousOf({ tapers }), skeletonWithStops([['a', 'tpl-a']]), NO_CARRY)

    expect(merge.carriedTapers).toEqual([{ shelfProductId: 'a', templateId: 'tpl-a', startedOn: null }])
  })

  it('adds the taper of a new stop that no step depended on without asking the writer, since tapers are set in code', () => {
    const merge = stableMerge(previousOf(), skeletonWithStops([['new-steroid', 'tpl-steroid']]), NO_CARRY)

    expect(merge.carriedTapers).toEqual([{ shelfProductId: 'new-steroid', templateId: 'tpl-steroid', startedOn: null }])
    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
    expect(merge.writerSkeleton).toBeNull()
  })
})

describe('stableMerge: the goal', () => {
  it('carries the expectation when the goal is the same', () => {
    expect(stableMerge(previousOf(), baseSkeleton(), NO_CARRY).expectation).toBe(EXPECTATION)
  })

  it('gives the expectation back to be rewritten, and asks the writer, when the goal changed, while the steps that still pass stay fixed', () => {
    const skeleton = baseSkeleton(undefined, { goal: OTHER_GOAL })

    const merge = stableMerge(previousOf(), skeleton, NO_CARRY)

    expect(merge.expectation).toBeNull()
    expect(fixedSteps(merge)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
    expect(merge.writerSkeleton).not.toBeNull()
    expect(merge.writerSkeleton!.goal).toBe(OTHER_GOAL)
  })
})

describe('spliceFixed: the fixed steps over the writer answer', () => {
  // The cleanser entry pair breaks (second cleanser dropped); treat, moisturise and protect are fixed.
  const brokenCleanse = () => {
    const steps = [entry('cleanse', { kind: 'shelf', id: 'cleanser-1' }, 'am', ['https://rules.example/cleanser-1']), entry('cleanse', { kind: 'shelf', id: 'cleanser-2' }, 'pm', ['https://rules.example/cleanser-2']), ...previousSteps().slice(1)]
    const skeleton = baseSkeleton([shelfProduct('cleanser-1', 'cleanse'), shelfProduct('cleanser-2', 'cleanse', { kind: 'drop' })], {})
    return stableMerge(previousOf({ steps }), skeleton, NO_CARRY)
  }

  const answer = (over: Partial<Routine> = {}): Routine => ({
    steps: [
      { step: 'cleanse', product: { kind: 'shelf', id: 'cleanser-1' }, frequency: 'pm', reason: 'Writer cleanse reason.', grounding: [] },
      { step: 'treat', product: { kind: 'candidate', code: 'tr-1' }, frequency: 'am', reason: 'Writer treat reason.', grounding: ['https://evidence.example/tr-1/a'] },
      { step: 'moisturise', product: { kind: 'candidate', code: 'mo-1' }, frequency: 'am', reason: 'Writer moisturise reason.', grounding: [] },
      { step: 'protect', product: { kind: 'candidate', code: 'pr-1' }, frequency: 'am', reason: 'Writer protect reason.', grounding: [] },
    ],
    tapers: [],
    expectation: 'Writer expectation.',
    ...over,
  })

  it('keeps each fixed step whole, product, frequency, reason and grounding, and takes the writer entries only for the broken step', () => {
    const merge = brokenCleanse()

    const result = spliceFixed(merge, answer())

    expect(result.steps).toEqual([
      { step: 'cleanse', product: { kind: 'shelf', id: 'cleanser-1' }, frequency: 'pm', reason: 'Writer cleanse reason.', grounding: [], gotIt: false, fixedFrom: null, changedOn: null },
      { ...previousSteps()[1]!, fixedFrom: PREVIOUS_ID },
      { ...previousSteps()[2]!, fixedFrom: PREVIOUS_ID },
      { ...previousSteps()[3]!, fixedFrom: PREVIOUS_ID },
    ])
  })

  it('replaces every writer entry at a fixed step, however many there are', () => {
    const merge = brokenCleanse()
    const extra = { step: 'treat' as const, product: { kind: 'candidate' as const, code: 'tr-2' }, frequency: 'weekly' as const, reason: 'Writer second treat.', grounding: [] }
    const routine = answer()
    routine.steps.splice(2, 0, extra)

    const result = spliceFixed(merge, routine)

    expect(result.steps.filter((e) => e.step === 'treat')).toEqual([{ ...previousSteps()[1]!, fixedFrom: PREVIOUS_ID }])
  })

  it('sets the tapers from the rules with their carried dates, ignoring the writer tapers', () => {
    const skeleton = baseSkeleton([shelfProduct('cleanser-1', 'cleanse'), shelfProduct('steroid-1', null, { kind: 'stop', taperTemplateId: 'tpl-steroid' })])
    const tapers: StoredTaper[] = [{ shelfProductId: 'steroid-1', templateId: 'tpl-steroid', startedOn: at(-5 * DAY) }]
    const merge = stableMerge(previousOf({ tapers }), skeleton, NO_CARRY)

    const result = spliceFixed(merge, answer({ tapers: [{ shelfProductId: 'invented', templateId: 'tpl-invented' }] }))

    expect(result.tapers).toEqual([{ shelfProductId: 'steroid-1', templateId: 'tpl-steroid', startedOn: at(-5 * DAY) }])
  })

  it('carries the previous expectation over the writer one when the goal is unchanged, and uses the writer one when the goal changed', () => {
    const same = spliceFixed(brokenCleanse(), answer())
    const changed = spliceFixed(stableMerge(previousOf(), baseSkeleton(undefined, { goal: OTHER_GOAL }), NO_CARRY), answer())

    expect(same.expectation).toBe(EXPECTATION)
    expect(changed.expectation).toBe('Writer expectation.')
  })

  it('takes every entry from the writer when nothing was fixed', () => {
    const merge = stableMerge(previousOf({ expectation: 'Most people with rosacea see a change in 8 to 12 weeks.' }), baseSkeleton(), NO_CARRY)

    const result = spliceFixed(merge, answer())

    expect(result.steps.map((e) => [e.step, e.reason, e.gotIt, e.fixedFrom])).toEqual([
      ['cleanse', 'Writer cleanse reason.', false, null],
      ['treat', 'Writer treat reason.', false, null],
      ['moisturise', 'Writer moisturise reason.', false, null],
      ['protect', 'Writer protect reason.', false, null],
    ])
    expect(result.expectation).toBe('Writer expectation.')
  })
})

// ---- changedOn (spec #233, PR 4a) ----
// The day each step's product last changed is a date the service stamps on the steps the splice writes as new (fixedFrom null): the splice itself leaves them null, and the service
// (which knows the clock and the zone) stamps them after. What this pure part owes is that a step kept whole is kept with its date, however the merge moves it.
describe('changedOn: a fixed step keeps its own date', () => {
  const CHANGED = new Date('2030-06-19T00:00:00.000Z')
  const dated = (): StoredRoutineStep[] => previousSteps().map((e) => (e.step === 'treat' || e.step === 'protect' ? { ...e, changedOn: CHANGED } : e))

  it('carries a date through the merge on every fixed step, and null on one that never had a date', () => {
    const merge = stableMerge(previousOf({ steps: dated() }), baseSkeleton(), NO_CARRY)

    expect(merge.fixed.map((e) => [e.step, e.changedOn])).toEqual([['cleanse', null], ['treat', CHANGED], ['moisturise', null], ['protect', CHANGED]])
  })

  it('keeps the date of a recommended product the person has got when it becomes their own shelf entry: it is the same product, so it is not a change', () => {
    const skeleton = baseSkeleton([shelfProduct('cleanser-1', 'cleanse'), shelfProduct('serum-own', 'treat')])

    const merge = stableMerge(previousOf({ steps: dated() }), skeleton, { candidates: {}, onShelf: { 'tr-1': 'serum-own' } })

    expect(merge.fixed.find((e) => e.step === 'treat')).toMatchObject({ product: { kind: 'shelf', id: 'serum-own' }, changedOn: CHANGED })
  })

  it('keeps the dates of the fixed steps when the splice puts them back, and leaves the writer\'s own step undated for the service to stamp', () => {
    const steps = [entry('cleanse', { kind: 'shelf', id: 'cleanser-1' }, 'am', ['https://rules.example/cleanser-1']), entry('cleanse', { kind: 'shelf', id: 'cleanser-2' }, 'pm', ['https://rules.example/cleanser-2']), ...dated().slice(1)]
    const skeleton = baseSkeleton([shelfProduct('cleanser-1', 'cleanse'), shelfProduct('cleanser-2', 'cleanse', { kind: 'drop' })], {})
    const merge = stableMerge(previousOf({ steps }), skeleton, NO_CARRY)
    const written: Routine = {
      steps: [
        { step: 'cleanse', product: { kind: 'shelf', id: 'cleanser-1' }, frequency: 'pm', reason: 'Writer cleanse reason.', grounding: [] },
        { step: 'treat', product: { kind: 'candidate', code: 'tr-1' }, frequency: 'am', reason: 'Writer treat reason.', grounding: [] },
        { step: 'moisturise', product: { kind: 'candidate', code: 'mo-1' }, frequency: 'am', reason: 'Writer moisturise reason.', grounding: [] },
        { step: 'protect', product: { kind: 'candidate', code: 'pr-1' }, frequency: 'am', reason: 'Writer protect reason.', grounding: [] },
      ],
      tapers: [],
      expectation: 'Writer expectation.',
    }

    const result = spliceFixed(merge, written)

    expect(result.steps.map((e) => [e.step, e.fixedFrom === null, e.changedOn])).toEqual([['cleanse', true, null], ['treat', false, CHANGED], ['moisturise', false, null], ['protect', false, CHANGED]])
  })
})

// ---- sameProductBefore: whether a step the writer wrote is a change of product (spec #233, PR 4a) ----
describe('sameProductBefore: the previous step that holds the same product', () => {
  const before = (): StoredRoutineStep[] => [
    entry('cleanse', { kind: 'shelf', id: 'cleanser-1' }, 'am', []),
    entry('treat', { kind: 'candidate', code: 'tr-1' }, 'pm', []),
    entry('moisturise', { kind: 'none' }, 'am', []),
  ]
  const now = (step: RoutineStep, product: StoredRoutineStep['product']) => entry(step, product, 'am', [])

  it('finds the step with the same shelf entry, the same recommended code, or "use what you have" again', () => {
    expect(sameProductBefore(before(), now('cleanse', { kind: 'shelf', id: 'cleanser-1' }), {})?.step).toBe('cleanse')
    expect(sameProductBefore(before(), now('treat', { kind: 'candidate', code: 'tr-1' }), {})?.step).toBe('treat')
    expect(sameProductBefore(before(), now('moisturise', { kind: 'none' }), {})?.step).toBe('moisturise')
  })

  it('finds a recommended product the person has got as their own shelf entry of it', () => {
    expect(sameProductBefore(before(), now('treat', { kind: 'shelf', id: 'serum-own' }), { 'tr-1': 'serum-own' })?.step).toBe('treat')
  })

  it('finds nothing when the product at the step changed, was another shelf entry, or the step is new', () => {
    expect(sameProductBefore(before(), now('cleanse', { kind: 'shelf', id: 'cleanser-2' }), {})).toBeUndefined()
    expect(sameProductBefore(before(), now('treat', { kind: 'candidate', code: 'tr-2' }), {})).toBeUndefined()
    expect(sameProductBefore(before(), now('treat', { kind: 'shelf', id: 'serum-own' }), { 'tr-2': 'serum-own' })).toBeUndefined()
    expect(sameProductBefore(before(), now('moisturise', { kind: 'candidate', code: 'mo-1' }), {})).toBeUndefined()
    expect(sameProductBefore(before(), now('protect', { kind: 'none' }), {})).toBeUndefined()
  })

  it('does not match the same product at another step', () => {
    expect(sameProductBefore(before(), now('moisturise', { kind: 'candidate', code: 'tr-1' }), {})).toBeUndefined()
  })
})
