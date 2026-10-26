import { describe, expect, it, vi } from 'vitest'
import type { ProductSummary } from '../catalog/catalog.service'
import type { RecommendedByCode } from '../catalog/catalog.workbook.repository'
import type { CountryRow, TaperRow } from '../catalog/catalog.workbook.schema'
import { GOALS } from '../goals/goals.vocabulary'
import { contentFor } from '../onboarding/onboarding.content'
import type { RoutineVersionRow } from './routines.repository'
import { toRoutineResponse, type RoutineViewInput } from './routines.view'
import { FORBIDDEN_WORDING } from './routines.wording'

// The routine screen's body (spec #189, PR 4b), as a pure mapping from a stored version and the reads around it. Nothing here touches a service: the
// viewer service gathers the reads and hands them over, and this file pins what a client is shown of them.
//
// THE SIGNATURE ASSUMED (the brief fixes the response, not the function):
//   toRoutineResponse(input: RoutineViewInput): { status: 'ready' | 'updating'; startedOn; expectation; steps; tapers }
//   RoutineViewInput = {
//     status: 'ready' | 'updating'
//     version: RoutineVersionRow                       the routine in force
//     previous: RoutineVersionRow | null               the newest served version other than `version` (repository.lastServedBefore), for `changed`
//     country: string                                  the profile's shopping country
//     countries: CountryRow[]                          workbook.countries(): the currency of `country`
//     own: ReadonlyMap<entryId, { brand: string | null; name: string; formulationId?: string }>   the shelf entries the version names (the formulation of a product entry, for `changed`)
//     recommended: ReadonlyMap<code, RecommendedByCode>                             workbook.recommendedByCode(codes), retired rows included
//     summaries: ReadonlyMap<formulationId, ProductSummary>                         catalog.productSummaries(formulationIds), for brand, name and image
//     tapers: ReadonlyMap<templateId, TaperRow>                                     workbook.tapersByCode(codes)
//   }
// The response (pr4-plan.md): a step is { step, frequency, reason, changed, product }, the product being
//   { kind: 'own', entryId, brand, name } | { kind: 'recommended', code, brand, name, imageUrl, origin?, price, whereSold, soldInCurrentCountry, soldElsewhere,
//     keyIngredient, strength, notYetGot } | { kind: 'none' };
// a taper is { entryId, brand, name, code, kind, whatToExpect, seeAProfessionalIf, steps: { fromWeek, toWeek, frequency, fromDate?, toDate? }[] }.
// `origin` is there only for a brand-submitted product. `soldElsewhere` is country codes. Dates are UTC days ('YYYY-MM-DD'), only once the routine is started.
// PR 5 (the Plan ready summary) adds one column to the stored version and one key to the body:
//   RoutineVersionRow.shelfCounts: { keep: number; reduce: number; drop: number; stop: number } | null   (null while pending, and on a row built before the column)
//   body.summary: { goal: { id, label }, keepUsing, useLessOrChange, stepDown: { products: { brand, name }[], message } | null } | null
//   keepUsing = keep; useLessOrChange = reduce + drop; stepDown is null when stop is 0 and otherwise names the version's step-downs (brand + name, in stored
//   order); summary is null for a version with no stored counts. The goal label is the one the goal chips show (the six pinned in the onboarding content test).
// Two choices the brief leaves open, pinned here and flagged in the report: a taper's dates count from the taper's own `startedOn` (a step-down begun after Start
// begins the day of its rebuild), and a step the previously served version had no entry for counts as changed.

