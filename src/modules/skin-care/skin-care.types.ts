import type { Frequency, IngredientGroup, RoutineStep } from '../catalog/catalog.vocabulary'
import type { escalationHolds, skinLogs, stepPauses } from './skin-care.table'
import type { SkinCareProductRef } from './skin-care.vocabulary'

export type { SkinCareProductRef }

// The narrow shapes the skin-care module reads the routine through, and is given back by. This module owns them so it never imports routines: `RoutineViewerService.skinCareRoutineFor`
// answers a SkinCareRoutine, and the viewer is handed a SkinCareState by `stateFor`. Routines imports these types, never the other way.

/** One step of the routine in force, with the facts a pause or a reaction call is made from. */
export type SkinCareRoutineStep = {
  step: RoutineStep
  /** The routine's plain title for the step, as the screen shows it. */
  title: string
  productRef: SkinCareProductRef
  /** The catalog product the step names: the shelf entry's, or the recommended row's. Null for an entry with no label and for "use what you have". */
  productId: string | null
  /** The calendar day ('YYYY-MM-DD') the step's product last changed; day 1 when it has no day of its own, and null while the routine is not started. */
  changedOn: string | null
  /** The active ingredient groups the product holds: retinoid, exfoliating-acid and benzoyl-peroxide only, in vocabulary order. */
  activeGroups: IngredientGroup[]
}

/** The routine in force, as skin-care reads it. */
export type SkinCareRoutine = {
  /** Day 1 ('YYYY-MM-DD'); null before Start. */
  dayOne: string | null
  steps: SkinCareRoutineStep[]
  /** Whether a dated step-down is still running today. */
  stepDownRunning: boolean
}

/**
 * What skin-care says about a profile on a local day: the pauses that change an entry's place in the routine, and whether an escalation hold is open. A step being brought back also says
 * which rung it is on (`rung`, counting from 1) and how many rungs there are before it is back (`of`), for the line "step n of m". A paused step says which pause it is (`pauseId`) and
 * the day it is checked (`checkDay`), for the line "we'll ask on {day}".
 */
export type SkinCareState = {
  pauses: { step: RoutineStep; productId: string; state: 'paused' | 'bringing-back'; frequency?: Frequency; anchor?: string; rung?: number; of?: number; pauseId?: string; checkDay?: string }[]
  held: boolean
}

export type SkinLog = typeof skinLogs.$inferSelect

/** A log as the service makes it: the caller makes the id and the time, and a new log is never overridden. */
export type NewSkinLog = Omit<SkinLog, 'overridden'>

export type StepPause = typeof stepPauses.$inferSelect

/** A pause as the service makes it: the caller makes the id and the time, and every column is given. */
export type NewStepPause = StepPause

export type EscalationHold = typeof escalationHolds.$inferSelect

/** A hold as the service makes it: the caller makes the id and the times, and a new hold is open. */
export type NewEscalationHold = Omit<EscalationHold, 'closedAt' | 'closedHow'>
