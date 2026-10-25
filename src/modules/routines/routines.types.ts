import type { BudgetBand, Frequency, RoutineStep } from '../catalog/catalog.vocabulary'
import type { Band, ShownConcern, SkinTypeLabel } from '../face-scans/face-scans.tables'
import type { Goal } from '../goals/goals.vocabulary'

/** Person-specific states in which the writer must choose the gentlest suitable option, whatever an outcome hint says. */
export type CautionState = 'pregnant' | 'breastfeeding' | 'tapering' | 'recent-reaction' | 'prescription'

export type SeenConcern = {
  /** The concern the face scan showed. */
  concern: ShownConcern
  /** How strongly it showed. */
  level: Band
}

/** A safe candidate for one gap, as the AI sees it. There is deliberately no `origin` field: who paid for a review must never reach a choice. */
export type SkeletonCandidate = {
  /** The catalog code a routine entry names to choose this product. */
  code: string
  /** The maker's name. */
  brand: string
  /** The product's name. */
  name: string
  /** What it comes as (cream, gel, serum...), or null when the review does not say. */
  form: string | null
  /** The ingredient list, as reviewed. */
  ingredients: string[]
  /** The concerns the review says it helps. */
  skinConcerns: ShownConcern[]
  /** How often the review says to use it. */
  frequency: Frequency
  /** The lowest price seen. */
  priceMin: number
  /** The highest price seen. */
  priceMax: number
  /** AI-only context, never shown to users. */
  evidenceUrls: string[]
  /** Where its ingredient list came from, or null when there is no source. A routine entry may cite it. */
  ingredientsSourceUrl: string | null
  /** Null when there is no hint (under 30 similar users, or this routine is built without hints). */
  outcomeHint: {
    /** How many similar users the hint rests on. */
    n: number
    /** How many more of them saw the concern fade than saw it darken. */
    netFainter: number
  } | null
}

/**
 * What the rules decided for a shelf product (spec #171). The verdict screen sorts products into groups; each maps to a routine verdict:
 *
 * | Verdict group                         | Routine verdict                                                          |
 * | ------------------------------------- | ------------------------------------------------------------------------ |
 * | helping                               | keep                                                                     |
 * | redundant                             | drop                                                                     |
 * | blocking the goal                     | drop (an AI "blocking" never stops; only the rules start a taper)        |
 * | likely the problem: steroid           | stop, with the approved steroid template                                 |
 * | likely the problem: lightening        | stop, with the approved lightening template                              |
 * | likely the problem: mercury           | drop, with an escalation to a professional                               |
 * | likely the problem: banned, no group  | drop                                                                     |
 * | likely the problem: reaction product  | drop                                                                     |
 * | conflicting: a clash                  | reduce (the one product of the pair, capped at alternate days)           |
 * | conflicting: pregnancy                | drop                                                                     |
 * | conflicting: reaction ingredient      | drop                                                                     |
 * | can't tell what's in it               | drop                                                                     |
 * | prescribed                            | keep (always, over every other label)                                    |
 */
export type ShelfVerdict =
  /** Use it as it is. */
  | { kind: 'keep' }
  /** Keep it, but no more often than `maxFrequency`. */
  | { kind: 'reduce'; maxFrequency: Frequency }
  /** Stop it, tapering off as the approved template says. */
  | { kind: 'stop'; taperTemplateId: string }
  /** Leave it out of the routine with no taper: it is redundant, or it holds the goal back but is safe to stop at once. */
  | { kind: 'drop' }

export type SkeletonShelfProduct = {
  /** The shelf entry's id; a routine entry names it to keep using the product. */
  id: string
  /** The maker's name, or null when the label was not read. */
  brand: string | null
  /** The product's name. */
  name: string
  /** The ingredient list, as known. */
  ingredients: string[]
  /** The routine step it fills, or null when it fills none of the four. */
  step: RoutineStep | null
  /** What the rules decided to do with it. */
  verdict: ShelfVerdict
  /** Sources of the ingredient rules that apply to it: AI-only context. */
  sourceUrls: string[]
}

/** A routine step the goal needs that the kept shelf does not fill, with its safe candidates (possibly none). */
export type SkeletonGap = {
  /** The step to fill. */
  step: RoutineStep
  /** The safe products that could fill it. Empty means "use what you have". */
  candidates: SkeletonCandidate[]
}

export type RoutineSkeleton = {
  /** The one goal this routine is for. */
  goal: Goal
  /** What the writer may know about the person. */
  person: {
    /** Concerns the person chose to look at, as the face scan showed them. */
    seen: SeenConcern[]
    /** Concerns the scan showed that the person did not choose. */
    alsoNoticed: SeenConcern[]
    /** The scan's skin type, or null when there is none. */
    skinType: SkinTypeLabel | null
    /** Concerns the scan was unsure of. */
    lowConfidence: readonly ShownConcern[]
    /** States that call for the gentlest suitable option. */
    cautions: CautionState[]
    /** What the person can spend, or null when not given. */
    budgetBand: BudgetBand | null
  }
  /** The routine steps the goal needs, in routine order. */
  steps: RoutineStep[]
  /** The person's shelf, each product with the rules' verdict. */
  shelf: SkeletonShelfProduct[]
  /** The steps the kept shelf leaves empty. */
  gaps: SkeletonGap[]
  /** Bounds the rules put on the writer. */
  limits: {
    /** The frequencies allowed for each step. */
    allowed: Record<RoutineStep, Frequency[]>
    /** The most distinct new products the routine may ask the person to buy. */
    maxNewProducts: number
  }
  /** Whether outcome hints were given to the writer for this routine. */
  hintsShown: boolean
}

export type RoutineProduct =
  /** A product already on the shelf. */
  | { kind: 'shelf'; id: string }
  /** A candidate for the entry's gap. */
  | { kind: 'candidate'; code: string }
  /** "Use what you have": only for a gap with no candidates. */
  | { kind: 'none' }

export type RoutineEntry = {
  /** The routine step this entry is for. */
  step: RoutineStep
  /** The product to use at this step. */
  product: RoutineProduct
  /** How often to use it. */
  frequency: Frequency
  /** Plain words shown to the user. Never a diagnosis. */
  reason: string
  /** The links this reason drew on. Internal only: never in an API response or on a screen. */
  grounding: string[]
}

export type Routine = {
  /** The entries, in routine order. */
  steps: RoutineEntry[]
  /** One per shelf product whose verdict is stop, naming its approved template unchanged. */
  tapers: {
    /** The shelf product being stopped. */
    shelfProductId: string
    /** The approved taper template, exactly as the verdict named it. */
    templateId: string
  }[]
  /** What to expect and when, in plain words (8 to 12 weeks for most goals). */
  expectation: string
}

export type GateCode =
  | 'parse'
  | 'unknown-product'
  | 'stopped-product'
  | 'dropped-product'
  | 'over-reduced'
  | 'taper'
  | 'too-many-new'
  | 'frequency'
  | 'order'
  | 'gap'
  | 'unused-shelf'
  | 'grounding'
  | 'wording'

/** A fixed code, never model text. `step` is null for routine-wide failures. */
export type GateFailure = {
  /** Which rule failed. */
  gate: GateCode
  /** The step of the entry or gap at fault, or null for a routine-wide failure. */
  step: RoutineStep | null
}
