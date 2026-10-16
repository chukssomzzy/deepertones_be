import type { ProductImage } from '../product-analysis/product-analyst.provider'

/**
 * Where users' product photos are kept. The store is private: nothing here gives out an address, and callers
 * hand photos back to people only through signed photo links. A key that is not ours is a bug, so adapters
 * throw on one. `get` answers null for a key that is not there; `put` and `delete` throw on storage failure
 * so the caller can retry.
 */
export interface PhotoStore {
  put(key: string, image: ProductImage): Promise<void>
  get(key: string): Promise<ProductImage | null>
  /** Deleting a key that is not there is not an error. */
  delete(key: string): Promise<void>
  /** Deletes every key, or none if any key is invalid. Any number of keys. */
  deleteMany(keys: string[]): Promise<void>
}
