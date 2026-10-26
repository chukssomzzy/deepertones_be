/*
 * The skeleton of a case: what the rules decide for a synthetic person, built by the REAL RecommendationService.candidatesFor (under runAs) over the
 * snapshot's FakeCatalogWorkbook and small stubs for the reads it makes of the goal, safety answers, skin type and product summaries. A candidate is in a
 * skeleton for exactly the reason it would be in the app.
 */
import { type Actor, runAs } from '../../src/lib/context'
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { ProductSummary } from '../../src/modules/catalog/catalog.service'
import type { GoalView } from '../../src/modules/goals/goals.types'
import { FakeRecommendationsRepository } from '../../src/modules/recommendations/recommendations.repository.fake'
import { RecommendationService } from '../../src/modules/recommendations/recommendations.service'
import type { Candidate } from '../../src/modules/recommendations/recommendations.types'
import type { SafetyMentionRow } from '../../src/modules/safety/safety.types'
import { routineStepsFor } from '../../src/modules/routines/routines.rules'
import { assembleSkeleton } from '../../src/modules/routines/routines.skeleton'
import type { RoutineSkeleton } from '../../src/modules/routines/routines.types'
import type { RoutineCase } from './routine-cases'
import { catalogFor, type Snapshot } from './routine-snapshot'

export type BuiltSkeleton = {
  skeleton: RoutineSkeleton
  /** For each gap, its candidates' codes sorted by code: what a label set pins. */
  gapCodes: Partial<Record<RoutineStep, string[]>>
}

const PROFILE = 'eval-profile'
const ACTOR: Actor = { kind: 'user', userId: 'eval-user', status: 'verified', profileId: PROFILE }
const EPOCH = new Date('2030-01-01T00:00:00.000Z')

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
  const candidates: Partial<Record<RoutineStep, Candidate[]>> = {}
  for (const step of routineStepsFor(c.goal)) candidates[step] = await runAs(ACTOR, () => service.candidatesFor({ step }))
  const skeleton = assembleSkeleton({
    goal: c.goal,
    seen: c.seen,
    alsoNoticed: c.alsoNoticed,
    skinType: c.skinType,
    budgetBand: c.budgetBand,
    safetyChoices: c.safety.choices,
    shelf: c.shelf,
    candidates,
    hintsShown,
  })
  return { skeleton, gapCodes: Object.fromEntries(skeleton.gaps.map((gap) => [gap.step, gap.candidates.map((candidate) => candidate.code).sort()])) }
}
