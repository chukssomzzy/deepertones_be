import { describe, expect, it } from 'vitest'
import { SHOWN_CONCERNS, SKIN_TYPE_LABELS } from '../face-scans/face-scans.tables'
import { CATEGORIES, CONCERN_KINDS, ESCALATION_REASONS, PRODUCT_FORMS, BUDGET_BANDS, FREQUENCIES, ORIGINS, RESPONSE_OUTCOMES, ROUTINE_STEPS, WEEK_BANDS } from './catalog.vocabulary'
import { CONTRACT, CONTRACT_VERSION, REINTRO_NEVER_BACK, contractFingerprint, validateWorkbook, type RawWorkbook } from './catalog.workbook.schema'

// The workbook schema (the contract) is pure: raw tabs in (each tab's header row, and its rows as a spreadsheet library gives them, keyed by header), either a parsed Workbook or EVERY problem out.
// A problem is { tab, row, column, rule }: `tab` is the RawWorkbook key, `row` the spreadsheet row (the header is row 1, so the first data row is 2),
// `column` the header, and `rule` a fixed code that never holds a cell value. The rule codes below are the contract; the tests pin them.
//
// What is pinned about WHERE a problem is reported, where the spec leaves it open:
//   - a missing or unknown column: row 1 (the header row), `column` the header; the HEADERS decide, never which keys the rows happen to have, and
//     an unknown column is named by its header text cut to 80 characters;
//   - a clash between rows (a code, an identity, an availability pair, a rule): EVERY row in the clash, so the author sees both sides;
//   - a rule between two cells (price range, low/mid, approved without an approver, half an audit): the cell that has to change.

