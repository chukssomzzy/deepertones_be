import { ingredientParts, ingredientsKey } from '../catalog/catalog.ingredients'
import type { ReferenceEntry } from '../catalog/catalog.reference'
import { flagFacts } from '../catalog/catalog.rules'
import { INGREDIENT_GROUPS, type Category, type IngredientGroup, type TaperKind } from '../catalog/catalog.vocabulary'
import type { ShelfVerdict } from '../routines/routines.types'
import { anyIn, namedIn, type NamedMention } from '../safety/safety.matching'
import type { MentionSource } from '../safety/safety.types'
import type { NoLabelPurpose } from '../scans/scans.vocabulary'

// The rules floor of the shelf verdict (spec #171): the safety labels, decided by fixed rules over reviewed facts and never by a model. A PURE function of
// plain data (no I/O, no clock, never edits its input) so the same shelf, rules and safety answers are always the same verdict, and so the fit judge, which
// may only make a verdict stricter, has a floor it cannot lower. It reads the live rules' `group`, never the AI-written formulation concerns (ADR 0001:
// ingredient rules beat a product's claims).

export type FloorRule = ReferenceEntry & {
  /** The Ingredients tab's group; null for most rules. */
  group: IngredientGroup | null
  /** Groups this rule's group clashes with. Read as the union of both directions, so a clash listed on one side only still pairs. */
  clashesWith: IngredientGroup[]
}

type FloorShelfBase = { id: string; brand: string | null; name: string; variant: string | null; category: Category }

export type FloorShelfEntry =
  | (FloorShelfBase & { kind: 'product'; productId: string; ingredients: string[] })
  | (FloorShelfBase & { kind: 'no-label'; noLabelPurpose: NoLabelPurpose })

export type FloorMention = NamedMention & {
  source: MentionSource
  /** The ingredient list of the product the words were resolved to, when the catalog has one. */
  ingredients: string[] | null
}

export type FloorInput = {
  shelf: readonly FloorShelfEntry[]
  rules: readonly FloorRule[]
  /** The workbook's reviewed lightening claim phrases. */
  claimPhrases: readonly string[]
  /** The approved step-down template code for each kind that has one. */
  tapers: Readonly<Partial<Record<TaperKind, string>>>
  safety: { excludesPregnancyCaution: boolean; mentions: readonly FloorMention[] }
}

export type FloorFact =
  | { kind: 'ingredient-group'; group: IngredientGroup; ingredient: string }
  | { kind: 'banned-substance'; ingredient: string }
  | { kind: 'claim-phrase'; phrase: string }
  | { kind: 'no-label-purpose'; purpose: NoLabelPurpose }
  | { kind: 'reaction-product' }
  | { kind: 'pregnancy-caution'; ingredient: string }
  | { kind: 'reaction-ingredient'; ingredient: string; named: string }
  | { kind: 'unknown-contents' }
  | { kind: 'prescription' }

export type FloorGroup = 'prescribed' | 'likely-the-problem' | 'conflicting' | 'cant-tell'

export type FloorEntry =
  /** Nothing is known against it: the fit judge decides. */
  | { id: string; status: 'open' }
  | { id: string; status: 'fixed'; group: FloorGroup; verdict: Extract<ShelfVerdict, { kind: 'keep' | 'stop' | 'drop' }>; escalate: boolean; facts: FloorFact[] }
  /** It needs a step-down of this kind and none is approved. The floor never invents a template code. */
  | { id: string; status: 'taper-missing'; group: 'likely-the-problem'; missingTaper: TaperKind; escalate: false; facts: FloorFact[] }

export type ClashPair = {
  ids: [string, string]
  groups: [IngredientGroup, IngredientGroup]
  /** The fixed tie-break, used only when the fit judge names none: never a prescribed product, then an exfoliant or benzoyl peroxide before a retinoid, then shelf order. */
  fallbackReduceId: string
  maxFrequency: 'alternate-days'
}

export type FloorResult = { entries: FloorEntry[]; clashes: ClashPair[] }

