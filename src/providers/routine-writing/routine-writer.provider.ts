import type { Routine, RoutineSkeleton } from '../../modules/routines/routines.types'

/**
 * Turns a routine skeleton (what the rules decided) into a routine in the person's words.
 * Adapters throw their vendor's errors for failures the caller can act on, and never return a partial routine.
 */
export interface RoutineWriter {
  /** Writes a routine for the skeleton. The caller checks it with checkRoutine before anything uses it. */
  write(skeleton: RoutineSkeleton): Promise<Routine>
}
