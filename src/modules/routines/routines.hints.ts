import { outcomeHint, type OutcomeCounts } from './routines.outcomes'
import type { RoutineSkeleton, SkeletonCandidate } from './routines.types'

// A candidate with no counts row, or whose counts are corrupt (outcomeHint throws), has no hint: a bad row must cost one hint, not the routine. A corrupt
// row is a bug upstream, so its code is passed to `onCorrupt` for the caller to log (never the numbers).
const hintOf = (code: string, counts: Map<string, OutcomeCounts>, onCorrupt: (code: string) => void): SkeletonCandidate['outcomeHint'] => {
  const row = counts.get(code)
  if (!row) return null
  try {
    return outcomeHint(row)
  } catch {
    onCorrupt(code)
    return null
  }
}

/**
 * The skeleton with each gap candidate's `outcomeHint` filled from `counts` (by catalog code) and `hintsShown` set to `shown`. When `shown` is false every
 * hint is null and `counts` is not read. Pure: the skeleton it is given is not changed; `onCorrupt` hears the code of each corrupt counts row.
 */
export const applyOutcomeHints = (
  skeleton: RoutineSkeleton,
  counts: Map<string, OutcomeCounts>,
  shown: boolean,
  onCorrupt: (code: string) => void = () => {},
): RoutineSkeleton => ({
  ...skeleton,
  gaps: skeleton.gaps.map((gap) => ({
    ...gap,
    candidates: gap.candidates.map((candidate) => ({ ...candidate, outcomeHint: shown ? hintOf(candidate.code, counts, onCorrupt) : null })),
  })),
  hintsShown: shown,
})
