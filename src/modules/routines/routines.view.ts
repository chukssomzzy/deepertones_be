import type { z } from '@hono/zod-openapi'
import type { ProductSummary } from '../catalog/catalog.service'
import { daysBetween, dueOnDay } from '../catalog/catalog.frequency'
import { FREQUENCY_STRENGTH, ROUTINE_STEPS, type Frequency, type ProductForm } from '../catalog/catalog.vocabulary'
import type { RecommendedByCode } from '../catalog/catalog.workbook.repository'
import type { CountryRow, TaperRow } from '../catalog/catalog.workbook.schema'
import { GOAL_LABELS } from '../goals/goals.vocabulary'
import { stepDownLineFor, stepDownMessage, titleFor, whenFor } from './routines.copy'
import type { RoutineVersionRow } from './routines.repository'
import type { ReadyRoutineResponse, UpdatingRoutineResponse } from './routines.schemas'

type RoutineBody = z.infer<typeof ReadyRoutineResponse> | z.infer<typeof UpdatingRoutineResponse>
type PublicEntry = RoutineBody['morning'][number]
type PublicProduct = PublicEntry['product']

/** What the skin-care state does to a step of the routine: its status on the screen, and for a step being brought back the rung's frequency and the day the rung's count starts. A step with none is active. */
export type StepOverlay = { status: Exclude<PublicEntry['status'], 'active'>; frequency?: Frequency; anchor?: string; rung?: number; of?: number }

/** Everything the routine screen is made of, read by the viewer service and handed over: a stored version and the reads around it. */
export type RoutineViewInput = {
  status: 'ready' | 'updating'
  /** The routine in force. */
  version: RoutineVersionRow
  /** The newest version shown before this one, for `changed`; null when none was. */
  previous: RoutineVersionRow | null
  /** The country the profile shops in. */
  country: string
  countries: readonly CountryRow[]
  /** The shelf entries the version names, with the formulation of a product entry (a no-label entry has none): what makes an entry the product the user was recommended. `form` is the product's own, for its title. */
  own: ReadonlyMap<string, { brand: string | null; name: string; formulationId?: string; form?: ProductForm | null }>
  /** The recommended rows the version names and the one shown before names, retired ones included. */
  recommended: ReadonlyMap<string, RecommendedByCode>
  /** By formulation id: the brand, name and image of a recommended product. */
  summaries: ReadonlyMap<string, ProductSummary>
  /** The step-down templates the version names, by code. */
  tapers: ReadonlyMap<string, TaperRow>
  /** What the skin-care state does to each step, by the step as the version stores it. Absent (or a step with no entry): every step is active. */
  overlay?: ReadonlyMap<RoutineVersionRow['steps'][number], StepOverlay>
}

/** What a step-down names when its product has left the shelf since the version was built: the plan is still the person's, and the schedule is what matters. */
const GONE_PRODUCT_NAME = "A product you're stepping down"

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_DAYS = 7

const utcDay = (date: Date): number => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
const dayString = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** Whether a recommended row is sold in the country now: only an approved row is; a draft or retired one is sold nowhere, whatever the workbook still lists for it. */
export const isSoldIn = (row: RecommendedByCode, country: string): boolean => row.status === 'approved' && row.availability.some((sold) => sold.country === country)

const sameProduct = (a: RoutineVersionRow['steps'][number]['product'], b: RoutineVersionRow['steps'][number]['product']): boolean => {
  if (a.kind === 'shelf') return b.kind === 'shelf' && a.id === b.id
  if (a.kind === 'candidate') return b.kind === 'candidate' && a.code === b.code
  return b.kind === 'none'
}

/** Whether a recommended product of the version shown before is, as the version in force has it, the user's own shelf entry of the same formulation (they got it). */
const gotAsOwn = (before: RoutineVersionRow['steps'][number]['product'], now: RoutineVersionRow['steps'][number]['product'], input: RoutineViewInput): boolean => {
  if (before.kind !== 'candidate' || now.kind !== 'shelf') return false
  const formulationId = input.recommended.get(before.code)?.formulationId
  return !!formulationId && input.own.get(now.id)?.formulationId === formulationId
}

