import { ingredientParts } from '../catalog/catalog.ingredients'
import type { ReferenceEntry } from '../catalog/catalog.reference'
import type { SafetyMentionRow } from './safety.types'

// What "the user named this" means, in one place: the recommendations and the shelf verdict's rules floor both match a reaction or a prescription against
// ingredient lists, and they must never disagree about it. Pure: no clock, no I/O.

export type NamedMention = Pick<SafetyMentionRow, 'kind' | 'name' | 'productId'>

/**
 * `parts` and every other label of each rule that has one of them as a label (its name or an alias), so a name and its synonyms the reviewed rules list
 * stand for each other, whichever one the user or the row used. One step from what was named, not a chain through rules that share a label, so the answer
 * does not depend on the order the rules are in. A name no rule lists stays as it is: the match is never fuzzy.
 */
export const expandLabels = (parts: ReadonlySet<string>, rules: readonly ReferenceEntry[]): Set<string> => {
  const expanded = new Set(parts)
  for (const { name, aliases } of rules) {
    const labels = [name, ...aliases]
    if (labels.some((label) => parts.has(label))) for (const label of labels) expanded.add(label)
  }
  return expanded
}

/**
 * What the user's words name that a row can be matched by: product ids (either source, resolved or not) and the name parts of ingredients, taken through
 * the live rules (see `expandLabels`).
 */
export const namedIn = (mentions: readonly NamedMention[], rules: readonly ReferenceEntry[]): { productIds: Set<string>; ingredientParts: Set<string> } => {
  const productIds = new Set<string>()
  const parts = new Set<string>()
  for (const mention of mentions) {
    if (mention.kind === 'ingredient') for (const part of ingredientParts(mention.name)) parts.add(part)
    else if (mention.productId !== null) productIds.add(mention.productId)
  }
  return { productIds, ingredientParts: expandLabels(parts, rules) }
}

export const anyIn = (parts: readonly string[], set: ReadonlySet<string>): boolean => parts.some((part) => set.has(part))
