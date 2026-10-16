/**
 * The comparable form of an INCI name: lower case, single spaces, and no trailing footnote marks or full
 * stops ("Alcohol Denat." and "Glycerin*" are "alcohol denat" and "glycerin"). Brackets, hyphens and digits stay.
 */
export const normaliseIngredient = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s*†.]+$/, '')
    .trim()

// A trailing strength ("4%", "2.5 %") or pharmacopoeia grade ("usp"). The digit runs are capped so matching
// stays linear on any input. Names are already single-spaced.
const STRENGTH_OR_GRADE = /(?: ?\d{1,4}(?:\.\d{1,4})? ?%| (?:usp|bp|ep))$/

const withoutStrength = (part: string): string => {
  const next = part.replace(STRENGTH_OR_GRADE, '').trim()
  return next === part ? part : withoutStrength(next)
}

/**
 * The names an ingredient can be matched by, whole name first. Labels write "Aqua (Water)", "Cocos Nucifera
 * (Coconut) Oil", "Parfum/Fragrance" and "Hydroquinone 4%", so for each of the whole name, the name with its
 * brackets taken out, and what was inside the brackets, we also give each side of a slash, and each of those
 * again without a trailing strength or grade. De-duplicated, in that order.
 */
export const ingredientParts = (raw: string): string[] => {
  const whole = normaliseIngredient(raw)
  const bracketed = [...whole.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]!)
  const outside = whole.replace(/\([^()]*\)/g, ' ')
  const bases = [whole, ...(bracketed.length > 0 ? [outside, ...bracketed] : [])].map(normaliseIngredient)

  const parts = new Set<string>()
  for (const base of bases) {
    for (const piece of [base, ...(base.includes('/') ? base.split('/') : [])]) {
      const name = normaliseIngredient(piece)
      parts.add(name)
      parts.add(withoutStrength(name))
    }
  }
  parts.delete('')
  return [...parts]
}

/** Equal for two lists that read the same on the label. Order counts: it is part of the formulation. */
export const ingredientsKey = (ingredients: string[]): string => ingredients.map(normaliseIngredient).join('\n')
