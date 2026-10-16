import { describe, expect, it } from 'vitest'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { PhotoEnvironment, PhotoStore } from './photo-store.provider'

const JPEG: ProductImage = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mediaType: 'image/jpeg' }
const WEBP: ProductImage = { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 8, 7]), mediaType: 'image/webp' }

const ENV: PhotoEnvironment = 'test'
const keyAt = (i: number, extension: 'jpg' | 'webp' = 'jpg', environment: string = ENV) =>
  `photos/${environment}/user-1/scan-1/item-${i}.${extension}`

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

/**
 * What every PhotoStore must do about keys, media types and the round trip. `make(environment)` returns an empty store
 * locked to that environment. Runs against R2PhotoStore (on a minimal fake bucket) and MemoryPhotoStore, so the in-memory
 * one cannot accept what the real one refuses.
 */
export const photoStoreContract = (name: string, make: (environment: PhotoEnvironment) => PhotoStore) => {
  describe(`PhotoStore contract: ${name}`, () => {
    describe('round trip', () => {
      it.each([
        ['image/jpeg', JPEG, keyAt(1, 'jpg')],
        ['image/webp', WEBP, keyAt(2, 'webp')],
      ])('returns what was put as the same bytes and %s', async (_type, image, key) => {
        const store = make(ENV)
        await store.put(key, image)

        await expect(store.get(key)).resolves.toEqual(image)
      })

      it('returns null for a key that is not there', async () => {
        await expect(make(ENV).get(keyAt(1))).resolves.toBeNull()
      })

      it('replaces the photo when the same key is put again', async () => {
        const store = make(ENV)
        await store.put(keyAt(1), JPEG)
        const replacement = { bytes: new Uint8Array([7, 7]), mediaType: 'image/jpeg' as const }
        await store.put(keyAt(1), replacement)

        await expect(store.get(keyAt(1))).resolves.toEqual(replacement)
      })

      it('keeps photos apart by key', async () => {
        const store = make(ENV)
        await store.put(keyAt(1), JPEG)
        await store.put(keyAt(2, 'webp'), WEBP)

        await expect(store.get(keyAt(1))).resolves.toEqual(JPEG)
        await expect(store.get(keyAt(2, 'webp'))).resolves.toEqual(WEBP)
      })
    })

    describe('delete', () => {
      it('removes one photo and leaves the others', async () => {
        const store = make(ENV)
        await store.put(keyAt(1), JPEG)
        await store.put(keyAt(2), JPEG)

        await store.delete(keyAt(1))

        await expect(store.get(keyAt(1))).resolves.toBeNull()
        await expect(store.get(keyAt(2))).resolves.toEqual(JPEG)
      })

      it('is not an error for a key that is not there', async () => {
        await expect(make(ENV).delete(keyAt(1))).resolves.toBeUndefined()
      })
    })

    describe('deleteMany', () => {
      it('does nothing for no keys', async () => {
        const store = make(ENV)
        await store.put(keyAt(1), JPEG)

        await expect(store.deleteMany([])).resolves.toBeUndefined()

        await expect(store.get(keyAt(1))).resolves.toEqual(JPEG)
      })

      it('removes a single key', async () => {
        const store = make(ENV)
        await store.put(keyAt(1), JPEG)
        await store.put(keyAt(2), JPEG)

        await store.deleteMany([keyAt(1)])

        await expect(store.get(keyAt(1))).resolves.toBeNull()
        await expect(store.get(keyAt(2))).resolves.toEqual(JPEG)
      })

      it('removes many keys, ignores missing ones, and leaves the rest', async () => {
        const store = make(ENV)
        for (const i of [1, 2, 3, 4, 5]) await store.put(keyAt(i), JPEG)

        await store.deleteMany([keyAt(1), keyAt(2), keyAt(3), keyAt(99)])

        for (const i of [1, 2, 3]) await expect(store.get(keyAt(i))).resolves.toBeNull()
        for (const i of [4, 5]) await expect(store.get(keyAt(i))).resolves.toEqual(JPEG)
      })

      it('removes nothing when any key is invalid', async () => {
        const store = make(ENV)
        await store.put(keyAt(1), JPEG)

        const error = await caught(store.deleteMany([keyAt(1), 'photos/test/user-1/scan-1/../../other.jpg']))

        expect(error).toBeInstanceOf(Error)
        await expect(store.get(keyAt(1))).resolves.toEqual(JPEG)
      })
    })

    describe('keys', () => {
      it.each([
        'photos/test/user-1/scan-1/item-1.jpg',
        'photos/test/user-1/scan-1/item-1.webp',
        'photos/test/user-1/scan-1/item-1-back.jpg',
        'photos/test/user-1/scan-1/item-1-back.webp',
        'photos/test/0b9f3c1e-7a2d-4e5f-8c6b-1d2e3f4a5b6c/1c2d3e4f-0000-4a5b-8c6d-7e8f9a0b1c2d/9f8e7d6c-1111-4b2a-9c3d-4e5f6a7b8c9d.webp',
        'photos/test/u/s/i.jpg',
      ])('accepts the key %s in every method', async (key) => {
        const store = make(ENV)
        const image = key.endsWith('.webp') ? WEBP : JPEG

        await store.put(key, image)
        await expect(store.get(key)).resolves.toEqual(image)
        await store.delete(key)
        await store.deleteMany([key])
        await expect(store.get(key)).resolves.toBeNull()
      })

      it.each([
        ['empty', ''],
        ['no photos/ prefix', 'private/test/user-1/scan-1/item-1.jpg'],
        ['a leading slash', '/photos/test/user-1/scan-1/item-1.jpg'],
        ['an unknown environment', 'photos/prod/user-1/scan-1/item-1.jpg'],
        ['an uppercase environment', 'photos/Test/user-1/scan-1/item-1.jpg'],
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
      ])('rejects a key with %s in every method with a plain Error', async (_label, key) => {
        const store = make(ENV)

        const errors = [
          await caught(store.put(key, JPEG)),
          await caught(store.get(key)),
          await caught(store.delete(key)),
          await caught(store.deleteMany([keyAt(1), key])),
        ]

        for (const error of errors) {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).name).toBe('Error')
          expect((error as Error).message).toMatch(/key/i)
        }
      })
    })

    describe('environment lock', () => {
      const environments: PhotoEnvironment[] = ['development', 'staging', 'production', 'test']

      it.each(environments)('accepts keys of its own environment (%s)', async (environment) => {
        const store = make(environment)
        const key = keyAt(1, 'jpg', environment)

        await store.put(key, JPEG)

        await expect(store.get(key)).resolves.toEqual(JPEG)
      })

      it.each(environments.flatMap((own) => environments.filter((other) => other !== own).map((other) => [own, other] as const)))(
        'a %s store rejects a %s key in every method with a plain Error',
        async (own, other) => {
          const store = make(own)
          const key = keyAt(1, 'jpg', other)

          const errors = [
            await caught(store.put(key, JPEG)),
            await caught(store.get(key)),
            await caught(store.delete(key)),
            await caught(store.deleteMany([keyAt(1, 'jpg', own), key])),
          ]

          for (const error of errors) {
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).name).toBe('Error')
            expect((error as Error).message).toMatch(/key/i)
          }
        },
      )

      it('leaves a photo of another environment alone when a delete of it is refused', async () => {
        const store = make('staging')
        await store.put(keyAt(1, 'jpg', 'staging'), JPEG)

        await caught(store.deleteMany([keyAt(1, 'jpg', 'staging'), keyAt(1, 'jpg', 'production')]))

        await expect(store.get(keyAt(1, 'jpg', 'staging'))).resolves.toEqual(JPEG)
      })
    })

    describe('media rules', () => {
      it.each([
        ['image/jpeg', 'jpg'],
        ['image/webp', 'webp'],
      ] as const)('puts %s under a .%s key', async (mediaType, extension) => {
        const store = make(ENV)
        const image = { bytes: new Uint8Array([1, 2, 3]), mediaType }

        await expect(store.put(keyAt(1, extension), image)).resolves.toBeUndefined()
      })

      it.each([
        ['image/webp', 'jpg'],
        ['image/jpeg', 'webp'],
        ['image/png', 'jpg'],
        ['image/png', 'webp'],
        ['image/gif', 'jpg'],
        ['image/svg+xml', 'webp'],
        ['text/html', 'jpg'],
        ['application/octet-stream', 'webp'],
        ['IMAGE/JPEG', 'jpg'],
        ['image/jpg', 'jpg'],
        ['', 'jpg'],
      ] as const)('refuses %s under a .%s key with a plain Error, storing nothing', async (mediaType, extension) => {
        const store = make(ENV)
        const key = keyAt(1, extension)

        const error = await caught(store.put(key, { bytes: new Uint8Array([1]), mediaType } as unknown as ProductImage))

        expect(error).toBeInstanceOf(Error)
        expect((error as Error).name).toBe('Error')
        await expect(store.get(key)).resolves.toBeNull()
      })
    })
  })
}