// The one clock every date hangs off: the day the routine was started, at UTC midnight. Other days are offsets from it.
const START = new Date('2030-06-15T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const at = (days: number) => new Date(START.getTime() + days * DAY)
const dayOf = (days: number) => at(days).toISOString().slice(0, 10)

const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as any

const NG: CountryRow = { code: 'NG', currency: 'NGN', lowMax: 5000, midMax: 15000, status: 'active' }
const GH: CountryRow = { code: 'GH', currency: 'GHS', lowMax: 100, midMax: 300, status: 'active' }

type Step = RoutineVersionRow['steps'][number]
const ownStep = (step: Step['step'], entryId: string, frequency: Step['frequency'] = 'am'): Step => ({
  step,
  product: { kind: 'shelf', id: entryId },
  frequency,
  reason: `Keep ${entryId}.`,
  grounding: ['https://internal.example/grounding'],
  gotIt: false,
  fixedFrom: 'version-0',
})
const candidateStep = (step: Step['step'], code: string, frequency: Step['frequency'] = 'pm', over: Partial<Step> = {}): Step => ({
  step,
  product: { kind: 'candidate', code },
  frequency,
  reason: `Use ${code}.`,
  grounding: ['https://internal.example/grounding'],
  gotIt: false,
  fixedFrom: null,
  ...over,
})
const noneStep = (step: Step['step'], frequency: Step['frequency'] = 'am'): Step => ({ step, product: { kind: 'none' }, frequency, reason: 'Use what you have.', grounding: [], gotIt: false, fixedFrom: null })

let ids = 0
const version = (over: Partial<RoutineVersionRow> = {}): RoutineVersionRow => ({
  id: `version-${++ids}`,
  profileId: 'profile-amara',
  status: 'ready',
  createdAt: at(-1),
  steps: [ownStep('cleanse', 'entry-a'), candidateStep('treat', 'SERUM-1'), noneStep('protect')],
  tapers: [],
  expectation: 'Give it 8 to 12 weeks before judging.',
  cautions: [],
  goal: 'fade-dark-marks',
  // Counts that no sum or pairing can be mistaken for: keep 3, reduce 2, drop 4, stop 0 (the default version stops nothing).
  shelfCounts: { keep: 3, reduce: 2, drop: 4, stop: 0 },
  readyAt: at(-1),
  startedOn: null,
  servedAt: null,
  model: 'claude-internal-model',
  promptHash: 'internal-prompt-hash',
  catalogVersion: 7,
  rulesVersion: 'internal-rules-1',
  hintsShown: false,
  verdictFingerprint: 'internal-verdict-fp',
  routineFingerprint: 'internal-routine-fp',
  source: 'writer',
  reason: 'first',
  writerRetryDueAt: null,
  writerCalls: 1,
  ...over,
})

const summary = (formulationId: string, over: Partial<ProductSummary> = {}): ProductSummary => ({
  id: `product-of-${formulationId}`,
  kind: 'named',
  brand: `Brand of ${formulationId}`,
  name: `Name of ${formulationId}`,
  variant: null,
  form: 'serum',
  category: 'skin',
  imageUrl: `https://images.example/${formulationId}.jpg`,
  ...over,
})

const recommendedRow = (code: string, over: Partial<RecommendedByCode> = {}): RecommendedByCode => ({
  code,
  status: 'approved',
  productId: `product-of-form-${code}`,
  formulationId: `form-${code}`,
  origin: 'sourced',
  keyIngredient: null,
  strength: null,
  availability: [{ country: 'NG', priceMin: 3000, priceMax: 4500, whereSold: 'Pharmacies and online' }],
  ...over,
})

const STEROID_TEMPLATE: TaperRow = {
  code: 'TPR-STEROID-1',
  kind: 'steroid',
  // Weeks 1-2, 3-4 and 5 (the stop).
  schedule: [
    { fromWeek: 1, toWeek: 2, frequency: 'alternate-days' },
    { fromWeek: 3, toWeek: 4, frequency: 'weekly' },
    { fromWeek: 5, toWeek: 5, frequency: 'stop' },
  ],
  whatToExpect: 'Skin may flare for a few days after each step down.',
  seeAProfessionalIf: 'The redness spreads or the skin weeps.',
  status: 'approved',
  approvedBy: 'Dr A. Reviewer',
  approvedOn: at(-30),
  auditedBy: 'Dr B. Auditor',
  auditedOn: at(-20),
}

const input = (over: Partial<RoutineViewInput> = {}): RoutineViewInput => ({
  status: 'ready',
  version: version(),
  previous: null,
  country: 'NG',
  countries: [NG, GH],
  own: new Map([['entry-a', { brand: 'Orbis', name: 'Calm Cleanser' }]]),
  recommended: new Map([['SERUM-1', recommendedRow('SERUM-1')]]),
  summaries: new Map([['form-SERUM-1', summary('form-SERUM-1')]]),
  tapers: new Map([[STEROID_TEMPLATE.code, STEROID_TEMPLATE]]),
  ...over,
})

const stepsOf = (over: Partial<RoutineViewInput>) => wire(toRoutineResponse(input(over))).steps as any[]
const recommendedOf = (row: RecommendedByCode, over: Partial<RoutineViewInput> = {}) => {
  const [, treat] = stepsOf({
    recommended: new Map([[row.code, row]]),
    summaries: new Map([[`form-${row.code}`, summary(`form-${row.code}`)]]),
    version: version({ steps: [ownStep('cleanse', 'entry-a'), candidateStep('treat', row.code)] }),
    ...over,
  })
  return treat.product
}

describe('toRoutineResponse: the routine as a whole', () => {
  it('answers a ready routine as its start day, what to expect, its steps in routine order and its step-downs', () => {
    const body = wire(toRoutineResponse(input()))

    expect(Object.keys(body).sort()).toEqual(['expectation', 'startedOn', 'status', 'steps', 'summary', 'tapers'])
    expect(body).toMatchObject({ status: 'ready', startedOn: null, expectation: 'Give it 8 to 12 weeks before judging.', tapers: [] })
    expect(body.steps.map((s: any) => s.step)).toEqual(['cleanse', 'treat', 'protect'])
  })

  it('answers an updating routine with the same body as a ready one, the status the only difference', () => {
    const ready = wire(toRoutineResponse(input({ status: 'ready' })))
    const updating = wire(toRoutineResponse(input({ status: 'updating' })))

    expect(updating.status).toBe('updating')
    expect({ ...updating, status: 'ready' }).toEqual(ready)
  })

  it('says the day it was started as a UTC calendar day', () => {
    expect(wire(toRoutineResponse(input({ version: version({ startedOn: at(0) }) }))).startedOn).toBe(dayOf(0))
    expect(wire(toRoutineResponse(input({ version: version({ startedOn: new Date(at(9).getTime() + 23 * 60 * 60 * 1000 + 59 * 60 * 1000) }) }))).startedOn).toBe(dayOf(9))
  })
})

describe('toRoutineResponse: the product of a step', () => {
  it('shows a product on the shelf as the shelf entry with its brand and name', () => {
    const [cleanse] = stepsOf({})

    expect(cleanse).toEqual({ step: 'cleanse', frequency: 'am', reason: 'Keep entry-a.', changed: false, product: { kind: 'own', entryId: 'entry-a', brand: 'Orbis', name: 'Calm Cleanser' } })
  })

  it('shows a shelf product with no brand as brand null', () => {
    const [cleanse] = stepsOf({ own: new Map([['entry-a', { brand: null, name: 'A product with no label' }]]) })

    expect(cleanse.product).toEqual({ kind: 'own', entryId: 'entry-a', brand: null, name: 'A product with no label' })
  })

  it('shows "use what you have" as kind none and nothing else', () => {
    const [, , protect] = stepsOf({})

    expect(protect.product).toEqual({ kind: 'none' })
  })

  it('shows a recommended product sold here with its brand, name, image, price in the shopping country\'s currency, where it is sold, key ingredient and strength', () => {
    const product = recommendedOf(recommendedRow('SERUM-1', { keyIngredient: 'Azelaic acid', strength: '10%' }))

    expect(product).toEqual({
      kind: 'recommended',
      code: 'SERUM-1',
      brand: 'Brand of form-SERUM-1',
      name: 'Name of form-SERUM-1',
      imageUrl: 'https://images.example/form-SERUM-1.jpg',
      price: { min: 3000, max: 4500, currency: 'NGN' },
      whereSold: 'Pharmacies and online',
      soldInCurrentCountry: true,
      soldElsewhere: [],
      keyIngredient: 'Azelaic acid',
      strength: '10%',
      notYetGot: true,
    })
  })

  it('shows a null image, key ingredient and strength as null, not as absent', () => {
    const product = recommendedOf(recommendedRow('SERUM-1'), { summaries: new Map([['form-SERUM-1', summary('form-SERUM-1', { imageUrl: null })]]) })

    expect(product).toMatchObject({ imageUrl: null, keyIngredient: null, strength: null })
  })

  it('prices a product in the currency of the country the profile shops in, and from that country\'s availability', () => {
    const row = recommendedRow('SERUM-1', {
      availability: [
        { country: 'NG', priceMin: 3000, priceMax: 4500, whereSold: 'Lagos pharmacies' },
        { country: 'GH', priceMin: 40, priceMax: 55, whereSold: 'Accra markets' },
      ],
    })

    expect(recommendedOf(row, { country: 'GH' })).toMatchObject({ price: { min: 40, max: 55, currency: 'GHS' }, whereSold: 'Accra markets', soldInCurrentCountry: true, soldElsewhere: ['NG'] })
    expect(recommendedOf(row, { country: 'NG' })).toMatchObject({ price: { min: 3000, max: 4500, currency: 'NGN' }, whereSold: 'Lagos pharmacies', soldInCurrentCountry: true, soldElsewhere: ['GH'] })
  })

  it('shows a whereSold of null when the availability row says none', () => {
    const product = recommendedOf(recommendedRow('SERUM-1', { availability: [{ country: 'NG', priceMin: 3000, priceMax: 4500, whereSold: null }] }))

    expect(product).toMatchObject({ whereSold: null, soldInCurrentCountry: true })
  })

  it('shows a product sold only in another country as not sold here, with no price or place, and the countries that do sell it', () => {
    const product = recommendedOf(recommendedRow('SERUM-1', { availability: [{ country: 'GH', priceMin: 40, priceMax: 55, whereSold: 'Accra markets' }] }))

    expect(product).toMatchObject({ kind: 'recommended', soldInCurrentCountry: false, price: null, whereSold: null, soldElsewhere: ['GH'] })
  })

  it('keeps a retired product on the screen, as not sold here and sold nowhere, rather than hiding it', () => {
    const [cleanse, treat] = stepsOf({
      recommended: new Map([['SERUM-1', recommendedRow('SERUM-1', { status: 'retired', availability: [] })]]),
    })

    expect(cleanse.product.kind).toBe('own')
    expect(treat.product).toMatchObject({ kind: 'recommended', code: 'SERUM-1', name: 'Name of form-SERUM-1', soldInCurrentCountry: false, price: null, whereSold: null, soldElsewhere: [] })
  })

  it.each(['draft', 'retired'] as const)('does not count a %s product as sold here even when the workbook still lists the country for it', (status) => {
    const product = recommendedOf(recommendedRow('SERUM-1', { status }))

    expect(product).toMatchObject({ kind: 'recommended', code: 'SERUM-1', soldInCurrentCountry: false })
  })

  it('shows origin brand-submitted for a product a brand submitted and no origin at all for a sourced one', () => {
    expect(recommendedOf(recommendedRow('SERUM-1', { origin: 'brand-submitted' }))).toHaveProperty('origin', 'brand-submitted')
    expect(recommendedOf(recommendedRow('SERUM-1', { origin: 'sourced' }))).not.toHaveProperty('origin')
  })

  it('says a product is not yet got until the user taps "I got it", and got after', () => {
    expect(recommendedOf(recommendedRow('SERUM-1'))).toHaveProperty('notYetGot', true)

    const got = stepsOf({ version: version({ steps: [candidateStep('treat', 'SERUM-1', 'pm', { gotIt: true })] }) })[0]
    expect(got.product).toHaveProperty('notYetGot', false)
  })
})

describe('toRoutineResponse: the step-downs and their dates', () => {
  const stopped = (startedOn: Date | null, shelfProductId = 'entry-b', templateId = STEROID_TEMPLATE.code) => ({ shelfProductId, templateId, startedOn })
  const own = new Map([
    ['entry-a', { brand: 'Orbis', name: 'Calm Cleanser' }],
    ['entry-b', { brand: 'Karo', name: 'Karo Glow Cream' }],
    ['entry-c', { brand: null, name: 'A product with no label' }],
  ])

  it('names the stopped product and its template, with the template\'s words and its weeks, and no dates before the routine is started', () => {
    const [taper] = wire(toRoutineResponse(input({ own, version: version({ startedOn: null, tapers: [stopped(null)] }) }))).tapers

    expect(taper).toEqual({
      entryId: 'entry-b',
      brand: 'Karo',
      name: 'Karo Glow Cream',
      code: 'TPR-STEROID-1',
      kind: 'steroid',
      whatToExpect: 'Skin may flare for a few days after each step down.',
      seeAProfessionalIf: 'The redness spreads or the skin weeps.',
      steps: [
        { fromWeek: 1, toWeek: 2, frequency: 'alternate-days' },
        { fromWeek: 3, toWeek: 4, frequency: 'weekly' },
        { fromWeek: 5, toWeek: 5, frequency: 'stop' },
      ],
    })
    for (const step of taper.steps) {
      expect(step).not.toHaveProperty('fromDate')
      expect(step).not.toHaveProperty('toDate')
    }
  })

  it('dates each step from the day the step-down began once started: a step runs from the first day of its first week to the last day of its last week, both inclusive', () => {
    const [taper] = wire(toRoutineResponse(input({ own, version: version({ startedOn: at(0), tapers: [stopped(at(0))] }) }))).tapers

    // Weeks 1-2 are days 0 to 13, weeks 3-4 days 14 to 27, week 5 days 28 to 34 (a week is 7 days; toDate is the day before the next step starts).
    expect(taper.steps).toEqual([
      { fromWeek: 1, toWeek: 2, frequency: 'alternate-days', fromDate: dayOf(0), toDate: dayOf(13) },
      { fromWeek: 3, toWeek: 4, frequency: 'weekly', fromDate: dayOf(14), toDate: dayOf(27) },
      { fromWeek: 5, toWeek: 5, frequency: 'stop', fromDate: dayOf(28), toDate: dayOf(34) },
    ])
  })

  it('starts a step-down that began after Start on its own day, not on the day of Start', () => {
    const body = wire(
      toRoutineResponse(
        input({
          own,
          version: version({ startedOn: at(0), tapers: [stopped(at(0)), stopped(at(10), 'entry-c')] }),
        }),
      ),
    )

    const [first, later] = body.tapers
    expect(first.steps[0]).toMatchObject({ fromDate: dayOf(0), toDate: dayOf(13) })
    expect(later.entryId).toBe('entry-c')
    expect(later.steps[0]).toMatchObject({ fromDate: dayOf(10), toDate: dayOf(23) })
    expect(later.steps[2]).toMatchObject({ fromDate: dayOf(38), toDate: dayOf(44) })
  })

  it('counts days in UTC, so a start time late in the evening is still that day', () => {
    const lateEvening = new Date(at(0).getTime() + 23 * 60 * 60 * 1000 + 30 * 60 * 1000)

    const [taper] = wire(toRoutineResponse(input({ own, version: version({ startedOn: lateEvening, tapers: [stopped(lateEvening)] }) }))).tapers

    expect(taper.steps[0]).toMatchObject({ fromDate: dayOf(0), toDate: dayOf(13) })
  })

  it('keeps the step-downs in the order they are stored, one for each stopped product', () => {
    const body = wire(toRoutineResponse(input({ own, version: version({ tapers: [stopped(null, 'entry-c'), stopped(null, 'entry-b')] }) })))

    expect(body.tapers.map((t: any) => t.entryId)).toEqual(['entry-c', 'entry-b'])
    expect(body.tapers[0]).toMatchObject({ brand: null, name: 'A product with no label' })
  })

  it('still shows a step-down whose product has left the shelf, under its stored entry id and a neutral name, with the template\'s steps and dates', () => {
    const body = wire(toRoutineResponse(input({ own, version: version({ startedOn: at(0), tapers: [stopped(at(0), 'entry-gone')] }) })))

    expect(body.tapers).toHaveLength(1)
    expect(body.tapers[0]).toMatchObject({ entryId: 'entry-gone', brand: null, name: "A product you're stepping down", code: 'TPR-STEROID-1' })
    expect(body.tapers[0].steps[0]).toMatchObject({ fromWeek: 1, toWeek: 2, frequency: 'alternate-days', fromDate: dayOf(0), toDate: dayOf(13) })
  })

  it('drops a step-down whose template cannot be found, and logs the profile and the template id', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const body = wire(toRoutineResponse(input({ own, version: version({ tapers: [stopped(null, 'entry-b', 'TPR-UNKNOWN'), stopped(null, 'entry-c')] }) })))

    expect(body.tapers.map((t: any) => t.entryId)).toEqual(['entry-c'])
    expect(error).toHaveBeenCalledWith({ outcome: 'routine-taper-template-missing', profileId: 'profile-amara', templateId: 'TPR-UNKNOWN' })
    error.mockRestore()
  })
})

