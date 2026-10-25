import { ingredientParts } from './catalog.ingredients'
import type { ReferenceEntry } from './catalog.reference'
import type { ConcernKind } from './catalog.vocabulary'

/** A hard fact from the reference data that the analysis must explain. */
export type FlaggedFact = {
  kind: ConcernKind
  /** The ingredient exactly as written on the label. */
  ingredient: string
  rule: string
  /** An https URL for a regulatory listing; null for a commonly cited concern. */
  source: string | null
}

// The order an ingredient's facts come in when one name carries several kinds (hydroquinone is banned and a pregnancy caution; retinol is a sun
// sensitiser and a pregnancy caution): what the law forbids or limits first, then the commonly cited concerns. The analyst is shown the facts in
// this order and the eval's expected flags are written in it, so it must not depend on the order the rules happen to be read in (the database lists
// them by code, REFERENCE in the order it was written). CONCERN_KINDS cannot serve: it puts a pregnancy caution before a banned substance.
const KIND_RANK: Record<ConcernKind, number> = {
  'banned-substance': 0,
  'restricted-substance': 1,
  allergen: 2,
  interaction: 3,
  'sun-sensitivity': 4,
  'pregnancy-caution': 5,
  'hyperpigmentation-risk': 6,
  'pore-clogging': 7,
  irritation: 8,
  drying: 9,
}

// The label map is the same for every product checked against one rules array (the live rules are one array per rules version), so it is built once
// per array and not once per product. A WeakMap, so a replaced rules array takes its map with it.
const labelMaps = new WeakMap<readonly ReferenceEntry[], Map<string, ReferenceEntry[]>>()

const labelMapOf = (rules: readonly ReferenceEntry[]): Map<string, ReferenceEntry[]> => {
  const known = labelMaps.get(rules)
  if (known) return known
  const byLabel = new Map<string, ReferenceEntry[]>()
  for (const entry of rules) {
    for (const label of [entry.name, ...entry.aliases]) byLabel.set(label, [...(byLabel.get(label) ?? []), entry])
  }
  for (const entries of byLabel.values()) entries.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])
  labelMaps.set(rules, byLabel)
  return byLabel
}

/**
 * Every rule that flags `ingredient`, each once: by the ingredient's whole name and by the parts either side of a bracket, in the order the parts are tried
 * and, for one label, strictest kind first. Unlike `flagFacts` it does not stop at one rule per kind, so two rules of the same kind both come back.
 */
export const rulesMatching = <T extends ReferenceEntry>(ingredient: string, rules: readonly T[]): T[] => {
  const byLabel = labelMapOf(rules)
  const matched = new Set<ReferenceEntry>()
  for (const part of ingredientParts(ingredient)) for (const entry of byLabel.get(part) ?? []) matched.add(entry)
  return [...matched] as T[]
}

/**
 * Checks each ingredient against `rules` (the live approved ones; REFERENCE is the seed and the eval's fixture), in label order. An
 * ingredient is matched by its whole name and by the parts either side of a bracket, and yields at most one fact per kind. `rules` is not
 * changed after it is passed (a new rules version is a new array).
 */
export const flagFacts = (ingredients: string[], rules: readonly ReferenceEntry[]): FlaggedFact[] => {
  const facts: FlaggedFact[] = []
  for (const ingredient of ingredients) {
    const seen = new Set<ConcernKind>()
    for (const { kind, rule, source } of rulesMatching(ingredient, rules)) {
      if (seen.has(kind)) continue
      seen.add(kind)
      facts.push({ kind, ingredient, rule, source })
    }
  }
  return facts
}
