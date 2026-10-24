import { ROUTINE_STEPS } from '../catalog/catalog.vocabulary'
import type { Frequency, RoutineStep } from '../catalog/catalog.vocabulary'
import { RoutineSchema } from './routines.schema'
import { FORBIDDEN_WORDING } from './routines.wording'
import type { GateFailure, Routine, RoutineSkeleton, SkeletonCandidate, SkeletonShelfProduct } from './routines.types'

/** How often, from least to most. am and pm are the same rank: neither is more than the other. */
export const FREQUENCY_RANK: Record<Frequency, number> = {
  'as-needed': 0,
  weekly: 1,
  'alternate-days': 2,
  am: 3,
  pm: 3,
  'am-pm': 4,
}

const hasForbiddenWording = (text: string) => FORBIDDEN_WORDING.some(({ pattern }) => pattern.test(text))

/**
 * Every rule a written routine must keep, checked without a model. Returns [] when it passes, else every failure, gate by gate in
 * the order below and within a gate in entry order. A failure is a fixed code and a step, never text from the routine.
 */
export const checkRoutine = (skeleton: RoutineSkeleton, routine: unknown): GateFailure[] => {
  const parsed = RoutineSchema.safeParse(routine)
  if (!parsed.success) return [{ gate: 'parse', step: null }]
  const { steps: entries, tapers, expectation }: Routine = parsed.data

  const failures: GateFailure[] = []
  const fail = (gate: GateFailure['gate'], step: RoutineStep | null) => failures.push({ gate, step })

  const shelfById = new Map(skeleton.shelf.map((p) => [p.id, p]))
  const candidatesFor = (step: RoutineStep): SkeletonCandidate[] => skeleton.gaps.filter((g) => g.step === step).flatMap((g) => g.candidates)

  // Each entry's product as the skeleton knows it: null for an unknown one, and for a none entry (it has no product).
  type Known = { kind: 'shelf'; product: SkeletonShelfProduct } | { kind: 'candidate'; product: SkeletonCandidate } | null
  const known: Known[] = entries.map((entry) => {
    if (entry.product.kind === 'shelf') {
      const product = shelfById.get(entry.product.id)
      return product ? { kind: 'shelf', product } : null
    }
    if (entry.product.kind === 'candidate') {
      const code = entry.product.code
      const product = candidatesFor(entry.step).find((c) => c.code === code)
      return product ? { kind: 'candidate', product } : null
    }
    return null
  })

  // 2. unknown-product. A shelf entry must name a kept or reduced product, used at its own step. A none entry is judged by the gap gate.
  entries.forEach((entry, i) => {
    if (entry.product.kind === 'none') return
    const match = known[i]
    // A shelf product only fills the step it was matched to: a cleanser cannot be the moisturiser.
    const wrongStep = match?.kind === 'shelf' && match.product.step !== entry.step
    if (!match || wrongStep || (match.kind === 'shelf' && match.product.verdict.kind === 'stop')) fail('unknown-product', entry.step)
  })

  // 3. stopped-product
  entries.forEach((entry, i) => {
    const match = known[i]
    if (match?.kind === 'shelf' && match.product.verdict.kind === 'stop') fail('stopped-product', entry.step)
  })

  // 4. over-reduced
  entries.forEach((entry, i) => {
    const match = known[i]
    if (match?.kind !== 'shelf' || match.product.verdict.kind !== 'reduce') return
    const rank = FREQUENCY_RANK[entry.frequency]
    const max = FREQUENCY_RANK[match.product.verdict.maxFrequency]
    // A frequency the table does not know cannot be shown to be within the cap, so it fails: a missing rank must not read as a pass.
    if (rank === undefined || max === undefined || rank > max) fail('over-reduced', entry.step)
  })

  // 5. taper: exactly one per stopped product, each naming that product's own template.
  const expectedTapers = new Map<string, string>()
  for (const p of skeleton.shelf) if (p.verdict.kind === 'stop') expectedTapers.set(p.id, p.verdict.taperTemplateId)
  const taperIds = new Set(tapers.map((t) => t.shelfProductId))
  const tapersMatch =
    tapers.length === expectedTapers.size && taperIds.size === tapers.length && tapers.every((t) => expectedTapers.get(t.shelfProductId) === t.templateId)
  if (!tapersMatch) fail('taper', null)

  // 6. too-many-new. Only candidates the skeleton knows count: an invented code is already an unknown-product failure.
  const newCodes = new Set<string>()
  entries.forEach((entry, i) => {
    if (entry.product.kind === 'candidate' && known[i]) newCodes.add(entry.product.code)
  })
  if (newCodes.size > skeleton.limits.maxNewProducts) fail('too-many-new', null)

  // 7. frequency
  for (const entry of entries) {
    const allowed = skeleton.limits.allowed[entry.step].includes(entry.frequency)
    if (!allowed || (entry.step === 'protect' && entry.frequency !== 'am')) fail('frequency', entry.step)
  }

  // 8. order: each entry against the one before it, so one misplaced entry is one failure.
  entries.forEach((entry, i) => {
    const previous = entries[i - 1]
    if (previous && ROUTINE_STEPS.indexOf(entry.step) < ROUTINE_STEPS.indexOf(previous.step)) fail('order', entry.step)
  })

  // 9. gap: one failure per step, however it went wrong.
  const gapFailed = new Set<RoutineStep>()
  for (const gap of skeleton.gaps) {
    const own = entries.filter((e) => e.step === gap.step)
    const codes = new Set(gap.candidates.map((c) => c.code))
    const used =
      gap.candidates.length > 0
        ? own.filter((e) => e.product.kind === 'candidate' && codes.has(e.product.code)).length
        : own.filter((e) => e.product.kind === 'none').length
    if (used !== 1 && !gapFailed.has(gap.step)) {
      gapFailed.add(gap.step)
      fail('gap', gap.step)
    }
  }
  const emptyGapSteps = new Set(skeleton.gaps.filter((g) => g.candidates.length === 0).map((g) => g.step))
  for (const entry of entries) {
    if (entry.product.kind === 'none' && !emptyGapSteps.has(entry.step) && !gapFailed.has(entry.step)) {
      gapFailed.add(entry.step)
      fail('gap', entry.step)
    }
  }

  // 10. grounding: only the product's own links, compared exactly. An unknown product has no links to compare with (already failed).
  entries.forEach((entry, i) => {
    const match = known[i]
    if (entry.product.kind === 'none') {
      if (entry.grounding.length > 0) fail('grounding', entry.step)
      return
    }
    if (!match) return
    const own =
      match.kind === 'candidate'
        ? [...match.product.evidenceUrls, ...(match.product.ingredientsSourceUrl ? [match.product.ingredientsSourceUrl] : [])]
        : match.product.sourceUrls
    if (!entry.grounding.every((link) => own.includes(link))) fail('grounding', entry.step)
  })

  // 11. wording
  for (const entry of entries) if (hasForbiddenWording(entry.reason)) fail('wording', entry.step)
  if (hasForbiddenWording(expectation)) fail('wording', null)

  return failures
}
