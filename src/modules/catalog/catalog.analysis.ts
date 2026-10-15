import type { DraftConcern } from '../../providers/product-analysis/product-analyst.provider'
import { ingredientParts } from './catalog.ingredients'
import type { FlaggedFact } from './catalog.rules'
import type { DraftConcernRow } from './catalog.types'
import { CONCERN_KINDS, SEVERITIES, TRAITS } from './catalog.vocabulary'

/** Why an analysis was refused: a fixed code, never a word the model or the label supplied. */
export type AnalysisProblem =
  | 'TOO_MANY_CONCERNS'
  | 'UNKNOWN_KIND'
  | 'UNKNOWN_SEVERITY'
  | 'UNKNOWN_TRAIT'
  | 'TEXT_TOO_LONG'
  | 'TEXT_HAS_LINK'
  | 'TEXT_HAS_MARKUP'
  | 'UNCOVERED_FLAGGED_FACT'

export type AnalysisCheck = { ok: true; concerns: DraftConcernRow[] } | { ok: false; reason: AnalysisProblem }

export const MAX_CONCERNS = 20
export const MAX_WHY_LENGTH = 600
export const MAX_WHO_LENGTH = 300

// Text from the web or the model is shown to users, and none of it has any business carrying a link or markup.
// A link is a scheme or a "www." host. Markup is a "<" that starts a tag, a closing tag or a comment: straight before a
// letter, "/" or "!". Other angle brackets are ordinary text ("<1 ppm", "pH < 5", "> 2%").
const LINK = /[a-z][a-z0-9+.-]*:\/\/|\bwww\./i
const MARKUP = /<[a-z/!]/i

export const hasLink = (text: string): boolean => LINK.test(text)
export const hasMarkup = (text: string): boolean => MARKUP.test(text)
export const hasLinkOrMarkup = (text: string): boolean => hasLink(text) || hasMarkup(text)

const canonical = <T extends string>(vocabulary: readonly T[], value: string): T | undefined => {
  const wanted = value.trim().toLowerCase()
  return vocabulary.find((word) => word === wanted)
}

type TextProblem = Extract<AnalysisProblem, `TEXT_${string}`>

/** A link is reported before markup, so text with both says TEXT_HAS_LINK. */
const textProblem = (text: string, max: number): TextProblem | undefined => {
  if (text.length > max) return 'TEXT_TOO_LONG'
  if (hasLink(text)) return 'TEXT_HAS_LINK'
  if (hasMarkup(text)) return 'TEXT_HAS_MARKUP'
  return undefined
}

/**
 * Turns the model's draft concerns into storable ones, or says why they cannot be stored. The model is not trusted:
 *  - more than MAX_CONCERNS concerns, or free text that is too long or carries a link or markup, rejects the analysis;
 *  - a kind, severity or trait outside the vocabulary rejects the whole analysis (matched ignoring case);
 *  - each ingredient a concern names is replaced by the formulation's own spelling, a name not on the label is
 *    dropped, and a concern left with no ingredient is dropped;
 *  - a banned substance is always high severity, whatever the model said;
 *  - a source survives only on a concern whose kind and ingredient a flagged fact with that regulation URL is about,
 *    so a made-up link is never shown, and neither is a real one on a concern it does not back;
 *  - every flagged fact must be covered by a surviving concern of its kind that names its ingredient.
 * Coverage is judged last, after the drops, so a concern that named nothing on the label cannot cover a fact.
 */
export const checkAnalysis = (drafts: DraftConcern[], ingredients: string[], facts: FlaggedFact[]): AnalysisCheck => {
  if (drafts.length > MAX_CONCERNS) return { ok: false, reason: 'TOO_MANY_CONCERNS' }
  const labelParts = ingredients.map((ingredient) => new Set(ingredientParts(ingredient)))

  const concerns: DraftConcernRow[] = []
  for (const draft of drafts) {
    const kind = canonical(CONCERN_KINDS, draft.kind)
    if (!kind) return { ok: false, reason: 'UNKNOWN_KIND' }
    const severity = canonical(SEVERITIES, draft.severity)
    if (!severity) return { ok: false, reason: 'UNKNOWN_SEVERITY' }
    const traits = draft.traits.map((trait) => canonical(TRAITS, trait))
    if (traits.includes(undefined)) return { ok: false, reason: 'UNKNOWN_TRAIT' }
    const text = textProblem(draft.why, MAX_WHY_LENGTH) ?? textProblem(draft.whoShouldTakeCare, MAX_WHO_LENGTH)
    if (text) return { ok: false, reason: text }

    const named = draft.ingredients.map((name) => new Set(ingredientParts(name)))
    const onLabel = ingredients.filter((_, i) => named.some((parts) => [...parts].some((part) => labelParts[i]!.has(part))))
    if (onLabel.length === 0) continue

    const backing = new Set(facts.filter((f) => f.kind === kind && f.source !== null && onLabel.includes(f.ingredient)).map((f) => f.source))
    concerns.push({
      kind,
      severity: kind === 'banned-substance' ? 'high' : severity,
      ingredients: onLabel,
      why: draft.why,
      whoShouldTakeCare: draft.whoShouldTakeCare,
      traits: traits as DraftConcernRow['traits'],
      sources: [...new Set(draft.sources.filter((source) => backing.has(source)))],
    })
  }

  for (const fact of facts) {
    if (!concerns.some((c) => c.kind === fact.kind && c.ingredients.includes(fact.ingredient))) {
      return { ok: false, reason: 'UNCOVERED_FLAGGED_FACT' }
    }
  }
  return { ok: true, concerns }
}
