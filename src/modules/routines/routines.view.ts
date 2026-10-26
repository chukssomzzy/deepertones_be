import type { z } from '@hono/zod-openapi'
import type { ProductSummary } from '../catalog/catalog.service'
import type { RecommendedByCode } from '../catalog/catalog.workbook.repository'
import type { CountryRow, TaperRow } from '../catalog/catalog.workbook.schema'
import { GOAL_LABELS } from '../goals/goals.vocabulary'
import { stepDownMessage } from './routines.copy'
import type { RoutineVersionRow } from './routines.repository'
import type { ReadyRoutineResponse, UpdatingRoutineResponse } from './routines.schemas'

type RoutineBody = z.infer<typeof ReadyRoutineResponse> | z.infer<typeof UpdatingRoutineResponse>
type PublicStep = RoutineBody['steps'][number]
type PublicProduct = PublicStep['product']

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
  /** The shelf entries the version names, with the formulation of a product entry (a no-label entry has none): what makes an entry the product the user was recommended. */
  own: ReadonlyMap<string, { brand: string | null; name: string; formulationId?: string }>
  /** The recommended rows the version names and the one shown before names, retired ones included. */
  recommended: ReadonlyMap<string, RecommendedByCode>
  /** By formulation id: the brand, name and image of a recommended product. */
  summaries: ReadonlyMap<string, ProductSummary>
  /** The step-down templates the version names, by code. */
  tapers: ReadonlyMap<string, TaperRow>
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
// stored version later must not reach a client unless it is named here.
const productOf = (step: RoutineVersionRow['steps'][number], input: RoutineViewInput): PublicProduct => {
  const { product } = step
  if (product.kind === 'shelf') {
    const own = input.own.get(product.id)
    // An entry taken off the shelf since this version was built has no name to show: the rebuild that follows drops it.
    return own ? { kind: 'own', entryId: product.id, brand: own.brand, name: own.name } : { kind: 'none' }
  }
  if (product.kind === 'none') return { kind: 'none' }
  const row = input.recommended.get(product.code)
  const summary = row?.formulationId ? input.summaries.get(row.formulationId) : undefined
  // A code that names no row, or a row with no product to name, cannot be shown; "use what you have" is what it falls back to.
  if (!row || !summary) return { kind: 'none' }
  const here = isSoldIn(row, input.country) ? row.availability.find((sold) => sold.country === input.country) : undefined
  const currency = input.countries.find((country) => country.code === input.country)?.currency
  return {
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
  }
}

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
          ...(began === null ? {} : { fromDate: dayString(began + (fromWeek - 1) * WEEK_DAYS * DAY_MS), toDate: dayString(began + (toWeek * WEEK_DAYS - 1) * DAY_MS) }),
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
  return {
    status: input.status,
    startedOn: version.startedOn === null ? null : dayString(utcDay(version.startedOn)),
    expectation: version.expectation ?? '',
    steps: version.steps.map((step) => ({ step: step.step, frequency: step.frequency, reason: step.reason, changed: changedSince(step, previous, input), product: productOf(step, input) })),
    tapers,
    summary: summaryOf(input, tapers),
  }
}
