import type { Goal } from '../../modules/goals/goals.vocabulary'

export type GoalReading = {
  /** The goal the words say, or null when they say none the app offers. */
  goal: Goal | null
  /** The words ask to be lighter, fairer or whiter. When true, `goal` is `brighter`. */
  wantsLighter: boolean
}

/**
 * Sorts words a user typed about their skin ("make my face clear") into one of the five goals.
 * Adapters throw their vendor's errors for failures the caller can act on; "no goal in these words" is a result, not an error.
 */
export interface GoalReader {
  read(text: string): Promise<GoalReading>
}