// A step the version shown before had no entry for counts as changed. Rewording a reason, or the user getting the product (it becomes their own entry of the same
// formulation, which is the swap of story 30), is not a change.
const changedSince = (step: RoutineVersionRow['steps'][number], previous: RoutineVersionRow | null, input: RoutineViewInput): boolean => {
  if (previous === null) return false
  const before = previous.steps.find((entry) => entry.step === step.step)
  return !before || before.frequency !== step.frequency || !(sameProduct(before.product, step.product) || gotAsOwn(before.product, step.product, input))
}

// Written out field by field: grounding, where a step came from and the stored version's own columns are how the routine was reached, and a field added to the
// stored version later must not reach a client unless it is named here. `form` is the product's, for the title; a step that falls back to "none" has none.
const productOf = (step: RoutineVersionRow['steps'][number], input: RoutineViewInput): { product: PublicProduct; form: ProductForm | null } => {
  const { product } = step
  if (product.kind === 'shelf') {
    const own = input.own.get(product.id)
    // An entry taken off the shelf since this version was built has no name to show: the rebuild that follows drops it.
    return own ? { product: { kind: 'own', entryId: product.id, brand: own.brand, name: own.name }, form: own.form ?? null } : { product: { kind: 'none' }, form: null }
  }
  if (product.kind === 'none') return { product: { kind: 'none' }, form: null }
  const row = input.recommended.get(product.code)
  const summary = row?.formulationId ? input.summaries.get(row.formulationId) : undefined
  // A code that names no row, or a row with no product to name, cannot be shown; "use what you have" is what it falls back to.
  if (!row || !summary) return { product: { kind: 'none' }, form: null }
  const here = isSoldIn(row, input.country) ? row.availability.find((sold) => sold.country === input.country) : undefined
  const currency = input.countries.find((country) => country.code === input.country)?.currency
  return {
    form: summary.form,
    product: {
      kind: 'recommended',
      code: row.code,
      brand: summary.brand,
      name: summary.name,
      imageUrl: summary.imageUrl,
      ...(row.origin === 'brand-submitted' ? { origin: 'brand-submitted' as const } : {}),
      price: here && currency ? { min: here.priceMin, max: here.priceMax, currency } : null,
      whereSold: here?.whereSold ?? null,
      soldInCurrentCountry: here !== undefined,
      soldElsewhere: row.status === 'approved' ? row.availability.filter((sold) => sold.country !== input.country).map((sold) => sold.country) : [],
      keyIngredient: row.keyIngredient,
      strength: row.strength,
      notYetGot: !step.gotIt,
    },
  }
}

const titleOf = (step: RoutineVersionRow['steps'][number], input: RoutineViewInput): { title: string; product: PublicProduct } => {
  const { product, form } = productOf(step, input)
  const keyIngredient = product.kind === 'recommended' ? product.keyIngredient : null
  return { title: titleFor({ step: step.step, form, keyIngredient }), product }
}

/** The rung a step is being brought back at, when it is: its frequency and the day its count starts. */
const rungOf = (step: RoutineVersionRow['steps'][number], input: RoutineViewInput): StepOverlay | undefined => {
  const over = input.overlay?.get(step)
  return over?.status === 'bringing-back' ? over : undefined
}

/**
 * How often a step is used now: the rung's while it is being brought back, else the routine's own; never more often than the routine's own (a weekly step on a ladder that climbs
 * past weekly stays weekly until the ladder ends). The body's `when`, the list it is in and the reminders all follow it.
 */
const frequencyOf = (step: RoutineVersionRow['steps'][number], input: RoutineViewInput): RoutineVersionRow['steps'][number]['frequency'] => {
  const rung = rungOf(step, input)?.frequency
  return rung === undefined || FREQUENCY_STRENGTH[rung] >= FREQUENCY_STRENGTH[step.frequency] ? step.frequency : rung
}

const entryOf = (step: RoutineVersionRow['steps'][number], previous: RoutineVersionRow | null, input: RoutineViewInput): PublicEntry => {
  const { title, product } = titleOf(step, input)
  return { step: step.step, title, when: whenFor(frequencyOf(step, input)), reason: step.reason, status: input.overlay?.get(step)?.status ?? 'active', changed: changedSince(step, previous, input), product }
}

