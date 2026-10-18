import { describe, expect, it } from 'vitest'
import type { ShelfEntryRow } from '../shelf/shelf.types'
import type { ScansRepository } from './scans.repository'
import type { ItemPatch, ItemState, NewBackPhoto, NewRetake, NewScan, NewScanItem, NewScanPhoto, NewSibling, PhotoPatch } from './scans.types'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

// Each call yields a value no other test (or earlier run against a shared D1) uses.
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
const fresh = (label: string) => `${label}-${runSalt}-${counter++}`
const freshId = () => crypto.randomUUID()

/**
 * What a contract run needs: the repository, and a way to get a user id that exists (D1 enforces scans.user_id -> users.id).
 * For adoptOrphanScans, which reads the owner's default profile: a user the way the old Worker left one, with no profile,
 * and a way to give any user a default profile afterwards.
 * For the shelf: a way to read every shelf row of a profile (removed ones too), and an arrange-only stand-in for removing one
 * (the shelf module's own remove comes later), so the tests can prove a later move restores it.
 */
export type ScansContractSetup = {
  repository: ScansRepository
  newUser: () => Promise<string>
  newUserWithoutProfile: () => Promise<string>
  giveDefaultProfile: (userId: string) => Promise<string>
  shelfOf: (profileId: string) => Promise<ShelfEntryRow[]>
  removeFromShelf: (entryId: string, reason: NonNullable<ShelfEntryRow['removedReason']>, at: Date) => Promise<void>
}

// scans.profile_id has no foreign key (profiles die with their user, and the user's scans with it), so any id will do.
const newScan = (userId: string, over: Partial<NewScan> = {}): NewScan => ({ id: freshId(), userId, profileId: freshId(), kind: 'product', ipHash: fresh('iphash'), createdAt: BASE, ...over })

const newUpload = (itemId: string, userId: string, uploadedAt: Date, over: Partial<NewBackPhoto> = {}): NewBackPhoto => ({
  id: freshId(),
  itemId,
  userId,
  ipHash: fresh('upload-ip'),
  uploadedAt,
  ...over,
})

const newRetake = (itemId: string, userId: string, uploadedAt: Date, over: Partial<NewRetake> = {}): NewRetake => ({
  id: freshId(),
  itemId,
  userId,
  ipHash: fresh('retake-ip'),
  uploadedAt,
  ...over,
})

const newItem = (scan: NewScan, position: number, over: Partial<NewScanItem> = {}): NewScanItem => ({
  id: freshId(),
  scanId: scan.id,
  userId: scan.userId,
  position,
  photoId: freshId(),
  photoKey: `photos/test/${scan.userId}/${scan.id}/${position}.jpg`,
  createdAt: scan.createdAt,
  ...over,
})

/** A product read on a shelf photo, as a new item: it has no image of its own, and it starts where the read puts it. */
const newSibling = (scan: NewScan, photo: NewScanPhoto, position: number, over: Partial<NewSibling> = {}): NewSibling => ({
  ...newItem(scan, position, { photoId: photo.id, photoKey: null, createdAt: at(MINUTE) }),
  state: 'matching',
  recognisedBrand: 'Glow Co',
  recognisedName: `Serum ${position}`,
  recognisedVariant: null,
  recognisedForm: null,
  recognisedCategory: 'skin',
  recognisedConfidence: 0.9,
  ...over,
})

/** What reading a shelf photo writes on the photo: its state, the whole answer, and the counts of what was left out. */
const readPhoto = (over: Partial<PhotoPatch> = {}): PhotoPatch => ({
  state: 'recognised',
  recognition: JSON.stringify({ classification: 'beauty-product', products: [], excluded: { otherProducts: 1, unreadable: 2 } }),
  skippedNotBeauty: 1,
  skippedUnreadable: 2,
  skippedOverLimit: 3,
  skippedDailyLimit: 4,
  updatedAt: at(MINUTE),
  ...over,
})

/** A photo row for a scan; a product photo holds no image of its own (its item does), so photoKey is null unless a test says it is a shelf photo. */
const newPhoto = (scan: NewScan, position: number, over: Partial<NewScanPhoto> = {}): NewScanPhoto => ({
  id: freshId(),
  scanId: scan.id,
  userId: scan.userId,
  position,
  photoKey: null,
  createdAt: scan.createdAt,
  ...over,
})

/** Creates a scan the way the product route does: one photo per item, at the item's position, with the item pointing at it. */
const createWithPhotos = (repository: ScansRepository, scan: NewScan, items: NewScanItem[]) =>
  repository.createScan(
    scan,
    items.map((item) => newPhoto(scan, item.position, { id: item.photoId! })),
    items,
  )

/** The row the old Worker wrote while migrations 0011 and 0012 had run and the new Worker had not gone live: no profile. */
const orphan = (userId: string, over: Partial<NewScan> = {}): NewScan => newScan(userId, { profileId: null as unknown as string, ...over })

/**
 * Behaviour every ScansRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier).
 * Assumptions the D1 table must meet: scans.user_id references users (so `newUser` makes real users), scans.profile_id is plain text with no foreign key, scan_items.scan_id
 * references scans, and product_id / formulation_id are plain text with no foreign key (the catalog is not this module's).
 */
