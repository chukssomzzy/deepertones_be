/*
 * The measurement sets of `npm run eval:routine`: 30 synthetic people in ROUTINE_DEV (the set a prompt or rule is tuned on) and 30 in ROUTINE_HOLDOUT (the
 * set the bar is judged on, never tuned on). They are written from the personas in CONTEXT.md (Amara, Tolu, Ngozi, Chidi) and from people like them who have no
 * name, and they describe people, not catalog rows, so they are committed; the catalog snapshot they are run against is not (see routine-snapshot.ts).
 *
 * A case holds what the app would know when it builds the skeleton: the goal and the face scan's reading of all three of the goal's concerns, in goal order (a real scan shows every concern it measured, faint included), the safety answers, the shelf with the
 * rules' verdicts, the country and the budget. The cautions are derived from the safety answers and the shelf here, as the app derives them. A case carries no
 * maxNewProducts: the skeleton allows as many new products as it has gaps with candidates.
 * Each set is a spread (goals, countries, personas, safety states, shelves alternate from one case to the next), not half of a sorted list.
 * The shelf products and their brands are made up for the eval (a market product has no brand) and may coincide with real names; none stands for a real product.
 */
import type { BudgetBand, Frequency } from '../../src/modules/catalog/catalog.vocabulary'
import type { Band, ShownConcern, SkinTypeLabel } from '../../src/modules/face-scans/face-scans.tables'
import { concernsForGoal } from '../../src/modules/face-scans/face-scans.tables'
import type { Goal } from '../../src/modules/goals/goals.vocabulary'
import type { SafetyChoice } from '../../src/modules/safety/safety.vocabulary'
import type { CautionState, SeenConcern, ShelfVerdict, SkeletonShelfProduct } from '../../src/modules/routines/routines.types'

/** The measurement sets: dev is tuned on, holdout is the bar. */
export type RoutineSet = 'dev' | 'holdout'

export type RoutineCase = {
  /** 'dev-01'..'dev-30', 'hold-01'..'hold-30'. */
  id: string
  persona: 'amara' | 'tolu' | 'ngozi' | 'chidi' | null
  goal: Goal
  country: 'NG' | 'GB'
  budgetBand: BudgetBand | null
  skinType: SkinTypeLabel | null
  /** All three of the goal's concerns, in goal order, at the levels the scan gave. */
  seen: SeenConcern[]
  /** Visible core extras the person did not choose. */
  alsoNoticed: SeenConcern[]
  /** The ticked choices, and the ingredients the parse found in the words typed beside "reaction" and "prescription" (resolved ingredient mentions). */
  safety: { choices: SafetyChoice[]; reactionIngredients: string[]; prescriptionIngredients: string[] }
  cautions: CautionState[]
  /** Synthetic shelf products with the rules' verdicts. */
  shelf: SkeletonShelfProduct[]
}

type Persona = RoutineCase['persona']
type Seen = [ShownConcern, Band][]
/** The levels of a goal's three concerns, in goal order. */
type Levels = [Band, Band, Band]
type Safety = RoutineCase['safety']

// --- shelf products ------------------------------------------------------------------------------------------------------------------------------

type Template = Omit<SkeletonShelfProduct, 'id'>

const keep: ShelfVerdict = { kind: 'keep' }
const reduce = (maxFrequency: Frequency): ShelfVerdict => ({ kind: 'reduce', maxFrequency })
const stop = (taperTemplateId: string): ShelfVerdict => ({ kind: 'stop', taperTemplateId })

