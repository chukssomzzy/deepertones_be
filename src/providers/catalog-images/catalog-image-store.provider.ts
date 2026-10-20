import type { ProductImage } from '../product-analysis/product-analyst.provider'

/**
 * Where product stock images come from and go to. Failures to obtain an image are `null`, never
 * errors: a product without a stock image is normal. `put` and `delete` throw on storage failure so
 * the caller can retry.
 */
export interface CatalogImageStore {
  /** Downloads a JPEG, PNG or WebP from a public https URL, or null for anything else or any failure. */
  fetchImage(url: string): Promise<ProductImage | null>
  /** The page's own image (its JSON-LD Product image, else og:image, else twitter:image) as an absolute public https URL, or null for anything else or any failure. Never throws. */
  pageImageUrl(pageUrl: string): Promise<string | null>
  put(key: string, image: ProductImage): Promise<void>
  /** Deleting a key that is not there is not an error. */
  delete(key: string): Promise<void>
  /** Where the world can load the object, or null when the store has no public address. */
  publicUrl(key: string): string | null
}
