import type { ProductIdentity } from '../product-research/product-researcher.provider'

/** A hard fact from the rule checks (banned, restricted, labelled allergen...) that the analysis must explain. */
export type FlaggedFact = {
  kind: string
  ingredient: string
  rule: string
  /** An https URL for a regulatory listing; null for a commonly cited concern that has no official source. */
  source: string | null
}

export type AnalysisInput = {
  product: ProductIdentity
  /** In label (INCI) order. */
  ingredients: string[]
  flaggedFacts: FlaggedFact[]
  /** The allowed values for a concern's kind, severity and traits; the caller owns these lists. */
  kinds: readonly string[]
  severities: readonly string[]
  traits: readonly string[]
}

/** A concern as the model wrote it, before the caller validates it against its own rules. */
export type DraftConcern = {
  kind: string
  severity: string
  ingredients: string[]
  why: string
  whoShouldTakeCare: string
  traits: string[]
  sources: string[]
}

export type ProductImage = {
  bytes: Uint8Array
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
}

/** The model-backed judgements about a product. Adapters throw their vendor's errors; answers are never guessed. */
export interface ProductAnalyst {
  /** The concerns for this formula as a whole, covering every flagged fact. */
  analyse(input: AnalysisInput): Promise<DraftConcern[]>
  /** Whether two spellings of brand, name and variant name the same product. */
  sameProduct(a: ProductIdentity, b: ProductIdentity): Promise<boolean>
  /** Whether the image is a photo of this product. */
  imageShowsProduct(image: ProductImage, product: ProductIdentity): Promise<boolean>
}
