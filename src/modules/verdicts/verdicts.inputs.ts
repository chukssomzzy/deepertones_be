import type { FitProduct, FitRequest } from '../../providers/verdict-fitting/verdict-fitter.provider'
import type { ShelfFacts } from '../catalog/catalog.service'
import { rulesMatching } from '../catalog/catalog.rules'
import type { VerdictReference } from '../catalog/catalog.workbook.service'
import { ROUTINE_STEPS, type Category, type ProductForm, type RoutineStep, type TaperKind } from '../catalog/catalog.vocabulary'
import { concernsForGoal, type Band, type ShownConcern, type SkinTypeLabel } from '../face-scans/face-scans.tables'
import type { Goal } from '../goals/goals.vocabulary'
import type { ParseState, SafetyMentionRow, SafetyView } from '../safety/safety.types'
import type { NoLabelPurpose } from '../scans/scans.vocabulary'
import type { ShelfActiveEntry } from '../shelf/shelf.service'
import type { FingerprintInput, FingerprintShelfEntry } from './verdicts.fingerprint'
import type { FloorEntry, FloorInput, FloorMention, FloorResult, FloorShelfEntry } from './verdicts.floor'
import type { VerdictProvenance } from './verdicts.types'

// The pure assembly of a shelf verdict's inputs (spec #171): the facts the accessors already loaded become the exact inputs of the floor, the merge, the fit
// judge, the fingerprint and the saved provenance. No I/O and no clock, so the same facts always give the same inputs.

/** Everything a build reads, loaded by the accessors beforehand. Each map is keyed as the accessor that gave it keys it. */
export type VerdictFacts = {
  reference: VerdictReference
  goal: Goal | null
  /** The profile's active shelf in shelf order. */
  entries: readonly ShelfActiveEntry[]
  /** By formulation id. */
  shelfFacts: ReadonlyMap<string, ShelfFacts>
  /** By no-label item id. */
  noLabelFacts: ReadonlyMap<string, { purpose: NoLabelPurpose; category: Category }>
  /** The routine steps of each catalog product, by catalog product id. */
  steps: ReadonlyMap<string, readonly RoutineStep[]>
  /** The skin concerns the recommendation catalog says each product is for, by catalog product id; a product the catalog does not recommend is absent. */
  skinConcerns: ReadonlyMap<string, readonly ShownConcern[]>
  safety: { view: SafetyView | null; parseState: ParseState | null; mentions: readonly SafetyMentionRow[] }
  /** The ingredient list of each product the user named, by catalog product id: the one input the accessors do not already give. */
  mentionIngredients: ReadonlyMap<string, string[]>
  scan: { skinType: SkinTypeLabel | null; concerns: readonly { concern: ShownConcern; band: Band }[] } | null
  /** The model and prompt the fit judge uses, which the fingerprint names. */
  fitter: { model: string; promptHash: string }
}

// A no-label entry has no name; the floor and the fingerprint still carry one, so it is fixed here and never varies with the entry. Changing its wording
// changes the fingerprint of every shelf with a no-label item, so every such verdict is rebuilt and the fit judge billed again.
const NO_LABEL_NAME = 'A product with no label'

