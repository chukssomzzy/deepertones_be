import type { GateFailure, Routine, RoutineSkeleton } from '../../modules/routines/routines.types'

/** What a second attempt is told: the gates the previous routine failed (codes and steps only, never the failed routine). An empty list is no retry. */
export type RoutineRetry = { failed: GateFailure[] }

/**
 * Turns a routine skeleton (what the rules decided) into a routine in the person's words.
 * Adapters throw their vendor's errors for failures the caller can act on, and never return a partial routine.
 */
export interface RoutineWriter {
  /** Writes a routine for the skeleton, told what a previous attempt failed when `retry` is given. The caller checks it with checkRoutine before anything uses it. */
  write(skeleton: RoutineSkeleton, retry?: RoutineRetry): Promise<Routine>
}
