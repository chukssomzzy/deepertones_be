import { ROUTINE_STEPS, type RoutineStep } from '../catalog/catalog.vocabulary'
import type { Goal } from '../goals/goals.vocabulary'
import { checkRoutine } from './routines.gates'
import { maxNewProductsFor } from './routines.rules'
import type { Routine, RoutineEntry, RoutineProduct, RoutineSkeleton, SkeletonCandidate, SkeletonGap, StoredRoutineStep, StoredTaper } from './routines.types'

// What keeps a started routine steady (spec #189): after Start a rebuild must not reshuffle what still works. A previous step is FIXED when the gates find nothing
// wrong with it against the new skeleton; only the broken steps go back to the writer, and the fixed steps are spliced back whole over its answer. Pure: the caller
// looks up whatever needs a service (where else a product is sold, what is on the shelf now) and passes it in.

/** The current ready version, as far as the merge needs it. */
export type StablePrevious = { id: string; goal: Goal; expectation: string; steps: StoredRoutineStep[]; tapers: StoredTaper[] }

/** What only the caller can look up. */
export type StableCarry = {
  /** The previous recommended candidates the new skeleton's gaps lost (to the country or budget filter), found by code in any country, by the step they were at. A code found nowhere is absent. */
  candidates: Partial<Record<RoutineStep, SkeletonCandidate[]>>
  /** A previous candidate's code to the shelf entry of the same product, once the person has it on the shelf. */
  onShelf: Record<string, string>
}

export type StableMerge = {
  /** The previous steps kept whole, in previous order. `fixedFrom` is the version they came from (a step's own `fixedFrom` stays). */
  fixed: StoredRoutineStep[]
  /** The new skeleton with the carried candidates put back in their gaps: the real skeleton for every final gate check. */
  checking: RoutineSkeleton
  /** What the writer is asked: `checking` with each fixed recommended step's gap narrowed to its one candidate, and a broken step's gap holding only what the new skeleton offered. Null when no step is broken and the goal is unchanged. */
  writerSkeleton: RoutineSkeleton | null
  /** One per stopped shelf product of the new skeleton, in shelf order: the start date kept while the template is unchanged. */
  carriedTapers: StoredTaper[]
  /** The previous expectation, or null when it is to be rewritten: the goal changed, or the routine failed as a whole and is rebuilt whole. */
  expectation: string | null
}

export type SplicedRoutine = { steps: StoredRoutineStep[]; tapers: StoredTaper[]; expectation: string }

const rank = (step: RoutineStep): number => ROUTINE_STEPS.indexOf(step)

const linksOf = (candidate: SkeletonCandidate): string[] => [...candidate.evidenceUrls, ...(candidate.ingredientsSourceUrl ? [candidate.ingredientsSourceUrl] : [])]

/** The routine as the gates read it: no got-it flag, no origin, no dates (their schema is strict). */
export const asRoutine = (steps: readonly StoredRoutineStep[], tapers: readonly StoredTaper[], expectation: string): Routine => ({
  steps: steps.map(({ step, product, frequency, reason, grounding }): RoutineEntry => ({ step, product, frequency, reason, grounding })),
  tapers: tapers.map(({ shelfProductId, templateId }) => ({ shelfProductId, templateId })),
  expectation,
})

const withCarried = (skeleton: RoutineSkeleton, carried: StableCarry['candidates']): RoutineSkeleton => {
  const copy = structuredClone(skeleton)
  const gaps = copy.gaps.map((gap): SkeletonGap => {
    const have = new Set(gap.candidates.map((c) => c.code))
    return { step: gap.step, candidates: [...gap.candidates, ...structuredClone((carried[gap.step] ?? []).filter((c) => !have.has(c.code)))] }
  })
  // A carried candidate can fill a gap that had none, and the gap gate needs every gap that has candidates filled.
  return { ...copy, gaps, limits: { ...copy.limits, maxNewProducts: maxNewProductsFor(gaps) } }
}

/** The links a product's reason may draw on in this skeleton, or undefined when the skeleton does not know it. */
const linksHeld = (skeleton: RoutineSkeleton, step: RoutineStep, product: RoutineProduct): string[] | undefined => {
  if (product.kind === 'shelf') return skeleton.shelf.find((p) => p.id === product.id)?.sourceUrls
  if (product.kind === 'none') return undefined
  const found = skeleton.gaps.find((g) => g.step === step)?.candidates.find((c) => c.code === product.code)
  return found && linksOf(found)
}