type FloorProduct = Extract<FloorShelfEntry, { kind: 'product' }>
type Held = Map<IngredientGroup, FloorFact[]>

type Context = {
  input: FloorInput
  byGroup: Map<IngredientGroup, FloorRule[]>
  /** Banned rules whose group (if any) decides nothing on its own, so a banned ingredient can never fall through every label. */
  strayBanned: FloorRule[]
  prescribed: readonly FloorMention[]
  reactedProducts: readonly FloorMention[]
  reactedIngredients: readonly FloorMention[]
}

// Mercury, steroid and lightening-agent have their own outcome. Any other banned rule, grouped or not, falls to "a banned ingredient: drop".
const OUTCOME_GROUPS: readonly IngredientGroup[] = ['mercury', 'steroid', 'lightening-agent']

// When a clashing pair is left to the floor, the product that holds one of these groups is reduced before one that holds anything else (a retinoid is the
// treatment, the acid and the peroxide are the add-ons). Equal rank: the one first on the shelf.
const REDUCED_FIRST: readonly IngredientGroup[] = ['exfoliating-acid', 'benzoyl-peroxide']

const groupRules = (rules: readonly FloorRule[]): Map<IngredientGroup, FloorRule[]> => {
  const byGroup = new Map<IngredientGroup, FloorRule[]>()
  for (const rule of rules) if (rule.group !== null) byGroup.set(rule.group, [...(byGroup.get(rule.group) ?? []), rule])
  return byGroup
}

const contextOf = (input: FloorInput): Context => ({
  input,
  byGroup: groupRules(input.rules),
  strayBanned: input.rules.filter((rule) => rule.kind === 'banned-substance' && (rule.group === null || !OUTCOME_GROUPS.includes(rule.group))),
  prescribed: input.safety.mentions.filter((mention) => mention.source === 'prescription' && mention.kind === 'product'),
  reactedProducts: input.safety.mentions.filter((mention) => mention.source === 'reaction' && mention.kind === 'product'),
  reactedIngredients: input.safety.mentions.filter((mention) => mention.source === 'reaction' && mention.kind === 'ingredient'),
})

const uniqueIngredients = <T extends { ingredient: string }>(facts: T[]): T[] => facts.filter((fact, at) => facts.findIndex((other) => other.ingredient === fact.ingredient) === at)

const heldGroups = (product: FloorProduct, byGroup: Map<IngredientGroup, FloorRule[]>): Held => {
  const held: Held = new Map()
  for (const [group, rules] of byGroup) {
    const facts = uniqueIngredients(flagFacts(product.ingredients, rules)).map(({ ingredient }): FloorFact => ({ kind: 'ingredient-group', group, ingredient }))
    if (facts.length > 0) held.set(group, facts)
  }
  return held
}

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '')

const hasPhrase = (words: string[], phrase: string[]): boolean =>
  phrase.length > 0 && words.some((_, at) => phrase.every((word, offset) => words[at + offset] === word))

/** The approved claim phrases found as whole words in the brand, the name or the variant (each on its own, so a phrase never spans two fields). */
const claimFacts = (product: FloorProduct, claimPhrases: readonly string[]): FloorFact[] => {
  const fields = [product.brand, product.name, product.variant].flatMap((field) => (field === null ? [] : [wordsOf(field)]))
  return [...new Set(claimPhrases)]
    .filter((phrase) => fields.some((words) => hasPhrase(words, wordsOf(phrase))))
    .map((phrase): FloorFact => ({ kind: 'claim-phrase', phrase }))
}

const bannedFacts = (product: FloorProduct, strayBanned: FloorRule[]): FloorFact[] =>
  uniqueIngredients(flagFacts(product.ingredients, strayBanned).filter((fact) => fact.kind === 'banned-substance')).map(({ ingredient }): FloorFact => ({ kind: 'banned-substance', ingredient }))

