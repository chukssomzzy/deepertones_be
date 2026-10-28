import type { profileSafety, safetyMentions, safetyReads } from './safety.table'

export type SafetyRow = typeof profileSafety.$inferSelect
export type ParseState = SafetyRow['parseState']

export type SafetyMentionRow = typeof safetyMentions.$inferSelect
export type MentionSource = SafetyMentionRow['source']
/** The two texts the parse reads; `skin-log` marks are never read from words, so they have no read record. */
export type ReadSource = typeof safetyReads.$inferSelect['source']

/** A profile's current safety answers as the app sees them. */
export type SafetyView = {
  choices: SafetyRow['choices']
  reactionText: string | null
  prescriptionText: string | null
  /** True for pregnant or breastfeeding: ingredients unsafe in either are left out of everything. */
  excludesPregnancyCaution: boolean
  updatedAt: Date
}
