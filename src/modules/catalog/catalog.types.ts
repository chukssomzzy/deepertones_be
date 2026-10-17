import type { analysisAttempts, formulationConcerns, formulations, products, researchAttempts } from './catalog.table'
import type { Trait } from './catalog.vocabulary'

export type Product = typeof products.$inferSelect

/** A product to create; it has no image yet. It is `named` unless it says otherwise, and its search text is empty unless given. */
export type NewProduct = Omit<Product, 'imageKey' | 'imageSourceUrl' | 'imageCheckedAt' | 'kind' | 'searchText'> & { kind?: Product['kind']; searchText?: string }

export type Formulation = typeof formulations.$inferSelect

/** A formulation to create; it has not been analysed yet. */
export type NewFormulation = Omit<Formulation, 'analysisVersion' | 'referenceVersion' | 'analysedAt'>

type ConcernRow = typeof formulationConcerns.$inferSelect

/** A concern as the analysis produces it, before it is stored. */
export type DraftConcernRow = Omit<ConcernRow, 'id' | 'formulationId' | 'position'> & { traits: Trait[] }

/** A stored concern, with its traits (sorted). */
export type StoredConcern = DraftConcernRow & Pick<ConcernRow, 'id' | 'formulationId' | 'position'>

export type ResearchAttempt = typeof researchAttempts.$inferSelect

export type AnalysisAttempt = typeof analysisAttempts.$inferSelect
