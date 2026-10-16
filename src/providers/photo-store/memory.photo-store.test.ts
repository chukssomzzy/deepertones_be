import { describe, expect, it } from 'vitest'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { MemoryPhotoStore } from './memory.photo-store'

const KEY_A = 'photos/test/user-1/scan-1/item-1.jpg'
const KEY_B = 'photos/test/user-1/scan-1/item-2.webp'
const KEY_C = 'photos/test/user-1/scan-1/item-3.webp'
const JPEG: ProductImage = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg' }
const WEBP: ProductImage = { bytes: new Uint8Array([4, 5]), mediaType: 'image/webp' }

describe('MemoryPhotoStore', () => {
  it('returns what was put under a key, and null for a key it does not hold', async () => {
    const store = new MemoryPhotoStore()

    await store.put(KEY_A, JPEG)

    await expect(store.get(KEY_A)).resolves.toEqual(JPEG)
    await expect(store.get(KEY_B)).resolves.toBeNull()
  })

  it('delete removes one key, and deleting a missing key is not an error', async () => {
    const store = new MemoryPhotoStore()
    await store.put(KEY_A, JPEG)
    await store.put(KEY_B, WEBP)

    await store.delete(KEY_A)
    await store.delete(KEY_C)

    await expect(store.get(KEY_A)).resolves.toBeNull()
    await expect(store.get(KEY_B)).resolves.toEqual(WEBP)
  })

  it('deleteMany removes every key it is given, ignores missing ones, and leaves the rest', async () => {
    const store = new MemoryPhotoStore()
    await store.put(KEY_A, JPEG)
    await store.put(KEY_B, WEBP)
    await store.put(KEY_C, WEBP)

    await store.deleteMany([KEY_A, KEY_B, 'photos/test/user-9/scan-9/item-9.jpg'])
    await store.deleteMany([])

    await expect(store.get(KEY_A)).resolves.toBeNull()
    await expect(store.get(KEY_B)).resolves.toBeNull()
    await expect(store.get(KEY_C)).resolves.toEqual(WEBP)
  })
})
