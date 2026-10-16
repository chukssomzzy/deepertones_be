import type { ProductImage } from '../product-analysis/product-analyst.provider'

/**
 * Where users' product photos are kept. The store is private: nothing here gives out an address, and callers
 * hand photos back to people only through signed photo links. A key that is not ours is a bug, so adapters
 * throw on one. `get` answers null for a key that is not there; `put` and `delete` throw on storage failure
 * so the caller can retry.
 */
export interface PhotoStore {
  /** Throws unless the image is a JPEG or WebP and its type matches the key's extension (jpg or webp). */
  put(key: string, image: ProductImage): Promise<void>
  get(key: string): Promise<ProductImage | null>
  /** Deleting a key that is not there is not an error. */
  delete(key: string): Promise<void>
  /** Deletes every key, or none if any key is invalid. Any number of keys. */
  deleteMany(keys: string[]): Promise<void>
}

export type PhotoEnvironment = 'development' | 'staging' | 'production' | 'test'

// One bucket serves every environment, told apart only by this prefix. A store may touch only its own environment's
// keys, so a misconfigured environment cannot read or delete another's photos.
const KEY_REST = /^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\.(jpg|webp)$/

/**
 * Throws a plain Error unless `key` is photos/<environment>/<user id>/<scan id>/<item id>.<jpg|webp>, for exactly this
 * environment. Ids are lowercase letters, digits and hyphens (UUIDs pass, and so does `<item id>-back`). Both adapters
 * call this, so the fake cannot accept what the real store refuses.
 */
export const assertPhotoKey = (key: string, environment: PhotoEnvironment): void => {
  const prefix = `photos/${environment}/`
  if (!key.startsWith(prefix) || !KEY_REST.test(key.slice(prefix.length))) {
    throw new Error(`Invalid photo key for environment ${environment}: ${JSON.stringify(key)}`)
  }
}

const MEDIA_TYPE_OF_EXTENSION = { jpg: 'image/jpeg', webp: 'image/webp' } as const

/** Throws a plain Error unless the image is a JPEG or WebP whose type matches the extension of the (already valid) key. */
export const assertPhotoMedia = (key: string, image: ProductImage): void => {
  const extension = key.endsWith('.webp') ? 'webp' : 'jpg'
  if (image.mediaType !== MEDIA_TYPE_OF_EXTENSION[extension]) {
    throw new Error(`Photo media type ${JSON.stringify(image.mediaType)} does not match the key ${JSON.stringify(key)}`)
  }
}
