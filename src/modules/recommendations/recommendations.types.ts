import type { ProductSummary } from '../catalog/catalog.service'
import type { Frequency, Origin } from '../catalog/catalog.vocabulary'
import type { ShownConcern } from '../face-scans/face-scans.tables'
import type { profileShopping } from './recommendations.table'

export type ShoppingRow = typeof profileShopping.$inferSelect

/** A profile's current shopping country and budget band as the app sees them. */
export type ShoppingView = {
  country: string
  budgetBand: ShoppingRow['budgetBand']
  updatedAt: Date
}

/** The rules a candidate passed, in this fixed order. `budget` is there only when the user gave a band, `reactions` only when they named something that could be checked. */
export type CandidateRule = 'country' | 'step' | 'skin-concern' | 'skin-type' | 'budget' | 'ingredient-rules' | 'reactions'

/** A candidate's ingredients that are also in a product the user said gave them a reaction, spelled as the candidate lists them. Information, never a filter. */
export type SharedWithReaction = { productId: string; ingredients: string[] }

/** A reviewed product that may be suggested for a routine step: the row's own facts for the routine to show, and why it is here. */
export type Candidate = {
  code: string
  product: ProductSummary
  skinConcerns: ShownConcern[]
  ingredients: string[]
  /** Context for the AI that writes the routine and for the team. Never in a response or on a screen. */
  evidenceUrls: string[]
  ingredientsSourceUrl: string | null
  passed: CandidateRule[]
  sharedWithReaction: SharedWithReaction[]
  origin: Origin
  frequency: Frequency
  priceMin: number
  priceMax: number
  whereSold: string | null
}
