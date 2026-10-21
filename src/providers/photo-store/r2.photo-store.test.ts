import { describe, expect, it, vi } from 'vitest'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { photoStoreContract } from './photo-store.contract'
import type { PhotoEnvironment } from './photo-store.provider'
import { R2PhotoStore } from './r2.photo-store'

const KEY = 'photos/test/user-1/scan-1/item-1.jpg'
const WEBP_KEY = 'photos/test/user-1/scan-1/item-2.webp'
const R2_DELETE_LIMIT = 1000

const JPEG: ProductImage = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mediaType: 'image/jpeg' }
const WEBP: ProductImage = { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 8, 7]), mediaType: 'image/webp' }

const keyAt = (i: number) => `photos/test/user-1/scan-1/item-${i}.jpg`

/**
 * The smallest R2 bucket the store can use: put, get and delete over a map. Like the real one, delete takes a key or a list
 * of at most 1000 and a get answers null for a missing key. `seed` writes an object the way another writer could have.
 */
const fakeBucket = () => {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  const bytesOf = (value: unknown): Uint8Array => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    throw new Error('this fake only takes bytes')
  }
  const put = vi.fn(async (key: string, value: unknown, options?: R2PutOptions) => {
    objects.set(key, { bytes: bytesOf(value), contentType: (options?.httpMetadata as R2HTTPMetadata | undefined)?.contentType })
    return {} as R2Object
  })
  const get = vi.fn(async (key: string) => {
    const object = objects.get(key)
    if (!object) return null
    return {
      key,
      httpMetadata: { contentType: object.contentType },
      arrayBuffer: async () => object.bytes.slice().buffer,
      bytes: async () => object.bytes.slice(),
      body: new Blob([object.bytes]).stream(),
    }
  })
  const del = vi.fn(async (keys: string | string[]) => {
    const list = Array.isArray(keys) ? keys : [keys]
    if (list.length > R2_DELETE_LIMIT) throw new Error('R2 takes at most 1000 keys per delete')
    for (const key of list) objects.delete(key)
  })
  const seed = (key: string, bytes: Uint8Array, contentType?: string) => objects.set(key, { bytes, contentType })
  return { bucket: { put, get, delete: del } as unknown as R2Bucket, put, get, del, objects, seed }
}

const make = (fake = fakeBucket(), environment: PhotoEnvironment = 'test') => ({ store: new R2PhotoStore({ bucket: fake.bucket, environment }), fake })

photoStoreContract('R2PhotoStore', (environment) => make(fakeBucket(), environment).store)

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('R2PhotoStore.put', () => {
  it('stores the bytes under the key with the media type and a private, uncacheable cache-control', async () => {
    const { store, fake } = make()

    await store.put(WEBP_KEY, WEBP)

    expect(fake.put).toHaveBeenCalledTimes(1)
    const [key, value, options] = fake.put.mock.calls[0]!
    expect(key).toBe(WEBP_KEY)
    expect(Array.from(new Uint8Array(value as ArrayBuffer))).toEqual(Array.from(WEBP.bytes))
    expect(options?.httpMetadata).toEqual({ contentType: 'image/webp', cacheControl: 'private, no-store' })
  })

  it('lets a bucket failure through, so the caller can retry', async () => {
    const put = vi.fn(async () => {
      throw new Error('R2 unavailable')
    })
    const store = new R2PhotoStore({ bucket: { put } as unknown as R2Bucket, environment: 'test' })

    await expect(store.put(KEY, JPEG)).rejects.toThrow('R2 unavailable')
  })
})

describe('R2PhotoStore.get', () => {
  it.each([
    ['image/jpeg', JPEG, KEY],
    ['image/webp', WEBP, WEBP_KEY],
  ])('returns what was put as the same bytes and %s', async (_type, image, key) => {
    const { store } = make()
    await store.put(key, image)

    await expect(store.get(key)).resolves.toEqual(image)
  })

  it('returns null for a key that is not there', async () => {
    const { store } = make()

    await expect(store.get(KEY)).resolves.toBeNull()
  })

  it('uses the stored content type, not the file extension', async () => {
    const { store, fake } = make()
    fake.seed(KEY, WEBP.bytes, 'image/webp')

    await expect(store.get(KEY)).resolves.toEqual(WEBP)
  })

  it.each([
    ['image/png'],
    ['image/gif'],
    ['image/svg+xml'],
    ['text/html'],
    ['application/octet-stream'],
    [undefined],
  ])('returns null when the stored content type is %s', async (contentType) => {
    const { store, fake } = make()
    fake.seed(KEY, JPEG.bytes, contentType)

    await expect(store.get(KEY)).resolves.toBeNull()
  })
})