type Resolved = {
  floor: FloorShelfEntry
  fingerprint: FingerprintShelfEntry
  step: RoutineStep | null
  form: ProductForm | null
  /** The sources of the rules that match the product's ingredients, once each and sorted; none for a rule that cites none. */
  sourceUrls: string[]
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// Mentions in a fixed order (source, then catalog product id with none last, then kind), so a saved row never depends on the order the safety answers came in.
const byMention = (a: VerdictProvenance['safety']['mentions'][number], b: VerdictProvenance['safety']['mentions'][number]): number =>
  byText(a.source, b.source) || byText(a.productId ?? '\uffff', b.productId ?? '\uffff') || byText(a.kind, b.kind)

const sortedUnique = <T extends string>(items: readonly T[]): T[] => [...new Set(items)].sort(byText)

/** The earliest of the steps in routine order, not in the order the catalog lists them. */
const firstStep = (steps: readonly RoutineStep[] | undefined): RoutineStep | null =>
  steps?.reduce<RoutineStep | null>((first, step) => (first === null || ROUTINE_STEPS.indexOf(step) < ROUTINE_STEPS.indexOf(first) ? step : first), null) ?? null

const matchedRules = (ingredients: readonly string[], reference: VerdictReference) => ingredients.flatMap((ingredient) => rulesMatching(ingredient, reference.rules))

const resolveEntry = (entry: ShelfActiveEntry, facts: VerdictFacts): Resolved | null => {
  if (entry.kind === 'no-label') {
    const noLabel = facts.noLabelFacts.get(entry.itemId)
    if (!noLabel) return null
    const base = { id: entry.id, brand: null, name: NO_LABEL_NAME, variant: null, category: noLabel.category }
    return {
      floor: { ...base, kind: 'no-label', noLabelPurpose: noLabel.purpose },
      fingerprint: { ...base, kind: 'no-label', noLabelPurpose: noLabel.purpose },
      step: null,
      form: null,
      sourceUrls: [],
    }
  }
  const product = facts.shelfFacts.get(entry.formulationId)
  if (!product) return null
  const base = { id: entry.id, brand: product.brand, name: product.name, variant: product.variant, category: product.category }
  return {
    floor: { ...base, kind: 'product', productId: product.productId, ingredients: product.ingredients },
    fingerprint: { ...base, kind: 'product', formulationId: entry.formulationId },
    step: firstStep(facts.steps.get(product.productId)),
    form: product.form,
    sourceUrls: sortedUnique(matchedRules(product.ingredients, facts.reference).flatMap((rule) => (rule.source === null ? [] : [rule.source]))),
  }
}

const resolve = (facts: VerdictFacts): { resolved: Resolved[]; unresolved: string[] } => {
  const resolved: Resolved[] = []
  const unresolved: string[] = []
  for (const entry of facts.entries) {
    const known = resolveEntry(entry, facts)
    if (known) resolved.push(known)
    else unresolved.push(entry.id)
  }
  return { resolved, unresolved }
}

const mentionOf = ({ source, kind, name, productId }: SafetyMentionRow, mentionIngredients: VerdictFacts['mentionIngredients']): FloorMention => ({
  source,
  kind,
  name,
  productId,
  ingredients: productId === null ? null : (mentionIngredients.get(productId) ?? null),
})

/**
 * The inputs of the floor and the merge, and what is known of each resolved entry. An entry whose formulation or no-label item is not in the facts is left out
 * of all of them and its id is reported in `unresolved`, since there is nothing to judge it by.
 */
export const assembleVerdictInputs = (facts: VerdictFacts) => {
  const { resolved, unresolved } = resolve(facts)
  const shelf = resolved.map(({ floor }) => floor)
  const floorInput: FloorInput = {
    shelf,
    rules: facts.reference.rules,
    claimPhrases: facts.reference.claimPhrases,
    tapers: facts.reference.tapers,
    safety: {
      excludesPregnancyCaution: facts.safety.view?.excludesPregnancyCaution ?? false,
      mentions: facts.safety.mentions.map((mention) => mentionOf(mention, facts.mentionIngredients)),
    },
  }
  return {
    floorInput,
    entries: shelf.map(({ id, category }) => ({ id, category })),
    unresolved,
    perEntry: new Map(resolved.map(({ floor, step, sourceUrls }): [string, { step: RoutineStep | null; sourceUrls: string[] }] => [floor.id, { step, sourceUrls }])),
  }
}

const fitFloorOf = (entry: FloorEntry): FitProduct['floor'] => (entry.status === 'open' ? { status: 'open' } : { status: 'fixed', group: entry.group })

/**
 * What the fit judge is asked, or null when there is nothing to ask: the profile has no goal to judge fit to, or the floor left no product open and found no
 * clash. Every skin entry is listed, the ones the floor decided as context.
 *
 * The two nulls differ for the caller: no open product means the verdict is complete without a fit, but no goal means the fit cannot be asked at all, and a
 * merge would leave the open products undecided for good. So the verdict build refuses a profile with no goal before it gets here.
 */
export const fitRequestOf = (facts: VerdictFacts, floor: FloorResult): FitRequest | null => {
  if (facts.goal === null) return null
  if (!floor.entries.some((entry) => entry.status === 'open') && floor.clashes.length === 0) return null

  const decided = new Map(floor.entries.map((entry) => [entry.id, entry]))
  const shelf = resolve(facts)
    .resolved.filter(({ floor: entry }) => entry.category === 'skin')
    .map(({ floor: entry, step, form }): FitProduct => {
      const decision = decided.get(entry.id)
      if (!decision) throw new Error(`The floor has no answer for the shelf product ${entry.id}`)
      const ingredients = entry.kind === 'product' ? entry.ingredients : []
      const matched = matchedRules(ingredients, facts.reference)
      const catalogConcerns = (entry.kind === 'product' ? facts.skinConcerns.get(entry.productId) : undefined) ?? []
      return {
        id: entry.id,
        brand: entry.brand,
        name: entry.name,
        variant: entry.variant,
        step,
        form,
        ingredients,
        cautions: sortedUnique(matched.map((rule) => rule.kind)),
        skinConcerns: sortedUnique([...matched.flatMap((rule) => rule.helps), ...catalogConcerns]),
        floor: fitFloorOf(decision),
      }
    })

  return {
    goal: { id: facts.goal, skinConcerns: concernsForGoal(facts.goal) },
    skinType: facts.scan?.skinType ?? null,
    scan: facts.scan?.concerns.map(({ concern, band }) => ({ concern, level: band })) ?? null,
    shelf,
    clashes: floor.clashes.map(({ ids, groups }) => ({ ids, groups })),
  }
}

/** The step-down codes the floor stopped a product with. */
const usedTaperCodes = (floor: FloorResult): string[] =>
  sortedUnique(floor.entries.flatMap((entry) => (entry.status === 'fixed' && entry.verdict.kind === 'stop' ? [entry.verdict.taperTemplateId] : [])))

const scanOf = (scan: VerdictFacts['scan']): VerdictProvenance['scan'] => scan && { skinType: scan.skinType, concerns: scan.concerns.map(({ concern, band }) => ({ concern, band })) }

/**
 * What the verdict is hashed from. `tapers` holds only the kinds whose template the floor used, so approving or replacing the code of a kind this shelf
 * never needed does not make it stale.
 */
export const fingerprintInputOf = (facts: VerdictFacts, floor: FloorResult): FingerprintInput => {
  const codes = new Set(usedTaperCodes(floor))
  return {
    rulesVersion: facts.reference.rulesVersion,
    rules: facts.reference.rules,
    claimPhrases: facts.reference.claimPhrases,
    tapers: Object.fromEntries(Object.entries(facts.reference.tapers).filter(([, code]) => codes.has(code))) as Partial<Record<TaperKind, string>>,
    goal: facts.goal,
    shelf: resolve(facts).resolved.map(({ fingerprint }) => fingerprint),
    safety: facts.safety,
    scan: scanOf(facts.scan),
    model: facts.fitter.model,
    promptHash: facts.fitter.promptHash,
  }
}

/**
 * What the saved row records of its inputs: ids, codes and bands, never a word the user typed or a product's name. Only skin entries are listed, as the
 * verdict itself shows only those; a mention is its source, its catalog product id and its kind and resolution, never its name.
 */
export const provenanceOf = (facts: VerdictFacts, floor: FloorResult): VerdictProvenance => ({
  goal: facts.goal,
  entries: resolve(facts)
    .resolved.filter((entry) => entry.floor.category === 'skin')
    .map(({ fingerprint }) =>
      fingerprint.kind === 'product' ? { id: fingerprint.id, formulationId: fingerprint.formulationId } : { id: fingerprint.id, noLabelPurpose: fingerprint.noLabelPurpose },
    ),
  scan: scanOf(facts.scan),
  safety: {
    choices: [...(facts.safety.view?.choices ?? [])].sort(byText),
    parseState: facts.safety.parseState,
    mentions: facts.safety.mentions.map(({ source, productId, kind, resolution }) => ({ source, productId, kind, resolution })).sort(byMention),
  },
  taperCodes: usedTaperCodes(floor),
})
