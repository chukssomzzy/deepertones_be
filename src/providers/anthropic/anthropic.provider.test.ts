import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { lastJsonObjectIn } from './anthropic.provider'

// The scanner the researcher and the drafter both read a final answer with. The researcher's and the drafter's own tests cover it through their
// answers; these pin it on its own.
const SCHEMA = z.object({ found: z.boolean(), n: z.number().optional() })

describe('lastJsonObjectIn', () => {
  it('reads a bare object', () => {
    expect(lastJsonObjectIn('{"found": true}', SCHEMA)).toEqual({ found: true })
  })

  it('reads the last object that fits the schema, past chatter before and after it', () => {
    expect(lastJsonObjectIn('first {"found": false} then ```json\n{"found": true, "n": 2}\n``` done', SCHEMA)).toEqual({ found: true, n: 2 })
  })

  it('falls back to an earlier object when the last one does not fit the schema', () => {
    expect(lastJsonObjectIn('{"found": true} and {"other": 1}', SCHEMA)).toEqual({ found: true })
  })

  it('reads an object whose strings hold braces and escaped quotes', () => {
    const schema = z.object({ s: z.string() })

    expect(lastJsonObjectIn('{"s": "a } b { \\" }"}', schema)).toEqual({ s: 'a } b { " }' })
  })

  it.each([['no JSON'], ['{"found": true'], ['}'], ['{"found": "yes"}'], ['']])('returns undefined for %j', (text) => {
    expect(lastJsonObjectIn(text, SCHEMA)).toBeUndefined()
  })

  it('gives up on stray closing braces after the answer instead of scanning back from each', () => {
    expect(lastJsonObjectIn(`{"found": true} ${'}'.repeat(50_000)}`, SCHEMA)).toBeUndefined()
  })
})
