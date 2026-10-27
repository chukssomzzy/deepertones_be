import { TRAITS, type Trait } from '../catalog/catalog.vocabulary'

// The goals a user can pick are the goals a product can be tagged with: the catalog's "goal:" traits, minus the prefix and in the
// same order (the order the chips show them). Reading them from there means the two lists cannot drift apart; goals.vocabulary.test.ts
// pins it.
const PREFIX = 'goal:'
type GoalTrait = Extract<Trait, `${typeof PREFIX}${string}`>

export type Goal = GoalTrait extends `${typeof PREFIX}${infer G}` ? G : never

// A tuple type, because drizzle's column enum and zod's enum both need a non-empty list. The filter cannot say so to the compiler.
export const GOALS = TRAITS.filter((trait): trait is GoalTrait => trait.startsWith(PREFIX)).map((trait) => trait.slice(PREFIX.length)) as unknown as readonly [Goal, ...Goal[]]

// DRAFT copy: the sixth label is new words nobody has reviewed yet (issue #82), and is not the calm-repair answer's title, which says "again".
// DRAFT_COPY (onboarding.content.ts) lists it for the owner to find before launch.
/** What a goal is called on a screen: the goal chips and the routine's "Your plan is ready" summary both read this one map, so the two cannot say different things. */
export const GOAL_LABELS: Record<Goal, string> = {
  'clear-skin': 'Clear skin',
  'even-tone': 'Even tone',
  'fade-dark-marks': 'Fade dark marks',
  brighter: 'Brighter, more even',
  glow: 'A glow',
  'calm-repair': 'Calm, healthy skin', // DRAFT
}
