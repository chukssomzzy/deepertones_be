import type { ProductSummary } from '../catalog/catalog.service'
import type { RoutineStep } from '../catalog/catalog.vocabulary'
import type { Band, ShownConcern, SkinTypeLabel } from '../face-scans/face-scans.tables'
import type { Goal } from '../goals/goals.vocabulary'
import type { ParseState, SafetyMentionRow } from '../safety/safety.types'
import type { SafetyChoice } from '../safety/safety.vocabulary'
import type { NoLabelView } from '../scans/scans.service'
import type { NoLabelPurpose } from '../scans/scans.vocabulary'
import type { VerdictProduct } from './verdicts.merge'

/** A product of the saved verdict as the routine reads it (spec #171, #152): the merged verdict plus its routine step and the sources of the rules that match its ingredients. */
export type SavedVerdictProduct = VerdictProduct & { step: RoutineStep | null; sourceUrls: string[] }

/** A saved product with its shelf entry's own kind and product or noLabel, joined when the verdict is read: what a client is shown, never what is saved or fingerprinted. */
// With neither when the shelf entry can no longer be shown: the product stays, as saved.
export type ShownVerdictProduct = SavedVerdictProduct & ({ kind: 'product'; product: ProductSummary } | { kind: 'no-label'; noLabel: NoLabelView } | { kind?: undefined })

/** What a saved verdict was built from: ids, codes and bands only, never a word the user typed or a product name. */
export type VerdictProvenance = {
  goal: Goal | null
  /** The resolved skin entries, a product by its formulation and a no-label entry by its purpose. */
  entries: ({ id: string; formulationId: string } | { id: string; noLabelPurpose: NoLabelPurpose })[]
  scan: { skinType: SkinTypeLabel | null; concerns: { concern: ShownConcern; band: Band }[] } | null
  /** The choices sorted, and what the user named by its catalog product, kind and resolution: never its name. */
  safety: { choices: SafetyChoice[]; parseState: ParseState | null; mentions: Pick<SafetyMentionRow, 'source' | 'productId' | 'kind' | 'resolution'>[] }
  /** The step-down template codes the floor used. */
  taperCodes: string[]
}
