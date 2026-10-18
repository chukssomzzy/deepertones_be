import type { GoalAnswer } from './goals.answers'
import type { profileGoals } from './goals.table'
import type { Goal } from './goals.vocabulary'

export type GoalRow = typeof profileGoals.$inferSelect

/** A profile's current goal as the app sees it. The answer is worked out from the row when it is read, never stored. */
export type GoalView = {
  goal: Goal | null
  wantsLighter: boolean
  text: string | null
  /** Null while there is no goal: typed words nobody sorted into one yet get no answer. */
  answer: GoalAnswer | null
  answersVersion: number
  updatedAt: Date
}

/** Which first-run step comes next. */
export type OnboardingStep = 'goal' | 'safety'

export type OnboardingView = {
  goal: GoalView | null
  /** Always null until the safety answers are built. */
  safety: null
  next: OnboardingStep
}
