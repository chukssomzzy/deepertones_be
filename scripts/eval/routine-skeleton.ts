/*
 * The skeleton of a case: what the rules decide for a synthetic person, built by the REAL RecommendationService.candidatesFor (under runAs) over the
 * snapshot's FakeCatalogWorkbook and small stubs for the reads it makes of the goal, safety answers, skin type and product summaries. A candidate is in a
 * skeleton for exactly the reason it would be in the app.
 */
import { type Actor, runAs } from '../../src/lib/context'
import { ROUTINE_STEPS, type Frequency, type RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { ProductSummary } from '../../src/modules/catalog/catalog.service'
import { LOW_CONFIDENCE_CONCERNS } from '../../src/modules/face-scans/face-scans.tables'
import type { GoalView } from '../../src/modules/goals/goals.types'
import { FakeRecommendationsRepository } from '../../src/modules/recommendations/recommendations.repository.fake'
import { RecommendationService } from '../../src/modules/recommendations/recommendations.service'
import type { Candidate } from '../../src/modules/recommendations/recommendations.types'
import type { SafetyMentionRow } from '../../src/modules/safety/safety.types'
import type { RoutineSkeleton, SkeletonCandidate, SkeletonGap } from '../../src/modules/routines/routines.types'
import type { RoutineCase } from './routine-cases'
import { catalogFor, type Snapshot } from './routine-snapshot'

/**
 * The frequencies each step may be written with. The eval's stand-in until the routine-stage rules exist: they will own this table, and the skeleton the
 * app builds will carry theirs.
 */
export const ROUTINE_ALLOWED_FREQUENCIES: Record<RoutineStep, Frequency[]> = {
  cleanse: ['am', 'pm', 'am-pm'],
  treat: ['pm', 'alternate-days', 'weekly', 'am', 'am-pm'],
  moisturise: ['am', 'pm', 'am-pm'],
  protect: ['am'],
}

export type BuiltSkeleton = {
  skeleton: RoutineSkeleton
  /** For each gap, its candidates' codes sorted by code: what a label set pins. */
  gapCodes: Partial<Record<RoutineStep, string[]>>
}

const PROFILE = 'eval-profile'
const ACTOR: Actor = { kind: 'user', userId: 'eval-user', status: 'verified', profileId: PROFILE }
const EPOCH = new Date('2030-01-01T00:00:00.000Z')

const skeletonCandidate = ({ code, product, ingredients, skinConcerns, frequency, priceMin, priceMax, evidenceUrls, ingredientsSourceUrl }: Candidate): SkeletonCandidate => ({
  code,
  brand: product.brand,
  name: product.name,
  form: product.form,
  ingredients,
  skinConcerns,
  frequency,
  priceMin,
  priceMax,
  evidenceUrls,
  ingredientsSourceUrl,
  // `origin` is dropped on purpose: who put a product forward must never reach a choice.
  outcomeHint: null,
})

const serviceFor = async (c: RoutineCase, snapshot: Snapshot): Promise<RecommendationService> => {
  const summaries = new Map<string, ProductSummary>(snapshot.offers.map((o) => [o.row.formulationId, o.summary]))
  const named = [
    ...c.safety.reactionIngredients.map((name) => ({ name, source: 'reaction' as const })),
    ...c.safety.prescriptionIngredients.map((name) => ({ name, source: 'prescription' as const })),
  ]
  // As the parse stores them: resolved ingredient mentions, the reaction words first.
  const mentions: SafetyMentionRow[] = named.map(({ name, source }, position) => ({
    id: `mention-${position}`,
    safetyId: 'eval-safety',
    source,
    kind: 'ingredient',
    brand: null,
    name,
    variant: null,
    category: null,
    productId: null,
    resolution: null,
    position,
    createdAt: EPOCH,
  }))
  const repository = new FakeRecommendationsRepository()
  await repository.append({ id: 'eval-shopping', profileId: PROFILE, country: c.country, budgetBand: c.budgetBand, createdAt: EPOCH })
  return new RecommendationService({
    repository,
    goals: { requireGoal: async (): Promise<GoalView> => ({ goal: c.goal, wantsLighter: false, text: null, answer: null, answersVersion: 0, updatedAt: EPOCH }) },
    safety: {
      requireAnswered: async () => ({
        choices: c.safety.choices,
        reactionText: null,
        prescriptionText: null,
        excludesPregnancyCaution: c.safety.choices.includes('pregnant') || c.safety.choices.includes('breastfeeding'),
        updatedAt: EPOCH,
      }),
      currentMentions: async () => mentions,
    },
    workbook: catalogFor(snapshot),
    faceScans: { latestSkinType: async () => c.skinType },
    catalog: {
      productSummaries: async (formulationIds) => new Map(formulationIds.flatMap((id): [string, ProductSummary][] => (summaries.has(id) ? [[id, summaries.get(id)!]] : []))),
      latestIngredients: async () => null,
    },
  })
}

export const buildSkeleton = async (c: RoutineCase, snapshot: Snapshot, { hintsShown }: { hintsShown: boolean }): Promise<BuiltSkeleton> => {
  const service = await serviceFor(c, snapshot)
  // A step is filled when a shelf product the rules keep (as it is or reduced) is used for it; a stopped product fills nothing.
  const filled = new Set(c.shelf.filter((p) => p.step !== null && p.verdict.kind !== 'stop').map((p) => p.step))
  const gaps: SkeletonGap[] = []
  for (const step of ROUTINE_STEPS) {
    if (filled.has(step)) continue
    const candidates = await runAs(ACTOR, () => service.candidatesFor({ step }))
    gaps.push({ step, candidates: candidates.map(skeletonCandidate) })
  }
  const skeleton: RoutineSkeleton = {
    goal: c.goal,
    person: {
      seen: c.seen.map((s) => ({ ...s })),
      alsoNoticed: c.alsoNoticed.map((s) => ({ ...s })),
      skinType: c.skinType,
      lowConfidence: LOW_CONFIDENCE_CONCERNS,
      cautions: [...c.cautions],
      budgetBand: c.budgetBand,
    },
    steps: [...ROUTINE_STEPS],
    shelf: structuredClone(c.shelf),
    gaps,
    limits: {
      allowed: structuredClone(ROUTINE_ALLOWED_FREQUENCIES),
      // The writer's prompt promises that the skeleton always allows enough new products to fill its gaps, and the gap gate needs every gap that has
      // candidates filled. So the limit is that count, not a number a case chooses.
      maxNewProducts: gaps.filter((gap) => gap.candidates.length > 0).length,
    },
    hintsShown,
  }
  return { skeleton, gapCodes: Object.fromEntries(gaps.map((gap) => [gap.step, gap.candidates.map((candidate) => candidate.code).sort()])) }
}
