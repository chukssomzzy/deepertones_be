import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { ProductCategory } from '../product-research/product-researcher.provider'

export type LabelReading =
  /**
   * `ingredients` are as printed, in label (INCI) order. `brand`, `name`, `variant` and `category` are there only when the
   * label prints them and they passed the checks; each is dropped on its own, without making the list unreadable.
   */
  | { readable: true; ingredients: string[]; brand?: string; name?: string; variant?: string; category?: ProductCategory }
  /** No usable ingredient list: none visible, unreadable, or an answer that could not be accepted. */
  | { readable: false }

/**
 * Reads the ingredient list off a photo of a label. Adapters throw their vendor's errors for failures the caller can
 * act on; "could not read it" is a result, not an error.
 */
export interface LabelReader {
  read(image: ProductImage): Promise<LabelReading>
}
