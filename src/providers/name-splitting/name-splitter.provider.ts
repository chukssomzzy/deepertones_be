import type { ProductCategory } from '../product-research/product-researcher.provider'

export type NameSplit =
  /** The text read as a product: `brand` and `name` are never empty, each field passed the checks, and `variant` is there only when the text gave one. */
  | { kind: 'product'; brand: string; name: string; variant?: string; category: ProductCategory }
  /** The text is not a product's name, or the answer could not be accepted. */
  | { kind: 'not-a-product' }

/**
 * Splits a name a user typed ("cerave hydrating facial cleanser night") into the brand, name, variant and category of a product.
 * Adapters throw their vendor's errors for failures the caller can act on; "that is not a product" is a result, not an error.
 */
export interface NameSplitter {
  split(text: string): Promise<NameSplit>
}
