import type { IngredientGroup } from '../catalog/catalog.vocabulary'
import type { SafetyChoice } from '../safety/safety.vocabulary'
import type { FloorEntry, FloorFact } from './verdicts.floor'

// The words of a verdict the rules floor decided (spec #171): one plain sentence for each kind of fact, about the product and never the person (CONTEXT: no
// "you are / you have", no scores, never lightness). Worked out by fixed rules, never by a model, so the same fact is always the same words.

type Fixed = Extract<FloorEntry, { status: 'fixed' }>

const PRESCRIBER_NOTE = 'If a doctor prescribed this, keep following their instructions.'

// The whole reason, note included, is at most 200 characters (the fit judge's limit too). The note takes 64 of them, so a name from a label or from the user is
// cut to keep the longest template inside the rest. A rule's canonical name is short enough to stay whole; a label's long wording is why the reasons name the
// rule and not the label.
const MAX_NAME = 30

const named = (text: string): string => (text.length <= MAX_NAME ? text : `${text.slice(0, MAX_NAME - 1).trimEnd()}…`)

// Rule names are stored lowercase; in a sentence they read as a name. The user's own words and a label's phrases are left as they were written.
const ruleNamed = (ruleName: string): string => named(ruleName.replace(/(^|\s)\p{L}/gu, (start) => start.toUpperCase()))

// A step-down is never "stop now": stopping these suddenly is what causes the flare or the darkening that sends people back.
const STEROID_STEP_DOWN = 'step it down gradually, as stopping suddenly can cause a flare'
const LIGHTENING_STEP_DOWN = 'step it down gradually, as stopping suddenly can darken skin'

const factReason = (fact: FloorFact): string => {
  switch (fact.kind) {
    case 'ingredient-group':
      if (fact.group === 'mercury') return `Stop using this now: it contains ${ruleNamed(fact.ruleName)}, which can poison the body, so see a professional.`
      if (fact.group === 'steroid') return `It contains ${ruleNamed(fact.ruleName)}, a steroid: ${STEROID_STEP_DOWN}.`
      if (fact.group === 'lightening-agent') return `It contains ${ruleNamed(fact.ruleName)}, a skin-lightening ingredient: ${LIGHTENING_STEP_DOWN}.`
      throw new Error(`No reason is written for a floor decision on the ingredient group ${fact.group}`)
    case 'claim-phrase':
      return `It is sold as "${named(fact.phrase)}", a skin-lightening claim: ${LIGHTENING_STEP_DOWN}.`
    case 'no-label-purpose':
      return `It is described as used for lightening: ${LIGHTENING_STEP_DOWN}.`
    case 'banned-substance':
      // Hedged: a ban differs by country, so the copy says what is true of many of them and claims no law.
      return `Stop using this now: ${ruleNamed(fact.ruleName)} is not allowed in cosmetics in many countries.`
    case 'reaction-product':
      return 'Stop using this now: it is the product you reacted to.'
    case 'reaction-ingredient':
      return `Stop using this now: it contains ${named(fact.named)}, an ingredient you reacted to.`
    case 'pregnancy-caution':
      return `Leave this out while pregnant or breastfeeding: it contains ${named(fact.ingredient)}.`
    case 'unknown-contents':
      return "We can't read what is in this one, so it is set aside: photograph the back label to check it."
    case 'prescription':
      return "Keep following your prescriber's instructions, and talk to your doctor before changing how you use it."
  }
}

// Where the product could be the user's own prescribed cream: a step-down (steroid, lightening agent, claim phrase, a no-label lightener) or a product set aside
// as unreadable, since the floor cannot match those to a prescription. Where it is dangerous or unwanted whoever prescribed it (mercury, a banned ingredient, a
// reaction, a pregnancy caution) the note would soften the stop, and a prescribed product already says so.
const mayBePrescribed = (fact: FloorFact): boolean => {
  switch (fact.kind) {
    case 'ingredient-group':
      return fact.group === 'steroid' || fact.group === 'lightening-agent'
    case 'claim-phrase':
    case 'no-label-purpose':
    case 'unknown-contents':
      return true
    default:
      return false
  }
}

/**
 * The reason for a product the floor decided, from its first fact. When the profile ticked prescription, a reason where the product may be the user's own
 * prescribed cream (see `mayBePrescribed`) adds the prescriber note.
 */
export const floorReason = (entry: Fixed, choices: readonly SafetyChoice[] = []): string => {
  const [first] = entry.facts
  if (!first) throw new Error(`Floor entry ${entry.id} has no fact to give a reason from`)
  const reason = factReason(first)
  return mayBePrescribed(first) && choices.includes('prescription') ? `${reason} ${PRESCRIBER_NOTE}` : reason
}

const plain = (group: IngredientGroup): string => group.replaceAll('-', ' ')

/** The reason for the one product of a clashing pair that is reduced: its own group first, the other product's second. */
export const clashReason = ([own, other]: [IngredientGroup, IngredientGroup]): string =>
  `Best used on alternate days, because its ${plain(own)} works against the ${plain(other)} in another product on the shelf.`

// --- Copy awaiting the owner's sign-off ---
// "Where this comes from" (spec #259, screen 7.1): the fixed line of each basis that is not a reviewed rule's own words. Here and not in verdicts.screen-copy.ts,
// which imports the merge that builds a basis (a cycle). About the product, never the person, and no line calls the checker's fit a reviewed rule, which it is not.
// Every one passes FORBIDDEN_WORDING (pinned in verdicts.basis.test.ts).
export const TOLD_US_REACTION_LINE = 'You told us your skin reacted to this product.'
export const TOLD_US_PRESCRIPTION_LINE = 'You told us a doctor prescribed this.'
export const NO_LABEL_PURPOSE_LINE = 'You told us this product is for lightening, and we cannot see what is in it, so we treat it with caution. This is about the product, not about you.'
export const NO_LABEL_UNKNOWN_LINE = 'We cannot see what is in this product, so we treat it with caution. This is about the product, not about you.'
export const FIT_LINE = 'Matched against your goal by our checker.'

// The phrase is the workbook's own word, which can itself be one the wording gate forbids ("whitening"), so only the words around it are gated: they say what the
// phrase is without using a forbidden one.
export const claimWordStatement = (phrase: string): string => `Its name says "${phrase}", a claim about changing skin colour.`