/** The one day every date in this file hangs from; fixtures are offsets from it. */
const BASE = new Date('2030-06-15T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const day = (offset: number) => new Date(BASE.getTime() + offset * DAY).toISOString().slice(0, 10)
const APPROVED_ON = day(-3)
const AUDITED_ON = day(-1)
const utcMidnight = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`)

type RawTab = RawWorkbook['products']
type Raw = RawTab['rows'][number]
type Tab = keyof RawWorkbook

// The header row of each tab, as a literal written from the spec's tables (not read back from CONTRACT), in the order the workbook has them.
const HEADERS = {
  products: ['code', 'brand', 'name', 'variant', 'form', 'category', 'ingredients', 'ingredients_source_url', 'key_ingredient', 'strength', 'skin_concerns', 'skin_types', 'steps', 'frequency', 'own_cautions', 'evidence_urls', 'origin', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on', 'draft_cells'],
  availability: ['product_code', 'country', 'price_min', 'price_max', 'where_sold', 'source_url'],
  ingredients: ['code', 'name', 'aliases', 'kind', 'strength_limit', 'statement', 'source_url', 'helps', 'group', 'clashes_with', 'status', 'approved_by', 'reviewer_role', 'approved_on', 'audited_by', 'audited_on'],
  countries: ['code', 'currency', 'low_max', 'mid_max', 'status'],
  claimWords: ['code', 'phrase', 'claim', 'source_url', 'status', 'approved_by', 'reviewer_role', 'approved_on', 'audited_by', 'audited_on'],
  tapers: ['code', 'kind', 'schedule', 'what_to_expect', 'see_a_professional_if', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  guides: ['step', 'goal', 'what_it_does', 'look_for', 'for_deeper_skin', 'look_for_when_pregnant', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  reintroductions: ['group', 'schedule', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  escalations: ['reason', 'who_to_see', 'how_soon', 'what_to_tell_them', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  responses: ['outcome', 'title', 'body', 'what_to_do_now', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
  weeks: ['band', 'goal', 'step_down', 'title', 'text', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
} as const satisfies Record<Tab, readonly string[]>

// The vocabularies of the new tabs, written out and not read from the code: the reasons an escalation is written for, the outcomes a response answers, the week bands.
const REASONS = ['pus-or-hot-patch', 'swelling', 'near-eyes', 'worse-after-pause', 'unchanged-after-checks', 'harm-while-two-paused', 'hard-to-ignore-during-step-down', 'about-a-product'] as const
const OUTCOMES = ['paused', 'advice-tightness', 'advice-itching', 'advice-breakouts', 'expected-flare', 'check-calmer', 'check-same', 'check-worse', 'nothing-to-pause'] as const
const BANDS = ['1', '2', '3-4', '5-8', '9-12'] as const
const GOALS = ['clear-skin', 'even-tone', 'fade-dark-marks', 'brighter', 'glow', 'calm-repair'] as const

/** A tab with its full header row unless other headers are given. A row need not hold every header: a key left out is an empty cell. */
const tab = (name: Tab, rows: Raw[], headers: readonly string[] = HEADERS[name]): RawTab => ({ headers: [...headers], rows })

// --- fixtures: one valid row of each tab, with every column present ---------------------------------------------------------------------------

const product = (over: Raw = {}): Raw => ({
  code: 'PRD-CERAVE-CLEANSER',
  brand: 'CeraVe',
  name: 'Hydrating Facial Cleanser',
  variant: null,
  form: null,
  category: 'skin',
  ingredients: 'Aqua; Glycerin; Cetearyl Alcohol',
  ingredients_source_url: 'https://www.cerave.com/hydrating-cleanser',
  key_ingredient: null,
  strength: null,
  skin_concerns: 'hd_moisture;hd_redness',
  skin_types: 'dry;combination',
  steps: 'cleanse',
  frequency: 'am-pm',
  own_cautions: null,
  evidence_urls: null,
  origin: 'sourced',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  draft_cells: null,
  ...over,
})

const availability = (over: Raw = {}): Raw => ({ product_code: 'PRD-CERAVE-CLEANSER', country: 'NG', price_min: 4000, price_max: 6500, where_sold: 'Pharmacies and online', ...over })

const ingredient = (over: Raw = {}): Raw => ({
  code: 'ING-RETINOL-SUN-SENSITIVITY',
  name: 'retinol',
  aliases: 'vitamin a alcohol',
  kind: 'sun-sensitivity',
  strength_limit: null,
  statement: 'Can make skin burn more easily in the sun, so sunscreen matters while using it.',
  source_url: null,
  helps: null,
  group: null,
  clashes_with: null,
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  reviewer_role: 'a consultant dermatologist',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  ...over,
})

const claimWord = (over: Raw = {}): Raw => ({
  code: 'CLM-WHITENING',
  phrase: 'whitening',
  claim: 'lightening',
  source_url: null,
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  reviewer_role: 'a consultant dermatologist',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  ...over,
})

const taper = (over: Raw = {}): Raw => ({
  code: 'TPR-STEROID-1',
  kind: 'steroid',
  schedule: '1-2: alternate-days; 3-4: weekly; 5: stop',
  what_to_expect: 'Skin may flare or look redder for a few days after each step down. This is expected and passes.',
  see_a_professional_if: 'The redness spreads, the skin weeps or blisters, or you feel unwell.',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  ...over,
})

/** A Guides row: by default the approved base row (no goal) of the cleanse step. */
const guide = (over: Raw = {}): Raw => ({
  step: 'cleanse',
  goal: null,
  what_it_does: 'Lifts sweat, sunscreen and dirt off your skin so the rest of your routine can work.',
  look_for: 'A gentle, fragrance-free wash that leaves your skin comfortable, not tight.',
  for_deeper_skin: 'Skip harsh scrubs and hot water: rubbing hard can leave dark marks behind on deeper skin.',
  look_for_when_pregnant: null,
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  ...over,
})

/** The four approved base rows (no goal) every workbook needs: one for each routine step, written out here and not read from the vocabulary. */
const baseGuides = (): Raw[] => ['cleanse', 'treat', 'moisturise', 'protect'].map((step) => guide({ step }))

/** A Reintroductions row: by default the approved default ladder (no group). */
const reintroduction = (over: Raw = {}): Raw => ({
  group: null,
  schedule: '1: weekly; 2: alternate-days; 3: back',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  ...over,
})

/** An Escalations row: by default the approved row of the first reason. */
const escalation = (over: Raw = {}): Raw => ({
  reason: 'pus-or-hot-patch',
  who_to_see: 'A doctor or a pharmacist.',
  how_soon: 'Today, or within a day.',
  what_to_tell_them: 'What you noticed, where, and since when. Which products you were using.',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  ...over,
})

/** A Responses row: by default the approved row of the paused outcome, with the one placeholder there is. */
const response = (over: Raw = {}): Raw => ({
  outcome: 'paused',
  title: 'We paused your {step}',
  body: 'Your skin needs a rest from your {step}. We will ask how it feels in three days.',
  what_to_do_now: 'Skip anything that stings. Keep to a gentle cleanser and moisturiser.',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  ...over,
})

/** A Weeks row: by default the approved base row (no goal, no step-down) of band 1. */
const week = (over: Raw = {}): Raw => ({
  band: '1',
  goal: null,
  step_down: 'no',
  title: 'Settling in',
  text: 'The first week is about calming things down. Go gently and keep to the basics.',
  status: 'approved',
  approved_by: 'Dr A. Reviewer',
  approved_on: APPROVED_ON,
  audited_by: null,
  audited_on: null,
  ...over,
})

/** What every workbook needs of the four reviewed tabs: the default ladder, a row for each reason, a row for each outcome, a base row for each band. */
const baseReintroductions = (): Raw[] => [reintroduction()]
const baseEscalations = (): Raw[] => REASONS.map((reason) => escalation({ reason }))
const baseResponses = (): Raw[] => OUTCOMES.map((outcome) => response({ outcome }))
const baseWeeks = (): Raw[] => BANDS.map((band) => week({ band }))

const country = (over: Raw = {}): Raw => ({ code: 'NG', currency: 'NGN', low_max: 5000, mid_max: 15000, status: 'active', ...over })

/** A workbook whose tabs hold one valid row each (the five tabs that need rows hold the rows they need: a base guide for each step, the default ladder, an escalation for each reason, a response for each outcome and a base week card for each band), unless the rows of a tab are given. */
const workbook = (over: Partial<Record<Tab, Raw[]>> = {}): RawWorkbook => ({
  products: tab('products', over.products ?? [product()]),
  availability: tab('availability', over.availability ?? [availability()]),
  ingredients: tab('ingredients', over.ingredients ?? [ingredient()]),
  countries: tab('countries', over.countries ?? [country()]),
  claimWords: tab('claimWords', over.claimWords ?? [claimWord()]),
  tapers: tab('tapers', over.tapers ?? [taper()]),
  guides: tab('guides', over.guides ?? baseGuides()),
  reintroductions: tab('reintroductions', over.reintroductions ?? baseReintroductions()),
  escalations: tab('escalations', over.escalations ?? baseEscalations()),
  responses: tab('responses', over.responses ?? baseResponses()),
  weeks: tab('weeks', over.weeks ?? baseWeeks()),
})

// A tab under test sits in a workbook where nothing else can add a problem: a product row mutated on its own has no availability to point
// at a code that is no longer there, and so on.
const inProducts = (...products: Raw[]): RawWorkbook => workbook({ products, availability: [], ingredients: [], countries: [] })
const inAvailability = (...rows: Raw[]): RawWorkbook => workbook({ availability: rows, ingredients: [], countries: [country(), country({ code: 'GH', currency: 'GHS' })] })
const inIngredients = (...ingredients: Raw[]): RawWorkbook => workbook({ products: [], availability: [], ingredients, countries: [] })
const inCountries = (...countries: Raw[]): RawWorkbook => workbook({ products: [], availability: [], ingredients: [], countries })
const inClaimWords = (...claimWords: Raw[]): RawWorkbook => workbook({ products: [], availability: [], ingredients: [], countries: [], claimWords })
const inTapers = (...tapers: Raw[]): RawWorkbook => workbook({ products: [], availability: [], ingredients: [], countries: [], tapers })
/** The Guides tab holds exactly these rows (so a test of the base rows decides which there are); every other tab holds nothing that could add a problem. */
const inGuides = (...guides: Raw[]): RawWorkbook => workbook({ products: [], availability: [], ingredients: [], countries: [], guides })
/** The four base rows and then these: the row a test is about is spreadsheet row 6, and the base rows cannot add a problem. */
const withBases = (...more: Raw[]): RawWorkbook => inGuides(...baseGuides(), ...more)
/** One of the four new tabs holds exactly these rows; every other tab holds nothing that could add a problem. */
const alone = (name: 'reintroductions' | 'escalations' | 'responses' | 'weeks', rows: Raw[]): RawWorkbook =>
  workbook({ products: [], availability: [], ingredients: [], countries: [], [name]: rows })

type Problem = { tab: Tab; row: number; column: string; rule: string }
const problem = (tab: Tab, row: number, column: string, rule: string): Problem => ({ tab, row, column, rule })
const order = (problems: Problem[]) => [...problems].sort((a, b) => JSON.stringify([a.tab, a.row, a.column, a.rule]).localeCompare(JSON.stringify([b.tab, b.row, b.column, b.rule])))

/** What validateWorkbook found wrong, in a fixed order (the order it lists them in is not part of the contract); [] when it found nothing. */
const problemsOf = (raw: RawWorkbook): Problem[] => {
  const result = validateWorkbook(raw)
  return result.ok ? [] : order(result.problems as Problem[])
}
const expectProblems = (raw: RawWorkbook, expected: Problem[]) => expect(problemsOf(raw)).toEqual(order(expected))
const expectValid = (raw: RawWorkbook) => expect(validateWorkbook(raw)).toMatchObject({ ok: true })

const parsed = (raw: RawWorkbook) => {
  const result = validateWorkbook(raw)
  if (!result.ok) throw new Error(`expected a valid workbook, got ${JSON.stringify(result.problems)}`)
  return result.workbook
}

const text = (length: number, char = 'a') => char.repeat(length)

describe('the contract', () => {
  it('is version 2.4.0: the contract that adds reviewer_role to Ingredients and Claim words, source_url to Claim words and the about-a-product escalation', () => {
    expect(CONTRACT_VERSION).toBe('2.4.1')
  })

  it('is plain data: it survives JSON unchanged, so nothing in it (a pattern, a limit) can be left out of the fingerprint', () => {
    expect(JSON.parse(JSON.stringify(CONTRACT))).toEqual(CONTRACT)
  })

  it.each([
    ['SHOWN_CONCERNS', SHOWN_CONCERNS],
    ['SKIN_TYPE_LABELS', SKIN_TYPE_LABELS],
    ['ROUTINE_STEPS', ROUTINE_STEPS],
    ['FREQUENCIES', FREQUENCIES],
    ['BUDGET_BANDS', BUDGET_BANDS],
    ['ORIGINS', ORIGINS],
    ['CATEGORIES', CATEGORIES],
    ['PRODUCT_FORMS', PRODUCT_FORMS],
    ['CONCERN_KINDS', CONCERN_KINDS],
  ])('lists every value of %s, so the generated document says what is allowed', (_name, values) => {
    const written = JSON.stringify(CONTRACT)

    for (const value of values) expect(written, value).toContain(`"${value}"`)
  })

  it('lists the eleven tabs, by the names a RawWorkbook uses', () => {
    const written = JSON.stringify(CONTRACT)

    for (const tab of ['products', 'availability', 'ingredients', 'countries', 'claimWords', 'tapers', 'guides', 'reintroductions', 'escalations', 'responses', 'weeks']) expect(written, tab).toContain(`"${tab}"`)
  })

  it('titles the tabs "Claim words", "Tapers", "Guides", "Reintroductions", "Escalations", "Responses" and "Weeks", the names they have in the workbook file', () => {
    expect(CONTRACT.tabs.map((tab) => [tab.key, tab.title])).toEqual([
      ['products', 'Products'],
      ['availability', 'Availability'],
      ['ingredients', 'Ingredients'],
      ['countries', 'Countries'],
      ['claimWords', 'Claim words'],
      ['tapers', 'Tapers'],
      ['guides', 'Guides'],
      ['reintroductions', 'Reintroductions'],
      ['escalations', 'Escalations'],
      ['responses', 'Responses'],
      ['weeks', 'Weeks'],
    ])
  })

  it('keeps the new vocabularies in catalog.vocabulary.ts, with the values the spec gives them', () => {
    expect([...ESCALATION_REASONS]).toEqual([...REASONS])
    expect([...RESPONSE_OUTCOMES]).toEqual([...OUTCOMES])
    expect([...WEEK_BANDS]).toEqual([...BANDS])
  })

  it.each([
    ['ESCALATION_REASONS', REASONS],
    ['RESPONSE_OUTCOMES', OUTCOMES],
    ['WEEK_BANDS', BANDS],
    ['the yes and no of step_down', ['yes', 'no']],
    ['back, the last step of a ladder', ['back']],
  ])('lists every value of %s, so the generated document says what is allowed', (_name, values) => {
    const written = JSON.stringify(CONTRACT)

    for (const value of values) expect(written, value).toContain(`"${value}"`)
  })

  it('lists the checks each new tab makes across its rows, by the rule codes the document explains', () => {
    const checks = (key: string) => CONTRACT.tabs.find((tab) => tab.key === key)!.checks.map((check) => check.rule)

    expect(checks('reintroductions')).toEqual(expect.arrayContaining(['AUDIT_INCOMPLETE', 'REINTRO_DEFAULT_MISSING', 'REINTRO_DUPLICATE', 'REINTRO_GROUP_NEVER_BACK']))
    expect(checks('escalations')).toEqual(expect.arrayContaining(['AUDIT_INCOMPLETE', 'ESCALATION_DUPLICATE', 'ESCALATION_MISSING', 'ESCALATION_WORDING']))
    expect(checks('responses')).toEqual(expect.arrayContaining(['AUDIT_INCOMPLETE', 'RESPONSE_DUPLICATE', 'RESPONSE_MISSING', 'RESPONSE_PLACEHOLDER', 'RESPONSE_WORDING']))
    expect(checks('weeks')).toEqual(expect.arrayContaining(['AUDIT_INCOMPLETE', 'WEEK_BASE_MISSING', 'WEEK_DUPLICATE', 'WEEK_WORDING']))
  })

  it('explains each new rule code in words, and the missing-row rules name what has to be there: every reason, every band', () => {
    for (const rule of [
      'REINTRO_DEFAULT_MISSING', 'REINTRO_DUPLICATE', 'REINTRO_GROUP_NEVER_BACK', 'REINTRO_MISSING_BACK', 'REINTRO_BACK_NOT_LAST', 'REINTRO_FREQUENCY_DECREASES',
      'ESCALATION_MISSING', 'ESCALATION_DUPLICATE', 'ESCALATION_WORDING', 'RESPONSE_MISSING', 'RESPONSE_DUPLICATE', 'RESPONSE_PLACEHOLDER', 'RESPONSE_WORDING',
      'WEEK_BASE_MISSING', 'WEEK_DUPLICATE', 'WEEK_WORDING',
    ] as const) {
      expect(CONTRACT.rules[rule as keyof typeof CONTRACT.rules], rule).toMatch(/\S{3}/)
    }
    for (const reason of REASONS) expect(CONTRACT.rules.ESCALATION_MISSING, reason).toContain(reason)
    for (const outcome of OUTCOMES) expect(CONTRACT.rules.RESPONSE_MISSING, outcome).toContain(outcome)
    for (const band of BANDS) expect(CONTRACT.rules.WEEK_BASE_MISSING, band).toContain(band)
  })

  it('says in the Responses tab that {step} is the one placeholder, and in the Reintroductions tab that mercury, steroid and lightening-agent are only ever stopped', () => {
    const about = (key: string) => {
      const found = CONTRACT.tabs.find((tab) => tab.key === key)!
      return JSON.stringify(found)
    }

    expect(about('responses')).toContain('{step}')
    for (const group of ['mercury', 'steroid', 'lightening-agent']) expect(about('reintroductions'), group).toContain(group)
  })

  it('lists the goals a Guides row may be written for, and the routine steps, so the generated document says what is allowed', () => {
    const written = JSON.stringify(CONTRACT)

    for (const goal of ['clear-skin', 'even-tone', 'fade-dark-marks', 'brighter', 'glow', 'calm-repair']) expect(written, goal).toContain(`"${goal}"`)
  })

  it('tells the people who write guides that a row without look_for_when_pregnant must be written safe for pregnancy: a review rule the document carries', () => {
    const guides = CONTRACT.tabs.find((tab) => tab.key === 'guides')!
    const column = guides.columns.find((candidate) => candidate.name === 'look_for_when_pregnant')!

    expect(`${guides.about} ${column.about}`).toMatch(/pregnan/i)
  })

  it('lists the columns of every tab in the order the workbook has them, the new ones included', () => {
    for (const tab of CONTRACT.tabs) expect(tab.columns.map((column) => column.name), tab.key).toEqual([...HEADERS[tab.key]])
  })

  // reviewer_role (2.4.0): the role the app shows under "Reviewed by", on the two tabs whose rows the shelf verdict explains with a reason.
  describe.each(['ingredients', 'claimWords'] as const)('the reviewer_role column of %s', (key) => {
    const column = () => CONTRACT.tabs.find((tab) => tab.key === key)!.columns.find((candidate) => candidate.name === 'reviewer_role')

    it('is plain text of at most 80 characters, needed when the row is approved, like approved_by', () => {
      expect(column()).toMatchObject({ type: 'text', required: 'when-approved', maxLength: 80, plainText: true })
    })

    it('says it is the role of the person who reviewed the rule, as the app shows it under "Reviewed by", and never a name', () => {
      const about = column()!.about

      expect(about).toContain('Reviewed by')
      expect(about).toContain('a consultant dermatologist')
      expect(about).toMatch(/never a name/i)
    })
  })

  it('has an optional source_url on Claim words, a link like the one on Ingredients', () => {
    const claimWords = CONTRACT.tabs.find((tab) => tab.key === 'claimWords')!
    const ingredients = CONTRACT.tabs.find((tab) => tab.key === 'ingredients')!

    expect(claimWords.columns.find((column) => column.name === 'source_url')).toMatchObject({ type: 'url', required: 'optional' })
    expect(ingredients.columns.find((column) => column.name === 'source_url')).toMatchObject({ type: 'url', required: 'optional' })
  })
})

// The fingerprint of the contract as released at CONTRACT_VERSION 2.4.0, written out. A contract change that does not bump the version (and,
// with it, this literal) is a silent change to what a workbook may hold, so it fails here. Bumping means: CONTRACT_VERSION, then the version
// and fingerprint below, then `npm run catalog:contract-doc`.
// The fingerprint of contract 2.4.0 (`await contractFingerprint()`, pinned at release as this file describes).
const RELEASED = { version: '2.4.1', fingerprint: '2d99c296efb349b25d13b010f04a4907d5d3b64e661cd93a9f766da5bd08314c' }

describe('contractFingerprint', () => {
  it('is the one released for this CONTRACT_VERSION: change CONTRACT only together with a bump of CONTRACT_VERSION and of RELEASED in this file', async () => {
    expect(CONTRACT_VERSION, 'CONTRACT_VERSION moved: update RELEASED in this file to the new version and its fingerprint').toBe(RELEASED.version)
    expect(await contractFingerprint(), 'CONTRACT changed without a new CONTRACT_VERSION: bump the version and update RELEASED, or undo the change').toBe(RELEASED.fingerprint)
  })

  it('is the sha256 of the definitions as 64 lower-case hex digits', async () => {
    expect(await contractFingerprint()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is the same every time it is asked', async () => {
    expect(await contractFingerprint()).toBe(await contractFingerprint())
  })

  it('does not depend on the order the definitions are written in', async () => {
    const reordered = JSON.parse(JSON.stringify(CONTRACT, (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value,
    )) as typeof CONTRACT

    expect(await contractFingerprint(reordered)).toBe(await contractFingerprint(CONTRACT))
  })

  it('changes when any definition changes, however small', async () => {
    const original = await contractFingerprint(CONTRACT)
    const changed = structuredClone(CONTRACT)
    // The first string anywhere in the definitions gets one more character: whichever piece that is, the fingerprint has to notice.
    const bump = (node: unknown): boolean => {
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (typeof value === 'string') {
            ;(node as Record<string, unknown>)[key] = `${value}x`
            return true
          }
          if (bump(value)) return true
        }
      }
      return false
    }
    expect(bump(changed)).toBe(true)

    expect(await contractFingerprint(changed)).not.toBe(original)
  })

  it('changes when a vocabulary loses a value', async () => {
    const original = await contractFingerprint(CONTRACT)
    const without = JSON.parse(JSON.stringify(CONTRACT).replace('"alternate-days",', '')) as typeof CONTRACT

    expect(JSON.stringify(without)).not.toBe(JSON.stringify(CONTRACT))
    expect(await contractFingerprint(without)).not.toBe(original)
  })
})

describe('validateWorkbook: a valid workbook', () => {
  it('is ok, with each tab parsed into camelCased fields, lists as arrays and dates as Dates', () => {
    const result = parsed(
      workbook({
        products: [
          product({
            variant: 'Night',
            form: 'cream',
            key_ingredient: 'Azelaic acid',
            strength: '10%',
            own_cautions: 'irritation;allergen',
            evidence_urls: 'https://a.example.com/study;https://b.example.com/review',
            audited_by: 'Nneka Audit',
            audited_on: AUDITED_ON,
            draft_cells: 'steps=https://example.com/a?id=3',
            status: 'draft',
          }),
        ],
        availability: [availability()],
        ingredients: [
          ingredient({ aliases: 'vitamin a alcohol; retinol alcohol', strength_limit: '0.3% in leave-on', source_url: 'https://example.com/retinol', helps: 'hd_texture;hd_age_spot', group: 'retinoid', clashes_with: 'exfoliating-acid; benzoyl-peroxide' }),
          ingredient({ code: 'ING-GLYCOLIC-ACID-IRRITATION', name: 'glycolic acid', aliases: null, kind: 'irritation', group: 'exfoliating-acid', clashes_with: 'retinoid' }),
          ingredient({ code: 'ING-BENZOYL-PEROXIDE-IRRITATION', name: 'benzoyl peroxide', aliases: null, kind: 'irritation', group: 'benzoyl-peroxide', clashes_with: 'retinoid' }),
        ],
        claimWords: [claimWord({ audited_by: 'Nneka Audit', audited_on: AUDITED_ON })],
        tapers: [taper({ audited_by: 'Nneka Audit', audited_on: AUDITED_ON })],
      }),
    )

    expect(result.products).toEqual([
      {
        code: 'PRD-CERAVE-CLEANSER',
        brand: 'CeraVe',
        name: 'Hydrating Facial Cleanser',
        variant: 'Night',
        form: 'cream',
        category: 'skin',
        ingredients: ['Aqua', 'Glycerin', 'Cetearyl Alcohol'],
        ingredientsSourceUrl: 'https://www.cerave.com/hydrating-cleanser',
        keyIngredient: 'Azelaic acid',
        strength: '10%',
        skinConcerns: ['hd_moisture', 'hd_redness'],
        skinTypes: ['dry', 'combination'],
        steps: ['cleanse'],
        frequency: 'am-pm',
        ownCautions: ['irritation', 'allergen'],
        evidenceUrls: ['https://a.example.com/study', 'https://b.example.com/review'],
        origin: 'sourced',
        status: 'draft',
        approvedBy: 'Dr A. Reviewer',
        approvedOn: utcMidnight(APPROVED_ON),
        auditedBy: 'Nneka Audit',
        auditedOn: utcMidnight(AUDITED_ON),
        draftCells: [{ column: 'steps', url: 'https://example.com/a?id=3' }],
      },
    ])
    expect(result.availability).toEqual([{ productCode: 'PRD-CERAVE-CLEANSER', country: 'NG', priceMin: 4000, priceMax: 6500, whereSold: 'Pharmacies and online', sourceUrl: null }])
    expect(result.ingredients).toEqual([
      {
        code: 'ING-RETINOL-SUN-SENSITIVITY',
        name: 'retinol',
        aliases: ['vitamin a alcohol', 'retinol alcohol'],
        kind: 'sun-sensitivity',
        strengthLimit: '0.3% in leave-on',
        statement: 'Can make skin burn more easily in the sun, so sunscreen matters while using it.',
        sourceUrl: 'https://example.com/retinol',
        helps: ['hd_texture', 'hd_age_spot'],
        group: 'retinoid',
        clashesWith: ['exfoliating-acid', 'benzoyl-peroxide'],
        status: 'approved',
        approvedBy: 'Dr A. Reviewer',
        reviewerRole: 'a consultant dermatologist',
        approvedOn: utcMidnight(APPROVED_ON),
        auditedBy: null,
        auditedOn: null,
      },
      expect.objectContaining({ code: 'ING-GLYCOLIC-ACID-IRRITATION', group: 'exfoliating-acid', clashesWith: ['retinoid'] }),
      expect.objectContaining({ code: 'ING-BENZOYL-PEROXIDE-IRRITATION', group: 'benzoyl-peroxide', clashesWith: ['retinoid'] }),
    ])
    expect(result.countries).toEqual([{ code: 'NG', currency: 'NGN', lowMax: 5000, midMax: 15000, status: 'active' }])
    expect(result.claimWords).toEqual([
      {
        code: 'CLM-WHITENING',
        phrase: 'whitening',
        claim: 'lightening',
        sourceUrl: null,
        status: 'approved',
        approvedBy: 'Dr A. Reviewer',
        reviewerRole: 'a consultant dermatologist',
        approvedOn: utcMidnight(APPROVED_ON),
        auditedBy: 'Nneka Audit',
        auditedOn: utcMidnight(AUDITED_ON),
      },
    ])
    // The schedule is read into its steps: `N` is a step of one week (fromWeek = toWeek), `N-M` a step of several.
    expect(result.tapers).toEqual([
      {
        code: 'TPR-STEROID-1',
        kind: 'steroid',
        schedule: [
          { fromWeek: 1, toWeek: 2, frequency: 'alternate-days' },
          { fromWeek: 3, toWeek: 4, frequency: 'weekly' },
          { fromWeek: 5, toWeek: 5, frequency: 'stop' },
        ],
        whatToExpect: 'Skin may flare or look redder for a few days after each step down. This is expected and passes.',
        seeAProfessionalIf: 'The redness spreads, the skin weeps or blisters, or you feel unwell.',
        status: 'approved',
        approvedBy: 'Dr A. Reviewer',
        approvedOn: utcMidnight(APPROVED_ON),
        auditedBy: 'Nneka Audit',
        auditedOn: utcMidnight(AUDITED_ON),
      },
    ])
  })

  it('reads an optional cell left empty as null, or as an empty list for a list', () => {
    const result = parsed(workbook({ availability: [availability({ where_sold: null })] }))

    expect(result.products[0]).toMatchObject({ variant: null, form: null, keyIngredient: null, strength: null, ownCautions: [], evidenceUrls: [], auditedBy: null, auditedOn: null, draftCells: [] })
    expect(result.availability[0]).toMatchObject({ whereSold: null })
    expect(result.ingredients[0]).toMatchObject({ strengthLimit: null, sourceUrl: null, helps: [], group: null, clashesWith: [] })
  })

  it('reads a reviewer_role left empty on a draft or retired row as null, and a claim word source_url left empty as null', () => {
    const result = parsed(
      workbook({
        ingredients: [ingredient({ status: 'draft', approved_by: null, approved_on: null, reviewer_role: null })],
        claimWords: [claimWord({ status: 'retired', approved_by: null, approved_on: null, reviewer_role: null, source_url: null })],
      }),
    )

    expect(result.ingredients[0]).toMatchObject({ reviewerRole: null })
    expect(result.claimWords[0]).toMatchObject({ reviewerRole: null, sourceUrl: null })
  })

  it('is ok with every tab empty but the five that need rows: Guides, Reintroductions, Escalations, Responses and Weeks', () => {
    const result = parsed(workbook({ products: [], availability: [], ingredients: [], countries: [], claimWords: [], tapers: [] }))

    expect({ ...result, guides: [], reintroductions: [], escalations: [], responses: [], weeks: [] }).toEqual({
      products: [], availability: [], ingredients: [], countries: [], claimWords: [], tapers: [], guides: [], reintroductions: [], escalations: [], responses: [], weeks: [],
    })
    expect(result.guides.map((row) => [row.step, row.goal])).toEqual([['cleanse', null], ['treat', null], ['moisturise', null], ['protect', null]])
    expect(result.reintroductions.map((row) => row.group)).toEqual([null])
    expect(result.escalations.map((row) => row.reason)).toEqual([...REASONS])
    expect(result.responses.map((row) => row.outcome)).toEqual([...OUTCOMES])
    expect(result.weeks.map((row) => [row.band, row.goal, row.stepDown])).toEqual(BANDS.map((band) => [band, null, false]))
  })

  it('keeps rows in the order they were given', () => {
    const result = parsed(inProducts(product({ code: 'PRD-B', name: 'Second' }), product({ code: 'PRD-A', name: 'First' })))

    expect(result.products.map((p) => p.code)).toEqual(['PRD-B', 'PRD-A'])
  })
})

describe('validateWorkbook: cells', () => {
  it('trims text, and reads a cell of only spaces as empty', () => {
    const result = parsed(inProducts(product({ brand: '  CeraVe  ', variant: '   ', name: '\tHydrating Facial Cleanser\n' })))

    expect(result.products[0]).toMatchObject({ brand: 'CeraVe', variant: null, name: 'Hydrating Facial Cleanser' })
  })

  it('splits a list on ";", trims each item and drops empty ones, keeping the order', () => {
    const result = parsed(inProducts(product({ ingredients: ' Aqua ;Glycerin;; ; Cetearyl Alcohol ;', steps: 'protect;cleanse' })))

    expect(result.products[0]).toMatchObject({ ingredients: ['Aqua', 'Glycerin', 'Cetearyl Alcohol'], steps: ['protect', 'cleanse'] })
  })

  it('reads a whole number given as a number or as text', () => {
    const result = parsed(inAvailability(availability({ price_min: '4000', price_max: 6500 })))

    expect(result.availability[0]).toMatchObject({ priceMin: 4000, priceMax: 6500 })
  })

  it('reports the spreadsheet row, so the first data row is 2 and the second is 3', () => {
    expectProblems(inProducts(product({ code: 'PRD-A', name: 'A' }), product({ code: 'PRD-B', name: 'B', brand: null })), [problem('products', 3, 'brand', 'REQUIRED')])
  })

  it('lists every problem, across rows, columns and tabs, not only the first', () => {
    expectProblems(
      workbook({
        products: [product({ code: 'prd-a', name: 'A', category: 'face' }), product({ code: 'PRD-B', name: 'B', frequency: 'daily' })],
        availability: [availability({ product_code: 'PRD-NOPE' }), availability({ product_code: 'PRD-B', country: 'GH', price_min: -1 })],
        ingredients: [ingredient({ name: 'Retinol.' })],
        countries: [country({ currency: 'ngn' })],
      }),
      [
        problem('products', 2, 'code', 'BAD_CODE'),
        problem('products', 2, 'category', 'NOT_IN_VOCABULARY'),
        problem('products', 3, 'frequency', 'NOT_IN_VOCABULARY'),
        problem('availability', 2, 'product_code', 'UNKNOWN_PRODUCT'),
        problem('availability', 3, 'country', 'UNKNOWN_COUNTRY'),
        problem('availability', 3, 'price_min', 'NOT_A_WHOLE_NUMBER'),
        problem('ingredients', 2, 'name', 'NOT_NORMALISED'),
        problem('countries', 2, 'currency', 'BAD_CURRENCY'),
      ],
    )
  })

  it('gives a problem only its tab, row, column and rule, never what the cell held', () => {
    const result = validateWorkbook(inProducts(product({ category: 'SECRET-VALUE-XYZ' })))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems).toHaveLength(1)
    expect(Object.keys(result.problems[0]!).sort()).toEqual(['column', 'row', 'rule', 'tab'])
    expect(JSON.stringify(result.problems)).not.toContain('SECRET-VALUE-XYZ')
  })

  it('does not stop at a bad cell: a row with two bad cells has two problems', () => {
    expectProblems(inProducts(product({ origin: 'invented', status: 'live' })), [problem('products', 2, 'origin', 'NOT_IN_VOCABULARY'), problem('products', 2, 'status', 'NOT_IN_VOCABULARY')])
  })
})

describe('validateWorkbook: columns', () => {
  const TABS = ['products', 'availability', 'ingredients', 'countries', 'claimWords', 'tapers', 'guides', 'reintroductions', 'escalations', 'responses', 'weeks'] as const
  /** The tabs that need rows, with the column their missing-row problem sits in, and its rule. */
  const NEEDS_ROWS = [
    ['guides', 'step', 'GUIDE_BASE_MISSING'],
    ['reintroductions', 'group', 'REINTRO_DEFAULT_MISSING'],
    ['escalations', 'reason', 'ESCALATION_MISSING'],
    ['responses', 'outcome', 'RESPONSE_MISSING'],
    ['weeks', 'band', 'WEEK_BASE_MISSING'],
  ] as const
  /** The one-valid-row workbook with `name` given other headers (and, when asked, other rows). */
  const withTab = (name: Tab, headers: readonly string[], rows: Raw[] = workbook()[name].rows): RawWorkbook => ({ ...workbook(), [name]: tab(name, rows, headers) })
  const without = (name: Tab, column: string) => HEADERS[name].filter((header) => header !== column)
  const omitting = (rows: Raw[], column: string): Raw[] => rows.map(({ [column]: _gone, ...rest }) => rest)

  it.each(TABS)('reports a header the contract does not have as UNKNOWN_COLUMN, on the header row of %s', (name) => {
    const rows = workbook()[name].rows.map((row) => ({ ...row, colour: 'red' }))

    expectProblems(withTab(name, [...HEADERS[name], 'colour'], rows), [problem(name, 1, 'colour', 'UNKNOWN_COLUMN')])
  })

  it('judges columns by the headers, so an unknown header is reported even when no row has a value under it', () => {
    expectProblems(withTab('products', [...HEADERS.products, 'colour']), [problem('products', 1, 'colour', 'UNKNOWN_COLUMN')])
  })

  it('ignores a key a row has that the headers do not: the headers decide what the columns are', () => {
    const rows = workbook().availability.rows.map((row) => ({ ...row, colour: 'red' }))

    expectValid(withTab('availability', HEADERS.availability, rows))
  })

  it('names an unknown header by its first 80 characters, so a long one cannot fill a response', () => {
    const header = `${'x'.repeat(80)}${'y'.repeat(120)}`

    expectProblems(withTab('countries', [...HEADERS.countries, header]), [problem('countries', 1, 'x'.repeat(80), 'UNKNOWN_COLUMN')])
  })

  it('keeps an unknown header of 80 characters or fewer whole', () => {
    expectProblems(withTab('countries', [...HEADERS.countries, 'x'.repeat(80)]), [problem('countries', 1, 'x'.repeat(80), 'UNKNOWN_COLUMN')])
    expectProblems(withTab('countries', [...HEADERS.countries, 'colour']), [problem('countries', 1, 'colour', 'UNKNOWN_COLUMN')])
  })

  it.each([
    ['products', 'brand'],
    ['products', 'variant'],
    ['products', 'key_ingredient'],
    ['products', 'strength'],
    ['availability', 'price_min'],
    ['ingredients', 'statement'],
    ['countries', 'currency'],
    ['ingredients', 'group'],
    ['ingredients', 'clashes_with'],
    ['ingredients', 'reviewer_role'],
    ['claimWords', 'phrase'],
    ['claimWords', 'source_url'],
    ['claimWords', 'reviewer_role'],
    ['tapers', 'schedule'],
    ['guides', 'what_it_does'],
    ['guides', 'look_for_when_pregnant'],
    ['guides', 'goal'],
    ['guides', 'step'],
    ['reintroductions', 'group'],
    ['reintroductions', 'schedule'],
    ['escalations', 'reason'],
    ['escalations', 'how_soon'],
    ['responses', 'outcome'],
    ['responses', 'what_to_do_now'],
    ['weeks', 'band'],
    ['weeks', 'goal'],
    ['weeks', 'step_down'],
    ['weeks', 'title'],
  ] as const)('reports %s without a %s header once, as MISSING_COLUMN on the header row, and nothing else about that column', (name, column) => {
    expectProblems(withTab(name, without(name, column), omitting(workbook()[name].rows, column)), [problem(name, 1, column, 'MISSING_COLUMN')])
  })

  it('says only MISSING_COLUMN for a strength whose key_ingredient header is gone: with no column there is no cell to be missing an ingredient', () => {
    const rows = omitting([product({ strength: '10%' })], 'key_ingredient')

    expectProblems(withTab('products', without('products', 'key_ingredient'), rows), [problem('products', 1, 'key_ingredient', 'MISSING_COLUMN')])
  })

  it('reports a missing header even when the rows still carry a value under that name, since the headers decide', () => {
    expect(problemsOf(withTab('products', without('products', 'variant')))).toContainEqual(problem('products', 1, 'variant', 'MISSING_COLUMN'))
  })

  it('reports every missing and unknown header of a tab', () => {
    const headers = [...without('countries', 'currency').filter((header) => header !== 'mid_max'), 'colour']

    expectProblems(withTab('countries', headers, omitting(omitting(workbook().countries.rows, 'currency'), 'mid_max')), [
      problem('countries', 1, 'currency', 'MISSING_COLUMN'),
      problem('countries', 1, 'mid_max', 'MISSING_COLUMN'),
      problem('countries', 1, 'colour', 'UNKNOWN_COLUMN'),
    ])
  })

  it.each(TABS.filter((name) => !NEEDS_ROWS.some(([needy]) => needy === name)))('checks the header row of %s even when the tab has no rows', (name) => {
    const empty = workbook({ products: [], availability: [], ingredients: [], countries: [], claimWords: [], tapers: [] })
    const emptyWith = (headers: readonly string[]): RawWorkbook => ({ ...empty, [name]: tab(name, [], headers) })

    expectValid(emptyWith(HEADERS[name]))
    expectProblems(emptyWith([...without(name, HEADERS[name][0]), 'colour']), [problem(name, 1, HEADERS[name][0], 'MISSING_COLUMN'), problem(name, 1, 'colour', 'UNKNOWN_COLUMN')])
  })

  it.each(NEEDS_ROWS)('checks the header row of %s even when the tab has no rows: a tab with no rows is missing the rows it needs, and a wrong header is told as a wrong header and nothing more', (name, key, missing) => {
    const emptyWith = (headers: readonly string[]): RawWorkbook => ({ ...workbook({ products: [], availability: [], ingredients: [], countries: [] }), [name]: tab(name, [], headers) })

    expectProblems(emptyWith(HEADERS[name]), [problem(name, 1, key, missing)])
    expectProblems(emptyWith([...without(name, key), 'colour']), [problem(name, 1, key, 'MISSING_COLUMN'), problem(name, 1, 'colour', 'UNKNOWN_COLUMN')])
  })

  describe('a row that leaves a key out', () => {
    it('has an empty cell there: an optional column reads as empty', () => {
      const result = parsed(inProducts(omitting([product()], 'variant')[0]!))

      expect(result.products[0]).toMatchObject({ variant: null })
    })

    it('has an empty cell there: a required column is REQUIRED on that row, and only that row', () => {
      expectProblems(inProducts(product({ code: 'PRD-A', name: 'A' }), omitting([product({ code: 'PRD-B', name: 'B' })], 'brand')[0]!), [problem('products', 3, 'brand', 'REQUIRED')])
    })
  })
})

describe('validateWorkbook: Products', () => {
  describe('code', () => {
    it.each(['AB', 'PRD-1', '1A', 'A-B-C', 'A'.repeat(40)])('accepts %s', (code) => {
      expectValid(inProducts(product({ code })))
    })

    it.each(['A', 'a1', 'prd-1', '-AB', 'A B', 'AB_C', 'A'.repeat(41), 'ÀB'])('refuses %s as BAD_CODE', (code) => {
      expectProblems(inProducts(product({ code })), [problem('products', 2, 'code', 'BAD_CODE')])
    })

    it('is required', () => {
      expectProblems(inProducts(product({ code: null })), [problem('products', 2, 'code', 'REQUIRED')])
    })

    it('is unique: both rows that share one are reported', () => {
      expectProblems(inProducts(product({ code: 'PRD-A', name: 'One' }), product({ code: 'PRD-B', name: 'Two' }), product({ code: 'PRD-A', name: 'Three' })), [
        problem('products', 2, 'code', 'DUPLICATE_CODE'),
        problem('products', 4, 'code', 'DUPLICATE_CODE'),
      ])
    })
  })

  describe('brand, name and variant', () => {
    it.each(['brand', 'name'])('%s is required, and null, an empty cell and only spaces all count as empty', (column) => {
      for (const empty of [null, '', '   ']) expectProblems(inProducts(product({ [column]: empty })), [problem('products', 2, column, 'REQUIRED')])
    })

    it.each(['brand', 'name', 'variant'])('%s carries no link or markup', (column) => {
      for (const bad of ['Buy at https://shop.example.com', 'see www.shop.example.com', '<b>Bold</b>']) {
        expectProblems(inProducts(product({ [column]: bad })), [problem('products', 2, column, 'HAS_LINK_OR_MARKUP')])
      }
    })

    // A cell is measured before it is read: a cell over its cap says only that, so a huge cell never costs more than its length to refuse.
    it.each(['brand', 'name', 'variant'])('%s holds at most 120 characters: 120 is fine, 121 is TOO_LONG', (column) => {
      expectValid(inProducts(product({ [column]: text(120) })))
      expectProblems(inProducts(product({ [column]: text(121) })), [problem('products', 2, column, 'TOO_LONG')])
    })

    it.each(['brand', 'name', 'variant'])('says only TOO_LONG for a %s over 120 characters that also holds a link or markup', (column) => {
      expectProblems(inProducts(product({ [column]: `https://shop.example.com/${text(100)}` })), [problem('products', 2, column, 'TOO_LONG')])
      expectProblems(inProducts(product({ [column]: `<b>${text(118)}` })), [problem('products', 2, column, 'TOO_LONG')])
    })

    it('lets a name hold ordinary angle brackets and percent signs', () => {
      expectValid(inProducts(product({ name: 'Serum 10% (pH < 5)' })))
    })
  })

  describe('form and category', () => {
    it.each(PRODUCT_FORMS)('accepts the form %s', (form) => {
      expectValid(inProducts(product({ form })))
    })

    it('refuses a form that is not one of the product forms', () => {
      expectProblems(inProducts(product({ form: 'foam' })), [problem('products', 2, 'form', 'NOT_IN_VOCABULARY')])
    })

    it.each(CATEGORIES)('accepts the category %s', (category) => {
      expectValid(inProducts(product({ category })))
    })

    it('requires a category from the list', () => {
      expectProblems(inProducts(product({ category: 'face' })), [problem('products', 2, 'category', 'NOT_IN_VOCABULARY')])
      expectProblems(inProducts(product({ category: null })), [problem('products', 2, 'category', 'REQUIRED')])
    })
  })

  describe('ingredients', () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => `Ingredient ${i}`).join(';')

    it('is required for a draft and an approved product', () => {
      expectProblems(inProducts(product({ ingredients: null })), [problem('products', 2, 'ingredients', 'REQUIRED')])
      expectProblems(inProducts(product({ ingredients: ' ; ;', status: 'draft' })), [problem('products', 2, 'ingredients', 'REQUIRED')])
    })

    it('may be empty for a retired product, which has nothing left to analyse', () => {
      expectValid(inProducts(product({ ingredients: null, status: 'retired' })))
    })

    it('holds from 1 to 150 items', () => {
      expect(parsed(inProducts(product({ ingredients: items(1) }))).products[0]!.ingredients).toHaveLength(1)
      expect(parsed(inProducts(product({ ingredients: items(150) }))).products[0]!.ingredients).toHaveLength(150)
      expectProblems(inProducts(product({ ingredients: items(151) })), [problem('products', 2, 'ingredients', 'TOO_MANY_ITEMS')])
    })

    it('holds items of at most 120 characters', () => {
      expectValid(inProducts(product({ ingredients: `Aqua;${text(120)}` })))
      expectProblems(inProducts(product({ ingredients: `Aqua;${text(121)}` })), [problem('products', 2, 'ingredients', 'ITEM_TOO_LONG')])
    })

    it('holds items with no link or markup', () => {
      expectProblems(inProducts(product({ ingredients: 'Aqua;<script>alert(1)</script>' })), [problem('products', 2, 'ingredients', 'HAS_LINK_OR_MARKUP')])
    })
  })

  describe('ingredients_source_url', () => {
    it('is required for an approved product, and not for a draft or a retired one', () => {
      expectProblems(inProducts(product({ ingredients_source_url: null })), [problem('products', 2, 'ingredients_source_url', 'REQUIRED_WHEN_APPROVED')])
      expectValid(inProducts(product({ ingredients_source_url: null, status: 'draft' })))
      expectValid(inProducts(product({ ingredients_source_url: null, status: 'retired' })))
    })

    it('is an https URL whatever the status', () => {
      for (const status of ['approved', 'draft', 'retired']) {
        for (const bad of ['http://www.cerave.com/p', 'not a url', 'ftp://example.com/p', 'javascript:alert(1)']) {
          expectProblems(inProducts(product({ ingredients_source_url: bad, status })), [problem('products', 2, 'ingredients_source_url', 'NOT_HTTPS_URL')])
        }
      }
    })
  })

  describe('key_ingredient and strength', () => {
    // Both are optional plain-text cells shown to people ("what to look for") and never read by a rule. Over-length is judged first, as for any text.
    it('are optional: a row with both empty is valid and reads back both as null', () => {
      for (const empty of [null, '', '   ']) expectValid(inProducts(product({ key_ingredient: empty, strength: empty })))
      expect(parsed(inProducts(product())).products[0]).toMatchObject({ keyIngredient: null, strength: null })
    })

    it('are read back as written, trimmed, when both are filled', () => {
      const result = parsed(inProducts(product({ key_ingredient: '  Azelaic acid ', strength: ' 10% ' })))

      expect(result.products[0]).toMatchObject({ keyIngredient: 'Azelaic acid', strength: '10%' })
    })

    it('accepts a key ingredient with no strength: the label may not state one', () => {
      expect(parsed(inProducts(product({ key_ingredient: 'Niacinamide', strength: null }))).products[0]).toMatchObject({ keyIngredient: 'Niacinamide', strength: null })
    })

    it('holds a key_ingredient of at most 80 characters: 80 is fine, 81 is TOO_LONG', () => {
      expectValid(inProducts(product({ key_ingredient: text(80) })))
      expectProblems(inProducts(product({ key_ingredient: text(81) })), [problem('products', 2, 'key_ingredient', 'TOO_LONG')])
    })

    it('holds a strength of at most 40 characters: 40 is fine, 41 is TOO_LONG', () => {
      expectValid(inProducts(product({ key_ingredient: 'Azelaic acid', strength: text(40) })))
      expectProblems(inProducts(product({ key_ingredient: 'Azelaic acid', strength: text(41) })), [problem('products', 2, 'strength', 'TOO_LONG')])
    })

    it.each(['key_ingredient', 'strength'])('%s carries no link or markup', (column) => {
      for (const bad of ['Buy at https://shop.example.com', 'see www.shop.example.com', '<b>10%</b>']) {
        expectProblems(inProducts(product({ key_ingredient: 'Azelaic acid', [column]: bad })), [problem('products', 2, column, 'HAS_LINK_OR_MARKUP')])
      }
    })

    it.each(['key_ingredient', 'strength'])('says only TOO_LONG for a %s over its length that also holds a link or markup', (column) => {
      expectProblems(inProducts(product({ key_ingredient: 'Azelaic acid', [column]: `https://shop.example.com/${text(100)}` })), [problem('products', 2, column, 'TOO_LONG')])
    })

    it('lets a strength hold percent signs and a key ingredient hold ordinary punctuation', () => {
      expectValid(inProducts(product({ key_ingredient: 'Vitamin C (L-ascorbic acid)', strength: '0.5% - 2%' })))
    })

    it('reports a strength with no key_ingredient as STRENGTH_WITHOUT_INGREDIENT on the strength cell of that row, since a strength alone means nothing', () => {
      for (const empty of [null, '', '   ']) {
        expectProblems(inProducts(product({ key_ingredient: empty, strength: '10%' })), [problem('products', 2, 'strength', 'STRENGTH_WITHOUT_INGREDIENT')])
      }
    })

    it('reports STRENGTH_WITHOUT_INGREDIENT only for the row that has it, and for a draft row as well as an approved one', () => {
      expectProblems(inProducts(product({ code: 'PRD-A', name: 'A', key_ingredient: 'Azelaic acid', strength: '10%' }), product({ code: 'PRD-B', name: 'B', strength: '10%', status: 'draft', approved_by: null, approved_on: null })), [
        problem('products', 3, 'strength', 'STRENGTH_WITHOUT_INGREDIENT'),
      ])
    })

    it('can be named in draft_cells, like any other Products column', () => {
      expectValid(inProducts(product({ status: 'draft', approved_by: null, approved_on: null, key_ingredient: 'Azelaic acid', draft_cells: 'key_ingredient=https://example.com/azelaic' })))
    })

    it('explains the new rule in the contract in plain words, and lists it among the Products checks', () => {
      expect(CONTRACT.rules.STRENGTH_WITHOUT_INGREDIENT).toMatch(/\S/)
      expect(CONTRACT.tabs.find((tab) => tab.key === 'products')!.checks.map((check) => check.rule)).toContain('STRENGTH_WITHOUT_INGREDIENT')
    })

    it('declares both as optional plain-text columns with the lengths 80 and 40', () => {
      const columns = CONTRACT.tabs.find((tab) => tab.key === 'products')!.columns
      const keyIngredient = columns.find((column) => column.name === 'key_ingredient')
      const strength = columns.find((column) => column.name === 'strength')

      expect(keyIngredient).toMatchObject({ type: 'text', required: 'optional', maxLength: 80, plainText: true })
      expect(strength).toMatchObject({ type: 'text', required: 'optional', maxLength: 40, plainText: true })
    })
  })

  describe('skin_concerns, skin_types, steps and frequency', () => {
    it.each(SHOWN_CONCERNS)('accepts the skin concern %s', (concern) => {
      expectValid(inProducts(product({ skin_concerns: concern })))
    })

    it('needs at least one skin concern, each one a concern a face scan can show', () => {
      expectProblems(inProducts(product({ skin_concerns: null })), [problem('products', 2, 'skin_concerns', 'REQUIRED')])
      expectProblems(inProducts(product({ skin_concerns: ' ; ' })), [problem('products', 2, 'skin_concerns', 'REQUIRED')])
      expectProblems(inProducts(product({ skin_concerns: 'acne' })), [problem('products', 2, 'skin_concerns', 'NOT_IN_VOCABULARY')])
      // The skin type is asked of the face scan too, but it is a label, not a concern.
      expectProblems(inProducts(product({ skin_concerns: 'hd_skin_type' })), [problem('products', 2, 'skin_concerns', 'NOT_IN_VOCABULARY')])
      expectProblems(inProducts(product({ skin_concerns: 'hd_acne;hd_nope;hd_nada' })), [problem('products', 2, 'skin_concerns', 'NOT_IN_VOCABULARY')])
    })

    it.each(SKIN_TYPE_LABELS)('accepts the skin type %s', (label) => {
      expectValid(inProducts(product({ skin_types: label })))
    })

    it('accepts all the labels together, and "all" alone', () => {
      expectValid(inProducts(product({ skin_types: SKIN_TYPE_LABELS.join(';') })))
      expect(parsed(inProducts(product({ skin_types: 'all' }))).products[0]!.skinTypes).toEqual(['all'])
    })

    it('needs a skin type, never "all" next to another, and never one that is not a label', () => {
      expectProblems(inProducts(product({ skin_types: null })), [problem('products', 2, 'skin_types', 'REQUIRED')])
      expectProblems(inProducts(product({ skin_types: 'all;oily' })), [problem('products', 2, 'skin_types', 'ALL_MIXED_WITH_OTHERS')])
      expectProblems(inProducts(product({ skin_types: 'greasy' })), [problem('products', 2, 'skin_types', 'NOT_IN_VOCABULARY')])
    })

    it.each(ROUTINE_STEPS)('accepts the step %s', (step) => {
      expectValid(inProducts(product({ steps: step })))
    })

    it('needs at least one step, each a routine step', () => {
      expect(parsed(inProducts(product({ steps: ROUTINE_STEPS.join(';') }))).products[0]!.steps).toEqual([...ROUTINE_STEPS])
      expectProblems(inProducts(product({ steps: null })), [problem('products', 2, 'steps', 'REQUIRED')])
      expectProblems(inProducts(product({ steps: 'cleanse;exfoliate' })), [problem('products', 2, 'steps', 'NOT_IN_VOCABULARY')])
    })

    it.each(FREQUENCIES)('accepts the frequency %s', (frequency) => {
      expectValid(inProducts(product({ frequency })))
    })

    it('needs exactly one frequency from the list', () => {
      expectProblems(inProducts(product({ frequency: null })), [problem('products', 2, 'frequency', 'REQUIRED')])
      expectProblems(inProducts(product({ frequency: 'daily' })), [problem('products', 2, 'frequency', 'NOT_IN_VOCABULARY')])
      expectProblems(inProducts(product({ frequency: 'am;pm' })), [problem('products', 2, 'frequency', 'NOT_IN_VOCABULARY')])
    })
  })

  describe('own_cautions and evidence_urls', () => {
    it.each(CONCERN_KINDS)('accepts the own caution %s', (kind) => {
      expectValid(inProducts(product({ own_cautions: kind })))
    })

    it('are optional; a caution must be a concern kind and an evidence link an https URL', () => {
      expectValid(inProducts(product({ own_cautions: null, evidence_urls: null })))
      expectProblems(inProducts(product({ own_cautions: 'irritation;itchy' })), [problem('products', 2, 'own_cautions', 'NOT_IN_VOCABULARY')])
      expectProblems(inProducts(product({ evidence_urls: 'https://a.example.com/x;http://b.example.com/y' })), [problem('products', 2, 'evidence_urls', 'NOT_HTTPS_URL')])
    })
  })

  describe('origin and status', () => {
    it.each(ORIGINS)('accepts the origin %s', (origin) => {
      expectValid(inProducts(product({ origin })))
    })

    it('needs an origin from the list', () => {
      expectProblems(inProducts(product({ origin: 'invented' })), [problem('products', 2, 'origin', 'NOT_IN_VOCABULARY')])
      expectProblems(inProducts(product({ origin: null })), [problem('products', 2, 'origin', 'REQUIRED')])
    })

    it.each(['draft', 'approved', 'retired'])('accepts the status %s', (status) => {
      expectValid(inProducts(product({ status })))
    })

    it('needs a status of draft, approved or retired', () => {
      expectProblems(inProducts(product({ status: 'live' })), [problem('products', 2, 'status', 'NOT_IN_VOCABULARY')])
      expectProblems(inProducts(product({ status: null })), [problem('products', 2, 'status', 'REQUIRED')])
    })
  })

  describe('approval and audit', () => {
    it('needs an approver and a date to be approved, each reported where it is missing', () => {
      expectProblems(inProducts(product({ approved_by: null })), [problem('products', 2, 'approved_by', 'REQUIRED_WHEN_APPROVED')])
      expectProblems(inProducts(product({ approved_on: null })), [problem('products', 2, 'approved_on', 'REQUIRED_WHEN_APPROVED')])
      expectProblems(inProducts(product({ approved_by: '  ', approved_on: '' })), [
        problem('products', 2, 'approved_by', 'REQUIRED_WHEN_APPROVED'),
        problem('products', 2, 'approved_on', 'REQUIRED_WHEN_APPROVED'),
      ])
    })

    it.each(['approved_by', 'audited_by'])('holds at most 80 characters of %s: 80 is fine, 81 is TOO_LONG', (column) => {
      const audit = { audited_by: 'Nneka Audit', audited_on: AUDITED_ON }
      expectValid(inProducts(product({ ...audit, [column]: text(80) })))
      expectProblems(inProducts(product({ ...audit, [column]: text(81) })), [problem('products', 2, column, 'TOO_LONG')])
    })

    it.each(['draft', 'retired'])('does not need an approver for a %s product', (status) => {
      expectValid(inProducts(product({ status, approved_by: null, approved_on: null })))
    })

    it.each(['15/06/2030', '2030-6-1', '2030-02-30', '2030-13-01', '2030-06-15T00:00:00Z', 'yesterday', 20300615])('refuses the date %s as BAD_DATE', (date) => {
      expectProblems(inProducts(product({ approved_on: date })), [problem('products', 2, 'approved_on', 'BAD_DATE')])
      expectProblems(inProducts(product({ audited_by: 'Nneka Audit', audited_on: date })), [problem('products', 2, 'audited_on', 'BAD_DATE')])
    })

    it('accepts a real calendar day, a leap day included', () => {
      expect(parsed(inProducts(product({ approved_on: '2032-02-29' }))).products[0]!.approvedOn).toEqual(utcMidnight('2032-02-29'))
    })

    it('takes an audit as a name and a date together or not at all, reporting the half that is missing', () => {
      expectValid(inProducts(product({ audited_by: 'Nneka Audit', audited_on: AUDITED_ON })))
      expectProblems(inProducts(product({ audited_by: 'Nneka Audit' })), [problem('products', 2, 'audited_on', 'AUDIT_INCOMPLETE')])
      expectProblems(inProducts(product({ audited_on: AUDITED_ON })), [problem('products', 2, 'audited_by', 'AUDIT_INCOMPLETE')])
    })
  })

  describe('draft_cells', () => {
    const drafted = (draft_cells: string, over: Raw = {}) => inProducts(product({ status: 'draft', draft_cells, ...over }))

    it('lists column=https-url pairs, split at the first "=" so a URL may carry its own', () => {
      const result = parsed(drafted('category=https://example.com/a; steps=https://example.com/b?x=1&y=2'))

      expect(result.products[0]!.draftCells).toEqual([
        { column: 'category', url: 'https://example.com/a' },
        { column: 'steps', url: 'https://example.com/b?x=1&y=2' },
      ])
    })

    it('is for a draft or a retired row, never an approved one', () => {
      expectValid(drafted('category=https://example.com/a'))
      expectValid(drafted('category=https://example.com/a', { status: 'retired' }))
      expectProblems(drafted('category=https://example.com/a', { status: 'approved' }), [problem('products', 2, 'draft_cells', 'APPROVED_WITH_DRAFT_CELLS')])
    })

    it('can mark any Products column but the identity and sign-off ones', () => {
      for (const column of ['brand', 'name', 'ingredients', 'skin_concerns', 'frequency', 'origin']) expectValid(drafted(`${column}=https://example.com/a`))
      for (const column of ['code', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on', 'draft_cells']) {
        expectProblems(drafted(`${column}=https://example.com/a`), [problem('products', 2, 'draft_cells', 'DRAFT_CELL_COLUMN')])
      }
    })

    it('refuses a column the Products tab does not have', () => {
      expectProblems(drafted('colour=https://example.com/a'), [problem('products', 2, 'draft_cells', 'DRAFT_CELL_COLUMN')])
    })

    it('refuses a pair with no "=", or no column, and a source that is not an https URL', () => {
      expectProblems(drafted('category'), [problem('products', 2, 'draft_cells', 'INVALID_DRAFT_CELL')])
      expectProblems(drafted('=https://example.com/a'), [problem('products', 2, 'draft_cells', 'INVALID_DRAFT_CELL')])
      expectProblems(drafted('category=http://example.com/a'), [problem('products', 2, 'draft_cells', 'NOT_HTTPS_URL')])
      expectProblems(drafted('category='), [problem('products', 2, 'draft_cells', 'INVALID_DRAFT_CELL')])
    })
  })

  describe('identity', () => {
    it('is brand, name, variant and form, read the way the catalog reads them: two rows that read the same are both reported', () => {
      expectProblems(
        inProducts(
          product({ code: 'PRD-A', brand: 'CeraVe', name: 'Hydrating Facial Cleanser' }),
          product({ code: 'PRD-B', brand: 'CERAVE', name: 'hydrating  facial cleanser 236 ml' }),
          product({ code: 'PRD-C', brand: 'Dove', name: 'Hydrating Facial Cleanser' }),
        ),
        [problem('products', 2, 'name', 'DUPLICATE_IDENTITY'), problem('products', 3, 'name', 'DUPLICATE_IDENTITY')],
      )
    })

    it('tells two products apart by variant, and by form', () => {
      expectValid(inProducts(product({ code: 'PRD-A', variant: 'Night' }), product({ code: 'PRD-B', variant: 'Day' }), product({ code: 'PRD-C', variant: 'Night', form: 'cream' }), product({ code: 'PRD-D', variant: 'Night', form: 'gel' })))
    })

    it('counts a retired row too, since it is still the same product', () => {
      expectProblems(inProducts(product({ code: 'PRD-A' }), product({ code: 'PRD-B', status: 'retired' })), [problem('products', 2, 'name', 'DUPLICATE_IDENTITY'), problem('products', 3, 'name', 'DUPLICATE_IDENTITY')])
    })
  })
})

