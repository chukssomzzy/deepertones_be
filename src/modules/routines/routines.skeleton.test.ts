import { describe, expect, it } from 'vitest'
import type { RoutineStep } from '../catalog/catalog.vocabulary'
import { LOW_CONFIDENCE_CONCERNS } from '../face-scans/face-scans.tables'
import type { Candidate } from '../recommendations/recommendations.types'
import type { SafetyChoice } from '../safety/safety.vocabulary'
import { assembleSkeleton, candidateOf, cautionsOf } from './routines.skeleton'
import { ROUTINE_ALLOWED_FREQUENCIES } from './routines.rules'
import type { CautionState, SkeletonShelfProduct } from './routines.types'

// assembleSkeleton is a pure function from facts already read (the goal, the scan, the safety choices, the shelf with its verdicts, and each step's candidates
// in the order the recommendation rules gave them) to the skeleton the writer sees. The same code builds the eval's skeletons and production's. Expected values
// below are worked out from the spec, not from the code under test.

const candidate = (code: string, over: Partial<Candidate> = {}): Candidate => ({
  code,
  product: { id: `product-${code}`, kind: 'named', brand: `Brand ${code}`, name: `Name ${code}`, variant: null, form: 'cream', category: 'skin', imageUrl: null },
  skinConcerns: ['hd_radiance'],
  ingredients: ['Aqua', 'Glycerin'],
  evidenceUrls: [`https://evidence.example/${code}`],
  ingredientsSourceUrl: `https://ingredients.example/${code}`,
  keyIngredient: null,
  strength: null,
  passed: ['country', 'step'],
  sharedWithReaction: [],
  origin: 'sourced',
  frequency: 'am-pm',
  priceMin: 1000,
  priceMax: 2000,
  whereSold: 'Pharmacies',
  ...over,
})

const shelfProduct = (id: string, over: Partial<SkeletonShelfProduct> = {}): SkeletonShelfProduct => ({
  id,
  brand: 'Shelf Brand',
  name: `Shelf ${id}`,
  ingredients: ['Aqua'],
  step: 'cleanse',
  verdict: { kind: 'keep' },
  sourceUrls: [],
  ...over,
})

const stopped = (id: string, step: RoutineStep | null = 'treat') => shelfProduct(id, { step, verdict: { kind: 'stop', taperTemplateId: `tpl-${id}` } })
const dropped = (id: string, step: RoutineStep | null = 'treat') => shelfProduct(id, { step, verdict: { kind: 'drop' } })

const input = (over: Partial<Parameters<typeof assembleSkeleton>[0]> = {}): Parameters<typeof assembleSkeleton>[0] => ({
  goal: 'even-tone',
  seen: [{ concern: 'hd_age_spot', level: 'some' }],
  alsoNoticed: [],
  skinType: 'combination',
  budgetBand: 'mid',
  safetyChoices: ['none'],
  shelf: [],
  candidates: {},
  hintsShown: false,
  ...over,
})

