import { z } from '@hono/zod-openapi'
import { GOALS } from '../goals/goals.vocabulary'
import { FREQUENCIES, ROUTINE_STEPS, TAPER_KINDS } from '../catalog/catalog.vocabulary'
import { CHECK_IN_TIMES } from './routines.check-ins.vocabulary'

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
    when: z.string().openapi({ description: 'How often, in words for the card: "Every day", "Every other evening", "Once a week" or "When you need it".' }),
    reason: z.string().openapi({ description: 'Why, in words for the user.' }),
    status: z.enum(['active', 'paused', 'held', 'bringing-back']).openapi({ description: '`active` for a step in the routine as written. `paused`: left out for now. `held`: left out while a hold is open. `bringing-back`: used again at a gentler pace.' }),
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
          fromDate: z.string().optional().openapi({ description: 'The first day of the step, as `YYYY-MM-DD`: a calendar date, the person\'s local date once a time zone is stored (UTC otherwise), fixed when the step-down began. Only once the routine is started.' }),
          toDate: z.string().optional().openapi({ description: 'The last day of the step, as `YYYY-MM-DD`, counted from `fromDate` in calendar days. Only once the routine is started.' }),
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
  startedOn: z.string().nullable().openapi({ description: 'Day 1 of the routine, as `YYYY-MM-DD`: the day after the user tapped Start, in their local calendar once a time zone is stored (UTC otherwise); fixed when set, so a later change of time zone does not move it. Null until they tap Start. Step-down dates count from it.' }),
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

const LookForProduct = z
  .object({
    code: z.string().openapi({ description: 'The catalog code of the product.' }),
    brand: z.string(),
    name: z.string(),
    imageUrl: z.string().nullable(),
    origin: z.literal('brand-submitted').optional().openapi({ description: 'Only on a product a brand submitted for review, which says so. The review fee never affects the choice.' }),
    aboutPrice: z.object({ amount: z.number(), currency: z.string() }).openapi({ description: 'About what it costs: the lowest price it is sold at in the country the profile shops in.' }),
    whereSold: z.string().nullable().openapi({ description: 'Where to find it in the shopping country; null when the review does not say.' }),
    why: z.string().openapi({ description: 'One fixed line on why this product is here: the concerns of the goal it works on, in plain words.' }),
    keyIngredient: z.string().nullable(),
    strength: z.string().nullable(),
    inYourRoutine: z.boolean().openapi({ description: 'True for the product the routine recommends for this step; it is listed first.' }),
  })
  .openapi('LookForProduct')

export const LookForResponse = z
  .object({
    category: z.string().openapi({ description: 'The step\'s plain noun: Cleanser, Treatment, Moisturiser or Sunscreen.' }),
    guide: z
      .object({
        whatItDoes: z.string(),
        lookFor: z.string().openapi({ description: 'What to look for in this kind of product. For a person who is pregnant or breastfeeding it is the guide\'s pregnancy-safe text when it has one.' }),
        forDeeperSkin: z.string(),
      })
      .openapi({ description: 'Reviewed copy for the step, written for the person\'s goal when the guide has a row for it.' }),
    typicalPrice: z
      .object({ low: z.number(), high: z.number(), currency: z.string() })
      .nullable()
      .openapi({ description: 'The lowest price to the highest price across every reviewed product for the step in the shopping country, not only the ones listed; null when there are none.' }),
    commonlySoldAt: z.array(z.string()).openapi({ description: 'Up to three places that most of those products are sold at, most common first.' }),
    products: z.array(LookForProduct).openapi({ description: 'At most ten reviewed products that suit the person: the routine\'s pick first, then the cheapest.' }),
  })
  .openapi('LookFor')

export type LookForResponse = z.infer<typeof LookForResponse>

export const CheckInBody = z
  .object({
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .openapi({ description: 'The local day checked in for, `YYYY-MM-DD`: today or yesterday in the person\'s time zone (UTC with none stored), and not before day 1.', example: '2030-06-15' }),
    time: z.enum(CHECK_IN_TIMES).openapi({ description: 'Which routine was done: `morning` or `evening`.' }),
  })
  .openapi('CheckInBody')

export const CheckInResponse = z.object({ day: z.string().openapi({ example: '2030-06-15' }), time: z.enum(CHECK_IN_TIMES) }).openapi('CheckIn')

const TodayEntryResponse = RoutineEntryResponse.omit({ changed: true })
  .extend({ status: z.enum(['active', 'bringing-back']).openapi({ description: '`active`, or `bringing-back` for a step used again at a gentler pace after a pause. A paused or held step is not listed.' }) })
  .openapi('TodayEntry', { description: 'One card of a half of the day: the routine\'s entry, without `changed`.' })