describe('validateWorkbook: Availability', () => {
  it('points at a product and a country the workbook has', () => {
    expectProblems(inAvailability(availability({ product_code: 'PRD-NOPE' })), [problem('availability', 2, 'product_code', 'UNKNOWN_PRODUCT')])
    expectProblems(inAvailability(availability({ country: 'ZA' })), [problem('availability', 2, 'country', 'UNKNOWN_COUNTRY')])
    expectProblems(inAvailability(availability({ product_code: null, country: null })), [problem('availability', 2, 'product_code', 'REQUIRED'), problem('availability', 2, 'country', 'REQUIRED')])
  })

  it('may point at a retired product or a retired country, which stay in the workbook', () => {
    const raw = workbook({
      products: [product({ status: 'retired', ingredients: null })],
      availability: [availability()],
      ingredients: [],
      countries: [country({ status: 'retired' })],
    })

    expectValid(raw)
  })

  it('matches a product code exactly, case and all', () => {
    expectProblems(inAvailability(availability({ product_code: 'prd-cerave-cleanser' })), [problem('availability', 2, 'product_code', 'UNKNOWN_PRODUCT')])
  })

  describe('prices', () => {
    it.each([0, 1, 4000, '4000'])('accepts %s as a price', (price) => {
      expectValid(inAvailability(availability({ price_min: price, price_max: 999999 })))
    })

    it.each([-1, 1.5, '1.5', 'abc', '4,000', true])('refuses %s as NOT_A_WHOLE_NUMBER, saying nothing else about the pair', (price) => {
      expectProblems(inAvailability(availability({ price_min: price })), [problem('availability', 2, 'price_min', 'NOT_A_WHOLE_NUMBER')])
      expectProblems(inAvailability(availability({ price_max: price })), [problem('availability', 2, 'price_max', 'NOT_A_WHOLE_NUMBER')])
    })

    it('needs both', () => {
      expectProblems(inAvailability(availability({ price_min: null, price_max: '' })), [problem('availability', 2, 'price_min', 'REQUIRED'), problem('availability', 2, 'price_max', 'REQUIRED')])
    })

    it('has a minimum no higher than the maximum: equal is fine, one above is not', () => {
      expectValid(inAvailability(availability({ price_min: 6500, price_max: 6500 })))
      expectProblems(inAvailability(availability({ price_min: 6501, price_max: 6500 })), [problem('availability', 2, 'price_max', 'PRICE_RANGE')])
    })
  })

  describe('where_sold', () => {
    it('is optional text of at most 200 characters', () => {
      expectValid(inAvailability(availability({ where_sold: null })))
      expectValid(inAvailability(availability({ where_sold: text(200) })))
      expectProblems(inAvailability(availability({ where_sold: text(201) })), [problem('availability', 2, 'where_sold', 'TOO_LONG')])
    })

    it('carries no link or markup', () => {
      expectProblems(inAvailability(availability({ where_sold: 'Shop at https://shop.example.com' })), [problem('availability', 2, 'where_sold', 'HAS_LINK_OR_MARKUP')])
    })
  })

  describe('source_url', () => {
    it('is an optional https URL, where the price and shop were found', () => {
      expectValid(inAvailability(availability({ source_url: null })))
      expectValid(inAvailability(availability({ source_url: 'https://shop.example.com/cerave' })))
      expect(parsed(inAvailability(availability({ source_url: 'https://shop.example.com/cerave' }))).availability[0]).toMatchObject({ sourceUrl: 'https://shop.example.com/cerave' })
      expect(parsed(inAvailability(availability({ source_url: '' }))).availability[0]).toMatchObject({ sourceUrl: null })
    })

    it('refuses a link that is not https', () => {
      expectProblems(inAvailability(availability({ source_url: 'http://shop.example.com/cerave' })), [problem('availability', 2, 'source_url', 'NOT_HTTPS_URL')])
    })
  })

  it('has one row for each product and country: both rows of a pair are reported, and one product in two countries is fine', () => {
    expectValid(inAvailability(availability({ country: 'NG' }), availability({ country: 'GH' })))
    expectProblems(inAvailability(availability({ country: 'NG' }), availability({ country: 'GH' }), availability({ country: 'NG', price_min: 1 })), [
      problem('availability', 2, 'country', 'DUPLICATE_AVAILABILITY'),
      problem('availability', 4, 'country', 'DUPLICATE_AVAILABILITY'),
    ])
  })
})

