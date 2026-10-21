import type { Goal } from '../goals/goals.vocabulary'

export type ScanVerdict = { allowed: true } | { allowed: false; reason: 'already-scanned-for-goal' }

/**
 * Whether a profile may start a face scan now. Today: when it has no face scan, or its latest was taken under another goal than the one it
 * has now. (A later check-in schedule adds a third reason.) Pure: the service reads the goal and the latest scan and asks.
 */
export const mayScanNow = ({ goal, latest }: { goal: Goal; latest: { goalAtScan: Goal } | null }): ScanVerdict =>
  latest && latest.goalAtScan === goal ? { allowed: false, reason: 'already-scanned-for-goal' } : { allowed: true }
