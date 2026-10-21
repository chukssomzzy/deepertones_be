// The pure core of the shelf part's seeding (see matching.ts): what a product's single photos were read as, so the shelf
// eval seeds the catalog the way it would really come to hold the product, not with the eval owner's label wording.
import type { Recognition } from '../../src/providers/product-recognition/product-recognizer.provider'
import type { ProductIdentity } from '../../src/providers/product-research/product-researcher.provider'
import type { Label } from './matching-set'

/** One single photo's recognition, or why it has none (a failed call); `photo` is the file name, never a path. */
export type PhotoReading = { photo: string; recognition: Recognition } | { photo: string; error: string }

export type SeedSource = 'single-scan' | 'label'
/** `photo` is set exactly when `source` is 'single-scan': the photo the reading came from. */
export type ProductSeed = { identity: ProductIdentity; source: SeedSource; photo?: string }

/** The identity a label gives a product, exactly as `resolve` would be asked. */
export const identityOfLabel = (product: { label: Label }): ProductIdentity => {
  const { brand, name, variant, form, category } = product.label
  return { brand, name, category, ...(variant ? { variant } : {}), ...(form ? { form } : {}) }
}

/**
 * What the catalog really holds for this product: the first reading in `readings` that came back as a beauty
 * product, with the photo it came from, else the label. Pure; does not change `product` or `readings`.
 */
export const seedReadingOf = (product: { folder: string; label: Label }, readings: readonly PhotoReading[]): ProductSeed => {
  for (const reading of readings) {
    if (!('recognition' in reading) || reading.recognition.classification !== 'beauty-product') continue
    const { brand, name, variant, form, category } = reading.recognition
    return { identity: { brand, name, category, ...(variant ? { variant } : {}), ...(form ? { form } : {}) }, source: 'single-scan', photo: reading.photo }
  }
  return { identity: identityOfLabel(product), source: 'label' }
}