describe('validateWorkbook: Ingredients', () => {
  describe('code', () => {
    it.each(['ING-RETINOL-SUN-SENSITIVITY', 'AB', 'A'.repeat(40)])('accepts %s', (code) => {
      expectValid(inIngredients(ingredient({ code })))
    })

    it.each(['A', 'ing-retinol', '-ING', 'A'.repeat(41)])('refuses %s as BAD_CODE', (code) => {
      expectProblems(inIngredients(ingredient({ code })), [problem('ingredients', 2, 'code', 'BAD_CODE')])
    })

    it('is required and unique: both rows that share one are reported', () => {
      expectProblems(inIngredients(ingredient({ code: null })), [problem('ingredients', 2, 'code', 'REQUIRED')])
      expectProblems(inIngredients(ingredient({ code: 'ING-A', name: 'one', aliases: null }), ingredient({ code: 'ING-A', name: 'two', aliases: null })), [
        problem('ingredients', 2, 'code', 'DUPLICATE_CODE'),
        problem('ingredients', 3, 'code', 'DUPLICATE_CODE'),
      ])
    })

    it('is its own list: a product may have a code an ingredient rule has', () => {
      expectValid(workbook({ products: [product({ code: 'SHARED-1' })], availability: [], ingredients: [ingredient({ code: 'SHARED-1' })], countries: [] }))
    })
  })

  describe('name and aliases', () => {
    it('are INCI names in the normalised form the matcher compares: lower case is accepted and read as lower case', () => {
      const result = parsed(inIngredients(ingredient({ name: 'Retinol', aliases: 'Vitamin A Alcohol; Retinol Alcohol' })))

      expect(result.ingredients[0]).toMatchObject({ name: 'retinol', aliases: ['vitamin a alcohol', 'retinol alcohol'] })
    })

    it.each(['alcohol denat.', 'glycerin*', 'aqua  water', 'retinol†', 'retinol.*'])('refuses the name %s as NOT_NORMALISED, since the label spelling is not the stored one', (name) => {
      expectProblems(inIngredients(ingredient({ name })), [problem('ingredients', 2, 'name', 'NOT_NORMALISED')])
    })

    it('keeps brackets, hyphens and digits, which normalising keeps', () => {
      expectValid(inIngredients(ingredient({ name: 'aqua (water)', aliases: '1,4-dihydroxybenzene; ci 77891' })))
    })

    it('refuses an alias that is not normalised, naming the aliases column', () => {
      expectProblems(inIngredients(ingredient({ aliases: 'quinol; alcohol denat.' })), [problem('ingredients', 2, 'aliases', 'NOT_NORMALISED')])
    })

    it('hold at most 120 characters: a name of 121 is TOO_LONG and an alias of 121 is ITEM_TOO_LONG', () => {
      expectValid(inIngredients(ingredient({ name: text(120), aliases: text(120, 'b') })))
      expectProblems(inIngredients(ingredient({ name: text(121), aliases: null })), [problem('ingredients', 2, 'name', 'TOO_LONG')])
      expectProblems(inIngredients(ingredient({ aliases: `vitamin a alcohol;${text(121, 'b')}` })), [problem('ingredients', 2, 'aliases', 'ITEM_TOO_LONG')])
    })

    it('say only that they are too long when over 120 characters and also not normalised: the length is checked first', () => {
      expectProblems(inIngredients(ingredient({ name: `${text(120)}.`, aliases: null })), [problem('ingredients', 2, 'name', 'TOO_LONG')])
      expectProblems(inIngredients(ingredient({ aliases: `${text(120, 'b')}*` })), [problem('ingredients', 2, 'aliases', 'ITEM_TOO_LONG')])
    })

    it('needs a name, and may have no aliases', () => {
      expectProblems(inIngredients(ingredient({ name: null })), [problem('ingredients', 2, 'name', 'REQUIRED')])
      expect(parsed(inIngredients(ingredient({ aliases: null }))).ingredients[0]!.aliases).toEqual([])
    })
  })

  describe('kind, strength_limit and statement', () => {
    it.each(CONCERN_KINDS)('accepts the kind %s', (kind) => {
      expectValid(inIngredients(ingredient({ kind })))
    })

    it('needs a kind from the list', () => {
      expectProblems(inIngredients(ingredient({ kind: 'itchy' })), [problem('ingredients', 2, 'kind', 'NOT_IN_VOCABULARY')])
      expectProblems(inIngredients(ingredient({ kind: null })), [problem('ingredients', 2, 'kind', 'REQUIRED')])
    })

    it('has an optional strength limit of at most 80 characters', () => {
      expectValid(inIngredients(ingredient({ strength_limit: text(80) })))
      expectProblems(inIngredients(ingredient({ strength_limit: text(81) })), [problem('ingredients', 2, 'strength_limit', 'TOO_LONG')])
    })

    it('has a statement of 1 to 600 characters', () => {
      expectProblems(inIngredients(ingredient({ statement: null })), [problem('ingredients', 2, 'statement', 'REQUIRED')])
      expectValid(inIngredients(ingredient({ statement: text(600) })))
      expectProblems(inIngredients(ingredient({ statement: text(601) })), [problem('ingredients', 2, 'statement', 'TOO_LONG')])
    })

    it.each(['See https://example.com/why', 'see www.example.com', '<a href="x">why</a>'])('has a statement with no link or markup: %s', (statement) => {
      expectProblems(inIngredients(ingredient({ statement })), [problem('ingredients', 2, 'statement', 'HAS_LINK_OR_MARKUP')])
    })

    it('has a strength limit with no link or markup', () => {
      expectProblems(inIngredients(ingredient({ strength_limit: '<b>2%</b>' })), [problem('ingredients', 2, 'strength_limit', 'HAS_LINK_OR_MARKUP')])
    })
  })

  describe('source_url and helps', () => {
    it('has a source that is an https URL, or none for a commonly cited concern', () => {
      expectValid(inIngredients(ingredient({ source_url: null })))
      expectValid(inIngredients(ingredient({ source_url: 'https://eur-lex.europa.eu/eli/reg/2009/1223/oj' })))
      expectProblems(inIngredients(ingredient({ source_url: 'http://eur-lex.europa.eu/x' })), [problem('ingredients', 2, 'source_url', 'NOT_HTTPS_URL')])
    })

    it.each(SHOWN_CONCERNS)('accepts %s as a concern a rule helps', (concern) => {
      expectValid(inIngredients(ingredient({ helps: concern })))
    })

    it('has optional skin concerns it helps, each one a concern a face scan can show', () => {
      expectValid(inIngredients(ingredient({ helps: null })))
      expectProblems(inIngredients(ingredient({ helps: 'hd_texture;acne' })), [problem('ingredients', 2, 'helps', 'NOT_IN_VOCABULARY')])
    })
  })

  describe('status, approval and audit', () => {
    it.each(['draft', 'approved', 'retired'])('accepts the status %s', (status) => {
      expectValid(inIngredients(ingredient({ status })))
    })

    it('needs a status of draft, approved or retired', () => {
      expectProblems(inIngredients(ingredient({ status: 'live' })), [problem('ingredients', 2, 'status', 'NOT_IN_VOCABULARY')])
    })

    it('needs an approver and a date to be approved, as a product does, and neither for a draft or a retired rule', () => {
      expectProblems(inIngredients(ingredient({ approved_by: null })), [problem('ingredients', 2, 'approved_by', 'REQUIRED_WHEN_APPROVED')])
      expectProblems(inIngredients(ingredient({ approved_on: null })), [problem('ingredients', 2, 'approved_on', 'REQUIRED_WHEN_APPROVED')])
      expectValid(inIngredients(ingredient({ status: 'draft', approved_by: null, approved_on: null })))
      expectValid(inIngredients(ingredient({ status: 'retired', approved_by: null, approved_on: null })))
    })

    it.each(['approved_by', 'audited_by'])('holds at most 80 characters of %s: 80 is fine, 81 is TOO_LONG', (column) => {
      const audit = { audited_by: 'Nneka Audit', audited_on: AUDITED_ON }
      expectValid(inIngredients(ingredient({ ...audit, [column]: text(80) })))
      expectProblems(inIngredients(ingredient({ ...audit, [column]: text(81) })), [problem('ingredients', 2, column, 'TOO_LONG')])
    })

    it('reads dates as YYYY-MM-DD', () => {
      expectProblems(inIngredients(ingredient({ approved_on: '15/06/2030' })), [problem('ingredients', 2, 'approved_on', 'BAD_DATE')])
    })

    it('takes an audit as a name and a date together or not at all', () => {
      expectValid(inIngredients(ingredient({ audited_by: 'Nneka Audit', audited_on: AUDITED_ON })))
      expectProblems(inIngredients(ingredient({ audited_by: 'Nneka Audit' })), [problem('ingredients', 2, 'audited_on', 'AUDIT_INCOMPLETE')])
      expectProblems(inIngredients(ingredient({ audited_on: AUDITED_ON })), [problem('ingredients', 2, 'audited_by', 'AUDIT_INCOMPLETE')])
    })
  })

  // reviewer_role (contract 2.4.0): the role the app shows under "Reviewed by". Needed once a rule is approved, like approved_by; a role and never a name.
  describe('reviewer_role', () => {
    it('is needed once the rule is approved, reported where it is missing', () => {
      expectProblems(inIngredients(ingredient({ reviewer_role: null })), [problem('ingredients', 2, 'reviewer_role', 'REQUIRED_WHEN_APPROVED')])
      expectProblems(inIngredients(ingredient({ reviewer_role: '   ' })), [problem('ingredients', 2, 'reviewer_role', 'REQUIRED_WHEN_APPROVED')])
    })

    it('is reported alongside a missing approver and day, each where it is missing', () => {
      expectProblems(inIngredients(ingredient({ approved_by: null, approved_on: null, reviewer_role: null })), [
        problem('ingredients', 2, 'approved_by', 'REQUIRED_WHEN_APPROVED'),
        problem('ingredients', 2, 'approved_on', 'REQUIRED_WHEN_APPROVED'),
        problem('ingredients', 2, 'reviewer_role', 'REQUIRED_WHEN_APPROVED'),
      ])
    })

    it.each(['draft', 'retired'])('is not needed for a %s rule, and may be given', (status) => {
      expectValid(inIngredients(ingredient({ status, approved_by: null, approved_on: null, reviewer_role: null })))
      expectValid(inIngredients(ingredient({ status, approved_by: null, approved_on: null, reviewer_role: 'a pharmacist' })))
    })

    it('holds at most 80 characters: 80 is fine, 81 is TOO_LONG', () => {
      expectValid(inIngredients(ingredient({ reviewer_role: text(80) })))
      expectProblems(inIngredients(ingredient({ reviewer_role: text(81) })), [problem('ingredients', 2, 'reviewer_role', 'TOO_LONG')])
    })

    it.each(['See https://example.com/who', 'see www.example.com', '<b>a pharmacist</b>'])('is plain text with no link or markup: %s', (reviewer_role) => {
      expectProblems(inIngredients(ingredient({ reviewer_role })), [problem('ingredients', 2, 'reviewer_role', 'HAS_LINK_OR_MARKUP')])
    })

    it('is read into the rule as reviewerRole', () => {
      expect(parsed(inIngredients(ingredient({ reviewer_role: 'a pharmacist' }))).ingredients[0]).toMatchObject({ reviewerRole: 'a pharmacist' })
    })
  })

  // One fact per kind per label: a label (a name or an alias) may be in only one rule of a kind, among the rules that are not retired.
  describe('one rule for each label and kind', () => {
    it('refuses two rules with the same name and kind, in both rows', () => {
      expectProblems(inIngredients(ingredient({ code: 'ING-A', name: 'retinol', aliases: null }), ingredient({ code: 'ING-B', name: 'retinol', aliases: null })), [
        problem('ingredients', 2, 'name', 'DUPLICATE_RULE'),
        problem('ingredients', 3, 'name', 'DUPLICATE_RULE'),
      ])
    })

    it('compares labels as the matcher does, in lower case', () => {
      expectProblems(inIngredients(ingredient({ code: 'ING-A', name: 'Retinol', aliases: null }), ingredient({ code: 'ING-B', name: 'retinol', aliases: null })), [
        problem('ingredients', 2, 'name', 'DUPLICATE_RULE'),
        problem('ingredients', 3, 'name', 'DUPLICATE_RULE'),
      ])
    })

    it('allows the same name under two kinds, which is how an ingredient with two concerns is written', () => {
      expectValid(inIngredients(ingredient({ code: 'ING-A', name: 'retinol', kind: 'sun-sensitivity', aliases: null }), ingredient({ code: 'ING-B', name: 'retinol', kind: 'pregnancy-caution', aliases: null })))
    })

    it('refuses a name that another rule of the kind has as an alias, naming the aliases column on the rule that has the alias', () => {
      expectProblems(inIngredients(ingredient({ code: 'ING-A', name: 'retinol', aliases: 'vitamin a alcohol' }), ingredient({ code: 'ING-B', name: 'retinyl thing', aliases: 'retinol' })), [
        problem('ingredients', 2, 'name', 'DUPLICATE_RULE'),
        problem('ingredients', 3, 'aliases', 'DUPLICATE_RULE'),
      ])
    })

    it('refuses an alias two rules of the kind share, in both rows', () => {
      expectProblems(inIngredients(ingredient({ code: 'ING-A', name: 'one', aliases: 'shared' }), ingredient({ code: 'ING-B', name: 'two', aliases: 'other; shared' })), [
        problem('ingredients', 2, 'aliases', 'DUPLICATE_RULE'),
        problem('ingredients', 3, 'aliases', 'DUPLICATE_RULE'),
      ])
    })

    it('counts a draft, which is waiting to become a rule', () => {
      expectProblems(inIngredients(ingredient({ code: 'ING-A', name: 'retinol', aliases: null }), ingredient({ code: 'ING-B', name: 'retinol', aliases: null, status: 'draft' })), [
        problem('ingredients', 2, 'name', 'DUPLICATE_RULE'),
        problem('ingredients', 3, 'name', 'DUPLICATE_RULE'),
      ])
    })

    it('does not count a retired rule, so a rule can be replaced by a new one for the same label', () => {
      expectValid(inIngredients(ingredient({ code: 'ING-A', name: 'retinol', aliases: null, status: 'retired' }), ingredient({ code: 'ING-B', name: 'retinol', aliases: null })))
      expectValid(inIngredients(ingredient({ code: 'ING-A', name: 'one', aliases: 'shared', status: 'retired' }), ingredient({ code: 'ING-B', name: 'two', aliases: 'shared' })))
    })
  })
})

describe('validateWorkbook: Countries', () => {
  describe('code and currency', () => {
    it.each(['NG', 'GH', 'GB'])('accepts the country code %s', (code) => {
      expectValid(inCountries(country({ code })))
    })

    it.each(['ng', 'NGA', 'N', 'N1', 'N-', ' '])('refuses the country code "%s"', (code) => {
      const rule = code.trim() === '' ? 'REQUIRED' : 'BAD_CODE'
      expectProblems(inCountries(country({ code })), [problem('countries', 2, 'code', rule)])
    })

    it('needs a country code, once for each country: both rows that share one are reported', () => {
      expectProblems(inCountries(country({ code: null })), [problem('countries', 2, 'code', 'REQUIRED')])
      expectProblems(inCountries(country({ code: 'NG' }), country({ code: 'GH', currency: 'GHS' }), country({ code: 'NG' })), [
        problem('countries', 2, 'code', 'DUPLICATE_CODE'),
        problem('countries', 4, 'code', 'DUPLICATE_CODE'),
      ])
    })

    it('has a currency of three capital letters', () => {
      for (const currency of ['NGN', 'GBP']) expectValid(inCountries(country({ currency })))
      for (const currency of ['ngn', 'NG', 'NGNN', 'N1N']) expectProblems(inCountries(country({ currency })), [problem('countries', 2, 'currency', 'BAD_CURRENCY')])
      expectProblems(inCountries(country({ currency: null })), [problem('countries', 2, 'currency', 'REQUIRED')])
    })
  })

  describe('low_max and mid_max', () => {
    it('are whole numbers of the currency, as numbers or as text', () => {
      expectValid(inCountries(country({ low_max: '5000', mid_max: '15000' })))
      for (const bad of [-1, 1.5, 'abc', true]) {
        expectProblems(inCountries(country({ low_max: bad })), [problem('countries', 2, 'low_max', 'NOT_A_WHOLE_NUMBER')])
        expectProblems(inCountries(country({ mid_max: bad })), [problem('countries', 2, 'mid_max', 'NOT_A_WHOLE_NUMBER')])
      }
      expectProblems(inCountries(country({ low_max: null, mid_max: '' })), [problem('countries', 2, 'low_max', 'REQUIRED'), problem('countries', 2, 'mid_max', 'REQUIRED')])
    })

    it('keep the low band strictly below the mid band: one apart is fine, equal is not, and neither is above', () => {
      expectValid(inCountries(country({ low_max: 0, mid_max: 1 })))
      expectValid(inCountries(country({ low_max: 14999, mid_max: 15000 })))
      expectProblems(inCountries(country({ low_max: 15000, mid_max: 15000 })), [problem('countries', 2, 'mid_max', 'LOW_NOT_BELOW_MID')])
      expectProblems(inCountries(country({ low_max: 15001, mid_max: 15000 })), [problem('countries', 2, 'mid_max', 'LOW_NOT_BELOW_MID')])
    })
  })

  it.each(['active', 'retired'])('accepts the status %s', (status) => {
    expectValid(inCountries(country({ status })))
  })

  it('has a status of active or retired, so a country is retired and never deleted', () => {
    expectProblems(inCountries(country({ status: 'approved' })), [problem('countries', 2, 'status', 'NOT_IN_VOCABULARY')])
    expectProblems(inCountries(country({ status: null })), [problem('countries', 2, 'status', 'REQUIRED')])
  })
})

// --- the contract bump: Ingredients group and clashes_with, the Claim words tab, the Tapers tab -----------------------------------------------------
// Where a problem is reported, where the spec leaves it open (pinned here):
//   - clashes_with: the row that lists a group is the one reported, in `clashes_with`. A relation that is not symmetric is reported on the row that
//     lists the group nobody lists back, AND on every row of the listed group, in `group`, so both sides are seen (a listed group with no row at all
//     is reported on the listing row only). A retired rule applies to nothing: it neither asks for a reciprocal nor gives one.
//   - a phrase that two rows share (among rows that are not retired): every such row, in `phrase`.
//   - a schedule: always the `schedule` cell, one rule per shape, and a schedule with one fault gives exactly that fault.

describe('validateWorkbook: Ingredients group and clashes_with', () => {
  // The relation the lists carry: a retinoid and an exfoliating acid clash, and each says so.
  const retinoid = (over: Raw = {}) => ingredient({ code: 'ING-RETINOL-SUN-SENSITIVITY', name: 'retinol', aliases: null, group: 'retinoid', clashes_with: 'exfoliating-acid', ...over })
  const acid = (over: Raw = {}) => ingredient({ code: 'ING-GLYCOLIC-IRRITATION', name: 'glycolic acid', aliases: null, kind: 'irritation', group: 'exfoliating-acid', clashes_with: 'retinoid', ...over })

  it.each(['mercury', 'steroid', 'lightening-agent', 'retinoid', 'exfoliating-acid', 'benzoyl-peroxide'])('accepts %s as a group', (group) => {
    expectValid(inIngredients(ingredient({ group })))
  })

  it('leaves group and clashes_with empty on a rule that has neither, which is most rules', () => {
    expectValid(inIngredients(ingredient({ group: null, clashes_with: null })))
  })

  it('refuses a group that is not one of the six, with the spelling and case that must match exactly', () => {
    expectProblems(inIngredients(ingredient({ group: 'Retinoid' }), ingredient({ code: 'ING-B', name: 'b', aliases: null, group: 'vitamin-c' })), [
      problem('ingredients', 2, 'group', 'NOT_IN_VOCABULARY'),
      problem('ingredients', 3, 'group', 'NOT_IN_VOCABULARY'),
    ])
  })

  it('refuses a clashes_with item that is not a group, whether it is the only item or one of several', () => {
    expectProblems(inIngredients(ingredient({ group: 'retinoid', clashes_with: 'vitamin-c' })), [problem('ingredients', 2, 'clashes_with', 'NOT_IN_VOCABULARY')])
    expectProblems(inIngredients(retinoid({ clashes_with: 'exfoliating-acid; vitamin-c' }), acid()), [problem('ingredients', 2, 'clashes_with', 'NOT_IN_VOCABULARY')])
  })

  it('accepts a symmetric relation: every group that is listed has a row that lists the first group back', () => {
    expectValid(inIngredients(retinoid(), acid()))
  })

  it('accepts a relation where one side lists several groups and each of them lists the first back', () => {
    expectValid(
      inIngredients(
        retinoid({ clashes_with: 'exfoliating-acid; benzoyl-peroxide' }),
        acid(),
        ingredient({ code: 'ING-BPO-IRRITATION', name: 'benzoyl peroxide', aliases: null, kind: 'irritation', group: 'benzoyl-peroxide', clashes_with: 'retinoid' }),
      ),
    )
  })

  it('accepts the reciprocal on any row of the listed group, not only the first', () => {
    expectValid(inIngredients(retinoid(), acid({ code: 'ING-LACTIC-IRRITATION', name: 'lactic acid', clashes_with: null }), acid({ code: 'ING-MANDELIC-IRRITATION', name: 'mandelic acid' })))
  })

  it('refuses a relation that is not symmetric, naming both sides: the row that lists the group and the rows of the group that does not list it back', () => {
    expectProblems(inIngredients(retinoid(), acid({ clashes_with: null })), [problem('ingredients', 2, 'clashes_with', 'CLASH_NOT_SYMMETRIC'), problem('ingredients', 3, 'group', 'CLASH_NOT_SYMMETRIC')])
  })

  it('refuses a listed group that no row has at all, on the row that lists it', () => {
    expectProblems(inIngredients(retinoid()), [problem('ingredients', 2, 'clashes_with', 'CLASH_NOT_SYMMETRIC')])
  })

  it('does not count a retired rule as the reciprocal: it applies to nothing', () => {
    expectProblems(inIngredients(retinoid(), acid({ status: 'retired' })), [problem('ingredients', 2, 'clashes_with', 'CLASH_NOT_SYMMETRIC')])
  })

  it('does not ask a retired rule for a reciprocal either', () => {
    expectValid(inIngredients(retinoid({ status: 'retired' })))
  })

  it('counts a draft, as it counts a draft for a duplicate: it is waiting to become a rule', () => {
    expectValid(inIngredients(retinoid(), acid({ status: 'draft', approved_by: null, approved_on: null })))
  })

  it('refuses a rule that lists clashes_with but has no group, since the relation is between groups', () => {
    expectProblems(inIngredients(ingredient({ group: null, clashes_with: 'retinoid' }), ingredient({ code: 'ING-GLYCOLIC-X', name: 'glycolic acid', aliases: null, group: 'retinoid', clashes_with: null })), [
      problem('ingredients', 2, 'clashes_with', 'CLASH_WITHOUT_GROUP'),
    ])
  })

  it('refuses a group that clashes with itself', () => {
    expectProblems(inIngredients(retinoid({ clashes_with: 'retinoid' })), [problem('ingredients', 2, 'clashes_with', 'SELF_CLASH')])
  })

  it('refuses a self clash even when other groups are listed with it, and reports only that item', () => {
    expectProblems(inIngredients(retinoid({ clashes_with: 'exfoliating-acid; retinoid' }), acid()), [problem('ingredients', 2, 'clashes_with', 'SELF_CLASH')])
  })

  it('splits clashes_with on ";" like every list, trimming each item and dropping empty ones', () => {
    const result = parsed(inIngredients(retinoid({ clashes_with: ' exfoliating-acid ;; ' }), acid()))

    expect(result.ingredients[0]).toMatchObject({ group: 'retinoid', clashesWith: ['exfoliating-acid'] })
  })
})

