import type { Category } from '../catalog/catalog.vocabulary'
import type { FitResult } from '../../providers/verdict-fitting/verdict-fitter.provider'
import type { ShelfVerdict } from '../routines/routines.types'
import type { SafetyChoice } from '../safety/safety.vocabulary'
import { clashReason, floorReason } from './verdicts.copy'
import type { FloorFact, FloorGroup, FloorResult } from './verdicts.floor'

// The merge of the shelf verdict (spec #171): the rules floor's answer and the fit judge's answer, or none, become the one verdict that is saved. A PURE function
// of plain data. A product the floor decided keeps its label with the floor's own words; a product it left open takes the judge's label and reason; a clash is
// applied only when both its products survive. No step moves a product to a less strict group: the floor's label is never touched, the judge's drop is never
// loosened by a clash, and the only thing the merge adds to a kept product is a reduction to alternate days.

export type VerdictGroup = FloorGroup | 'helping' | 'redundant' | 'blocking' | 'undecided'

export type VerdictProduct = {
  entryId: string
  group: VerdictGroup
  verdict: ShelfVerdict
  escalate: boolean
  reason: string
  /** The floor's facts for a product it decided, and none for any other. */
  facts: FloorFact[]
  /** A redundant product: the product that stays and does its job. */
  sameJobAs?: string
  /** A can't-tell product: what to do to get it read. */
  nudge?: 'photograph-back-label'
}

export type MergedVerdict = {
  /** Ready when the judge answered, or had nothing to answer. Not ready: the open products are undecided and the build is retried. */
  fit: 'ready' | 'not-ready'
  products: VerdictProduct[]
}

export type MergeInput = {
  floor: FloorResult
  /** Null when the judge failed, was refused or has not run. */
  fit: FitResult | null
  /** The shelf in its order: the output follows it and leaves out what is not skin. */
  entries: readonly { id: string; category: Category }[]
  /** The profile's safety choices, which the stop copy reads. */
  choices?: readonly SafetyChoice[]
}

// Shown for an open product while the judge has not answered.
const UNDECIDED_REASON = 'Kept for now while we check how well it fits your goal.'

const pairKey = (a: string, b: string): string => JSON.stringify([a, b].sort())

const survives = (product: VerdictProduct): boolean => product.verdict.kind === 'keep' || product.verdict.kind === 'reduce'

const floorProduct = (entry: Extract<FloorResult['entries'][number], { status: 'fixed' }>, choices: readonly SafetyChoice[]): VerdictProduct => ({
  entryId: entry.id,
  group: entry.group,
  verdict: entry.verdict,
  escalate: entry.escalate,
  reason: floorReason(entry, choices),
  facts: entry.facts,
  ...(entry.group === 'cant-tell' ? { nudge: 'photograph-back-label' as const } : {}),
})

const openProduct = (id: string, fit: FitResult | null): VerdictProduct => {
  if (fit === null) return { entryId: id, group: 'undecided', verdict: { kind: 'keep' }, escalate: false, reason: UNDECIDED_REASON, facts: [] }
  const said = fit.products.find((product) => product.id === id)
  if (!said) throw new Error(`The fit judge gave no answer for the open product ${id}`)
  const base = { entryId: id, escalate: false, reason: said.reason, facts: [] }
  switch (said.label) {
    case 'redundant':
      return { ...base, group: 'redundant', verdict: { kind: 'drop' }, sameJobAs: said.sameJobAs }
    case 'helping':
      return { ...base, group: 'helping', verdict: { kind: 'keep' } }
    case 'blocking':
      return { ...base, group: 'blocking', verdict: { kind: 'drop' } }
    default:
      // Never a drop by default: a label the types do not allow (a fake that does not check) is a bug to see, not a product to stop.
      throw new Error(`The fit judge gave the label ${JSON.stringify((said as { label: unknown }).label)} for ${id}, which is not helping, redundant or blocking`)
  }
}

/** Reduces, to alternate days, one product of each clashing pair whose two products both survive: the judge's pick, or the floor's tie-break when it names none. */
const applyClashes = (products: Map<string, VerdictProduct>, { floor, fit }: Pick<MergeInput, 'floor' | 'fit'>): void => {
  const settled = new Map((fit?.clashes ?? []).map(({ ids, reduceId }) => [pairKey(...ids), reduceId]))
  for (const { ids, groups, fallbackReduceId, maxFrequency } of floor.clashes) {
    const [a, b] = ids.map((id) => products.get(id))
    if (!a || !b || !survives(a) || !survives(b)) continue
    const named = settled.get(pairKey(...ids))
    // A prescribed product is never reduced, so a pick of one falls back to the floor's, which never is.
    const reduceId = named !== undefined && ids.includes(named) && products.get(named)?.group !== 'prescribed' ? named : fallbackReduceId
    const target = products.get(reduceId)
    // A defence only: the floor never picks a prescribed product as the fallback, so this cannot happen unless the floor changes.
    if (!target || target.group === 'prescribed') throw new Error(`The clash of ${ids.join(' and ')} has no product that can be reduced`)
    if (target.verdict.kind === 'reduce') continue
    products.set(reduceId, {
      ...target,
      group: 'conflicting',
      verdict: { kind: 'reduce', maxFrequency },
      reason: clashReason(reduceId === ids[0] ? groups : [groups[1], groups[0]]),
    })
  }
}

/**
 * Throws, so that no verdict is saved, when a product needs a step-down that has no approved template (a product that needs one is never shown as a plain drop),
 * when the floor has no answer for a shelf product, or when the judge's answer does not fit the shelf.
 */
export const mergeVerdict = ({ floor, fit, entries, choices = [] }: MergeInput): MergedVerdict => {
  for (const entry of floor.entries) {
    if (entry.status === 'taper-missing') throw new Error(`No approved ${entry.missingTaper} step-down template, which ${entry.id} needs`)
  }

  const decided = new Map(floor.entries.map((entry) => [entry.id, entry]))
  // Insertion order is the shelf's order, which is the output's.
  const products = new Map<string, VerdictProduct>()
  for (const { id, category } of entries) {
    if (category !== 'skin') continue
    const entry = decided.get(id)
    if (!entry) throw new Error(`The floor has no answer for the shelf product ${id}`)
    // A fit answer for a product the floor fixed is never read: the floor's label cannot be changed by it.
    products.set(id, entry.status === 'fixed' ? floorProduct(entry, choices) : openProduct(id, fit))
  }
  applyClashes(products, { floor, fit })

  const merged = [...products.values()]
  for (const product of merged) {
    if (product.group !== 'redundant') continue
    const kept = product.sameJobAs === undefined ? undefined : products.get(product.sameJobAs)
    if (!kept || !survives(kept)) throw new Error(`The redundant product ${product.entryId} names ${product.sameJobAs}, which is not a product that stays`)
  }

  const needsAnswer = floor.entries.some((entry) => entry.status === 'open') || floor.clashes.length > 0
  return { fit: fit !== null || !needsAnswer ? 'ready' : 'not-ready', products: merged }
}