const PRODUCTS = {
  'gentle-cleanser': { brand: 'Calm Water', name: 'Gentle Cream Cleanser', ingredients: ['Aqua', 'Glycerin', 'Cocamidopropyl Betaine', 'Panthenol'], step: 'cleanse', verdict: keep, sourceUrls: [] },
  'foaming-cleanser': { brand: 'Fresh Start', name: 'Foaming Face Wash', ingredients: ['Aqua', 'Sodium Laureth Sulfate', 'Cocamidopropyl Betaine', 'Parfum', 'Menthol'], step: 'cleanse', verdict: reduce('pm'), sourceUrls: [] },
  'black-soap': { brand: null, name: 'African black soap bar', ingredients: ['Sodium Cocoate', 'Plantain Ash', 'Butyrospermum Parkii Butter'], step: 'cleanse', verdict: keep, sourceUrls: [] },
  'lemon-scrub': { brand: null, name: 'Homemade lemon and sugar scrub', ingredients: ['Citrus Limon Juice', 'Sucrose', 'Cocos Nucifera Oil'], step: 'cleanse', verdict: reduce('weekly'), sourceUrls: [] },
  'kojic-soap': { brand: 'Glow Queen', name: 'Kojic Acid Brightening Soap', ingredients: ['Sodium Palmate', 'Aqua', 'Kojic Acid', 'Parfum'], step: 'cleanse', verdict: stop('tpl-lightening-soap'), sourceUrls: ['https://rules.example/kojic-acid'] },
  'lightening-cream': { brand: null, name: 'Market lightening cream (no label)', ingredients: ['Aqua', 'Hydroquinone', 'Glycerin', 'Parfum'], step: 'treat', verdict: stop('tpl-lightening-cream'), sourceUrls: ['https://rules.example/hydroquinone'] },
  'steroid-cream': { brand: null, name: 'Strong steroid cream (tube with no brand)', ingredients: ['Clobetasol Propionate', 'Petrolatum'], step: 'treat', verdict: stop('tpl-steroid-cream'), sourceUrls: ['https://rules.example/topical-steroids'] },
  'vitamin-c-serum': { brand: 'Bright Drop', name: 'Vitamin C Serum', ingredients: ['Aqua', 'Ascorbic Acid', 'Propylene Glycol', 'Alcohol Denat'], step: 'treat', verdict: keep, sourceUrls: [] },
  'niacinamide-serum': { brand: 'Even Tone Lab', name: 'Niacinamide 10% Serum', ingredients: ['Aqua', 'Niacinamide', 'Zinc PCA', 'Phenoxyethanol'], step: 'treat', verdict: keep, sourceUrls: [] },
  'glycolic-toner': { brand: 'Glow Peel', name: 'Glycolic Acid 7% Toner', ingredients: ['Aqua', 'Glycolic Acid', 'Alcohol Denat', 'Parfum'], step: 'treat', verdict: reduce('weekly'), sourceUrls: [] },
  'salicylic-gel': { brand: 'Clear Gel', name: 'Salicylic Acid 2% Gel', ingredients: ['Aqua', 'Salicylic Acid', 'Butylene Glycol'], step: 'treat', verdict: keep, sourceUrls: [] },
  'retinol-serum': { brand: 'Night Renew', name: 'Retinol 0.5% Serum', ingredients: ['Squalane', 'Retinol', 'Tocopherol'], step: 'treat', verdict: keep, sourceUrls: [] },
  'tretinoin-rx': { brand: null, name: 'Prescribed tretinoin 0.025% cream', ingredients: ['Tretinoin', 'Cetyl Alcohol', 'Aqua'], step: 'treat', verdict: keep, sourceUrls: [] },
  'hydrating-cream': { brand: 'Deep Dew', name: 'Moisturising Cream', ingredients: ['Aqua', 'Glycerin', 'Butyrospermum Parkii Butter', 'Ceramide NP'], step: 'moisturise', verdict: keep, sourceUrls: [] },
  'gel-moisturiser': { brand: 'Water Gel', name: 'Light Gel Moisturiser', ingredients: ['Aqua', 'Glycerin', 'Sodium Hyaluronate'], step: 'moisturise', verdict: keep, sourceUrls: [] },
  'shea-butter': { brand: null, name: 'Raw shea butter', ingredients: ['Butyrospermum Parkii Butter'], step: 'moisturise', verdict: keep, sourceUrls: [] },
  'petroleum-jelly': { brand: null, name: 'Petroleum jelly', ingredients: ['Petrolatum'], step: 'moisturise', verdict: keep, sourceUrls: [] },
  'cocoa-lotion': { brand: 'Sweet Cocoa', name: 'Cocoa Butter Body Lotion', ingredients: ['Aqua', 'Mineral Oil', 'Theobroma Cacao Seed Butter', 'Parfum'], step: 'moisturise', verdict: reduce('pm'), sourceUrls: [] },
  'mineral-spf': { brand: 'Daily Shield', name: 'Mineral SPF 50', ingredients: ['Zinc Oxide', 'Aqua', 'Caprylic/Capric Triglyceride'], step: 'protect', verdict: keep, sourceUrls: [] },
  'chemical-spf': { brand: 'Sheer', name: 'SPF 30 Lotion', ingredients: ['Aqua', 'Homosalate', 'Octocrylene', 'Avobenzone', 'Parfum'], step: 'protect', verdict: keep, sourceUrls: [] },
  'aftershave': { brand: 'Cool Blue', name: 'Aftershave Splash', ingredients: ['Alcohol Denat', 'Aqua', 'Parfum', 'Menthol'], step: null, verdict: reduce('as-needed'), sourceUrls: [] },
  'rice-toner': { brand: null, name: 'Rice water toner', ingredients: ['Oryza Sativa Water', 'Glycerin'], step: null, verdict: keep, sourceUrls: [] },
  'snail-essence': { brand: 'Slime Co', name: 'Snail Mucin Essence', ingredients: ['Snail Secretion Filtrate', 'Glycerin', 'Panthenol'], step: null, verdict: keep, sourceUrls: [] },
  'clay-mask': { brand: 'Earth Face', name: 'Clay Mask', ingredients: ['Kaolin', 'Aqua', 'Glycerin'], step: null, verdict: keep, sourceUrls: [] },
  'astringent-toner': { brand: 'Zing', name: 'Astringent Toner', ingredients: ['Alcohol Denat', 'Hamamelis Virginiana Water', 'Menthol', 'Parfum'], step: null, verdict: keep, sourceUrls: [] },
} as const satisfies Record<string, Template>