describe('validateWorkbook: Claim words', () => {
  it('reads a claim word into code, phrase, claim, source, status, reviewer role and sign-off', () => {
    expect(parsed(inClaimWords(claimWord({ phrase: 'skin fairness', audited_by: 'Nneka Audit', audited_on: AUDITED_ON }))).claimWords).toEqual([
      {
        code: 'CLM-WHITENING',
        phrase: 'skin fairness',
        claim: 'lightening',
        sourceUrl: null,
        status: 'approved',
        approvedBy: 'Dr A. Reviewer',
        reviewerRole: 'a consultant dermatologist',
        approvedOn: utcMidnight(APPROVED_ON),
        auditedBy: 'Nneka Audit',
        auditedOn: utcMidnight(AUDITED_ON),
      },
    ])
  })

  describe('code', () => {
    it.each(['CLM-WHITENING', 'CLM-A1', 'C1'])('accepts %s', (code) => {
      expectValid(inClaimWords(claimWord({ code })))
    })

    it.each(['clm-whitening', 'C', '-CLM', 'CLM WHITENING', `C${text(40)}`.toUpperCase()])('refuses %j as BAD_CODE', (code) => {
      expectProblems(inClaimWords(claimWord({ code })), [problem('claimWords', 2, 'code', 'BAD_CODE')])
    })

    it('is required and unique: both rows that share one are reported', () => {
      expectProblems(inClaimWords(claimWord({ code: null })), [problem('claimWords', 2, 'code', 'REQUIRED')])
      expectProblems(inClaimWords(claimWord(), claimWord({ phrase: 'bleaching' })), [problem('claimWords', 2, 'code', 'DUPLICATE_CODE'), problem('claimWords', 3, 'code', 'DUPLICATE_CODE')])
    })

    it('is its own list: a product, a rule and a taper may have a code a claim word has', () => {
      expectValid(workbook({ products: [product({ code: 'CLM-WHITENING' })], availability: [], ingredients: [ingredient({ code: 'CLM-WHITENING' })], countries: [], tapers: [taper({ code: 'CLM-WHITENING' })] }))
    })
  })

  describe('phrase', () => {
    it('is plain lower-case words of at most 60 characters: 60 is fine, 61 is TOO_LONG', () => {
      expectValid(inClaimWords(claimWord({ phrase: text(60) })))
      expectProblems(inClaimWords(claimWord({ phrase: text(61) })), [problem('claimWords', 2, 'phrase', 'TOO_LONG')])
    })

    it('is required', () => {
      expectProblems(inClaimWords(claimWord({ phrase: null })), [problem('claimWords', 2, 'phrase', 'REQUIRED')])
    })

    it('is written in lower case: a capital is refused as NOT_LOWER_CASE, not silently lowered', () => {
      expectProblems(inClaimWords(claimWord({ phrase: 'Whitening' })), [problem('claimWords', 2, 'phrase', 'NOT_LOWER_CASE')])
      expectProblems(inClaimWords(claimWord({ phrase: 'skin Toning' })), [problem('claimWords', 2, 'phrase', 'NOT_LOWER_CASE')])
    })

    it.each(['brightening', 'glow', 'instant glow', 'skin brightening serum', 'glow-boost'])('is never a claim word to say %j: it is NOT_A_LIGHTENING_CLAIM', (phrase) => {
      expectProblems(inClaimWords(claimWord({ phrase })), [problem('claimWords', 2, 'phrase', 'NOT_A_LIGHTENING_CLAIM')])
    })

    it('refuses brightening and glow in any case, and says NOT_LOWER_CASE too when it has a capital', () => {
      expectProblems(inClaimWords(claimWord({ phrase: 'Brightening' })), [problem('claimWords', 2, 'phrase', 'NOT_LOWER_CASE'), problem('claimWords', 2, 'phrase', 'NOT_A_LIGHTENING_CLAIM')])
    })

    it('refuses them in a retired row too, so the workbook never holds such a word', () => {
      expectProblems(inClaimWords(claimWord({ phrase: 'glow', status: 'retired' })), [problem('claimWords', 2, 'phrase', 'NOT_A_LIGHTENING_CLAIM')])
    })

    it.each(['glowing', 'afterglow', 'brightenings', 'skin lightening', 'whitening'])('does not refuse %j, which holds neither word as a whole word', (phrase) => {
      expectValid(inClaimWords(claimWord({ phrase })))
    })

    it('keeps digits, hyphens and spaces, which are plain', () => {
      expectValid(inClaimWords(claimWord({ phrase: '2-in-1 skin toning' })))
    })

    it('has no link and no markup', () => {
      expectProblems(inClaimWords(claimWord({ phrase: 'https://x.example.com' })), [problem('claimWords', 2, 'phrase', 'HAS_LINK_OR_MARKUP')])
      expectProblems(inClaimWords(claimWord({ phrase: '<b>whitening</b>' })), [problem('claimWords', 2, 'phrase', 'HAS_LINK_OR_MARKUP')])
    })

    it('is unique among the rows that are not retired: both rows are reported, in the phrase column', () => {
      expectProblems(inClaimWords(claimWord(), claimWord({ code: 'CLM-WHITENING-2' })), [problem('claimWords', 2, 'phrase', 'DUPLICATE_PHRASE'), problem('claimWords', 3, 'phrase', 'DUPLICATE_PHRASE')])
    })

    it('may be the phrase of a retired row, so a retired word can be replaced by a new one for the same phrase', () => {
      expectValid(inClaimWords(claimWord({ status: 'retired' }), claimWord({ code: 'CLM-WHITENING-2' })))
    })

    it('may be shared by two retired rows', () => {
      expectValid(inClaimWords(claimWord({ status: 'retired' }), claimWord({ code: 'CLM-WHITENING-2', status: 'retired' })))
    })
  })

  describe('claim', () => {
    it('is lightening, the only claim there is', () => {
      expectValid(inClaimWords(claimWord({ claim: 'lightening' })))
    })

    it.each(['brightening', 'Lightening', 'glow'])('refuses %s', (claim) => {
      expectProblems(inClaimWords(claimWord({ claim })), [problem('claimWords', 2, 'claim', 'NOT_IN_VOCABULARY')])
    })

    it('is required', () => {
      expectProblems(inClaimWords(claimWord({ claim: null })), [problem('claimWords', 2, 'claim', 'REQUIRED')])
    })
  })

  describe('source_url', () => {
    it('is optional, and an https URL when given', () => {
      expectValid(inClaimWords(claimWord({ source_url: null })))
      expectValid(inClaimWords(claimWord({ source_url: 'https://example.com/why-whitening-is-flagged' })))
    })

    it.each(['http://example.com/x', 'example.com/x', 'not a link'])('refuses %s: the cell is a link, and an https one', (source_url) => {
      expectProblems(inClaimWords(claimWord({ source_url })), [problem('claimWords', 2, 'source_url', 'NOT_HTTPS_URL')])
    })

    it('is read into the claim word as sourceUrl', () => {
      expect(parsed(inClaimWords(claimWord({ source_url: 'https://example.com/why' }))).claimWords[0]).toMatchObject({ sourceUrl: 'https://example.com/why' })
    })
  })

  // reviewer_role (contract 2.4.0): the same column, with the same rules, as on the Ingredients tab.
  describe('reviewer_role', () => {
    it('is needed once the word is approved, reported where it is missing', () => {
      expectProblems(inClaimWords(claimWord({ reviewer_role: null })), [problem('claimWords', 2, 'reviewer_role', 'REQUIRED_WHEN_APPROVED')])
      expectProblems(inClaimWords(claimWord({ reviewer_role: '   ' })), [problem('claimWords', 2, 'reviewer_role', 'REQUIRED_WHEN_APPROVED')])
    })

    it('is not needed for a retired word, and may be given', () => {
      expectValid(inClaimWords(claimWord({ status: 'retired', approved_by: null, approved_on: null, reviewer_role: null })))
      expectValid(inClaimWords(claimWord({ status: 'retired', approved_by: null, approved_on: null, reviewer_role: 'a pharmacist' })))
    })

    it('holds at most 80 characters: 80 is fine, 81 is TOO_LONG', () => {
      expectValid(inClaimWords(claimWord({ reviewer_role: text(80) })))
      expectProblems(inClaimWords(claimWord({ reviewer_role: text(81) })), [problem('claimWords', 2, 'reviewer_role', 'TOO_LONG')])
    })

    it.each(['See https://example.com/who', 'see www.example.com', '<b>a pharmacist</b>'])('is plain text with no link or markup: %s', (reviewer_role) => {
      expectProblems(inClaimWords(claimWord({ reviewer_role })), [problem('claimWords', 2, 'reviewer_role', 'HAS_LINK_OR_MARKUP')])
    })

    it('is read into the claim word as reviewerRole', () => {
      expect(parsed(inClaimWords(claimWord({ reviewer_role: 'a pharmacist' }))).claimWords[0]).toMatchObject({ reviewerRole: 'a pharmacist' })
    })
  })

  describe('status, approval and audit', () => {
    it('is approved or retired: a claim word has no draft, so draft is refused', () => {
      expectValid(inClaimWords(claimWord({ status: 'approved' })))
      expectValid(inClaimWords(claimWord({ status: 'retired' })))
      expectProblems(inClaimWords(claimWord({ status: 'draft' })), [problem('claimWords', 2, 'status', 'NOT_IN_VOCABULARY')])
      expectProblems(inClaimWords(claimWord({ status: null })), [problem('claimWords', 2, 'status', 'REQUIRED')])
    })

    it('needs an approver and a date to be approved, each reported where it is missing, and neither for a retired word', () => {
      expectProblems(inClaimWords(claimWord({ approved_by: null, approved_on: null })), [
        problem('claimWords', 2, 'approved_by', 'REQUIRED_WHEN_APPROVED'),
        problem('claimWords', 2, 'approved_on', 'REQUIRED_WHEN_APPROVED'),
      ])
      expectValid(inClaimWords(claimWord({ status: 'retired', approved_by: null, approved_on: null })))
    })

    it('has an approver of at most 80 characters: 80 is fine, 81 is TOO_LONG', () => {
      expectValid(inClaimWords(claimWord({ approved_by: text(80) })))
      expectProblems(inClaimWords(claimWord({ approved_by: text(81) })), [problem('claimWords', 2, 'approved_by', 'TOO_LONG')])
    })

    it('reads dates as YYYY-MM-DD, real calendar days only', () => {
      expectProblems(inClaimWords(claimWord({ approved_on: '2030-02-30' })), [problem('claimWords', 2, 'approved_on', 'BAD_DATE')])
    })

    it('takes an audit as a name and a date together or not at all, reporting the half that is missing', () => {
      expectProblems(inClaimWords(claimWord({ audited_by: 'Nneka Audit' })), [problem('claimWords', 2, 'audited_on', 'AUDIT_INCOMPLETE')])
      expectProblems(inClaimWords(claimWord({ audited_on: AUDITED_ON })), [problem('claimWords', 2, 'audited_by', 'AUDIT_INCOMPLETE')])
      expectValid(inClaimWords(claimWord({ audited_by: 'Nneka Audit', audited_on: AUDITED_ON })))
    })
  })
})

describe('validateWorkbook: Tapers', () => {
  /** A taper whose schedule is the one given, and nothing else different. */
  const scheduled = (schedule: string | null) => inTapers(taper({ schedule }))
  const scheduleProblem = (rule: string) => [problem('tapers', 2, 'schedule', rule)]

  it('reads a taper into code, kind, steps, the two plain-text cells, status and sign-off', () => {
    const [row] = parsed(inTapers(taper({ code: 'TPR-LIGHTENING-1', kind: 'lightening-agent' }))).tapers

    expect(row).toMatchObject({ code: 'TPR-LIGHTENING-1', kind: 'lightening-agent', status: 'approved', approvedBy: 'Dr A. Reviewer', approvedOn: utcMidnight(APPROVED_ON), auditedBy: null, auditedOn: null })
  })

  describe('code', () => {
    it('is a code like the others, required and unique: both rows that share one are reported', () => {
      expectValid(inTapers(taper({ code: 'TPR-STEROID-1' })))
      expectProblems(inTapers(taper({ code: 'tpr-steroid-1' })), [problem('tapers', 2, 'code', 'BAD_CODE')])
      expectProblems(inTapers(taper({ code: null })), [problem('tapers', 2, 'code', 'REQUIRED')])
      expectProblems(inTapers(taper(), taper()), [problem('tapers', 2, 'code', 'DUPLICATE_CODE'), problem('tapers', 3, 'code', 'DUPLICATE_CODE')])
    })
  })

  describe('kind', () => {
    it.each(['steroid', 'lightening-agent'])('accepts %s', (kind) => {
      expectValid(inTapers(taper({ kind })))
    })

    it.each(['mercury', 'Steroid', 'lightening'])('refuses %s: only a steroid or a lightening agent is stepped down', (kind) => {
      expectProblems(inTapers(taper({ kind })), [problem('tapers', 2, 'kind', 'NOT_IN_VOCABULARY')])
    })

    it('is required', () => {
      expectProblems(inTapers(taper({ kind: null })), [problem('tapers', 2, 'kind', 'REQUIRED')])
    })
  })

  describe('what_to_expect and see_a_professional_if', () => {
    it.each(['what_to_expect', 'see_a_professional_if'])('%s holds at most 400 characters: 400 is fine, 401 is TOO_LONG', (column) => {
      expectValid(inTapers(taper({ [column]: text(400) })))
      expectProblems(inTapers(taper({ [column]: text(401) })), [problem('tapers', 2, column, 'TOO_LONG')])
    })

    it.each(['what_to_expect', 'see_a_professional_if'])('%s is required, since a plan with nothing to expect or nobody to see is not one a person can follow', (column) => {
      expectProblems(inTapers(taper({ [column]: null })), [problem('tapers', 2, column, 'REQUIRED')])
    })

    it.each(['what_to_expect', 'see_a_professional_if'])('%s is plain text: no link and no markup', (column) => {
      expectProblems(inTapers(taper({ [column]: 'Read more at https://example.com/flare' })), [problem('tapers', 2, column, 'HAS_LINK_OR_MARKUP')])
      expectProblems(inTapers(taper({ [column]: 'Skin may <b>flare</b>.' })), [problem('tapers', 2, column, 'HAS_LINK_OR_MARKUP')])
    })

    it('says only that a cell is too long when it is also full of links: the length is checked first', () => {
      expectProblems(inTapers(taper({ what_to_expect: `https://example.com ${text(400)}` })), [problem('tapers', 2, 'what_to_expect', 'TOO_LONG')])
    })
  })

  it('exports the groups that are never brought back: mercury, steroid and lightening-agent, the three the contract refuses a ladder for', () => {
    expect([...REINTRO_NEVER_BACK]).toEqual(['mercury', 'steroid', 'lightening-agent'])
  })

  describe('schedule', () => {
    it('is required', () => {
      expectProblems(scheduled(null), scheduleProblem('REQUIRED'))
    })

    it('reads each entry as weeks, a frequency and where it ends: N is one week, N-M several', () => {
      const [row] = parsed(scheduled('1-2: alternate-days; 3: weekly; 4-6: as-needed; 7: stop')).tapers

      expect(row!.schedule).toEqual([
        { fromWeek: 1, toWeek: 2, frequency: 'alternate-days' },
        { fromWeek: 3, toWeek: 3, frequency: 'weekly' },
        { fromWeek: 4, toWeek: 6, frequency: 'as-needed' },
        { fromWeek: 7, toWeek: 7, frequency: 'stop' },
      ])
    })

    it('is the example of the contract: 1-2: alternate-days; 3-4: weekly; 5: stop', () => {
      expectValid(scheduled('1-2: alternate-days; 3-4: weekly; 5: stop'))
    })

    it('ignores spaces around entries and after the colon, as it does around every list item', () => {
      expect(parsed(scheduled(' 1-2:alternate-days ;  3 :  stop ')).tapers[0]!.schedule).toEqual([
        { fromWeek: 1, toWeek: 2, frequency: 'alternate-days' },
        { fromWeek: 3, toWeek: 3, frequency: 'stop' },
      ])
    })

    it.each([['am-pm'], ['am'], ['pm'], ['alternate-days'], ['weekly'], ['as-needed']])('accepts %s as the frequency of a step', (frequency) => {
      expectValid(scheduled(`1: ${frequency}; 2: stop`))
    })

    describe('each entry is `<weeks>: <frequency>`', () => {
      it.each([
        ['text that is no entry', 'taper slowly'],
        ['an entry with no weeks', ': weekly; 1: stop'],
        ['an entry with no frequency', '1: ; 2: stop'],
        ['an entry with no colon', '1 weekly; 2: stop'],
        ['a frequency that is not in the list', '1: daily; 2: stop'],
        ['a frequency in capitals', '1: Weekly; 2: stop'],
        ['week 0, since weeks start at 1', '0: weekly; 1: stop'],
        ['a week that is not a number', 'one: weekly; 2: stop'],
        ['a decimal week', '1.5: weekly; 2: stop'],
        ['a negative week', '-1: weekly; 2: stop'],
        ['a range written backwards', '3-1: weekly; 4: stop'],
        ['a range with three ends', '1-2-3: weekly; 4: stop'],
        ['a range with no end', '1-: weekly; 2: stop'],
      ])('refuses %s as BAD_SCHEDULE', (_what, schedule) => {
        expectProblems(scheduled(schedule), scheduleProblem('BAD_SCHEDULE'))
      })
    })

    describe('the weeks run from week 1 with no gap and no overlap', () => {
      it('accepts steps that follow each other: 1-2, 3, 4-6, 7', () => {
        expectValid(scheduled('1-2: weekly; 3: weekly; 4-6: as-needed; 7: stop'))
      })

      it('refuses a schedule that does not start at week 1', () => {
        expectProblems(scheduled('2: weekly; 3: stop'), scheduleProblem('SCHEDULE_NOT_CONTIGUOUS'))
      })

      it('refuses a gap: 1-2, then 4 (week 3 is nobody\'s)', () => {
        expectProblems(scheduled('1-2: weekly; 4: stop'), scheduleProblem('SCHEDULE_NOT_CONTIGUOUS'))
      })

      it('refuses an overlap: 1-3, then 3', () => {
        expectProblems(scheduled('1-3: weekly; 3: stop'), scheduleProblem('SCHEDULE_NOT_CONTIGUOUS'))
      })

      it('refuses a step that goes back inside an earlier one: 1-3, then 2', () => {
        expectProblems(scheduled('1-3: weekly; 2: stop'), scheduleProblem('SCHEDULE_NOT_CONTIGUOUS'))
      })

      it('refuses steps written out of order, even when together they cover the weeks', () => {
        expect(problemsOf(scheduled('3: stop; 1-2: weekly'))).toContainEqual(problem('tapers', 2, 'schedule', 'SCHEDULE_NOT_CONTIGUOUS'))
      })
    })

    describe('it ends with stop, and stop is only the last step', () => {
      it('refuses a schedule whose last step is not stop', () => {
        expectProblems(scheduled('1-2: alternate-days; 3-4: weekly'), scheduleProblem('SCHEDULE_MISSING_STOP'))
        expectProblems(scheduled('1: weekly'), scheduleProblem('SCHEDULE_MISSING_STOP'))
      })

      it('refuses a stop that is followed by another step', () => {
        expectProblems(scheduled('1: weekly; 2: stop; 3: stop'), scheduleProblem('SCHEDULE_STOP_NOT_LAST'))
      })
    })

    describe('the frequency never goes up: am-pm, then am or pm, then alternate-days, then weekly, then as-needed', () => {
      it('accepts the whole ladder, step by step down', () => {
        expectValid(scheduled('1: am-pm; 2: am; 3: alternate-days; 4: weekly; 5: as-needed; 6: stop'))
      })

      it('accepts a frequency that stays the same from one step to the next', () => {
        expectValid(scheduled('1: weekly; 2: weekly; 3: stop'))
      })

      it('treats am and pm as equal strength, so going from one to the other is not an increase, in either direction', () => {
        expectValid(scheduled('1: am; 2: pm; 3: stop'))
        expectValid(scheduled('1: pm; 2: am; 3: stop'))
      })

      it.each([
        ['weekly then alternate-days', '1: weekly; 2: alternate-days; 3: stop'],
        ['alternate-days then am', '1: alternate-days; 2: am; 3: stop'],
        ['pm then am-pm', '1: pm; 2: am-pm; 3: stop'],
        ['as-needed then weekly', '1: as-needed; 2: weekly; 3: stop'],
        ['one step down then back up', '1: am-pm; 2: weekly; 3: alternate-days; 4: stop'],
      ])('refuses %s as an increase', (_what, schedule) => {
        expectProblems(scheduled(schedule), scheduleProblem('SCHEDULE_FREQUENCY_INCREASES'))
      })
    })
  })

  describe('status, approval and audit', () => {
    it('is draft, approved or retired', () => {
      for (const status of ['draft', 'approved', 'retired']) expectValid(inTapers(taper({ status, ...(status === 'approved' ? {} : { approved_by: null, approved_on: null }) })))
      expectProblems(inTapers(taper({ status: 'live' })), [problem('tapers', 2, 'status', 'NOT_IN_VOCABULARY')])
      expectProblems(inTapers(taper({ status: null })), [problem('tapers', 2, 'status', 'REQUIRED')])
    })

    it('needs an approver and a date to be approved, each reported where it is missing, and neither for a draft or a retired template', () => {
      expectProblems(inTapers(taper({ approved_by: null, approved_on: null })), [problem('tapers', 2, 'approved_by', 'REQUIRED_WHEN_APPROVED'), problem('tapers', 2, 'approved_on', 'REQUIRED_WHEN_APPROVED')])
      expectValid(inTapers(taper({ status: 'draft', approved_by: null, approved_on: null }), taper({ code: 'TPR-STEROID-2', status: 'retired', approved_by: null, approved_on: null })))
    })

    it('takes an audit as a name and a date together or not at all, reporting the half that is missing', () => {
      expectProblems(inTapers(taper({ audited_by: 'Nneka Audit' })), [problem('tapers', 2, 'audited_on', 'AUDIT_INCOMPLETE')])
      expectProblems(inTapers(taper({ audited_on: AUDITED_ON })), [problem('tapers', 2, 'audited_by', 'AUDIT_INCOMPLETE')])
    })
  })

  it('keeps a retired template whole, schedule and all, so a past routine can still say which plan it used', () => {
    const [row] = parsed(inTapers(taper({ status: 'retired' }))).tapers

    expect(row).toMatchObject({ status: 'retired', schedule: [expect.anything(), expect.anything(), expect.anything()] })
  })
})

// --- the contract bump to 2.2.0: the Guides tab ---------------------------------------------------------------------------------------------------
// Where a problem is reported, where the spec leaves it open (pinned here):
//   - a Guides row is identified by its step and goal, not a code (the tab has no code column), so it has no DUPLICATE_CODE;
//   - GUIDE_BASE_MISSING: the tab has no approved row without a goal for some step. There is no row to point at, so it is on the header row, in `step`
//     (as MISSING_COLUMN is), once however many steps are missing. A draft or retired base row does not count. A tab whose `step` header is missing
//     says only that: with no column there are no steps to be missing;
//   - GUIDE_DUPLICATE: every row that shares its (step, goal) with another row, in `step`, whatever the rows' statuses (a retired row keeps its place);
//   - GUIDE_WORDING: the text cell that holds a forbidden word, one problem for the cell however many words it holds. A cell that is too long is
//     reported for its length only, as everywhere.

