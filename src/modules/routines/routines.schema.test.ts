import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FREQUENCIES, ROUTINE_STEPS } from '../catalog/catalog.vocabulary'
import { RoutineSchema, routineSchemaFor } from './routines.schema'
import type { RoutineSkeleton, ShelfVerdict, SkeletonCandidate, SkeletonShelfProduct } from './routines.types'

// A plain literal, not built from the types, so the schema is checked against a routine written the way Claude would answer.
const validRoutine = () => ({
  steps: [
    { step: 'cleanse', product: { kind: 'shelf', id: 'cleanser-1' }, frequency: 'am-pm', reason: 'Gentle on skin that is settling.', grounding: [] as string[] },
    { step: 'moisturise', product: { kind: 'candidate', code: 'mo-1' }, frequency: 'pm', reason: 'Keeps skin comfortable.', grounding: ['https://evidence.example/mo-1/a'] },
    { step: 'protect', product: { kind: 'none' }, frequency: 'am', reason: 'Use what you have.', grounding: [] as string[] },
  ],
  tapers: [{ shelfProductId: 'retinol-1', templateId: 'tpl-retinoid' }],
  expectation: 'Most people see a change in 8 to 12 weeks.',
})

const parses = (input: unknown) => RoutineSchema.safeParse(input).success

describe('RoutineSchema', () => {
  it('parses a valid routine, keeping every field as given', () => {
    const result = RoutineSchema.safeParse(validRoutine())

    expect(result.success).toBe(true)
    expect(result.data).toEqual(validRoutine())
  })

  it('parses a routine with no entries and no tapers', () => {
    expect(parses({ steps: [], tapers: [], expectation: 'Soon.' })).toBe(true)
  })

  it.each(FREQUENCIES)('parses the frequency %s', (frequency) => {
    const r = validRoutine()
    r.steps[0]!.frequency = frequency

    expect(parses(r)).toBe(true)
  })

  it.each(ROUTINE_STEPS)('parses the step %s', (step) => {
    const r = validRoutine()
    r.steps[0]!.step = step

    expect(parses(r)).toBe(true)
  })

  it('rejects an unknown frequency', () => {
    const r = validRoutine()
    r.steps[0]!.frequency = 'hourly'

    expect(parses(r)).toBe(false)
  })

  it('rejects an unknown step', () => {
    const r = validRoutine()
    r.steps[0]!.step = 'exfoliate'

    expect(parses(r)).toBe(false)
  })

  it('rejects an unknown product kind', () => {
    const r = validRoutine()
    r.steps[0]!.product = { kind: 'catalog', id: 'x' } as never

    expect(parses(r)).toBe(false)
  })

  it('rejects an entry with no grounding', () => {
    const r = validRoutine()
    delete (r.steps[0] as { grounding?: string[] }).grounding

    expect(parses(r)).toBe(false)
  })

  it.each([
    ['the routine', (r: ReturnType<typeof validRoutine>) => Object.assign(r, { confidence: 0.9 })],
    ['an entry', (r: ReturnType<typeof validRoutine>) => Object.assign(r.steps[0]!, { notes: 'x' })],
    ['a shelf product', (r: ReturnType<typeof validRoutine>) => Object.assign(r.steps[0]!.product, { origin: 'sponsored' })],
    ['a none product', (r: ReturnType<typeof validRoutine>) => Object.assign(r.steps[2]!.product, { code: 'mo-1' })],
    ['a taper', (r: ReturnType<typeof validRoutine>) => Object.assign(r.tapers[0]!, { weeks: 4 })],
  ])('rejects an extra field on %s', (_where, addExtra) => {
    const r = validRoutine()
    addExtra(r)

    expect(parses(r)).toBe(false)
  })

  it.each(['steps', 'tapers', 'expectation'] as const)('rejects a routine missing %s', (key) => {
    const r: Record<string, unknown> = validRoutine()
    delete r[key]

    expect(parses(r)).toBe(false)
  })

  it('rejects a grounding that holds something other than text', () => {
    const r = validRoutine()
    r.steps[0]!.grounding = [42] as never

    expect(parses(r)).toBe(false)
  })

  it.each([null, undefined, 'a routine', 42, []])('rejects %s', (input) => {
    expect(parses(input)).toBe(false)
  })
})

// ---- routineSchemaFor: the schema narrowed to one skeleton, so the writer can only answer with that skeleton's own products ----

