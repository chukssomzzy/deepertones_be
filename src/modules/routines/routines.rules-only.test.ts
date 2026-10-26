import { describe, expect, it } from 'vitest'
import { ROUTINE_STEPS, type Frequency, type RoutineStep } from '../catalog/catalog.vocabulary'
import { answerFor } from '../goals/goals.answers'
import { GOALS } from '../goals/goals.vocabulary'
import { checkRoutine, FREQUENCY_RANK } from './routines.gates'
import { ROUTINE_ALLOWED_FREQUENCIES, maxNewProductsFor } from './routines.rules'
import { rulesOnlyRoutine } from './routines.rules-only'
import { assembleSkeleton } from './routines.skeleton'
import type { CautionState, Routine, RoutineSkeleton, ShelfVerdict, SkeletonCandidate, SkeletonGap, SkeletonShelfProduct } from './routines.types'
import { FORBIDDEN_WORDING } from './routines.wording'

// The rules-only routine is what the app saves when the writer cannot be used (it failed twice, or the day's limit is spent). It is built by code from the
// skeleton alone, so it must always pass every gate, and its words are fixed. The headline test is that checkRoutine finds nothing wrong with it for a spread
// of skeletons. Expected frequencies are worked out from ROUTINE_ALLOWED_FREQUENCIES in routines.rules.ts: cleanse am/pm/am-pm, treat pm/alternate-days/weekly/am/
// am-pm, moisturise am/pm/am-pm, protect am.

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
  evidenceUrls: [`https://evidence.example/${code}`],
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
    goal: 'even-tone',
    person: { seen: [{ concern: 'hd_age_spot', level: 'some' }], alsoNoticed: [], skinType: 'combination', lowConfidence: [], cautions: [], budgetBand: 'mid' },
    steps: [...ROUTINE_STEPS],
    shelf,
    gaps,
    limits: { allowed: structuredClone(ROUTINE_ALLOWED_FREQUENCIES), maxNewProducts: maxNewProductsFor(gaps) },
    hintsShown: false,
    ...over,
  }
}

const entryFor = (routine: Routine, step: RoutineStep) => routine.steps.filter((e) => e.step === step)

/** Built by assembleSkeleton, not by hand: the cap a reduced product's step cannot otherwise write is allowed there by the assembler, and this spread must prove the two agree. */
const assembled = (shelf: SkeletonShelfProduct[]): RoutineSkeleton =>
  assembleSkeleton({ goal: 'even-tone', seen: [], alsoNoticed: [], skinType: null, budgetBand: null, safetyChoices: ['none'], shelf, candidates: {}, hintsShown: false })

