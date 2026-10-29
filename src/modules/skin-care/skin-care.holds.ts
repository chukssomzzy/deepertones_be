import type { RoutineStep } from '../catalog/catalog.vocabulary'
import type { SkinCareRoutine } from './skin-care.types'

/**
 * The steps an open escalation hold keeps out of the routine: those whose product holds an active ingredient group, in the routine's order. Sunscreen (`protect`) is never held,
 * whatever it holds, and the basics carry on. A step-down is not in `routine.steps`, so it carries on too. [] when there is no hold.
 */
export const heldSteps = (routine: SkinCareRoutine, held: boolean): RoutineStep[] =>
  held ? routine.steps.filter((s) => s.step !== 'protect' && s.activeGroups.length > 0).map((s) => s.step) : []