// Morning is am and am-pm; evening is pm, am-pm and anything used less than daily, which the routine places in the evening. The sunscreen is only ever a morning step.
type Placed = Pick<RoutineVersionRow['steps'][number], 'step' | 'frequency'>
const inMorning = ({ step, frequency }: Placed): boolean => step === 'protect' || frequency === 'am' || frequency === 'am-pm'
const inEvening = ({ step, frequency }: Placed): boolean => step !== 'protect' && frequency !== 'am'

/** An entry of the reminder plan: the routine entry's step and title, with the step's raw frequency (the body shows only the `when` label). A step being brought back has its rung's frequency and the `anchor` day that count starts from. */
export type ReminderPlanEntry = { step: RoutineVersionRow['steps'][number]['step']; title: string; frequency: RoutineVersionRow['steps'][number]['frequency']; anchor?: string }

/** The calendar date a step-down's week begins, counting from the day the step-down began. */
const fromDateOf = (began: number, week: number): string => dayString(began + (week - 1) * WEEK_DAYS * DAY_MS)

/** The first millisecond after the week ends (the UTC midnight of the day after its last day), counting from the day the step-down began. */
const afterWeekOf = (began: number, week: number): number => began + week * WEEK_DAYS * DAY_MS

/** One day a step of a step-down begins, for the step-down alert: the product's routine title and the step's fixed line. */
export type StepDownChange = { day: string; title: string; line: string }

/** What the reminder send job reads: day 1, the morning and evening lists, placed, ordered and titled as the body places them, and the days a step-down changes. */
export type ReminderPlan = { dayOne: string; morning: ReminderPlanEntry[]; evening: ReminderPlanEntry[]; stepDownChanges: StepDownChange[] }

const tapersOf = (input: RoutineViewInput): RoutineBody['tapers'] =>
  input.version.tapers.flatMap((stopped) => {
    const template = input.tapers.get(stopped.templateId)
    // A template the workbook no longer holds has no schedule to show: the step-down is dropped, and logged so it is noticed.
    if (!template) {
      console.error({ outcome: 'routine-taper-template-missing', profileId: input.version.profileId, templateId: stopped.templateId })
      return []
    }
    // A stopped product taken off the shelf since is still stepped down, so it stays, under a neutral name; hiding it would hide a schedule the person is on.
    const own = input.own.get(stopped.shelfProductId) ?? { brand: null, name: GONE_PRODUCT_NAME }
    // A step-down begun after Start begins the day of its rebuild, so its weeks count from its own day.
    const began = stopped.startedOn === null ? null : utcDay(stopped.startedOn)
    return [
      {
        entryId: stopped.shelfProductId,
        brand: own.brand,
        name: own.name,
        code: template.code,
        kind: template.kind,
        whatToExpect: template.whatToExpect,
        seeAProfessionalIf: template.seeAProfessionalIf,
        steps: template.schedule.map(({ fromWeek, toWeek, frequency }) => ({
          fromWeek,
          toWeek,
          // A step's frequency is typed as text, but the workbook reader refuses a schedule whose frequency is not a routine frequency or stop.
          frequency: frequency as RoutineBody['tapers'][number]['steps'][number]['frequency'],
          ...(began === null ? {} : { fromDate: fromDateOf(began, fromWeek), toDate: dayString(afterWeekOf(began, toWeek) - DAY_MS) }),
        })),
      },
    ]
  })

// The plan summary, worked out from the version's stored counts so it always matches the routine beside it. Its step-down names the tapers shown, so a schedule the
// workbook no longer holds is not named either. A version with no stored counts (built before the column) has none: counting from what it holds would be a guess.
const summaryOf = (input: RoutineViewInput, tapers: RoutineBody['tapers']): RoutineBody['summary'] => {
  const { shelfCounts, goal } = input.version
  if (shelfCounts === null || goal === null) return null
  const products = tapers.map(({ brand, name }) => ({ brand, name }))
  return {
    goal: { id: goal, label: GOAL_LABELS[goal] },
    keepUsing: shelfCounts.keep,
    useLessOrChange: shelfCounts.reduce + shelfCounts.drop,
    stepDown: products.length === 0 ? null : { products, message: stepDownMessage(products) },
  }
}

