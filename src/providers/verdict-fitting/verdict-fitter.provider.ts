import type { ConcernKind, IngredientGroup, ProductForm, RoutineStep } from '../../modules/catalog/catalog.vocabulary'
import type { ShownConcern, SkinTypeLabel } from '../../modules/face-scans/face-scans.tables'
import type { Goal } from '../../modules/goals/goals.vocabulary'
import type { SeenConcern } from '../../modules/routines/routines.types'
import type { FloorGroup } from '../../modules/verdicts/verdicts.floor'

/** The three labels the fit judge may give. The safety labels (likely the problem, conflicting, can't tell, prescribed) are the floor's alone. */
export type FitLabel = 'helping' | 'redundant' | 'blocking'

/** One shelf product as the fit judge sees it, with the status the rules floor gave it. */
export type FitProduct = {
  id: string
  brand: string | null
  name: string
  variant: string | null
  /** The routine step the recommendation catalog gives it; null when the product is not there. */
  step: RoutineStep | null
  /** What the product is (cream, serum, ...), when it is known. */
  form: ProductForm | null
  ingredients: string[]
  /** The kinds of caution the rules found in its ingredients. */
  cautions: ConcernKind[]
  /** The concerns the reviewed catalog says it works on. */
  skinConcerns: ShownConcern[]
  /** Open: the judge labels it. Fixed: the floor decided and the judge only reads it as context. */
  floor: { status: 'open' } | { status: 'fixed'; group: FloorGroup }
}

export type FitRequest = {
  goal: { id: Goal; skinConcerns: ShownConcern[] }
  /** Null when there is no face scan. */
  skinType: SkinTypeLabel | null
  /** Null when there is no face scan. */
  scan: SeenConcern[] | null
  shelf: FitProduct[]
  /** The pairs of shelf products the floor found clashing, each of which the judge picks one to reduce. */
  clashes: { ids: [string, string]; groups: [IngredientGroup, IngredientGroup] }[]
}

/**
 * The judge's word on one open product. `reason` is one plain sentence, not empty and at most 200 characters. A redundant product names the product that
 * does its job and stays in `sameJobAs`: an open product this same answer labels helping, or a fixed prescribed one. It is null for helping and blocking.
 */
export type FitProductResult =
  | { id: string; label: 'helping' | 'blocking'; reason: string; sameJobAs: null }
  | { id: string; label: 'redundant'; reason: string; sameJobAs: string }

export type FitResult = {
  /** One entry for each open product on the shelf, and none for a fixed one. */
  products: FitProductResult[]
  /** One entry for each clash pair the judge settled, with `ids` in the request's order; a pair left out is the floor's to settle. */
  clashes: { ids: [string, string]; reduceId: string }[]
}

/**
 * Judges whether the shelf products the rules left open are helping, redundant or blocking the goal, and which of each clashing pair to reduce.
 * It can only make a verdict stricter: it never sees a fixed product as something to change. Adapters throw their vendor's errors for failures
 * the caller can act on, and never return a partial result.
 */
export interface VerdictFitter {
  /** The model and prompt this fitter judges with, known before any call so a saved verdict's fingerprint can name them. */
  readonly identity: { model: string; promptHash: string }

  /**
   * Judges the shelf. The caller keeps the floor's fixed verdicts whatever this returns, and skips the call when no product is open and there are no clashes.
   * The floor's `taper-missing` entries are passed as fixed, in the group likely-the-problem, since the product is the likely problem.
   */
  fit(request: FitRequest): Promise<FitResult>
}
