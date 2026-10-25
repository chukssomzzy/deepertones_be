import type { RoutineStep } from '../catalog/catalog.vocabulary'
import type { Band, ShownConcern, SkinTypeLabel } from '../face-scans/face-scans.tables'
import type { Goal } from '../goals/goals.vocabulary'
import type { ParseState } from '../safety/safety.types'
import type { SafetyChoice } from '../safety/safety.vocabulary'
import type { NoLabelPurpose } from '../scans/scans.vocabulary'
import type { VerdictProduct } from './verdicts.merge'

/** A product of the saved verdict as the routine reads it (spec #171, #152): the merged verdict plus its routine step and the sources of the rules that match its ingredients. */
export type SavedVerdictProduct = VerdictProduct & { step: RoutineStep | null; sourceUrls: string[] }

/** What a saved verdict was built from: ids, codes and bands only, never a word the user typed or a product name. */
export type VerdictProvenance = {
  goal: Goal | null
  /** The resolved entries, a product by its formulation and a no-label entry by its purpose. */
  entries: ({ id: string; formulationId: string } | { id: string; noLabelPurpose: NoLabelPurpose })[]
  scan: { skinType: SkinTypeLabel | null; concerns: { concern: ShownConcern; band: Band }[] } | null
  safety: { choices: SafetyChoice[]; parseState: ParseState | null }
  /** The step-down template codes the floor used. */
  taperCodes: string[]
}
