import { describe, expect, it } from 'vitest'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { MemoryCatalogImageStore } from './memory.catalog-image-store'

const PHOTO: ProductImage = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/webp' }
const URL_ = 'https://brand.example/serum.webp'

describe('MemoryCatalogImageStore', () => {
  it('fetchImage answers null for a url nobody responded to, and records the attempt', async () => {
    const store = new MemoryCatalogImageStore()

    await expect(store.fetchImage(URL_)).resolves.toBeNull()
    expect(store.fetched).toEqual([URL_])
  })

  it('fetchImage answers what respondTo set for that url only', async () => {
    const store = new MemoryCatalogImageStore()
    store.respondTo(URL_, PHOTO)

    await expect(store.fetchImage(URL_)).resolves.toBe(PHOTO)
    await expect(store.fetchImage('https://brand.example/other.webp')).resolves.toBeNull()
  })

  it('respondTo with null makes a url answer null again', async () => {
    const store = new MemoryCatalogImageStore()
    store.respondTo(URL_, PHOTO)
    store.respondTo(URL_, null)

    await expect(store.fetchImage(URL_)).resolves.toBeNull()
  })

  it('records every fetched url in order', async () => {
    const store = new MemoryCatalogImageStore()

    await store.fetchImage('https://a.example/1.png')
    await store.fetchImage('https://b.example/2.png')
    await store.fetchImage('https://a.example/1.png')

    expect(store.fetched).toEqual(['https://a.example/1.png', 'https://b.example/2.png', 'https://a.example/1.png'])
  })

  it('put stores the image under its key and delete removes it', async () => {
    const store = new MemoryCatalogImageStore()

    await store.put('products/p1.webp', PHOTO)
    expect(store.stored.get('products/p1.webp')).toBe(PHOTO)

    await store.delete('products/p1.webp')
    expect(store.stored.has('products/p1.webp')).toBe(false)
  })

  it('delete of a key that was never stored does not throw', async () => {
    await expect(new MemoryCatalogImageStore().delete('products/none.webp')).resolves.toBeUndefined()
  })

  it('publicUrl is https://images.test/<key>', () => {
    expect(new MemoryCatalogImageStore().publicUrl('products/p1.webp')).toBe('https://images.test/products/p1.webp')
  })
})