describe('R2PhotoStore face keys', () => {
  const PNG: ProductImage = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6, 7]), mediaType: 'image/png' }
  const FACE_KEY = 'faces/test/user-1/profile-1/scan-1/front.jpg'
  const MASK_KEY = 'faces/test/user-1/profile-1/scan-1/mask-hd-acne.png'

  it('stores a face photo as a JPEG with a private, uncacheable cache-control, like a product photo', async () => {
    const { store, fake } = make()

    await store.put(FACE_KEY, JPEG)

    expect(fake.put.mock.calls[0]?.[0]).toBe(FACE_KEY)
    expect(fake.put.mock.calls[0]?.[2]?.httpMetadata).toEqual({ contentType: 'image/jpeg', cacheControl: 'private, no-store' })
  })

  it('stores a mask as image/png with the same private, uncacheable cache-control', async () => {
    const { store, fake } = make()

    await store.put(MASK_KEY, PNG)

    expect(fake.put.mock.calls[0]?.[2]?.httpMetadata).toEqual({ contentType: 'image/png', cacheControl: 'private, no-store' })
  })

  it('reads a mask back as a PNG by the stored content type', async () => {
    const { store, fake } = make()
    fake.seed(MASK_KEY, PNG.bytes, 'image/png')

    await expect(store.get(MASK_KEY)).resolves.toEqual(PNG)
  })

  it('still returns null for a PNG stored under a product key, which is not a photo we wrote', async () => {
    const { store, fake } = make()
    fake.seed(KEY, PNG.bytes, 'image/png')

    await expect(store.get(KEY)).resolves.toBeNull()
  })

  it('returns null when a face photo key holds a content type that is not an image we write', async () => {
    const { store, fake } = make()
    fake.seed(FACE_KEY, JPEG.bytes, 'text/html')

    await expect(store.get(FACE_KEY)).resolves.toBeNull()
  })
})

describe('R2PhotoStore.delete', () => {
  it('removes the object, and deleting a key that is not there is not an error', async () => {
    const { store, fake } = make()
    await store.put(KEY, JPEG)

    await store.delete(KEY)
    await store.delete(KEY)

    await expect(store.get(KEY)).resolves.toBeNull()
    expect(fake.objects.size).toBe(0)
  })
})

describe('R2PhotoStore.deleteMany', () => {
  it('does not call the bucket for no keys', async () => {
    const { store, fake } = make()

    await expect(store.deleteMany([])).resolves.toBeUndefined()

    expect(fake.del).not.toHaveBeenCalled()
  })

  it('removes every key it is given and leaves the others', async () => {
    const { store, fake } = make()
    await store.put(keyAt(1), JPEG)
    await store.put(keyAt(2), JPEG)
    await store.put(keyAt(3), JPEG)

    await store.deleteMany([keyAt(1), keyAt(3)])

    expect([...fake.objects.keys()]).toEqual([keyAt(2)])
  })

  it('deletes exactly 1000 keys in one call', async () => {
    const { store, fake } = make()
    const keys = Array.from({ length: R2_DELETE_LIMIT }, (_, i) => keyAt(i))
    for (const key of keys) fake.seed(key, JPEG.bytes, 'image/jpeg')

    await store.deleteMany(keys)

    expect(fake.del).toHaveBeenCalledTimes(1)
    expect(fake.objects.size).toBe(0)
  })

  it('splits 1001 keys into a call of 1000 and a call of 1', async () => {
    const { store, fake } = make()
    const keys = Array.from({ length: R2_DELETE_LIMIT + 1 }, (_, i) => keyAt(i))
    for (const key of keys) fake.seed(key, JPEG.bytes, 'image/jpeg')

    await store.deleteMany(keys)

    expect(fake.del.mock.calls.map(([batch]) => (Array.isArray(batch) ? batch.length : 1))).toEqual([R2_DELETE_LIMIT, 1])
    expect(fake.objects.size).toBe(0)
  })

  it('deletes every key of 2500 exactly once, in batches of at most 1000', async () => {
    const { store, fake } = make()
    const keys = Array.from({ length: 2500 }, (_, i) => keyAt(i))

    await store.deleteMany(keys)

    const batches = fake.del.mock.calls.map(([batch]) => (Array.isArray(batch) ? batch : [batch]))
    expect(batches.map((batch) => batch.length)).toEqual([1000, 1000, 500])
    expect(batches.flat()).toEqual(keys)
  })

  it('checks every key before deleting any: one bad key among good ones deletes nothing', async () => {
    const { store, fake } = make()
    const keys = [...Array.from({ length: 1500 }, (_, i) => keyAt(i)), 'photos/test/user-1/scan-1/../../../other.jpg']
    for (const key of keys) fake.seed(key, JPEG.bytes, 'image/jpeg')

    await expect(store.deleteMany(keys)).rejects.toThrow(/key/i)

    expect(fake.del).not.toHaveBeenCalled()
    expect(fake.objects.size).toBe(keys.length)
  })

  it('lets a bucket failure through, so the caller can retry', async () => {
    const del = vi.fn(async () => {
      throw new Error('R2 unavailable')
    })
    const store = new R2PhotoStore({ bucket: { delete: del } as unknown as R2Bucket, environment: 'test' })

    await expect(store.deleteMany([KEY])).rejects.toThrow('R2 unavailable')
  })
})

