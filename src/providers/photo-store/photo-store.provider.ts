import type { ProductImage } from '../product-analysis/product-analyst.provider'

/**
 * Where users' private photos are kept: product photos (photos/...) and face photos with their overlay masks (faces/...). The store is private: nothing here gives out an address, and callers
 * hand photos back to people only through signed photo links. A key that is not ours is a bug, so adapters
 * throw on one. `get` answers null for a key that is not there; `put` and `delete` throw on storage failure
 * so the caller can retry.
 */
export interface PhotoStore {
  /** Throws unless the image's type matches the key's extension (jpg, webp or, for a face mask only, png). */
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
const ID = '[a-z0-9-]+'
const PRODUCT_REST = new RegExp(`^${ID}/${ID}/${ID}\\.(jpg|webp)$`)
// faces/<environment>/<user id>/<profile id>/<scan id>/<name>: the profile is in the key so a photo link can be checked against it. A face
// photo is a JPEG; the one PNG the bucket holds is an overlay mask, named mask-<concern>.
const FACE_REST = new RegExp(`^${ID}/${ID}/${ID}/(${ID}\\.jpg|mask-${ID}\\.png)$`)

/**
 * Throws a plain Error unless `key` is photos/<environment>/<user id>/<scan id>/<item id>.<jpg|webp> or
 * faces/<environment>/<user id>/<profile id>/<scan id>/<name>.jpg (a mask: mask-<name>.png), for exactly this environment.
 * Ids are lowercase letters, digits and hyphens (UUIDs pass, and so does `<item id>-back`). Both adapters
 * call this, so the fake cannot accept what the real store refuses.
 */
export const assertPhotoKey = (key: string, environment: PhotoEnvironment): void => {
  const product = `photos/${environment}/`
  const face = `faces/${environment}/`
  const valid = key.startsWith(product) ? PRODUCT_REST.test(key.slice(product.length)) : key.startsWith(face) && FACE_REST.test(key.slice(face.length))
  if (!valid) throw new Error(`Invalid photo key for environment ${environment}: ${JSON.stringify(key)}`)
}

/** Whether the (already valid) key is a face photo or mask, which may hold a PNG. */
export const isFaceKey = (key: string): boolean => key.startsWith('faces/')

const MEDIA_TYPE_OF_EXTENSION = { jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png' } as const

/** Throws a plain Error unless the image's type matches the extension of the (already valid) key. */
export const assertPhotoMedia = (key: string, image: ProductImage): void => {
  const extension = key.endsWith('.webp') ? 'webp' : key.endsWith('.png') ? 'png' : 'jpg'
  if (image.mediaType !== MEDIA_TYPE_OF_EXTENSION[extension]) {
    throw new Error(`Photo media type ${JSON.stringify(image.mediaType)} does not match the key ${JSON.stringify(key)}`)
  }
}