const SPREAD: [string, RoutineSkeleton][] = [
  ['an empty shelf and nothing on offer', skeletonOf([])],
  ['an empty shelf and a candidate for every step', skeletonOf([], { cleanse: [candidate('cl-1')], treat: [candidate('tr-1')], moisturise: [candidate('mo-1')], protect: [candidate('pr-1')] })],
  ['a kept product at every step', skeletonOf([shelfProduct('c', 'cleanse'), shelfProduct('t', 'treat'), shelfProduct('m', 'moisturise'), shelfProduct('p', 'protect')])],
  ['a treat product reduced to weekly', skeletonOf([shelfProduct('t', 'treat', { kind: 'reduce', maxFrequency: 'weekly' })])],
  ['a treat product reduced to alternate days', skeletonOf([shelfProduct('t', 'treat', { kind: 'reduce', maxFrequency: 'alternate-days' })])],
  ['a cleanser reduced to alternate days, which no usual cleanse frequency honours', assembled([shelfProduct('c', 'cleanse', { kind: 'reduce', maxFrequency: 'alternate-days' })])],
  ['a sunscreen the rules reduce to alternate days, which is kept and used every morning', assembled([shelfProduct('p', 'protect', { kind: 'reduce', maxFrequency: 'alternate-days' })])],
  ['a moisturiser reduced to pm', skeletonOf([shelfProduct('m', 'moisturise', { kind: 'reduce', maxFrequency: 'pm' })])],
  ['a stopped treat product with its taper', skeletonOf([shelfProduct('s', 'treat', { kind: 'stop', taperTemplateId: 'tpl-steroid' })], { treat: [candidate('tr-1', { frequency: 'pm' })] })],
  ['a stopped product that fills no step', skeletonOf([shelfProduct('s', null, { kind: 'stop', taperTemplateId: 'tpl-lightening' })])],
  ['two stopped products', skeletonOf([shelfProduct('s1', 'treat', { kind: 'stop', taperTemplateId: 'tpl-a' }), shelfProduct('s2', 'cleanse', { kind: 'stop', taperTemplateId: 'tpl-b' })])],
  ['a dropped product, whose step is a gap', skeletonOf([shelfProduct('d', 'treat', { kind: 'drop' })], { treat: [candidate('tr-1', { frequency: 'pm' })] })],
  ['a dropped product and nothing on offer', skeletonOf([shelfProduct('d', 'moisturise', { kind: 'drop' })])],
  ['a gap with no candidates beside a gap with one', skeletonOf([shelfProduct('c', 'cleanse')], { protect: [candidate('pr-1')] })],
  ['a candidate whose own frequency is not allowed for its step (weekly moisturiser)', skeletonOf([], { moisturise: [candidate('mo-1', { frequency: 'weekly' })] })],
  ['a protect candidate whose own frequency is am-pm', skeletonOf([], { protect: [candidate('pr-1', { frequency: 'am-pm' })] })],
  ['a cleanser candidate whose own frequency is as-needed', skeletonOf([], { cleanse: [candidate('cl-1', { frequency: 'as-needed' })] })],
  ['several candidates for one step', skeletonOf([], { moisturise: [candidate('mo-1', { frequency: 'pm' }), candidate('mo-2'), candidate('mo-3')] })],
  ['no-label style shelf products with no brand', skeletonOf([{ ...shelfProduct('n', 'treat', { kind: 'stop', taperTemplateId: 'tpl-x' }), brand: null }, { ...shelfProduct('k', 'cleanse'), brand: null }])],
]

describe('rulesOnlyRoutine: it always passes every gate', () => {
  it('writes a sunscreen the rules reduce at am, every morning', () => {
    const skeleton = assembled([shelfProduct('p', 'protect', { kind: 'reduce', maxFrequency: 'alternate-days' })])

    const routine = rulesOnlyRoutine(skeleton)

    expect(entryFor(routine, 'protect')).toEqual([expect.objectContaining({ product: { kind: 'shelf', id: 'p' }, frequency: 'am' })])
    expect(checkRoutine(skeleton, routine)).toEqual([])
  })

  it('writes a cleanser reduced to alternate days at alternate days', () => {
    const skeleton = assembled([shelfProduct('c', 'cleanse', { kind: 'reduce', maxFrequency: 'alternate-days' })])

    const routine = rulesOnlyRoutine(skeleton)

    expect(entryFor(routine, 'cleanse')).toEqual([expect.objectContaining({ product: { kind: 'shelf', id: 'c' }, frequency: 'alternate-days' })])
    expect(checkRoutine(skeleton, routine)).toEqual([])
  })

  it.each(SPREAD)('for %s', (_name, skeleton) => {
    expect(checkRoutine(skeleton, rulesOnlyRoutine(skeleton))).toEqual([])
  })

  it.each(GOALS)('for the %s goal, with its expectation in plain words', (goal) => {
    const skeleton = skeletonOf([shelfProduct('c', 'cleanse')], { treat: [candidate('tr-1', { frequency: 'pm' })] }, { goal })

    expect(checkRoutine(skeleton, rulesOnlyRoutine(skeleton))).toEqual([])
  })

  const CAUTIONS: CautionState[] = ['pregnant', 'breastfeeding', 'tapering', 'recent-reaction', 'prescription']
  it.each(CAUTIONS)('for the %s caution', (caution) => {
    const base = skeletonOf([shelfProduct('t', 'treat', { kind: 'reduce', maxFrequency: 'weekly' })], { moisturise: [candidate('mo-1')] })
    const skeleton = { ...base, person: { ...base.person, cautions: [caution] } }

    expect(checkRoutine(skeleton, rulesOnlyRoutine(skeleton))).toEqual([])
  })

  it('for every goal with every caution at once', () => {
    for (const goal of GOALS) {
      const base = skeletonOf([shelfProduct('s', 'treat', { kind: 'stop', taperTemplateId: 'tpl-s' })], { treat: [candidate('tr-1', { frequency: 'pm' })], protect: [candidate('pr-1')] }, { goal })
      const skeleton = { ...base, person: { ...base.person, cautions: ['pregnant', 'breastfeeding', 'tapering', 'recent-reaction', 'prescription'] as CautionState[] } }

      expect(checkRoutine(skeleton, rulesOnlyRoutine(skeleton)), goal).toEqual([])
    }
  })
})

