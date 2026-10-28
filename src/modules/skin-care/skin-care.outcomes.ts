import type { EscalationReason, ResponseOutcome } from '../catalog/catalog.vocabulary'
import type { HowBad, Noticing, Where } from './skin-care.vocabulary'

/** Stored on every log, so a later change of the rules can tell which version decided an old one. */
export const SKIN_OUTCOME_RULES_VERSION = 1

type ProfessionalReason = Extract<EscalationReason, 'pus-or-hot-patch' | 'swelling' | 'near-eyes'>
type AdviceCode = Extract<ResponseOutcome, 'advice-tightness' | 'advice-itching' | 'advice-breakouts'>

/** What a skin log comes to. `pause` and `expected-flare` carry no text here; the service looks up the reviewed line. */
export type SkinOutcome =
  | { kind: 'professional'; reason: ProfessionalReason }
  | { kind: 'pause'; duringStepDown: boolean }
  | { kind: 'expected-flare' }
  | { kind: 'advice'; codes: AdviceCode[] }
  | { kind: 'logged' }

type Symptom = Exclude<Noticing, 'nothing-unusual'>

export type SkinLogReading = { noticing: Noticing[]; where: Where[]; howBad: HowBad | null }

// In the order the reviewed lines are shown, which is not the order of the vocabulary.
const ADVICE: [Symptom, AdviceCode][] = [
  ['tightness-or-dryness', 'advice-tightness'],
  ['itching', 'advice-itching'],
  ['new-breakouts', 'advice-breakouts'],
]

// Which red flag is named when several apply: the first.
const RED_FLAGS: [Symptom, ProfessionalReason][] = [
  ['pus-or-hot-patch', 'pus-or-hot-patch'],
  ['swelling', 'swelling'],
]

/**
 * The fixed rules over a skin log (CONTEXT.md, Safety): no AI and no note. The caller has already checked the input (at least one symptom, `nothing-unusual` only alone,
 * a level for anything but a good day). Precedence: professional, then pause, then expected flare, then advice, then logged. A harm signal (stinging, burning, new
 * redness) pauses at any level and any symptom does at hard-to-ignore; while a step-down runs a harm signal at mild or noticeable is the expected flare instead (the
 * step-down is never stopped), and hard-to-ignore stays a pause, marked so the caller can pick a step other than the step-down.
 */
export const outcomeFor = (log: SkinLogReading, context: { stepDownRunning: boolean }): SkinOutcome => {
  const symptoms = log.noticing.filter((item): item is Symptom => item !== 'nothing-unusual')
  if (symptoms.length === 0) return { kind: 'logged' }

  const redFlag = RED_FLAGS.find(([symptom]) => symptoms.includes(symptom))?.[1] ?? (log.where.includes('near-eyes') ? 'near-eyes' : null)
  if (redFlag !== null) return { kind: 'professional', reason: redFlag }

  if (log.howBad === 'hard-to-ignore') return { kind: 'pause', duringStepDown: context.stepDownRunning }
  if (symptoms.includes('stinging-or-burning') || symptoms.includes('new-redness')) return context.stepDownRunning ? { kind: 'expected-flare' } : { kind: 'pause', duringStepDown: false }

  return { kind: 'advice', codes: ADVICE.filter(([symptom]) => symptoms.includes(symptom)).map(([, code]) => code) }
}