describe('toRoutineResponse: what changed since the routine was last shown', () => {
  const served = (steps: Step[]) => version({ steps, servedAt: at(-2), readyAt: at(-2), createdAt: at(-2) })
  const changedFlags = (current: Step[], previous: RoutineVersionRow | null) =>
    wire(toRoutineResponse(input({ version: version({ steps: current }), previous }))).steps.map((s: any) => s.changed)
  const BASE_STEPS = () => [ownStep('cleanse', 'entry-a', 'am'), candidateStep('treat', 'SERUM-1', 'pm'), noneStep('protect', 'am')]

  it('marks no step changed when nothing was shown before', () => {
    expect(changedFlags(BASE_STEPS(), null)).toEqual([false, false, false])
  })

  it('marks no step changed when every product and frequency is as it was', () => {
    expect(changedFlags(BASE_STEPS(), served(BASE_STEPS()))).toEqual([false, false, false])
  })

  it('marks a step changed when its product is different, and only that step', () => {
    const current = [ownStep('cleanse', 'entry-a', 'am'), candidateStep('treat', 'SERUM-2', 'pm'), noneStep('protect', 'am')]

    expect(changedFlags(current, served(BASE_STEPS()))).toEqual([false, true, false])
  })

  it('marks a step changed when it went from a recommended product to one on the shelf, or to none', () => {
    const previous = served(BASE_STEPS())

    expect(changedFlags([ownStep('cleanse', 'entry-a', 'am'), ownStep('treat', 'entry-z', 'pm'), noneStep('protect', 'am')], previous)).toEqual([false, true, false])
    expect(changedFlags([ownStep('cleanse', 'entry-a', 'am'), noneStep('treat', 'pm'), noneStep('protect', 'am')], previous)).toEqual([false, true, false])
  })

  describe('when the user got the recommended product and it became their own shelf entry (story 30)', () => {
    const previous = () => served(BASE_STEPS())
    const swapped = (formulationId: string | undefined) => {
      const own = new Map([
        ['entry-a', { brand: 'Orbis', name: 'Calm Cleanser' }],
        ['entry-s', { brand: 'Lumina', name: 'Bright Serum', ...(formulationId === undefined ? {} : { formulationId }) }],
      ])
      const current = [ownStep('cleanse', 'entry-a', 'am'), ownStep('treat', 'entry-s', 'pm'), noneStep('protect', 'am')]
      return wire(toRoutineResponse(input({ version: version({ steps: current }), previous: previous(), own }))).steps.map((s: any) => s.changed)
    }

    it('does not mark the step changed when the shelf entry is the same formulation as the recommended product it replaces', () => {
      expect(swapped('form-SERUM-1')).toEqual([false, false, false])
    })

    it('marks it changed when the shelf entry is a different formulation, or its formulation is not known', () => {
      expect(swapped('form-SOMETHING-ELSE')).toEqual([false, true, false])
      expect(swapped(undefined)).toEqual([false, true, false])
    })

    it('still marks it changed when the frequency moved with the swap', () => {
      const own = new Map([['entry-s', { brand: 'Lumina', name: 'Bright Serum', formulationId: 'form-SERUM-1' }]])
      const current = [ownStep('cleanse', 'entry-a', 'am'), ownStep('treat', 'entry-s', 'am'), noneStep('protect', 'am')]

      expect(wire(toRoutineResponse(input({ version: version({ steps: current }), previous: previous(), own }))).steps.map((s: any) => s.changed)).toEqual([false, true, false])
    })
  })

  it('marks a step changed when only its frequency is different', () => {
    const current = [ownStep('cleanse', 'entry-a', 'am-pm'), candidateStep('treat', 'SERUM-1', 'pm'), noneStep('protect', 'am')]

    expect(changedFlags(current, served(BASE_STEPS()))).toEqual([true, false, false])
  })

  it('does not mark a step changed because its words were rewritten, or because the user has since got the product', () => {
    const current = [
      { ...ownStep('cleanse', 'entry-a', 'am'), reason: 'A different way of saying it.' },
      candidateStep('treat', 'SERUM-1', 'pm', { gotIt: true, reason: 'Also reworded.' }),
      noneStep('protect', 'am'),
    ]

    expect(changedFlags(current, served(BASE_STEPS()))).toEqual([false, false, false])
  })

  it('marks a step changed when the version shown before had no entry for that step', () => {
    const previous = served([ownStep('cleanse', 'entry-a', 'am'), candidateStep('treat', 'SERUM-1', 'pm')])

    expect(changedFlags(BASE_STEPS(), previous)).toEqual([false, false, true])
  })
})

