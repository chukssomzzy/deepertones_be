import type { Frequency, TaperKind } from '../catalog/catalog.vocabulary'
import type { VerdictGroup } from './verdicts.merge'

// The words of the verdict screen, apart from `verdicts.copy.ts` (which `verdicts.merge.ts` imports, and this file imports the merge's `VerdictGroup`: one file would be a cycle).

// --- Copy awaiting the owner's sign-off ---
// The verdict screen's headings (spec #259, screen 7.1) and what to do with each product. Fixed text, worked out by rules and never by a model. Titles and
// subtitles are the owner's where the screen has them; the rest is written in the same voice. Each intro is about the products, never the person. Every table
// below is a Record over its vocabulary, so a new group, frequency or step-down kind is a compile error until it has words.

// A guest's locked preview carries these words too, so an intro says "these" and never the word "products": the preview must hold nothing that reads as the shelf.
export type GroupCopy = { title: string; subtitle: string; intro: string }

export const GROUP_COPY: Record<VerdictGroup, GroupCopy> = {
  'likely-the-problem': {
    title: 'Likely the problem',
    subtitle: "What's causing trouble",
    intro: 'Each of these is likely to cause or worsen trouble. What to do with each is listed below.',
  },
  conflicting: {
    title: 'Conflicting',
    subtitle: "Don't work well together",
    intro: 'These work against each other when used together. Using one of them less often usually helps.',
  },
  'cant-tell': {
    title: "Can't tell what's in it",
    subtitle: 'Not enough to read yet',
    intro: 'We could not read what is in these, so they are set aside for now. A photo of the back label lets us check them.',
  },
  blocking: {
    title: 'Blocking your goal',
    subtitle: 'Holding your goal back',
    intro: 'These work against the goal that was set. Setting them aside should help the goal along.',
  },
  redundant: {
    title: 'Redundant',
    subtitle: 'Doing the same job as another',
    intro: 'Each of these does the same job as another one. One of the two is enough.',
  },
  helping: {
    title: 'Helping',
    subtitle: 'Working toward your goal',
    intro: 'These do something useful toward the goal. They are fine to keep using.',
  },
  prescribed: {
    title: 'Prescribed',
    subtitle: "Kept on the prescriber's advice",
    intro: "These look like ones a doctor prescribed. The prescriber's instructions come first.",
  },
  undecided: {
    title: 'Still checking',
    subtitle: 'Not decided yet',
    intro: 'These are still being checked against the goal. They stay as they are until that is done.',
  },
}

/** The order the screen shows the groups in. */
export const GROUP_ORDER = ['likely-the-problem', 'conflicting', 'cant-tell', 'blocking', 'redundant', 'helping', 'prescribed', 'undecided'] as const satisfies readonly VerdictGroup[]

// A group missing from GROUP_ORDER makes this `never` assignment fail to compile.
const _everyGroupIsOrdered: Exclude<VerdictGroup, (typeof GROUP_ORDER)[number]> extends never ? true : never = true
void _everyGroupIsOrdered

export const KEEP_SUGGESTION = 'Keep using it.'

const FREQUENCY_SUGGESTION: Record<Frequency, string> = {
  am: 'Use it in the morning only.',
  pm: 'Use it in the evening only.',
  'am-pm': 'Use it no more than once in the morning and once in the evening.',
  'alternate-days': 'Use it no more than every other day.',
  weekly: 'Use it no more than once a week.',
  'as-needed': 'Use it only when it is needed.',
}

/** The line for a reduced product: the most often it should be used. */
export const reduceSuggestion = (maxFrequency: Frequency): string => FREQUENCY_SUGGESTION[maxFrequency]

// Named by the step-down's kind and consistent with STEROID_STEP_DOWN and LIGHTENING_STEP_DOWN in verdicts.copy.ts: never "stop now", as stopping suddenly is what sends people back.
const STOP_SUGGESTION: Record<TaperKind, string[]> = {
  steroid: ['Step it down on the steroid schedule.', 'Never stop it suddenly, as that can cause a flare.'],
  'lightening-agent': ['Step it down on the lightening schedule.', 'Never stop it suddenly, as that can darken skin.'],
}

/** The lines for a stopped product, from its step-down's kind; without the template (not expected, as the verdict carries every one it uses) the lines name no kind. */
export const stopSuggestion = (kind: TaperKind | undefined): string[] =>
  kind === undefined ? ['Step it down gradually, using it less often each week.', 'Never stop it suddenly.'] : STOP_SUGGESTION[kind]

export const DROP_SUGGESTION = 'Stop using it now.'
export const ESCALATE_SUGGESTION = 'See a professional about it.'
export const PHOTOGRAPH_SUGGESTION = 'Photograph the back label so we can read it.'
