/**
 * Lower case, accents and apostrophes removed, "&" read as "and", a "+" touching a letter or digit read as "plus"
 * ("SPF 50+", "Hydro Boost+"; a standalone " + " is just a space), every other mark a space, a space between a
 * letter and the digit after it ("NC15" is "nc 15"), single spaces. A dot survives only between two digits, so
 * "1.5" is kept and "v.2" is "v 2". A digit followed by a letter is left alone, so "250ml" still reaches stripSizes.
 */
export const normaliseText = (raw: string): string =>
  raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/(?<=[\p{L}\p{N}])\+|\+(?=[\p{L}\p{N}])/gu, ' plus ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/(?<=\p{L})(?=\d)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const SIZE = /\b(\d+(?:\.\d+)?)\s*(fl\s*oz|floz|ml|kg|mg|oz|l|g)\b/gi

/**
 * Removes pack sizes ("50 ml", "100g", "3.4 fl oz") from normalised text. May leave extra spaces. A bare "g" or
 * "l" counts only from 10 up: "shade 4 l" and "level 6 g" are shades and levels, not litres and grams.
 */
export const stripSizes = (text: string): string =>
  text.replace(SIZE, (match, amount: string, unit: string) => (/^[gl]$/i.test(unit) && Number(amount) < 10 ? match : ' '))

const comparable = (raw: string | null | undefined): string => stripSizes(normaliseText(raw ?? '')).replace(/\s+/g, ' ').trim()

type Named = { name: string; variant?: string | null; brand?: string }
type Branded = Named & { brand: string; form?: string | null }

export const brandKey = (brand: string): string => normaliseText(brand)

/** The first word of the normalised brand: "NIVEA MEN" and "NIVEA" both give "nivea". */
export const brandFirstWord = (brand: string): string => brandKey(brand).split(' ')[0] ?? ''

/** Whether two brands share a first word, so a brand/name split ("NIVEA MEN" + "DRY IMPACT" or "NIVEA" + "MEN DRY IMPACT") still meets. */
export const sameBrandFamily = (brandA: string, brandB: string): boolean => brandFirstWord(brandA) === brandFirstWord(brandB)

/** Whether two products have the same form; none counts as a value, as it does in the key. */
export const sameForm = (a: { form?: string | null }, b: { form?: string | null }): boolean => (a.form ?? '') === (b.form ?? '')

/** One product, one key: brand, name and variant normalised, with pack sizes ignored, then the form (empty for none). */
export const identityKey = (product: Branded): string =>
  `${brandKey(product.brand)}|${comparable(product.name)}|${comparable(product.variant)}|${product.form ?? ''}`

const words = (product: Named): Set<string> =>
  new Set(comparable(`${product.brand ?? ''} ${product.name} ${product.variant ?? ''}`).split(' ').filter(Boolean))

/** Jaccard ratio of the words in the brand, name and variant, pooled so a word may sit in any of them: 1 for the same words, 0 for none shared. */
export const nameSimilarity = (a: Named, b: Named): number => {
  const wa = words(a)
  const wb = words(b)
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  const union = wa.size + wb.size - shared
  return union === 0 ? 0 : shared / union
}

/**
 * Products of the same brand family (first word) whose words nearly matches but whose identity key differs: the cases for the model
 * to decide (same product or not). Best first, equal similarity by id.
 */
export const nearMissCandidates = <P extends Branded & { id: string }>(
  target: Branded,
  products: P[],
  options: { threshold?: number; limit?: number } = {},
): P[] => {
  const { threshold = 0.6, limit = 3 } = options
  const targetKey = identityKey(target)
  return products
    .filter((p) => sameBrandFamily(p.brand, target.brand) && identityKey(p) !== targetKey)
    .map((p) => ({ product: p, similarity: nameSimilarity(target, p) }))
    .filter((c) => c.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity || (a.product.id < b.product.id ? -1 : 1))
    .slice(0, limit)
    .map((c) => c.product)
}
