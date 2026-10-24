import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Frequency, RoutineStep } from '../catalog/catalog.vocabulary'
import { checkRoutine, FREQUENCY_RANK } from './routines.gates'
import type { GateCode, GateFailure, Routine, RoutineEntry, RoutineProduct, RoutineSkeleton, SkeletonCandidate, SkeletonShelfProduct } from './routines.types'

// ---- builders: one valid skeleton and one valid routine for it, so each failing case changes one thing ----

const candidate = (code: string, overrides: Partial<SkeletonCandidate> = {}): SkeletonCandidate => ({
  code,
  brand: 'Brand',
  name: `Product ${code}`,
  form: 'cream',
  ingredients: ['Aqua', 'Glycerin'],
  skinConcerns: ['hd_moisture'],
  frequency: 'am-pm',
  priceMin: 5,
  priceMax: 10,
  evidenceUrls: [`https://evidence.example/${code}/a`, `https://evidence.example/${code}/b`],
  ingredientsSourceUrl: `https://ingredients.example/${code}`,
  outcomeHint: null,
  ...overrides,
})

const shelfProduct = (id: string, overrides: Partial<SkeletonShelfProduct> = {}): SkeletonShelfProduct => ({
  id,
  brand: 'Shelf Brand',
  name: `Shelf ${id}`,
  ingredients: ['Aqua'],
  step: 'cleanse',
  verdict: { kind: 'keep' },
  sourceUrls: [`https://rules.example/${id}`],
  ...overrides,
})

// Shelf: two kept cleansers, a serum to cut back to alternate days, and a retinoid to stop (its taper is tpl-retinoid).
// Gaps: moisturise (two candidates) and protect (one). So a valid routine uses two new products.
const skeleton = (overrides: Partial<RoutineSkeleton> = {}): RoutineSkeleton => ({
  goal: 'even-tone',
  person: { seen: [{ concern: 'hd_age_spot', level: 'some' }], alsoNoticed: [], skinType: 'combination', lowConfidence: [], cautions: [], budgetBand: 'mid' },
  steps: ['cleanse', 'treat', 'moisturise', 'protect'],
  shelf: [
    shelfProduct('cleanser-1'),
    shelfProduct('cleanser-2'),
    shelfProduct('serum-1', { step: 'treat', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' } }),
    shelfProduct('retinol-1', { step: 'treat', verdict: { kind: 'stop', taperTemplateId: 'tpl-retinoid' } }),
  ],
  gaps: [
    { step: 'moisturise', candidates: [candidate('mo-1'), candidate('mo-2')] },
    { step: 'protect', candidates: [candidate('pr-1')] },
  ],
  limits: {
    allowed: {
      cleanse: ['am', 'pm', 'am-pm'],
      treat: ['pm', 'alternate-days', 'weekly', 'as-needed'],
      moisturise: ['am', 'pm', 'am-pm'],
      // am-pm is allowed here on purpose, so the "protect is am only" rule is what a protect am-pm entry trips, not the allowed list.
      protect: ['am', 'am-pm'],
    },
    maxNewProducts: 2,
  },
  hintsShown: false,
  ...overrides,
})

const entry = (step: RoutineStep, product: RoutineProduct, frequency: Frequency, overrides: Partial<RoutineEntry> = {}): RoutineEntry => ({
  step,
  product,
  frequency,
  reason: 'Gentle on skin that is still settling.',
  grounding: [],
  ...overrides,
})

const shelfEntry = (step: RoutineStep, id: string, frequency: Frequency, overrides: Partial<RoutineEntry> = {}) => entry(step, { kind: 'shelf', id }, frequency, overrides)
const candidateEntry = (step: RoutineStep, code: string, frequency: Frequency, overrides: Partial<RoutineEntry> = {}) => entry(step, { kind: 'candidate', code }, frequency, overrides)

const validSteps = (): RoutineEntry[] => [
  shelfEntry('cleanse', 'cleanser-1', 'am-pm'),
  shelfEntry('treat', 'serum-1', 'alternate-days'),
  candidateEntry('moisturise', 'mo-1', 'am-pm'),
  candidateEntry('protect', 'pr-1', 'am'),
]

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  steps: validSteps(),
  tapers: [{ shelfProductId: 'retinol-1', templateId: 'tpl-retinoid' }],
  expectation: 'Most people see a change in 8 to 12 weeks.',
  ...overrides,
})

