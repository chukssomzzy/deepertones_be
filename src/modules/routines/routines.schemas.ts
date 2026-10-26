import { z } from '@hono/zod-openapi'
import { FREQUENCIES, ROUTINE_STEPS, TAPER_KINDS } from '../catalog/catalog.vocabulary'

export const StepParams = z.object({
  step: z.enum(ROUTINE_STEPS).openapi({ param: { name: 'step', in: 'path' }, description: 'The routine step: `cleanse`, `treat`, `moisturise` or `protect`.' }),
})

const OwnProduct = z
  .object({
    kind: z.literal('own'),
    entryId: z.string().openapi({ description: 'The shelf entry to keep using: its `id` from `GET /api/v1/me/shelf`.' }),
    brand: z.string().nullable().openapi({ description: 'Null when the label was not read.' }),
    name: z.string(),
  })
  .openapi('RoutineOwnProduct', { description: 'A product already on the shelf.' })

const RecommendedProduct = z
  .object({
    kind: z.literal('recommended'),
    code: z.string().openapi({ description: 'The catalog code of the product.' }),
    brand: z.string(),
    name: z.string(),
    imageUrl: z.string().nullable(),
    origin: z.literal('brand-submitted').optional().openapi({ description: 'Only on a product a brand submitted for review, which says so. The review fee never affects the choice.' }),
    price: z
      .object({ min: z.number(), max: z.number(), currency: z.string().openapi({ description: 'The currency of the country the profile shops in.' }) })
      .nullable()
      .openapi({ description: 'The price range in the shopping country; null when it is not sold there.' }),
    whereSold: z.string().nullable().openapi({ description: 'Where to find it in the shopping country; null when it is not sold there or the review does not say.' }),
    soldInCurrentCountry: z.boolean().openapi({ description: 'False when the product is not sold in the shopping country (or has been retired): it stays on the screen, and `find-sold-here` asks for another.' }),
    soldElsewhere: z.array(z.string()).openapi({ description: 'The codes of the other countries that sell it; empty for a retired product.' }),
    keyIngredient: z.string().nullable(),
    strength: z.string().nullable(),
    notYetGot: z.boolean().openapi({ description: 'True until the user taps "I got it".' }),
  })
  .openapi('RoutineRecommendedProduct', { description: 'A product from the catalog the user does not have yet.' })

const NoProduct = z.object({ kind: z.literal('none') }).openapi('RoutineNoProduct', { description: '"Use what you have": nothing to recommend for this step.' })

const RoutineStepResponse = z
  .object({
    step: z.enum(ROUTINE_STEPS),
    frequency: z.enum(FREQUENCIES),
    reason: z.string().openapi({ description: 'Why, in words for the user.' }),
    changed: z.boolean().openapi({ description: 'True when this step\'s product or frequency differs from the routine the user was last shown, or that routine had no such step. Always false the first time a routine is shown.' }),
    product: z.discriminatedUnion('kind', [OwnProduct, RecommendedProduct, NoProduct]),
  })
  .openapi('RoutineStep')

const RoutineTaperResponse = z
  .object({
    entryId: z.string().openapi({ description: 'The shelf entry being stepped down.' }),
    brand: z.string().nullable(),
    name: z.string(),
    code: z.string().openapi({ description: 'The step-down\'s code.' }),
    kind: z.enum(TAPER_KINDS),
    whatToExpect: z.string(),
    seeAProfessionalIf: z.string(),
    steps: z
      .array(
        z.object({
          fromWeek: z.number().int().openapi({ description: 'The first week of the step, counting from 1.' }),
          toWeek: z.number().int().openapi({ description: 'The last week of the step; the same as `fromWeek` for a single week.' }),
          frequency: z.enum([...FREQUENCIES, 'stop']),
          fromDate: z.string().optional().openapi({ description: 'The first day of the step, as `YYYY-MM-DD` (UTC). Only once the routine is started.' }),
          toDate: z.string().optional().openapi({ description: 'The last day of the step, as `YYYY-MM-DD` (UTC). Only once the routine is started.' }),
        }),
      )
      .openapi({ description: 'The steps in order, ending with `stop`.' }),
  })
  .openapi('RoutineTaper')

const body = {
  startedOn: z.string().nullable().openapi({ description: 'The day the user tapped Start, as `YYYY-MM-DD` (UTC); null until they do.' }),
  expectation: z.string().openapi({ description: 'What to expect and when, in plain words.' }),
  steps: z.array(RoutineStepResponse).openapi({ description: 'In routine order.' }),
  tapers: z.array(RoutineTaperResponse).openapi({ description: 'One per product being stopped.' }),
}

export const ReadyRoutineResponse = z.object({ status: z.literal('ready'), ...body }).openapi('ReadyRoutine')
export const UpdatingRoutineResponse = z.object({ status: z.literal('updating'), ...body }).openapi('UpdatingRoutine')

export const RoutineResponse = z
  .discriminatedUnion('status', [z.object({ status: z.literal('pending') }), ReadyRoutineResponse, UpdatingRoutineResponse])
  .openapi('Routine', {
    description:
      '`pending`: there is nothing to show yet (a first build is on its way, or the routine no longer fits the safety answers and is being rebuilt). `ready`: the routine in force. ' +
      '`updating`: the routine in force, while a newer one is being built.',
  })

export type RoutineResponse = z.infer<typeof RoutineResponse>
