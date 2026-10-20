import { normaliseText } from '../../lib/normalise-text'

// Lives in lib/ because the name splitter, a provider, compares typed words the way the catalog keys them.
export { normaliseText }

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

type WordRelation = 'equal' | 'subset' | 'superset' | 'other'

/** How the words of `a` stand to the words of `b`: the same, all inside, all containing, or neither. */
const relation = (a: Set<string>, b: Set<string>): WordRelation => {
  const aInB = [...a].every((w) => b.has(w))
  const bInA = [...b].every((w) => a.has(w))
  if (aInB && bInA) return 'equal'
  if (aInB) return 'subset'
  return bInA ? 'superset' : 'other'
}

/** Whether the reading's words are a strict subset of the product's: it says less than the product does ("Hydro Boost" for "Hydro Boost Water Gel"). */
export const lessSpecific = (reading: Named, product: Named): boolean => relation(words(reading), words(product)) === 'subset'

/**
 * Whether the label names an edition the product, whose variant went unread, does not: a variant word ("Shea Butter") found nowhere in
 * the product's brand and name. A variant whose words the product already holds is the same words split differently ("NIVEA | MEN",
 * variant "Dry Impact", against "NIVEA MEN | DRY IMPACT"), not another edition.
 */
export const namesAnotherEdition = (label: Named, product: Named): boolean => {
  if (product.variant) return false
  const held = words(product)
  return comparable(label.variant).split(' ').some((w) => w !== '' && !held.has(w))
}

/**
 * Form, category and generic descriptors that many products of one brand share ("Body Wash", "Daily Lotion"). A containment resting on
 * these alone ("Dove Body Wash" in "Dove Go Fresh Body Wash") would name every sibling, so it needs a word beyond them and the brand.
 */
const GENERIC_WORDS = new Set([
  'lotion', 'cream', 'creme', 'gel', 'oil', 'serum', 'wash', 'cleanser', 'soap', 'bar', 'balm', 'spray', 'stick', 'shampoo', 'conditioner', 'moisturiser', 'moisturizer', 'moisturizing',
  'body', 'face', 'facial', 'hand', 'hair', 'skin', 'men', 'women', 'sun', 'original', 'classic', 'care', 'daily',
])

const wordsOf = (text: string): string[] => normaliseText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** A percent-encoded path as the text it stands for; a bad escape leaves the raw text. */
const decoded = (path: string): string => {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/**
 * The pages whose URL path names the product, best first, for finding a picture on a page the research did not name. A page's words
 * are those of its path only (not host, query or fragment). The score is how many of the product's words (brand, name, variant; one
 * letter dropped) they hold; a page needs one word that is neither the brand's nor generic, so "lotion" or the brand alone never
 * qualify. Ties keep input order; then only the first page of each host stays. A value that is not a URL is dropped.
 */
export const pagesByNameMatch = (pages: string[], product: Named & { brand: string }): string[] => {
  const brand = new Set(wordsOf(product.brand))
  const wanted = new Set([...brand, ...wordsOf(`${product.name} ${product.variant ?? ''}`)].filter((w) => w.length > 1))
  const scored = pages.flatMap((page, order) => {
    let url: URL
    try {
      url = new URL(page)
    } catch {
      return []
    }
    const held = new Set(wordsOf(decoded(url.pathname)))
    const matched = [...wanted].filter((w) => held.has(w))
    if (!matched.some((w) => !brand.has(w) && !GENERIC_WORDS.has(w))) return []
    return [{ page, host: url.host, score: matched.length, order }]
  })
  const seen = new Set<string>()
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .filter(({ host }) => !seen.has(host) && !!seen.add(host))
    .map(({ page }) => page)
}

/**
 * Whether every word of the shorter reading is in the longer one ("NIVEA soft" in "NIVEA Soft Light Moisturiser"): the recognizer
 * often adds or drops descriptors, which Jaccard punishes. A reading with no word beyond its brand is contained in every product of
 * the brand, so on either side it is never a containment; nor is one whose only words beyond the brand are generic.
 */
const contains = (a: Branded, b: Branded): boolean => {
  const [wa, wb] = [words(a), words(b)]
  const beyond = (p: Branded, w: Set<string>, ignore: Set<string> = new Set()): boolean => {
    const brand = new Set(comparable(p.brand).split(' '))
    return !['subset', 'equal'].includes(relation(w, new Set([...brand, ...ignore])))
  }
  if (!beyond(a, wa) || !beyond(b, wb)) return false
  const [short, shortProduct, long] = wa.size <= wb.size ? [wa, a, wb] : [wb, b, wa]
  return ['subset', 'equal'].includes(relation(short, long)) && beyond(shortProduct, short, GENERIC_WORDS)
}

/**
 * Products of the same brand family (first word) whose words nearly match (Jaccard at the threshold, or one reading's words all inside
 * the other's) but whose identity key differs: the cases for the model to decide (same product or not). Best first, equal similarity by id.
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
    .filter((c) => c.similarity >= threshold || contains(target, c.product))
    .sort((a, b) => b.similarity - a.similarity || (a.product.id < b.product.id ? -1 : 1))
    .slice(0, limit)
    .map((c) => c.product)
}
