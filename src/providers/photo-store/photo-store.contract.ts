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

    // Face photos live beside product photos in the one private bucket, under their own prefix: faces/<environment>/<user id>/<profile id>/<scan id>/<name>.
    // The profile is in the key so that a photo link can be checked against the profile (the account's other profiles must not open it). A face photo is a
    // JPEG. The only PNG the store holds is an overlay mask, whose name starts with `mask-`, under the same layout; a product photo is never a PNG.
    describe('face keys', () => {
      const faceKey = (name: string, environment: string = ENV) => `faces/${environment}/user-1/profile-1/scan-1/${name}`

      it.each([['front'], ['right'], ['left']])('accepts the %s photo of a face scan as a JPEG in every method, and gives it back', async (position) => {
        const store = make(ENV)
        const key = faceKey(`${position}.jpg`)

        await store.put(key, JPEG)
        await expect(store.get(key)).resolves.toEqual(JPEG)
        await store.delete(key)
        await store.deleteMany([key])
        await expect(store.get(key)).resolves.toBeNull()
      })

      it('accepts UUID ids in every segment', async () => {
        const store = make(ENV)
        const key = `faces/${ENV}/0b9f3c1e-7a2d-4e5f-8c6b-1d2e3f4a5b6c/1c2d3e4f-0000-4a5b-8c6d-7e8f9a0b1c2d/9f8e7d6c-1111-4b2a-9c3d-4e5f6a7b8c9d/front.jpg`

        await store.put(key, JPEG)

        await expect(store.get(key)).resolves.toEqual(JPEG)
      })

      it('keeps the photos of two profiles of one account apart', async () => {
        const store = make(ENV)
        const mine = 'faces/test/user-1/profile-1/scan-1/front.jpg'
        const theirs = 'faces/test/user-1/profile-2/scan-1/front.jpg'
        const other = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 9]), mediaType: 'image/jpeg' as const }
        await store.put(mine, JPEG)
        await store.put(theirs, other)

        await expect(store.get(mine)).resolves.toEqual(JPEG)
        await expect(store.get(theirs)).resolves.toEqual(other)
      })

      it.each([
        ['a webp extension (a face photo is a JPEG)', 'faces/test/user-1/profile-1/scan-1/front.webp'],
        ['a png extension on a name that is not a mask', 'faces/test/user-1/profile-1/scan-1/front.png'],
        ['no profile segment', 'faces/test/user-1/scan-1/front.jpg'],
        ['an extra segment', 'faces/test/user-1/profile-1/scan-1/extra/front.jpg'],
        ['an unknown environment', 'faces/prod/user-1/profile-1/scan-1/front.jpg'],
        ['an uppercase environment', 'faces/Test/user-1/profile-1/scan-1/front.jpg'],
        ['no environment', 'faces/user-1/profile-1/scan-1/front.jpg'],
        ['an uppercase profile id', 'faces/test/user-1/Profile-1/scan-1/front.jpg'],
        ['an underscore in an id', 'faces/test/user-1/profile_1/scan-1/front.jpg'],
        ['an empty profile id', 'faces/test/user-1//scan-1/front.jpg'],
        ['a dot-dot segment', 'faces/test/user-1/profile-1/../front.jpg'],
        ['a leading slash', '/faces/test/user-1/profile-1/scan-1/front.jpg'],
        ['a jpeg extension spelled out', 'faces/test/user-1/profile-1/scan-1/front.jpeg'],
        ['no extension', 'faces/test/user-1/profile-1/scan-1/front'],
        ['a trailing newline', 'faces/test/user-1/profile-1/scan-1/front.jpg\n'],
      ])('rejects a key with %s in every method with a plain Error', async (_label, key) => {
        const store = make(ENV)

        const errors = [
          await caught(store.put(key, JPEG)),
          await caught(store.get(key)),
          await caught(store.delete(key)),
          await caught(store.deleteMany([faceKey('front.jpg'), key])),
        ]

        for (const error of errors) {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).name).toBe('Error')
          expect((error as Error).message).toMatch(/key/i)
        }
      })

      it('removes nothing when one key of a delete is invalid, even if the others are face keys', async () => {
        const store = make(ENV)
        await store.put(faceKey('front.jpg'), JPEG)

        await caught(store.deleteMany([faceKey('front.jpg'), faceKey('front.webp')]))

        await expect(store.get(faceKey('front.jpg'))).resolves.toEqual(JPEG)
      })

      it.each([
        ['development', 'staging'],
        ['staging', 'production'],
        ['production', 'test'],
        ['test', 'development'],
      ] as const)('a %s store rejects a %s face key in every method', async (own, other) => {
        const store = make(own)
        const key = faceKey('front.jpg', other)

        const errors = [await caught(store.put(key, JPEG)), await caught(store.get(key)), await caught(store.delete(key)), await caught(store.deleteMany([key]))]

        for (const error of errors) {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toMatch(/key/i)
        }
      })
    })

    describe('face media rules', () => {
      const faceKey = (name: string) => `faces/${ENV}/user-1/profile-1/scan-1/${name}`
      const PNG: ProductImage = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6, 7]), mediaType: 'image/png' }

      it('puts a JPEG under a face photo key', async () => {
        await expect(make(ENV).put(faceKey('front.jpg'), JPEG)).resolves.toBeUndefined()
      })

      it.each([
        ['image/webp', 'front.jpg'],
        ['image/png', 'front.jpg'],
        ['image/gif', 'front.jpg'],
        ['', 'front.jpg'],
        ['image/jpeg', 'mask-hd-acne.png'],
        ['image/webp', 'mask-hd-acne.png'],
      ] as const)('refuses %s under the key %s with a plain Error, storing nothing', async (mediaType, name) => {
        const store = make(ENV)

        const error = await caught(store.put(faceKey(name), { bytes: new Uint8Array([1]), mediaType } as unknown as ProductImage))

        expect(error).toBeInstanceOf(Error)
        expect((error as Error).name).toBe('Error')
        await expect(store.get(faceKey(name))).resolves.toBeNull()
      })

      it('puts a PNG under a mask key of the face layout, gives it back as a PNG, and deletes it', async () => {
        const store = make(ENV)
        const key = faceKey('mask-hd-acne.png')

        await store.put(key, PNG)

        await expect(store.get(key)).resolves.toEqual(PNG)
        await store.delete(key)
        await expect(store.get(key)).resolves.toBeNull()
      })

      it('deletes a photo and its masks together in one deleteMany', async () => {
        const store = make(ENV)
        await store.put(faceKey('front.jpg'), JPEG)
        await store.put(faceKey('mask-hd-acne.png'), PNG)
        await store.put(faceKey('mask-hd-radiance.png'), PNG)

        await store.deleteMany([faceKey('front.jpg'), faceKey('mask-hd-acne.png'), faceKey('mask-hd-radiance.png')])

        for (const name of ['front.jpg', 'mask-hd-acne.png', 'mask-hd-radiance.png']) await expect(store.get(faceKey(name))).resolves.toBeNull()
      })

      // The product layout is unchanged: JPEG and WebP only. A PNG is a mask, and a mask is only ever under faces/.
      it.each([
        ['a .jpg product key', 'photos/test/user-1/scan-1/item-1.jpg'],
        ['a .webp product key', 'photos/test/user-1/scan-1/item-1.webp'],
        ['a .png product key', 'photos/test/user-1/scan-1/item-1.png'],
        ['a product key named like a mask', 'photos/test/user-1/scan-1/mask-hd-acne.png'],
      ])('still refuses a PNG under %s', async (_label, key) => {
        const store = make(ENV)

        const error = await caught(store.put(key, PNG))

        expect(error).toBeInstanceOf(Error)
        expect((error as Error).name).toBe('Error')
      })

      it('still accepts a JPEG and a WebP under product keys', async () => {
        const store = make(ENV)

        await store.put('photos/test/user-1/scan-1/item-1.jpg', JPEG)
        await store.put('photos/test/user-1/scan-1/item-2.webp', WEBP)

        await expect(store.get('photos/test/user-1/scan-1/item-1.jpg')).resolves.toEqual(JPEG)
        await expect(store.get('photos/test/user-1/scan-1/item-2.webp')).resolves.toEqual(WEBP)
      })
    })
  })
}
