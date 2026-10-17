import { describe, expect, it } from 'vitest'
import type { ScansRepository } from './scans.repository'
import type { ItemState, NewBackPhoto, NewRetake, NewScan, NewScanItem } from './scans.types'

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
 */
export type ScansContractSetup = {
  repository: ScansRepository
  newUser: () => Promise<string>
  newUserWithoutProfile: () => Promise<string>
  giveDefaultProfile: (userId: string) => Promise<string>
}

// scans.profile_id has no foreign key (profiles die with their user, and the user's scans with it), so any id will do.
const newScan = (userId: string, over: Partial<NewScan> = {}): NewScan => ({ id: freshId(), userId, profileId: freshId(), ipHash: fresh('iphash'), createdAt: BASE, ...over })

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
  photoKey: `photos/test/${scan.userId}/${scan.id}/${position}.jpg`,
  createdAt: scan.createdAt,
  ...over,
})

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
      await repository.createScan(scan, items)
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
        await repository.createScan(a, [newItem(a, 0)])
        await repository.createScan(b, [newItem(b, 0)])

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
          state: 'recognising',
          reason: null,
          photoKey: items[0]!.photoKey,
          backPhotoKey: null,
          recognisedBrand: null,
          recognisedName: null,
          recognisedVariant: null,
          recognisedCategory: null,
          recognisedConfidence: null,
          productId: null,
          formulationId: null,
        })
        expect(item!.createdAt.getTime()).toBe(at(3 * MINUTE).getTime())
        expect(item!.updatedAt.getTime()).toBe(at(3 * MINUTE).getTime())
      })

      it('itemsOf returns the scan\'s items in position order, whatever order they were given in', async () => {
        const { repository, newUser } = await make()
        const scan = newScan(await newUser())
        const [first, second, third] = [newItem(scan, 0), newItem(scan, 1), newItem(scan, 2)]
        await repository.createScan(scan, [third!, first!, second!])

        const items = await repository.itemsOf(scan.id)

        expect(items.map((i) => i.id)).toEqual([first!.id, second!.id, third!.id])
        expect(items.map((i) => i.position)).toEqual([0, 1, 2])
      })

      it('itemsOf holds only that scan\'s items', async () => {
        const { repository, userId, scan, items } = await seeded(2)
        const other = newScan(userId)
        await repository.createScan(other, [newItem(other, 0)])

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

        await expect(repository.createScan(scan, [good, clash])).rejects.toThrow()

        expect(await repository.findScan(scan.id)).toBeNull()
        expect(await repository.findItem(good.id)).toBeNull()
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

    describe('photo counts for the daily quotas', () => {
      const since = at(HOUR)

      it('counts one photo per item created at or after the cutoff, and not one made a millisecond before it', async () => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const before = newScan(userId, { createdAt: new Date(since.getTime() - 1) })
        const exactly = newScan(userId, { createdAt: since })
        await repository.createScan(before, [newItem(before, 0), newItem(before, 1)])
        await repository.createScan(exactly, [newItem(exactly, 0), newItem(exactly, 1), newItem(exactly, 2)])

        const counted = await repository.photosSince(userId, since)

        expect(counted.count).toBe(3)
        expect(counted.oldest!.getTime()).toBe(since.getTime())
      })

      it('says none, with no oldest time, for a user with no photos in the window', async () => {
        const { repository, newUser } = await make()

        expect(await repository.photosSince(await newUser(), since)).toEqual({ count: 0, oldest: null })
      })

      it('counts only that user\'s photos, and reports the oldest of those in the window', async () => {
        const { repository, newUser } = await make()
        const [alice, bob] = [await newUser(), await newUser()]
        const [a1, a2, b1] = [newScan(alice, { createdAt: at(3 * HOUR) }), newScan(alice, { createdAt: at(2 * HOUR) }), newScan(bob, { createdAt: at(HOUR) })]
        await repository.createScan(a1, [newItem(a1, 0)])
        await repository.createScan(a2, [newItem(a2, 0), newItem(a2, 1)])
        await repository.createScan(b1, [newItem(b1, 0)])

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
        await repository.createScan(a, [newItem(a, 0), newItem(a, 1)])
        await repository.createScan(b, [newItem(b, 0)])
        await repository.createScan(c, [newItem(c, 0)])

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
        await repository.createScan(a, [aItem])
        await repository.createScan(b, [bItem])
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
          await repository.createScan(old, [newItem(old, 0)])
        }
        const recent = newScan(userId, { ipHash, createdAt: at(2 * HOUR) })
        await repository.createScan(recent, [newItem(recent, 0)])

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
        await repository.createScan(before, [newItem(before, 0)])
        await repository.createScan(exactly, [newItem(exactly, 0)])

        expect((await repository.photosSinceIp(ipHash, since)).count).toBe(1)
      })
    })

    describe('countBackPhotos', () => {
      it('counts the back photos recorded for that item only, and answers 0 for an item with none', async () => {
        const { repository, newUser } = await make()
        const userId = await newUser()
        const scan = newScan(userId)
        const [first, second] = [newItem(scan, 0), newItem(scan, 1)]
        await repository.createScan(scan, [first, second])
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
        await repository.createScan(scan, [item])
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
        await repository.createScan(scan, [first, second])
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
        await repository.createScan(a, [aItem])
        await repository.createScan(b, [bItem])
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
        await repository.createScan(a, aItems)
        await repository.createScan(b, [newItem(b, 0)])
        await repository.createScan(c, [newItem(c, 0)])
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
        await repository.createScan(a, [aItem])
        await repository.createScan(b, [bItem])
        await repository.createScan(c, [cItem])

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
        await repository.createScan(a, [aItem])
        await repository.createScan(b, [bItem])
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
        await repository.createScan(other, [newItem(other, 0)])

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
        await repository.createScan(other, [newItem(other, 0)])
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
        await repository.createScan(scan, [newItem(scan, 0)])
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
        await repository.createScan(adaScan, [newItem(adaScan, 0)])
        await repository.createScan(boScan, [newItem(boScan, 0)])
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
        await repository.createScan(scan, [newItem(scan, 0)])

        await repository.adoptOrphanScans(10)

        expect((await repository.findScan(scan.id))!.profileId).toBe(profileId)
      })

      it('leaves a scan whose owner has no default profile without one, and does not count it', async () => {
        const { repository, newUserWithoutProfile } = await make()
        const userId = await newUserWithoutProfile()
        const scan = orphan(userId)
        await repository.createScan(scan, [newItem(scan, 0)])

        expect(await repository.adoptOrphanScans(10)).toBe(0)

        expect((await repository.findScan(scan.id))!.profileId).toBeNull()
      })

      it('adopts it on a later call, once its owner has a default profile', async () => {
        const { repository, newUserWithoutProfile, giveDefaultProfile } = await make()
        const userId = await newUserWithoutProfile()
        const scan = orphan(userId)
        await repository.createScan(scan, [newItem(scan, 0)])
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
        await repository.createScan(scan, [newItem(scan, 0)])

        await repository.adoptOrphanScans(10)

        expect((await repository.findScan(scan.id))!.profileId).toBe('some-other-profile')
      })

      it('adopts at most `limit` scans, oldest first, and the next call takes the rest', async () => {
        const { repository, newUserWithoutProfile, giveDefaultProfile } = await make()
        const userId = await newUserWithoutProfile()
        const profileId = await giveDefaultProfile(userId)
        const scans = [orphan(userId, { createdAt: at(2 * MINUTE) }), orphan(userId, { createdAt: at(0) }), orphan(userId, { createdAt: at(MINUTE) })]
        for (const scan of scans) await repository.createScan(scan, [newItem(scan, 0)])
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
          await repository.createScan(scan, [newItem(scan, 0)])
        }
        const wanted = orphan(settled, { createdAt: at(HOUR) })
        await repository.createScan(wanted, [newItem(wanted, 0)])

        expect(await repository.adoptOrphanScans(1)).toBe(1)

        expect((await repository.findScan(wanted.id))!.profileId).toBe(profileId)
      })

      it('says 0 and changes nothing when there is nothing to adopt', async () => {
        const { repository, newUserWithoutProfile, giveDefaultProfile } = await make()
        const userId = await newUserWithoutProfile()
        await giveDefaultProfile(userId)
        const scan = newScan(userId)
        await repository.createScan(scan, [newItem(scan, 0)])
        await repository.adoptOrphanScans(1000)

        const again = await repository.adoptOrphanScans(1000)

        expect(again).toBe(0)
        expect((await repository.findScan(scan.id))!.profileId).toBe(scan.profileId)
      })
    })

    describe('staleItems', () => {
      const WORKING: ItemState[] = ['recognising', 'matching']

      /** One item per entry, each moved to its state at its time; returns their ids in the same order. */
      const itemsIn = async (repository: ScansRepository, userId: string, wanted: [ItemState, number][]) => {
        const scan = newScan(userId, { createdAt: at(-DAY_MS) })
        const items = wanted.map((_, position) => newItem(scan, position))
        await repository.createScan(scan, items)
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
      const FINAL: ItemState[] = ['ready', 'rejected', 'failed']
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
        await repository.createScan(scan, items)
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