type ProductKey = keyof typeof PRODUCTS
/** A product by key, or by key with the verdict the rules gave it for this person. */
type OnShelf = ProductKey | [ProductKey, ShelfVerdict]

const shelfOf = (...items: OnShelf[]): SkeletonShelfProduct[] =>
  items.map((item) => {
    const [key, verdict] = typeof item === 'string' ? [item, undefined] : item
    const template: Template = PRODUCTS[key]
    return { id: `shelf-${key}`, ...template, ingredients: [...template.ingredients], sourceUrls: [...template.sourceUrls], verdict: verdict ?? template.verdict }
  })

// --- safety answers ------------------------------------------------------------------------------------------------------------------------------

const NONE: Safety = { choices: ['none'], reactionIngredients: [], prescriptionIngredients: [] }
const PREGNANT: Safety = { choices: ['pregnant'], reactionIngredients: [], prescriptionIngredients: [] }
const BREASTFEEDING: Safety = { choices: ['breastfeeding'], reactionIngredients: [], prescriptionIngredients: [] }
const reaction = (...ingredients: string[]): Safety => ({ choices: ['reaction'], reactionIngredients: ingredients, prescriptionIngredients: [] })
const prescription = (...ingredients: string[]): Safety => ({ choices: ['prescription'], reactionIngredients: [], prescriptionIngredients: ingredients })
const reactionAndPrescription = (reacted: string[], prescribed: string[]): Safety => ({ choices: ['reaction', 'prescription'], reactionIngredients: reacted, prescriptionIngredients: prescribed })

// --- cases ---------------------------------------------------------------------------------------------------------------------------------------

const levels = (pairs: Seen): SeenConcern[] => pairs.map(([concern, level]) => ({ concern, level }))
const seenOf = (goal: Goal, bands: Levels): SeenConcern[] => concernsForGoal(goal).map((concern, i) => ({ concern, level: bands[i]! }))