/** The valid routine plus extra entries, each placed after the valid entries for its own step so the routine stays in routine order. */
const withExtraEntries = (...extra: RoutineEntry[]): Routine => {
  const order: RoutineStep[] = ['cleanse', 'treat', 'moisturise', 'protect']
  const steps = [...validSteps(), ...extra].sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step))
  return routine({ steps })
}

const gatesOf = (failures: GateFailure[]): GateCode[] => failures.map((f) => f.gate)

describe('checkRoutine', () => {
  it('passes a routine that follows every rule', () => {
    expect(checkRoutine(skeleton(), routine())).toEqual([])
  })

  describe('parse', () => {
    it.each([
      ['null', null],
      ['a string', 'use cleanser'],
      ['an empty object', {}],
      ['a routine with an unknown frequency', routine({ steps: [shelfEntry('cleanse', 'cleanser-1', 'hourly' as Frequency)] })],
      ['a routine with an extra field', { ...routine(), confidence: 0.9 }],
    ])('rejects %s as a parse failure', (_name, input) => {
      expect(checkRoutine(skeleton(), input)).toEqual([{ gate: 'parse', step: null }])
    })

    it('checks nothing else once the routine does not parse, even if it would also break other rules', () => {
      // Missing tapers, a stopped product in use and a forbidden word would each fail a gate; but a missing field fails parse alone.
      const broken = { steps: [shelfEntry('cleanse', 'retinol-1', 'am-pm', { reason: 'You have melasma.' })], expectation: 'Soon.' }

      expect(checkRoutine(skeleton(), broken)).toEqual([{ gate: 'parse', step: null }])
    })
  })

  describe('unknown-product', () => {
    it('fails a shelf entry naming a product that is not on the shelf', () => {
      expect(checkRoutine(skeleton(), withExtraEntries(shelfEntry('cleanse', 'ghost', 'am')))).toEqual([{ gate: 'unknown-product', step: 'cleanse' }])
    })

    it('fails a shelf entry used at a step other than the product\'s own', () => {
      // cleanser-1 fills cleanse; as the moisturiser entry it is unknown (and the gap is left unfilled by it).
      const steps = validSteps()
      steps[2] = shelfEntry('moisturise', 'cleanser-1', 'am-pm')

      expect(checkRoutine(skeleton(), routine({ steps }))).toContainEqual({ gate: 'unknown-product', step: 'moisturise' })
    })

    it('fails a shelf entry whose product fills no step', () => {
      const noStep = skeleton({ shelf: [...skeleton().shelf, shelfProduct('stray-1', { step: null })] })

      expect(checkRoutine(noStep, withExtraEntries(shelfEntry('cleanse', 'stray-1', 'pm')))).toEqual([{ gate: 'unknown-product', step: 'cleanse' }])
    })

    it('passes a second shelf entry naming another kept product', () => {
      expect(checkRoutine(skeleton(), withExtraEntries(shelfEntry('cleanse', 'cleanser-2', 'pm')))).toEqual([])
    })

    it('fails a candidate entry whose code is in no gap', () => {
      expect(checkRoutine(skeleton(), withExtraEntries(candidateEntry('moisturise', 'nowhere-1', 'pm')))).toEqual([{ gate: 'unknown-product', step: 'moisturise' }])
    })

    it('fails a candidate entry that belongs to a different step\'s gap', () => {
      // mo-1 is a moisturise candidate; using it again under protect is not allowed (it does not add a new product, so only this gate trips).
      expect(checkRoutine(skeleton(), withExtraEntries(candidateEntry('protect', 'mo-1', 'am')))).toEqual([{ gate: 'unknown-product', step: 'protect' }])
    })

    it('passes a second candidate from the same gap when it is not the one that fills the gap', () => {
      // mo-2 is a real moisturise candidate. A second candidate entry for the step breaks the "exactly one" gap rule, not this gate.
      const failures = checkRoutine(skeleton({ limits: { ...skeleton().limits, maxNewProducts: 3 } }), withExtraEntries(candidateEntry('moisturise', 'mo-2', 'pm')))

      expect(gatesOf(failures)).not.toContain('unknown-product')
    })
  })

  describe('stopped-product', () => {
    it('fails when a product to stop is still in the routine', () => {
      const failures = checkRoutine(skeleton(), withExtraEntries(shelfEntry('cleanse', 'retinol-1', 'pm')))

      expect(gatesOf(failures)).toContain('stopped-product')
    })

    it('reports a stopped product used as a shelf entry as unknown-product and stopped-product, and nothing else', () => {
      // retinol-1 fills treat, so only its verdict is wrong; both gates name it on purpose.
      const failures = checkRoutine(skeleton(), withExtraEntries(shelfEntry('treat', 'retinol-1', 'pm')))

      expect(failures).toEqual([
        { gate: 'unknown-product', step: 'treat' },
        { gate: 'stopped-product', step: 'treat' },
      ])
    })

    it('passes when the product to stop is left out and tapered instead', () => {
      expect(checkRoutine(skeleton(), routine())).toEqual([])
    })
  })

  describe('over-reduced', () => {
    it('passes a reduced product exactly at its maximum frequency', () => {
      // serum-1 is capped at alternate-days (rank 2), which is what the valid routine uses.
      expect(checkRoutine(skeleton(), routine())).toEqual([])
    })

    it('passes a reduced product below its maximum frequency', () => {
      const steps = validSteps()
      steps[1] = shelfEntry('treat', 'serum-1', 'weekly')

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([])
    })

    it('fails a reduced product one rank above its maximum frequency', () => {
      // pm is rank 3, alternate-days rank 2. pm is in the allowed list for treat, so only this gate trips.
      const steps = validSteps()
      steps[1] = shelfEntry('treat', 'serum-1', 'pm')

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([{ gate: 'over-reduced', step: 'treat' }])
    })
  })

  describe('over-reduced with an unranked frequency', () => {
    it('fails closed when the cap has no rank, rather than passing', () => {
      const broken = skeleton({ shelf: skeleton().shelf.map((p) => (p.id === 'serum-1' ? { ...p, verdict: { kind: 'reduce' as const, maxFrequency: 'hourly' as Frequency } } : p)) })

      expect(checkRoutine(broken, routine())).toEqual([{ gate: 'over-reduced', step: 'treat' }])
    })
  })

  describe('FREQUENCY_RANK', () => {
    it('ranks as-needed below weekly below alternate-days below am and pm (equal) below am-pm', () => {
      expect(FREQUENCY_RANK['as-needed']).toBe(0)
      expect(FREQUENCY_RANK.weekly).toBe(1)
      expect(FREQUENCY_RANK['alternate-days']).toBe(2)
      expect(FREQUENCY_RANK.am).toBe(3)
      expect(FREQUENCY_RANK.pm).toBe(3)
      expect(FREQUENCY_RANK['am-pm']).toBe(4)
    })
  })

  describe('taper', () => {
    it('passes with one taper per stopped product naming its template', () => {
      expect(checkRoutine(skeleton(), routine())).toEqual([])
    })

    it('passes with no tapers when nothing is stopped', () => {
      const noStop = skeleton({ shelf: skeleton().shelf.filter((p) => p.verdict.kind !== 'stop') })

      expect(checkRoutine(noStop, routine({ tapers: [] }))).toEqual([])
    })

    it('fails when a stopped product has no taper', () => {
      expect(checkRoutine(skeleton(), routine({ tapers: [] }))).toEqual([{ gate: 'taper', step: null }])
    })

    it('fails a taper for a product that is not being stopped', () => {
      const tapers = [...routine().tapers, { shelfProductId: 'serum-1', templateId: 'tpl-retinoid' }]

      expect(checkRoutine(skeleton(), routine({ tapers }))).toEqual([{ gate: 'taper', step: null }])
    })

    it('fails a taper for a product that is not on the shelf', () => {
      const tapers = [...routine().tapers, { shelfProductId: 'ghost', templateId: 'tpl-retinoid' }]

      expect(checkRoutine(skeleton(), routine({ tapers }))).toEqual([{ gate: 'taper', step: null }])
    })

    it('fails a duplicated taper', () => {
      const tapers = [...routine().tapers, ...routine().tapers]

      expect(checkRoutine(skeleton(), routine({ tapers }))).toEqual([{ gate: 'taper', step: null }])
    })

    it('fails a taper naming a different template than the stopped product\'s', () => {
      const tapers = [{ shelfProductId: 'retinol-1', templateId: 'tpl-made-up' }]

      expect(checkRoutine(skeleton(), routine({ tapers }))).toEqual([{ gate: 'taper', step: null }])
    })
  })

  describe('too-many-new', () => {
    it('passes exactly at the limit of new products', () => {
      // The valid routine adds mo-1 and pr-1, and the limit is 2.
      expect(checkRoutine(skeleton(), routine())).toEqual([])
    })

    it('fails one above the limit', () => {
      const tight = skeleton({ limits: { ...skeleton().limits, maxNewProducts: 1 } })

      expect(checkRoutine(tight, routine())).toEqual([{ gate: 'too-many-new', step: null }])
    })

    it('ignores a candidate code the skeleton does not know', () => {
      // nowhere-1 is its own unknown-product failure; it must not also push the count of new products over the limit.
      const failures = checkRoutine(skeleton(), withExtraEntries(candidateEntry('moisturise', 'nowhere-1', 'pm')))

      expect(gatesOf(failures)).not.toContain('too-many-new')
    })

    it('counts a product once when it fills two steps', () => {
      // One product that is both moisturiser and sunscreen is a single new product, so a limit of 1 still passes.
      const both = candidate('both-1')
      const sharing = skeleton({
        gaps: [
          { step: 'moisturise', candidates: [both] },
          { step: 'protect', candidates: [both] },
        ],
        limits: { ...skeleton().limits, maxNewProducts: 1 },
      })
      const steps = validSteps()
      steps[2] = candidateEntry('moisturise', 'both-1', 'am-pm')
      steps[3] = candidateEntry('protect', 'both-1', 'am')

      expect(checkRoutine(sharing, routine({ steps }))).toEqual([])
    })
  })

  describe('frequency', () => {
    it('fails an entry whose frequency is not allowed for its step', () => {
      // weekly is not in the allowed list for cleanse.
      const steps = validSteps()
      steps[0] = shelfEntry('cleanse', 'cleanser-1', 'weekly')

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([{ gate: 'frequency', step: 'cleanse' }])
    })

    it('passes an entry whose frequency is allowed for its step', () => {
      const steps = validSteps()
      steps[0] = shelfEntry('cleanse', 'cleanser-1', 'pm')

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([])
    })

    it('fails a protect entry that is am-pm even when the allowed list includes it', () => {
      const steps = validSteps()
      steps[3] = candidateEntry('protect', 'pr-1', 'am-pm')

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([{ gate: 'frequency', step: 'protect' }])
    })

    it('fails a protect entry that is pm even when the allowed list includes it', () => {
      const pmAllowed = skeleton({ limits: { ...skeleton().limits, allowed: { ...skeleton().limits.allowed, protect: ['am', 'pm'] } } })
      const steps = validSteps()
      steps[3] = candidateEntry('protect', 'pr-1', 'pm')

      expect(checkRoutine(pmAllowed, routine({ steps }))).toEqual([{ gate: 'frequency', step: 'protect' }])
    })

    it('passes a protect entry that is am', () => {
      expect(checkRoutine(skeleton(), routine())).toEqual([])
    })
  })

  describe('order', () => {
    it('fails entries that go backwards through the routine', () => {
      const [cleanse, treat, moisturise, protect] = validSteps()

      expect(gatesOf(checkRoutine(skeleton(), routine({ steps: [protect!, cleanse!, treat!, moisturise!] })))).toEqual(['order'])
    })

    it('fails a single step out of place', () => {
      const [cleanse, treat, moisturise, protect] = validSteps()

      expect(gatesOf(checkRoutine(skeleton(), routine({ steps: [cleanse!, moisturise!, treat!, protect!] })))).toEqual(['order'])
    })

    it('passes several entries for one step', () => {
      const steps = validSteps()
      steps.splice(1, 0, shelfEntry('cleanse', 'cleanser-2', 'pm'))

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([])
    })

    it('fails going back to a step after leaving it', () => {
      const steps = validSteps()
      steps.splice(2, 0, shelfEntry('cleanse', 'cleanser-2', 'pm'))

      expect(gatesOf(checkRoutine(skeleton(), routine({ steps })))).toEqual(['order'])
    })
  })

  describe('gap', () => {
    it('fails when a gap with candidates has no entry using one of them', () => {
      const steps = validSteps().filter((e) => e.step !== 'moisturise')

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([{ gate: 'gap', step: 'moisturise' }])
    })

    it('fails when a gap with candidates has two entries using its candidates', () => {
      const wide = skeleton({ limits: { ...skeleton().limits, maxNewProducts: 3 } })

      expect(checkRoutine(wide, withExtraEntries(candidateEntry('moisturise', 'mo-2', 'pm')))).toEqual([{ gate: 'gap', step: 'moisturise' }])
    })

    it('fails when the same candidate is used twice in one step', () => {
      const wide = skeleton({ limits: { ...skeleton().limits, maxNewProducts: 3 } })

      expect(checkRoutine(wide, withExtraEntries(candidateEntry('moisturise', 'mo-1', 'pm')))).toEqual([{ gate: 'gap', step: 'moisturise' }])
    })

    it('fails a none entry for a gap that has candidates', () => {
      const steps = validSteps()
      steps[2] = entry('moisturise', { kind: 'none' }, 'am-pm')
      const failures = checkRoutine(skeleton(), routine({ steps }))

      expect(failures.length).toBeGreaterThan(0)
      expect(failures).toContainEqual({ gate: 'gap', step: 'moisturise' })
    })

    describe('a gap with no candidates', () => {
      const bare = (): RoutineSkeleton => skeleton({ gaps: [{ step: 'moisturise', candidates: [candidate('mo-1')] }, { step: 'protect', candidates: [] }] })
      const useWhatYouHave = (): RoutineEntry[] => [...validSteps().slice(0, 3), entry('protect', { kind: 'none' }, 'am')]

      it('passes with exactly one none entry for it', () => {
        expect(checkRoutine(bare(), routine({ steps: useWhatYouHave() }))).toEqual([])
      })

      it('fails with no entry for it', () => {
        expect(checkRoutine(bare(), routine({ steps: validSteps().slice(0, 3) }))).toEqual([{ gate: 'gap', step: 'protect' }])
      })

      it('fails with two none entries for it', () => {
        const steps = [...useWhatYouHave(), entry('protect', { kind: 'none' }, 'am')]

        expect(checkRoutine(bare(), routine({ steps }))).toEqual([{ gate: 'gap', step: 'protect' }])
      })
    })

    it('fails a none entry for a step that is not a gap at all', () => {
      // cleanse is filled by the kept shelf, so there is nothing to "use what you have" for.
      const failures = checkRoutine(skeleton(), withExtraEntries(entry('cleanse', { kind: 'none' }, 'am')))

      expect(failures.length).toBeGreaterThan(0)
      expect(failures.every((f) => f.step === 'cleanse')).toBe(true)
    })
  })

  describe('grounding', () => {
    it('passes an empty grounding', () => {
      expect(checkRoutine(skeleton(), routine())).toEqual([])
    })

    it('passes a candidate entry citing its own evidence and ingredients source', () => {
      const steps = validSteps()
      steps[2] = candidateEntry('moisturise', 'mo-1', 'am-pm', { grounding: ['https://evidence.example/mo-1/a', 'https://ingredients.example/mo-1'] })

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([])
    })

    it('fails a candidate entry citing a link that belongs to another candidate', () => {
      const steps = validSteps()
      steps[2] = candidateEntry('moisturise', 'mo-1', 'am-pm', { grounding: ['https://evidence.example/mo-2/a'] })

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([{ gate: 'grounding', step: 'moisturise' }])
    })

    it('fails a candidate entry citing a link that belongs to no product', () => {
      const steps = validSteps()
      steps[2] = candidateEntry('moisturise', 'mo-1', 'am-pm', { grounding: ['https://made-up.example/'] })

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([{ gate: 'grounding', step: 'moisturise' }])
    })

    it('compares links exactly, so a trailing slash or different case is another link', () => {
      for (const near of ['https://evidence.example/mo-1/a/', 'HTTPS://EVIDENCE.EXAMPLE/mo-1/a', ' https://evidence.example/mo-1/a']) {
        const steps = validSteps()
        steps[2] = candidateEntry('moisturise', 'mo-1', 'am-pm', { grounding: [near] })

        expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([{ gate: 'grounding', step: 'moisturise' }])
      }
    })

    it('fails when only one of several links is foreign', () => {
      const steps = validSteps()
      steps[2] = candidateEntry('moisturise', 'mo-1', 'am-pm', { grounding: ['https://evidence.example/mo-1/a', 'https://evidence.example/mo-2/a'] })

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([{ gate: 'grounding', step: 'moisturise' }])
    })

    it('passes a shelf entry citing its own rule sources', () => {
      const steps = validSteps()
      steps[1] = shelfEntry('treat', 'serum-1', 'alternate-days', { grounding: ['https://rules.example/serum-1'] })

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([])
    })

    it('fails a shelf entry citing another shelf product\'s sources', () => {
      const steps = validSteps()
      steps[1] = shelfEntry('treat', 'serum-1', 'alternate-days', { grounding: ['https://rules.example/cleanser-1'] })

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([{ gate: 'grounding', step: 'treat' }])
    })

    it('fails a shelf entry citing a candidate\'s link', () => {
      const steps = validSteps()
      steps[1] = shelfEntry('treat', 'serum-1', 'alternate-days', { grounding: ['https://evidence.example/mo-1/a'] })

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([{ gate: 'grounding', step: 'treat' }])
    })

    it('fails a none entry that cites anything', () => {
      const bare = skeleton({ gaps: [{ step: 'moisturise', candidates: [candidate('mo-1')] }, { step: 'protect', candidates: [] }] })
      const steps = [...validSteps().slice(0, 3), entry('protect', { kind: 'none' }, 'am', { grounding: ['https://evidence.example/mo-1/a'] })]

      expect(checkRoutine(bare, routine({ steps }))).toEqual([{ gate: 'grounding', step: 'protect' }])
    })
  })

  describe('wording', () => {
    it('fails an entry whose reason uses a forbidden phrase, naming that entry\'s step', () => {
      const steps = validSteps()
      steps[2] = candidateEntry('moisturise', 'mo-1', 'am-pm', { reason: 'This will help your melasma.' })

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([{ gate: 'wording', step: 'moisturise' }])
    })

    it('fails an expectation that uses a forbidden phrase, with no step', () => {
      expect(checkRoutine(skeleton(), routine({ expectation: 'Expect lighter skin in 8 weeks.' }))).toEqual([{ gate: 'wording', step: null }])
    })

    it('passes the plain phrase "use what you have" in a reason', () => {
      const bare = skeleton({ gaps: [{ step: 'moisturise', candidates: [candidate('mo-1')] }, { step: 'protect', candidates: [] }] })
      const steps = [...validSteps().slice(0, 3), entry('protect', { kind: 'none' }, 'am', { reason: 'Use what you have for now.' })]

      expect(checkRoutine(bare, routine({ steps }))).toEqual([])
    })

    it('reports each entry that breaks the wording rules', () => {
      const steps = validSteps()
      steps[0] = shelfEntry('cleanse', 'cleanser-1', 'am-pm', { reason: 'Good against eczema.' })
      steps[3] = candidateEntry('protect', 'pr-1', 'am', { reason: 'We diagnose less this way.' })

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([
        { gate: 'wording', step: 'cleanse' },
        { gate: 'wording', step: 'protect' },
      ])
    })
  })

  describe('several failures', () => {
    // One routine breaking five gates at once: a ghost shelf product, an over-reduced serum, a missing taper, a cleanser at a
    // frequency the step does not allow, and a forbidden word in the expectation.
    const brokenRoutine = (): Routine => {
      const steps = validSteps()
      steps[0] = shelfEntry('cleanse', 'cleanser-1', 'weekly')
      steps[1] = shelfEntry('treat', 'serum-1', 'pm')
      steps.splice(1, 0, shelfEntry('cleanse', 'ghost', 'am'))
      return routine({ steps, tapers: [], expectation: 'You will see lighter skin.' })
    }

    it('reports every failure found, not just the first', () => {
      expect(checkRoutine(skeleton(), brokenRoutine())).toEqual(
        expect.arrayContaining([
          { gate: 'unknown-product', step: 'cleanse' },
          { gate: 'over-reduced', step: 'treat' },
          { gate: 'taper', step: null },
          { gate: 'frequency', step: 'cleanse' },
          { gate: 'wording', step: null },
        ]),
      )
      expect(checkRoutine(skeleton(), brokenRoutine())).toHaveLength(5)
    })

    it('reports them in the same order every time, gate by gate in the order the rules are numbered', () => {
      const first = checkRoutine(skeleton(), brokenRoutine())

      expect(checkRoutine(skeleton(), brokenRoutine())).toEqual(first)
      expect(gatesOf(first)).toEqual(['unknown-product', 'over-reduced', 'taper', 'frequency', 'wording'])
    })

    it('reports the same gate on several entries in routine order', () => {
      const steps = validSteps()
      steps[0] = shelfEntry('cleanse', 'cleanser-1', 'weekly')
      steps[2] = candidateEntry('moisturise', 'mo-1', 'weekly')

      expect(checkRoutine(skeleton(), routine({ steps }))).toEqual([
        { gate: 'frequency', step: 'cleanse' },
        { gate: 'frequency', step: 'moisturise' },
      ])
    })
  })
})

describe('SkeletonCandidate', () => {
  it('has no origin field, so who paid for a review can never reach a choice', () => {
    expectTypeOf<SkeletonCandidate>().not.toHaveProperty('origin')
  })
})