describe('validateWorkbook: Guides', () => {
  const SIXTH = 6

  it('reads a guide into its step, goal, three texts, the pregnancy text, status and sign-off', () => {
    const rows = parsed(
      withBases(
        guide({
          step: 'treat',
          goal: 'fade-dark-marks',
          what_it_does: 'Helps dark marks fade evenly over weeks.',
          look_for: 'Niacinamide or azelaic acid.',
          for_deeper_skin: 'Start slowly: strong acids can leave new dark marks on deeper skin.',
          look_for_when_pregnant: 'Azelaic acid. Leave out retinoids.',
          audited_by: 'Nneka Audit',
          audited_on: AUDITED_ON,
        }),
      ),
    ).guides

    expect(rows[0]).toEqual({
      step: 'cleanse',
      goal: null,
      whatItDoes: 'Lifts sweat, sunscreen and dirt off your skin so the rest of your routine can work.',
      lookFor: 'A gentle, fragrance-free wash that leaves your skin comfortable, not tight.',
      forDeeperSkin: 'Skip harsh scrubs and hot water: rubbing hard can leave dark marks behind on deeper skin.',
      lookForWhenPregnant: null,
      status: 'approved',
      approvedBy: 'Dr A. Reviewer',
      approvedOn: utcMidnight(APPROVED_ON),
      auditedBy: null,
      auditedOn: null,
    })
    expect(rows[4]).toEqual({
      step: 'treat',
      goal: 'fade-dark-marks',
      whatItDoes: 'Helps dark marks fade evenly over weeks.',
      lookFor: 'Niacinamide or azelaic acid.',
      forDeeperSkin: 'Start slowly: strong acids can leave new dark marks on deeper skin.',
      lookForWhenPregnant: 'Azelaic acid. Leave out retinoids.',
      status: 'approved',
      approvedBy: 'Dr A. Reviewer',
      approvedOn: utcMidnight(APPROVED_ON),
      auditedBy: 'Nneka Audit',
      auditedOn: utcMidnight(AUDITED_ON),
    })
  })

  it('keeps rows in the order they were given', () => {
    const steps = ['protect', 'treat', 'cleanse', 'moisturise']

    expect(parsed(inGuides(...steps.map((step) => guide({ step })))).guides.map((row) => row.step)).toEqual(steps)
  })

  describe('step', () => {
    it('is one of the four routine steps, and is required', () => {
      expectValid(withBases())
      expectProblems(withBases(guide({ step: 'exfoliate', goal: 'glow' })), [problem('guides', SIXTH, 'step', 'NOT_IN_VOCABULARY')])
      expectProblems(withBases(guide({ step: 'Cleanse', goal: 'glow' })), [problem('guides', SIXTH, 'step', 'NOT_IN_VOCABULARY')])
      expectProblems(withBases(guide({ step: null, goal: 'glow' })), [problem('guides', SIXTH, 'step', 'REQUIRED')])
    })
  })

  describe('goal', () => {
    it.each(['clear-skin', 'even-tone', 'fade-dark-marks', 'brighter', 'glow', 'calm-repair'])('accepts %s, a goal a person can pick', (goal) => {
      expectValid(withBases(guide({ step: 'treat', goal })))
    })

    it('is optional: a row with no goal is the step\'s base row', () => {
      expect(parsed(withBases()).guides.every((row) => row.goal === null)).toBe(true)
    })

    it('refuses a value that is not one of the goals, in the case it is written in', () => {
      expectProblems(withBases(guide({ step: 'treat', goal: 'lighter-skin' })), [problem('guides', SIXTH, 'goal', 'NOT_IN_VOCABULARY')])
      expectProblems(withBases(guide({ step: 'treat', goal: 'Glow' })), [problem('guides', SIXTH, 'goal', 'NOT_IN_VOCABULARY')])
    })
  })

  describe('what_it_does, look_for and for_deeper_skin', () => {
    const TEXTS = ['what_it_does', 'look_for', 'for_deeper_skin'] as const
    const override = (over: Raw) => withBases(guide({ step: 'treat', goal: 'glow', ...over }))

    it.each(TEXTS)('holds up to 300 characters in %s, and no more', (column) => {
      expectValid(override({ [column]: text(300) }))
      expectProblems(override({ [column]: text(301) }), [problem('guides', SIXTH, column, 'TOO_LONG')])
    })

    it.each(TEXTS)('requires %s', (column) => {
      expectProblems(override({ [column]: null }), [problem('guides', SIXTH, column, 'REQUIRED')])
      expectProblems(override({ [column]: '   ' }), [problem('guides', SIXTH, column, 'REQUIRED')])
    })

    it.each(TEXTS)('is plain words in %s: no link and no markup', (column) => {
      expectProblems(override({ [column]: 'Read more at https://example.com/sunscreen' }), [problem('guides', SIXTH, column, 'HAS_LINK_OR_MARKUP')])
      expectProblems(override({ [column]: 'A <b>gentle</b> wash.' }), [problem('guides', SIXTH, column, 'HAS_LINK_OR_MARKUP')])
    })

    it('reports a cell that is too long for its length only, even when it also holds a link', () => {
      expectProblems(override({ look_for: `https://example.com ${text(300)}` }), [problem('guides', SIXTH, 'look_for', 'TOO_LONG')])
    })
  })

  describe('look_for_when_pregnant', () => {
    const override = (over: Raw) => withBases(guide({ step: 'treat', goal: 'glow', ...over }))

    it('is optional: empty reads as null, and a row with it keeps it', () => {
      expectValid(override({ look_for_when_pregnant: null }))
      expect(parsed(override({ look_for_when_pregnant: '  ' })).guides[4]!.lookForWhenPregnant).toBeNull()
      expect(parsed(override({ look_for_when_pregnant: 'Azelaic acid only.' })).guides[4]!.lookForWhenPregnant).toBe('Azelaic acid only.')
    })

    it('holds up to 300 characters, and no more', () => {
      expectValid(override({ look_for_when_pregnant: text(300) }))
      expectProblems(override({ look_for_when_pregnant: text(301) }), [problem('guides', SIXTH, 'look_for_when_pregnant', 'TOO_LONG')])
    })

    it('is plain words: no link and no markup', () => {
      expectProblems(override({ look_for_when_pregnant: 'See https://example.com' }), [problem('guides', SIXTH, 'look_for_when_pregnant', 'HAS_LINK_OR_MARKUP')])
      expectProblems(override({ look_for_when_pregnant: 'Use <i>azelaic acid</i>.' }), [problem('guides', SIXTH, 'look_for_when_pregnant', 'HAS_LINK_OR_MARKUP')])
    })
  })

  describe('the routine wording gate', () => {
    const TEXT_COLUMNS = ['what_it_does', 'look_for', 'for_deeper_skin', 'look_for_when_pregnant'] as const
    const override = (over: Raw) => withBases(guide({ step: 'treat', goal: 'glow', ...over }))

    it.each(TEXT_COLUMNS)('refuses a promise of lighter skin in %s, on that cell: GUIDE_WORDING', (column) => {
      expectProblems(override({ [column]: 'Helps you get lighter skin in weeks.' }), [problem('guides', SIXTH, column, 'GUIDE_WORDING')])
    })

    it.each(TEXT_COLUMNS)('refuses the name of a condition in %s', (column) => {
      expectProblems(override({ [column]: 'Good for melasma.' }), [problem('guides', SIXTH, column, 'GUIDE_WORDING')])
    })

    it.each([
      ['whiter', 'Makes your face look whiter.'],
      ['you have a condition', 'If you have an infection, use this.'],
      ['a diagnosis', 'This will diagnose the cause.'],
    ])('refuses %s: the wording gate is the routine\'s own, not a shorter list', (_name, cell) => {
      expectProblems(override({ look_for: cell }), [problem('guides', SIXTH, 'look_for', 'GUIDE_WORDING')])
    })

    it('reports a cell once however many forbidden words it holds, and each bad cell of a row on its own', () => {
      expectProblems(override({ what_it_does: 'Lighter skin, fairer and whiter.', look_for: 'For melasma.' }), [
        problem('guides', SIXTH, 'what_it_does', 'GUIDE_WORDING'),
        problem('guides', SIXTH, 'look_for', 'GUIDE_WORDING'),
      ])
    })

    it('also checks a base row, which every person without a goal row is shown', () => {
      expectProblems(inGuides(guide({ step: 'cleanse', for_deeper_skin: 'Wash for lighter skin.' }), ...baseGuides().slice(1)), [problem('guides', 2, 'for_deeper_skin', 'GUIDE_WORDING')])
    })

    it.each([
      ['a lighter product', 'Choose a lighter face cream in the heat.'],
      ['advice with "you have"', 'Use what you have until it runs out.'],
      ['a white film', 'Look for a finish that leaves no grey or white film on deeper skin.'],
      ['a goal', 'Brighter, more even skin takes patience.'],
    ])('lets %s through', (_name, cell) => {
      expectValid(override({ what_it_does: cell, look_for: cell, for_deeper_skin: cell, look_for_when_pregnant: cell }))
    })

    it('says a cell that is too long is too long and nothing else', () => {
      expectProblems(override({ what_it_does: `lighter skin ${text(300)}` }), [problem('guides', SIXTH, 'what_it_does', 'TOO_LONG')])
    })
  })

  describe('a base row for every step', () => {
    const MISSING = [problem('guides', 1, 'step', 'GUIDE_BASE_MISSING')]

    it.each(['cleanse', 'treat', 'moisturise', 'protect'])('is refused when %s has none: GUIDE_BASE_MISSING on the header row', (step) => {
      expectProblems(inGuides(...baseGuides().filter((row) => row.step !== step)), MISSING)
    })

    it('is told once however many steps have none, an empty tab included', () => {
      expectProblems(inGuides(), MISSING)
      expectProblems(inGuides(baseGuides()[0]!), MISSING)
    })

    it.each([
      ['a draft', { status: 'draft', approved_by: null, approved_on: null }],
      ['a retired row', { status: 'retired', approved_by: null, approved_on: null }],
    ])('does not count %s as the base row', (_name, over) => {
      expectProblems(inGuides(...baseGuides().map((row) => (row.step === 'protect' ? { ...row, ...over } : row))), MISSING)
    })

    it('is not met by a row for a goal: a step with only goal rows has no base row', () => {
      expectProblems(inGuides(...baseGuides().map((row) => (row.step === 'treat' ? { ...row, goal: 'glow' } : row))), MISSING)
    })

    it('is met by one approved row with no goal, whatever else the step has: goal rows, drafts and retired goal rows', () => {
      expectValid(
        withBases(
          guide({ step: 'treat', goal: 'glow' }),
          guide({ step: 'treat', goal: 'even-tone', status: 'draft', approved_by: null, approved_on: null }),
          guide({ step: 'treat', goal: 'brighter', status: 'retired', approved_by: null, approved_on: null }),
        ),
      )
    })

    it('is checked for a workbook that has other problems too, and adds nothing to them', () => {
      expectProblems(
        workbook({ products: [product({ category: 'face' })], availability: [], ingredients: [], countries: [], guides: baseGuides().slice(1) }),
        [problem('products', 2, 'category', 'NOT_IN_VOCABULARY'), ...MISSING],
      )
    })
  })

  describe('one row for each step and goal', () => {
    const base = guide({ step: 'treat', goal: null })
    const duplicate = (problems: number[]) => problems.map((row) => problem('guides', row, 'step', 'GUIDE_DUPLICATE'))

    it('refuses two base rows for one step: both are reported, in step', () => {
      expectProblems(withBases(guide({ step: 'treat', look_for: 'Something else.' })), duplicate([3, SIXTH]))
    })

    it('refuses two rows for one step and goal: both are reported', () => {
      expectProblems(withBases(guide({ step: 'treat', goal: 'glow' }), guide({ step: 'treat', goal: 'glow', look_for: 'Something else.' })), duplicate([SIXTH, 7]))
    })

    it('reports every row of a clash of three', () => {
      expectProblems(withBases(base, base, base), duplicate([3, SIXTH, 7, 8]))
    })

    it('lets one step have a row for each goal, and one goal have a row for each step', () => {
      expectValid(withBases(guide({ step: 'treat', goal: 'glow' }), guide({ step: 'treat', goal: 'even-tone' }), guide({ step: 'protect', goal: 'glow' })))
    })

    it('counts a retired row too: the row keeps its place, and two rows cannot share it', () => {
      expectProblems(withBases(guide({ step: 'cleanse', status: 'retired', approved_by: null, approved_on: null })), duplicate([2, SIXTH]))
    })

    it('counts a draft too', () => {
      expectProblems(withBases(guide({ step: 'treat', goal: 'glow' }), guide({ step: 'treat', goal: 'glow', status: 'draft', approved_by: null, approved_on: null })), duplicate([SIXTH, 7]))
    })

    it('reads the steps and goals as they are written once trimmed', () => {
      expectProblems(withBases(guide({ step: ' treat ', goal: null })), duplicate([3, SIXTH]))
    })
  })

  describe('status, approval and audit', () => {
    const override = (over: Raw) => withBases(guide({ step: 'treat', goal: 'glow', ...over }))

    it('takes draft, approved and retired for a row, and nothing else', () => {
      for (const status of ['draft', 'approved', 'retired']) expectValid(override({ status, ...(status === 'approved' ? {} : { approved_by: null, approved_on: null }) }))
      expectProblems(override({ status: 'live' }), [problem('guides', SIXTH, 'status', 'NOT_IN_VOCABULARY')])
      expectProblems(override({ status: null }), [problem('guides', SIXTH, 'status', 'REQUIRED')])
    })

    it('needs an approver and a day once the row is approved', () => {
      expectProblems(override({ approved_by: null, approved_on: null }), [problem('guides', SIXTH, 'approved_by', 'REQUIRED_WHEN_APPROVED'), problem('guides', SIXTH, 'approved_on', 'REQUIRED_WHEN_APPROVED')])
    })

    it('reads the approval day as a real calendar day', () => {
      expectProblems(override({ approved_on: '2030-02-30' }), [problem('guides', SIXTH, 'approved_on', 'BAD_DATE')])
    })

    it('wants both halves of an audit, or neither', () => {
      expectProblems(override({ audited_by: 'Nneka Audit' }), [problem('guides', SIXTH, 'audited_on', 'AUDIT_INCOMPLETE')])
      expectProblems(override({ audited_on: AUDITED_ON }), [problem('guides', SIXTH, 'audited_by', 'AUDIT_INCOMPLETE')])
    })

    it('keeps a retired row whole, so what a past routine said stays on record', () => {
      const [, , , , row] = parsed(override({ status: 'retired', look_for_when_pregnant: 'Azelaic acid only.' })).guides

      expect(row).toMatchObject({ status: 'retired', goal: 'glow', lookFor: guide().look_for, lookForWhenPregnant: 'Azelaic acid only.' })
    })
  })
})

// --- the contract bump to 2.3.0: the Reintroductions, Escalations, Responses and Weeks tabs ---------------------------------------------------------
// Where a problem is reported, where the spec leaves it open (pinned here), all as for the Guides tab:
//   - none of the four has a code column, so none has DUPLICATE_CODE: a row is its key (a group, a reason, an outcome, or a band with goal and step-down);
//   - a rule that a tab lacks a row it needs (REINTRO_DEFAULT_MISSING, ESCALATION_MISSING, RESPONSE_MISSING, WEEK_BASE_MISSING) has no row to point at, so it is on
//     the header row, in the key column, once however much is missing. A draft or retired row does not count. A tab whose key header is missing says only that;
//   - a duplicate (REINTRO_DUPLICATE, ESCALATION_DUPLICATE, RESPONSE_DUPLICATE, WEEK_DUPLICATE) is every row that shares its key with another, in the key column
//     (`band` for Weeks), whatever the statuses: a retired or draft row keeps its key. So a reason or an outcome can only ever have its one approved row, and a row
//     for one that is draft or retired leaves it without an approved one;
//   - ESCALATION_WORDING, RESPONSE_WORDING and WEEK_WORDING: the text cell that holds a forbidden word, one problem for the cell however many words it holds. A cell
//     that is too long is reported for its length only. Reintroductions has no text cell, so it has no wording rule;
//   - REINTRO_GROUP_NEVER_BACK: the `group` cell of the row, whatever the row's status.

describe('validateWorkbook: Reintroductions', () => {
  const withDefault = (...more: Raw[]): RawWorkbook => alone('reintroductions', [reintroduction(), ...more])
  const scheduled = (schedule: string | null): RawWorkbook => alone('reintroductions', [reintroduction({ schedule })])
  const scheduleProblem = (rule: string) => [problem('reintroductions', 2, 'schedule', rule)]
  const THIRD = 3

  it('reads a ladder into its group, the steps of its schedule, status and sign-off', () => {
    const rows = parsed(withDefault(reintroduction({ group: 'retinoid', schedule: '1-2: as-needed; 3: weekly; 4-5: alternate-days; 6: am; 7: am-pm; 8: back', audited_by: 'Nneka Audit', audited_on: AUDITED_ON }))).reintroductions

    expect(rows[0]).toEqual({
      group: null,
      schedule: [
        { fromWeek: 1, toWeek: 1, frequency: 'weekly' },
        { fromWeek: 2, toWeek: 2, frequency: 'alternate-days' },
        { fromWeek: 3, toWeek: 3, frequency: 'back' },
      ],
      status: 'approved',
      approvedBy: 'Dr A. Reviewer',
      approvedOn: utcMidnight(APPROVED_ON),
      auditedBy: null,
      auditedOn: null,
    })
    expect(rows[1]).toEqual({
      group: 'retinoid',
      schedule: [
        { fromWeek: 1, toWeek: 2, frequency: 'as-needed' },
        { fromWeek: 3, toWeek: 3, frequency: 'weekly' },
        { fromWeek: 4, toWeek: 5, frequency: 'alternate-days' },
        { fromWeek: 6, toWeek: 6, frequency: 'am' },
        { fromWeek: 7, toWeek: 7, frequency: 'am-pm' },
        { fromWeek: 8, toWeek: 8, frequency: 'back' },
      ],
      status: 'approved',
      approvedBy: 'Dr A. Reviewer',
      approvedOn: utcMidnight(APPROVED_ON),
      auditedBy: 'Nneka Audit',
      auditedOn: utcMidnight(AUDITED_ON),
    })
  })

  describe('group', () => {
    it.each(['retinoid', 'exfoliating-acid', 'benzoyl-peroxide'])('accepts %s, a group that can be brought back', (group) => {
      expectValid(withDefault(reintroduction({ group })))
    })

    it('is optional: empty is the default ladder, and reads as null', () => {
      expect(parsed(withDefault()).reintroductions[0]!.group).toBeNull()
      expect(parsed(alone('reintroductions', [reintroduction({ group: '  ' })])).reintroductions[0]!.group).toBeNull()
    })

    it.each(['Retinoid', 'bleach', 'default'])('refuses %s: it is not an ingredient group', (group) => {
      expectProblems(withDefault(reintroduction({ group })), [problem('reintroductions', THIRD, 'group', 'NOT_IN_VOCABULARY')])
    })

    it.each(['mercury', 'steroid', 'lightening-agent'])('refuses %s with REINTRO_GROUP_NEVER_BACK on its group cell: it is only ever stopped, never brought back', (group) => {
      expectProblems(withDefault(reintroduction({ group })), [problem('reintroductions', THIRD, 'group', 'REINTRO_GROUP_NEVER_BACK')])
    })

    it.each(['draft', 'retired'])('refuses a never-back group on a %s row too, since the row would be a ladder for a product that is not brought back', (status) => {
      expectProblems(withDefault(reintroduction({ group: 'steroid', status, approved_by: null, approved_on: null })), [problem('reintroductions', THIRD, 'group', 'REINTRO_GROUP_NEVER_BACK')])
    })
  })

  describe('schedule', () => {
    it('is required', () => {
      expectProblems(scheduled(null), scheduleProblem('REQUIRED'))
    })

    it('is the example of the brief: 1: weekly; 2: alternate-days; 3: back', () => {
      expectValid(scheduled('1: weekly; 2: alternate-days; 3: back'))
    })

    it('accepts the whole ladder, step by step up to back: as-needed, weekly, alternate-days, am or pm, am-pm', () => {
      expectValid(scheduled('1: as-needed; 2: weekly; 3: alternate-days; 4: am; 5: am-pm; 6: back'))
    })

    it('ignores spaces around entries and after the colon', () => {
      expect(parsed(scheduled(' 1-2:weekly ;  3 :  back ')).reintroductions[0]!.schedule).toEqual([
        { fromWeek: 1, toWeek: 2, frequency: 'weekly' },
        { fromWeek: 3, toWeek: 3, frequency: 'back' },
      ])
    })

    it.each(['am-pm', 'am', 'pm', 'alternate-days', 'weekly', 'as-needed'])('accepts %s as a step before back', (frequency) => {
      expectValid(scheduled(`1: ${frequency}; 2: back`))
    })

    it('accepts a frequency that stays the same from one step to the next, and am and pm as the same strength in either order', () => {
      expectValid(scheduled('1: weekly; 2: weekly; 3: back'))
      expectValid(scheduled('1: am; 2: pm; 3: back'))
      expectValid(scheduled('1: pm; 2: am; 3: back'))
    })

    it.each([
      ['text that is no entry', 'bring it back slowly'],
      ['an entry with no weeks', ': weekly; 2: back'],
      ['an entry with no frequency', '1: ; 2: back'],
      ['an entry with no colon', '1 weekly; 2: back'],
      ['a frequency that is not in the list', '1: daily; 2: back'],
      ['a frequency in capitals', '1: Weekly; 2: back'],
      ['back in capitals', '1: weekly; 2: Back'],
      ['stop, which a ladder up never says', '1: weekly; 2: stop'],
      ['stop alone', '1: stop'],
      ['week 0, since weeks start at 1', '0: weekly; 1: back'],
      ['a range written backwards', '3-1: weekly; 4: back'],
      ['a decimal week', '1.5: weekly; 2: back'],
    ])('refuses %s as BAD_SCHEDULE', (_what, schedule) => {
      expectProblems(scheduled(schedule), scheduleProblem('BAD_SCHEDULE'))
    })

    describe('it is at most 12 weeks long, and the weeks run from week 1 with no gap and no overlap', () => {
      it('accepts a ladder that ends in week 12', () => {
        expectValid(scheduled('1-11: weekly; 12: back'))
      })

      it('refuses a ladder that runs into week 13: BAD_SCHEDULE', () => {
        expectProblems(scheduled('1-12: weekly; 13: back'), scheduleProblem('BAD_SCHEDULE'))
      })

      it('refuses a schedule that does not start at week 1', () => {
        expectProblems(scheduled('2: weekly; 3: back'), scheduleProblem('SCHEDULE_NOT_CONTIGUOUS'))
      })

      it('refuses a gap: 1-2, then 4', () => {
        expectProblems(scheduled('1-2: weekly; 4: back'), scheduleProblem('SCHEDULE_NOT_CONTIGUOUS'))
      })

      it('refuses an overlap: 1-3, then 3', () => {
        expectProblems(scheduled('1-3: weekly; 3: back'), scheduleProblem('SCHEDULE_NOT_CONTIGUOUS'))
      })

      it('refuses steps written out of order', () => {
        expect(problemsOf(scheduled('3: back; 1-2: weekly'))).toContainEqual(problem('reintroductions', 2, 'schedule', 'SCHEDULE_NOT_CONTIGUOUS'))
      })
    })

    describe('it ends with back, and back is only the last step', () => {
      it('refuses a schedule whose last step is not back: REINTRO_MISSING_BACK', () => {
        expectProblems(scheduled('1-2: weekly; 3-4: alternate-days'), scheduleProblem('REINTRO_MISSING_BACK'))
        expectProblems(scheduled('1: weekly'), scheduleProblem('REINTRO_MISSING_BACK'))
      })

      it('refuses a back that is followed by another step: REINTRO_BACK_NOT_LAST, and nothing about the step that follows', () => {
        expectProblems(scheduled('1: weekly; 2: back; 3: am'), scheduleProblem('REINTRO_BACK_NOT_LAST'))
        expectProblems(scheduled('1: weekly; 2: back; 3: back'), scheduleProblem('REINTRO_BACK_NOT_LAST'))
      })
    })

    describe('there is at least one step before back, so nothing is brought back at full strength at once', () => {
      it.each([
        ['back alone', '1: back'],
        ['back for the whole ladder', '1-12: back'],
        ['back for several weeks and nothing before it', '1-4: back'],
      ])('refuses %s: REINTRO_BACK_ONLY', (_what, schedule) => {
        expectProblems(scheduled(schedule), scheduleProblem('REINTRO_BACK_ONLY'))
      })

      it('accepts a single step before back', () => {
        expectValid(scheduled('1: as-needed; 2: back'))
      })

      it('says a ladder that opens with back and goes on has that fault and that the back is not last, each once', () => {
        expectProblems(scheduled('1: back; 2: weekly'), [problem('reintroductions', 2, 'schedule', 'REINTRO_BACK_ONLY'), problem('reintroductions', 2, 'schedule', 'REINTRO_BACK_NOT_LAST')])
      })

      it('does not raise it for a ladder that does not start at week 1 but has a step first', () => {
        expectProblems(scheduled('2: weekly; 3: back'), scheduleProblem('SCHEDULE_NOT_CONTIGUOUS'))
      })

      it('is not a rule of a Tapers schedule: a taper may stop at once', () => {
        expectValid(inTapers(taper({ schedule: '1: stop' })))
      })
    })

    describe('the frequency never goes down: as-needed, then weekly, then alternate-days, then am or pm, then am-pm, then back', () => {
      it.each([
        ['alternate-days then weekly', '1: alternate-days; 2: weekly; 3: back'],
        ['am-pm then am', '1: am-pm; 2: am; 3: back'],
        ['am then alternate-days', '1: am; 2: alternate-days; 3: back'],
        ['weekly then as-needed', '1: weekly; 2: as-needed; 3: back'],
        ['one step up then down', '1: weekly; 2: am-pm; 3: alternate-days; 4: back'],
      ])('refuses %s: REINTRO_FREQUENCY_DECREASES', (_what, schedule) => {
        expectProblems(scheduled(schedule), scheduleProblem('REINTRO_FREQUENCY_DECREASES'))
      })
    })
  })

  describe('a default ladder', () => {
    const MISSING = [problem('reintroductions', 1, 'group', 'REINTRO_DEFAULT_MISSING')]

    it('is required: an approved row with no group, reported once on the header row', () => {
      expectProblems(alone('reintroductions', []), MISSING)
    })

    it('is not met by a row for a group: a tab of group ladders alone has no default', () => {
      expectProblems(alone('reintroductions', [reintroduction({ group: 'retinoid' }), reintroduction({ group: 'exfoliating-acid' })]), MISSING)
    })

    it.each([
      ['a draft', { status: 'draft', approved_by: null, approved_on: null }],
      ['a retired row', { status: 'retired', approved_by: null, approved_on: null }],
    ])('does not count %s as the default', (_name, over) => {
      expectProblems(alone('reintroductions', [reintroduction(over)]), MISSING)
    })

    it('is met by one approved default, whatever else the tab has: group ladders, drafts and retired ones', () => {
      expectValid(
        withDefault(
          reintroduction({ group: 'retinoid' }),
          reintroduction({ group: 'exfoliating-acid', status: 'draft', approved_by: null, approved_on: null }),
          reintroduction({ group: 'benzoyl-peroxide', status: 'retired', approved_by: null, approved_on: null }),
        ),
      )
    })

    it('is checked for a workbook that has other problems too, and adds nothing to them', () => {
      expectProblems(workbook({ products: [product({ category: 'face' })], availability: [], ingredients: [], countries: [], reintroductions: [] }), [problem('products', 2, 'category', 'NOT_IN_VOCABULARY'), ...MISSING])
    })
  })

  describe('one ladder for each group', () => {
    const duplicate = (rows: number[]) => rows.map((row) => problem('reintroductions', row, 'group', 'REINTRO_DUPLICATE'))
    const other = '1: weekly; 2: back'

    it('refuses two ladders for one group: both are reported, in group', () => {
      expectProblems(withDefault(reintroduction({ group: 'retinoid' }), reintroduction({ group: 'retinoid', schedule: other })), duplicate([THIRD, 4]))
    })

    it('refuses two default ladders: both are reported, and the default is not also missing', () => {
      expectProblems(withDefault(reintroduction({ schedule: other })), duplicate([2, THIRD]))
    })

    it('counts a retired or a draft row too: the row keeps its group', () => {
      expectProblems(withDefault(reintroduction({ group: 'retinoid' }), reintroduction({ group: 'retinoid', status: 'retired', approved_by: null, approved_on: null })), duplicate([THIRD, 4]))
      expectProblems(withDefault(reintroduction({ status: 'draft', approved_by: null, approved_on: null })), duplicate([2, THIRD]))
    })

    it('lets each group have its own ladder', () => {
      expectValid(withDefault(reintroduction({ group: 'retinoid' }), reintroduction({ group: 'exfoliating-acid' }), reintroduction({ group: 'benzoyl-peroxide' })))
    })
  })

  describe('status, approval and audit', () => {
    const extra = (over: Raw) => withDefault(reintroduction({ group: 'retinoid', ...over }))

    it('takes draft, approved and retired for a row, and nothing else', () => {
      for (const status of ['draft', 'approved', 'retired']) expectValid(extra({ status, ...(status === 'approved' ? {} : { approved_by: null, approved_on: null }) }))
      expectProblems(extra({ status: 'live' }), [problem('reintroductions', THIRD, 'status', 'NOT_IN_VOCABULARY')])
      expectProblems(extra({ status: null }), [problem('reintroductions', THIRD, 'status', 'REQUIRED')])
    })

    it('needs an approver and a day once the row is approved', () => {
      expectProblems(extra({ approved_by: null, approved_on: null }), [problem('reintroductions', THIRD, 'approved_by', 'REQUIRED_WHEN_APPROVED'), problem('reintroductions', THIRD, 'approved_on', 'REQUIRED_WHEN_APPROVED')])
    })

    it('reads the approval day as a real calendar day', () => {
      expectProblems(extra({ approved_on: '2030-02-30' }), [problem('reintroductions', THIRD, 'approved_on', 'BAD_DATE')])
    })

    it('wants both halves of an audit, or neither', () => {
      expectProblems(extra({ audited_by: 'Nneka Audit' }), [problem('reintroductions', THIRD, 'audited_on', 'AUDIT_INCOMPLETE')])
      expectProblems(extra({ audited_on: AUDITED_ON }), [problem('reintroductions', THIRD, 'audited_by', 'AUDIT_INCOMPLETE')])
    })

    it('keeps a retired ladder whole, schedule and all, so a past routine can still say which ladder it used', () => {
      const row = parsed(extra({ status: 'retired' })).reintroductions[1]

      expect(row).toMatchObject({ status: 'retired', group: 'retinoid', schedule: [expect.anything(), expect.anything(), expect.anything()] })
    })
  })
})