const candidate = (code: string): SkeletonCandidate => ({
  code,
  brand: 'Brand',
  name: `Product ${code}`,
  form: 'cream',
  ingredients: ['Aqua', 'Glycerin'],
  skinConcerns: ['hd_moisture'],
  frequency: 'am-pm',
  priceMin: 5,
  priceMax: 10,
  evidenceUrls: [],
  ingredientsSourceUrl: null,
  outcomeHint: null,
})

const shelfProduct = (id: string, verdict: ShelfVerdict): SkeletonShelfProduct => ({
  id,
  brand: null,
  name: `Shelf ${id}`,
  ingredients: ['Aqua'],
  step: 'treat',
  verdict,
  sourceUrls: [],
})

const skeletonWith = (overrides: Partial<RoutineSkeleton>): RoutineSkeleton => ({
  goal: 'even-tone',
  person: { seen: [], alsoNoticed: [], skinType: null, lowConfidence: [], cautions: [], budgetBand: null },
  steps: ['cleanse', 'treat', 'moisturise', 'protect'],
  shelf: [],
  gaps: [],
  limits: {
    allowed: { cleanse: ['am', 'pm', 'am-pm'], treat: ['pm', 'alternate-days', 'weekly'], moisturise: ['am', 'pm', 'am-pm'], protect: ['am'] },
    maxNewProducts: 1,
  },
  hintsShown: false,
  ...overrides,
})

// Real-looking codes, so a misspelling is the kind Sonnet really made (a letter dropped from MOISTURISING).
const SKELETON_A = skeletonWith({
  shelf: [
    shelfProduct('keep-1', { kind: 'keep' }),
    shelfProduct('reduce-1', { kind: 'reduce', maxFrequency: 'alternate-days' }),
    shelfProduct('stop-1', { kind: 'stop', taperTemplateId: 'tpl-retinoid' }),
    shelfProduct('stop-2', { kind: 'stop', taperTemplateId: 'tpl-steroid' }),
    shelfProduct('drop-1', { kind: 'drop' }),
  ],
  gaps: [
    { step: 'moisturise', candidates: [candidate('SKU-MOISTURISING-CREAM-01'), candidate('SKU-MOISTURISING-GEL-02')] },
    { step: 'protect', candidates: [candidate('SKU-SUNSCREEN-03')] },
  ],
})

const SKELETON_B = skeletonWith({
  steps: ['cleanse', 'moisturise'],
  shelf: [shelfProduct('other-keep', { kind: 'keep' }), shelfProduct('other-stop', { kind: 'stop', taperTemplateId: 'tpl-other' })],
  gaps: [{ step: 'moisturise', candidates: [candidate('SKU-OTHER-CREAM-09')] }],
})

const NO_CANDIDATES = skeletonWith({
  shelf: [shelfProduct('keep-1', { kind: 'keep' }), shelfProduct('stop-1', { kind: 'stop', taperTemplateId: 'tpl-retinoid' })],
  gaps: [{ step: 'moisturise', candidates: [] }],
})

const NO_GAPS = skeletonWith({ shelf: [shelfProduct('keep-1', { kind: 'keep' })], gaps: [] })

const NO_KEPT_SHELF = skeletonWith({
  shelf: [shelfProduct('stop-1', { kind: 'stop', taperTemplateId: 'tpl-retinoid' }), shelfProduct('drop-1', { kind: 'drop' })],
  gaps: [{ step: 'moisturise', candidates: [candidate('SKU-MOISTURISING-CREAM-01')] }],
})

const NOTHING_STOPPED = skeletonWith({
  shelf: [shelfProduct('keep-1', { kind: 'keep' }), shelfProduct('drop-1', { kind: 'drop' })],
  gaps: [{ step: 'moisturise', candidates: [candidate('SKU-MOISTURISING-CREAM-01')] }],
})

const EMPTY_SHELF_AND_GAPS = skeletonWith({})

type Entry = { step: string; product: Record<string, unknown>; frequency: string; reason: string; grounding: string[] }
const entry = (overrides: Partial<Entry> = {}): Entry => ({
  step: 'moisturise',
  product: { kind: 'candidate', code: 'SKU-MOISTURISING-CREAM-01' },
  frequency: 'pm',
  reason: 'Keeps skin comfortable.',
  grounding: [],
  ...overrides,
})
const routineOf = (entries: Entry[], tapers: { shelfProductId: string; templateId: string }[] = []) => ({ steps: entries, tapers, expectation: 'Most people see a change in 8 to 12 weeks.' })
const parsesFor = (skeleton: RoutineSkeleton, input: unknown) => routineSchemaFor(skeleton).safeParse(input).success