/** The body `GET /me/routine` answers for a routine in force. The viewer service sends this same body on the event stream, and the routes answer it: one mapping. */
export const toRoutineResponse = (input: RoutineViewInput): RoutineBody => {
  const { version, previous } = input
  const tapers = tapersOf(input)
  const ordered = [...version.steps].sort((a, b) => ROUTINE_STEPS.indexOf(a.step) - ROUTINE_STEPS.indexOf(b.step))
  return {
    status: input.status,
    startedOn: version.startedOn === null ? null : dayString(utcDay(version.startedOn)),
    expectation: version.expectation ?? '',
    morning: ordered.filter((step) => inMorning({ step: step.step, frequency: frequencyOf(step, input) })).map((step) => entryOf(step, previous, input)),
    evening: ordered.filter((step) => inEvening({ step: step.step, frequency: frequencyOf(step, input) })).map((step) => entryOf(step, previous, input)),
    // The stored list as it was built, field by field like everything else here: its titles and reasons were fixed at the build, and a product since gone from the shelf still shows.
    notInRoutine: version.notInRoutine?.map(({ entryId, title, status, reason }) => ({ entryId, title, status, reason })) ?? null,
    tapers,
    summary: summaryOf(input, tapers),
  }
}

const frozenTitleOf = (input: RoutineViewInput, shelfProductId: string): string => input.version.notInRoutine?.find(({ entryId }) => entryId === shelfProductId)?.title ?? GONE_PRODUCT_NAME

// One change for the first day of each step of each dated step-down's schedule (week one and the stop included), in the version's order of step-downs and then the schedule's. The title
// is the one frozen in `notInRoutine` when the build left the product out: the maker's brand and name are its own words, and an alert on a lock screen names the routine's plain title.
// A step-down with no start has no days yet; one whose template the workbook no longer holds has none either, and is logged as the body logs it.
const stepDownChangesOf = (input: RoutineViewInput): StepDownChange[] =>
  input.version.tapers.flatMap((stopped) => {
    if (stopped.startedOn === null) return []
    const template = input.tapers.get(stopped.templateId)
    if (!template) {
      console.error({ outcome: 'routine-taper-template-missing', profileId: input.version.profileId, templateId: stopped.templateId })
      return []
    }
    const title = frozenTitleOf(input, stopped.shelfProductId)
    const began = utcDay(stopped.startedOn)
    return template.schedule.map(({ fromWeek, frequency }) => ({ day: fromDateOf(began, fromWeek), title, line: stepDownLineFor(frequency as Frequency | 'stop') }))
  })

/** The plan a Started routine's reminders are made of; null while the version has no day 1. The titles need no `previous`; the step-down days need `tapers` (the viewer reads them for the plan). */
export const toReminderPlan = (input: RoutineViewInput): ReminderPlan | null => {
  const { version } = input
  if (version.startedOn === null) return null
  const ordered = [...version.steps].sort((a, b) => ROUTINE_STEPS.indexOf(a.step) - ROUTINE_STEPS.indexOf(b.step))
  // A paused or held step is not reminded of. A step being brought back is placed, and counted, by its rung instead of the routine's frequency.
  const entries = ordered.flatMap((step): ReminderPlanEntry[] => {
    const over = input.overlay?.get(step)
    if (over?.status === 'paused' || over?.status === 'held') return []
    const rung = rungOf(step, input)
    return [{ step: step.step, title: titleOf(step, input).title, frequency: frequencyOf(step, input), ...(rung?.anchor === undefined ? {} : { anchor: rung.anchor }) }]
  })
  return { dayOne: dayString(utcDay(version.startedOn)), morning: entries.filter(inMorning), evening: entries.filter(inEvening), stepDownChanges: stepDownChangesOf(input) }
}

/** An entry of Today's list: the routine's entry as the screen shows it, without `changed`, and never a paused or held step. */
export type TodayEntry = Omit<PublicEntry, 'changed' | 'status'> & { status: 'active' | 'bringing-back' }