/** The cautions the app would state: from the safety answers, and tapering when the rules stop a shelf product. */
const cautionsOf = (safety: Safety, shelf: SkeletonShelfProduct[]): CautionState[] => [
  ...(safety.choices.includes('pregnant') ? (['pregnant'] as const) : []),
  ...(safety.choices.includes('breastfeeding') ? (['breastfeeding'] as const) : []),
  ...(shelf.some((p) => p.verdict.kind === 'stop') ? (['tapering'] as const) : []),
  ...(safety.choices.includes('reaction') ? (['recent-reaction'] as const) : []),
  ...(safety.choices.includes('prescription') ? (['prescription'] as const) : []),
]

const person = (
  id: string,
  persona: Persona,
  goal: Goal,
  country: RoutineCase['country'],
  budgetBand: BudgetBand | null,
  skinType: SkinTypeLabel | null,
  seen: Levels,
  alsoNoticed: Seen,
  safety: Safety,
  ...items: OnShelf[]
): RoutineCase => {
  const shelf = shelfOf(...items)
  return { id, persona, goal, country, budgetBand, skinType, seen: seenOf(goal, seen), alsoNoticed: levels(alsoNoticed), safety, cautions: cautionsOf(safety, shelf), shelf }
}

export const ROUTINE_DEV: RoutineCase[] = [
  // Amara: thin, red skin after a market lightening cream; both times she stopped it flared.
  person('dev-01', 'amara', 'calm-repair', 'NG', 'low', 'combination', ['clear', 'some', 'a-little'], [['hd_age_spot', 'a-little']], NONE, 'lightening-cream', 'black-soap', 'petroleum-jelly'),
  // Ngozi: reads ingredient lists, reacts to fragrance.
  person('dev-02', 'ngozi', 'even-tone', 'GB', 'high', 'normal', ['clear', 'faint', 'some'], [['hd_acne', 'a-little']], reaction('fragrance'), 'gentle-cleanser', 'vitamin-c-serum', 'mineral-spf'),
  // Tolu: nine TikTok products at once and something stings.
  person('dev-03', 'tolu', 'fade-dark-marks', 'NG', 'low', 'oily', ['clear', 'some', 'a-little'], [['hd_pore', 'some'], ['hd_oiliness', 'clear']], NONE, 'lemon-scrub', 'kojic-soap', 'glycolic-toner', 'vitamin-c-serum', 'niacinamide-serum', 'snail-essence', 'rice-toner', 'cocoa-lotion', 'chemical-spf'),
  // Chidi: razor bumps along the jaw, an aftershave that stings.
  person('dev-04', 'chidi', 'clear-skin', 'NG', 'low', 'oily', ['some', 'a-little', 'some'], [['hd_age_spot', 'a-little']], reaction('fragrance', 'alcohol'), 'aftershave', 'salicylic-gel', 'black-soap'),
  person('dev-05', null, 'glow', 'GB', 'mid', 'dry', ['a-little', 'clear', 'some'], [], NONE),
  person('dev-06', null, 'brighter', 'NG', 'high', 'normal', ['some', 'clear', 'a-little'], [['hd_oiliness', 'a-little']], NONE, 'mineral-spf'),
  person('dev-07', 'amara', 'even-tone', 'NG', null, 'oily', ['some', 'clear', 'faint'], [], NONE, 'steroid-cream', 'gentle-cleanser'),
  person('dev-08', 'ngozi', 'glow', 'GB', 'high', 'combination', ['some', 'a-little', 'faint'], [['hd_pore', 'a-little']], PREGNANT, 'gel-moisturiser', 'mineral-spf', 'niacinamide-serum'),
  person('dev-09', null, 'clear-skin', 'GB', 'low', null, ['clear', 'some', 'a-little'], [], NONE),
  person('dev-10', 'tolu', 'calm-repair', 'NG', 'low', 'dry', ['some', 'clear', 'clear'], [['hd_acne', 'a-little']], reaction('glycolic acid'), 'glycolic-toner', 'foaming-cleanser', 'snail-essence', 'shea-butter'),
  person('dev-11', 'chidi', 'fade-dark-marks', 'NG', 'mid', 'combination', ['clear', 'some', 'a-little'], [['hd_pore', 'a-little']], NONE, 'gentle-cleanser', 'salicylic-gel', 'aftershave'),
  person('dev-12', null, 'brighter', 'GB', 'mid', 'dry', ['a-little', 'some', 'faint'], [], BREASTFEEDING),
  person('dev-13', 'amara', 'fade-dark-marks', 'NG', null, 'dry', ['clear', 'faint', 'some'], [['hd_oiliness', 'a-little']], prescription('hydroquinone'), 'lightening-cream', 'shea-butter'),
  person('dev-14', 'ngozi', 'brighter', 'GB', 'high', 'oily', ['clear', 'a-little', 'some'], [['hd_acne', 'some']], NONE, 'retinol-serum', 'mineral-spf', 'gentle-cleanser', 'hydrating-cream'),
  person('dev-15', null, 'glow', 'NG', 'low', 'normal', ['faint', 'faint', 'a-little'], [], NONE),
  person('dev-16', 'tolu', 'even-tone', 'NG', 'low', 'combination', ['some', 'a-little', 'some'], [['hd_acne', 'some']], NONE, 'lemon-scrub', 'rice-toner', 'cocoa-lotion', 'vitamin-c-serum'),
  person('dev-17', 'chidi', 'calm-repair', 'NG', null, 'normal', ['some', 'a-little', 'clear'], [['hd_age_spot', 'a-little']], reaction('fragrance'), 'black-soap', 'aftershave', 'petroleum-jelly'),
  person('dev-18', null, 'clear-skin', 'NG', 'mid', 'oily', ['some', 'a-little', 'clear'], [], NONE, 'foaming-cleanser', 'salicylic-gel', 'clay-mask'),
  person('dev-19', 'ngozi', 'fade-dark-marks', 'GB', 'mid', null, ['clear', 'a-little', 'some'], [['hd_pore', 'a-little'], ['hd_oiliness', 'some']], prescription('tretinoin'), 'tretinoin-rx', 'gentle-cleanser', 'mineral-spf'),
  person('dev-20', 'amara', 'brighter', 'NG', 'low', 'combination', ['a-little', 'faint', 'some'], [], NONE, 'lightening-cream', 'kojic-soap', 'petroleum-jelly'),
  person('dev-21', null, 'even-tone', 'GB', 'low', 'dry', ['some', 'some', 'a-little'], [], BREASTFEEDING, 'gentle-cleanser', 'hydrating-cream'),
  person('dev-22', 'tolu', 'glow', 'NG', 'mid', 'oily', ['a-little', 'faint', 'some'], [['hd_acne', 'clear'], ['hd_oiliness', 'some']], NONE, 'foaming-cleanser', 'niacinamide-serum', 'cocoa-lotion', 'chemical-spf', 'snail-essence'),
  person('dev-23', null, 'calm-repair', 'GB', 'high', 'combination', ['clear', 'some', 'some'], [], reaction('essential oils', 'fragrance'), 'gentle-cleanser', 'gel-moisturiser', 'glycolic-toner'),
  person('dev-24', 'chidi', 'clear-skin', 'NG', 'mid', 'combination', ['clear', 'some', 'a-little'], [['hd_age_spot', 'some']], NONE),
  person('dev-25', 'ngozi', 'glow', 'GB', null, 'normal', ['some', 'some', 'faint'], [], NONE, 'vitamin-c-serum', 'mineral-spf'),
  person('dev-26', null, 'fade-dark-marks', 'NG', 'high', 'oily', ['some', 'clear', 'a-little'], [['hd_pore', 'clear']], PREGNANT, 'black-soap', 'gentle-cleanser'),
  person('dev-27', 'amara', 'calm-repair', 'NG', 'low', 'dry', ['clear', 'clear', 'some'], [['hd_age_spot', 'some']], reactionAndPrescription(['kojic acid'], ['clobetasol propionate']), 'steroid-cream', 'shea-butter', 'black-soap'),
  person('dev-28', null, 'brighter', 'NG', 'low', 'combination', ['some', 'some', 'a-little'], [], NONE),
  person('dev-29', 'tolu', 'clear-skin', 'NG', 'low', 'oily', ['clear', 'clear', 'clear'], [['hd_age_spot', 'a-little']], NONE, 'foaming-cleanser', 'lemon-scrub', 'glycolic-toner', 'salicylic-gel', 'clay-mask', 'chemical-spf'),
  person('dev-30', 'chidi', 'even-tone', 'NG', 'mid', 'normal', ['some', 'a-little', 'a-little'], [], NONE, 'gentle-cleanser', 'mineral-spf'),
]

