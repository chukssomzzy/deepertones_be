import { ROUTINE_STEPS, type Frequency, type RoutineStep } from '../catalog/catalog.vocabulary'
import type { Goal } from '../goals/goals.vocabulary'
import type { SkeletonGap } from './routines.types'

/** Recorded on every routine built, so a routine can be traced to the rules that shaped it. Change it whenever a rule here changes. */
export const ROUTINE_RULES_VERSION = '1'

/** How often, from least to most. am and pm are the same rank: neither is more than the other. */
export const FREQUENCY_RANK: Record<Frequency, number> = {
  'as-needed': 0,
  weekly: 1,
  'alternate-days': 2,
  am: 3,
  pm: 3,
  'am-pm': 4,
}

/** The steps a goal's routine uses, in routine order. Every goal uses all four today; this is the one place to tune that per goal. */
export const routineStepsFor = (_goal: Goal): RoutineStep[] => [...ROUTINE_STEPS]

/** The frequencies each step may be written with, the most usual first. */
export const ROUTINE_ALLOWED_FREQUENCIES: Record<RoutineStep, Frequency[]> = {
  cleanse: ['am', 'pm', 'am-pm'],
  treat: ['pm', 'alternate-days', 'weekly', 'am', 'am-pm'],
  moisturise: ['am', 'pm', 'am-pm'],
  protect: ['am'],
}

/**
 * The most distinct new products a routine may ask the person to buy: one per gap that has a candidate. The writer's prompt promises the skeleton always allows
 * enough new products to fill its gaps, and the gap gate needs every gap that has candidates filled.
 */
export const maxNewProductsFor = (gaps: SkeletonGap[]): number => gaps.filter((gap) => gap.candidates.length > 0).length

/**
 * The most frequent of `allowed` whose rank is within a reduced product's cap, or null when none is (a cleanser capped at weekly: every usual cleanse frequency
 * is more often than that). On equal rank the first in `allowed` wins.
 */
export const reducedFrequencyFor = (allowed: readonly Frequency[], maxFrequency: Frequency): Frequency | null => {
  let best: Frequency | null = null
  for (const frequency of allowed) {
    if (FREQUENCY_RANK[frequency] > FREQUENCY_RANK[maxFrequency]) continue
    if (best === null || FREQUENCY_RANK[frequency] > FREQUENCY_RANK[best]) best = frequency
  }
  return best
}