export const stableMerge = (previous: StablePrevious, skeleton: RoutineSkeleton, carry: StableCarry): StableMerge => {
  const checking = withCarried(skeleton, carry.candidates)
  const goalChanged = previous.goal !== skeleton.goal

  const carriedTapers = skeleton.shelf.flatMap((p): StoredTaper[] => {
    if (p.verdict.kind !== 'stop') return []
    const { taperTemplateId } = p.verdict
    const before = previous.tapers.find((t) => t.shelfProductId === p.id && t.templateId === taperTemplateId)
    return [{ shelfProductId: p.id, templateId: taperTemplateId, startedOn: before?.startedOn ?? null }]
  })

  // The previous steps as they stand against the new skeleton: a product the person now has on the shelf is that shelf entry, and the grounding is cut to the
  // links the product holds now, so a catalog edit never breaks a step.
  const current = previous.steps.map((entry): StoredRoutineStep => {
    const shelfId = entry.product.kind === 'candidate' ? carry.onShelf[entry.product.code] : undefined
    const product: RoutineProduct = shelfId === undefined ? entry.product : { kind: 'shelf', id: shelfId }
    const held = linksHeld(checking, entry.step, product)
    return {
      ...entry,
      product,
      grounding: held === undefined ? entry.grounding : entry.grounding.filter((link) => held.includes(link)),
      // A product on the shelf is no longer one to get.
      gotIt: shelfId === undefined ? entry.gotIt : false,
    }
  })

  // Tapers are the recomputed ones, so the taper gate has nothing to say; a goal change replaces the expectation, so its old words are not asked about.
  const failures = checkRoutine(checking, asRoutine(current, carriedTapers, goalChanged ? '' : previous.expectation))
  const wholeRoutineFailed = failures.some((f) => f.step === null)
  const broken = new Set(failures.flatMap((f) => (f.step === null ? [] : [f.step])))

  const fixedEntries = wholeRoutineFailed ? [] : current.filter((e) => skeleton.steps.includes(e.step) && !broken.has(e.step))
  const fixed = fixedEntries.map((e) => ({ ...e, fixedFrom: e.fixedFrom ?? previous.id }))
  const fixedSteps = new Set(fixed.map((e) => e.step))

  const needsWriter = goalChanged || skeleton.steps.some((step) => !fixedSteps.has(step))
  // A fixed step's gap is narrowed to its one product, which may be a carried one (sold elsewhere). A broken step is picked again from what the person's own country
  // offers, so a carried candidate is left out of its gap: the writer, or the rules, must never re-pick a product not sold here.
  const narrowed = checking.gaps.map((gap): SkeletonGap => {
    const codes = fixed.flatMap((e) => (e.step === gap.step && e.product.kind === 'candidate' ? [e.product.code] : []))
    if (codes.length > 0) return { step: gap.step, candidates: gap.candidates.filter((c) => codes.includes(c.code)) }
    const own = new Set(skeleton.gaps.find((g) => g.step === gap.step)?.candidates.map((c) => c.code))
    return { step: gap.step, candidates: gap.candidates.filter((c) => own.has(c.code)) }
  })

  return {
    fixed,
    checking,
    writerSkeleton: needsWriter ? { ...checking, gaps: narrowed } : null,
    carriedTapers,
    // A routine that failed as a whole (its own expectation may be what failed) is rebuilt whole, words included.
    expectation: goalChanged || wholeRoutineFailed ? null : previous.expectation,
  }
}

/**
 * The writer's (or the rules') routine with the fixed steps put back: each fixed step replaces, whole, every entry the answer has for that step; the other steps
 * are the answer's, with no got-it flag. The tapers are the carried ones, the answer's are ignored. The expectation is the previous one when the goal is unchanged.
 */
export const spliceFixed = (merge: StableMerge, answer: Routine): SplicedRoutine => {
  const fixedByStep = new Map<RoutineStep, StoredRoutineStep[]>()
  for (const entry of merge.fixed) fixedByStep.set(entry.step, [...(fixedByStep.get(entry.step) ?? []), entry])

  const steps: StoredRoutineStep[] = []
  const placed = new Set<RoutineStep>()
  for (const entry of answer.steps) {
    const group = fixedByStep.get(entry.step)
    if (!group) steps.push({ ...entry, gotIt: false, fixedFrom: null })
    else if (!placed.has(entry.step)) {
      placed.add(entry.step)
      steps.push(...group)
    }
  }
  // A fixed step the answer left out still belongs, in routine order (an out-of-order answer is left for the order gate to see).
  for (const [step, group] of fixedByStep) {
    if (placed.has(step)) continue
    const at = steps.findIndex((e) => rank(e.step) > rank(step))
    steps.splice(at === -1 ? steps.length : at, 0, ...group)
  }
  return { steps, tapers: merge.carriedTapers, expectation: merge.expectation ?? answer.expectation }
}