/**
 * The entries due on `day` (a local day, 'YYYY-MM-DD') in the morning and in the evening, in routine order. A paused or held step is left out. The evening list holds only what is due that day,
 * counted from day 1 or, for a step being brought back, from its rung's first day: the same arithmetic the reminders use. A started routine's day 1 is its `startedOn`; null gives none.
 */
export const toTodayLists = (input: RoutineViewInput, day: string): { morning: TodayEntry[]; evening: TodayEntry[] } => {
  const { startedOn } = input.version
  if (startedOn === null) return { morning: [], evening: [] }
  const dayOne = dayString(utcDay(startedOn))
  const ordered = [...input.version.steps].sort((a, b) => ROUTINE_STEPS.indexOf(a.step) - ROUTINE_STEPS.indexOf(b.step))
  const morning: TodayEntry[] = []
  const evening: TodayEntry[] = []
  for (const step of ordered) {
    const over = input.overlay?.get(step)
    if (over?.status === 'paused' || over?.status === 'held') continue
    const frequency = frequencyOf(step, input)
    const { changed: _changed, status, ...entry } = entryOf(step, null, input)
    const shown: TodayEntry = { ...entry, status: status === 'bringing-back' ? 'bringing-back' : 'active' }
    if (inMorning({ step: step.step, frequency })) morning.push(shown)
    if (inEvening({ step: step.step, frequency }) && dueOnDay(frequency, rungOf(step, input)?.anchor ?? dayOne, day)) evening.push(shown)
  }
  return { morning, evening }
}

/** The week of the plan on `day`: days 1 to 7 are week 1, and so on with no cap. Null before day 1. */
export const weekOf = (dayOne: string, day: string): number | null => {
  const since = daysBetween(dayOne, day)
  return since < 0 ? null : Math.floor(since / WEEK_DAYS) + 1
}

/** The title a step shows on the screen. */
export const stepTitleOf = (step: RoutineVersionRow['steps'][number], input: RoutineViewInput): string => titleOf(step, input).title

/** Where a dated step-down is today: step `step` of `of`, whether it is still running, and the first day of the next step (null on the last). */
export type StepDownProgress = { entryId: string; title: string; step: number; of: number; running: boolean; nextChange: string | null }

/**
 * Where each step-down that has begun is on `today` (a local day, 'YYYY-MM-DD'), in the order given, by the arithmetic the schedule screen counts its dates with. A step-down with no
 * start date has not begun, and one whose template the workbook no longer holds has no schedule: both are left out, the second logged as the body logs it (with the profile's id, when given). A step-down is running
 * until its start plus the last week's end (so also before its first day), and after that it is still its last step.
 */
export const stepDownProgressOf = (
  tapers: readonly (Pick<RoutineVersionRow['tapers'][number], 'shelfProductId' | 'templateId' | 'startedOn'> & { title: string })[],
  templates: ReadonlyMap<string, TaperRow>,
  today: string,
  profileId?: string,
): StepDownProgress[] =>
  tapers.flatMap((stopped) => {
    if (stopped.startedOn === null) return []
    const template = templates.get(stopped.templateId)
    if (!template) {
      console.error({ outcome: 'routine-taper-template-missing', profileId, templateId: stopped.templateId })
      return []
    }
    const began = utcDay(stopped.startedOn)
    const day = Date.parse(`${today}T00:00:00.000Z`)
    const { schedule } = template
    const found = schedule.findIndex(({ toWeek }) => day < afterWeekOf(began, toWeek))
    const at = found === -1 ? schedule.length - 1 : found
    const next = schedule[at + 1]
    return [
      {
        entryId: stopped.shelfProductId,
        title: stopped.title,
        step: at + 1,
        of: schedule.length,
        running: day < afterWeekOf(began, schedule[schedule.length - 1]!.toWeek),
        nextChange: next === undefined ? null : fromDateOf(began, next.fromWeek),
      },
    ]
  })

/** `stepDownProgressOf` over the version's own step-downs, each under the plain title its row of `notInRoutine` froze. */
export const stepDownsOf = (input: RoutineViewInput, today: string): StepDownProgress[] =>
  stepDownProgressOf(
    input.version.tapers.map((stopped) => ({ ...stopped, title: frozenTitleOf(input, stopped.shelfProductId) })),
    input.tapers,
    today,
    input.version.profileId,
  )
