import { describe, expect, it } from 'vitest'
import { FREQUENCIES, ROUTINE_STEPS } from '../catalog/catalog.vocabulary'
import { RoutineSchema } from './routines.schema'

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
