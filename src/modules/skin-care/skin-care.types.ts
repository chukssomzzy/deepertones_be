import type { Frequency, IngredientGroup, RoutineStep } from '../catalog/catalog.vocabulary'

// The narrow shapes the skin-care module reads the routine through, and is given back by. This module owns them so it never imports routines: `RoutineViewerService.skinCareRoutineFor`
// answers a SkinCareRoutine, and the viewer is handed a SkinCareState by `stateFor`. Routines imports these types, never the other way.

/** The product a stored routine step names, restated here so skin-care does not import routines: a shelf entry, a recommended product by code, or "use what you have". */
export type SkinCareProductRef = { kind: 'shelf'; id: string } | { kind: 'candidate'; code: string } | { kind: 'none' }

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

/** What skin-care says about a profile on a local day: the pauses that change an entry's place in the routine, and whether an escalation hold is open. */
export type SkinCareState = {
  pauses: { step: RoutineStep; productId: string; state: 'paused' | 'bringing-back'; frequency?: Frequency; anchor?: string }[]
  held: boolean
}
