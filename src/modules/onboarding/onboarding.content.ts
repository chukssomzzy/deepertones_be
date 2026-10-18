import { sha256Hex } from '../../lib/crypto'
import { once } from '../../lib/once'
import { answerFor, type GoalAnswer } from '../goals/goals.answers'
import { GOALS, type Goal } from '../goals/goals.vocabulary'
import { SAFETY_CHOICES, type SafetyChoice } from '../safety/safety.vocabulary'

// The words of onboarding screens 1.2 to 1.5 (goal, answer, safety), served by GET /api/v1/onboarding/content so that a copy change, a new chip
// or a new choice is a deploy and not an app release. Pure data, no I/O. The screen text is the mock text word for word; the ids come from the
// vocabularies the API itself validates (GOALS, SAFETY_CHOICES) and the answer cards from goals.answers, so a chip or a choice the app shows is
// always one the API accepts, and the answer words have one source.

type Field = { label: string; hint?: string }
type Choice = { id: string; label: string; field?: Field }

export type OnboardingContent = {
  locale: Locale
  contentVersion: string
  goalScreen: {
    title: string
    subtitle: string
    placeholder: string
    footnote: string
    continueLabel: string
    loginLabel: string
    chips: { id: Goal; label: string }[]
  }
  answerScreen: { subtitle: string; howLongLabel: string; helpsLabel: string; inTheWayLabel: string; continueLabel: string; changeLabel: string }
  answers: Record<Goal, Omit<GoalAnswer, 'note'>>
  /** Shown only when the user's own words asked to be lighter. */
  colourNote: string
  safetyScreen: { title: string; subtitle: string; footnote: string; continueLabel: string; choices: Choice[] }
}

/** The languages the copy is written in. Anything else is served in English. */
const LOCALES = ['en'] as const
type Locale = (typeof LOCALES)[number]

// DRAFT copy: the sixth chip needs owner review before launch (issue #82). Its label is not the calm-repair answer's title, which says "again".
const CHIP_LABELS: Record<Goal, string> = {
  'clear-skin': 'Clear skin',
  'even-tone': 'Even tone',
  'fade-dark-marks': 'Fade dark marks',
  brighter: 'Brighter, more even',
  glow: 'A glow',
  'calm-repair': 'Calm, healthy skin', // DRAFT
}

// A field is a text box under the choice; only the two that take words have one.
const CHOICES: Record<SafetyChoice, { label: string; field?: Field }> = {
  pregnant: { label: 'Pregnant' },
  breastfeeding: { label: 'Breastfeeding' },
  reaction: {
    label: 'A product gave me a reaction',
    // DRAFT copy: this field needs owner review before launch (issue #82).
    field: { label: 'Which product? (optional)', hint: 'Add the ingredient too if you know it.' },
  },
  prescription: { label: 'Using a prescription cream or tablets', field: { label: 'What is it? (optional)', hint: 'Product names help us check.' } },
  none: { label: 'None of these' },
}

const withoutVersion = (locale: Locale): Omit<OnboardingContent, 'contentVersion'> => {
  const colourNote = answerFor(GOALS[0], true).note
  if (colourNote === null) throw new Error('goals.answers has no colour note for someone who asked to be lighter')

  return {
    locale,
    goalScreen: {
      title: 'What do you want your skin to look like?',
      subtitle: "Say it your way. We'll tell you honestly what it takes.",
      placeholder: 'For example: clear skin',
      footnote: 'No account needed.',
      continueLabel: 'Continue',
      loginLabel: 'Login',
      chips: GOALS.map((id) => ({ id, label: CHIP_LABELS[id] })),
    },
    answerScreen: {
      subtitle: 'Here is what it usually takes.',
      howLongLabel: 'How long it takes',
      helpsLabel: 'What helps',
      inTheWayLabel: 'What gets in the way',
      continueLabel: 'Continue',
      changeLabel: 'Change my goal',
    },
    answers: Object.fromEntries(
      GOALS.map((goal) => {
        const { note: _note, ...plan } = answerFor(goal, false)
        return [goal, plan]
      }),
    ) as OnboardingContent['answers'],
    colourNote,
    safetyScreen: {
      title: "Anything that changes what's safe for you?",
      subtitle: "Some ingredients aren't safe in certain situations. Tell us, and we'll leave them out of everything.",
      footnote: 'You can change this any time in Settings.',
      continueLabel: 'Continue',
      choices: SAFETY_CHOICES.map((id) => ({ id, ...CHOICES[id] })),
    },
  }
}

/** JSON with object keys sorted, so the text (and so the hash) does not depend on the order fields are written in. Arrays keep their order. */
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** A hash of the content, locale included and chip and choice order included: any changed word, id or position is a new version. 16 hex digits are plenty for an ETag. */
export const contentVersionOf = async (content: Omit<OnboardingContent, 'contentVersion'>): Promise<string> =>
  (await sha256Hex(stableJson(content))).slice(0, 16)

// Built once per isolate: the content cannot change without a deploy, so hashing it on every request would be wasted work.
const build = (locale: Locale) =>
  once(async (): Promise<OnboardingContent> => {
    const content = withoutVersion(locale)
    return { ...content, contentVersion: await contentVersionOf(content) }
  })

const CONTENT: Record<Locale, () => Promise<OnboardingContent>> = { en: build('en') }

/** The content in the asked-for language; a language that does not ship yet (and any spelling but exactly `en`) is served in English. */
export const contentFor = (locale: string): Promise<OnboardingContent> => CONTENT[(LOCALES as readonly string[]).includes(locale) ? (locale as Locale) : 'en']()
