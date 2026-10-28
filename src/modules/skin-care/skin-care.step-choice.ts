import type { RoutineStep } from '../catalog/catalog.vocabulary'
import type { SkinCareRoutine, SkinCareRoutineStep } from './skin-care.types'

// Which of two steps changed on one day is paused first: the treatment, then the cleanser, then the moisturiser. The sunscreen is never in it.
const TIE_ORDER: readonly RoutineStep[] = ['treat', 'cleanse', 'moisturise']

/**
 * What a pause on a step is held under: the catalog product id of the step's product, else the id of the person's own shelf entry (a product with no label has no catalog
 * product). Null for a step with nothing to key a pause by (a recommendation whose product has left the catalog, or "use what you have"): it cannot be paused, and the routine
 * could not show it as paused. Never '', which is the key of the "nothing to pause" row. The routine's overlay computes the same key.
 */
export const pauseKeyOf = (entry: SkinCareRoutineStep): string | null => entry.productId ?? (entry.productRef.kind === 'shelf' ? entry.productRef.id : null)

/**
 * The step a pause is for (spec #233): never the sunscreen, and never a step that already has a pause open (matched by step alone). Among the active steps (those whose product
 * holds an active ingredient) the one that changed most recently; with no active step left, the most recently changed of the rest. A `changedOn` of null is day 1, and a tie
 * on the day goes treat, then cleanse, then moisturise. Null when nothing is left to pause. A step-down product is never in `routine.steps`, so it is never chosen.
 */
// A `bringing-back` or `escalated` row holds its step here (the service passes every open pause). The service re-pauses a step being brought back before it asks for a step to pause,
// so this never sees a step it should have turned back into `paused`.
export const stepToPause = (routine: SkinCareRoutine, openPauses: readonly { step: RoutineStep | null }[]): SkinCareRoutineStep | null => {
  const taken = new Set(openPauses.flatMap(({ step }) => (step === null ? [] : [step])))
  const pausable = routine.steps.filter(({ step }) => step !== 'protect' && !taken.has(step))
  const active = pausable.filter(({ activeGroups }) => activeGroups.length > 0)
  const pool = active.length > 0 ? active : pausable
  const dayOf = (entry: SkinCareRoutineStep) => entry.changedOn ?? routine.dayOne ?? ''
  return (
    [...pool].sort((a, b) => dayOf(b).localeCompare(dayOf(a)) || TIE_ORDER.indexOf(a.step) - TIE_ORDER.indexOf(b.step))[0] ?? null
  )
}
