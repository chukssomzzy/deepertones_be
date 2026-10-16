import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { assertPhotoKey, assertPhotoMedia, type PhotoEnvironment, type PhotoStore } from './photo-store.provider'

/** Keeps photos in a map and checks keys and media types exactly as R2PhotoStore does (same functions). For tests. */
export class MemoryPhotoStore implements PhotoStore {
  readonly stored = new Map<string, ProductImage>()

  readonly #environment: PhotoEnvironment

  constructor({ environment }: { environment: PhotoEnvironment }) {
    this.#environment = environment
  }

  async put(key: string, image: ProductImage): Promise<void> {
    this.#assertKey(key)
    assertPhotoMedia(key, image)
    this.stored.set(key, image)
  }

  async get(key: string): Promise<ProductImage | null> {
    this.#assertKey(key)
    return this.stored.get(key) ?? null
  }

  async delete(key: string): Promise<void> {
    this.#assertKey(key)
    this.stored.delete(key)
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) this.#assertKey(key)
    for (const key of keys) this.stored.delete(key)
  }

  #assertKey(key: string): void {
    assertPhotoKey(key, this.#environment)
  }
}
