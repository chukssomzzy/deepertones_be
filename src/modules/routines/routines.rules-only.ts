import type { Frequency, RoutineStep } from '../catalog/catalog.vocabulary'
import { expectationFor, reasonFor } from './routines.copy'
import { reducedFrequencyFor } from './routines.rules'
import type { Routine, RoutineEntry, RoutineSkeleton } from './routines.types'

/**
 * The routine built by code from the skeleton alone, for when the writer cannot be used. It passes every gate for any skeleton assembleSkeleton makes: a kept
 * product at the step's usual frequency, a reduced one as often as its cap allows, each gap its first (cheapest) candidate or "use what you have", no grounding
 * (so nothing to get wrong) and a taper for every stopped product.
 */
export const rulesOnlyRoutine = (skeleton: RoutineSkeleton): Routine => {
  const usual = (step: RoutineStep): Frequency => skeleton.limits.allowed[step][0]!
  const steps: RoutineEntry[] = []
  for (const step of skeleton.steps) {
    const shelf = skeleton.shelf.filter((p) => p.step === step && (p.verdict.kind === 'keep' || p.verdict.kind === 'reduce'))
    if (shelf.length > 0) {
      for (const { id, verdict } of shelf) {
        // assembleSkeleton allows a reduced product's cap at its step, so a frequency within it always exists; the usual one only keeps this total for a skeleton built another way.
        const reduced = verdict.kind === 'reduce' ? reducedFrequencyFor(skeleton.limits.allowed[step], verdict.maxFrequency) : null
        steps.push({ step, product: { kind: 'shelf', id }, frequency: reduced ?? usual(step), reason: reasonFor(step, verdict.kind === 'reduce' ? 'reduced' : 'kept'), grounding: [] })
      }
      continue
    }
    const first = skeleton.gaps.find((gap) => gap.step === step)?.candidates[0]
    if (first) {
      const frequency = skeleton.limits.allowed[step].includes(first.frequency) ? first.frequency : usual(step)
      steps.push({ step, product: { kind: 'candidate', code: first.code }, frequency, reason: reasonFor(step, 'recommended'), grounding: [] })
    } else {
      steps.push({ step, product: { kind: 'none' }, frequency: usual(step), reason: reasonFor(step, 'none'), grounding: [] })
    }
  }
  const tapers = skeleton.shelf.flatMap((p) => (p.verdict.kind === 'stop' ? [{ shelfProductId: p.id, templateId: p.verdict.taperTemplateId }] : []))
  return { steps, tapers, expectation: expectationFor(skeleton.goal) }
}
