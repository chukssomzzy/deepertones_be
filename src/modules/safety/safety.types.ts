import type { profileSafety } from './safety.table'

export type SafetyRow = typeof profileSafety.$inferSelect

/** A profile's current safety answers as the app sees them. */
export type SafetyView = {
  choices: SafetyRow['choices']
  reactionText: string | null
  prescriptionText: string | null
  /** True for pregnant or breastfeeding: ingredients unsafe in either are left out of everything. */
  excludesPregnancyCaution: boolean
  updatedAt: Date
}
