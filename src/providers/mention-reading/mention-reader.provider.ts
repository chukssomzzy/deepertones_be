import type { ProductCategory } from '../product-research/product-researcher.provider'

/** A product or an ingredient the person named in their own words. Nothing here comes from what the model knows about a product. */
export type Mention =
  /** `brand` is null for a thing the person named without a maker ("the white tub from the market"); `category` is null when the reader cannot tell. */
  | { kind: 'product'; brand: string | null; name: string; variant?: string; category: ProductCategory | null }
  | { kind: 'ingredient'; name: string }

/**
 * Lists the products and ingredients named in words a user typed beside "a product gave me a reaction" or "I use a prescription".
 * Adapters throw their vendor's errors for failures the caller can act on; "nothing named in these words" is a result (an empty list), not an error.
 */
export interface MentionReader {
  read(text: string): Promise<Mention[]>
}
