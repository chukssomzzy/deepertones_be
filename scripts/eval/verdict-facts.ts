/*
 * A verdict case as the facts a real build reads (`VerdictFacts`), so the eval runs the REAL `assembleVerdictInputs` and the REAL rules floor over it and never a
 * copy of either. Everything the accessors would have loaded from the database is made up here from the case: ids that are unique in the case, the maps keyed as
 * the accessors key them, and the safety rows the parse would have saved.
 */
import type { ShelfFacts } from '../../src/modules/catalog/catalog.service'
import type { VerdictReference } from '../../src/modules/catalog/catalog.workbook.service'
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { ShownConcern } from '../../src/modules/face-scans/face-scans.tables'
import type { SafetyMentionRow } from '../../src/modules/safety/safety.types'
import type { NoLabelPurpose } from '../../src/modules/scans/scans.vocabulary'
import type { ShelfActiveEntry } from '../../src/modules/shelf/shelf.service'
import type { VerdictFacts } from '../../src/modules/verdicts/verdicts.inputs'
import type { VerdictCase } from './verdict-cases'

const EPOCH = new Date('2030-01-01T00:00:00.000Z')
/** Each entry is added a second after the one before, so the shelf order is the order the case lists them. */
const addedAt = (position: number): Date => new Date(EPOCH.getTime() + position * 1000)

export const factsOf = (c: VerdictCase, reference: VerdictReference, fitter: VerdictFacts['fitter']): VerdictFacts => {
  const entries: ShelfActiveEntry[] = []
  const shelfFacts = new Map<string, ShelfFacts>()
  const noLabelFacts = new Map<string, { purpose: NoLabelPurpose; category: 'skin' }>()
  const steps = new Map<string, readonly RoutineStep[]>()
  const skinConcerns = new Map<string, readonly ShownConcern[]>()
  const productIdOf = new Map<string, string>()
  const ingredientsOf = new Map<string, string[]>()

  c.shelf.forEach((entry, position) => {
    if (entry.kind === 'no-label') {
      const itemId = `item-${entry.id}`
      entries.push({ id: entry.id, kind: 'no-label', addedAt: addedAt(position), itemId })
      noLabelFacts.set(itemId, { purpose: entry.purpose, category: 'skin' })
      return
    }
    const productId = `product-${entry.id}`
    const formulationId = `formulation-${entry.id}`
    entries.push({ id: entry.id, kind: 'product', addedAt: addedAt(position), productId, formulationId })
    shelfFacts.set(formulationId, { productId, brand: entry.brand, name: entry.name, variant: entry.variant, form: entry.form, category: entry.category, ingredients: [...entry.ingredients] })
    steps.set(productId, [...entry.steps])
    if (entry.skinConcerns && entry.skinConcerns.length > 0) skinConcerns.set(productId, [...entry.skinConcerns])
    productIdOf.set(entry.id, productId)
    ingredientsOf.set(productId, [...entry.ingredients])
  })

  const mentionIngredients = new Map<string, string[]>()
  const mentions = c.safety.mentions.map((mention, position): SafetyMentionRow => {
    // A mention resolves only to a product of the shelf (the loader refuses any other): anything else is left unresolved.
    const productId = mention.kind === 'product' && mention.resolvesTo !== null ? (productIdOf.get(mention.resolvesTo) ?? null) : null
    if (productId !== null) mentionIngredients.set(productId, [...(ingredientsOf.get(productId) ?? [])])
    return {
      id: `mention-${position}`,
      safetyId: 'safety',
      source: mention.source,
      kind: mention.kind,
      brand: null,
      name: mention.name,
      variant: null,
      category: null,
      productId,
      resolution: mention.kind === 'product' ? (productId === null ? 'unresolved' : 'resolved') : null,
      position,
      createdAt: EPOCH,
    }
  })

  return {
    reference,
    goal: c.goal,
    entries,
    shelfFacts,
    noLabelFacts,
    steps,
    skinConcerns,
    safety: {
      // The service's rule: a person who is pregnant or breastfeeding is held to the same cautions.
      view: {
        choices: [...c.safety.choices],
        reactionText: null,
        prescriptionText: null,
        excludesPregnancyCaution: c.safety.choices.some((choice) => choice === 'pregnant' || choice === 'breastfeeding'),
        updatedAt: EPOCH,
      },
      parseState: mentions.length > 0 ? 'done' : 'none',
      mentions,
    },
    mentionIngredients,
    scan: c.scan,
    fitter: { ...fitter },
  }
}