describe('assembleSkeleton: the steps and the gaps', () => {
  it('makes a gap of every step, each with no candidates, when nothing is on the shelf and nothing is on offer', () => {
    const skeleton = assembleSkeleton(input())

    expect(skeleton.steps).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
    expect(skeleton.gaps).toEqual([
      { step: 'cleanse', candidates: [] },
      { step: 'treat', candidates: [] },
      { step: 'moisturise', candidates: [] },
      { step: 'protect', candidates: [] },
    ])
  })

  it('leaves no gap for a step a kept or a reduced shelf product fills', () => {
    const shelf = [shelfProduct('cleanser', { step: 'cleanse' }), shelfProduct('cream', { step: 'moisturise', verdict: { kind: 'reduce', maxFrequency: 'pm' } })]

    const skeleton = assembleSkeleton(input({ shelf }))

    expect(skeleton.gaps.map((gap) => gap.step)).toEqual(['treat', 'protect'])
  })

  it('keeps a step a gap when the only shelf product for it is stopped, because a stopped product fills nothing', () => {
    const skeleton = assembleSkeleton(input({ shelf: [stopped('steroid', 'treat')] }))

    expect(skeleton.gaps.map((gap) => gap.step)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
  })

  it('keeps a step a gap when the only shelf product for it is dropped, because a dropped product fills nothing', () => {
    const skeleton = assembleSkeleton(input({ shelf: [dropped('toner', 'treat')] }))

    expect(skeleton.gaps.map((gap) => gap.step)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
  })

  it('does not let a kept shelf product with no step fill any gap', () => {
    const skeleton = assembleSkeleton(input({ shelf: [shelfProduct('clay-mask', { step: null })] }))

    expect(skeleton.gaps).toHaveLength(4)
  })

  it('fills a step with a kept product even when a stopped product also claims the step', () => {
    const shelf = [stopped('old-serum', 'treat'), shelfProduct('new-serum', { step: 'treat' })]

    const skeleton = assembleSkeleton(input({ shelf }))

    expect(skeleton.gaps.map((gap) => gap.step)).toEqual(['cleanse', 'moisturise', 'protect'])
  })

  it('keeps a reduced product whose step allows nothing within its cap as reduce, so it still fills its step, and allows the cap at that step', () => {
    // Every usual cleanse frequency (am, pm, am-pm) is more often than alternate-days, so the cap itself is allowed at cleanse.
    const capped = shelfProduct('wash', { step: 'cleanse', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' } })

    const skeleton = assembleSkeleton(input({ shelf: [capped], candidates: { cleanse: [candidate('cl-1')] } }))

    expect(skeleton.shelf).toEqual([capped])
    expect(skeleton.gaps.map((gap) => gap.step)).toEqual(['treat', 'moisturise', 'protect'])
    expect(skeleton.limits.allowed.cleanse).toEqual(['am', 'pm', 'am-pm', 'alternate-days'])
    expect(skeleton.limits.allowed.treat).toEqual(['pm', 'alternate-days', 'weekly', 'am', 'am-pm'])
    expect(skeleton.limits.maxNewProducts).toBe(0)
  })

  it('keeps a sunscreen the rules reduce, so it fills protect, is used every morning, and protect still allows only am', () => {
    const sunscreen = shelfProduct('spf', { step: 'protect', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' } })

    const skeleton = assembleSkeleton(input({ shelf: [sunscreen], candidates: { protect: [candidate('pr-1')] } }))

    expect(skeleton.shelf).toEqual([{ ...sunscreen, verdict: { kind: 'keep' } }])
    expect(skeleton.gaps.map((gap) => gap.step)).toEqual(['cleanse', 'treat', 'moisturise'])
    expect(skeleton.limits.allowed.protect).toEqual(['am'])
  })

  it('allows the cap once when two reduced products at a step share it, and not again once one cap makes the other satisfiable', () => {
    const wash = shelfProduct('wash', { step: 'cleanse', verdict: { kind: 'reduce', maxFrequency: 'weekly' } })
    const foam = shelfProduct('foam', { step: 'cleanse', verdict: { kind: 'reduce', maxFrequency: 'weekly' } })
    const gel = shelfProduct('gel', { step: 'cleanse', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' } })

    expect(assembleSkeleton(input({ shelf: [wash, foam] })).limits.allowed.cleanse).toEqual(['am', 'pm', 'am-pm', 'weekly'])
    // weekly is within gel's cap too, so gel needs nothing more.
    expect(assembleSkeleton(input({ shelf: [wash, gel] })).limits.allowed.cleanse).toEqual(['am', 'pm', 'am-pm', 'weekly'])
  })

  it('leaves the allowed frequencies as the rules list them when every reduce is satisfiable, and for one with no step', () => {
    const treat = shelfProduct('serum', { step: 'treat', verdict: { kind: 'reduce', maxFrequency: 'weekly' } })
    const moisturiser = shelfProduct('cream', { step: 'moisturise', verdict: { kind: 'reduce', maxFrequency: 'pm' } })
    const aftershave = shelfProduct('aftershave', { step: null, verdict: { kind: 'reduce', maxFrequency: 'as-needed' } })

    const skeleton = assembleSkeleton(input({ shelf: [treat, moisturiser, aftershave] }))

    expect(skeleton.shelf).toEqual([treat, moisturiser, aftershave])
    expect(skeleton.limits.allowed).toEqual(ROUTINE_ALLOWED_FREQUENCIES)
  })

  it('never changes the global allowed frequencies, whatever the shelf asks for', () => {
    const before = structuredClone(ROUTINE_ALLOWED_FREQUENCIES)

    assembleSkeleton(input({ shelf: [shelfProduct('wash', { step: 'cleanse', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' } })] }))

    expect(ROUTINE_ALLOWED_FREQUENCIES).toEqual(before)
  })

  it('lists the whole shelf, stopped and dropped products included, in the order it was given', () => {
    const shelf = [shelfProduct('a'), dropped('b'), stopped('c'), shelfProduct('d', { step: null })]

    expect(assembleSkeleton(input({ shelf })).shelf).toEqual(shelf)
  })

  it("gives each gap its step's candidates in the order they were given, as the writer sees them", () => {
    const skeleton = assembleSkeleton(input({ candidates: { moisturise: [candidate('mo-2'), candidate('mo-1')], protect: [candidate('pr-1')] } }))

    expect(skeleton.gaps.find((gap) => gap.step === 'moisturise')!.candidates.map((c) => c.code)).toEqual(['mo-2', 'mo-1'])
    expect(skeleton.gaps.find((gap) => gap.step === 'protect')!.candidates.map((c) => c.code)).toEqual(['pr-1'])
    expect(skeleton.gaps.find((gap) => gap.step === 'cleanse')!.candidates).toEqual([])
  })

  it('ignores candidates offered for a step the shelf already fills', () => {
    const skeleton = assembleSkeleton(input({ shelf: [shelfProduct('cleanser', { step: 'cleanse' })], candidates: { cleanse: [candidate('cl-1')] } }))

    expect(skeleton.gaps.map((gap) => gap.step)).not.toContain('cleanse')
    expect(skeleton.limits.maxNewProducts).toBe(0)
  })
})

describe('assembleSkeleton: limits', () => {
  it('allows the frequencies the routine rules list for each step, as its own copy', () => {
    const skeleton = assembleSkeleton(input())

    expect(skeleton.limits.allowed).toEqual(ROUTINE_ALLOWED_FREQUENCIES)
    skeleton.limits.allowed.cleanse.push('weekly')
    expect(ROUTINE_ALLOWED_FREQUENCIES.cleanse).not.toContain('weekly')
  })

  it('allows one new product per gap that has a candidate, not one per gap', () => {
    // Four gaps; only treat and protect have anything on offer.
    const skeleton = assembleSkeleton(input({ candidates: { treat: [candidate('tr-1'), candidate('tr-2')], protect: [candidate('pr-1')] } }))

    expect(skeleton.gaps).toHaveLength(4)
    expect(skeleton.limits.maxNewProducts).toBe(2)
  })

  it('allows no new products when no gap has a candidate', () => {
    expect(assembleSkeleton(input()).limits.maxNewProducts).toBe(0)
  })
})

describe('assembleSkeleton: the person', () => {
  it('carries the goal, what the scan showed, the skin type and the budget band as given', () => {
    const skeleton = assembleSkeleton(
      input({
        goal: 'fade-dark-marks',
        seen: [{ concern: 'hd_age_spot', level: 'a-little' }, { concern: 'hd_radiance', level: 'clear' }],
        alsoNoticed: [{ concern: 'hd_pore', level: 'some' }],
        skinType: 'oily',
        budgetBand: 'low',
      }),
    )

    expect(skeleton.goal).toBe('fade-dark-marks')
    expect(skeleton.person.seen).toEqual([{ concern: 'hd_age_spot', level: 'a-little' }, { concern: 'hd_radiance', level: 'clear' }])
    expect(skeleton.person.alsoNoticed).toEqual([{ concern: 'hd_pore', level: 'some' }])
    expect(skeleton.person.skinType).toBe('oily')
    expect(skeleton.person.budgetBand).toBe('low')
  })

  it('carries a missing skin type and a missing budget as null', () => {
    const skeleton = assembleSkeleton(input({ skinType: null, budgetBand: null }))

    expect(skeleton.person.skinType).toBeNull()
    expect(skeleton.person.budgetBand).toBeNull()
  })

  it('marks the concerns the scan is unsure of as low confidence', () => {
    expect(assembleSkeleton(input()).person.lowConfidence).toEqual([...LOW_CONFIDENCE_CONCERNS])
  })

  it('states a caution for each safety answer', () => {
    const skeleton = assembleSkeleton(input({ safetyChoices: ['pregnant', 'reaction'] }))

    expect(skeleton.person.cautions).toEqual(['pregnant', 'recent-reaction'])
  })

  it('states the tapering caution when the rules stop a shelf product, with no safety answer needed', () => {
    const skeleton = assembleSkeleton(input({ safetyChoices: ['none'], shelf: [stopped('steroid')] }))

    expect(skeleton.person.cautions).toEqual(['tapering'])
  })

  it('records whether outcome hints were shown, either way', () => {
    expect(assembleSkeleton(input({ hintsShown: true })).hintsShown).toBe(true)
    expect(assembleSkeleton(input({ hintsShown: false })).hintsShown).toBe(false)
  })

  it('does not change what it was given', () => {
    const shelf = [shelfProduct('cleanser'), stopped('steroid')]
    const candidates = { treat: [candidate('tr-1')] }
    const before = structuredClone({ shelf, candidates })

    assembleSkeleton(input({ shelf, candidates }))

    expect({ shelf, candidates }).toEqual(before)
  })
})

describe('cautionsOf', () => {
  const cases: [SafetyChoice, CautionState][] = [
    ['pregnant', 'pregnant'],
    ['breastfeeding', 'breastfeeding'],
    ['reaction', 'recent-reaction'],
    ['prescription', 'prescription'],
  ]

  it.each(cases)('turns the %s answer into the %s caution', (choice, caution) => {
    expect(cautionsOf([choice], [])).toEqual([caution])
  })

  it('states no caution for "none" and an empty shelf', () => {
    expect(cautionsOf(['none'], [])).toEqual([])
  })

  it('states tapering when any shelf product is stopped', () => {
    expect(cautionsOf(['none'], [shelfProduct('a'), stopped('b')])).toEqual(['tapering'])
  })

  it('does not state tapering for kept, reduced or dropped products', () => {
    const shelf = [shelfProduct('a'), shelfProduct('b', { verdict: { kind: 'reduce', maxFrequency: 'weekly' } }), dropped('c')]

    expect(cautionsOf(['none'], shelf)).toEqual([])
  })

  it('lists every caution once, in the fixed order the writer is given, whatever order the answers came in', () => {
    const shelf = [stopped('a'), stopped('b')]

    expect(cautionsOf(['prescription', 'reaction', 'breastfeeding', 'pregnant'], shelf)).toEqual(['pregnant', 'breastfeeding', 'tapering', 'recent-reaction', 'prescription'])
  })

  it('lists a caution once when the same answer is given twice', () => {
    expect(cautionsOf(['pregnant', 'pregnant'], [])).toEqual(['pregnant'])
  })
})

describe('candidateOf', () => {
  it('flattens the product, keeps what the writer may choose by, and drops who put the product forward', () => {
    const result = candidateOf(
      candidate('mo-1', {
        origin: 'brand-submitted',
        skinConcerns: ['hd_moisture', 'hd_radiance'],
        ingredients: ['Aqua', 'Shea Butter'],
        frequency: 'pm',
        priceMin: 3000,
        priceMax: 4500,
        evidenceUrls: ['https://evidence.example/a', 'https://evidence.example/b'],
        ingredientsSourceUrl: null,
        product: { id: 'p1', kind: 'named', brand: 'Deep Dew', name: 'Moisturising Cream', variant: null, form: 'gel', category: 'skin', imageUrl: 'https://img.example/x.png' },
      }),
    )

    expect(result).toEqual({
      code: 'mo-1',
      brand: 'Deep Dew',
      name: 'Moisturising Cream',
      form: 'gel',
      ingredients: ['Aqua', 'Shea Butter'],
      skinConcerns: ['hd_moisture', 'hd_radiance'],
      frequency: 'pm',
      priceMin: 3000,
      priceMax: 4500,
      evidenceUrls: ['https://evidence.example/a', 'https://evidence.example/b'],
      ingredientsSourceUrl: null,
      outcomeHint: null,
    })
    expect('origin' in result).toBe(false)
  })

  it('has no outcome hint unless one is given', () => {
    expect(candidateOf(candidate('a')).outcomeHint).toBeNull()
  })

  it('attaches the outcome hint it is given', () => {
    expect(candidateOf(candidate('a'), { n: 42, netFainter: 7 }).outcomeHint).toEqual({ n: 42, netFainter: 7 })
  })

  it('never lets origin reach a skeleton, whoever put the product forward', () => {
    const skeleton = assembleSkeleton(input({ candidates: { treat: [candidate('tr-1', { origin: 'brand-submitted' })] } }))

    expect(JSON.stringify(skeleton)).not.toContain('brand-submitted')
    expect(skeleton.gaps.find((gap) => gap.step === 'treat')!.candidates[0]).not.toHaveProperty('origin')
  })
})
