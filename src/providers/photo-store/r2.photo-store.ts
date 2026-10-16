import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { assertPhotoKey, assertPhotoMedia, type PhotoEnvironment, type PhotoStore } from './photo-store.provider'

// R2 takes at most this many keys in one delete.
const R2_DELETE_LIMIT = 1000
// Never shared or cached: a deleted photo must be gone, and a signed link must not be replayable from a cache.
const CACHE_CONTROL = 'private, no-store'

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
  constructor(private readonly config: R2PhotoStoreConfig) {}

  async put(key: string, image: ProductImage): Promise<void> {
    this.assertKey(key)
    assertPhotoMedia(key, image)
    await this.config.bucket.put(key, image.bytes, { httpMetadata: { contentType: image.mediaType, cacheControl: CACHE_CONTROL } })
  }

  async get(key: string): Promise<ProductImage | null> {
    this.assertKey(key)
    const object = await this.config.bucket.get(key)
    if (!object) return null
    // The stored type decides, never the extension; anything but a JPEG or WebP is not a photo we wrote.
    const mediaType = object.httpMetadata?.contentType
    if (mediaType !== 'image/jpeg' && mediaType !== 'image/webp') return null
    return { bytes: new Uint8Array(await object.arrayBuffer()), mediaType }
  }

  async delete(key: string): Promise<void> {
    this.assertKey(key)
    await this.config.bucket.delete(key)
  }

  async deleteMany(keys: string[]): Promise<void> {
    // All keys first, so one bad key cannot leave a half-done delete.
    for (const key of keys) this.assertKey(key)
    for (let i = 0; i < keys.length; i += R2_DELETE_LIMIT) {
      await this.config.bucket.delete(keys.slice(i, i + R2_DELETE_LIMIT))
    }
  }

  private assertKey(key: string): void {
    assertPhotoKey(key, this.config.environment)
  }
}
