import { z } from 'zod'
import { FREQUENCIES, ROUTINE_STEPS } from '../catalog/catalog.vocabulary'
import type { Routine, RoutineSkeleton } from './routines.types'

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

// Always an `enum`, even for one value: z.literal would emit `const`. An enum cannot be empty, so an empty list falls back to `all`.
const enumOf = <T extends string>(values: readonly T[], all: readonly T[] = values) => z.enum([...new Set(values.length > 0 ? values : all)] as [T, ...T[]])

/**
 * RoutineSchema narrowed to one skeleton, so a reply can only name the skeleton's own steps, products, templates and frequencies
 * (a code Claude misspells fails to parse instead of reaching the gates). It sends and parses the same shape as RoutineSchema, which stays
 * the contract: whatever this accepts, RoutineSchema accepts. A product kind with nothing to choose from is left out, and `tapers` is a
 * plain list when nothing is stopped (the API refuses an empty tuple's `prefixItems`; the taper gate rejects any taper then). Which step a
 * product suits is still for the gates.
 */
export const routineSchemaFor = (skeleton: RoutineSkeleton): z.ZodType<Routine> => {
  const shelfIds = skeleton.shelf.filter((p) => p.verdict.kind === 'keep' || p.verdict.kind === 'reduce').map((p) => p.id)
  const codes = skeleton.gaps.flatMap((gap) => gap.candidates.map((c) => c.code))
  const stopped = skeleton.shelf.flatMap((p) => (p.verdict.kind === 'stop' ? [{ id: p.id, templateId: p.verdict.taperTemplateId }] : []))
  const products = [
    ...(shelfIds.length > 0 ? [z.strictObject({ kind: z.literal('shelf'), id: enumOf(shelfIds) })] : []),
    ...(codes.length > 0 ? [z.strictObject({ kind: z.literal('candidate'), code: enumOf(codes) })] : []),
    z.strictObject({ kind: z.literal('none') }),
  ]
  const entry = z.strictObject({
    step: enumOf(skeleton.steps, ROUTINE_STEPS),
    product: z.union(products as [(typeof products)[number], (typeof products)[number], ...(typeof products)[number][]]),
    frequency: enumOf(Object.values(skeleton.limits.allowed).flat(), FREQUENCIES),
    reason: z.string(),
    grounding: z.array(z.string()),
  })
  const tapers = z.array(
    z.strictObject({
      shelfProductId: stopped.length > 0 ? enumOf(stopped.map((t) => t.id)) : z.string(),
      templateId: stopped.length > 0 ? enumOf(stopped.map((t) => t.templateId)) : z.string(),
    }),
  )
  return z.strictObject({ steps: z.array(entry), tapers, expectation: z.string() })
}
