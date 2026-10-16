import type { ProductImage } from '../product-analysis/product-analyst.provider'

export type LabelReading =
  /** `ingredients` are as printed, in label (INCI) order. */
  | { readable: true; ingredients: string[] }
  /** No usable ingredient list: none visible, unreadable, or an answer that could not be accepted. */
  | { readable: false }

/**
 * Reads the ingredient list off a photo of a label. Adapters throw their vendor's errors for failures the caller can
 * act on; "could not read it" is a result, not an error.
 */
export interface LabelReader {
  read(image: ProductImage): Promise<LabelReading>
}