const isNamedProduct = (product: FloorProduct, mentions: readonly FloorMention[], rules: readonly FloorRule[]): boolean => {
  const { productIds } = namedIn(mentions, rules)
  // The key is derived here from the same list the rest of the floor reads, so the match cannot drift from the ingredients.
  const key = ingredientsKey(product.ingredients)
  return productIds.has(product.productId) || mentions.some((mention) => mention.ingredients !== null && mention.ingredients.length > 0 && ingredientsKey(mention.ingredients) === key)
}

const pregnancyFacts = (product: FloorProduct, rules: readonly FloorRule[]): FloorFact[] =>
  flagFacts(product.ingredients, rules)
    .filter((fact) => fact.kind === 'pregnancy-caution')
    .map(({ ingredient }): FloorFact => ({ kind: 'pregnancy-caution', ingredient }))

const reactionIngredientFacts = (product: FloorProduct, mentions: readonly FloorMention[], rules: readonly FloorRule[]): FloorFact[] =>
  uniqueIngredients(
    mentions.flatMap((mention) => {
      const { ingredientParts: named } = namedIn([mention], rules)
      const ingredient = product.ingredients.find((candidate) => anyIn(ingredientParts(candidate), named))
      return ingredient === undefined ? [] : [{ kind: 'reaction-ingredient' as const, ingredient, named: mention.name }]
    }),
  )

const fixed = (id: string, group: FloorGroup, verdict: Extract<FloorEntry, { status: 'fixed' }>['verdict'], facts: FloorFact[], escalate = false): FloorEntry => ({
  id,
  status: 'fixed',
  group,
  verdict,
  escalate,
  facts,
})

/** The step-down of `kind` if one is approved; otherwise the entry says which kind is missing rather than naming a template. */
const stepDown = (id: string, kind: TaperKind, facts: FloorFact[], tapers: FloorInput['tapers']): FloorEntry => {
  const taperTemplateId = tapers[kind]
  if (!taperTemplateId) return { id, status: 'taper-missing', group: 'likely-the-problem', missingTaper: kind, escalate: false, facts }
  return fixed(id, 'likely-the-problem', { kind: 'stop', taperTemplateId }, facts)
}

/** Likely the problem, strictest trigger first: mercury, steroid, lightening, a banned ingredient with nothing else to say, the product the user reacted to. */
const likelyTheProblem = (product: FloorProduct, held: Held, context: Context): FloorEntry | null => {
  const { id } = product
  const { tapers } = context.input
  const mercury = held.get('mercury')
  if (mercury) return fixed(id, 'likely-the-problem', { kind: 'drop' }, mercury, true)
  const steroid = held.get('steroid')
  if (steroid) return stepDown(id, 'steroid', steroid, tapers)
  const lightening = [...(held.get('lightening-agent') ?? []), ...claimFacts(product, context.input.claimPhrases)]
  if (lightening.length > 0) return stepDown(id, 'lightening-agent', lightening, tapers)
  const banned = bannedFacts(product, context.strayBanned)
  if (banned.length > 0) return fixed(id, 'likely-the-problem', { kind: 'drop' }, banned)
  if (isNamedProduct(product, context.reactedProducts, context.input.rules)) return fixed(id, 'likely-the-problem', { kind: 'drop' }, [{ kind: 'reaction-product' }])
  return null
}

/** Conflicting, which drops the product: a pregnancy caution for a pregnant or breastfeeding user, or an ingredient the user reacted to. */
const conflicting = (product: FloorProduct, context: Context): FloorEntry | null => {
  const { rules, safety } = context.input
  const facts = [...(safety.excludesPregnancyCaution ? pregnancyFacts(product, rules) : []), ...reactionIngredientFacts(product, context.reactedIngredients, rules)]
  return facts.length > 0 ? fixed(product.id, 'conflicting', { kind: 'drop' }, facts) : null
}