describe('rulesOnlyRoutine: kept and reduced shelf products', () => {
  it('uses a kept product at its own step, at the first frequency allowed for the step', () => {
    const skeleton = skeletonOf([shelfProduct('c', 'cleanse'), shelfProduct('t', 'treat'), shelfProduct('m', 'moisturise'), shelfProduct('p', 'protect')])

    const routine = rulesOnlyRoutine(skeleton)

    expect(routine.steps.map((e) => [e.step, e.product, e.frequency])).toEqual([
      ['cleanse', { kind: 'shelf', id: 'c' }, 'am'],
      ['treat', { kind: 'shelf', id: 't' }, 'pm'],
      ['moisturise', { kind: 'shelf', id: 'm' }, 'am'],
      ['protect', { kind: 'shelf', id: 'p' }, 'am'],
    ])
  })

  it('writes the steps in routine order, one entry per step when each step has one product', () => {
    const routine = rulesOnlyRoutine(skeletonOf([shelfProduct('m', 'moisturise')], { protect: [candidate('pr-1')] }))

    expect(routine.steps.map((e) => e.step)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
  })

  it('uses every kept product when two fill the same step', () => {
    const skeleton = skeletonOf([shelfProduct('t1', 'treat'), shelfProduct('t2', 'treat')])

    const routine = rulesOnlyRoutine(skeleton)

    expect(entryFor(routine, 'treat').map((e) => e.product)).toEqual([{ kind: 'shelf', id: 't1' }, { kind: 'shelf', id: 't2' }])
    expect(checkRoutine(skeleton, routine)).toEqual([])
  })

  it('reduces a product capped at weekly to weekly', () => {
    const routine = rulesOnlyRoutine(skeletonOf([shelfProduct('t', 'treat', { kind: 'reduce', maxFrequency: 'weekly' })]))

    expect(entryFor(routine, 'treat')[0]!.frequency).toBe('weekly')
  })

  it('reduces a product capped at alternate days to alternate days, the most often the cap allows', () => {
    const routine = rulesOnlyRoutine(skeletonOf([shelfProduct('t', 'treat', { kind: 'reduce', maxFrequency: 'alternate-days' })]))

    expect(entryFor(routine, 'treat')[0]!.frequency).toBe('alternate-days')
  })

  it('never writes a reduced product more often than its cap', () => {
    const caps: Frequency[] = ['weekly', 'alternate-days', 'am', 'pm', 'am-pm']
    for (const maxFrequency of caps) {
      const routine = rulesOnlyRoutine(skeletonOf([shelfProduct('t', 'treat', { kind: 'reduce', maxFrequency })]))
      const frequency = entryFor(routine, 'treat')[0]!.frequency

      expect(FREQUENCY_RANK[frequency], `capped at ${maxFrequency}`).toBeLessThanOrEqual(FREQUENCY_RANK[maxFrequency])
      expect(ROUTINE_ALLOWED_FREQUENCIES.treat, `capped at ${maxFrequency}`).toContain(frequency)
    }
  })
})

describe('rulesOnlyRoutine: gaps', () => {
  it('fills a gap with its first candidate, the cheapest the skeleton lists first', () => {
    const routine = rulesOnlyRoutine(skeletonOf([], { moisturise: [candidate('mo-1', { frequency: 'pm' }), candidate('mo-2')] }))

    expect(entryFor(routine, 'moisturise').map((e) => e.product)).toEqual([{ kind: 'candidate', code: 'mo-1' }])
  })

  it("uses the candidate's own frequency when it is allowed for the step", () => {
    const routine = rulesOnlyRoutine(skeletonOf([], { moisturise: [candidate('mo-1', { frequency: 'pm' })], treat: [candidate('tr-1', { frequency: 'alternate-days' })] }))

    expect(entryFor(routine, 'moisturise')[0]!.frequency).toBe('pm')
    expect(entryFor(routine, 'treat')[0]!.frequency).toBe('alternate-days')
  })

  it("uses the step's first allowed frequency when the candidate's own is not allowed", () => {
    const routine = rulesOnlyRoutine(skeletonOf([], { moisturise: [candidate('mo-1', { frequency: 'weekly' })], protect: [candidate('pr-1', { frequency: 'am-pm' })], cleanse: [candidate('cl-1', { frequency: 'as-needed' })] }))

    expect(entryFor(routine, 'moisturise')[0]!.frequency).toBe('am')
    expect(entryFor(routine, 'protect')[0]!.frequency).toBe('am')
    expect(entryFor(routine, 'cleanse')[0]!.frequency).toBe('am')
  })

  it('says "use what you have" for a gap with no candidates, at the step\'s first allowed frequency', () => {
    const routine = rulesOnlyRoutine(skeletonOf([]))

    expect(routine.steps.map((e) => [e.step, e.product, e.frequency])).toEqual([
      ['cleanse', { kind: 'none' }, 'am'],
      ['treat', { kind: 'none' }, 'pm'],
      ['moisturise', { kind: 'none' }, 'am'],
      ['protect', { kind: 'none' }, 'am'],
    ])
  })

  it('leaves out a stopped or a dropped product and fills its step as a gap', () => {
    const skeleton = skeletonOf([shelfProduct('s', 'treat', { kind: 'stop', taperTemplateId: 'tpl-s' }), shelfProduct('d', 'cleanse', { kind: 'drop' })], { treat: [candidate('tr-1', { frequency: 'pm' })] })

    const routine = rulesOnlyRoutine(skeleton)

    expect(routine.steps.some((e) => e.product.kind === 'shelf')).toBe(false)
    expect(entryFor(routine, 'treat')[0]!.product).toEqual({ kind: 'candidate', code: 'tr-1' })
    expect(entryFor(routine, 'cleanse')[0]!.product).toEqual({ kind: 'none' })
  })

  it('asks for no more new products than the skeleton allows', () => {
    const skeleton = skeletonOf([], { cleanse: [candidate('cl-1')], treat: [candidate('tr-1')], moisturise: [candidate('mo-1')], protect: [candidate('pr-1')] })

    const codes = new Set(rulesOnlyRoutine(skeleton).steps.flatMap((e) => (e.product.kind === 'candidate' ? [e.product.code] : [])))

    expect(codes.size).toBeLessThanOrEqual(skeleton.limits.maxNewProducts)
  })
})

describe('rulesOnlyRoutine: tapers, grounding and the expectation', () => {
  it('has no tapers when nothing is stopped', () => {
    expect(rulesOnlyRoutine(skeletonOf([shelfProduct('c', 'cleanse'), shelfProduct('d', 'treat', { kind: 'drop' })])).tapers).toEqual([])
  })

  it('has one taper per stopped product, naming its approved template, in shelf order', () => {
    const skeleton = skeletonOf([
      shelfProduct('s1', 'treat', { kind: 'stop', taperTemplateId: 'tpl-steroid' }),
      shelfProduct('k', 'cleanse'),
      shelfProduct('s2', null, { kind: 'stop', taperTemplateId: 'tpl-lightening' }),
    ])

    expect(rulesOnlyRoutine(skeleton).tapers).toEqual([
      { shelfProductId: 's1', templateId: 'tpl-steroid' },
      { shelfProductId: 's2', templateId: 'tpl-lightening' },
    ])
  })

  it('cites nothing: every entry has empty grounding, even for a candidate with links and a product with sources', () => {
    const skeleton = skeletonOf([shelfProduct('c', 'cleanse')], { treat: [candidate('tr-1', { ingredientsSourceUrl: 'https://ingredients.example/tr-1' })] })

    const routine = rulesOnlyRoutine(skeleton)

    expect(routine.steps.length).toBeGreaterThan(0)
    for (const entry of routine.steps) expect(entry.grounding).toEqual([])
  })

  it.each(GOALS)("expects what the %s goal's answer says about how long it takes", (goal) => {
    const routine = rulesOnlyRoutine(skeletonOf([], {}, { goal }))

    expect(routine.expectation).toBe(answerFor(goal, false).howLong)
    expect(routine.expectation.length).toBeGreaterThan(0)
  })

  it('does not change the skeleton it is given', () => {
    const skeleton = skeletonOf([shelfProduct('s', 'treat', { kind: 'stop', taperTemplateId: 'tpl-s' })], { treat: [candidate('tr-1')] })
    const before = structuredClone(skeleton)

    rulesOnlyRoutine(skeleton)

    expect(skeleton).toEqual(before)
  })

  it('is the same routine every time for the same skeleton', () => {
    const skeleton = skeletonOf([shelfProduct('c', 'cleanse')], { protect: [candidate('pr-1')] })

    expect(rulesOnlyRoutine(skeleton)).toEqual(rulesOnlyRoutine(structuredClone(skeleton)))
  })
})

describe('rulesOnlyRoutine: its words', () => {
  const everyLine = (): string[] => {
    const lines = new Set<string>()
    for (const goal of GOALS) {
      // Each step, with each kind of product: kept, reduced, a recommended candidate, and nothing to recommend.
      const kept = skeletonOf([shelfProduct('c', 'cleanse'), shelfProduct('t', 'treat'), shelfProduct('m', 'moisturise'), shelfProduct('p', 'protect')], {}, { goal })
      const reduced = skeletonOf(
        [shelfProduct('c', 'cleanse', { kind: 'reduce', maxFrequency: 'pm' }), shelfProduct('t', 'treat', { kind: 'reduce', maxFrequency: 'weekly' }), shelfProduct('m', 'moisturise', { kind: 'reduce', maxFrequency: 'pm' }), shelfProduct('p', 'protect', { kind: 'reduce', maxFrequency: 'am' })],
        {},
        { goal },
      )
      const recommended = skeletonOf([], { cleanse: [candidate('cl-1')], treat: [candidate('tr-1', { frequency: 'pm' })], moisturise: [candidate('mo-1')], protect: [candidate('pr-1')] }, { goal })
      const nothing = skeletonOf([], {}, { goal })
      for (const skeleton of [kept, reduced, recommended, nothing]) {
        const routine = rulesOnlyRoutine(skeleton)
        for (const entry of routine.steps) lines.add(entry.reason)
        lines.add(routine.expectation)
      }
    }
    return [...lines]
  }

  it('passes the wording gate in every reason and every expectation, for every goal', () => {
    for (const line of everyLine()) {
      for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(line), `"${line}" trips ${code}`).toBe(false)
    }
  })

  it('has a plain, non-empty reason for every entry', () => {
    for (const entry of rulesOnlyRoutine(skeletonOf([], {})).steps) expect(entry.reason.trim().length).toBeGreaterThan(0)
  })

  it('gives a reason that does not depend on which product it is, so it is a fixed line per step', () => {
    const one = rulesOnlyRoutine(skeletonOf([{ ...shelfProduct('a', 'cleanse'), name: 'Alpha Wash', brand: 'Alpha' }]))
    const other = rulesOnlyRoutine(skeletonOf([{ ...shelfProduct('b', 'cleanse'), name: 'Beta Foam', brand: 'Beta' }]))

    expect(entryFor(one, 'cleanse')[0]!.reason).toBe(entryFor(other, 'cleanse')[0]!.reason)
  })

  it('gives a reason that does not depend on the person, so it is the same for two goals', () => {
    const calm = rulesOnlyRoutine(skeletonOf([shelfProduct('c', 'cleanse')], {}, { goal: 'calm-repair' }))
    const glow = rulesOnlyRoutine(skeletonOf([shelfProduct('c', 'cleanse')], {}, { goal: 'glow' }))

    expect(entryFor(calm, 'cleanse')[0]!.reason).toBe(entryFor(glow, 'cleanse')[0]!.reason)
  })

  it('does not name the product, so a reason can never quote a brand', () => {
    const skeleton = skeletonOf([{ ...shelfProduct('a', 'cleanse'), name: 'Zorbax Wash', brand: 'Zorbax' }], { treat: [candidate('tr-1', { brand: 'Quillon', name: 'Quillon Serum' })] })

    for (const entry of rulesOnlyRoutine(skeleton).steps) expect(entry.reason).not.toMatch(/zorbax|quillon/i)
  })

  it('says something different for using what you have than for a recommended product at the same step', () => {
    const none = rulesOnlyRoutine(skeletonOf([]))
    const recommended = rulesOnlyRoutine(skeletonOf([], { moisturise: [candidate('mo-1')] }))

    expect(entryFor(none, 'moisturise')[0]!.reason).not.toBe(entryFor(recommended, 'moisturise')[0]!.reason)
  })
})