describe('toRoutineResponse: nothing internal is shown', () => {
  // How the writer and the rules reached the routine, where it came from, and the workbook's audit columns are for the team, never for the screen.
  const INTERNAL = [
    'grounding',
    'fixedFrom',
    'sourceUrls',
    'evidenceUrls',
    'ingredientsSourceUrl',
    'model',
    'promptHash',
    'rulesVersion',
    'catalogVersion',
    'verdictFingerprint',
    'routineFingerprint',
    'writerCalls',
    'writerRetryDueAt',
    'hintsShown',
    'source',
    'cautions',
    'goal',
    'gotIt',
    'approvedBy',
    'approvedOn',
    'auditedBy',
    'auditedOn',
    'productId',
    'formulationId',
    'profileId',
    'servedAt',
    'createdAt',
    'readyAt',
    'schedule',
    'id',
  ]

  const keysDeep = (value: unknown, keys = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) value.forEach((item) => keysDeep(item, keys))
    else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        keys.add(key)
        keysDeep(inner, keys)
      }
    }
    return keys
  }

  const full = () =>
    input({
      version: version({
        startedOn: at(0),
        steps: [ownStep('cleanse', 'entry-a'), candidateStep('treat', 'SERUM-1', 'pm', { gotIt: true }), noneStep('protect')],
        tapers: [{ shelfProductId: 'entry-b', templateId: STEROID_TEMPLATE.code, startedOn: at(0) }],
        shelfCounts: { keep: 3, reduce: 2, drop: 4, stop: 1 },
      }),
      previous: version({ steps: [ownStep('cleanse', 'entry-a', 'pm')], servedAt: at(-2) }),
      own: new Map([
        ['entry-a', { brand: 'Orbis', name: 'Calm Cleanser' }],
        ['entry-b', { brand: 'Karo', name: 'Karo Glow Cream' }],
      ]),
      recommended: new Map([['SERUM-1', recommendedRow('SERUM-1', { origin: 'brand-submitted', keyIngredient: 'Azelaic acid', strength: '10%' })]]),
    })

  it.each(['ready', 'updating'] as const)('has none of the internal fields anywhere in a %s body, at any depth', (status) => {
    // The summary names the goal (`goal.id`, `goal.label`) on purpose: its own keys are pinned in the summary's describe below.
    const { summary: _summary, ...routine } = wire(toRoutineResponse({ ...full(), status }))
    const keys = keysDeep(routine)

    for (const internal of INTERNAL) expect(keys, internal).not.toContain(internal)
  })

  it('has exactly the documented keys on the routine, a step, each kind of product and a step-down', () => {
    const body = wire(toRoutineResponse(full()))

    expect(Object.keys(body).sort()).toEqual(['expectation', 'startedOn', 'status', 'steps', 'summary', 'tapers'])
    for (const step of body.steps) expect(Object.keys(step).sort()).toEqual(['changed', 'frequency', 'product', 'reason', 'step'])
    expect(Object.keys(body.steps[0].product).sort()).toEqual(['brand', 'entryId', 'kind', 'name'])
    expect(Object.keys(body.steps[1].product).sort()).toEqual(
      ['brand', 'code', 'imageUrl', 'keyIngredient', 'kind', 'name', 'notYetGot', 'origin', 'price', 'soldElsewhere', 'soldInCurrentCountry', 'strength', 'whereSold'].sort(),
    )
    expect(Object.keys(body.steps[2].product)).toEqual(['kind'])
    expect(Object.keys(body.tapers[0]).sort()).toEqual(['brand', 'code', 'entryId', 'kind', 'name', 'seeAProfessionalIf', 'steps', 'whatToExpect'])
    expect(Object.keys(body.tapers[0].steps[0]).sort()).toEqual(['frequency', 'fromDate', 'fromWeek', 'toDate', 'toWeek'])
  })
})

