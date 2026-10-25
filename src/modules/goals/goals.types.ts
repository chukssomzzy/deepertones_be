import type { GoalAnswer } from './goals.answers'
import type { SafetyView } from '../safety/safety.types'
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
export type OnboardingStep = 'goal' | 'safety' | 'shelf'

export type OnboardingView = {
  goal: GoalView | null
  /** The profile's current safety answers, null until it answers (even before the goal is set). */
  safety: SafetyView | null
  next: OnboardingStep
}

/** What switching to a goal would do, worked out from the goal history alone (issue #145). `dayOneAt` and `resumeUntil` are null for a fresh start. */
export type SwitchPreviewView = {
  goal: Goal
  outcome: 'resume' | 'fresh'
  /** When the chase's first ready scan was taken, or null when it has none. */
  dayOneAt: Date | null
  /** The last moment the goal can be taken up again and still continue its chase. */
  resumeUntil: Date | null
}