export const scansRepositoryContract = (name: string, make: () => ScansContractSetup | Promise<ScansContractSetup>) => {
  describe(`ScansRepository contract: ${name}`, () => {
    const seeded = async (itemCount = 2, scanOver: Partial<NewScan> = {}) => {
      const { repository, newUser } = await make()
      const userId = await newUser()
      const scan = newScan(userId, scanOver)
      const items = Array.from({ length: itemCount }, (_, i) => newItem(scan, i))
      await createWithPhotos(repository, scan, items)
      return { repository, newUser, userId, scan, items }
    }

    describe('createScan and reading back', () => {
      it('stores the scan with its owner, IP hash and time', async () => {
        const { repository, scan } = await seeded()

        const stored = await repository.findScan(scan.id)

        expect(stored).toMatchObject({ id: scan.id, userId: scan.userId, ipHash: scan.ipHash, doneAt: null })
        expect(stored!.createdAt.getTime()).toBe(BASE.getTime())
      })

      it('stores the profile the scan was made by, and gives it back', async () => {
        const profileId = freshId()
        const { repository, scan } = await seeded(1, { profileId })

        expect((await repository.findScan(scan.id))!.profileId).toBe(profileId)
      })

      it('keeps the profile of each scan apart: two scans of one user, made by two profiles', async () => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const [a, b] = [newScan(userId, { profileId: freshId() }), newScan(userId, { profileId: freshId() })]
        await createWithPhotos(repository, a, [newItem(a, 0)])
        await createWithPhotos(repository, b, [newItem(b, 0)])

        expect((await repository.findScan(a.id))!.profileId).toBe(a.profileId)
        expect((await repository.findScan(b.id))!.profileId).toBe(b.profileId)
        expect(a.profileId).not.toBe(b.profileId)
      })

      it('stores every item recognising, with no reason, recognised fields, product or back photo, and updatedAt equal to createdAt', async () => {
        const { repository, scan, items } = await seeded(1, { createdAt: at(3 * MINUTE) })

        const item = await repository.findItem(items[0]!.id)

        expect(item).toMatchObject({
          id: items[0]!.id,
          scanId: scan.id,
          userId: scan.userId,
          position: 0,
          photoId: items[0]!.photoId,
          state: 'recognising',
          reason: null,
          photoKey: items[0]!.photoKey,
          backPhotoKey: null,
          recognisedBrand: null,
          recognisedName: null,
          recognisedVariant: null,
          recognisedForm: null,
          recognisedCategory: null,
          recognisedConfidence: null,
          productId: null,
          formulationId: null,
          noLabelSource: null,
          noLabelPurpose: null,
          noLabelUsedFor: null,
          noLabelDescription: null,
        })
        expect(item!.createdAt.getTime()).toBe(at(3 * MINUTE).getTime())
        expect(item!.updatedAt.getTime()).toBe(at(3 * MINUTE).getTime())
      })

      it('counts an item toward the daily quotas unless it was created uncounted', async () => {
        const { repository, items } = await seeded(1)

        expect((await repository.findItem(items[0]!.id))!.counted).toBe(true)
      })

      it.each([true, false])('stores a typed scan with no photos and one item waiting for identification with no photo, counted %s', async (counted) => {
        const { repository, newUser } = await make()
        const scan = newScan(await newUser(), { kind: 'typed' })
        const item = newItem(scan, 0, { photoId: null, photoKey: null, state: 'needs-identification', counted })

        await repository.createScan(scan, [], [item])

        expect((await repository.findScan(scan.id))!.kind).toBe('typed')
        expect(await repository.photosOf(scan.id)).toEqual([])
        const stored = await repository.itemsOf(scan.id)
        expect(stored).toHaveLength(1)
        expect(stored[0]).toMatchObject({ id: item.id, position: 0, state: 'needs-identification', reason: null, photoId: null, photoKey: null, counted })
        expect(await repository.findItem(item.id)).toMatchObject({ state: 'needs-identification', photoId: null, counted })
      })

      it('itemsOf returns the scan\'s items in position order, whatever order they were given in', async () => {
        const { repository, newUser } = await make()
        const scan = newScan(await newUser())
        const [first, second, third] = [newItem(scan, 0), newItem(scan, 1), newItem(scan, 2)]
        await createWithPhotos(repository, scan, [third!, first!, second!])

        const items = await repository.itemsOf(scan.id)

        expect(items.map((i) => i.id)).toEqual([first!.id, second!.id, third!.id])
        expect(items.map((i) => i.position)).toEqual([0, 1, 2])
      })

      it('itemsOf holds only that scan\'s items', async () => {
        const { repository, userId, scan, items } = await seeded(2)
        const other = newScan(userId)
        await createWithPhotos(repository, other, [newItem(other, 0)])

        expect((await repository.itemsOf(scan.id)).map((i) => i.id)).toEqual(items.map((i) => i.id))
        expect(await repository.itemsOf(freshId())).toEqual([])
      })

      it('finds nothing for an unknown scan or item', async () => {
        const { repository } = await make()

        expect(await repository.findScan(freshId())).toBeNull()
        expect(await repository.findItem(freshId())).toBeNull()
      })

      it('stores nothing at all when one of the items cannot be stored: the scan and the good items are not left behind', async () => {
        const { repository, newUser } = await make()
        const scan = newScan(await newUser())
        const good = newItem(scan, 0)
        const clash = newItem(scan, 1, { id: good.id })

        await expect(createWithPhotos(repository, scan, [good, clash])).rejects.toThrow()

        expect(await repository.findScan(scan.id)).toBeNull()
        expect(await repository.findItem(good.id)).toBeNull()
      })
    })

    describe('scan photos and kind', () => {
      it('stores each photo with its scan, owner, position, and a recognising state, no recognition and zero skipped counts, updatedAt equal to createdAt', async () => {
        const { repository, newUser } = await make()
        const scan = newScan(await newUser(), { createdAt: at(3 * MINUTE) })
        const photo = newPhoto(scan, 0)
        await repository.createScan(scan, [photo], [])

        expect(await repository.findPhoto(photo.id)).toMatchObject({
          id: photo.id,
          scanId: scan.id,
          userId: scan.userId,
          position: 0,
          state: 'recognising',
          photoKey: null,
          recognition: null,
          skippedNotBeauty: 0,
          skippedUnreadable: 0,
          skippedOverLimit: 0,
          skippedDailyLimit: 0,
          createdAt: at(3 * MINUTE),
          updatedAt: at(3 * MINUTE),
        })
      })

      it('keeps the key of a shelf photo, whose image the photo row holds', async () => {
        const { repository, newUser } = await make()
        const scan = newScan(await newUser(), { kind: 'shelf' })
        const photo = newPhoto(scan, 0, { photoKey: `photos/test/${scan.userId}/${scan.id}/shelf.jpg` })
        await repository.createScan(scan, [photo], [])

        expect((await repository.findPhoto(photo.id))!.photoKey).toBe(photo.photoKey)
      })

      it('gives back each item\'s photoId, and the items point at photos the scan holds', async () => {
        const { repository, scan, items } = await seeded(2)

        const stored = await repository.itemsOf(scan.id)
        const photoIds = (await repository.photosOf(scan.id)).map((p) => p.id)

        expect(stored.map((i) => i.photoId)).toEqual(items.map((i) => i.photoId))
        expect(photoIds).toEqual(items.map((i) => i.photoId))
      })

      it('photosOf returns the scan\'s photos in position order, whatever order they were given in, and only that scan\'s', async () => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const [scan, other] = [newScan(userId), newScan(userId)]
        const [first, second, third] = [newPhoto(scan, 0), newPhoto(scan, 1), newPhoto(scan, 2)]
        await repository.createScan(scan, [third, first, second], [])
        await repository.createScan(other, [newPhoto(other, 0)], [])

        const photos = await repository.photosOf(scan.id)

        expect(photos.map((p) => p.id)).toEqual([first.id, second.id, third.id])
        expect(photos.map((p) => p.position)).toEqual([0, 1, 2])
        expect(await repository.photosOf(freshId())).toEqual([])
      })

      it('finds nothing for an unknown photo', async () => {
        const { repository } = await make()

        expect(await repository.findPhoto(freshId())).toBeNull()
      })

      it('gives back the kind a scan was created with, for both kinds', async () => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const [product, shelf] = [newScan(userId, { kind: 'product' }), newScan(userId, { kind: 'shelf' })]
        await repository.createScan(product, [newPhoto(product, 0)], [])
        await repository.createScan(shelf, [newPhoto(shelf, 0)], [])

        expect((await repository.findScan(product.id))!.kind).toBe('product')
        expect((await repository.findScan(shelf.id))!.kind).toBe('shelf')
      })

      it('refuses a second photo at the same position in one scan, and stores nothing of that batch', async () => {
        const { repository, newUser } = await make()
        const scan = newScan(await newUser())
        const item = newItem(scan, 0)
        const [good, clash] = [newPhoto(scan, 0, { id: item.photoId! }), newPhoto(scan, 0)]

        await expect(repository.createScan(scan, [good, clash], [item])).rejects.toThrow()

        expect(await repository.findScan(scan.id)).toBeNull()
        expect(await repository.findPhoto(good.id)).toBeNull()
        expect(await repository.findItem(item.id)).toBeNull()
      })

      it('refuses two items at the same position in one scan, and stores nothing of that batch', async () => {
        const { repository, newUser } = await make()
        const scan = newScan(await newUser())
        const [first, clash] = [newItem(scan, 0), newItem(scan, 0)]
        const photos = [newPhoto(scan, 0, { id: first.photoId! }), newPhoto(scan, 1, { id: clash.photoId! })]

        await expect(repository.createScan(scan, photos, [first, clash])).rejects.toThrow()

        expect(await repository.findScan(scan.id)).toBeNull()
        expect(await repository.findItem(first.id)).toBeNull()
      })

      it('allows the same position in two different scans', async () => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const [a, b] = [newScan(userId), newScan(userId)]

        await repository.createScan(a, [newPhoto(a, 0)], [])
        await repository.createScan(b, [newPhoto(b, 0)], [])

        expect(await repository.photosOf(a.id)).toHaveLength(1)
        expect(await repository.photosOf(b.id)).toHaveLength(1)
      })

      it('photoKeysForUsers lists the keys of those users\' shelf photos, not the photos without one, and not other users\'', async () => {
        const { repository, newUser } = await make()
        const [alice, bob] = [await newUser(), await newUser()]
        const [a, b] = [newScan(alice, { kind: 'shelf' }), newScan(bob, { kind: 'shelf' })]
        const shelfKey = `photos/test/${alice}/${a.id}/shelf.jpg`
        await repository.createScan(a, [newPhoto(a, 0, { photoKey: shelfKey }), newPhoto(a, 1)], [])
        await repository.createScan(b, [newPhoto(b, 0, { photoKey: `photos/test/${bob}/${b.id}/shelf.jpg` })], [])

        expect(await repository.photoKeysForUsers([alice])).toEqual([shelfKey])
      })

      it('deleteForUsers removes those users\' photos, and keeps everybody else\'s', async () => {
        const { repository, newUser } = await make()
        const [alice, bob] = [await newUser(), await newUser()]
        const [a, b] = [newScan(alice), newScan(bob)]
        const [aPhoto, bPhoto] = [newPhoto(a, 0), newPhoto(b, 0)]
        await repository.createScan(a, [aPhoto], [])
        await repository.createScan(b, [bPhoto], [])

        await repository.deleteForUsers([alice])

        expect(await repository.findPhoto(aPhoto.id)).toBeNull()
        expect(await repository.photosOf(a.id)).toEqual([])
        expect(await repository.findPhoto(bPhoto.id)).not.toBeNull()
      })
    })

    describe('storeRecognition', () => {
      const seededPhoto = async () => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const scan = newScan(userId, { kind: 'shelf' })
        const photo = newPhoto(scan, 0, { photoKey: `photos/test/${userId}/${scan.id}/${freshId()}.jpg` })
        await repository.createScan(scan, [photo], [newItem(scan, 0, { photoId: photo.id, photoKey: null })])
        return { repository, scan, photo }
      }

      it('stores the answer and the time on a recognising photo that holds none, and says so, leaving the state alone', async () => {
        const { repository, photo } = await seededPhoto()

        expect(await repository.storeRecognition(photo.id, '{"first":true}', at(MINUTE))).toBe(true)

        expect(await repository.findPhoto(photo.id)).toMatchObject({ state: 'recognising', recognition: '{"first":true}', updatedAt: at(MINUTE) })
      })

      it('keeps the first answer: a second call changes nothing and says so', async () => {
        const { repository, photo } = await seededPhoto()
        await repository.storeRecognition(photo.id, '{"first":true}', at(MINUTE))

        expect(await repository.storeRecognition(photo.id, '{"second":true}', at(2 * MINUTE))).toBe(false)

        expect(await repository.findPhoto(photo.id)).toMatchObject({ recognition: '{"first":true}', updatedAt: at(MINUTE) })
      })

      it('does nothing once the photo has left recognising, or for an unknown photo', async () => {
        const { repository, scan, photo } = await seededPhoto()
        const placeholder = (await repository.itemsOf(scan.id))[0]!
        await repository.fanOut({
          photo: { id: photo.id, patch: readPhoto({ recognition: null }) },
          placeholder: { id: placeholder.id, from: 'recognising', patch: { state: 'rejected', reason: 'unreadable', updatedAt: at(MINUTE) } },
          siblings: [],
          maxItems: 20,
        })

        expect(await repository.storeRecognition(photo.id, '{"late":true}', at(2 * MINUTE))).toBe(false)
        expect(await repository.storeRecognition(freshId(), '{}', at(2 * MINUTE))).toBe(false)
        expect((await repository.findPhoto(photo.id))!.recognition).toBeNull()
      })
    })

    describe('fanOut', () => {
      /** A shelf scan with one photo that holds its image, and one placeholder item at slot 0 still recognising. */
      const shelfSeeded = async (otherPositions: number[] = []) => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const scan = newScan(userId, { kind: 'shelf' })
        const photo = newPhoto(scan, 0, { photoKey: `photos/test/${userId}/${scan.id}/${freshId()}.jpg` })
        const placeholder = newItem(scan, 0, { photoId: photo.id, photoKey: null })
        const others = otherPositions.map((position) => newItem(scan, position, { photoId: freshId(), photoKey: null }))
        await repository.createScan(scan, [photo], [placeholder, ...others])
        const move = (patch: Partial<Parameters<ScansRepository['fanOut']>[0]['placeholder']['patch']> = {}) => ({
          id: placeholder.id,
          from: 'recognising' as ItemState,
          patch: { state: 'matching' as const, recognisedBrand: 'Glow Co', recognisedName: 'Serum 0', recognisedCategory: 'skin' as const, recognisedConfidence: 0.95, updatedAt: at(MINUTE), ...patch },
        })
        return { repository, scan, photo, placeholder, move, newUser }
      }

      it('stores the new items where the read puts them, moves the placeholder and the photo, and says the placeholder moved', async () => {
        const { repository, scan, photo, placeholder, move } = await shelfSeeded()
        const [a, b] = [newSibling(scan, photo, 1), newSibling(scan, photo, 2, { state: 'needs-confirmation', recognisedConfidence: 0.4, recognisedVariant: 'Night', recognisedForm: 'serum' })]

        const result = await repository.fanOut({ photo: { id: photo.id, patch: readPhoto() }, placeholder: move(), siblings: [a, b], maxItems: 20 })

        expect(result).toEqual({ placeholderMoved: true })
        expect((await repository.itemsOf(scan.id)).map((i) => [i.position, i.state])).toEqual([
          [0, 'matching'],
          [1, 'matching'],
          [2, 'needs-confirmation'],
        ])
        expect(await repository.findItem(placeholder.id)).toMatchObject({ recognisedName: 'Serum 0', recognisedConfidence: 0.95 })
        expect(await repository.findItem(b.id)).toMatchObject({
          id: b.id,
          scanId: scan.id,
          userId: scan.userId,
          position: 2,
          photoId: photo.id,
          photoKey: null,
          state: 'needs-confirmation',
          reason: null,
          backPhotoKey: null,
          recognisedBrand: 'Glow Co',
          recognisedName: 'Serum 2',
          recognisedVariant: 'Night',
          recognisedForm: 'serum',
          recognisedCategory: 'skin',
          recognisedConfidence: 0.4,
          productId: null,
          formulationId: null,
          noLabelSource: null,
          createdAt: at(MINUTE),
          updatedAt: at(MINUTE),
        })
        expect(await repository.findPhoto(photo.id)).toMatchObject({
          state: 'recognised',
          recognition: readPhoto().recognition,
          skippedNotBeauty: 1,
          skippedUnreadable: 2,
          skippedOverLimit: 3,
          skippedDailyLimit: 4,
          updatedAt: at(MINUTE),
        })
      })

      it('can reject the photo and its placeholder with no new items, clearing the photo\'s key', async () => {
        const { repository, scan, photo, placeholder, move } = await shelfSeeded()

        const result = await repository.fanOut({
          photo: { id: photo.id, patch: readPhoto({ state: 'rejected', photoKey: null }) },
          placeholder: move({ state: 'rejected', reason: 'not-a-beauty-product' }),
          siblings: [],
          maxItems: 20,
        })

        expect(result).toEqual({ placeholderMoved: true })
        expect(await repository.findPhoto(photo.id)).toMatchObject({ state: 'rejected', photoKey: null })
        expect(await repository.findItem(placeholder.id)).toMatchObject({ state: 'rejected', reason: 'not-a-beauty-product' })
        expect(await repository.itemsOf(scan.id)).toHaveLength(1)
      })

      it('counts the new items among the user\'s photos for the daily quota', async () => {
        const { repository, scan, photo, move } = await shelfSeeded()
        await repository.fanOut({ photo: { id: photo.id, patch: readPhoto() }, placeholder: move(), siblings: [newSibling(scan, photo, 1), newSibling(scan, photo, 2)], maxItems: 20 })

        expect((await repository.photosSince(scan.userId, at(0))).count).toBe(3)
      })

      it('skips, without an error, a new item that clashes on both its id and its position', async () => {
        const { repository, scan, photo, placeholder, move } = await shelfSeeded()
        const clash = newSibling(scan, photo, 0, { id: placeholder.id })

        const result = await repository.fanOut({ photo: { id: photo.id, patch: readPhoto() }, placeholder: move(), siblings: [clash, newSibling(scan, photo, 1)], maxItems: 20 })

        expect(result).toEqual({ placeholderMoved: true })
        expect((await repository.itemsOf(scan.id)).map((i) => [i.position, i.state])).toEqual([
          [0, 'matching'],
          [1, 'matching'],
        ])
      })

      it('stores nothing at all when one new item cannot be stored (its id is taken)', async () => {
        const { repository, scan, photo, placeholder, move } = await shelfSeeded()
        const clash = newSibling(scan, photo, 2, { id: placeholder.id })

        await expect(repository.fanOut({ photo: { id: photo.id, patch: readPhoto() }, placeholder: move(), siblings: [newSibling(scan, photo, 1), clash], maxItems: 20 })).rejects.toThrow()

        expect(await repository.itemsOf(scan.id)).toHaveLength(1)
        expect(await repository.findItem(placeholder.id)).toMatchObject({ state: 'recognising', recognisedName: null })
        expect(await repository.findPhoto(photo.id)).toMatchObject({ state: 'recognising', recognition: null, skippedNotBeauty: 0 })
      })

      it('does nothing new when repeated: the placeholder does not move again, no item is added or changed, the photo keeps its first answer', async () => {
        const { repository, scan, photo, placeholder, move } = await shelfSeeded()
        const siblings = [newSibling(scan, photo, 1), newSibling(scan, photo, 2)]
        await repository.fanOut({ photo: { id: photo.id, patch: readPhoto() }, placeholder: move(), siblings, maxItems: 20 })
        const items = await repository.itemsOf(scan.id)
        const stored = await repository.findPhoto(photo.id)

        const again = await repository.fanOut({
          photo: { id: photo.id, patch: readPhoto({ skippedOverLimit: 9, updatedAt: at(2 * MINUTE) }) },
          placeholder: move({ updatedAt: at(2 * MINUTE) }),
          siblings: siblings.map((s) => ({ ...s, id: freshId(), recognisedName: 'Changed' })),
          maxItems: 20,
        })

        expect(again).toEqual({ placeholderMoved: false })
        expect(await repository.itemsOf(scan.id)).toEqual(items)
        expect(await repository.findItem(placeholder.id)).toMatchObject({ updatedAt: at(MINUTE) })
        expect(await repository.findPhoto(photo.id)).toEqual(stored)
      })

      it('skips a new item whose position is already taken, with no error, leaves the item that holds it, and stores the others', async () => {
        const { repository, scan, photo, move } = await shelfSeeded([2])

        const result = await repository.fanOut({
          photo: { id: photo.id, patch: readPhoto() },
          placeholder: move(),
          siblings: [newSibling(scan, photo, 1, { recognisedName: 'First' }), newSibling(scan, photo, 2, { recognisedName: 'Clash' }), newSibling(scan, photo, 3, { recognisedName: 'Third' })],
          maxItems: 20,
        })

        expect(result).toEqual({ placeholderMoved: true })
        expect((await repository.itemsOf(scan.id)).map((i) => [i.position, i.recognisedName])).toEqual([
          [0, 'Serum 0'],
          [1, 'First'],
          [2, null],
          [3, 'Third'],
        ])
      })

      describe('the cap on items in a scan', () => {
        it('stores new items only while the scan holds fewer than maxItems, the first in the list winning', async () => {
          const { repository, scan, photo, move } = await shelfSeeded([100])
          const siblings = [1, 2, 3, 4].map((position) => newSibling(scan, photo, position))

          await repository.fanOut({ photo: { id: photo.id, patch: readPhoto() }, placeholder: move(), siblings, maxItems: 4 })

          // The scan held 2 items (the placeholder and one other): room for 2 more.
          expect((await repository.itemsOf(scan.id)).map((i) => i.position)).toEqual([0, 1, 2, 100])
        })

        it('stores them all when they bring the scan to exactly maxItems', async () => {
          const { repository, scan, photo, move } = await shelfSeeded([100])

          await repository.fanOut({ photo: { id: photo.id, patch: readPhoto() }, placeholder: move(), siblings: [newSibling(scan, photo, 1), newSibling(scan, photo, 2)], maxItems: 4 })

          expect(await repository.itemsOf(scan.id)).toHaveLength(4)
        })

        it('stores none when the scan is already at maxItems, and still moves the placeholder and the photo', async () => {
          const { repository, scan, photo, placeholder, move } = await shelfSeeded([100])

          const result = await repository.fanOut({ photo: { id: photo.id, patch: readPhoto() }, placeholder: move(), siblings: [newSibling(scan, photo, 1)], maxItems: 2 })

          expect(result).toEqual({ placeholderMoved: true })
          expect(await repository.itemsOf(scan.id)).toHaveLength(2)
          expect((await repository.findItem(placeholder.id))!.state).toBe('matching')
          expect((await repository.findPhoto(photo.id))!.state).toBe('recognised')
        })

        it('counts only the items of its own scan', async () => {
          const { repository, scan, photo, move, newUser } = await shelfSeeded()
          const other = newScan(await newUser())
          await createWithPhotos(repository, other, [newItem(other, 0), newItem(other, 1), newItem(other, 2)])

          await repository.fanOut({ photo: { id: photo.id, patch: readPhoto() }, placeholder: move(), siblings: [newSibling(scan, photo, 1)], maxItems: 2 })

          expect(await repository.itemsOf(scan.id)).toHaveLength(2)
        })
      })

      describe('the guards', () => {
        it('applies the photo\'s patch only while the photo is recognising: a photo already read keeps its answer, yet the placeholder still moves (the undo case)', async () => {
          const { repository, scan, photo, placeholder, move } = await shelfSeeded()
          await repository.fanOut({ photo: { id: photo.id, patch: readPhoto() }, placeholder: move(), siblings: [newSibling(scan, photo, 1)], maxItems: 20 })
          const stored = await repository.findPhoto(photo.id)
          // The next step could not be queued: the placeholder is put back.
          expect(await repository.updateItem(placeholder.id, 'matching', { state: 'recognising', updatedAt: at(2 * MINUTE) })).toBe(true)

          const result = await repository.fanOut({
            photo: { id: photo.id, patch: readPhoto({ skippedOverLimit: 9, updatedAt: at(3 * MINUTE) }) },
            placeholder: move({ updatedAt: at(3 * MINUTE) }),
            siblings: [newSibling(scan, photo, 1)],
            maxItems: 20,
          })

          expect(result).toEqual({ placeholderMoved: true })
          expect(await repository.findPhoto(photo.id)).toEqual(stored)
          expect(await repository.findItem(placeholder.id)).toMatchObject({ state: 'matching', updatedAt: at(3 * MINUTE) })
          expect(await repository.itemsOf(scan.id)).toHaveLength(2)
        })

        it('says false and leaves the placeholder as it was when it is not in the state it was expected in', async () => {
          const { repository, scan, photo, placeholder, move } = await shelfSeeded()
          await repository.updateItem(placeholder.id, 'recognising', { state: 'failed', reason: 'unavailable', updatedAt: at(30 * SECOND) })

          const result = await repository.fanOut({ photo: { id: photo.id, patch: readPhoto() }, placeholder: move(), siblings: [newSibling(scan, photo, 1)], maxItems: 20 })

          expect(result).toEqual({ placeholderMoved: false })
          expect(await repository.findItem(placeholder.id)).toMatchObject({ state: 'failed', reason: 'unavailable', recognisedName: null, updatedAt: at(30 * SECOND) })
        })

        it('says false for an unknown placeholder', async () => {
          const { repository, scan, photo, move } = await shelfSeeded()

          const result = await repository.fanOut({ photo: { id: photo.id, patch: readPhoto() }, placeholder: { ...move(), id: freshId() }, siblings: [], maxItems: 20 })

          expect(result).toEqual({ placeholderMoved: false })
          expect(await repository.itemsOf(scan.id)).toHaveLength(1)
        })
      })
    })

    // D1 binds at most 100 parameters per statement, so the repository reads ids in chunks; these sizes straddle the chunk edge.
    describe('findItems', () => {
      /** `count` items, spread over several scans: findItems does not care which scan an item is in. */
      const storeItems = async (count: number) => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const ids: string[] = []
        for (let stored = 0; stored < count; stored += 20) {
          const scan = newScan(userId)
          const items = Array.from({ length: Math.min(20, count - stored) }, (_, i) => newItem(scan, i))
          await createWithPhotos(repository, scan, items)
          ids.push(...items.map((item) => item.id))
        }
        return { repository, ids }
      }

      it.each([1, 90, 91, 95, 181])('returns each of %i stored ids once', async (count) => {
        const { repository, ids } = await storeItems(count)

        const found = (await repository.findItems(ids)).map((item) => item.id)

        expect(found).toHaveLength(count)
        expect([...found].sort()).toEqual([...ids].sort())
      })

      it('returns exactly the stored ones when some of the ids are unknown', async () => {
        const { repository, ids } = await storeItems(95)

        const found = (await repository.findItems([...ids.slice(0, 50), freshId(), ...ids.slice(50), freshId()])).map((item) => item.id)

        expect(found).toHaveLength(95)
        expect([...found].sort()).toEqual([...ids].sort())
      })

      it('returns nothing for no ids, and nothing for ids nobody has', async () => {
        const { repository } = await storeItems(1)

        expect(await repository.findItems([])).toEqual([])
        expect(await repository.findItems(Array.from({ length: 95 }, freshId))).toEqual([])
      })
    })

    describe('updateItem', () => {
      it('applies the patch, with the new time, while the item is in the expected state, and says so', async () => {
        const { repository, items } = await seeded(1)

        const applied = await repository.updateItem(items[0]!.id, 'recognising', {
          state: 'needs-confirmation',
          recognisedBrand: 'Glow Co',
          recognisedName: 'Bright Tone Serum',
          recognisedVariant: 'Extra Strength',
          recognisedCategory: 'skin',
          recognisedConfidence: 0.55,
          updatedAt: at(5 * MINUTE),
        })

        expect(applied).toBe(true)
        const item = await repository.findItem(items[0]!.id)
        expect(item).toMatchObject({
          state: 'needs-confirmation',
          recognisedBrand: 'Glow Co',
          recognisedName: 'Bright Tone Serum',
          recognisedVariant: 'Extra Strength',
          recognisedCategory: 'skin',
          recognisedConfidence: 0.55,
        })
        expect(item!.updatedAt.getTime()).toBe(at(5 * MINUTE).getTime())
        expect(item!.createdAt.getTime()).toBe(BASE.getTime())
      })

      it('stores the recognised form, and clears it when the patch sets it to null', async () => {
        const { repository, items } = await seeded(1)
        const id = items[0]!.id

        await repository.updateItem(id, 'recognising', { recognisedForm: 'spray', updatedAt: at(5 * MINUTE) })
        expect((await repository.findItem(id))!.recognisedForm).toBe('spray')

        await repository.updateItem(id, 'recognising', { recognisedForm: null, updatedAt: at(6 * MINUTE) })
        expect((await repository.findItem(id))!.recognisedForm).toBeNull()
      })

      it('leaves a field the patch does not mention as it was, and clears one the patch sets to null', async () => {
        const { repository, items } = await seeded(1)
        const id = items[0]!.id
        await repository.updateItem(id, 'recognising', {
          state: 'rejected',
          reason: 'face-or-person',
          productId: 'product-1',
          formulationId: 'formulation-1',
          updatedAt: at(MINUTE),
        })

        const applied = await repository.updateItem(id, 'rejected', { photoKey: null, productId: null, updatedAt: at(2 * MINUTE) })

        expect(applied).toBe(true)
        expect(await repository.findItem(id)).toMatchObject({
          state: 'rejected',
          reason: 'face-or-person',
          photoKey: null,
          productId: null,
          formulationId: 'formulation-1',
        })
      })

      it('refuses, changing nothing, when the item is in another state', async () => {
        const { repository, items } = await seeded(1)
        const id = items[0]!.id
        const before = await repository.findItem(id)

        const applied = await repository.updateItem(id, 'matching', { state: 'ready', productId: 'product-1', updatedAt: at(MINUTE) })

        expect(applied).toBe(false)
        expect(await repository.findItem(id)).toEqual(before)
      })

      it('says false for an unknown item', async () => {
        const { repository } = await make()

        expect(await repository.updateItem(freshId(), 'recognising', { state: 'matching', updatedAt: at(MINUTE) })).toBe(false)
      })

      it('lets exactly one of two simultaneous updates from the same state win', async () => {
        const { repository, items } = await seeded(1)
        const id = items[0]!.id

        const results = await Promise.all([
          repository.updateItem(id, 'recognising', { state: 'matching', updatedAt: at(MINUTE) }),
          repository.updateItem(id, 'recognising', { state: 'rejected', reason: 'unreadable', updatedAt: at(MINUTE) }),
        ])

        expect(results.filter(Boolean)).toHaveLength(1)
        const item = await repository.findItem(id)
        expect(item!.state).toBe(results[0] ? 'matching' : 'rejected')
      })

      it('only touches the item it was asked about', async () => {
        const { repository, items } = await seeded(2)

        await repository.updateItem(items[0]!.id, 'recognising', { state: 'matching', updatedAt: at(MINUTE) })

        expect((await repository.findItem(items[1]!.id))!.state).toBe('recognising')
      })
    })

    describe('the shelf', () => {
      const MOVE_AT = at(5 * MINUTE)

      /** A user with a real default profile (the shelf row's foreign key is real on D1), and a way to scan as that profile. */
      const shelving = async () => {
        const setup = await make()
        const userId = await setup.newUserWithoutProfile()
        const profileId = await setup.giveDefaultProfile(userId)
        const scanItems = async (count = 1, over: Partial<NewScan> = {}) => {
          const scan = newScan(userId, { profileId, ...over })
          const items = Array.from({ length: count }, (_, i) => newItem(scan, i))
          await createWithPhotos(setup.repository, scan, items)
          return { scan, items }
        }
        return { ...setup, userId, profileId, scanItems }
      }
      const ready = (productId: string, formulationId: string, updatedAt: Date): ItemPatch => ({ state: 'ready', productId, formulationId, updatedAt })

      it('puts an item that moves into ready on its profile\'s shelf: one product row with the item\'s product and formulation, its scan and item as the source, and the move time as added and last scanned', async () => {
        const { repository, profileId, scanItems, shelfOf } = await shelving()
        const { scan, items } = await scanItems()
        const [productId, formulationId] = [fresh('product'), fresh('formulation')]

        const applied = await repository.updateItem(items[0]!.id, 'recognising', ready(productId, formulationId, MOVE_AT))

        expect(applied).toBe(true)
        const rows = await shelfOf(profileId)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          profileId,
          kind: 'product',
          productId,
          formulationId,
          scanId: scan.id,
          itemId: items[0]!.id,
          addedAt: MOVE_AT,
          lastScannedAt: MOVE_AT,
          removedAt: null,
          removedReason: null,
        })
      })

      it('records an upload and shelves the item when one move into ready carries both, and says the move applied', async () => {
        const { repository, userId, profileId, scanItems, shelfOf } = await shelving()
        const { items } = await scanItems()

        const applied = await repository.updateItem(items[0]!.id, 'recognising', ready(fresh('product'), fresh('formulation'), MOVE_AT), newUpload(items[0]!.id, userId, MOVE_AT))

        expect(applied).toBe(true)
        expect(await repository.countBackPhotos(items[0]!.id)).toBe(1)
        expect(await shelfOf(profileId)).toHaveLength(1)
      })

      it('keeps one row when a second item of the same product reaches ready for the profile: formulation, source and last scanned follow the newer item, added stays the first time', async () => {
        const { repository, profileId, scanItems, shelfOf } = await shelving()
        const productId = fresh('product')
        const first = await scanItems()
        const second = await scanItems()
        const newerFormulation = fresh('formulation')
        await repository.updateItem(first.items[0]!.id, 'recognising', ready(productId, fresh('formulation'), at(5 * MINUTE)))
        const entryId = (await shelfOf(profileId))[0]!.id

        await repository.updateItem(second.items[0]!.id, 'recognising', ready(productId, newerFormulation, at(9 * MINUTE)))

        const rows = await shelfOf(profileId)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          id: entryId,
          productId,
          formulationId: newerFormulation,
          scanId: second.scan.id,
          itemId: second.items[0]!.id,
          addedAt: at(5 * MINUTE),
          lastScannedAt: at(9 * MINUTE),
        })
      })

      it('restores a removed product when an item of it reaches ready again: removed time and reason are cleared, added stays the first time', async () => {
        const { repository, profileId, scanItems, shelfOf, removeFromShelf } = await shelving()
        const productId = fresh('product')
        const first = await scanItems()
        const second = await scanItems()
        await repository.updateItem(first.items[0]!.id, 'recognising', ready(productId, fresh('formulation'), at(5 * MINUTE)))
        const entryId = (await shelfOf(profileId))[0]!.id
        await removeFromShelf(entryId, 'finished', at(6 * MINUTE))
        expect((await shelfOf(profileId))[0]).toMatchObject({ removedAt: at(6 * MINUTE), removedReason: 'finished' })

        await repository.updateItem(second.items[0]!.id, 'recognising', ready(productId, fresh('formulation'), at(9 * MINUTE)))

        const rows = await shelfOf(profileId)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ id: entryId, removedAt: null, removedReason: null, addedAt: at(5 * MINUTE), lastScannedAt: at(9 * MINUTE), itemId: second.items[0]!.id })
      })

      it('gives each profile its own row for the same product', async () => {
        const { repository, shelfOf, profileId, scanItems, newUserWithoutProfile, giveDefaultProfile } = await shelving()
        const productId = fresh('product')
        const mine = await scanItems()
        const otherUser = await newUserWithoutProfile()
        const otherProfile = await giveDefaultProfile(otherUser)
        const theirScan = newScan(otherUser, { profileId: otherProfile })
        const theirItem = newItem(theirScan, 0)
        await createWithPhotos(repository, theirScan, [theirItem])

        await repository.updateItem(mine.items[0]!.id, 'recognising', ready(productId, fresh('formulation'), at(5 * MINUTE)))
        await repository.updateItem(theirItem.id, 'recognising', ready(productId, fresh('formulation'), at(6 * MINUTE)))

        const [theirs, ours] = [await shelfOf(otherProfile), await shelfOf(profileId)]
        expect(ours.map((r) => r.itemId)).toEqual([mine.items[0]!.id])
        expect(theirs.map((r) => r.itemId)).toEqual([theirItem.id])
      })

      it('puts an item that moves into unidentified on the shelf as a no-label row with no product or formulation, its scan and item as the source', async () => {
        const { repository, profileId, scanItems, shelfOf } = await shelving()
        const { scan, items } = await scanItems()

        const applied = await repository.updateItem(items[0]!.id, 'recognising', { state: 'unidentified', updatedAt: MOVE_AT })

        expect(applied).toBe(true)
        const rows = await shelfOf(profileId)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          profileId,
          kind: 'no-label',
          productId: null,
          formulationId: null,
          scanId: scan.id,
          itemId: items[0]!.id,
          addedAt: MOVE_AT,
          lastScannedAt: MOVE_AT,
          removedAt: null,
          removedReason: null,
        })
      })

      it('gives every unidentified item its own row, whatever its answers', async () => {
        const { repository, profileId, scanItems, shelfOf } = await shelving()
        const { items } = await scanItems(2)

        await repository.updateItem(items[0]!.id, 'recognising', { state: 'unidentified', updatedAt: at(5 * MINUTE) })
        await repository.updateItem(items[1]!.id, 'recognising', { state: 'unidentified', updatedAt: at(6 * MINUTE) })

        const rows = await shelfOf(profileId)
        expect(rows.map((r) => r.itemId).sort()).toEqual(items.map((i) => i.id).sort())
        expect(rows.every((r) => r.kind === 'no-label')).toBe(true)
      })

      it('shelves nothing, and says false, when the guarded move does not apply because the item is in another state', async () => {
        const { repository, profileId, scanItems, shelfOf } = await shelving()
        const { items } = await scanItems(2)

        const ready_ = await repository.updateItem(items[0]!.id, 'matching', ready(fresh('product'), fresh('formulation'), MOVE_AT))
        const unidentified = await repository.updateItem(items[1]!.id, 'matching', { state: 'unidentified', updatedAt: MOVE_AT })

        expect([ready_, unidentified]).toEqual([false, false])
        expect(await shelfOf(profileId)).toEqual([])
      })

      it('shelves nothing for an unknown item', async () => {
        const { repository, profileId, shelfOf } = await shelving()

        expect(await repository.updateItem(freshId(), 'recognising', ready(fresh('product'), fresh('formulation'), MOVE_AT))).toBe(false)
        expect(await shelfOf(profileId)).toEqual([])
      })

      it('applies a move into ready for a scan with no profile, and shelves nothing', async () => {
        const { repository, newUserWithoutProfile } = await make()
        // An owner with no profile, so the reaper's adoption (another case) never picks this scan up.
        const scan = orphan(await newUserWithoutProfile())
        const item = newItem(scan, 0)
        await createWithPhotos(repository, scan, [item])

        const applied = await repository.updateItem(item.id, 'recognising', ready(fresh('product'), fresh('formulation'), MOVE_AT))

        expect(applied).toBe(true)
        expect((await repository.findItem(item.id))!.state).toBe('ready')
      })

      it('applies a move into unidentified for a scan with no profile, and shelves nothing', async () => {
        const { repository, newUserWithoutProfile } = await make()
        // An owner with no profile, so the reaper's adoption (another case) never picks this scan up.
        const scan = orphan(await newUserWithoutProfile())
        const item = newItem(scan, 0)
        await createWithPhotos(repository, scan, [item])

        expect(await repository.updateItem(item.id, 'recognising', { state: 'unidentified', updatedAt: MOVE_AT })).toBe(true)
        expect((await repository.findItem(item.id))!.state).toBe('unidentified')
      })

      it('applies the move, and shelves nothing, when the scan\'s profile is not a profile that exists', async () => {
        const { repository, newUser, shelfOf } = await make()
        const scan = newScan(await newUser())
        const items = [newItem(scan, 0), newItem(scan, 1)]
        await createWithPhotos(repository, scan, items)

        const applied = [
          await repository.updateItem(items[0]!.id, 'recognising', ready(fresh('product'), fresh('formulation'), MOVE_AT)),
          await repository.updateItem(items[1]!.id, 'recognising', { state: 'unidentified', updatedAt: MOVE_AT }),
        ]

        expect(applied).toEqual([true, true])
        expect((await repository.findItem(items[0]!.id))!.state).toBe('ready')
        expect((await repository.findItem(items[1]!.id))!.state).toBe('unidentified')
        expect(await shelfOf(scan.profileId)).toEqual([])
      })

      it.each(['matching', 'analysing', 'researching', 'reading-label', 'needs-back-photo', 'needs-confirmation', 'rejected', 'failed'] as const)('shelves nothing for a move into %s', async (state) => {
        const { repository, profileId, scanItems, shelfOf } = await shelving()
        const { items } = await scanItems()

        const applied = await repository.updateItem(items[0]!.id, 'recognising', { state, productId: fresh('product'), formulationId: fresh('formulation'), updatedAt: MOVE_AT })

        expect(applied).toBe(true)
        expect(await shelfOf(profileId)).toEqual([])
      })

      it('shelves nothing when a ready item has no product, and the move still applies', async () => {
        const { repository, profileId, scanItems, shelfOf } = await shelving()
        const { items } = await scanItems()

        const applied = await repository.updateItem(items[0]!.id, 'recognising', { state: 'ready', updatedAt: MOVE_AT })

        expect(applied).toBe(true)
        expect((await repository.findItem(items[0]!.id))!.state).toBe('ready')
        expect(await shelfOf(profileId)).toEqual([])
      })

      it.each(['ready', 'unidentified'] as const)('throws, and leaves the item as it was, when a move into %s carries no time', async (state) => {
        const { repository, profileId, scanItems, shelfOf } = await shelving()
        const { items } = await scanItems()
        const before = await repository.findItem(items[0]!.id)

        await expect(repository.updateItem(items[0]!.id, 'recognising', { state, productId: fresh('product') } as unknown as ItemPatch)).rejects.toThrow()

        expect(await repository.findItem(items[0]!.id)).toEqual(before)
        expect(await shelfOf(profileId)).toEqual([])
      })

      it('neither duplicates nor bumps a row when a move is repeated and its guard no longer matches', async () => {
        const { repository, profileId, scanItems, shelfOf } = await shelving()
        const { items } = await scanItems(2)
        const productId = fresh('product')
        const formulationId = fresh('formulation')
        await repository.updateItem(items[0]!.id, 'recognising', ready(productId, formulationId, at(5 * MINUTE)))
        await repository.updateItem(items[1]!.id, 'recognising', { state: 'unidentified', updatedAt: at(5 * MINUTE) })
        const before = await shelfOf(profileId)

        const again = [
          await repository.updateItem(items[0]!.id, 'recognising', ready(productId, fresh('formulation'), at(9 * MINUTE))),
          await repository.updateItem(items[1]!.id, 'recognising', { state: 'unidentified', updatedAt: at(9 * MINUTE) }),
        ]

        expect(again).toEqual([false, false])
        expect(before).toHaveLength(2)
        expect(await shelfOf(profileId)).toEqual(before)
      })
    })

    describe('the answers to an item with no label', () => {
      const ANSWERS = { noLabelSource: 'market-vendor', noLabelPurpose: 'lighten', noLabelUsedFor: '6-months-2-years', noLabelDescription: 'A tub with no name on it' } as const

      /** An item that has reached needs-identification, the only state the no-label answers are given in. */
      const awaiting = async () => {
        const { repository, items } = await seeded(1)
        const id = items[0]!.id
        await repository.updateItem(id, 'recognising', { state: 'needs-identification', reason: 'unreadable', photoKey: null, updatedAt: at(MINUTE) })
        return { repository, id }
      }

      it('stores all four answers together with the move to unidentified, and gives them back', async () => {
        const { repository, id } = await awaiting()

        const applied = await repository.updateItem(id, 'needs-identification', { state: 'unidentified', reason: null, ...ANSWERS, updatedAt: at(2 * MINUTE) })

        expect(applied).toBe(true)
        const item = await repository.findItem(id)
        expect(item).toMatchObject({ state: 'unidentified', reason: null, ...ANSWERS })
        expect(item!.updatedAt.getTime()).toBe(at(2 * MINUTE).getTime())
      })

      it('leaves the answers null on an item that has not been given any', async () => {
        const { repository, id } = await awaiting()

        expect(await repository.findItem(id)).toMatchObject({ noLabelSource: null, noLabelPurpose: null, noLabelUsedFor: null, noLabelDescription: null })
      })

      it('keeps an answer a later patch does not mention, and clears one the patch sets to null', async () => {
        const { repository, id } = await awaiting()
        await repository.updateItem(id, 'needs-identification', { state: 'unidentified', ...ANSWERS, updatedAt: at(2 * MINUTE) })

        const applied = await repository.updateItem(id, 'unidentified', { noLabelDescription: null, updatedAt: at(3 * MINUTE) })

        expect(applied).toBe(true)
        expect(await repository.findItem(id)).toMatchObject({
          state: 'unidentified',
          noLabelSource: 'market-vendor',
          noLabelPurpose: 'lighten',
          noLabelUsedFor: '6-months-2-years',
          noLabelDescription: null,
        })
      })

      it('stores nothing when the item is in another state: the answers are written only by the guarded move', async () => {
        const { repository, id } = await awaiting()
        const before = await repository.findItem(id)

        const applied = await repository.updateItem(id, 'needs-retake', { state: 'unidentified', ...ANSWERS, updatedAt: at(2 * MINUTE) })

        expect(applied).toBe(false)
        expect(await repository.findItem(id)).toEqual(before)
      })

      it('lets exactly one of two simultaneous moves to unidentified win, and keeps the winner\'s answers', async () => {
        const { repository, id } = await awaiting()

        const results = await Promise.all([
          repository.updateItem(id, 'needs-identification', { state: 'unidentified', ...ANSWERS, noLabelSource: 'pharmacy', updatedAt: at(2 * MINUTE) }),
          repository.updateItem(id, 'needs-identification', { state: 'unidentified', ...ANSWERS, noLabelSource: 'gift', updatedAt: at(2 * MINUTE) }),
        ])

        expect(results.filter(Boolean)).toHaveLength(1)
        expect((await repository.findItem(id))!.noLabelSource).toBe(results[0] ? 'pharmacy' : 'gift')
      })

      it('only writes the answers to the item it was asked about', async () => {
        const { repository, items } = await seeded(2)
        await repository.updateItem(items[0]!.id, 'recognising', { state: 'needs-identification', updatedAt: at(MINUTE) })

        await repository.updateItem(items[0]!.id, 'needs-identification', { state: 'unidentified', ...ANSWERS, updatedAt: at(2 * MINUTE) })

        expect(await repository.findItem(items[1]!.id)).toMatchObject({ state: 'recognising', noLabelSource: null, noLabelDescription: null })
      })
    })

    describe('photo counts for the daily quotas', () => {
      const since = at(HOUR)

      it('counts one photo per item created at or after the cutoff, and not one made a millisecond before it', async () => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const before = newScan(userId, { createdAt: new Date(since.getTime() - 1) })
        const exactly = newScan(userId, { createdAt: since })
        await createWithPhotos(repository, before, [newItem(before, 0), newItem(before, 1)])
        await createWithPhotos(repository, exactly, [newItem(exactly, 0), newItem(exactly, 1), newItem(exactly, 2)])

        const counted = await repository.photosSince(userId, since)

        expect(counted.count).toBe(3)
        expect(counted.oldest!.getTime()).toBe(since.getTime())
      })

      it('leaves out an item created uncounted, and still counts the counted ones beside it', async () => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const uncounted = newScan(userId, { kind: 'typed', createdAt: at(2 * HOUR) })
        const counted = newScan(userId, { createdAt: at(3 * HOUR) })
        await repository.createScan(uncounted, [], [newItem(uncounted, 0, { photoId: null, photoKey: null, state: 'needs-identification', counted: false })])
        await createWithPhotos(repository, counted, [newItem(counted, 0), newItem(counted, 1, { counted: true })])

        const taken = await repository.photosSince(userId, since)

        expect(taken.count).toBe(2)
        expect(taken.oldest!.getTime()).toBe(at(3 * HOUR).getTime())
      })

      it('says none for a user whose only items are uncounted', async () => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const scan = newScan(userId, { kind: 'typed', createdAt: at(2 * HOUR) })
        await repository.createScan(scan, [], [newItem(scan, 0, { photoId: null, photoKey: null, state: 'needs-identification', counted: false })])

        expect(await repository.photosSince(userId, since)).toEqual({ count: 0, oldest: null })
      })

      it('leaves out uncounted items from the address count too, across users, and still counts the counted ones', async () => {
        const { repository, newUser } = await make()
        const ipHash = fresh('typed-ip')
        const [alice, bob] = [await newUser(), await newUser()]
        const uncounted = newScan(alice, { kind: 'typed', ipHash, createdAt: at(2 * HOUR) })
        const counted = newScan(bob, { ipHash, createdAt: at(3 * HOUR) })
        await repository.createScan(uncounted, [], [newItem(uncounted, 0, { photoId: null, photoKey: null, state: 'needs-identification', counted: false })])
        await createWithPhotos(repository, counted, [newItem(counted, 0)])

        const taken = await repository.photosSinceIp(ipHash, since)

        expect(taken.count).toBe(1)
        expect(taken.oldest!.getTime()).toBe(at(3 * HOUR).getTime())
      })

      it('says none, with no oldest time, for a user with no photos in the window', async () => {
        const { repository, newUser } = await make()

        expect(await repository.photosSince(await newUser(), since)).toEqual({ count: 0, oldest: null })
      })

      it('counts only that user\'s photos, and reports the oldest of those in the window', async () => {
        const { repository, newUser } = await make()
        const [alice, bob] = [await newUser(), await newUser()]
        const [a1, a2, b1] = [newScan(alice, { createdAt: at(3 * HOUR) }), newScan(alice, { createdAt: at(2 * HOUR) }), newScan(bob, { createdAt: at(HOUR) })]
        await createWithPhotos(repository, a1, [newItem(a1, 0)])
        await createWithPhotos(repository, a2, [newItem(a2, 0), newItem(a2, 1)])
        await createWithPhotos(repository, b1, [newItem(b1, 0)])

        const counted = await repository.photosSince(alice, since)

        expect(counted.count).toBe(3)
        expect(counted.oldest!.getTime()).toBe(at(2 * HOUR).getTime())
      })

      it('still counts the photo of an item whose photo was deleted (a rejected item)', async () => {
        const { repository, userId, items } = await seeded(1, { createdAt: since })
        await repository.updateItem(items[0]!.id, 'recognising', { state: 'rejected', reason: 'face-or-person', photoKey: null, updatedAt: at(2 * HOUR) })

        expect((await repository.photosSince(userId, since)).count).toBe(1)
      })

      it('counts a back photo as one more photo, at the time it was uploaded, and keeps counting it after the back photo is deleted', async () => {
        const { repository, userId, items } = await seeded(1, { createdAt: at(-5 * HOUR) })
        const id = items[0]!.id
        await repository.updateItem(id, 'recognising', { state: 'needs-back-photo', updatedAt: at(-4 * HOUR) })
        expect((await repository.photosSince(userId, since)).count).toBe(0)

        await repository.updateItem(
          id,
          'needs-back-photo',
          { state: 'reading-label', backPhotoKey: 'photos/test/user/scan/item-back.jpg', updatedAt: at(2 * HOUR) },
          newUpload(id, userId, at(2 * HOUR)),
        )
        const stored = await repository.photosSince(userId, since)
        expect(stored.count).toBe(1)
        expect(stored.oldest!.getTime()).toBe(at(2 * HOUR).getTime())

        await repository.updateItem(id, 'reading-label', { state: 'needs-back-photo', reason: 'label-unreadable', backPhotoKey: null, updatedAt: at(3 * HOUR) })
        expect((await repository.photosSince(userId, since)).count).toBe(1)
      })

      it('counts every back photo an item is sent: three uploads in a row are three photos, not one', async () => {
        const { repository, userId, items } = await seeded(1, { createdAt: at(-5 * HOUR) })
        const id = items[0]!.id
        await repository.updateItem(id, 'recognising', { state: 'needs-back-photo', updatedAt: at(-4 * HOUR) })

        for (const [n, hours] of [1, 2, 3].entries()) {
          const applied = await repository.updateItem(
            id,
            'needs-back-photo',
            { state: 'reading-label', backPhotoKey: `back-${n}.jpg`, updatedAt: at(hours * HOUR) },
            newUpload(id, userId, at(hours * HOUR)),
          )
          expect(applied).toBe(true)
          await repository.updateItem(id, 'reading-label', { state: 'needs-back-photo', reason: 'label-unreadable', backPhotoKey: null, updatedAt: at(hours * HOUR + MINUTE) })
        }

        const counted = await repository.photosSince(userId, since)
        expect(counted.count).toBe(3)
        expect(counted.oldest!.getTime()).toBe(at(HOUR).getTime())
      })

      it('counts a back photo only from the cutoff on, inclusive', async () => {
        const { repository, userId, items } = await seeded(1, { createdAt: at(-5 * HOUR) })
        const id = items[0]!.id
        await repository.updateItem(id, 'recognising', { state: 'needs-back-photo', updatedAt: at(-4 * HOUR) })
        await repository.updateItem(id, 'needs-back-photo', { state: 'reading-label', updatedAt: at(-3 * HOUR) }, newUpload(id, userId, new Date(since.getTime() - 1)))
        await repository.updateItem(id, 'reading-label', { state: 'needs-back-photo', updatedAt: at(-2 * HOUR) })
        await repository.updateItem(id, 'needs-back-photo', { state: 'reading-label', updatedAt: at(-HOUR) }, newUpload(id, userId, since))

        const counted = await repository.photosSince(userId, since)

        expect(counted.count).toBe(1)
        expect(counted.oldest!.getTime()).toBe(since.getTime())
      })

      it('reports the oldest over front photos and back photos together', async () => {
        const { repository, userId, items } = await seeded(1, { createdAt: at(3 * HOUR) })
        const id = items[0]!.id
        await repository.updateItem(id, 'recognising', { state: 'needs-back-photo', updatedAt: at(3 * HOUR) })
        await repository.updateItem(id, 'needs-back-photo', { state: 'reading-label', updatedAt: at(4 * HOUR) }, newUpload(id, userId, at(2 * HOUR)))

        const counted = await repository.photosSince(userId, since)

        expect(counted.count).toBe(2)
        expect(counted.oldest!.getTime()).toBe(at(2 * HOUR).getTime())
      })

      it('records a back photo only when the update applies: an item in another state, or an unknown one, counts nothing', async () => {
        const { repository, userId, items } = await seeded(1, { createdAt: at(-5 * HOUR) })
        const id = items[0]!.id

        const wrongState = await repository.updateItem(id, 'needs-back-photo', { state: 'reading-label', updatedAt: at(2 * HOUR) }, newUpload(id, userId, at(2 * HOUR)))
        const unknown = await repository.updateItem(freshId(), 'needs-back-photo', { state: 'reading-label', updatedAt: at(2 * HOUR) }, newUpload(id, userId, at(2 * HOUR)))

        expect(wrongState).toBe(false)
        expect(unknown).toBe(false)
        expect((await repository.findItem(id))!.state).toBe('recognising')
        expect((await repository.photosSince(userId, since)).count).toBe(0)
      })

      it('counts a back photo for the address it was uploaded from, not the one the scan was made from', async () => {
        const { repository, userId, scan, items } = await seeded(1, { createdAt: at(-5 * HOUR) })
        const id = items[0]!.id
        const uploadIp = fresh('upload-from')
        await repository.updateItem(id, 'recognising', { state: 'needs-back-photo', updatedAt: at(-4 * HOUR) })
        await repository.updateItem(id, 'needs-back-photo', { state: 'reading-label', updatedAt: at(2 * HOUR) }, newUpload(id, userId, at(2 * HOUR), { ipHash: uploadIp }))

        expect((await repository.photosSinceIp(uploadIp, since)).count).toBe(1)
        expect(await repository.photosSinceIp(scan.ipHash, since)).toEqual({ count: 0, oldest: null })
      })

      it('counts by IP hash across users, and only for that hash', async () => {
        const { repository, newUser } = await make()
        const ipHash = fresh('shared-ip')
        const [alice, bob, carol] = [await newUser(), await newUser(), await newUser()]
        const [a, b, c] = [
          newScan(alice, { ipHash, createdAt: at(2 * HOUR) }),
          newScan(bob, { ipHash, createdAt: at(3 * HOUR) }),
          newScan(carol, { createdAt: at(2 * HOUR) }),
        ]
        await createWithPhotos(repository, a, [newItem(a, 0), newItem(a, 1)])
        await createWithPhotos(repository, b, [newItem(b, 0)])
        await createWithPhotos(repository, c, [newItem(c, 0)])

        const counted = await repository.photosSinceIp(ipHash, since)

        expect(counted.count).toBe(3)
        expect(counted.oldest!.getTime()).toBe(at(2 * HOUR).getTime())
        expect(await repository.photosSinceIp(fresh('unused-ip'), since)).toEqual({ count: 0, oldest: null })
      })

      it('adds the back photos uploaded from the address to its count, and takes the oldest over both', async () => {
        const { repository, newUser } = await make()
        const ipHash = fresh('mixed-ip')
        const [alice, bob] = [await newUser(), await newUser()]
        const a = newScan(alice, { ipHash, createdAt: at(3 * HOUR) })
        const b = newScan(bob, { createdAt: at(-5 * HOUR) })
        const aItem = newItem(a, 0)
        const bItem = newItem(b, 0)
        await createWithPhotos(repository, a, [aItem])
        await createWithPhotos(repository, b, [bItem])
        await repository.updateItem(bItem.id, 'recognising', { state: 'needs-back-photo', updatedAt: at(-4 * HOUR) })
        await repository.updateItem(bItem.id, 'needs-back-photo', { state: 'reading-label', updatedAt: at(2 * HOUR) }, newUpload(bItem.id, bob, at(2 * HOUR), { ipHash }))

        const counted = await repository.photosSinceIp(ipHash, since)

        expect(counted.count).toBe(2)
        expect(counted.oldest!.getTime()).toBe(at(2 * HOUR).getTime())
      })

      it('leaves out the photos of scans made from the address before the cutoff, however many there are', async () => {
        const { repository, newUser } = await make()
        const ipHash = fresh('old-ip')
        const userId = await newUser()
        for (let i = 0; i < 3; i++) {
          const old = newScan(userId, { ipHash, createdAt: at(-(i + 2) * HOUR) })
          await createWithPhotos(repository, old, [newItem(old, 0)])
        }
        const recent = newScan(userId, { ipHash, createdAt: at(2 * HOUR) })
        await createWithPhotos(repository, recent, [newItem(recent, 0)])

        const counted = await repository.photosSinceIp(ipHash, since)

        expect(counted.count).toBe(1)
        expect(counted.oldest!.getTime()).toBe(at(2 * HOUR).getTime())
      })

      it('applies the same inclusive cutoff to the IP count', async () => {
        const { repository, newUser } = await make()
        const ipHash = fresh('edge-ip')
        const userId = await newUser()
        const before = newScan(userId, { ipHash, createdAt: new Date(since.getTime() - 1) })
        const exactly = newScan(userId, { ipHash, createdAt: since })
        await createWithPhotos(repository, before, [newItem(before, 0)])
        await createWithPhotos(repository, exactly, [newItem(exactly, 0)])

        expect((await repository.photosSinceIp(ipHash, since)).count).toBe(1)
      })
    })

    describe('countBackPhotos', () => {
      it('counts the back photos recorded for that item only, and answers 0 for an item with none', async () => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const scan = newScan(userId)
        const [first, second] = [newItem(scan, 0), newItem(scan, 1)]
        await createWithPhotos(repository, scan, [first, second])
        await repository.updateItem(first.id, 'recognising', { state: 'needs-back-photo', updatedAt: at(MINUTE) })
        expect(await repository.countBackPhotos(first.id)).toBe(0)

        for (const [n, minutes] of [[1, 2], [2, 4], [3, 6]] as const) {
          await repository.updateItem(first.id, 'needs-back-photo', { state: 'reading-label', updatedAt: at(minutes * MINUTE) }, newUpload(first.id, userId, at(minutes * MINUTE)))
          expect(await repository.countBackPhotos(first.id)).toBe(n)
          await repository.updateItem(first.id, 'reading-label', { state: 'needs-back-photo', updatedAt: at((minutes + 1) * MINUTE) })
        }

        expect(await repository.countBackPhotos(second.id)).toBe(0)
      })
    })

    // A retake is a new front photo for an item that could not be read. It reuses the item's row, so it has no row of its own to
    // count: scan_retakes records each one, in the same write that moves the item back to recognising, like a back photo.
    describe('retakes', () => {
      const since = at(HOUR)

      /** One item that could not be read: made for `userId` at `createdAt`, and now waiting for a retake. */
      const awaitingRetakeFor = async (repository: ScansContractSetup['repository'], userId: string, createdAt = at(-5 * HOUR)) => {
        const scan = newScan(userId, { createdAt })
        const item = newItem(scan, 0)
        await createWithPhotos(repository, scan, [item])
        await repository.updateItem(item.id, 'recognising', { state: 'needs-retake', reason: 'unreadable', photoKey: null, updatedAt: at(-4 * HOUR) })
        return { scan, id: item.id }
      }
      const awaitingRetake = async (createdAt?: Date) => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        return { repository, userId, ...(await awaitingRetakeFor(repository, userId, createdAt)) }
      }
      /** The retake: a new photo in, the item recognising again, and the upload recorded by the same write. */
      const retake = (repository: ScansContractSetup['repository'], id: string, userId: string, uploadedAt: Date, over: Partial<NewRetake> = {}) =>
        repository.updateItem(
          id,
          'needs-retake',
          { state: 'recognising', reason: null, photoKey: `photos/test/${userId}/retake-${uploadedAt.getTime()}.jpg`, updatedAt: uploadedAt },
          undefined,
          newRetake(id, userId, uploadedAt, over),
        )
      /** The retaken photo could not be read either, so the item asks again. Its photo is deleted; the upload stays recorded. */
      const failAgain = (repository: ScansContractSetup['repository'], id: string, after: Date) =>
        repository.updateItem(id, 'recognising', { state: 'needs-retake', reason: 'label-not-visible', photoKey: null, updatedAt: new Date(after.getTime() + MINUTE) })

      it('countRetakes counts the retakes recorded for that item only, and answers 0 for an item with none', async () => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const scan = newScan(userId)
        const [first, second] = [newItem(scan, 0), newItem(scan, 1)]
        await createWithPhotos(repository, scan, [first, second])
        for (const item of [first, second]) await repository.updateItem(item.id, 'recognising', { state: 'needs-retake', reason: 'unreadable', photoKey: null, updatedAt: at(MINUTE) })
        expect(await repository.countRetakes(first.id)).toBe(0)

        for (const [n, minutes] of [[1, 2], [2, 4]] as const) {
          expect(await retake(repository, first.id, userId, at(minutes * MINUTE))).toBe(true)
          expect(await repository.countRetakes(first.id)).toBe(n)
          await failAgain(repository, first.id, at(minutes * MINUTE))
        }

        expect(await repository.countRetakes(second.id)).toBe(0)
      })

      it('answers 0 for an unknown item', async () => {
        const { repository } = await make()

        expect(await repository.countRetakes(freshId())).toBe(0)
      })

      it('is not a back photo: a retake does not count as one, and a back photo does not count as a retake', async () => {
        const { repository, userId, id } = await awaitingRetake()
        await retake(repository, id, userId, at(2 * HOUR))
        await repository.updateItem(id, 'recognising', { state: 'needs-back-photo', updatedAt: at(3 * HOUR) })
        await repository.updateItem(id, 'needs-back-photo', { state: 'reading-label', updatedAt: at(4 * HOUR) }, newUpload(id, userId, at(4 * HOUR)))

        expect(await repository.countRetakes(id)).toBe(1)
        expect(await repository.countBackPhotos(id)).toBe(1)
      })

      it('counts a retake as one more photo, at the time it was uploaded, and keeps counting it after its photo is deleted', async () => {
        const { repository, userId, id } = await awaitingRetake()
        expect((await repository.photosSince(userId, since)).count).toBe(0)

        await retake(repository, id, userId, at(2 * HOUR))
        const stored = await repository.photosSince(userId, since)
        expect(stored.count).toBe(1)
        expect(stored.oldest!.getTime()).toBe(at(2 * HOUR).getTime())

        await failAgain(repository, id, at(2 * HOUR))
        expect((await repository.photosSince(userId, since)).count).toBe(1)
      })

      it('counts every retake an item is sent: three in a row are three photos, not one', async () => {
        const { repository, userId, id } = await awaitingRetake()

        for (const hours of [1, 2, 3]) {
          expect(await retake(repository, id, userId, at(hours * HOUR))).toBe(true)
          await failAgain(repository, id, at(hours * HOUR))
        }

        const counted = await repository.photosSince(userId, since)
        expect(counted.count).toBe(3)
        expect(counted.oldest!.getTime()).toBe(at(HOUR).getTime())
      })

      it('counts a retake only from the cutoff on, inclusive', async () => {
        const { repository, userId, id } = await awaitingRetake()
        await retake(repository, id, userId, new Date(since.getTime() - 1))
        await failAgain(repository, id, new Date(since.getTime() - 1))
        await retake(repository, id, userId, since)

        const counted = await repository.photosSince(userId, since)

        expect(counted.count).toBe(1)
        expect(counted.oldest!.getTime()).toBe(since.getTime())
      })

      it('counts only that user\'s retakes', async () => {
        const { repository, newUser } = await make()
        const [mine, theirs] = [await newUser(), await newUser()]
        const [minePending, theirsPending] = [await awaitingRetakeFor(repository, mine), await awaitingRetakeFor(repository, theirs)]
        await retake(repository, minePending.id, mine, at(2 * HOUR))
        await retake(repository, theirsPending.id, theirs, at(2 * HOUR))
        await failAgain(repository, theirsPending.id, at(2 * HOUR))
        await retake(repository, theirsPending.id, theirs, at(3 * HOUR))

        expect((await repository.photosSince(mine, since)).count).toBe(1)
        expect((await repository.photosSince(theirs, since)).count).toBe(2)
      })

      it('reports the oldest over front photos, back photos and retakes together', async () => {
        const { repository, userId, id } = await awaitingRetake(at(4 * HOUR))
        await retake(repository, id, userId, at(3 * HOUR))
        await repository.updateItem(id, 'recognising', { state: 'needs-back-photo', updatedAt: at(5 * HOUR) })
        await repository.updateItem(id, 'needs-back-photo', { state: 'reading-label', updatedAt: at(6 * HOUR) }, newUpload(id, userId, at(2 * HOUR)))

        const counted = await repository.photosSince(userId, since)

        expect(counted.count).toBe(3)
        expect(counted.oldest!.getTime()).toBe(at(2 * HOUR).getTime())
        // And with the retake the oldest, it is the retake's time.
        const other = await awaitingRetake(at(4 * HOUR))
        await retake(other.repository, other.id, other.userId, at(90 * MINUTE))
        expect((await other.repository.photosSince(other.userId, since)).oldest!.getTime()).toBe(at(90 * MINUTE).getTime())
      })

      it('records a retake only when the update applies: an item in another state, or an unknown one, counts nothing', async () => {
        const { repository, userId, items } = await seeded(1, { createdAt: at(-5 * HOUR) })
        const id = items[0]!.id

        const wrongState = await retake(repository, id, userId, at(2 * HOUR))
        const unknown = await retake(repository, freshId(), userId, at(2 * HOUR))

        expect(wrongState).toBe(false)
        expect(unknown).toBe(false)
        expect((await repository.findItem(id))!.state).toBe('recognising')
        expect(await repository.countRetakes(id)).toBe(0)
        expect((await repository.photosSince(userId, since)).count).toBe(0)
      })

      it('lets exactly one of two simultaneous retakes win, and records exactly one', async () => {
        const { repository, userId, id } = await awaitingRetake()

        const results = await Promise.all([retake(repository, id, userId, at(2 * HOUR)), retake(repository, id, userId, at(2 * HOUR))])

        expect(results.filter(Boolean)).toHaveLength(1)
        expect(await repository.countRetakes(id)).toBe(1)
        expect((await repository.photosSince(userId, since)).count).toBe(1)
      })

      it('applies the patch with the retake: the item is recognising again, with no reason, no recognised fields and the new photo', async () => {
        const { repository, userId, id } = await awaitingRetake()
        await repository.updateItem(id, 'needs-retake', { state: 'needs-retake', recognisedBrand: 'Stale', recognisedName: 'Stale', recognisedCategory: 'skin', recognisedConfidence: 0.4, updatedAt: at(-3 * HOUR) })

        await repository.updateItem(
          id,
          'needs-retake',
          { state: 'recognising', reason: null, photoKey: 'photos/test/new.jpg', recognisedBrand: null, recognisedName: null, recognisedVariant: null, recognisedCategory: null, recognisedConfidence: null, updatedAt: at(2 * HOUR) },
          undefined,
          newRetake(id, userId, at(2 * HOUR)),
        )

        expect(await repository.findItem(id)).toMatchObject({
          state: 'recognising',
          reason: null,
          photoKey: 'photos/test/new.jpg',
          recognisedBrand: null,
          recognisedName: null,
          recognisedVariant: null,
          recognisedCategory: null,
          recognisedConfidence: null,
        })
      })

      it('counts a retake for the address it was uploaded from, not the one the scan was made from', async () => {
        const { repository, userId, scan, id } = await awaitingRetake()
        const uploadIp = fresh('retake-from')
        await retake(repository, id, userId, at(2 * HOUR), { ipHash: uploadIp })

        expect((await repository.photosSinceIp(uploadIp, since)).count).toBe(1)
        expect(await repository.photosSinceIp(scan.ipHash, since)).toEqual({ count: 0, oldest: null })
      })

      it('adds the retakes uploaded from the address to its count, and takes the oldest over both', async () => {
        const { repository, newUser } = await make()
        const ipHash = fresh('retake-mixed-ip')
        const [alice, bob] = [await newUser(), await newUser()]
        const a = newScan(alice, { ipHash, createdAt: at(3 * HOUR) })
        const b = newScan(bob, { createdAt: at(-5 * HOUR) })
        const [aItem, bItem] = [newItem(a, 0), newItem(b, 0)]
        await createWithPhotos(repository, a, [aItem])
        await createWithPhotos(repository, b, [bItem])
        await repository.updateItem(bItem.id, 'recognising', { state: 'needs-retake', reason: 'unreadable', photoKey: null, updatedAt: at(-4 * HOUR) })
        await retake(repository, bItem.id, bob, at(2 * HOUR), { ipHash })

        const counted = await repository.photosSinceIp(ipHash, since)

        expect(counted.count).toBe(2)
        expect(counted.oldest!.getTime()).toBe(at(2 * HOUR).getTime())
      })

      it('applies the same inclusive cutoff to the IP count of retakes', async () => {
        const { repository, userId, id } = await awaitingRetake()
        const ipHash = fresh('retake-edge-ip')
        await retake(repository, id, userId, new Date(since.getTime() - 1), { ipHash })
        await failAgain(repository, id, new Date(since.getTime() - 1))
        await retake(repository, id, userId, since, { ipHash })

        expect((await repository.photosSinceIp(ipHash, since)).count).toBe(1)
      })

      it('deleteForUsers removes those users\' retake records too, so their uploads stop counting, and keeps everybody else\'s', async () => {
        const { repository, newUser } = await make()
        const [alice, bob] = [await newUser(), await newUser()]
        const [aliceItem, bobItem] = [await awaitingRetakeFor(repository, alice), await awaitingRetakeFor(repository, bob)]
        await retake(repository, aliceItem.id, alice, at(2 * HOUR))
        await retake(repository, bobItem.id, bob, at(2 * HOUR))

        await repository.deleteForUsers([alice])

        expect(await repository.photosSince(alice, at(HOUR))).toEqual({ count: 0, oldest: null })
        expect(await repository.countRetakes(aliceItem.id)).toBe(0)
        expect((await repository.photosSince(bob, at(HOUR))).count).toBe(1)
        expect(await repository.countRetakes(bobItem.id)).toBe(1)
      })
    })

    describe('guest cleanup', () => {
      it('photoKeysForUsers lists the photo and back-photo keys of those users\' items, leaving out deleted photos and other users', async () => {
        const { repository, newUser } = await make()
        const [alice, bob, carol] = [await newUser(), await newUser(), await newUser()]
        const [a, b, c] = [newScan(alice), newScan(bob), newScan(carol)]
        const aItems = [newItem(a, 0), newItem(a, 1)]
        await createWithPhotos(repository, a, aItems)
        await createWithPhotos(repository, b, [newItem(b, 0)])
        await createWithPhotos(repository, c, [newItem(c, 0)])
        await repository.updateItem(aItems[0]!.id, 'recognising', { state: 'needs-back-photo', updatedAt: at(MINUTE) })
        await repository.updateItem(aItems[0]!.id, 'needs-back-photo', { state: 'reading-label', backPhotoKey: `photos/test/${alice}/${a.id}/back.jpg`, updatedAt: at(2 * MINUTE) }, newUpload(aItems[0]!.id, alice, at(2 * MINUTE)))
        await repository.updateItem(aItems[1]!.id, 'recognising', { state: 'rejected', reason: 'unreadable', photoKey: null, updatedAt: at(MINUTE) })

        const keys = await repository.photoKeysForUsers([alice, bob])

        expect(keys.sort()).toEqual([aItems[0]!.photoKey!, `photos/test/${alice}/${a.id}/back.jpg`, (await repository.itemsOf(b.id))[0]!.photoKey!].sort())
      })

      it('photoKeysForUsers answers nothing for no users, and for users with no scans', async () => {
        const { repository, newUser } = await make()

        expect(await repository.photoKeysForUsers([])).toEqual([])
        expect(await repository.photoKeysForUsers([await newUser()])).toEqual([])
      })

      it('deleteForUsers removes those users\' scans and items, and nobody else\'s', async () => {
        const { repository, newUser } = await make()
        const [alice, bob, carol] = [await newUser(), await newUser(), await newUser()]
        const [a, b, c] = [newScan(alice), newScan(bob), newScan(carol)]
        const [aItem, bItem, cItem] = [newItem(a, 0), newItem(b, 0), newItem(c, 0)]
        await createWithPhotos(repository, a, [aItem])
        await createWithPhotos(repository, b, [bItem])
        await createWithPhotos(repository, c, [cItem])

        await repository.deleteForUsers([alice, bob])

        expect(await repository.findScan(a.id)).toBeNull()
        expect(await repository.findScan(b.id)).toBeNull()
        expect(await repository.findItem(aItem.id)).toBeNull()
        expect(await repository.findItem(bItem.id)).toBeNull()
        expect(await repository.findScan(c.id)).not.toBeNull()
        expect(await repository.findItem(cItem.id)).not.toBeNull()
        expect(await repository.photosSince(alice, new Date(0))).toEqual({ count: 0, oldest: null })
      })

      it('deleteForUsers removes those users\' back-photo records too, so their uploads stop counting, and keeps everybody else\'s', async () => {
        const { repository, newUser } = await make()
        const [alice, bob] = [await newUser(), await newUser()]
        const [a, b] = [newScan(alice, { createdAt: at(-5 * HOUR) }), newScan(bob, { createdAt: at(-5 * HOUR) })]
        const [aItem, bItem] = [newItem(a, 0), newItem(b, 0)]
        await createWithPhotos(repository, a, [aItem])
        await createWithPhotos(repository, b, [bItem])
        for (const [item, userId] of [[aItem, alice], [bItem, bob]] as const) {
          await repository.updateItem(item.id, 'recognising', { state: 'needs-back-photo', updatedAt: at(-4 * HOUR) })
          await repository.updateItem(item.id, 'needs-back-photo', { state: 'reading-label', updatedAt: at(2 * HOUR) }, newUpload(item.id, userId, at(2 * HOUR)))
        }

        await repository.deleteForUsers([alice])

        expect(await repository.photosSince(alice, at(HOUR))).toEqual({ count: 0, oldest: null })
        expect((await repository.photosSince(bob, at(HOUR))).count).toBe(1)
      })

      it('deleteForUsers is safe to repeat, and does nothing for an empty list or for users with no scans', async () => {
        const { repository, userId, scan } = await seeded(1)

        await expect(repository.deleteForUsers([])).resolves.toBeUndefined()
        expect(await repository.findScan(scan.id)).not.toBeNull()

        await repository.deleteForUsers([userId])
        await expect(repository.deleteForUsers([userId])).resolves.toBeUndefined()
        expect(await repository.findScan(scan.id)).toBeNull()
      })
    })

    describe('markScanDone', () => {
      it('applies once: true the first time, false every time after, and keeps the first time it was set', async () => {
        const { repository, scan } = await seeded(1)

        expect(await repository.markScanDone(scan.id, at(MINUTE))).toBe(true)
        expect(await repository.markScanDone(scan.id, at(2 * MINUTE))).toBe(false)

        expect((await repository.findScan(scan.id))!.doneAt!.getTime()).toBe(at(MINUTE).getTime())
      })

      it('lets exactly one of two simultaneous calls win', async () => {
        const { repository, scan } = await seeded(1)

        const results = await Promise.all([repository.markScanDone(scan.id, at(MINUTE)), repository.markScanDone(scan.id, at(MINUTE))])

        expect(results.filter(Boolean)).toHaveLength(1)
      })

      it('says false for an unknown scan, and touches only the scan it was asked about', async () => {
        const { repository, userId, scan } = await seeded(1)
        const other = newScan(userId)
        await createWithPhotos(repository, other, [newItem(other, 0)])

        expect(await repository.markScanDone(freshId(), at(MINUTE))).toBe(false)
        expect(await repository.markScanDone(scan.id, at(MINUTE))).toBe(true)

        expect((await repository.findScan(other.id))!.doneAt).toBeNull()
      })
    })

    describe('clearScanDone', () => {
      it('takes back the done time it is given, so the scan can be marked again', async () => {
        const { repository, scan } = await seeded(1)
        await repository.markScanDone(scan.id, at(MINUTE))

        expect(await repository.clearScanDone(scan.id, at(MINUTE))).toBe(true)

        expect((await repository.findScan(scan.id))!.doneAt).toBeNull()
        expect(await repository.markScanDone(scan.id, at(2 * MINUTE))).toBe(true)
      })

      it('leaves a done time that is not the one it is given, and says false', async () => {
        const { repository, scan } = await seeded(1)
        await repository.markScanDone(scan.id, at(MINUTE))

        expect(await repository.clearScanDone(scan.id, at(2 * MINUTE))).toBe(false)

        expect((await repository.findScan(scan.id))!.doneAt!.getTime()).toBe(at(MINUTE).getTime())
      })

      it('says false for a scan with no done time and for an unknown scan', async () => {
        const { repository, scan } = await seeded(1)

        expect(await repository.clearScanDone(scan.id, at(MINUTE))).toBe(false)
        expect(await repository.clearScanDone(freshId(), at(MINUTE))).toBe(false)
      })

      it('touches only the scan it was asked about', async () => {
        const { repository, userId, scan } = await seeded(1)
        const other = newScan(userId)
        await createWithPhotos(repository, other, [newItem(other, 0)])
        await repository.markScanDone(scan.id, at(MINUTE))
        await repository.markScanDone(other.id, at(MINUTE))

        await repository.clearScanDone(scan.id, at(MINUTE))

        expect((await repository.findScan(other.id))!.doneAt!.getTime()).toBe(at(MINUTE).getTime())
      })
    })

    describe('adoptOrphanScans', () => {
      it('sets the owner\'s default profile on a scan that has none, and says how many it adopted', async () => {
        const { repository, newUserWithoutProfile, giveDefaultProfile } = await make()
        const userId = await newUserWithoutProfile()
        const profileId = await giveDefaultProfile(userId)
        const scan = orphan(userId)
        await createWithPhotos(repository, scan, [newItem(scan, 0)])
        expect((await repository.findScan(scan.id))!.profileId).toBeNull()

        const adopted = await repository.adoptOrphanScans(10)

        expect(adopted).toBe(1)
        expect((await repository.findScan(scan.id))!.profileId).toBe(profileId)
      })

      it('gives each scan its own owner\'s default, and leaves the rest of the scan as it was', async () => {
        const { repository, newUserWithoutProfile, giveDefaultProfile } = await make()
        const ada = await newUserWithoutProfile()
        const bo = await newUserWithoutProfile()
        const adaProfile = await giveDefaultProfile(ada)
        const boProfile = await giveDefaultProfile(bo)
        const adaScan = orphan(ada, { createdAt: at(MINUTE) })
        const boScan = orphan(bo)
        await createWithPhotos(repository, adaScan, [newItem(adaScan, 0)])
        await createWithPhotos(repository, boScan, [newItem(boScan, 0)])
        await repository.markScanDone(adaScan.id, at(2 * MINUTE))

        await repository.adoptOrphanScans(10)

        expect(await repository.findScan(adaScan.id)).toEqual({ ...adaScan, profileId: adaProfile, doneAt: at(2 * MINUTE) })
        expect(await repository.findScan(boScan.id)).toEqual({ ...boScan, profileId: boProfile, doneAt: null })
        expect(await repository.itemsOf(adaScan.id)).toHaveLength(1)
      })

      it('adopts to the default, not to another profile of the owner', async () => {
        const { repository, newUserWithoutProfile, giveDefaultProfile } = await make()
        const userId = await newUserWithoutProfile()
        const profileId = await giveDefaultProfile(userId)
        const scan = orphan(userId)
        await createWithPhotos(repository, scan, [newItem(scan, 0)])

        await repository.adoptOrphanScans(10)

        expect((await repository.findScan(scan.id))!.profileId).toBe(profileId)
      })

      it('leaves a scan whose owner has no default profile without one, and does not count it', async () => {
        const { repository, newUserWithoutProfile } = await make()
        const userId = await newUserWithoutProfile()
        const scan = orphan(userId)
        await createWithPhotos(repository, scan, [newItem(scan, 0)])

        expect(await repository.adoptOrphanScans(10)).toBe(0)

        expect((await repository.findScan(scan.id))!.profileId).toBeNull()
      })

      it('adopts it on a later call, once its owner has a default profile', async () => {
        const { repository, newUserWithoutProfile, giveDefaultProfile } = await make()
        const userId = await newUserWithoutProfile()
        const scan = orphan(userId)
        await createWithPhotos(repository, scan, [newItem(scan, 0)])
        await repository.adoptOrphanScans(10)

        const profileId = await giveDefaultProfile(userId)
        await repository.adoptOrphanScans(10)

        expect((await repository.findScan(scan.id))!.profileId).toBe(profileId)
      })

      it('never changes a scan that already has a profile, whatever the owner\'s default is', async () => {
        const { repository, newUserWithoutProfile, giveDefaultProfile } = await make()
        const userId = await newUserWithoutProfile()
        await giveDefaultProfile(userId)
        const scan = newScan(userId, { profileId: 'some-other-profile' })
        await createWithPhotos(repository, scan, [newItem(scan, 0)])

        await repository.adoptOrphanScans(10)

        expect((await repository.findScan(scan.id))!.profileId).toBe('some-other-profile')
      })

      it('adopts at most `limit` scans, oldest first, and the next call takes the rest', async () => {
        const { repository, newUserWithoutProfile, giveDefaultProfile } = await make()
        const userId = await newUserWithoutProfile()
        const profileId = await giveDefaultProfile(userId)
        const scans = [orphan(userId, { createdAt: at(2 * MINUTE) }), orphan(userId, { createdAt: at(0) }), orphan(userId, { createdAt: at(MINUTE) })]
        for (const scan of scans) await createWithPhotos(repository, scan, [newItem(scan, 0)])
        const profileOf = async (scan: NewScan) => (await repository.findScan(scan.id))!.profileId

        expect(await repository.adoptOrphanScans(1)).toBe(1)
        expect(await Promise.all(scans.map(profileOf))).toEqual([null, profileId, null])

        expect(await repository.adoptOrphanScans(1)).toBe(1)
        expect(await Promise.all(scans.map(profileOf))).toEqual([null, profileId, profileId])

        expect(await repository.adoptOrphanScans(1)).toBe(1)
        expect(await repository.adoptOrphanScans(1)).toBe(0)
        expect(await Promise.all(scans.map(profileOf))).toEqual([profileId, profileId, profileId])
      })

      it('counts only what it adopted: scans that cannot be adopted do not use up the limit', async () => {
        const { repository, newUserWithoutProfile, giveDefaultProfile } = await make()
        const homeless = await newUserWithoutProfile()
        const settled = await newUserWithoutProfile()
        const profileId = await giveDefaultProfile(settled)
        // The homeless user's scans are older, so a limit applied before the owner check would be spent on them.
        for (let i = 0; i < 3; i++) {
          const scan = orphan(homeless, { createdAt: at(-HOUR - i * MINUTE) })
          await createWithPhotos(repository, scan, [newItem(scan, 0)])
        }
        const wanted = orphan(settled, { createdAt: at(HOUR) })
        await createWithPhotos(repository, wanted, [newItem(wanted, 0)])

        expect(await repository.adoptOrphanScans(1)).toBe(1)

        expect((await repository.findScan(wanted.id))!.profileId).toBe(profileId)
      })

      it('says 0 and changes nothing when there is nothing to adopt', async () => {
        const { repository, newUserWithoutProfile, giveDefaultProfile } = await make()
        const userId = await newUserWithoutProfile()
        await giveDefaultProfile(userId)
        const scan = newScan(userId)
        await createWithPhotos(repository, scan, [newItem(scan, 0)])
        await repository.adoptOrphanScans(1000)

        const again = await repository.adoptOrphanScans(1000)

        expect(again).toBe(0)
        expect((await repository.findScan(scan.id))!.profileId).toBe(scan.profileId)
      })
    })

    // A front photo is held only while an item using it is recognising or waiting for a confirmation; these reads find the keys the
    // service missed releasing, and the guarded clears are how it lets go of one.
    describe('photos to release', () => {
      const HELD: ItemState[] = ['recognising', 'needs-confirmation']
      const RELEASABLE: ItemState[] = ['matching', 'researching', 'needs-back-photo', 'reading-label', 'analysing', 'ready', 'failed', 'rejected', 'unidentified']
      const freshUser = async () => {
        const { repository, newUser } = await make()
        return { repository, userId: await newUser() }
      }
      /** One product item per entry, each moved to its state at its time (a state of `recognising` is left as made); returns their ids in order. */
      const productItemsIn = async (repository: ScansRepository, userId: string, wanted: [ItemState, number][]) => {
        const scan = newScan(userId, { createdAt: at(-DAY_MS) })
        const items = wanted.map((_, position) => newItem(scan, position))
        await createWithPhotos(repository, scan, items)
        for (const [i, [state, updatedAt]] of wanted.entries()) {
          if (state !== 'recognising') await repository.updateItem(items[i]!.id, 'recognising', { state, updatedAt: at(updatedAt) })
        }
        return items.map((i) => i.id)
      }
      /**
       * A shelf photo with its placeholder in `states[0]` and one more item per further state, filed the way a read files them (one fanOut);
       * a state a read cannot file (ready, failed, ...) is reached by a later move of that item.
       */
      const shelfPhotoIn = async (repository: ScansRepository, userId: string, states: ItemState[]) => {
        const scan = newScan(userId, { kind: 'shelf', createdAt: at(-DAY_MS) })
        const photo = newPhoto(scan, 0, { photoKey: `photos/test/${userId}/${scan.id}/${freshId()}.jpg` })
        const placeholder = newItem(scan, 0, { photoId: photo.id, photoKey: null })
        await repository.createScan(scan, [photo], [placeholder])
        const readState = (state: ItemState) => (state === 'needs-confirmation' ? 'needs-confirmation' : 'matching')
        const siblings = states.slice(1).map((state, i) => newSibling(scan, photo, 1 + i, { state: readState(state) }))
        await repository.fanOut({
          photo: { id: photo.id, patch: readPhoto() },
          placeholder: { id: placeholder.id, from: 'recognising', patch: { state: readState(states[0]!), updatedAt: at(-HOUR) } },
          siblings,
          maxItems: 20,
        })
        const ids = [placeholder.id, ...siblings.map((s) => s.id)]
        for (const [i, state] of states.entries()) {
          const read = readState(state)
          if (state !== read) await repository.updateItem(ids[i]!, read, { state, updatedAt: at(-HOUR) })
        }
        return { photo, key: photo.photoKey!, ids }
      }
      const DAY_MS = 24 * HOUR

      describe('itemsWithReleasablePhoto', () => {
        it.each(RELEASABLE)('lists an item in %s that still has its photo key', async (state) => {
          const { repository, userId } = await freshUser()
          const [id] = await productItemsIn(repository, userId, [[state, -MINUTE]])

          const listed = await repository.itemsWithReleasablePhoto(1000)

          expect(listed.find((i) => i.id === id)).toMatchObject({ id, state, userId, photoKey: expect.any(String) })
        })

        it.each(HELD)('leaves out an item in %s: its photo is still wanted', async (state) => {
          const { repository, userId } = await freshUser()
          const [id] = await productItemsIn(repository, userId, [[state, -MINUTE]])

          expect((await repository.itemsWithReleasablePhoto(1000)).map((i) => i.id)).not.toContain(id)
        })

        it('leaves out an item whose key is already cleared, and a shelf item, which never has a key of its own', async () => {
          const { repository, userId } = await freshUser()
          const [cleared] = await productItemsIn(repository, userId, [['matching', -MINUTE]])
          await repository.clearItemPhotoKey(cleared!, (await repository.findItem(cleared!))!.photoKey!)
          const shelf = await shelfPhotoIn(repository, userId, ['matching', 'matching'])

          const ids = (await repository.itemsWithReleasablePhoto(1000)).map((i) => i.id)

          expect(ids).not.toContain(cleared)
          for (const id of shelf.ids) expect(ids).not.toContain(id)
        })

        it('returns at most the limit, in the same order as the unlimited read', async () => {
          const { repository, userId } = await freshUser()
          await productItemsIn(repository, userId, [['matching', -3 * HOUR], ['ready', -2 * HOUR], ['failed', -HOUR]])
          const everything = (await repository.itemsWithReleasablePhoto(1000)).map((i) => i.id)

          const limited = await repository.itemsWithReleasablePhoto(2)

          expect(limited).toHaveLength(2)
          expect(limited.map((i) => i.id)).toEqual(everything.slice(0, 2))
        })
      })

      describe('clearItemPhotoKey', () => {
        it('clears the key when it is the one given, says so, and changes nothing else about the item, its update time included', async () => {
          const { repository, userId } = await freshUser()
          const [id] = await productItemsIn(repository, userId, [['matching', -MINUTE]])
          const before = (await repository.findItem(id!))!

          const cleared = await repository.clearItemPhotoKey(id!, before.photoKey!)

          expect(cleared).toBe(true)
          expect(await repository.findItem(id!)).toEqual({ ...before, photoKey: null })
        })

        it('leaves the key, and says so, when the item holds a different one (a retake replaced it)', async () => {
          const { repository, userId } = await freshUser()
          const [id] = await productItemsIn(repository, userId, [['matching', -MINUTE]])
          const before = (await repository.findItem(id!))!

          expect(await repository.clearItemPhotoKey(id!, `${before.photoKey}.other`)).toBe(false)

          expect(await repository.findItem(id!)).toEqual(before)
        })

        it('answers false when repeated, and for an unknown item', async () => {
          const { repository, userId } = await freshUser()
          const [id] = await productItemsIn(repository, userId, [['matching', -MINUTE]])
          const key = (await repository.findItem(id!))!.photoKey!
          await repository.clearItemPhotoKey(id!, key)

          expect(await repository.clearItemPhotoKey(id!, key)).toBe(false)
          expect(await repository.clearItemPhotoKey(freshId(), key)).toBe(false)
        })
      })

      describe('shelfPhotosToRelease', () => {
        it.each([
          ['one matching item', ['matching']],
          ['a run of items that are all past waiting', ['matching', 'ready', 'failed']],
        ] as [string, ItemState[]][])('lists a photo whose items are %s', async (_label, states) => {
          const { repository, userId } = await freshUser()
          const { photo, key } = await shelfPhotoIn(repository, userId, states)

          const listed = await repository.shelfPhotosToRelease(1000)

          expect(listed.find((p) => p.id === photo.id)).toMatchObject({ id: photo.id, userId, photoKey: key })
        })

        it('leaves out a photo while any one of its items waits for a confirmation, whatever the others are doing', async () => {
          const { repository, userId } = await freshUser()
          const { photo } = await shelfPhotoIn(repository, userId, ['matching', 'needs-confirmation', 'ready'])

          expect((await repository.shelfPhotosToRelease(1000)).map((p) => p.id)).not.toContain(photo.id)
        })

        it('leaves out a photo whose placeholder is still recognising', async () => {
          const { repository, userId } = await freshUser()
          const scan = newScan(userId, { kind: 'shelf' })
          const photo = newPhoto(scan, 0, { photoKey: `photos/test/${userId}/${scan.id}/${freshId()}.jpg` })
          await repository.createScan(scan, [photo], [newItem(scan, 0, { photoId: photo.id, photoKey: null })])

          expect((await repository.shelfPhotosToRelease(1000)).map((p) => p.id)).not.toContain(photo.id)
        })

        it('is held by an item of the same photo only: another photo of the scan that is done is listed on its own', async () => {
          const { repository, userId } = await freshUser()
          const scan = newScan(userId, { kind: 'shelf' })
          const [done, waiting] = [newPhoto(scan, 0, { photoKey: `photos/test/${userId}/${scan.id}/${freshId()}.jpg` }), newPhoto(scan, 1, { photoKey: `photos/test/${userId}/${scan.id}/${freshId()}.jpg` })]
          const items = [newItem(scan, 0, { photoId: done.id, photoKey: null }), newItem(scan, 5, { photoId: waiting.id, photoKey: null })]
          await repository.createScan(scan, [done, waiting], items)
          await repository.updateItem(items[0]!.id, 'recognising', { state: 'matching', updatedAt: at(MINUTE) })
          await repository.updateItem(items[1]!.id, 'recognising', { state: 'needs-confirmation', updatedAt: at(MINUTE) })

          const ids = (await repository.shelfPhotosToRelease(1000)).map((p) => p.id)

          expect(ids).toContain(done.id)
          expect(ids).not.toContain(waiting.id)
        })

        it('leaves out a photo with no key, which is every product photo', async () => {
          const { repository, userId } = await freshUser()
          const scan = newScan(userId)
          const items = [newItem(scan, 0)]
          await createWithPhotos(repository, scan, items)
          await repository.updateItem(items[0]!.id, 'recognising', { state: 'matching', updatedAt: at(MINUTE) })

          expect((await repository.shelfPhotosToRelease(1000)).map((p) => p.id)).not.toContain(items[0]!.photoId)
        })

        it('leaves out a photo whose key is already cleared', async () => {
          const { repository, userId } = await freshUser()
          const { photo, key } = await shelfPhotoIn(repository, userId, ['matching'])
          await repository.clearShelfPhotoKey(photo.id, key)

          expect((await repository.shelfPhotosToRelease(1000)).map((p) => p.id)).not.toContain(photo.id)
        })

        it('returns at most the limit, in the same order as the unlimited read', async () => {
          const { repository, userId } = await freshUser()
          await shelfPhotoIn(repository, userId, ['matching'])
          await shelfPhotoIn(repository, userId, ['ready'])
          await shelfPhotoIn(repository, userId, ['failed'])
          const everything = (await repository.shelfPhotosToRelease(1000)).map((p) => p.id)

          const limited = await repository.shelfPhotosToRelease(2)

          expect(limited).toHaveLength(2)
          expect(limited.map((p) => p.id)).toEqual(everything.slice(0, 2))
        })
      })

      describe('clearShelfPhotoKey', () => {
        it('clears the key when it is the one given, says so, and changes nothing else about the photo, its update time included', async () => {
          const { repository, userId } = await freshUser()
          const { photo, key } = await shelfPhotoIn(repository, userId, ['matching'])
          const before = (await repository.findPhoto(photo.id))!

          expect(await repository.clearShelfPhotoKey(photo.id, key)).toBe(true)

          expect(await repository.findPhoto(photo.id)).toEqual({ ...before, photoKey: null })
        })

        it('leaves the key, and says so, when the photo holds a different one', async () => {
          const { repository, userId } = await freshUser()
          const { photo, key } = await shelfPhotoIn(repository, userId, ['matching'])
          const before = (await repository.findPhoto(photo.id))!

          expect(await repository.clearShelfPhotoKey(photo.id, `${key}.other`)).toBe(false)

          expect(await repository.findPhoto(photo.id)).toEqual(before)
        })

        it('answers false when repeated, and for an unknown photo', async () => {
          const { repository, userId } = await freshUser()
          const { photo, key } = await shelfPhotoIn(repository, userId, ['matching'])
          await repository.clearShelfPhotoKey(photo.id, key)

          expect(await repository.clearShelfPhotoKey(photo.id, key)).toBe(false)
          expect(await repository.clearShelfPhotoKey(freshId(), key)).toBe(false)
        })
      })
    })

    describe('staleItems', () => {
      const WORKING: ItemState[] = ['recognising', 'matching']

      /** One item per entry, each moved to its state at its time; returns their ids in the same order. */
      const itemsIn = async (repository: ScansRepository, userId: string, wanted: [ItemState, number][]) => {
        const scan = newScan(userId, { createdAt: at(-DAY_MS) })
        const items = wanted.map((_, position) => newItem(scan, position))
        await createWithPhotos(repository, scan, items)
        for (const [i, [state, updatedAt]] of wanted.entries()) await repository.updateItem(items[i]!.id, 'recognising', { state, updatedAt: at(updatedAt) })
        return items.map((i) => i.id)
      }
      const DAY_MS = 24 * HOUR
      const freshUser = async () => {
        const { repository, newUser } = await make()
        return { repository, userId: await newUser() }
      }

      it('lists the items in the given states last updated before the cutoff, oldest first', async () => {
        const { repository, userId } = await freshUser()
        const [newest, oldest, middle] = await itemsIn(repository, userId, [['matching', -10 * MINUTE], ['recognising', -50 * MINUTE], ['matching', -30 * MINUTE]])

        const stale = await repository.staleItems(WORKING, at(0), 100)

        expect(stale.map((i) => i.id).filter((id) => [newest, oldest, middle].includes(id))).toEqual([oldest, middle, newest])
      })

      it('leaves out items in other states, and items updated at the cutoff or later', async () => {
        const { repository, userId } = await freshUser()
        const [atCutoff, after, otherState, justBefore] = await itemsIn(repository, userId, [
          ['matching', 0],
          ['matching', MINUTE],
          ['needs-back-photo', -HOUR],
          ['matching', -1],
        ])

        const ids = (await repository.staleItems(WORKING, at(0), 100)).map((i) => i.id)

        expect(ids).toContain(justBefore)
        expect(ids).not.toContain(atCutoff)
        expect(ids).not.toContain(after)
        expect(ids).not.toContain(otherState)
      })

      it('returns whole items, and at most the limit, taking the oldest', async () => {
        const { repository, userId } = await freshUser()
        const [a, b, c] = await itemsIn(repository, userId, [['matching', -3 * HOUR], ['matching', -2 * HOUR], ['matching', -HOUR]])
        const everything = await repository.staleItems(['matching'], at(0), 1000)
        const oldestFirst = everything.map((i) => i.id)

        const limited = await repository.staleItems(['matching'], at(0), 2)

        expect(limited).toHaveLength(2)
        expect(limited.map((i) => i.id)).toEqual(oldestFirst.slice(0, 2))
        expect(everything.find((i) => i.id === c)).toMatchObject({ id: c, state: 'matching', userId })
        expect([a!, b!, c!].every((id) => oldestFirst.includes(id))).toBe(true)
      })

      it('answers nothing for no states', async () => {
        const { repository } = await seeded(1)

        expect(await repository.staleItems([], at(HOUR), 100)).toEqual([])
      })
    })

    describe('settledScansNotDone', () => {
      const FINAL: ItemState[] = ['ready', 'rejected', 'failed', 'unidentified']
      // Far enough back to take in every scan these tests make, so only the test about the bound narrows it.
      const LONG_AGO = at(-30 * 24 * HOUR)
      const freshUser = async () => {
        const { repository, newUser } = await make()
        return { repository, userId: await newUser() }
      }
      /** A scan with one item per entry, each moved to its state at its time; returns the scan's id. */
      const scanWith = async (repository: ScansRepository, userId: string, entries: [ItemState, number][], scanOver: Partial<NewScan> = {}) => {
        const scan = newScan(userId, { createdAt: at(-24 * HOUR), ...scanOver })
        const items = entries.map((_, position) => newItem(scan, position))
        await createWithPhotos(repository, scan, items)
        for (const [i, [state, updatedAt]] of entries.entries()) await repository.updateItem(items[i]!.id, 'recognising', { state, updatedAt: at(updatedAt) })
        return scan.id
      }
      const listed = async (repository: ScansRepository, ids: string[], limit = 1000) =>
        (await repository.settledScansNotDone(FINAL, at(0), LONG_AGO, limit)).map((s) => s.id).filter((id) => ids.includes(id))

      it('lists a scan with no done time whose items are all final and were all last updated before the cutoff', async () => {
        const { repository, userId } = await freshUser()
        const settled = await scanWith(repository, userId, [['ready', -10 * MINUTE], ['rejected', -20 * MINUTE], ['failed', -30 * MINUTE]])

        const found = await repository.settledScansNotDone(FINAL, at(0), LONG_AGO, 1000)

        expect(found.find((s) => s.id === settled)).toMatchObject({ id: settled, userId, doneAt: null })
      })

      it('lists a scan whose items are all final when one of them is unidentified', async () => {
        const { repository, userId } = await freshUser()
        const settled = await scanWith(repository, userId, [['unidentified', -HOUR], ['ready', -HOUR]])
        const only = await scanWith(repository, userId, [['unidentified', -HOUR]])

        expect(await listed(repository, [settled, only])).toEqual([settled, only])
      })

      it('leaves out a scan with an item that is not final, even if the others are', async () => {
        const { repository, userId } = await freshUser()
        const working = await scanWith(repository, userId, [['ready', -HOUR], ['matching', -HOUR]])
        const waiting = await scanWith(repository, userId, [['ready', -HOUR], ['needs-confirmation', -HOUR]])

        expect(await listed(repository, [working, waiting])).toEqual([])
      })

      it('leaves out a scan with an item updated at the cutoff or later', async () => {
        const { repository, userId } = await freshUser()
        const atCutoff = await scanWith(repository, userId, [['ready', -HOUR], ['ready', 0]])
        const after = await scanWith(repository, userId, [['ready', MINUTE]])
        const justBefore = await scanWith(repository, userId, [['ready', -1]])

        expect(await listed(repository, [atCutoff, after, justBefore])).toEqual([justBefore])
      })

      it('leaves out a scan that has a done time, and lists it again if it never had one', async () => {
        const { repository, userId } = await freshUser()
        const marked = await scanWith(repository, userId, [['ready', -HOUR]])
        const unmarked = await scanWith(repository, userId, [['ready', -HOUR]])
        await repository.markScanDone(marked, at(-30 * MINUTE))

        expect(await listed(repository, [marked, unmarked])).toEqual([unmarked])
      })

      it('lists the oldest scans first, at most the limit', async () => {
        const { repository, userId } = await freshUser()
        const newest = await scanWith(repository, userId, [['ready', -HOUR]], { createdAt: at(-2 * HOUR) })
        const oldest = await scanWith(repository, userId, [['ready', -HOUR]], { createdAt: at(-6 * HOUR) })
        const middle = await scanWith(repository, userId, [['ready', -HOUR]], { createdAt: at(-4 * HOUR) })

        expect(await listed(repository, [newest, oldest, middle])).toEqual([oldest, middle, newest])
        const all = (await repository.settledScansNotDone(FINAL, at(0), LONG_AGO, 1000)).map((s) => s.id)
        expect((await repository.settledScansNotDone(FINAL, at(0), LONG_AGO, 2)).map((s) => s.id)).toEqual(all.slice(0, 2))
      })

      it('leaves out a scan created before the given time, and lists one created at it', async () => {
        const { repository, userId } = await freshUser()
        const before = await scanWith(repository, userId, [['ready', -HOUR]], { createdAt: at(-3 * HOUR - 1) })
        const atBound = await scanWith(repository, userId, [['ready', -HOUR]], { createdAt: at(-3 * HOUR) })
        const after = await scanWith(repository, userId, [['ready', -HOUR]], { createdAt: at(-HOUR) })

        const found = (await repository.settledScansNotDone(FINAL, at(0), at(-3 * HOUR), 1000)).map((s) => s.id)

        expect(found.filter((id) => [before, atBound, after].includes(id))).toEqual([atBound, after])
      })

      it('answers nothing for no states', async () => {
        const { repository, userId } = await freshUser()
        await scanWith(repository, userId, [['ready', -HOUR]])

        expect(await repository.settledScansNotDone([], at(0), LONG_AGO, 100)).toEqual([])
      })
    })
  })
}
