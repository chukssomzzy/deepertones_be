import type { BudgetBand, Frequency, RoutineStep } from '../catalog/catalog.vocabulary'
import { LOW_CONFIDENCE_CONCERNS, type SkinTypeLabel } from '../face-scans/face-scans.tables'
import type { Goal } from '../goals/goals.vocabulary'
import type { Candidate } from '../recommendations/recommendations.types'
import type { SafetyChoice } from '../safety/safety.vocabulary'
import { maxNewProductsFor, reducedFrequencyFor, ROUTINE_ALLOWED_FREQUENCIES, routineStepsFor } from './routines.rules'
import type { CautionState, RoutineSkeleton, SeenConcern, SkeletonCandidate, SkeletonGap, SkeletonShelfProduct } from './routines.types'

// The one place a routine skeleton is put together, from facts already read: production's builder and the eval both call it, so a skeleton means the same in both.

export type SkeletonInput = {
  goal: Goal
  seen: SeenConcern[]
  alsoNoticed: SeenConcern[]
  skinType: SkinTypeLabel | null
  budgetBand: BudgetBand | null
  safetyChoices: readonly SafetyChoice[]
  shelf: SkeletonShelfProduct[]
  /** Each step's candidates in the order the recommendation rules gave them (cheapest first). Steps the kept shelf fills are ignored. */
  candidates: Partial<Record<RoutineStep, Candidate[]>>
  hintsShown: boolean
}

/** The cautions the app states: from the safety answers, and tapering when the rules stop a shelf product. The order is fixed: the writer's prompt carries it. */
export const cautionsOf = (safetyChoices: readonly SafetyChoice[], shelf: readonly SkeletonShelfProduct[]): CautionState[] => [
  ...(safetyChoices.includes('pregnant') ? (['pregnant'] as const) : []),
  ...(safetyChoices.includes('breastfeeding') ? (['breastfeeding'] as const) : []),
  ...(shelf.some((p) => p.verdict.kind === 'stop') ? (['tapering'] as const) : []),
  ...(safetyChoices.includes('reaction') ? (['recent-reaction'] as const) : []),
  ...(safetyChoices.includes('prescription') ? (['prescription'] as const) : []),
]

export const candidateOf = (
  { code, product, ingredients, skinConcerns, frequency, priceMin, priceMax, evidenceUrls, ingredientsSourceUrl }: Candidate,
  outcomeHint: SkeletonCandidate['outcomeHint'] = null,
): SkeletonCandidate => ({
  code,
  brand: product.brand,
  name: product.name,
  form: product.form,
  ingredients: [...ingredients],
  skinConcerns: [...skinConcerns],
  frequency,
  priceMin,
  priceMax,
  evidenceUrls: [...evidenceUrls],
  ingredientsSourceUrl,
  outcomeHint,
  // `origin` is dropped on purpose: who put a product forward must never reach a choice.
})

/**
 * The frequencies each step may be written with. A reduced product follows its verdict's cap, so when none of a step's usual frequencies is within the cap (a
 * cleanser capped at alternate-days: am, pm and am-pm are all more often), the cap itself is allowed there too, once. The routine then agrees with the verdict
 * screen instead of dropping the product. Protect never gets here: a reduced sunscreen has become keep by then.
 */
const allowedFor = (shelf: readonly SkeletonShelfProduct[]): Record<RoutineStep, Frequency[]> => {
  const allowed = structuredClone(ROUTINE_ALLOWED_FREQUENCIES)
  for (const { step, verdict } of shelf) {
    if (step === null || verdict.kind !== 'reduce') continue
    if (reducedFrequencyFor(allowed[step], verdict.maxFrequency) === null) allowed[step].push(verdict.maxFrequency)
  }
  return allowed
}

/** Sun protection stays daily: a reduced sunscreen is kept, so the morning-only rule for protect holds and the routine never asks for it less often. */
const sunscreenKept = (product: SkeletonShelfProduct): SkeletonShelfProduct =>
  product.step === 'protect' && product.verdict.kind === 'reduce' ? { ...product, verdict: { kind: 'keep' } } : product

export const assembleSkeleton = (input: SkeletonInput): RoutineSkeleton => {
  const shelf = structuredClone(input.shelf).map(sunscreenKept)
  // A step is filled when a shelf product the rules keep (as it is or reduced) is used for it; a stopped or dropped product fills nothing.
  const filled = new Set(shelf.filter((p) => p.step !== null && (p.verdict.kind === 'keep' || p.verdict.kind === 'reduce')).map((p) => p.step))
  const steps = routineStepsFor(input.goal)
  const gaps: SkeletonGap[] = steps.filter((step) => !filled.has(step)).map((step) => ({ step, candidates: (input.candidates[step] ?? []).map((c) => candidateOf(c)) }))
  return {
    goal: input.goal,
    person: {
      seen: input.seen.map((s) => ({ ...s })),
      alsoNoticed: input.alsoNoticed.map((s) => ({ ...s })),
      skinType: input.skinType,
      lowConfidence: LOW_CONFIDENCE_CONCERNS,
      cautions: cautionsOf(input.safetyChoices, shelf),
      budgetBand: input.budgetBand,
    },
    steps,
    shelf,
    gaps,
    limits: { allowed: allowedFor(shelf), maxNewProducts: maxNewProductsFor(gaps) },
    hintsShown: input.hintsShown,
  }
}
