import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { ProductCategory, ProductForm } from '../product-research/product-researcher.provider'

export type Recognition =
  /** A beauty or personal-care product whose brand and name were read. `confidence` is 0 to 1. */
  | { classification: 'beauty-product'; brand: string; name: string; variant?: string; form?: ProductForm; category: ProductCategory; confidence: number }
  /** A product, but not beauty or personal care. */
  | { classification: 'other-product' }
  /** A person or a face and no readable product. */
  | { classification: 'face-or-person' }
  /** A beauty or personal-care product is in view, but its label is turned away, covered or out of frame, so no brand or name can be read. */
  | { classification: 'label-not-visible' }
  /** Nothing usable: blurry, dark, no product, or an answer that could not be accepted. */
  | { classification: 'unreadable' }

/** One beauty or personal-care product read on a shelf. `confidence` is 0 to 1. */
export type ShelfProduct = { brand: string; name: string; variant?: string; form?: ProductForm; category: ProductCategory; confidence: number }

/** What a shelf photo holds. Products are the readable beauty or personal-care ones, at most 5, most confident first. */
export type ShelfRecognition = {
  /** `beauty-product` exactly when `products` is not empty; otherwise why there are none. */
  classification: 'beauty-product' | 'other-product' | 'face-or-person' | 'unreadable'
  products: ShelfProduct[]
  /** Products in view that are not in `products`, each count 0 to 50. People and faces are never counted. Products cut for the limit of 5 are in neither. */
  excluded: { otherProducts: number; unreadable: number }
}

/**
 * Names the product in a photo. Adapters throw their vendor's errors for failures the caller can act on;
 * "could not tell" is a result, not an error.
 */
export interface ProductRecognizer {
  recognize(image: ProductImage): Promise<Recognition>
  /** Lists the products on a shelf photo. */
  recognizeShelf(image: ProductImage): Promise<ShelfRecognition>
}
