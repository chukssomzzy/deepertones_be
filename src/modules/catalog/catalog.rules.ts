import { ingredientParts } from './catalog.ingredients'
import { REFERENCE, type ReferenceEntry } from './catalog.reference'
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

const byLabel = new Map<string, ReferenceEntry[]>()
for (const entry of REFERENCE) {
  for (const label of [entry.name, ...entry.aliases]) byLabel.set(label, [...(byLabel.get(label) ?? []), entry])
}

/**
 * Checks each ingredient against the reference data, in label order. An ingredient is matched by its whole
 * name and by the parts either side of a bracket, and yields at most one fact per kind.
 */
export const flagFacts = (ingredients: string[]): FlaggedFact[] => {
  const facts: FlaggedFact[] = []
  for (const ingredient of ingredients) {
    const seen = new Set<ConcernKind>()
    for (const part of ingredientParts(ingredient)) {
      for (const { kind, rule, source } of byLabel.get(part) ?? []) {
        if (seen.has(kind)) continue
        seen.add(kind)
        facts.push({ kind, ingredient, rule, source })
      }
    }
  }
  return facts
}