describe('validateWorkbook: Escalations', () => {
  const TEXTS = ['who_to_see', 'how_soon', 'what_to_tell_them'] as const
  /** The reason rows with the first one changed: it is spreadsheet row 2, and every reason still has its row. */
  const first = (over: Raw): RawWorkbook => alone('escalations', [escalation(over), ...baseEscalations().slice(1)])
  /** The reason rows and then these: the one a test is about is spreadsheet row 10. */
  const withReasons = (...more: Raw[]): RawWorkbook => alone('escalations', [...baseEscalations(), ...more])
  /** The rows after the base rows: one for each reason, in rows 2 to 9, so the next is row 10. */
  const EXTRA = REASONS.length + 2
  const MISSING = [problem('escalations', 1, 'reason', 'ESCALATION_MISSING')]

  it('reads an escalation into its reason, the three plain-text cells, status and sign-off', () => {
    const rows = parsed(first({ who_to_see: 'A dermatologist.', how_soon: 'Within two days.', what_to_tell_them: 'The products you used, and when it started.', audited_by: 'Nneka Audit', audited_on: AUDITED_ON })).escalations

    expect(rows[0]).toEqual({
      reason: 'pus-or-hot-patch',
      whoToSee: 'A dermatologist.',
      howSoon: 'Within two days.',
      whatToTellThem: 'The products you used, and when it started.',
      status: 'approved',
      approvedBy: 'Dr A. Reviewer',
      approvedOn: utcMidnight(APPROVED_ON),
      auditedBy: 'Nneka Audit',
      auditedOn: utcMidnight(AUDITED_ON),
    })
    expect(rows.map((row) => row.reason)).toEqual([...REASONS])
  })

  describe('reason', () => {
    it.each(['fever', 'Swelling', 'pus or hot patch', 'near eyes'])('refuses %s: it is not one of the reasons', (reason) => {
      expectProblems(withReasons(escalation({ reason })), [problem('escalations', EXTRA, 'reason', 'NOT_IN_VOCABULARY')])
    })

    it('is required', () => {
      expectProblems(withReasons(escalation({ reason: null })), [problem('escalations', EXTRA, 'reason', 'REQUIRED')])
    })
  })

  // about-a-product (contract 2.4.0): the reviewed text for "Talk to a professional" about a shelf product. It is a reason like the others: a workbook needs its approved row.
  describe('the about-a-product reason', () => {
    const aboutAProduct = (over: Raw = {}): Raw => escalation({ reason: 'about-a-product', who_to_see: 'A pharmacist or a dermatologist.', how_soon: 'Before you use it again.', what_to_tell_them: 'The product, what is in it, and what you noticed.', ...over })
    const others = () => baseEscalations().filter((row) => row.reason !== 'about-a-product')

    it('is the last reason, after the seven of the daily loop, and its approved row is read as an escalation of that reason', () => {
      expect(REASONS.at(-1)).toBe('about-a-product')
      expect(parsed(alone('escalations', [...others(), aboutAProduct()])).escalations.map((row) => row.reason)).toEqual([...REASONS])
    })

    it('is refused when the tab has every other reason but not an approved row for this one: ESCALATION_MISSING', () => {
      expectProblems(alone('escalations', others()), [problem('escalations', 1, 'reason', 'ESCALATION_MISSING')])
      expectProblems(alone('escalations', [...others(), aboutAProduct({ status: 'draft', approved_by: null, approved_on: null })]), [problem('escalations', 1, 'reason', 'ESCALATION_MISSING')])
    })

    it('names the reason in the ESCALATION_MISSING text, so the person fixing the workbook is told which row to write', () => {
      expect(CONTRACT.rules.ESCALATION_MISSING).toContain('about-a-product')
    })

    it('goes through the wording gate like every escalation, on the cell that holds the forbidden word', () => {
      expectProblems(alone('escalations', [...others(), aboutAProduct({ how_soon: 'Helps you get lighter skin in weeks.' })]), [problem('escalations', 9, 'how_soon', 'ESCALATION_WORDING')])
    })

    it('has one row only: two rows for the reason are both reported', () => {
      expectProblems(alone('escalations', [...others(), aboutAProduct(), aboutAProduct({ how_soon: 'Today.' })]), [
        problem('escalations', 9, 'reason', 'ESCALATION_DUPLICATE'),
        problem('escalations', 10, 'reason', 'ESCALATION_DUPLICATE'),
      ])
    })
  })

  describe('who_to_see, how_soon and what_to_tell_them', () => {
    it.each(TEXTS)('holds up to 300 characters in %s, and no more', (column) => {
      expectValid(first({ [column]: text(300) }))
      expectProblems(first({ [column]: text(301) }), [problem('escalations', 2, column, 'TOO_LONG')])
    })

    it.each(TEXTS)('requires %s', (column) => {
      expectProblems(first({ [column]: null }), [problem('escalations', 2, column, 'REQUIRED')])
      expectProblems(first({ [column]: '   ' }), [problem('escalations', 2, column, 'REQUIRED')])
    })

    it.each(TEXTS)('is plain words in %s: no link and no markup', (column) => {
      expectProblems(first({ [column]: 'Read more at https://example.com/pharmacist' }), [problem('escalations', 2, column, 'HAS_LINK_OR_MARKUP')])
      expectProblems(first({ [column]: 'A <b>doctor</b> today.' }), [problem('escalations', 2, column, 'HAS_LINK_OR_MARKUP')])
    })

    it('reports a cell that is too long for its length only, even when it also holds a link', () => {
      expectProblems(first({ who_to_see: `https://example.com ${text(300)}` }), [problem('escalations', 2, 'who_to_see', 'TOO_LONG')])
    })
  })

  describe('the routine wording gate', () => {
    it.each(TEXTS)('refuses a promise of lighter skin in %s, on that cell: ESCALATION_WORDING', (column) => {
      expectProblems(first({ [column]: 'Helps you get lighter skin in weeks.' }), [problem('escalations', 2, column, 'ESCALATION_WORDING')])
    })

    it.each(TEXTS)('refuses the name of a condition in %s', (column) => {
      expectProblems(first({ [column]: 'This may be eczema.' }), [problem('escalations', 2, column, 'ESCALATION_WORDING')])
    })

    it('refuses a diagnosis: the app names a pattern with honest uncertainty and never says "you have"', () => {
      expectProblems(first({ what_to_tell_them: 'Say that you have an infection.' }), [problem('escalations', 2, 'what_to_tell_them', 'ESCALATION_WORDING')])
    })

    it('reports a cell once however many forbidden words it holds, and each bad cell of a row on its own', () => {
      expectProblems(first({ who_to_see: 'Lighter skin, fairer and whiter.', how_soon: 'For melasma.' }), [
        problem('escalations', 2, 'who_to_see', 'ESCALATION_WORDING'),
        problem('escalations', 2, 'how_soon', 'ESCALATION_WORDING'),
      ])
    })

    it('lets the words an escalation needs through: infection on its own, swelling, pus and a pharmacist', () => {
      expectValid(first({ who_to_see: 'A pharmacist or a doctor.', how_soon: 'Today.', what_to_tell_them: 'If you see signs of infection, swelling or pus, say so.' }))
    })

    it('says a cell that is too long is too long and nothing else', () => {
      expectProblems(first({ how_soon: `lighter skin ${text(300)}` }), [problem('escalations', 2, 'how_soon', 'TOO_LONG')])
    })
  })

  describe('a row for every reason', () => {
    it.each(REASONS)('is refused when %s has none: ESCALATION_MISSING on the header row', (reason) => {
      expectProblems(alone('escalations', baseEscalations().filter((row) => row.reason !== reason)), MISSING)
    })

    it('is told once however many reasons have none, an empty tab included', () => {
      expectProblems(alone('escalations', []), MISSING)
      expectProblems(alone('escalations', baseEscalations().slice(0, 2)), MISSING)
    })

    it.each([
      ['a draft', { status: 'draft', approved_by: null, approved_on: null }],
      ['a retired row', { status: 'retired', approved_by: null, approved_on: null }],
    ])('does not count %s as the row of its reason', (_name, over) => {
      expectProblems(alone('escalations', baseEscalations().map((row) => (row.reason === 'near-eyes' ? { ...row, ...over } : row))), MISSING)
    })

    it('is checked for a workbook that has other problems too, and adds nothing to them', () => {
      expectProblems(workbook({ products: [product({ category: 'face' })], availability: [], ingredients: [], countries: [], escalations: baseEscalations().slice(1) }), [problem('products', 2, 'category', 'NOT_IN_VOCABULARY'), ...MISSING])
    })
  })

  describe('one row for each reason', () => {
    const duplicate = (rows: number[]) => rows.map((row) => problem('escalations', row, 'reason', 'ESCALATION_DUPLICATE'))

    it('refuses two rows for one reason: both are reported, in reason', () => {
      expectProblems(withReasons(escalation({ reason: 'swelling', how_soon: 'Something else.' })), duplicate([3, EXTRA]))
    })

    it('reports every row of a clash of three', () => {
      expectProblems(withReasons(escalation({ reason: 'swelling' }), escalation({ reason: 'swelling' })), duplicate([3, EXTRA, EXTRA + 1]))
    })

    it('counts a draft or a retired row too: the row keeps its reason', () => {
      expectProblems(withReasons(escalation({ reason: 'swelling', status: 'draft', approved_by: null, approved_on: null })), duplicate([3, EXTRA]))
      expectProblems(withReasons(escalation({ reason: 'swelling', status: 'retired', approved_by: null, approved_on: null })), duplicate([3, EXTRA]))
    })

    it('reads the reason as it is written once trimmed', () => {
      expectProblems(withReasons(escalation({ reason: ' swelling ' })), duplicate([3, EXTRA]))
    })
  })

  describe('status, approval and audit', () => {
    it('takes draft, approved and retired for a row, and nothing else, though a reason with no approved row is missing one', () => {
      expect(problemsOf(first({ status: 'live' }))).toContainEqual(problem('escalations', 2, 'status', 'NOT_IN_VOCABULARY'))
      expect(problemsOf(first({ status: null }))).toContainEqual(problem('escalations', 2, 'status', 'REQUIRED'))
      expectProblems(first({ status: 'draft', approved_by: null, approved_on: null }), MISSING)
    })

    it('needs an approver and a day once the row is approved', () => {
      expectProblems(first({ approved_by: null, approved_on: null }), [problem('escalations', 2, 'approved_by', 'REQUIRED_WHEN_APPROVED'), problem('escalations', 2, 'approved_on', 'REQUIRED_WHEN_APPROVED')])
    })

    it('reads the approval day as a real calendar day', () => {
      expectProblems(first({ approved_on: '2030-02-30' }), [problem('escalations', 2, 'approved_on', 'BAD_DATE')])
    })

    it('wants both halves of an audit, or neither', () => {
      expectProblems(first({ audited_by: 'Nneka Audit' }), [problem('escalations', 2, 'audited_on', 'AUDIT_INCOMPLETE')])
      expectProblems(first({ audited_on: AUDITED_ON }), [problem('escalations', 2, 'audited_by', 'AUDIT_INCOMPLETE')])
    })
  })
})

describe('validateWorkbook: Responses', () => {
  const TEXTS = ['title', 'body', 'what_to_do_now'] as const
  /** The outcome rows with the first one changed: it is spreadsheet row 2, and every outcome still has its row. */
  const first = (over: Raw): RawWorkbook => alone('responses', [response(over), ...baseResponses().slice(1)])
  const withOutcomes = (...more: Raw[]): RawWorkbook => alone('responses', [...baseResponses(), ...more])
  const ELEVENTH = 11
  const MISSING = [problem('responses', 1, 'outcome', 'RESPONSE_MISSING')]

  it('reads a response into its outcome, title, body, what to do now, status and sign-off', () => {
    const rows = parsed(first({ title: 'We paused it', body: 'A rest for your {step}.', what_to_do_now: 'Skip anything that stings.', audited_by: 'Nneka Audit', audited_on: AUDITED_ON })).responses

    expect(rows[0]).toEqual({
      outcome: 'paused',
      title: 'We paused it',
      body: 'A rest for your {step}.',
      whatToDoNow: 'Skip anything that stings.',
      status: 'approved',
      approvedBy: 'Dr A. Reviewer',
      approvedOn: utcMidnight(APPROVED_ON),
      auditedBy: 'Nneka Audit',
      auditedOn: utcMidnight(AUDITED_ON),
    })
    expect(rows.map((row) => row.outcome)).toEqual([...OUTCOMES])
  })

  describe('outcome', () => {
    it.each(['sore', 'Paused', 'check calmer', 'advice'])('refuses %s: it is not one of the outcomes', (outcome) => {
      expectProblems(withOutcomes(response({ outcome })), [problem('responses', ELEVENTH, 'outcome', 'NOT_IN_VOCABULARY')])
    })

    it('is required', () => {
      expectProblems(withOutcomes(response({ outcome: null })), [problem('responses', ELEVENTH, 'outcome', 'REQUIRED')])
    })
  })

  describe('title, body and what_to_do_now', () => {
    it('holds up to 120 characters in title, and no more', () => {
      expectValid(first({ title: text(120) }))
      expectProblems(first({ title: text(121) }), [problem('responses', 2, 'title', 'TOO_LONG')])
    })

    it.each(['body', 'what_to_do_now'])('holds up to 300 characters in %s, and no more', (column) => {
      expectValid(first({ [column]: text(300) }))
      expectProblems(first({ [column]: text(301) }), [problem('responses', 2, column, 'TOO_LONG')])
    })

    it.each(['title', 'body'])('requires %s', (column) => {
      expectProblems(first({ [column]: null }), [problem('responses', 2, column, 'REQUIRED')])
      expectProblems(first({ [column]: '   ' }), [problem('responses', 2, column, 'REQUIRED')])
    })

    it('does not require what_to_do_now: empty reads as null', () => {
      expectValid(first({ what_to_do_now: null }))
      expect(parsed(first({ what_to_do_now: '  ' })).responses[0]!.whatToDoNow).toBeNull()
    })

    it.each(TEXTS)('is plain words in %s: no link and no markup', (column) => {
      expectProblems(first({ [column]: 'Read more at https://example.com/pause' }), [problem('responses', 2, column, 'HAS_LINK_OR_MARKUP')])
      expectProblems(first({ [column]: 'Keep it <b>gentle</b>.' }), [problem('responses', 2, column, 'HAS_LINK_OR_MARKUP')])
    })

    it('reports a cell that is too long for its length only, even when it also holds a link', () => {
      expectProblems(first({ body: `https://example.com ${text(300)}` }), [problem('responses', 2, 'body', 'TOO_LONG')])
    })
  })

  describe('the placeholder {step}', () => {
    it.each(TEXTS)('is allowed in %s, once or more than once', (column) => {
      expectValid(first({ [column]: 'Rest your {step}, and ask how the {step} feels in three days.' }))
    })

    it.each(TEXTS)('refuses any other placeholder in %s, on that cell: RESPONSE_PLACEHOLDER', (column) => {
      expectProblems(first({ [column]: 'Rest your {product} for now.' }), [problem('responses', 2, column, 'RESPONSE_PLACEHOLDER')])
    })

    it.each([
      ['another name', 'Rest your {product}.'],
      ['a capital', 'Rest your {Step}.'],
      ['spaces inside', 'Rest your { step }.'],
      ['a name with a dot', 'Rest your {step.name}.'],
      ['a number', 'Rest your {0}.'],
      ['nothing inside', 'Rest your {}.'],
      ['{step} next to another one', 'Rest your {step} and {name}.'],
      ['an opening brace with no end', 'Rest your {step.'],
      ['a closing brace with no start', 'Rest your step}.'],
      ['a doubled closing brace', 'Rest your {step}}.'],
      ['a doubled opening brace', 'Rest your {{step}.'],
      ['a lone opening brace', 'Rest your { now.'],
      ['a lone closing brace', 'Rest your } now.'],
      ['{step} in capitals', 'Rest your {STEP}.'],
      ['a brace beside a good {step}', 'Rest your {step} and {x'],
    ])('refuses %s', (_what, body) => {
      expectProblems(first({ body }), [problem('responses', 2, 'body', 'RESPONSE_PLACEHOLDER')])
    })

    it.each(TEXTS)('refuses a brace that is not an exact {step} in %s, on that cell', (column) => {
      expectProblems(first({ [column]: 'Rest your {step', }), [problem('responses', 2, column, 'RESPONSE_PLACEHOLDER')])
    })

    it('says a cell that is too long is too long and nothing else', () => {
      expectProblems(first({ body: `{product} ${text(300)}` }), [problem('responses', 2, 'body', 'TOO_LONG')])
    })
  })

  describe('the routine wording gate', () => {
    it.each(TEXTS)('refuses a promise of lighter skin in %s, on that cell: RESPONSE_WORDING', (column) => {
      expectProblems(first({ [column]: 'Helps you get lighter skin in weeks.' }), [problem('responses', 2, column, 'RESPONSE_WORDING')])
    })

    it.each(TEXTS)('refuses the name of a condition in %s, with the placeholder in the text too', (column) => {
      expectProblems(first({ [column]: 'Rest your {step}: this looks like eczema.' }), [problem('responses', 2, column, 'RESPONSE_WORDING')])
    })

    it('refuses a diagnosis and a score, and reports a cell once however many forbidden words it holds', () => {
      expectProblems(first({ title: 'You have rosacea', body: 'Your skin score is 7/10. Lighter skin, fairer and whiter.' }), [
        problem('responses', 2, 'title', 'RESPONSE_WORDING'),
        problem('responses', 2, 'body', 'RESPONSE_WORDING'),
      ])
    })

    it('reads the text once for each way {step} is shown, and refuses it when any one reading breaks the gate', () => {
      // "skin lightening" passes only when a product word follows it: "skin lightening product" is a product someone is stopping, "skin lightening Treatment" is not.
      expectProblems(first({ body: 'Stop your skin lightening {step}.' }), [problem('responses', 2, 'body', 'RESPONSE_WORDING')])
      expectProblems(first({ title: 'Stop your skin lightening {step}' }), [problem('responses', 2, 'title', 'RESPONSE_WORDING')])
      expectProblems(first({ what_to_do_now: 'Stop your skin lightening {step}.' }), [problem('responses', 2, 'what_to_do_now', 'RESPONSE_WORDING')])
    })

    it('does not refuse a text with {step} that passes with every one of its readings', () => {
      expectValid(first({ body: 'Your {step} is on hold. Keep to a gentle wash and moisturiser.' }))
    })

    it('still reports a cell once, however many of the readings break the gate', () => {
      expectProblems(first({ body: 'Skin lightening {step}, lighter skin, fairer, whiter.' }), [problem('responses', 2, 'body', 'RESPONSE_WORDING')])
    })

    it('lets a plain sentence with {step} through', () => {
      expectValid(first({ title: 'Your {step} is on hold', body: 'We stopped your {step} so your skin can settle.', what_to_do_now: 'Keep your {step} off until we ask again.' }))
    })

    it('says a cell that is too long is too long and nothing else', () => {
      expectProblems(first({ body: `lighter skin ${text(300)}` }), [problem('responses', 2, 'body', 'TOO_LONG')])
    })
  })

  describe('a row for every outcome', () => {
    it.each(OUTCOMES)('is refused when %s has none: RESPONSE_MISSING on the header row', (outcome) => {
      expectProblems(alone('responses', baseResponses().filter((row) => row.outcome !== outcome)), MISSING)
    })

    it('is told once however many outcomes have none, an empty tab included', () => {
      expectProblems(alone('responses', []), MISSING)
      expectProblems(alone('responses', baseResponses().slice(0, 3)), MISSING)
    })

    it.each([
      ['a draft', { status: 'draft', approved_by: null, approved_on: null }],
      ['a retired row', { status: 'retired', approved_by: null, approved_on: null }],
    ])('does not count %s as the row of its outcome', (_name, over) => {
      expectProblems(alone('responses', baseResponses().map((row) => (row.outcome === 'check-worse' ? { ...row, ...over } : row))), MISSING)
    })
  })

  describe('one row for each outcome', () => {
    const duplicate = (rows: number[]) => rows.map((row) => problem('responses', row, 'outcome', 'RESPONSE_DUPLICATE'))

    it('refuses two rows for one outcome: both are reported, in outcome', () => {
      expectProblems(withOutcomes(response({ outcome: 'check-same', body: 'Something else.' })), duplicate([8, ELEVENTH]))
    })

    it('counts a draft or a retired row too: the row keeps its outcome', () => {
      expectProblems(withOutcomes(response({ outcome: 'check-same', status: 'draft', approved_by: null, approved_on: null })), duplicate([8, ELEVENTH]))
      expectProblems(withOutcomes(response({ outcome: 'check-same', status: 'retired', approved_by: null, approved_on: null })), duplicate([8, ELEVENTH]))
    })
  })

  describe('status, approval and audit', () => {
    it('takes draft, approved and retired for a row, and nothing else, though an outcome with no approved row is missing one', () => {
      expect(problemsOf(first({ status: 'live' }))).toContainEqual(problem('responses', 2, 'status', 'NOT_IN_VOCABULARY'))
      expect(problemsOf(first({ status: null }))).toContainEqual(problem('responses', 2, 'status', 'REQUIRED'))
      expectProblems(first({ status: 'retired', approved_by: null, approved_on: null }), MISSING)
    })

    it('needs an approver and a day once the row is approved', () => {
      expectProblems(first({ approved_by: null, approved_on: null }), [problem('responses', 2, 'approved_by', 'REQUIRED_WHEN_APPROVED'), problem('responses', 2, 'approved_on', 'REQUIRED_WHEN_APPROVED')])
    })

    it('reads the approval day as a real calendar day', () => {
      expectProblems(first({ approved_on: '2030-02-30' }), [problem('responses', 2, 'approved_on', 'BAD_DATE')])
    })

    it('wants both halves of an audit, or neither', () => {
      expectProblems(first({ audited_by: 'Nneka Audit' }), [problem('responses', 2, 'audited_on', 'AUDIT_INCOMPLETE')])
      expectProblems(first({ audited_on: AUDITED_ON }), [problem('responses', 2, 'audited_by', 'AUDIT_INCOMPLETE')])
    })
  })
})

