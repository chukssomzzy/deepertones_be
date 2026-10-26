import type { VerdictReference, VerdictRule } from '../../src/modules/catalog/catalog.workbook.service'
import type { VerdictCase, VerdictEntry } from './verdict-cases'

// Shared by the verdict eval tests: a reference built in code and one small case of each kind the rules floor decides, so a test changes the one thing it is
// about. Every brand and name here is MADE UP (a test may not use a real catalog product: the repo is public and the no-overfitting guard reads these names),
// and the ingredient rules are small stand-ins for the owner's workbook, never copies of it. Not a test file, so it is never run.

/** The one day every date in the verdict eval tests hangs from; fixtures are offsets from it. */
export const BASE = new Date('2030-06-15T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
export const dayAt = (offset: number): Date => new Date(BASE.getTime() + offset * DAY)

// --- the reference -------------------------------------------------------------------------------------------------------------------------------

const rule = (name: string, kind: VerdictRule['kind'], over: Partial<VerdictRule> = {}): VerdictRule => ({ name, aliases: [], kind, rule: `${name} is a ${kind} (test rule)`, source: null, group: null, clashesWith: [], helps: [], ...over })

/** What the fixture cases are judged by: one rule for each group the floor reads, a banned ingredient with no group, claim phrases and both step-down templates. */
export const FIXTURE_REFERENCE: VerdictReference = {
  rulesVersion: 'fixture-rules-1',
  catalogVersion: 1,
  rules: [
    rule('mercurous chloride', 'banned-substance', { aliases: ['calomel'], group: 'mercury' }),
    rule('clobetasol propionate', 'restricted-substance', { group: 'steroid' }),
    rule('hydroquinone', 'banned-substance', { aliases: ['quinol'], group: 'lightening-agent' }),
    rule('lead acetate', 'banned-substance'),
    // The clash is listed on both sides, as the workbook contract requires.
    rule('retinol', 'pregnancy-caution', { group: 'retinoid', clashesWith: ['exfoliating-acid'], helps: ['hd_age_spot', 'hd_texture'] }),
    rule('glycolic acid', 'irritation', { group: 'exfoliating-acid', clashesWith: ['retinoid'], helps: ['hd_texture'] }),
    rule('parfum', 'allergen', { aliases: ['fragrance'] }),
  ],
  claimPhrases: ['whitening', 'bleaching'],
  tapers: { steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' },
}

/** The model and prompt the fit judge uses, as the fingerprint names them. */
export const FIXTURE_FITTER = { model: 'fixture-model', promptHash: 'fixture-prompt-hash' }

// --- builders ------------------------------------------------------------------------------------------------------------------------------------

/** A skin product of a made-up brand that nothing in FIXTURE_REFERENCE flags, unless a test gives it ingredients that do. */
export const product = (id: string, over: Partial<Extract<VerdictEntry, { kind: 'product' }>> = {}): VerdictEntry => ({
  id,
  kind: 'product',
  brand: 'Zenvi',
  name: 'Plain Cream',
  variant: null,
  form: 'cream',
  category: 'skin',
  ingredients: ['Aqua', 'Glycerin'],
  steps: ['moisturise'],
  source: { madeUp: true },
  ...over,
})

export const noLabel = (id: string, purpose: Extract<VerdictEntry, { kind: 'no-label' }>['purpose']): VerdictEntry => ({ id, kind: 'no-label', purpose })

/** A case with no safety answers, no scan and nothing on the shelf, to be given what a test is about. */
export const caseOf = (id: string, over: Partial<VerdictCase> = {}): VerdictCase => ({
  id,
  persona: null,
  country: 'NG',
  note: 'fixture case: never sent to a model',
  goal: 'even-tone',
  scan: null,
  safety: { choices: ['none'], mentions: [] },
  shelf: [],
  expect: { entries: {}, clashes: [] },
  ...over,
})

// --- one case of each kind the floor decides -----------------------------------------------------------------------------------------------------------

export const FIXTURE = {
  /** A product holding a mercury ingredient: dropped at once, and the app tells the person to see a professional. */
  mercury: caseOf('main-01', {
    shelf: [product('mercury-cream', { brand: 'Quillon', name: 'Radiance Cream', ingredients: ['Aqua', 'Mercurous Chloride', 'Glycerin'] })],
    expect: { entries: { 'mercury-cream': { outcome: 'fixed', group: 'likely-the-problem', verdict: 'drop', escalate: true } }, clashes: [] },
  }),
  /** A steroid: stopped with the approved steroid step-down. */
  steroid: caseOf('main-02', {
    goal: 'calm-repair',
    shelf: [product('steroid-gel', { brand: 'Tavari', name: 'Soothing Gel', form: 'gel', ingredients: ['Clobetasol Propionate', 'Petrolatum'], steps: ['treat'] })],
    expect: { entries: { 'steroid-gel': { outcome: 'fixed', group: 'likely-the-problem', verdict: 'stop', taper: 'steroid' } }, clashes: [] },
  }),
  /** Hydroquinone, written with a strength as a label writes it: stopped with the approved lightening step-down. */
  hydroquinone: caseOf('main-03', {
    goal: 'fade-dark-marks',
    shelf: [product('spot-cream', { brand: 'Pellora', name: 'Spot Fade Cream', ingredients: ['Aqua', 'Hydroquinone 4%'], steps: ['treat'] })],
    expect: { entries: { 'spot-cream': { outcome: 'fixed', group: 'likely-the-problem', verdict: 'stop', taper: 'lightening-agent' } }, clashes: [] },
  }),
  /** Nothing in the ingredients is flagged; the name carries an approved lightening claim phrase. */
  claimWord: caseOf('main-04', {
    goal: 'brighter',
    shelf: [product('claim-lotion', { brand: 'Orrin', name: 'Whitening Face Lotion', form: 'lotion', ingredients: ['Aqua', 'Glycerin', 'Niacinamide'] })],
    expect: { entries: { 'claim-lotion': { outcome: 'fixed', group: 'likely-the-problem', verdict: 'stop', taper: 'lightening-agent' } }, clashes: [] },
  }),
  /** A jar with no label that the person says they use to lighten. */
  noLabelLighten: caseOf('main-05', {
    goal: 'brighter',
    shelf: [noLabel('jar-lighten', 'lighten')],
    expect: { entries: { 'jar-lighten': { outcome: 'fixed', group: 'likely-the-problem', verdict: 'stop', taper: 'lightening-agent' } }, clashes: [] },
  }),
  /** A jar with no label used for anything else: nothing can be read, so it is set aside. */
  noLabelOther: caseOf('main-06', {
    shelf: [noLabel('jar-other', 'moisturise')],
    expect: { entries: { 'jar-other': { outcome: 'fixed', group: 'cant-tell', verdict: 'drop' } }, clashes: [] },
  }),
  /** A product whose ingredient list is empty reads as "nothing flagged" but means nothing is known. */
  emptyIngredients: caseOf('main-07', {
    shelf: [product('empty-tube', { brand: 'Dovelle', name: 'Mystery Tube', ingredients: [] })],
    expect: { entries: { 'empty-tube': { outcome: 'fixed', group: 'cant-tell', verdict: 'drop' } }, clashes: [] },
  }),
  /** A banned ingredient that belongs to no group: dropped, with no escalation. */
  bannedNoGroup: caseOf('main-08', {
    shelf: [product('banned-balm', { brand: 'Ambra', name: 'Colour Balm', form: 'balm', ingredients: ['Aqua', 'Lead Acetate'] })],
    expect: { entries: { 'banned-balm': { outcome: 'fixed', group: 'likely-the-problem', verdict: 'drop' } }, clashes: [] },
  }),
  /** The person says a product they own gave them a reaction; the catalog resolved it to that shelf product. A second product stays open. */
  reactionProduct: caseOf('main-09', {
    safety: { choices: ['reaction'], mentions: [{ source: 'reaction', kind: 'product', name: 'Calm Cream', resolvesTo: 'calm-cream' }] },
    shelf: [
      product('calm-cream', { brand: 'Kestrel', name: 'Calm Cream', ingredients: ['Aqua', 'Squalane', 'Panthenol'] }),
      product('other-cream', { brand: 'Kestrel', name: 'Day Cream', ingredients: ['Aqua', 'Glycerin', 'Ceramide NP'] }),
    ],
    expect: { entries: { 'calm-cream': { outcome: 'fixed', group: 'likely-the-problem', verdict: 'drop' }, 'other-cream': { outcome: 'open' } }, clashes: [] },
  }),
  /** The person reacted to fragrance: a product that lists parfum conflicts, one that does not stays open. */
  reactionIngredient: caseOf('main-10', {
    safety: { choices: ['reaction'], mentions: [{ source: 'reaction', kind: 'ingredient', name: 'fragrance', resolvesTo: null }] },
    shelf: [
      product('scented-wash', { brand: 'Halden', name: 'Fresh Wash', form: 'liquid', ingredients: ['Aqua', 'Parfum', 'Glycerin'], steps: ['cleanse'] }),
      product('plain-wash', { brand: 'Halden', name: 'Soft Wash', form: 'liquid', ingredients: ['Aqua', 'Glycerin', 'Panthenol'], steps: ['cleanse'] }),
    ],
    expect: { entries: { 'scented-wash': { outcome: 'fixed', group: 'conflicting', verdict: 'drop' }, 'plain-wash': { outcome: 'open' } }, clashes: [] },
  }),
  /** Pregnant, with a retinol product on the shelf: it conflicts and is dropped. */
  pregnancyRetinol: caseOf('main-11', {
    persona: 'tolu',
    safety: { choices: ['pregnant'], mentions: [] },
    shelf: [product('night-serum', { brand: 'Wexley', name: 'Night Serum', form: 'serum', ingredients: ['Squalane', 'Retinol', 'Tocopherol'], steps: ['treat'] })],
    expect: { entries: { 'night-serum': { outcome: 'fixed', group: 'conflicting', verdict: 'drop' } }, clashes: [] },
  }),
  /** A steroid the person is prescribed, resolved by the catalog to the shelf product: kept, never stopped. */
  prescribedSteroid: caseOf('main-12', {
    safety: { choices: ['prescription'], mentions: [{ source: 'prescription', kind: 'product', name: 'Rx Gel', resolvesTo: 'rx-gel' }] },
    shelf: [product('rx-gel', { brand: 'Tavari', name: 'Rx Gel', form: 'gel', ingredients: ['Clobetasol Propionate', 'Petrolatum'], steps: ['treat'] })],
    expect: { entries: { 'rx-gel': { outcome: 'fixed', group: 'prescribed', verdict: 'keep' } }, clashes: [] },
  }),
  /** The person names a product that the catalog could not resolve to anything on the shelf: nothing can be held against the shelf product. */
  unresolvedMention: caseOf('hold-01', {
    safety: { choices: ['reaction'], mentions: [{ source: 'reaction', kind: 'product', name: 'Some Cream I Forgot', resolvesTo: null }] },
    shelf: [product('fine-cream', { brand: 'Lumet', name: 'Fine Cream', ingredients: ['Aqua', 'Squalane'] })],
    expect: { entries: { 'fine-cream': { outcome: 'open' } }, clashes: [] },
  }),
  /** A hair product is not the shelf verdict's business: the floor never answers for it. A skin product beside it stays open. */
  nonSkin: caseOf('hold-02', {
    persona: 'chidi',
    shelf: [
      product('edge-pomade', { brand: 'Dovelle', name: 'Edge Pomade', form: 'balm', category: 'hair', ingredients: ['Petrolatum', 'Beeswax'], steps: [] }),
      product('face-cream', { brand: 'Lumet', name: 'Face Cream', ingredients: ['Aqua', 'Squalane'] }),
    ],
    expect: { entries: { 'edge-pomade': { outcome: 'ignored' }, 'face-cream': { outcome: 'open' } }, clashes: [] },
  }),
  /** A retinoid and an exfoliating acid, neither pregnant nor stopped: both stay open and the floor reports the pair. */
  retinoidAcidClash: caseOf('hold-03', {
    persona: 'ngozi',
    country: 'GB',
    goal: 'fade-dark-marks',
    scan: { skinType: 'combination', concerns: [{ concern: 'hd_age_spot', band: 'some' }, { concern: 'hd_acne', band: 'a-little' }, { concern: 'hd_texture', band: 'faint' }] },
    shelf: [
      product('retinol-serum', { brand: 'Wexley', name: 'Retinol Serum', form: 'serum', ingredients: ['Squalane', 'Retinol'], steps: ['treat'] }),
      product('acid-toner', { brand: 'Ambra', name: 'Glycolic Toner', form: 'liquid', ingredients: ['Aqua', 'Glycolic Acid'], steps: ['treat'] }),
    ],
    expect: { entries: { 'retinol-serum': { outcome: 'open' }, 'acid-toner': { outcome: 'open' } }, clashes: [['retinol-serum', 'acid-toner']] },
  }),
} satisfies Record<string, VerdictCase>

export const FIXTURE_MAIN: VerdictCase[] = [
  FIXTURE.mercury,
  FIXTURE.steroid,
  FIXTURE.hydroquinone,
  FIXTURE.claimWord,
  FIXTURE.noLabelLighten,
  FIXTURE.noLabelOther,
  FIXTURE.emptyIngredients,
  FIXTURE.bannedNoGroup,
  FIXTURE.reactionProduct,
  FIXTURE.reactionIngredient,
  FIXTURE.pregnancyRetinol,
  FIXTURE.prescribedSteroid,
]
export const FIXTURE_HOLDOUT: VerdictCase[] = [FIXTURE.unresolvedMention, FIXTURE.nonSkin, FIXTURE.retinoidAcidClash]
export const FIXTURE_CASES: VerdictCase[] = [...FIXTURE_MAIN, ...FIXTURE_HOLDOUT]
