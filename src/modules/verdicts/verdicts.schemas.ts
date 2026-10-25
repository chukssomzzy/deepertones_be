import { z } from '@hono/zod-openapi'
import { FREQUENCIES, TAPER_KINDS } from '../catalog/catalog.vocabulary'

const GROUPS = ['prescribed', 'likely-the-problem', 'conflicting', 'cant-tell', 'helping', 'redundant', 'blocking', 'undecided'] as const

const VerdictResponse = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('keep') }),
    z.object({ kind: z.literal('reduce'), maxFrequency: z.enum(FREQUENCIES).openapi({ description: 'Keep it, but no more often than this.' }) }),
    z.object({ kind: z.literal('stop'), taperCode: z.string().openapi({ description: 'The `code` of the step-down in `tapers` to follow.' }) }),
    z.object({ kind: z.literal('drop') }),
  ])
  .openapi('ShelfVerdictAction', { description: 'What to do with the product: `keep` it, `reduce` it, `stop` it by a step-down, or `drop` it at once.' })

export const VerdictProductResponse = z
  .object({
    entryId: z.string().openapi({ description: 'The shelf entry this is about: its `id` from `GET /api/v1/me/shelf`.' }),
    group: z.enum(GROUPS).openapi({ description: 'The heading the product is shown under.' }),
    verdict: VerdictResponse,
    reason: z.string().openapi({ description: 'Why, in words for the user.' }),
    escalate: z.boolean().openapi({ description: 'True when the user should see a professional about this product.' }),
    sameJobAs: z.string().optional().openapi({ description: 'Only on a `redundant` product: the entry id of the product that stays and does its job.' }),
    nudge: z.literal('photograph-back-label').optional().openapi({ description: 'Only on a `cant-tell` product: what to do to get it read.' }),
  })
  .openapi('ShelfVerdictProduct')

export const VerdictTaperResponse = z
  .object({
    code: z.string().openapi({ description: 'The step-down\'s code, as a `stop` verdict names it.' }),
    kind: z.enum(TAPER_KINDS),
    schedule: z
      .array(
        z.object({
          fromWeek: z.number().int().openapi({ description: 'The first week of the step, counting from 1.' }),
          toWeek: z.number().int().openapi({ description: 'The last week of the step; the same as `fromWeek` for a single week.' }),
          frequency: z.enum([...FREQUENCIES, 'stop']),
        }),
      )
      .openapi({ description: 'The steps in order, ending with `stop`.' }),
    whatToExpect: z.string(),
    seeAProfessionalIf: z.string(),
  })
  .openapi('ShelfVerdictTaper')

export const ShelfVerdictResponse = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('pending') }),
    z.object({
      status: z.literal('ready'),
      fit: z.enum(['ready', 'not-ready']).openapi({ description: '`not-ready` when the goal-fit check has not answered yet: the products it would decide are shown as kept for now, and it is tried again.' }),
      products: z.array(VerdictProductResponse).openapi({ description: 'One per skin-care product on the shelf, in shelf order.' }),
      tapers: z.array(VerdictTaperResponse).openapi({ description: 'The step-downs the `stop` verdicts use, each once.' }),
    }),
  ])
  .openapi('ShelfVerdict')
