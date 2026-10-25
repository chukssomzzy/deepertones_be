import { z } from 'zod'
import { FREQUENCIES, ROUTINE_STEPS } from '../catalog/catalog.vocabulary'

// Every object is strict: a field the writer invents is a parse failure, not something silently dropped.
// A plain union, not a discriminatedUnion: Anthropic structured outputs document anyOf, not oneOf, and z.union emits anyOf.
const ProductSchema = z.union([
  z.strictObject({ kind: z.literal('shelf'), id: z.string() }),
  z.strictObject({ kind: z.literal('candidate'), code: z.string() }),
  z.strictObject({ kind: z.literal('none') }),
])

const EntrySchema = z.strictObject({
  step: z.enum(ROUTINE_STEPS),
  product: ProductSchema,
  frequency: z.enum(FREQUENCIES),
  reason: z.string(),
  grounding: z.array(z.string()),
})

/** What Claude's answer must parse as before any gate looks at it. */
export const RoutineSchema = z.strictObject({
  steps: z.array(EntrySchema),
  tapers: z.array(z.strictObject({ shelfProductId: z.string(), templateId: z.string() })),
  expectation: z.string(),
})