describe('routineSchemaFor', () => {
  it("parses a routine that uses only the skeleton's own codes, ids, steps and templates, keeping every field as given", () => {
    const routine = routineOf(
      [
        entry({ step: 'cleanse', product: { kind: 'shelf', id: 'keep-1' }, frequency: 'am-pm' }),
        entry({ step: 'treat', product: { kind: 'shelf', id: 'reduce-1' }, frequency: 'alternate-days' }),
        entry({ step: 'moisturise', product: { kind: 'candidate', code: 'SKU-MOISTURISING-GEL-02' } }),
        entry({ step: 'protect', product: { kind: 'none' }, frequency: 'am' }),
      ],
      [
        { shelfProductId: 'stop-1', templateId: 'tpl-retinoid' },
        { shelfProductId: 'stop-2', templateId: 'tpl-steroid' },
      ],
    )

    const result = routineSchemaFor(SKELETON_A).safeParse(routine)

    expect(result.success).toBe(true)
    expect(result.data).toEqual(routine)
  })

  it('parses a candidate from a different gap than the entry names, because which gap a code belongs to is for the gates to judge', () => {
    expect(parsesFor(SKELETON_A, routineOf([entry({ step: 'protect', product: { kind: 'candidate', code: 'SKU-MOISTURISING-CREAM-01' }, frequency: 'am' })]))).toBe(true)
  })

  it('parses a frequency allowed for any step, because which step it suits is for the gates to judge', () => {
    expect(parsesFor(SKELETON_A, routineOf([entry({ step: 'cleanse', frequency: 'weekly' })]))).toBe(true)
  })

  it('parses a routine with no entries and no tapers', () => {
    expect(parsesFor(SKELETON_A, routineOf([]))).toBe(true)
  })

  it.each([
    ['a misspelt candidate code (a letter dropped)', entry({ product: { kind: 'candidate', code: 'SKU-MOISTURING-CREAM-01' } })],
    ['a candidate code with different case', entry({ product: { kind: 'candidate', code: 'sku-moisturising-cream-01' } })],
    ['a candidate code from another skeleton', entry({ product: { kind: 'candidate', code: 'SKU-OTHER-CREAM-09' } })],
    ['a shelf id that is not on the shelf', entry({ step: 'cleanse', product: { kind: 'shelf', id: 'keep-9' } })],
    ['a stop product as a shelf entry', entry({ step: 'treat', product: { kind: 'shelf', id: 'stop-1' } })],
    ['a drop product as a shelf entry', entry({ step: 'treat', product: { kind: 'shelf', id: 'drop-1' } })],
    ['a shelf id from another skeleton', entry({ step: 'cleanse', product: { kind: 'shelf', id: 'other-keep' } })],
    ['a candidate code given as a shelf id', entry({ product: { kind: 'shelf', id: 'SKU-MOISTURISING-CREAM-01' } })],
    ['a shelf id given as a candidate code', entry({ product: { kind: 'candidate', code: 'keep-1' } })],
    ['a frequency outside the allowed union', entry({ frequency: 'as-needed' })],
    ['a frequency outside the list', entry({ frequency: 'hourly' })],
  ])('rejects %s', (_label, bad) => {
    expect(parsesFor(SKELETON_A, routineOf([bad]))).toBe(false)
  })

  it('rejects a step the skeleton does not need', () => {
    expect(parsesFor(SKELETON_B, routineOf([entry({ step: 'protect', product: { kind: 'none' }, frequency: 'am' })]))).toBe(false)
    expect(parsesFor(SKELETON_B, routineOf([entry({ step: 'cleanse', product: { kind: 'none' }, frequency: 'am' })]))).toBe(true)
  })

  it.each([
    ['a taper naming a keep product', { shelfProductId: 'keep-1', templateId: 'tpl-retinoid' }],
    ['a taper naming a reduce product', { shelfProductId: 'reduce-1', templateId: 'tpl-retinoid' }],
    ['a taper naming a drop product', { shelfProductId: 'drop-1', templateId: 'tpl-retinoid' }],
    ['a taper naming a product that is not on the shelf', { shelfProductId: 'stop-9', templateId: 'tpl-retinoid' }],
    ['a taper with a template that no stop product has', { shelfProductId: 'stop-1', templateId: 'tpl-other' }],
    ['a taper with a made-up template', { shelfProductId: 'stop-1', templateId: 'tpl-retinoids' }],
  ])('rejects %s', (_label, taper) => {
    expect(parsesFor(SKELETON_A, routineOf([], [taper]))).toBe(false)
  })

  it('parses each stop product tapered with its own template', () => {
    expect(parsesFor(SKELETON_A, routineOf([], [{ shelfProductId: 'stop-2', templateId: 'tpl-steroid' }]))).toBe(true)
  })

  it('still rejects an extra field and a missing field, as RoutineSchema does', () => {
    expect(parsesFor(SKELETON_A, { ...routineOf([]), confidence: 0.9 })).toBe(false)
    expect(parsesFor(SKELETON_A, routineOf([Object.assign(entry(), { notes: 'x' })]))).toBe(false)
    expect(parsesFor(SKELETON_A, { steps: [], tapers: [] })).toBe(false)
    const noGrounding: Record<string, unknown> = entry()
    delete noGrounding.grounding
    expect(parsesFor(SKELETON_A, routineOf([noGrounding as Entry]))).toBe(false)
  })

  it.each([
    ['no candidates in a gap', NO_CANDIDATES],
    ['no gaps at all', NO_GAPS],
    ['nothing on the shelf and no gaps', EMPTY_SHELF_AND_GAPS],
  ])('builds a schema for a skeleton with %s, and rejects a candidate', (_label, skeleton) => {
    expect(() => routineSchemaFor(skeleton)).not.toThrow()
    expect(parsesFor(skeleton, routineOf([entry({ product: { kind: 'candidate', code: 'SKU-MOISTURISING-CREAM-01' } })]))).toBe(false)
    expect(parsesFor(skeleton, routineOf([entry({ product: { kind: 'candidate', code: '' } })]))).toBe(false)
    expect(parsesFor(skeleton, routineOf([entry({ product: { kind: 'none' } })]))).toBe(true)
  })

  it('still accepts a kept shelf product when there are no candidates', () => {
    expect(parsesFor(NO_CANDIDATES, routineOf([entry({ step: 'cleanse', product: { kind: 'shelf', id: 'keep-1' }, frequency: 'am' })]))).toBe(true)
  })

  it.each([
    ['only stop and drop products on the shelf', NO_KEPT_SHELF],
    ['nothing on the shelf', EMPTY_SHELF_AND_GAPS],
  ])('builds a schema for a skeleton with %s, and rejects a shelf entry', (_label, skeleton) => {
    expect(() => routineSchemaFor(skeleton)).not.toThrow()
    for (const id of ['stop-1', 'drop-1', 'keep-1', '']) {
      expect(parsesFor(skeleton, routineOf([entry({ step: 'treat', product: { kind: 'shelf', id } })]))).toBe(false)
    }
  })

  it('still accepts a candidate and a none product when no shelf product is kept', () => {
    expect(parsesFor(NO_KEPT_SHELF, routineOf([entry()]))).toBe(true)
    expect(parsesFor(NO_KEPT_SHELF, routineOf([entry({ product: { kind: 'none' } })]))).toBe(true)
  })

  it('builds a schema for a skeleton where nothing is stopped, accepts no tapers, and rejects any taper', () => {
    expect(() => routineSchemaFor(NOTHING_STOPPED)).not.toThrow()
    expect(parsesFor(NOTHING_STOPPED, routineOf([]))).toBe(true)
    expect(parsesFor(NOTHING_STOPPED, routineOf([], [{ shelfProductId: 'keep-1', templateId: 'tpl-retinoid' }]))).toBe(false)
    expect(parsesFor(NOTHING_STOPPED, routineOf([], [{ shelfProductId: 'drop-1', templateId: 'tpl-retinoid' }]))).toBe(false)
  })

  describe('as JSON schema, which is what the writer sends', () => {
    const jsonOf = (skeleton: RoutineSkeleton) => z.toJSONSchema(routineSchemaFor(skeleton))
    const enumsIn = (node: unknown): string[][] => {
      if (Array.isArray(node)) return node.flatMap(enumsIn)
      if (node === null || typeof node !== 'object') return []
      return Object.entries(node).flatMap(([key, value]) => (key === 'enum' && Array.isArray(value) ? [value as string[]] : enumsIn(value)))
    }

    it('never uses oneOf, which structured outputs do not document, and uses anyOf for the product choice', () => {
      for (const skeleton of [SKELETON_A, NO_CANDIDATES, NO_KEPT_SHELF, NOTHING_STOPPED, EMPTY_SHELF_AND_GAPS]) {
        const text = JSON.stringify(jsonOf(skeleton))
        expect(text).not.toContain('"oneOf"')
        expect(text).toContain('"anyOf"')
      }
    })

    it("lists the skeleton's candidate codes as an enum, and no code from another skeleton", () => {
      const json = jsonOf(SKELETON_A)

      expect(enumsIn(json).map((values) => [...values].sort())).toContainEqual(['SKU-MOISTURISING-CREAM-01', 'SKU-MOISTURISING-GEL-02', 'SKU-SUNSCREEN-03'])
      expect(JSON.stringify(json)).not.toContain('SKU-OTHER-CREAM-09')
    })

    it('lists the steps, the kept shelf ids, the stop ids and their templates as enums', () => {
      const enums = enumsIn(jsonOf(SKELETON_A)).map((values) => [...values].sort())

      expect(enums).toContainEqual(['cleanse', 'moisturise', 'protect', 'treat'])
      expect(enums).toContainEqual(['keep-1', 'reduce-1'])
      expect(enums).toContainEqual(['stop-1', 'stop-2'])
      expect(enums).toContainEqual(['tpl-retinoid', 'tpl-steroid'])
      expect(JSON.stringify(jsonOf(SKELETON_A))).not.toContain('drop-1')
    })

    it('lists only the frequencies the skeleton allows', () => {
      const enums = enumsIn(jsonOf(SKELETON_A)).map((values) => [...values].sort())

      expect(enums).toContainEqual(['alternate-days', 'am', 'am-pm', 'pm', 'weekly'])
      expect(JSON.stringify(jsonOf(SKELETON_A))).not.toContain('as-needed')
    })

    it('leaves out the candidate branch when there are no candidates, and the shelf branch when no shelf product is kept', () => {
      expect(JSON.stringify(jsonOf(NO_CANDIDATES))).not.toContain('"candidate"')
      expect(JSON.stringify(jsonOf(NO_KEPT_SHELF))).not.toContain('"shelf"')
      expect(JSON.stringify(jsonOf(SKELETON_A))).toContain('"candidate"')
      expect(JSON.stringify(jsonOf(SKELETON_A))).toContain('"shelf"')
    })

    it('keeps the closed objects: no additional properties anywhere', () => {
      const closed = (node: unknown): boolean => {
        if (Array.isArray(node)) return node.every(closed)
        if (node === null || typeof node !== 'object') return true
        const o = node as Record<string, unknown>
        return (o.type !== 'object' || o.additionalProperties === false) && Object.values(o).every(closed)
      }

      expect(closed(jsonOf(SKELETON_A))).toBe(true)
    })
  })

  describe('against RoutineSchema, the contract', () => {
    // Every combination of values the skeleton offers and values it does not, so the check is not just the happy path.
    const STEPS = [...ROUTINE_STEPS, 'exfoliate']
    const FREQS = [...FREQUENCIES, 'hourly']
    const PRODUCTS = [
      { kind: 'none' },
      { kind: 'none', code: 'x' },
      { kind: 'bogus', id: 'x' },
      { kind: 'shelf', id: 'keep-1' },
      { kind: 'shelf', id: 'stop-1' },
      { kind: 'shelf', id: 'drop-1' },
      { kind: 'shelf', id: 'nope' },
      { kind: 'candidate', code: 'SKU-MOISTURISING-CREAM-01' },
      { kind: 'candidate', code: 'SKU-MOISTURING-CREAM-01' },
      { kind: 'candidate', code: 'SKU-OTHER-CREAM-09' },
      { kind: 'candidate', code: 'mo-1' },
    ]
    const TAPERS = [
      [],
      [{ shelfProductId: 'stop-1', templateId: 'tpl-retinoid' }],
      [{ shelfProductId: 'keep-1', templateId: 'tpl-retinoid' }],
      [{ shelfProductId: 'stop-1', templateId: 'tpl-other' }],
      [{ shelfProductId: 'stop-1', templateId: 'tpl-retinoid', weeks: 4 }],
    ]

    it.each([
      ['a skeleton with everything', SKELETON_A],
      ['a small skeleton', SKELETON_B],
      ['no candidates', NO_CANDIDATES],
      ['no kept shelf products', NO_KEPT_SHELF],
      ['nothing stopped', NOTHING_STOPPED],
      ['nothing at all', EMPTY_SHELF_AND_GAPS],
    ])('accepts nothing that RoutineSchema rejects, and does accept some routines, for %s', (_label, skeleton) => {
      let accepted = 0
      for (const step of STEPS)
        for (const frequency of FREQS)
          for (const product of PRODUCTS)
            for (const tapers of TAPERS) {
              const routine = routineOf([entry({ step, frequency, product })], tapers)
              if (parsesFor(skeleton, routine)) {
                accepted++
                expect(parses(routine), JSON.stringify(routine)).toBe(true)
              }
            }

      expect(accepted).toBeGreaterThan(0)
    })
  })
})