describe('toRoutineResponse: the summary of the plan (the "Your plan is ready" screen)', () => {
  // The counts are the ones the build stored on the version (`shelfCounts`), so the summary always agrees with the routine shown beside it. The names of the
  // products being stopped come from the version's step-downs, in the order stored.
  const COUNTS = { keep: 3, reduce: 2, drop: 4, stop: 0 }
  const stopped = (shelfProductId: string, templateId = STEROID_TEMPLATE.code) => ({ shelfProductId, templateId, startedOn: null })
  // Names that no word of the wording gate can catch, so what is under test is the sentence and not the products.
  const NAMES = new Map([
    ['stop-1', { brand: 'Karo', name: 'Glow Cream' }],
    ['stop-2', { brand: 'Orbis', name: 'Clear Gel' }],
    ['stop-3', { brand: 'Lumina', name: 'Day Lotion' }],
    ['stop-4', { brand: 'Accra', name: 'Shea Balm' }],
    ['stop-5', { brand: 'Zuri', name: 'Body Oil' }],
    ['stop-plain', { brand: null, name: 'Jar From The Market' }],
  ])
  const summaryOf = (version: RoutineVersionRow, over: Partial<RoutineViewInput> = {}) => wire(toRoutineResponse(input({ own: NAMES, version, ...over }))).summary
  const stoppingVersion = (ids: string[]) => version({ shelfCounts: { ...COUNTS, stop: ids.length }, tapers: ids.map((id) => stopped(id)) })
  const SENTENCE_END = "suddenly can make your skin flare. We'll take it step by step, so the rough days are expected, not a surprise."

  it('is there on a ready routine and on an updating one, the same in both', () => {
    const ready = wire(toRoutineResponse(input({ status: 'ready' }))).summary
    const updating = wire(toRoutineResponse(input({ status: 'updating' }))).summary

    expect(ready).toEqual({ goal: { id: 'fade-dark-marks', label: 'Fade dark marks' }, keepUsing: 3, useLessOrChange: 6, stepDown: null })
    expect(updating).toEqual(ready)
  })

  it.each([
    ['products kept as they are', { keep: 5, reduce: 0, drop: 0, stop: 0 }, 5, 0],
    ['products to use less often (reduce)', { keep: 0, reduce: 5, drop: 0, stop: 0 }, 0, 5],
    ['products to leave out at once (drop)', { keep: 0, reduce: 0, drop: 5, stop: 0 }, 0, 5],
    ['reduce and drop together', { keep: 1, reduce: 2, drop: 4, stop: 0 }, 1, 6],
    ['nothing on the shelf', { keep: 0, reduce: 0, drop: 0, stop: 0 }, 0, 0],
  ])('counts %s: keep is "keep using", reduce plus drop is "use less or change"', (_what, shelfCounts, keepUsing, useLessOrChange) => {
    const summary = summaryOf(version({ shelfCounts }))

    expect(summary.keepUsing).toBe(keepUsing)
    expect(summary.useLessOrChange).toBe(useLessOrChange)
  })

  it('leaves a stopped product out of both of the other counts: it is counted once, as a step-down', () => {
    const summary = summaryOf(version({ shelfCounts: { keep: 1, reduce: 1, drop: 1, stop: 2 }, tapers: [stopped('stop-1'), stopped('stop-2')] }))

    expect(summary.keepUsing).toBe(1)
    expect(summary.useLessOrChange).toBe(2)
    expect(summary.stepDown.products).toHaveLength(2)
  })

  describe('the goal', () => {
    // The labels the goal chips show, word for word (test/integration/onboarding.content.test.ts pins the same six).
    it.each([
      ['clear-skin', 'Clear skin'],
      ['even-tone', 'Even tone'],
      ['fade-dark-marks', 'Fade dark marks'],
      ['brighter', 'Brighter, more even'],
      ['glow', 'A glow'],
      ['calm-repair', 'Calm, healthy skin'],
    ] as const)('names the goal %s with its chip label "%s"', (goal, label) => {
      expect(summaryOf(version({ goal })).goal).toEqual({ id: goal, label })
    })

    it('has a label for every goal there is, the very label the goal chips show', async () => {
      const chips = (await contentFor('en')).goalScreen.chips

      expect(chips.map((chip) => chip.id)).toEqual([...GOALS])
      for (const chip of chips) expect(summaryOf(version({ goal: chip.id })).goal, chip.id).toEqual({ id: chip.id, label: chip.label })
    })
  })

  describe('the step-down', () => {
    it('is null when nothing is stopped', () => {
      expect(summaryOf(version({ shelfCounts: { ...COUNTS, stop: 0 }, tapers: [] })).stepDown).toBeNull()
    })

    it('names one stopped product by its brand and name, and says the step-down sentence about it', () => {
      const { stepDown } = summaryOf(stoppingVersion(['stop-1']))

      expect(stepDown).toEqual({
        products: [{ brand: 'Karo', name: 'Glow Cream' }],
        message: `Stopping Karo Glow Cream ${SENTENCE_END}`,
      })
    })

    it('joins two as "X and Y"', () => {
      const { stepDown } = summaryOf(stoppingVersion(['stop-1', 'stop-2']))

      expect(stepDown.message).toBe(`Stopping Karo Glow Cream and Orbis Clear Gel ${SENTENCE_END}`)
      expect(stepDown.products).toEqual([
        { brand: 'Karo', name: 'Glow Cream' },
        { brand: 'Orbis', name: 'Clear Gel' },
      ])
    })

    it('joins three as "X, Y and 1 more", the first two by name', () => {
      const { stepDown } = summaryOf(stoppingVersion(['stop-1', 'stop-2', 'stop-3']))

      expect(stepDown.message).toBe(`Stopping Karo Glow Cream, Orbis Clear Gel and 1 more ${SENTENCE_END}`)
      expect(stepDown.products).toHaveLength(3)
    })

    it('joins five as "X, Y and 3 more", and still lists all five products', () => {
      const { stepDown } = summaryOf(stoppingVersion(['stop-1', 'stop-2', 'stop-3', 'stop-4', 'stop-5']))

      expect(stepDown.message).toBe(`Stopping Karo Glow Cream, Orbis Clear Gel and 3 more ${SENTENCE_END}`)
      expect(stepDown.products.map((p: any) => p.name)).toEqual(['Glow Cream', 'Clear Gel', 'Day Lotion', 'Shea Balm', 'Body Oil'])
    })

    it('names a product with no brand by its name alone, and gives its brand as null', () => {
      const { stepDown } = summaryOf(stoppingVersion(['stop-plain']))

      expect(stepDown.products).toEqual([{ brand: null, name: 'Jar From The Market' }])
      expect(stepDown.message).toBe(`Stopping Jar From The Market ${SENTENCE_END}`)
    })

    it('names a product with no brand by its name alone among others', () => {
      const { stepDown } = summaryOf(stoppingVersion(['stop-1', 'stop-plain']))

      expect(stepDown.message).toBe(`Stopping Karo Glow Cream and Jar From The Market ${SENTENCE_END}`)
    })

    it('keeps the order the step-downs are stored in', () => {
      const { stepDown } = summaryOf(stoppingVersion(['stop-3', 'stop-1']))

      expect(stepDown.products.map((p: any) => p.name)).toEqual(['Day Lotion', 'Glow Cream'])
      expect(stepDown.message).toBe(`Stopping Lumina Day Lotion and Karo Glow Cream ${SENTENCE_END}`)
    })

    it('still counts a stopped product that has left the shelf since, under the neutral name its step-down has', () => {
      const { stepDown } = summaryOf(stoppingVersion(['stop-gone']))

      expect(stepDown.products).toEqual([{ brand: null, name: "A product you're stepping down" }])
      expect(stepDown.message).toBe(`Stopping A product you're stepping down ${SENTENCE_END}`)
    })

    it('is told the same before the routine is started and after: the sentence does not depend on dates', () => {
      const before = summaryOf(stoppingVersion(['stop-1']))
      const after = summaryOf({ ...stoppingVersion(['stop-1']), startedOn: at(0), tapers: [{ ...stopped('stop-1'), startedOn: at(0) }] })

      expect(after.stepDown).toEqual(before.stepDown)
    })
  })

  describe('the wording gate', () => {
    // The sentence is fixed reviewed copy, so it must pass the gate whatever the number of products it names.
    it.each([1, 2, 3, 4, 5])('lets the step-down sentence for %i stopped products through every forbidden-wording pattern', (count) => {
      const ids = ['stop-1', 'stop-2', 'stop-3', 'stop-4', 'stop-5'].slice(0, count)
      const { stepDown } = summaryOf(stoppingVersion(ids))

      for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(stepDown.message), `${count} products: ${code}`).toBe(false)
    })

    it('names no product the gate would catch: "Skin Whitening Cream" is "this product", and the sentence still passes the gate', () => {
      const own = new Map([['stop-bad', { brand: 'Karo', name: 'Skin Whitening Cream' }]])
      const { stepDown } = summaryOf(stoppingVersion(['stop-bad']), { own })

      expect(stepDown.message).toBe(`Stopping this product ${SENTENCE_END}`)
      for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(stepDown.message), code).toBe(false)
      // The products list is data for the schedule, not the sentence: it still names the product.
      expect(stepDown.products).toEqual([{ brand: 'Karo', name: 'Skin Whitening Cream' }])
    })

    it('says "these products" when several are stopped and any one of them would be caught, and names none of them', () => {
      const own = new Map([...NAMES, ['stop-bad', { brand: null, name: 'Fairer Skin Cream' }]])
      const { stepDown } = summaryOf(stoppingVersion(['stop-1', 'stop-bad', 'stop-2']), { own })

      expect(stepDown.message).toBe(`Stopping these products ${SENTENCE_END}`)
      for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(stepDown.message), code).toBe(false)
    })

    it('leaves a benign name as it is', () => {
      expect(summaryOf(stoppingVersion(['stop-1'])).stepDown.message).toBe(`Stopping Karo Glow Cream ${SENTENCE_END}`)
    })

    it('lets the sentence through for a product with no brand, and for a product that has left the shelf', () => {
      for (const id of ['stop-plain', 'stop-gone']) {
        const { stepDown } = summaryOf(stoppingVersion([id]))

        for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(stepDown.message), `${id}: ${code}`).toBe(false)
      }
    })
  })

  describe('a version with no stored counts', () => {
    it.each(['ready', 'updating'] as const)('has summary null on a %s routine: the counts are not worked out from the steps and step-downs it holds', (status) => {
      // It holds a step-down and four steps, so counting from what it holds would give an answer; the summary must not.
      const body = wire(toRoutineResponse(input({ status, own: NAMES, version: version({ shelfCounts: null, tapers: [stopped('stop-1')] }) })))

      expect(body).toHaveProperty('summary', null)
      expect(body.steps).toHaveLength(3)
    })
  })

  describe('what it shows', () => {
    it('has exactly the documented keys, and nothing of how the counts are stored or which shelf entry a name came from', () => {
      const summary = summaryOf(stoppingVersion(['stop-1', 'stop-2']))

      expect(Object.keys(summary).sort()).toEqual(['goal', 'keepUsing', 'stepDown', 'useLessOrChange'])
      expect(Object.keys(summary.goal).sort()).toEqual(['id', 'label'])
      expect(Object.keys(summary.stepDown).sort()).toEqual(['message', 'products'])
      for (const product of summary.stepDown.products) expect(Object.keys(product).sort()).toEqual(['brand', 'name'])
    })

    it('does not carry the stored counts, under any of their names, anywhere in the body', () => {
      const text = JSON.stringify(wire(toRoutineResponse(input({ own: NAMES, version: stoppingVersion(['stop-1']) }))))

      for (const stored of ['shelfCounts', 'shelf_counts', '"keep"', '"reduce"', '"drop"', '"stop":']) expect(text, stored).not.toContain(stored)
    })
  })
})
