import type { Frequency, ProductForm, RoutineStep } from '../catalog/catalog.vocabulary'
import { answerFor } from '../goals/goals.answers'
import type { Goal } from '../goals/goals.vocabulary'
import { FORBIDDEN_WORDING } from './routines.wording'

// DRAFT copy: needs owner review before launch, like the goal answers.
//
// The words of the rules-only routine (what the app saves when the writer cannot be used). One fixed line per step and kind of entry, so a line is about the
// product's place in the routine, never about the person and never names a product, a condition or a result. Every line must pass the wording gate
// (routines.wording.ts); the rules-only test checks them all.

export type ReasonKind = 'kept' | 'reduced' | 'recommended' | 'none'

const REASONS: Record<RoutineStep, Record<ReasonKind, string>> = {
  cleanse: {
    kept: 'Your cleanser, used as it is.',
    reduced: 'Your cleanser, used less often so it stays gentle.',
    recommended: 'A gentle cleanser that cleans the skin without stripping it.',
    none: 'Use the cleanser you have, a gentle one if you can.',
  },
  treat: {
    kept: 'Your treatment product, used as it is.',
    reduced: 'Your treatment product, used less often so it stays gentle.',
    recommended: 'A treatment product, used at a gentle pace.',
    none: 'No product to add for this step. Use what you have, or skip it.',
  },
  moisturise: {
    kept: 'Your moisturiser, used as it is.',
    reduced: 'Your moisturiser, used less often so it stays gentle.',
    recommended: 'A simple moisturiser that keeps the skin soft and comfortable.',
    none: 'Use the moisturiser you have, a plain one if you can.',
  },
  protect: {
    kept: 'Your sunscreen, used as it is.',
    reduced: 'Your sunscreen, used less often so it stays gentle.',
    recommended: 'A daily sunscreen that protects the skin from the sun.',
    none: 'Use the sunscreen you have each morning.',
  },
}

export const reasonFor = (step: RoutineStep, kind: ReasonKind): string => REASONS[step][kind]

const WHEN: Record<Frequency, string> = {
  am: 'Every day',
  pm: 'Every day',
  'am-pm': 'Every day',
  'alternate-days': '3 evenings a week',
  weekly: 'Once a week',
  'as-needed': 'When you need it',
}

/** The "when" label of a routine card. */
export const whenFor = (frequency: Frequency): string => WHEN[frequency]

// The forms that name a treatment better than "Treatment" does. A cleanser takes the form before its noun for its own list, and is plain "Cleanser" for the rest.
const TREAT_FORMS: readonly ProductForm[] = ['cream', 'lotion', 'gel', 'serum', 'oil', 'balm']
const CLEANSER_FORMS: readonly ProductForm[] = ['gel', 'cream', 'lotion', 'oil', 'balm', 'bar']

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * The plain name of a product on the routine screen, built by rules and never by the AI, with a capital and no full stop. The step's noun ("Cleanser", "Treatment",
 * "Moisturiser", "Sunscreen") unless the form names the product better: a sunscreen is always "Sunscreen"; a treatment is "Serum", "Cream" and so on; a cleanser is
 * "Gel cleanser" and so on; a moisturiser is "Moisturiser" whatever its form, except a gel. A key ingredient goes in front of the noun ("Niacinamide serum",
 * "Salicylic acid gel cleanser", "Shea butter moisturiser"). A product with no step is its form ("Cream"), or "Product" when that is not known either.
 */
export const titleFor = ({ step, form, keyIngredient }: { step: RoutineStep | null; form: ProductForm | null; keyIngredient?: string | null }): string => {
  const noun = ((): string => {
    if (step === null) return form === null ? 'Product' : capitalised(form)
    if (step === 'protect') return 'Sunscreen'
    if (step === 'moisturise') return form === 'gel' ? 'Gel moisturiser' : 'Moisturiser'
    if (step === 'treat') return form !== null && TREAT_FORMS.includes(form) ? capitalised(form) : 'Treatment'
    return form !== null && CLEANSER_FORMS.includes(form) ? `${capitalised(form)} cleanser` : 'Cleanser'
  })()
  // The key ingredient is free text from the workbook: trailing stops and spaces are not part of a name.
  const ingredient = keyIngredient?.replace(/[\s.]+$/, '').trim()
  if (!ingredient) return noun
  // A moisturiser with a key ingredient is "{ingredient} moisturiser" whatever its form: "Shea butter moisturiser", not "Shea butter gel moisturiser".
  const rest = step === 'moisturise' ? 'moisturiser' : noun.toLowerCase()
  // An ingredient that already ends with the noun ("Vitamin C serum") is the title, not "Vitamin C serum serum".
  const title = capitalised(new RegExp(`(?:^|\\s)${rest}$`, 'i').test(ingredient) ? ingredient : `${ingredient} ${rest}`)
  // A title never says what the wording gate forbids, whatever the catalog's words: the ingredient is dropped and the plain noun stands.
  return FORBIDDEN_WORDING.some(({ pattern }) => pattern.test(title)) ? noun : title
}

/** What to expect and when: the goal's own answer, so the routine and the goal screen never say different things. */
export const expectationFor = (goal: Goal): string => answerFor(goal, false).howLong

// The owner's text for the "Your plan is ready" step-down card. The sentence passes the wording gate; the names put into it might not (a product's name is the maker's
// own words, e.g. "Skin Whitening Cream"), so `stepDownMessage` swaps in a generic subject for any set of names the gate would catch.
const STEP_DOWN_MESSAGE = (names: string): string => `Stopping ${names} suddenly can make your skin flare. We'll take it step by step, so the rough days are expected, not a surprise.`

/** The step-down card's sentence for the products being stopped (brand and name, or the name alone), in order: "X", "X and Y", or "X, Y and N more". */
export const stepDownMessage = (products: readonly { brand: string | null; name: string }[]): string => {
  const names = products.map(({ brand, name }) => (brand ? `${brand} ${name}` : name))
  const [first, second, ...rest] = names
  if (first === undefined) throw new Error('stepDownMessage needs at least one product')
  if (names.some((name) => FORBIDDEN_WORDING.some(({ pattern }) => pattern.test(name)))) return STEP_DOWN_MESSAGE(names.length === 1 ? 'this product' : 'these products')
  if (second === undefined) return STEP_DOWN_MESSAGE(first)
  if (rest.length === 0) return STEP_DOWN_MESSAGE(`${first} and ${second}`)
  return STEP_DOWN_MESSAGE(`${first}, ${second} and ${rest.length} more`)
}
