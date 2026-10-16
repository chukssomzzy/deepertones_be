import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { PhotoStore } from './photo-store.provider'

/** Keeps photos in a map. It does not check keys: the real store does, and its own tests pin that. For tests. */
export class MemoryPhotoStore implements PhotoStore {
  readonly stored = new Map<string, ProductImage>()

  async put(key: string, image: ProductImage): Promise<void> {
    this.stored.set(key, image)
  }

  async get(key: string): Promise<ProductImage | null> {
    return this.stored.get(key) ?? null
  }

  async delete(key: string): Promise<void> {
    this.stored.delete(key)
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) this.stored.delete(key)
  }
}
