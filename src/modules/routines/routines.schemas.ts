import { z } from '@hono/zod-openapi'
import { GOALS } from '../goals/goals.vocabulary'
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

const RoutineEntryResponse = z
  .object({
    step: z.enum(ROUTINE_STEPS),
    title: z.string().openapi({ description: 'The product in plain words ("Gel cleanser", "Niacinamide serum", "Sunscreen"): a capital, no full stop.' }),
    when: z.string().openapi({ description: 'How often, in words for the card: "Every day", "3 evenings a week", "Once a week" or "When you need it".' }),
    reason: z.string().openapi({ description: 'Why, in words for the user.' }),
    changed: z.boolean().openapi({ description: 'True when this step\'s product or frequency differs from the routine the user was last shown, or that routine had no such step. Always false the first time a routine is shown.' }),
    product: z.discriminatedUnion('kind', [OwnProduct, RecommendedProduct, NoProduct]),
  })
  .openapi('RoutineEntry', { description: 'One card of the Morning or Evening list. A step used morning and evening is the same entry in both lists.' })

const NotInRoutineResponse = z
  .object({
    entryId: z.string().openapi({ description: 'The shelf entry: its `id` from `GET /api/v1/me/shelf`. It may have left the shelf since the routine was built.' }),
    title: z.string().openapi({ description: 'The product in plain words, as the routine titles one.' }),
    status: z.enum(['stepping-down', 'left-out']).openapi({ description: '`stepping-down`: being stopped step by step (see `tapers`). `left-out`: not part of the routine.' }),
    reason: z.string().openapi({ description: 'The verdict\'s own one-line reason for the product, as it was when the routine was built.' }),
  })
  .openapi('RoutineNotInRoutine')

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

const RoutineSummaryResponse = z
  .object({
    goal: z.object({ id: z.enum(GOALS), label: z.string().openapi({ description: 'The goal as the goal chips name it.' }) }).openapi({ description: 'The goal the routine was built for.' }),
    keepUsing: z.number().int().openapi({ description: 'Shelf products used as they are. A sunscreen the rules would reduce counts here too: sun protection is never used less.' }),
    useLessOrChange: z.number().int().openapi({ description: 'Shelf products to use less often, or to leave out (redundant, in the way of the goal, or not clear enough to keep).' }),
    stepDown: z
      .object({
        products: z.array(z.object({ brand: z.string().nullable(), name: z.string() })).openapi({ description: 'The products being stopped step by step, as in `tapers`.' }),
        message: z.string().openapi({ description: 'The fixed sentence for the card, naming the products.' }),
      })
      .nullable()
      .openapi({ description: 'Null when nothing is being stopped.' }),
  })
  .openapi('RoutineSummary', {
    description:
      'The "Your plan is ready" screen. The counts were fixed when the routine was built, so they always match it: every shelf product the routine was built from is in exactly one of `keepUsing`, `useLessOrChange` and the step-down.',
  })

const body = {
  summary: RoutineSummaryResponse.nullable().openapi({ description: 'Null for a routine built before summaries were kept; it gains one at its next rebuild.' }),
  startedOn: z.string().nullable().openapi({ description: 'Day 1 of the routine, as `YYYY-MM-DD` (UTC): the day after the user tapped Start; null until they do. Step-down dates count from it.' }),
  expectation: z.string().openapi({ description: 'What to expect and when, in plain words.' }),
  morning: z.array(RoutineEntryResponse).openapi({ description: 'The morning list, in routine order (cleanse, treat, moisturise, protect). The sunscreen is only ever here.' }),
  evening: z.array(RoutineEntryResponse).openapi({ description: 'The evening list, in routine order. Anything used less than daily (every other day, weekly, as needed) is here.' }),
  notInRoutine: z.array(NotInRoutineResponse).nullable().openapi({
    description:
      'The shelf products the routine was built without, in the shelf\'s order: stopped ones (`stepping-down`) and dropped ones (`left-out`). Products used less often stay in the lists. Fixed when the routine was built. Null for a routine built before the list was kept (unknown, not none); it gains one at its next rebuild.',
  }),
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