export const ROUTINE_HOLDOUT: RoutineCase[] = [
  person('hold-01', 'ngozi', 'fade-dark-marks', 'GB', 'high', 'dry', ['clear', 'a-little', 'some'], [['hd_pore', 'a-little']], reaction('fragrance'), 'gentle-cleanser', 'niacinamide-serum', 'hydrating-cream', 'mineral-spf'),
  person('hold-02', 'amara', 'calm-repair', 'NG', null, 'combination', ['clear', 'some', 'a-little'], [], NONE, 'steroid-cream', 'black-soap'),
  person('hold-03', null, 'glow', 'NG', 'mid', 'oily', ['some', 'a-little', 'faint'], [['hd_acne', 'a-little']], NONE),
  person('hold-04', 'tolu', 'brighter', 'NG', 'low', 'dry', ['a-little', 'clear', 'some'], [['hd_acne', 'some']], NONE, 'foaming-cleanser', 'black-soap', 'lightening-cream', 'retinol-serum', 'salicylic-gel', 'clay-mask', 'astringent-toner', 'shea-butter', 'mineral-spf'),
  person('hold-05', 'chidi', 'fade-dark-marks', 'NG', 'low', 'oily', ['some', 'clear', 'some'], [['hd_pore', 'clear'], ['hd_oiliness', 'some']], NONE, 'aftershave', 'salicylic-gel', 'black-soap'),
  person('hold-06', null, 'clear-skin', 'GB', 'mid', 'normal', ['a-little', 'some', 'faint'], [], PREGNANT, 'gentle-cleanser', 'mineral-spf'),
  person('hold-07', 'amara', 'even-tone', 'NG', 'low', 'dry', ['clear', 'some', 'a-little'], [['hd_acne', 'some']], reaction('fragrance'), 'lightening-cream', 'shea-butter', 'foaming-cleanser'),
  person('hold-08', 'ngozi', 'clear-skin', 'GB', 'high', 'combination', ['some', 'some', 'a-little'], [['hd_age_spot', 'clear']], prescription('tretinoin'), 'tretinoin-rx', 'gentle-cleanser', 'mineral-spf'),
  person('hold-09', null, 'calm-repair', 'GB', 'low', 'dry', ['some', 'clear', 'some'], [], BREASTFEEDING),
  person('hold-10', 'tolu', 'glow', 'NG', 'mid', 'combination', ['some', 'a-little', 'clear'], [['hd_acne', 'some']], NONE, 'black-soap', 'vitamin-c-serum', 'snail-essence', 'petroleum-jelly', 'chemical-spf'),
  person('hold-11', 'chidi', 'calm-repair', 'NG', 'mid', 'normal', ['some', 'some', 'a-little'], [], reaction('alcohol denat', 'fragrance'), 'aftershave', 'gel-moisturiser', 'gentle-cleanser'),
  person('hold-12', null, 'fade-dark-marks', 'NG', 'high', 'combination', ['clear', 'some', 'some'], [['hd_pore', 'a-little']], NONE, 'vitamin-c-serum', 'mineral-spf', 'retinol-serum'),
  person('hold-13', 'ngozi', 'brighter', 'GB', 'mid', 'oily', ['some', 'some', 'clear'], [['hd_acne', 'a-little'], ['hd_oiliness', 'some']], NONE),
  person('hold-14', 'amara', 'glow', 'NG', 'low', 'normal', ['faint', 'a-little', 'some'], [], NONE, 'lightening-cream', 'kojic-soap', 'shea-butter'),
  person('hold-15', null, 'clear-skin', 'NG', null, 'dry', ['a-little', 'faint', 'faint'], [], NONE, 'gentle-cleanser', 'hydrating-cream'),
  person('hold-16', 'tolu', 'fade-dark-marks', 'NG', 'low', 'combination', ['clear', 'clear', 'a-little'], [['hd_pore', 'some']], reaction('salicylic acid'), 'lemon-scrub', 'kojic-soap', 'rice-toner', 'cocoa-lotion'),
  person('hold-17', 'chidi', 'clear-skin', 'NG', null, 'oily', ['clear', 'clear', 'some'], [['hd_age_spot', 'some']], NONE, 'foaming-cleanser', 'salicylic-gel', 'clay-mask'),
  person('hold-18', 'ngozi', 'even-tone', 'GB', 'high', null, ['some', 'a-little', 'clear'], [], prescription('tretinoin'), 'tretinoin-rx', 'gentle-cleanser', 'mineral-spf', 'vitamin-c-serum'),
  person('hold-19', null, 'brighter', 'NG', 'high', 'dry', ['a-little', 'clear', 'some'], [], NONE, 'mineral-spf'),
  person('hold-20', 'amara', 'calm-repair', 'NG', 'low', 'oily', ['clear', 'a-little', 'clear'], [['hd_age_spot', 'a-little']], reaction('fragrance'), 'steroid-cream', 'petroleum-jelly', 'black-soap'),
  person('hold-21', null, 'glow', 'GB', 'low', 'combination', ['a-little', 'some', 'a-little'], [], NONE),
  person('hold-22', 'tolu', 'even-tone', 'NG', 'mid', 'dry', ['some', 'a-little', 'clear'], [['hd_oiliness', 'a-little']], NONE, 'black-soap', 'glycolic-toner', 'niacinamide-serum', 'cocoa-lotion', 'mineral-spf', 'rice-toner'),
  person('hold-23', 'chidi', 'glow', 'NG', 'high', 'combination', ['a-little', 'clear', 'some'], [['hd_pore', 'some']], NONE, 'gentle-cleanser', 'gel-moisturiser'),
  person('hold-24', null, 'fade-dark-marks', 'GB', 'mid', 'normal', ['some', 'a-little', 'some'], [], BREASTFEEDING, 'gentle-cleanser', 'mineral-spf'),
  person('hold-25', 'ngozi', 'calm-repair', 'GB', 'mid', 'combination', ['some', 'some', 'clear'], [['hd_acne', 'a-little']], reaction('fragrance', 'essential oils'), 'gentle-cleanser', 'hydrating-cream', 'glycolic-toner'),
  person('hold-26', null, 'clear-skin', 'GB', 'high', 'oily', ['some', 'clear', 'some'], [], NONE, 'retinol-serum', 'foaming-cleanser'),
  person('hold-27', 'amara', 'brighter', 'NG', null, 'dry', ['some', 'a-little', 'clear'], [], NONE, 'steroid-cream', 'gentle-cleanser', 'petroleum-jelly'),
  person('hold-28', 'tolu', 'calm-repair', 'NG', 'low', 'normal', ['clear', 'some', 'a-little'], [['hd_pore', 'a-little']], NONE, 'foaming-cleanser', 'glycolic-toner', 'vitamin-c-serum', 'lemon-scrub', 'cocoa-lotion'),
  person('hold-29', null, 'glow', 'NG', 'high', 'oily', ['clear', 'a-little', 'some'], [['hd_acne', 'some'], ['hd_oiliness', 'clear']], NONE, 'gentle-cleanser', 'mineral-spf', 'gel-moisturiser'),
  person('hold-30', 'chidi', 'fade-dark-marks', 'NG', 'mid', 'dry', ['clear', 'some', 'clear'], [['hd_pore', 'some']], NONE, 'black-soap', 'salicylic-gel', 'aftershave', 'petroleum-jelly'),
]
