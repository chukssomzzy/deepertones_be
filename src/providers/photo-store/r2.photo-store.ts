import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { assertPhotoKey, assertPhotoMedia, type PhotoEnvironment, type PhotoStore } from './photo-store.provider'

export type R2PhotoStoreConfig = {
  /** The private bucket, deepertones-private. */
  bucket: R2Bucket
  /** The only environment whose keys (photos/<environment>/...) this store will touch. */
  environment: PhotoEnvironment
}

/**
 * Keeps users' product photos in R2.
 *
 * This bucket has no public domain and r2.dev is off: photos are served only through signed photo links
 * (src/lib/photo-link.ts), which the Worker checks before reading here. Keep it that way; a public address
 * would expose every user's photos.
 */
export class R2PhotoStore implements PhotoStore {
  // R2 takes at most this many keys in one delete.
  static readonly #DELETE_LIMIT = 1000
  // Never shared or cached: a deleted photo must be gone, and a signed link must not be replayable from a cache.
  static readonly #CACHE_CONTROL = 'private, no-store'

  readonly #bucket: R2Bucket
  readonly #environment: PhotoEnvironment

  constructor({ bucket, environment }: R2PhotoStoreConfig) {
    this.#bucket = bucket
    this.#environment = environment
  }

  async put(key: string, image: ProductImage): Promise<void> {
    this.#assertKey(key)
    assertPhotoMedia(key, image)
    await this.#bucket.put(key, image.bytes, { httpMetadata: { contentType: image.mediaType, cacheControl: R2PhotoStore.#CACHE_CONTROL } })
  }

  async get(key: string): Promise<ProductImage | null> {
    this.#assertKey(key)
    const object = await this.#bucket.get(key)
    if (!object) return null
    // The stored type decides, never the extension; anything but a JPEG or WebP is not a photo we wrote.
    const mediaType = object.httpMetadata?.contentType
    if (mediaType !== 'image/jpeg' && mediaType !== 'image/webp') return null
    return { bytes: new Uint8Array(await object.arrayBuffer()), mediaType }
  }

  async delete(key: string): Promise<void> {
    this.#assertKey(key)
    await this.#bucket.delete(key)
  }

  async deleteMany(keys: string[]): Promise<void> {
    // All keys first, so one bad key cannot leave a half-done delete.
    for (const key of keys) this.#assertKey(key)
    for (let i = 0; i < keys.length; i += R2PhotoStore.#DELETE_LIMIT) {
      await this.#bucket.delete(keys.slice(i, i + R2PhotoStore.#DELETE_LIMIT))
    }
  }

  #assertKey(key: string): void {
    assertPhotoKey(key, this.#environment)
  }
}