const TodayHalfResponse = z.object({
  done: z.boolean().openapi({ description: 'Whether the person ticked this half off today (`POST /api/v1/me/routine/check-ins`).' }),
  entries: z.array(TodayEntryResponse).openapi({ description: 'What is due in this half today, in routine order. A paused or held step, an as-needed step and a step on its rest day are left out.' }),
})

const TodayInboxItemResponse = z.object({
  id: z.string(),
  kind: z.string(),
  day: z.string().openapi({ example: '2030-06-15' }),
  title: z.string(),
  body: z.string(),
  link: z.string().openapi({ description: 'An in-app path to open when the item is tapped.', example: '/routine' }),
  read: z.boolean(),
  createdAt: z.string().openapi({ format: 'date-time' }),
})

export const TodayResponse = z
  .object({
    started: z.boolean().openapi({ description: 'Whether the routine in force has a day 1 (Start was tapped). False with no routine, with one a safety change hides, and with one not started.' }),
    day: z.string().openapi({ description: 'The person\'s local day, `YYYY-MM-DD`: their stored time zone\'s, else UTC (also for a stored zone that cannot be used).', example: '2030-06-15' }),
    startsOn: z.string().nullable().openapi({ description: 'Day 1, `YYYY-MM-DD`, once started. Start makes tomorrow day 1, so on the day of the tap it is ahead of `day`.' }),
    week: z.number().int().nullable().openapi({ description: 'The week of the plan, counted from day 1 with no cap. Null before day 1 and when not started.' }),
    card: z.object({ title: z.string(), text: z.string() }).nullable().openapi({ description: 'The reviewed card for the week, written for the current goal and for a step-down when the team has written one. Null before day 1, and when no card is approved for the week.' }),
    half: z.enum(['morning', 'evening']).openapi({ description: 'The current half of the local day: morning before 15:00, evening from 15:00. Fixed; not the reminder times.' }),
    current: TodayHalfResponse.openapi({ description: 'The current half.' }),
    other: TodayHalfResponse.openapi({ description: 'The other half of the day.' }),
    allDone: z.boolean().openapi({ description: 'Both halves ticked off today.' }),
    stepDowns: z
      .array(z.object({ entryId: z.string(), title: z.string(), step: z.number().int(), of: z.number().int(), line: z.string().openapi({ example: 'Step-down: step 1 of 3' }) }))
      .openapi({ description: 'Each step-down that is running, with where it is.' }),
    checkInsDue: z
      .array(
        z.object({
          pauseId: z.string().openapi({ description: 'The pause the check-in answers (`POST /api/v1/me/skin-care/pauses/{id}/check-in`).' }),
          step: z.enum(ROUTINE_STEPS).nullable().openapi({ description: 'Null for the check-in that has no step (nothing could be paused).' }),
          title: z.string().nullable().openapi({ description: 'The routine\'s title for the step; null with no step.' }),
          checkDay: z.string().openapi({ example: '2030-06-18' }),
        }),
      )
      .openapi({ description: 'The check-ins after a pause that are due, until answered.' }),
    hold: z.object({ title: z.literal('See a professional') }).nullable().openapi({ description: 'Set while a hold is open.' }),
    bringingBack: z
      .array(z.object({ step: z.enum(ROUTINE_STEPS), title: z.string(), rung: z.number().int(), of: z.number().int(), line: z.string().openapi({ example: 'Bringing back Serum: step 2 of 3' }) }))
      .openapi({ description: 'Each step being brought back after a pause, on rest days too.' }),
    paused: z
      .array(
        z.object({
          pauseId: z.string().openapi({ description: 'The pause, as in `checkInsDue`.' }),
          step: z.enum(ROUTINE_STEPS),
          title: z.string().openapi({ description: 'The routine\'s title for the step.' }),
          checkDay: z.string().openapi({ description: 'The day the person is asked how the skin is, `YYYY-MM-DD`.', example: '2030-06-18' }),
        }),
      )
      .openapi({ description: 'Each step that is paused (or being held for a professional) and so left out of the halves, with the day it is checked.' }),
    remindersOff: z.boolean().openapi({ description: 'True when reminders are not switched on: show the banner.' }),
    inbox: z.object({ unread: z.number().int(), latest: z.array(TodayInboxItemResponse).openapi({ description: 'The newest five items, newest first, read or not.' }) }),
  })
  .openapi('Today')

export type TodayResponse = z.infer<typeof TodayResponse>