describe('R2PhotoStore keys', () => {
  it.each([
    'photos/development/user-1/scan-1/item-1.jpg',
    'photos/staging/user-1/scan-1/item-1.webp',
    'photos/production/user-1/scan-1/item-1.jpg',
    'photos/test/user-1/scan-1/item-1.webp',
    'photos/production/0b9f3c1e-7a2d-4e5f-8c6b-1d2e3f4a5b6c/1c2d3e4f-0000-4a5b-8c6d-7e8f9a0b1c2d/9f8e7d6c-1111-4b2a-9c3d-4e5f6a7b8c9d.webp',
    'photos/test/u/s/i.jpg',
    'photos/test/user-1/scan-1/item-1-back.jpg',
    'photos/test/user-1/scan-1/item-1-back.webp',
  ])('accepts the key %s in every method', async (key) => {
    const { store, fake } = make(fakeBucket(), key.split('/')[1] as PhotoEnvironment)

    await store.put(key, key.endsWith('.webp') ? WEBP : JPEG)
    await expect(store.get(key)).resolves.not.toBeNull()
    await store.delete(key)
    await store.deleteMany([key])

    expect(fake.put).toHaveBeenCalledTimes(1)
    expect(fake.get).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['empty', ''],
    ['no photos/ prefix', 'private/test/user-1/scan-1/item-1.jpg'],
    ['a leading slash', '/photos/test/user-1/scan-1/item-1.jpg'],
    ['an unknown environment', 'photos/prod/user-1/scan-1/item-1.jpg'],
    ['another environment than the store\'s', 'photos/production/user-1/scan-1/item-1.jpg'],
    ['the environment as a prefix of a longer name', 'photos/test2/user-1/scan-1/item-1.jpg'],
    ['an uppercase environment', 'photos/Production/user-1/scan-1/item-1.jpg'],
    ['no environment', 'photos/user-1/scan-1/item-1.jpg'],
    ['a missing item segment', 'photos/test/user-1/item-1.jpg'],
    ['an extra segment', 'photos/test/user-1/scan-1/extra/item-1.jpg'],
    ['an uppercase user id', 'photos/test/User-1/scan-1/item-1.jpg'],
    ['an underscore in an id', 'photos/test/user_1/scan-1/item-1.jpg'],
    ['a dot in an id', 'photos/test/user.1/scan-1/item-1.jpg'],
    ['an empty id', 'photos/test//scan-1/item-1.jpg'],
    ['a dot-dot segment', 'photos/test/user-1/../item-1.jpg'],
    ['a png extension', 'photos/test/user-1/scan-1/item-1.png'],
    ['a jpeg extension', 'photos/test/user-1/scan-1/item-1.jpeg'],
    ['an uppercase extension', 'photos/test/user-1/scan-1/item-1.JPG'],
    ['no extension', 'photos/test/user-1/scan-1/item-1'],
    ['a double extension', 'photos/test/user-1/scan-1/item-1.jpg.png'],
    ['a trailing slash', 'photos/test/user-1/scan-1/item-1.jpg/'],
    ['a trailing newline', 'photos/test/user-1/scan-1/item-1.jpg\n'],
    ['a space', 'photos/test/user-1/scan-1/item 1.jpg'],
    ['a query string', 'photos/test/user-1/scan-1/item-1.jpg?x=1'],
    ['a percent escape', 'photos/test/user-1/scan-1/%2e%2e.jpg'],
    ['a backslash', 'photos\\test\\user-1\\scan-1\\item-1.jpg'],
  ])('rejects a key with %s in every method with a plain Error, touching nothing', async (_label, key) => {
    const { store, fake } = make()

    const errors = [
      await caught(store.put(key, JPEG)),
      await caught(store.get(key)),
      await caught(store.delete(key)),
      await caught(store.deleteMany([KEY, key])),
    ]

    for (const error of errors) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).name).toBe('Error')
      expect((error as Error).message).toMatch(/key/i)
    }
    expect(fake.put).not.toHaveBeenCalled()
    expect(fake.get).not.toHaveBeenCalled()
    expect(fake.del).not.toHaveBeenCalled()
  })
})

describe('R2PhotoStore media rules', () => {
  it.each([
    ['a webp under a .jpg key', KEY, WEBP],
    ['a jpeg under a .webp key', WEBP_KEY, JPEG],
    ['a png', KEY, { bytes: new Uint8Array([1]), mediaType: 'image/png' } as unknown as ProductImage],
  ])('refuses to put %s and leaves the bucket untouched', async (_label, key, image) => {
    const { store, fake } = make()

    await expect(store.put(key, image)).rejects.toThrow(/media type/i)

    expect(fake.put).not.toHaveBeenCalled()
  })
})