const productEntry = (product: FloorProduct, held: Held, context: Context): FloorEntry => {
  if (isNamedProduct(product, context.prescribed, context.input.rules)) return fixed(product.id, 'prescribed', { kind: 'keep' }, [{ kind: 'prescription' }])
  const decided = likelyTheProblem(product, held, context) ?? conflicting(product, context)
  if (decided) return decided
  // An empty list reads as "nothing flagged" but really means nothing is known, so it is never left open (never guess).
  return product.ingredients.length === 0 ? cantTell(product.id) : { id: product.id, status: 'open' }
}

const cantTell = (id: string): FloorEntry => fixed(id, 'cant-tell', { kind: 'drop' }, [{ kind: 'unknown-contents' }])

/**
 * A no-label entry has no list to read: what the user said it is for decides, and otherwise it is set aside rather than guessed at.
 * The lighten case mirrors `cautionFor` in scans.cautions.ts, which warns about a lightener on the same answer.
 */
const noLabelEntry = (id: string, purpose: NoLabelPurpose, tapers: FloorInput['tapers']): FloorEntry =>
  purpose === 'lighten' ? stepDown(id, 'lightening-agent', [{ kind: 'no-label-purpose', purpose }], tapers) : cantTell(id)

const clashRelation = (rules: readonly FloorRule[]): Map<IngredientGroup, Set<IngredientGroup>> => {
  const related = new Map<IngredientGroup, Set<IngredientGroup>>(INGREDIENT_GROUPS.map((group) => [group, new Set()]))
  for (const { group, clashesWith } of rules) {
    if (group === null) continue
    for (const other of clashesWith) {
      related.get(group)?.add(other)
      related.get(other)?.add(group)
    }
  }
  return related
}

type Candidate = { id: string; prescribed: boolean; groups: IngredientGroup[] }

const clashingGroups = (a: Candidate, b: Candidate, related: Map<IngredientGroup, Set<IngredientGroup>>): [IngredientGroup, IngredientGroup] | null => {
  for (const ga of a.groups) {
    const gb = b.groups.find((group) => group !== ga && related.get(ga)?.has(group))
    if (gb !== undefined) return [ga, gb]
  }
  return null
}

const reduceRank = (candidate: Candidate): number => (candidate.groups.some((group) => REDUCED_FIRST.includes(group)) ? 0 : 1)

/** The product of a pair the floor would reduce: never a prescribed one, then the add-on over the treatment, then the one first on the shelf. */
const fallbackOf = (a: Candidate, b: Candidate): Candidate | null => {
  if (a.prescribed && b.prescribed) return null
  if (a.prescribed) return b
  if (b.prescribed) return a
  return reduceRank(b) < reduceRank(a) ? b : a
}

const clashPairs = (candidates: Candidate[], rules: readonly FloorRule[]): ClashPair[] => {
  const related = clashRelation(rules)
  const pairs: ClashPair[] = []
  candidates.forEach((a, at) => {
    for (const b of candidates.slice(at + 1)) {
      const groups = clashingGroups(a, b, related)
      const reduce = groups && fallbackOf(a, b)
      if (groups && reduce) pairs.push({ ids: [a.id, b.id], groups, fallbackReduceId: reduce.id, maxFrequency: 'alternate-days' })
    }
  })
  return pairs
}

export const floorVerdicts = (input: FloorInput): FloorResult => {
  const context = contextOf(input)
  const entries: FloorEntry[] = []
  const candidates: Candidate[] = []
  for (const item of input.shelf) {
    if (item.category !== 'skin') continue
    if (item.kind === 'no-label') {
      entries.push(noLabelEntry(item.id, item.noLabelPurpose, input.tapers))
      continue
    }
    const held = heldGroups(item, context.byGroup)
    const entry = productEntry(item, held, context)
    entries.push(entry)
    // Only a product still in play can be reduced: a stopped or dropped one is already out. A prescribed one stays in the pair but is never the fallback.
    const prescribed = entry.status === 'fixed' && entry.group === 'prescribed'
    if (entry.status === 'open' || prescribed) candidates.push({ id: item.id, prescribed, groups: [...held.keys()] })
  }
  return { entries, clashes: clashPairs(candidates, input.rules) }
}
