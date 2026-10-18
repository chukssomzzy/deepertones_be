import { TRAITS, type Trait } from '../catalog/catalog.vocabulary'

// The goals a user can pick are the goals a product can be tagged with: the catalog's "goal:" traits, minus the prefix and in the
// same order (the order the chips show them). Reading them from there means the two lists cannot drift apart; goals.vocabulary.test.ts
// pins it.
const PREFIX = 'goal:'
type GoalTrait = Extract<Trait, `${typeof PREFIX}${string}`>

export type Goal = GoalTrait extends `${typeof PREFIX}${infer G}` ? G : never

// A tuple type, because drizzle's column enum and zod's enum both need a non-empty list. The filter cannot say so to the compiler.
export const GOALS = TRAITS.filter((trait): trait is GoalTrait => trait.startsWith(PREFIX)).map((trait) => trait.slice(PREFIX.length)) as unknown as readonly [Goal, ...Goal[]]