describe('validateWorkbook: Weeks', () => {
  const TEXTS = ['title', 'text'] as const
  /** The five base rows with the first one changed: it is spreadsheet row 2, and every band still has its base row. */
  const first = (over: Raw): RawWorkbook => alone('weeks', [week(over), ...baseWeeks().slice(1)])
  /** The five base rows and then these: the one a test is about is spreadsheet row 7. */
  const withBands = (...more: Raw[]): RawWorkbook => alone('weeks', [...baseWeeks(), ...more])
  const SEVENTH = 7
  const MISSING = [problem('weeks', 1, 'band', 'WEEK_BASE_MISSING')]

  it('reads a week card into its band, goal, step-down flag, title, text, status and sign-off', () => {
    const rows = parsed(withBands(week({ band: '3-4', goal: 'glow', step_down: 'yes', title: 'Easing off', text: 'A flare is expected while you step down.', audited_by: 'Nneka Audit', audited_on: AUDITED_ON }))).weeks

    expect(rows[0]).toEqual({
      band: '1',
      goal: null,
      stepDown: false,
      title: 'Settling in',
      text: 'The first week is about calming things down. Go gently and keep to the basics.',
      status: 'approved',
      approvedBy: 'Dr A. Reviewer',
      approvedOn: utcMidnight(APPROVED_ON),
      auditedBy: null,
      auditedOn: null,
    })
    expect(rows[5]).toEqual({
      band: '3-4',
      goal: 'glow',
      stepDown: true,
      title: 'Easing off',
      text: 'A flare is expected while you step down.',
      status: 'approved',
      approvedBy: 'Dr A. Reviewer',
      approvedOn: utcMidnight(APPROVED_ON),
      auditedBy: 'Nneka Audit',
      auditedOn: utcMidnight(AUDITED_ON),
    })
  })

  describe('band', () => {
    it('is one of the five bands: 1, 2, 3-4, 5-8 and 9-12', () => {
      expect(parsed(withBands()).weeks.map((row) => row.band)).toEqual([...BANDS])
    })

    it.each(['0', '3', '4', '5', '9', '13', '1-2', '12', 'week 1', '3–4'])('refuses %s: it is not a band', (band) => {
      expectProblems(withBands(week({ band, goal: 'glow' })), [problem('weeks', SEVENTH, 'band', 'NOT_IN_VOCABULARY')])
    })

    it('is required', () => {
      expectProblems(withBands(week({ band: null, goal: 'glow' })), [problem('weeks', SEVENTH, 'band', 'REQUIRED')])
    })

    it.each([
      ['3-4 typed as 4 March (month first)', '2026-03-04'],
      ['3-4 typed as 3 April (day first)', '2026-04-03'],
      ['5-8 typed as 8 May', '2026-05-08'],
      ['5-8 typed as 5 August', '2026-08-05'],
      ['9-12 typed as 12 September', '2026-09-12'],
      ['9-12 typed as 9 December', '2026-12-09'],
    ])('says a band a spreadsheet made a date is that, and not only that it is no band: %s', (_what, band) => {
      expectProblems(withBands(week({ band, goal: 'glow' })), [problem('weeks', SEVENTH, 'band', 'WEEK_BAND_DATE')])
    })

    it.each(['2026-01-02', '2026-06-15', '2026-03-05'])('leaves a date that no band makes as a plain NOT_IN_VOCABULARY: %s', (band) => {
      expectProblems(withBands(week({ band, goal: 'glow' })), [problem('weeks', SEVENTH, 'band', 'NOT_IN_VOCABULARY')])
    })

    it('reads a band a spreadsheet gave as a number: 1 and 2 are bands', () => {
      expectValid(alone('weeks', [week({ band: 1 }), week({ band: 2 }), ...baseWeeks().slice(2)]))
      expect(parsed(alone('weeks', [week({ band: 1 }), ...baseWeeks().slice(1)])).weeks[0]!.band).toBe('1')
    })
  })

  describe('goal', () => {
    it.each(GOALS)('accepts %s, a goal a person can pick', (goal) => {
      expectValid(withBands(week({ band: '5-8', goal })))
    })

    it('is optional: a row with no goal is the band\'s base card', () => {
      expect(parsed(withBands()).weeks.every((row) => row.goal === null)).toBe(true)
    })

    it('refuses a value that is not one of the goals, in the case it is written in', () => {
      expectProblems(withBands(week({ band: '5-8', goal: 'lighter-skin' })), [problem('weeks', SEVENTH, 'goal', 'NOT_IN_VOCABULARY')])
      expectProblems(withBands(week({ band: '5-8', goal: 'Glow' })), [problem('weeks', SEVENTH, 'goal', 'NOT_IN_VOCABULARY')])
    })
  })

  describe('step_down', () => {
    it('is yes or no', () => {
      expectValid(withBands(week({ band: '5-8', step_down: 'yes' })))
      expectValid(withBands(week({ band: '5-8', step_down: 'no', goal: 'glow' })))
    })

    it('is no when it is empty', () => {
      expect(parsed(alone('weeks', [week({ step_down: null }), ...baseWeeks().slice(1)])).weeks[0]!.stepDown).toBe(false)
      expect(parsed(alone('weeks', [week({ step_down: '  ' }), ...baseWeeks().slice(1)])).weeks[0]!.stepDown).toBe(false)
    })

    it.each(['Yes', 'NO', 'true', 'maybe', '1'])('refuses %s: it is not yes or no, in the case it is written in', (step_down) => {
      expectProblems(withBands(week({ band: '5-8', step_down })), [problem('weeks', SEVENTH, 'step_down', 'NOT_IN_VOCABULARY')])
    })

    it('lets a step-down card have a goal', () => {
      expectValid(withBands(week({ band: '3-4', goal: 'calm-repair', step_down: 'yes' })))
    })
  })

  describe('title and text', () => {
    it('holds up to 60 characters in title, and no more', () => {
      expectValid(first({ title: text(60) }))
      expectProblems(first({ title: text(61) }), [problem('weeks', 2, 'title', 'TOO_LONG')])
    })

    it('holds up to 300 characters in text, and no more', () => {
      expectValid(first({ text: text(300) }))
      expectProblems(first({ text: text(301) }), [problem('weeks', 2, 'text', 'TOO_LONG')])
    })

    it.each(TEXTS)('requires %s', (column) => {
      expectProblems(first({ [column]: null }), [problem('weeks', 2, column, 'REQUIRED')])
      expectProblems(first({ [column]: '   ' }), [problem('weeks', 2, column, 'REQUIRED')])
    })

    it.each(TEXTS)('is plain words in %s: no link and no markup', (column) => {
      expectProblems(first({ [column]: 'Read more at https://example.com/week' }), [problem('weeks', 2, column, 'HAS_LINK_OR_MARKUP')])
      expectProblems(first({ [column]: 'Go <b>gently</b>.' }), [problem('weeks', 2, column, 'HAS_LINK_OR_MARKUP')])
    })

    it('reports a cell that is too long for its length only, even when it also holds a link', () => {
      expectProblems(first({ text: `https://example.com ${text(300)}` }), [problem('weeks', 2, 'text', 'TOO_LONG')])
    })
  })

  describe('the routine wording gate', () => {
    it.each(TEXTS)('refuses a promise of lighter skin in %s, on that cell: WEEK_WORDING', (column) => {
      expectProblems(first({ [column]: 'Lighter skin by week four.' }), [problem('weeks', 2, column, 'WEEK_WORDING')])
    })

    it.each(TEXTS)('refuses the name of a condition in %s', (column) => {
      expectProblems(first({ [column]: 'Good for melasma.' }), [problem('weeks', 2, column, 'WEEK_WORDING')])
    })

    it('reports a cell once however many forbidden words it holds, and each bad cell of a row on its own', () => {
      expectProblems(first({ title: 'Fairer and whiter', text: 'You have eczema and melasma.' }), [problem('weeks', 2, 'title', 'WEEK_WORDING'), problem('weeks', 2, 'text', 'WEEK_WORDING')])
    })

    it('also checks a card that is not approved yet, drafts included', () => {
      expectProblems(withBands(week({ band: '5-8', goal: 'glow', status: 'draft', approved_by: null, approved_on: null, text: 'Whiter skin.' })), [problem('weeks', SEVENTH, 'text', 'WEEK_WORDING')])
    })

    it('lets a plain card through', () => {
      expectValid(first({ title: 'Week of calm', text: 'Brighter, more even skin takes patience. Choose a lighter face cream in the heat.' }))
    })

    it('says a cell that is too long is too long and nothing else', () => {
      expectProblems(first({ text: `lighter skin ${text(300)}` }), [problem('weeks', 2, 'text', 'TOO_LONG')])
    })
  })

  describe('a base card for every band', () => {
    it.each(BANDS)('is refused when band %s has none: WEEK_BASE_MISSING on the header row', (band) => {
      expectProblems(alone('weeks', baseWeeks().filter((row) => row.band !== band)), MISSING)
    })

    it('is told once however many bands have none, an empty tab included', () => {
      expectProblems(alone('weeks', []), MISSING)
      expectProblems(alone('weeks', baseWeeks().slice(0, 2)), MISSING)
    })

    it.each([
      ['a draft', { status: 'draft', approved_by: null, approved_on: null }],
      ['a retired row', { status: 'retired', approved_by: null, approved_on: null }],
    ])('does not count %s as the base card', (_name, over) => {
      expectProblems(alone('weeks', baseWeeks().map((row) => (row.band === '9-12' ? { ...row, ...over } : row))), MISSING)
    })

    it('is not met by a card for a goal: a band with only goal cards has no base card', () => {
      expectProblems(alone('weeks', baseWeeks().map((row) => (row.band === '5-8' ? { ...row, goal: 'glow' } : row))), MISSING)
    })

    it('is not met by a step-down card: a band with only a step-down card has no base card', () => {
      expectProblems(alone('weeks', baseWeeks().map((row) => (row.band === '3-4' ? { ...row, step_down: 'yes' } : row))), MISSING)
    })

    it('counts a base card whose step_down is empty, which means no', () => {
      expectValid(alone('weeks', baseWeeks().map((row) => ({ ...row, step_down: null }))))
    })

    it('is met by one approved base card, whatever else the band has: goal cards, step-down cards, drafts and retired ones', () => {
      expectValid(
        withBands(
          week({ band: '3-4', goal: 'glow' }),
          week({ band: '3-4', step_down: 'yes' }),
          week({ band: '3-4', goal: 'glow', step_down: 'yes' }),
          week({ band: '3-4', goal: 'brighter', status: 'draft', approved_by: null, approved_on: null }),
          week({ band: '3-4', goal: 'even-tone', status: 'retired', approved_by: null, approved_on: null }),
        ),
      )
    })

    it('is checked for a workbook that has other problems too, and adds nothing to them', () => {
      expectProblems(workbook({ products: [product({ category: 'face' })], availability: [], ingredients: [], countries: [], weeks: baseWeeks().slice(1) }), [problem('products', 2, 'category', 'NOT_IN_VOCABULARY'), ...MISSING])
    })
  })

  describe('one card for each band, goal and step-down', () => {
    const duplicate = (rows: number[]) => rows.map((row) => problem('weeks', row, 'band', 'WEEK_DUPLICATE'))

    it('refuses two base cards for one band: both are reported, in band', () => {
      expectProblems(withBands(week({ band: '2', text: 'Something else.' })), duplicate([3, SEVENTH]))
    })

    it('refuses two cards for one band and goal: both are reported', () => {
      expectProblems(withBands(week({ band: '5-8', goal: 'glow' }), week({ band: '5-8', goal: 'glow', text: 'Something else.' })), duplicate([SEVENTH, 8]))
    })

    it('refuses two cards for one band, goal and step-down: both are reported', () => {
      expectProblems(withBands(week({ band: '5-8', goal: 'glow', step_down: 'yes' }), week({ band: '5-8', goal: 'glow', step_down: 'yes', text: 'Something else.' })), duplicate([SEVENTH, 8]))
    })

    it('reads an empty step_down as no: a base card that says no and one that says nothing clash', () => {
      expectProblems(withBands(week({ band: '2', step_down: null })), duplicate([3, SEVENTH]))
    })

    it('reports every row of a clash of three', () => {
      const card = week({ band: '5-8', goal: 'glow' })
      expectProblems(withBands(card, card, card), duplicate([SEVENTH, 8, 9]))
    })

    it('lets a band have a card for each goal, and for each step-down, and a goal have a card for each band', () => {
      expectValid(withBands(week({ band: '5-8', goal: 'glow' }), week({ band: '5-8', goal: 'even-tone' }), week({ band: '5-8', step_down: 'yes' }), week({ band: '9-12', goal: 'glow' })))
    })

    it('counts a retired or a draft card too: the row keeps its place', () => {
      expectProblems(withBands(week({ band: '5-8', goal: 'glow' }), week({ band: '5-8', goal: 'glow', status: 'retired', approved_by: null, approved_on: null })), duplicate([SEVENTH, 8]))
      expectProblems(withBands(week({ band: '5-8', goal: 'glow' }), week({ band: '5-8', goal: 'glow', status: 'draft', approved_by: null, approved_on: null })), duplicate([SEVENTH, 8]))
    })

    it('reads the band, goal and step-down as they are written once trimmed', () => {
      expectProblems(withBands(week({ band: ' 2 ', goal: null })), duplicate([3, SEVENTH]))
    })
  })

  describe('status, approval and audit', () => {
    const extra = (over: Raw) => withBands(week({ band: '5-8', goal: 'glow', ...over }))

    it('takes draft, approved and retired for a row, and nothing else', () => {
      for (const status of ['draft', 'approved', 'retired']) expectValid(extra({ status, ...(status === 'approved' ? {} : { approved_by: null, approved_on: null }) }))
      expectProblems(extra({ status: 'live' }), [problem('weeks', SEVENTH, 'status', 'NOT_IN_VOCABULARY')])
      expectProblems(extra({ status: null }), [problem('weeks', SEVENTH, 'status', 'REQUIRED')])
    })

    it('needs an approver and a day once the row is approved', () => {
      expectProblems(extra({ approved_by: null, approved_on: null }), [problem('weeks', SEVENTH, 'approved_by', 'REQUIRED_WHEN_APPROVED'), problem('weeks', SEVENTH, 'approved_on', 'REQUIRED_WHEN_APPROVED')])
    })

    it('reads the approval day as a real calendar day', () => {
      expectProblems(extra({ approved_on: '2030-02-30' }), [problem('weeks', SEVENTH, 'approved_on', 'BAD_DATE')])
    })

    it('wants both halves of an audit, or neither', () => {
      expectProblems(extra({ audited_by: 'Nneka Audit' }), [problem('weeks', SEVENTH, 'audited_on', 'AUDIT_INCOMPLETE')])
      expectProblems(extra({ audited_on: AUDITED_ON }), [problem('weeks', SEVENTH, 'audited_by', 'AUDIT_INCOMPLETE')])
    })

    it('keeps a retired card whole, so what a past week said stays on record', () => {
      const row = parsed(extra({ status: 'retired', step_down: 'yes' })).weeks[5]

      expect(row).toMatchObject({ status: 'retired', band: '5-8', goal: 'glow', stepDown: true, title: week().title })
    })
  })
})

// A spreadsheet cell holds up to 32767 characters, so a file can be full of cells that size. Each one is refused for its length before anything
// reads its content, so checking the whole workbook costs about the length of the cells and no more.
describe('validateWorkbook: cells at the spreadsheet limit', () => {
  const CELL = 32767

  it('refuses a 32767-character cell in every free-text column (the texts of Guides, Escalations, Responses and Weeks included), and a 150-item list of such items, in well under a second', () => {
    const huge = text(CELL)
    const raw = workbook({
      products: [product({ brand: huge, name: huge, variant: huge, approved_by: huge, ingredients: Array.from({ length: 150 }, () => huge).join(';') })],
      availability: [availability({ where_sold: huge })],
      ingredients: [ingredient({ name: huge, aliases: huge, statement: huge, reviewer_role: huge })],
      claimWords: [claimWord({ phrase: huge, approved_by: huge, reviewer_role: huge })],
      tapers: [taper({ schedule: huge, what_to_expect: huge, see_a_professional_if: huge, approved_by: huge })],
      // The base rows are still all there: a row with cells that are too long still names its step.
      guides: [guide({ step: 'cleanse', what_it_does: huge, look_for: huge, for_deeper_skin: huge, look_for_when_pregnant: huge, approved_by: huge }), ...baseGuides().slice(1)],
      // The same for the four reviewed tabs: the rows they need are all still there, each with its key, and the first has cells that are too long.
      reintroductions: [reintroduction({ schedule: huge, approved_by: huge })],
      escalations: [escalation({ who_to_see: huge, how_soon: huge, what_to_tell_them: huge, approved_by: huge }), ...baseEscalations().slice(1)],
      responses: [response({ title: huge, body: huge, what_to_do_now: huge, approved_by: huge }), ...baseResponses().slice(1)],
      weeks: [week({ title: huge, text: huge, approved_by: huge }), ...baseWeeks().slice(1)],
    })

    const started = performance.now()
    const problems = problemsOf(raw)
    const took = performance.now() - started

    expect(problems).toEqual(
      order([
        problem('products', 2, 'brand', 'TOO_LONG'),
        problem('products', 2, 'name', 'TOO_LONG'),
        problem('products', 2, 'variant', 'TOO_LONG'),
        problem('products', 2, 'approved_by', 'TOO_LONG'),
        problem('products', 2, 'ingredients', 'ITEM_TOO_LONG'),
        problem('availability', 2, 'where_sold', 'TOO_LONG'),
        problem('ingredients', 2, 'name', 'TOO_LONG'),
        problem('ingredients', 2, 'aliases', 'ITEM_TOO_LONG'),
        problem('ingredients', 2, 'statement', 'TOO_LONG'),
        problem('ingredients', 2, 'reviewer_role', 'TOO_LONG'),
        problem('claimWords', 2, 'phrase', 'TOO_LONG'),
        problem('claimWords', 2, 'approved_by', 'TOO_LONG'),
        problem('claimWords', 2, 'reviewer_role', 'TOO_LONG'),
        problem('tapers', 2, 'schedule', 'TOO_LONG'),
        problem('tapers', 2, 'what_to_expect', 'TOO_LONG'),
        problem('tapers', 2, 'see_a_professional_if', 'TOO_LONG'),
        problem('tapers', 2, 'approved_by', 'TOO_LONG'),
        problem('guides', 2, 'what_it_does', 'TOO_LONG'),
        problem('guides', 2, 'look_for', 'TOO_LONG'),
        problem('guides', 2, 'for_deeper_skin', 'TOO_LONG'),
        problem('guides', 2, 'look_for_when_pregnant', 'TOO_LONG'),
        problem('guides', 2, 'approved_by', 'TOO_LONG'),
        problem('reintroductions', 2, 'schedule', 'TOO_LONG'),
        problem('reintroductions', 2, 'approved_by', 'TOO_LONG'),
        problem('escalations', 2, 'who_to_see', 'TOO_LONG'),
        problem('escalations', 2, 'how_soon', 'TOO_LONG'),
        problem('escalations', 2, 'what_to_tell_them', 'TOO_LONG'),
        problem('escalations', 2, 'approved_by', 'TOO_LONG'),
        problem('responses', 2, 'title', 'TOO_LONG'),
        problem('responses', 2, 'body', 'TOO_LONG'),
        problem('responses', 2, 'what_to_do_now', 'TOO_LONG'),
        problem('responses', 2, 'approved_by', 'TOO_LONG'),
        problem('weeks', 2, 'title', 'TOO_LONG'),
        problem('weeks', 2, 'text', 'TOO_LONG'),
        problem('weeks', 2, 'approved_by', 'TOO_LONG'),
      ]),
    )
    expect(took).toBeLessThan(1000)
  })
})
