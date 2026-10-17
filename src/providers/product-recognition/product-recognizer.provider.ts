import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { ProductCategory, ProductForm } from '../product-research/product-researcher.provider'

export type Recognition =
  /** A beauty or personal-care product whose brand and name were read. `confidence` is 0 to 1. */
  | { classification: 'beauty-product'; brand: string; name: string; variant?: string; form?: ProductForm; category: ProductCategory; confidence: number }
  /** A product, but not beauty or personal care. */
  | { classification: 'other-product' }
  /** A person or a face and no readable product. */
  | { classification: 'face-or-person' }
  /** Nothing usable: blurry, dark, no product, or an answer that could not be accepted. */
  | { classification: 'unreadable' }

/**
 * Names the product in a photo. Adapters throw their vendor's errors for failures the caller can act on;
 * "could not tell" is a result, not an error.
 */
export interface ProductRecognizer {
  recognize(image: ProductImage): Promise<Recognition>
}
