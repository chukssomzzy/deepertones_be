import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import { FakeShelfStore } from '../shelf/shelf.store.fake'
import type { ScansRepository } from './scans.repository'
import { PHOTO_HELD_STATES } from './scans.types'
import type { ItemPatch, ItemState, NewBackPhoto, NewRetake, NewScan, NewScanItem, NewScanPhoto, NewSibling, PhotoPatch, Scan, ScanItem, ScanPhoto } from './scans.types'

const copyItem = (item: ScanItem): ScanItem => ({ ...item })
const isHeld = (state: ItemState) => PHOTO_HELD_STATES.includes(state)

/**
 * In-memory ScansRepository for unit tests. Its behaviour is pinned by scansRepositoryContract, which the D1 class also
 * passes: the doc comments below say what each method promises, and the D1 class must keep the same promises.
 */
export class FakeScansRepository implements ScansRepository {
  private scans = new Map<string, Scan>()
  private photos = new Map<string, ScanPhoto>()
  private items = new Map<string, ScanItem>()
  private backPhotos = new Map<string, NewBackPhoto>()
  private retakes = new Map<string, NewRetake>()
  private readonly profiles: FakeProfilesRepository
  private readonly knowsProfiles: boolean
  private readonly shelf: FakeShelfStore

  /**
   * Pass the fake profiles repository a test writes defaults into: `adoptOrphanScans` reads each owner's default from it, as D1 reads the profiles table.
   * `shelf` is the store the shelf rows go into, to share with a reader. A shelf row needs its profile to exist, as D1's join does: when no
   * profiles repository is given (tests that never create profiles) any profile id on a scan counts as existing.
   */
  constructor(options: { profiles?: FakeProfilesRepository; shelf?: FakeShelfStore } = {}) {
    this.profiles = options.profiles ?? new FakeProfilesRepository()
    this.knowsProfiles = options.profiles !== undefined
    this.shelf = options.shelf ?? new FakeShelfStore()
  }

  /**
   * Stores the scan, its photos and all its items, or nothing. Every photo starts `recognising` with no recognition and nothing
   * skipped, with `updatedAt` equal to `createdAt`. Every item starts `recognising` with no reason, no recognised
   * fields, no product, no back photo, and `updatedAt` equal to `createdAt`. Rejects (storing nothing) if any id is taken, or two photos or two items of the
   * scan share a position, as D1's unique indexes do.
   */
  async createScan(scan: NewScan, photos: NewScanPhoto[], items: NewScanItem[]): Promise<void> {
    const ids = items.map((i) => i.id)
    const photoIds = photos.map((p) => p.id)
    if (
      this.scans.has(scan.id) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => this.items.has(id)) ||
      new Set(photoIds).size !== photoIds.length ||
      photoIds.some((id) => this.photos.has(id)) ||
      new Set(photos.map((p) => p.position)).size !== photos.length ||
      new Set(items.map((i) => i.position)).size !== items.length
    ) {
      throw new Error('duplicate id')
    }
    this.scans.set(scan.id, { ...scan, doneAt: null })
    for (const photo of photos) {
      this.photos.set(photo.id, {
        ...photo,
        state: 'recognising',
        recognition: null,
        skippedNotBeauty: 0,
        skippedUnreadable: 0,
        skippedOverLimit: 0,
        skippedDailyLimit: 0,
        updatedAt: photo.createdAt,
      })
    }
    for (const item of items) {
      this.items.set(item.id, {
        ...item,
        state: 'recognising',
        reason: null,
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
        updatedAt: item.createdAt,
      })
    }
  }

  /** The scan's photos in position order. */
  async photosOf(scanId: string): Promise<ScanPhoto[]> {
    return [...this.photos.values()]
      .filter((p) => p.scanId === scanId)
      .sort((a, b) => a.position - b.position)
      .map((p) => ({ ...p }))
  }

  async findPhoto(photoId: string): Promise<ScanPhoto | null> {
    const photo = this.photos.get(photoId)
    return photo ? { ...photo } : null
  }

  async findScan(scanId: string): Promise<Scan | null> {
    const scan = this.scans.get(scanId)
    return scan ? { ...scan } : null
  }

  /** The scan's items in position order. */
  async itemsOf(scanId: string): Promise<ScanItem[]> {
    return [...this.items.values()]
      .filter((i) => i.scanId === scanId)
      .sort((a, b) => a.position - b.position)
      .map(copyItem)
  }

  async findItem(itemId: string): Promise<ScanItem | null> {
    const item = this.items.get(itemId)
    return item ? copyItem(item) : null
  }

  /**
   * Applies the patch only while the item is still in the `expected` state, and says whether it did. A field the patch
   * leaves out is unchanged; one it sets to null is cleared. Nothing changes when the state differs or the item is unknown.
   * `backPhoto` is the upload this move records for the daily quotas: stored together with the patch when it applies, and
   * not at all when it does not. `retake` is the same for a retaken front photo.
   *
   * A move into `ready` or `unidentified` also shelves the item, as D1 does in the same batch: it throws, changing nothing, when the patch has no
   * `updatedAt`; a `ready` product row for the profile and product is updated to this item (latest wins, a removed row is restored, `added_at`
   * stays), a `ready` item with no product is not shelved, and an `unidentified` item gets one no-label row. Nothing is shelved when the scan
   * has no profile or the profile does not exist.
   */
  async updateItem(itemId: string, expected: ItemState, patch: ItemPatch, backPhoto?: NewBackPhoto, retake?: NewRetake): Promise<boolean> {
    const shelved = patch.state === 'ready' || patch.state === 'unidentified' ? patch.state : null
    if (shelved && !patch.updatedAt) throw new Error('updatedAt is required when an item moves into ready or unidentified')
    const item = this.items.get(itemId)
    if (!item || item.state !== expected) return false
    this.apply(item, patch)
    if (shelved) await this.shelve(item, shelved)
    if (backPhoto) this.backPhotos.set(backPhoto.id, { ...backPhoto })
    if (retake) this.retakes.set(retake.id, { ...retake })
    return true
  }

  /** Stores the answer on the photo only while it is `recognising` and holds none, and says whether it did: of any number of callers exactly one wins. */
  async storeRecognition(photoId: string, recognition: string, at: Date): Promise<boolean> {
    const photo = this.photos.get(photoId)
    if (!photo || photo.state !== 'recognising' || photo.recognition !== null) return false
    photo.recognition = recognition
    photo.updatedAt = at
    return true
  }

  /**
   * Files what reading a shelf photo found, all or nothing (the whole call is checked before anything is changed). The photo's patch applies
   * only while the photo is `recognising`. Each sibling is stored, in list order, only while the scan holds fewer than `maxItems` items and
   * no item holds its position (no error otherwise, even if its id is taken too); a stored sibling at a free position whose id is taken rejects the whole call, as D1's primary key does.
   * The placeholder moves out of `from` as `updateItem` does, whatever became of the siblings, and the result says whether it did.
   */
  async fanOut(input: {
    photo: { id: string; patch: PhotoPatch }
    placeholder: { id: string; from: ItemState; patch: ItemPatch }
    siblings: NewSibling[]
    maxItems: number
  }): Promise<{ placeholderMoved: boolean }> {
    const { photo, placeholder, siblings, maxItems } = input
    const added = new Map<string, ScanItem>()
    const held = new Map([...this.items.values()].map((i) => [`${i.scanId}:${i.position}`, i]))
    const counts = new Map<string, number>()
    for (const item of this.items.values()) counts.set(item.scanId, (counts.get(item.scanId) ?? 0) + 1)
    for (const sibling of siblings) {
      const slot = `${sibling.scanId}:${sibling.position}`
      const count = counts.get(sibling.scanId) ?? 0
      if (count >= maxItems) continue
      // The slot first, as SQLite checks the ON CONFLICT target before the primary key: a clash on both is skipped, not an error.
      if (held.has(slot)) continue
      if (this.items.has(sibling.id) || added.has(sibling.id)) throw new Error('duplicate id')
      const stored: ScanItem = {
        ...sibling,
        reason: null,
        backPhotoKey: null,
        productId: null,
        formulationId: null,
        noLabelSource: null,
        noLabelPurpose: null,
        noLabelUsedFor: null,
        noLabelDescription: null,
        updatedAt: sibling.createdAt,
      }
      added.set(sibling.id, stored)
      held.set(slot, stored)
      counts.set(sibling.scanId, count + 1)
    }

    const storedPhoto = this.photos.get(photo.id)
    if (storedPhoto?.state === 'recognising') this.apply(storedPhoto, photo.patch)
    for (const [id, item] of added) this.items.set(id, item)
    return { placeholderMoved: await this.updateItem(placeholder.id, placeholder.from, placeholder.patch) }
  }

  /**
   * Sets the scan's done time if it has none, and says whether it did: of any number of callers exactly one gets true.
   * False when the scan was already marked or is unknown.
   */
  async markScanDone(scanId: string, at: Date): Promise<boolean> {
    const scan = this.scans.get(scanId)
    if (!scan || scan.doneAt !== null) return false
    scan.doneAt = at
    return true
  }

  /**
   * Takes back the done time `at`, and says whether it did. Applies only while the scan's done time is exactly `at`: false
   * when the scan has none, has a different one, or is unknown.
   */
  async clearScanDone(scanId: string, at: Date): Promise<boolean> {
    const scan = this.scans.get(scanId)
    if (!scan || scan.doneAt === null || scan.doneAt.getTime() !== at.getTime()) return false
    scan.doneAt = null
    return true
  }

  /**
   * Items in any of `states` last updated before `before` (an item updated exactly then is not included), oldest first,
   * at most `limit` of them.
   */
  async staleItems(states: ItemState[], before: Date, limit: number): Promise<ScanItem[]> {
    return [...this.items.values()]
      .filter((i) => states.includes(i.state) && i.updatedAt.getTime() < before.getTime())
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit)
      .map(copyItem)
  }

  /** Items that hold a front photo key although their state is not `recognising` or `needs-confirmation`, oldest `updatedAt` first, at most `limit`. */
  async itemsWithReleasablePhoto(limit: number): Promise<ScanItem[]> {
    return [...this.items.values()]
      .filter((i) => i.photoKey !== null && !isHeld(i.state))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit)
      .map(copyItem)
  }

  /** Clears the item's front photo key only while it is still `key`, and says whether it did. Nothing else changes, `updatedAt` included. */
  async clearItemPhotoKey(itemId: string, key: string): Promise<boolean> {
    const item = this.items.get(itemId)
    if (!item || item.photoKey !== key) return false
    item.photoKey = null
    return true
  }

  /** Photos that hold a key although none of their items is `recognising` or `needs-confirmation`, oldest `updatedAt` first, at most `limit`. */
  async shelfPhotosToRelease(limit: number): Promise<ScanPhoto[]> {
    const items = [...this.items.values()]
    return [...this.photos.values()]
      .filter((p) => p.photoKey !== null && !items.some((i) => i.scanId === p.scanId && i.photoId === p.id && isHeld(i.state)))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit)
      .map((p) => ({ ...p }))
  }

  /** The same for a scan photo's key. */
  async clearShelfPhotoKey(photoId: string, key: string): Promise<boolean> {
    const photo = this.photos.get(photoId)
    if (!photo || photo.photoKey !== key) return false
    photo.photoKey = null
    return true
  }

  /**
   * Scans with no done time, created at or after `createdSince`, whose items are all in one of `states` and were all last
   * updated before `before` (not at it), oldest scan first, at most `limit`. A scan with no items is never listed.
   */
  async settledScansNotDone(states: ItemState[], before: Date, createdSince: Date, limit: number): Promise<Scan[]> {
    const items = [...this.items.values()]
    return [...this.scans.values()]
      .filter((scan) => {
        const own = items.filter((i) => i.scanId === scan.id)
        return scan.doneAt === null && scan.createdAt.getTime() >= createdSince.getTime() && own.length > 0 && own.every((i) => states.includes(i.state) && i.updatedAt.getTime() < before.getTime())
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((scan) => ({ ...scan }))
  }

  /**
   * Photos uploaded by the user at or after `since`: one per item created then, plus one per back photo and one per retake
   * uploaded then (records that survive the photo being deleted, and that every upload adds). `oldest` is the earliest of them,
   * or null when there are none.
   */
  async photosSince(userId: string, since: Date): Promise<{ count: number; oldest: Date | null }> {
    return this.photoTimes((item) => item.userId === userId, (upload) => upload.userId === userId, since)
  }

  /** The same count for every scan made from the given IP hash (and every back photo and retake uploaded from it), whoever made them. */
  async photosSinceIp(ipHash: string, since: Date): Promise<{ count: number; oldest: Date | null }> {
    const scanIds = new Set([...this.scans.values()].filter((s) => s.ipHash === ipHash && s.createdAt.getTime() >= since.getTime()).map((s) => s.id))
    return this.photoTimes((item) => scanIds.has(item.scanId), (upload) => upload.ipHash === ipHash, since)
  }

  /** Every photo key and back-photo key still stored for these users' items, and every key on their scan photos (nulls left out). */
  async photoKeysForUsers(userIds: string[]): Promise<string[]> {
    const wanted = new Set(userIds)
    const keys: string[] = []
    for (const item of this.items.values()) {
      if (!wanted.has(item.userId)) continue
      if (item.photoKey !== null) keys.push(item.photoKey)
      if (item.backPhotoKey !== null) keys.push(item.backPhotoKey)
    }
    for (const photo of this.photos.values()) {
      if (wanted.has(photo.userId) && photo.photoKey !== null) keys.push(photo.photoKey)
    }
    return keys
  }

  /**
   * Gives each scan that has no profile its owner's default profile, oldest scan first, and says how many it changed. At most
   * `limit` scans are changed: a scan whose owner has no default is skipped and does not use up the limit, so it can never starve
   * the ones that can be adopted. It stays without a profile until a later call finds its owner has one.
   */
  async adoptOrphanScans(limit: number): Promise<number> {
    const adoptable = await Promise.all(
      [...this.scans.values()].filter((scan) => scan.profileId === null).map(async (scan) => ({ scan, profile: await this.profiles.defaultFor(scan.userId) })),
    )
    const chosen = adoptable
      .filter((a) => a.profile !== null)
      .sort((a, b) => a.scan.createdAt.getTime() - b.scan.createdAt.getTime())
      .slice(0, limit)
    for (const { scan, profile } of chosen) scan.profileId = profile!.id
    return chosen.length
  }

  /** Deletes the users' scans, photos, items, back-photo records and retake records. Safe to repeat; an empty list or unknown users delete nothing. */
  async deleteForUsers(userIds: string[]): Promise<void> {
    const wanted = new Set(userIds)
    for (const [id, scan] of this.scans) {
      if (wanted.has(scan.userId)) this.scans.delete(id)
    }
    for (const [id, photo] of this.photos) {
      if (wanted.has(photo.userId)) this.photos.delete(id)
    }
    for (const [id, item] of this.items) {
      if (wanted.has(item.userId)) this.items.delete(id)
    }
    for (const [id, upload] of this.backPhotos) {
      if (wanted.has(upload.userId)) this.backPhotos.delete(id)
    }
    for (const [id, upload] of this.retakes) {
      if (wanted.has(upload.userId)) this.retakes.delete(id)
    }
  }

  async countBackPhotos(itemId: string): Promise<number> {
    return [...this.backPhotos.values()].filter((upload) => upload.itemId === itemId).length
  }

  /** How many retakes have been uploaded for the item, whatever became of their photos. */
  async countRetakes(itemId: string): Promise<number> {
    return [...this.retakes.values()].filter((upload) => upload.itemId === itemId).length
  }

  private async shelve(item: ScanItem, state: 'ready' | 'unidentified'): Promise<void> {
    const profileId = this.scans.get(item.scanId)?.profileId
    if (!profileId || (this.knowsProfiles && !(await this.profiles.findById(profileId)))) return
    const at = item.updatedAt
    if (state === 'unidentified') {
      if (this.shelf.rows.some((r) => r.itemId === item.id && r.productId === null)) return
      this.shelf.rows.push({ id: crypto.randomUUID(), profileId, kind: 'no-label', productId: null, formulationId: null, scanId: item.scanId, itemId: item.id, addedAt: at, lastScannedAt: at, removedAt: null, removedReason: null })
      return
    }
    if (item.productId === null) return
    const existing = this.shelf.rows.find((r) => r.profileId === profileId && r.productId === item.productId)
    if (existing) {
      Object.assign(existing, { formulationId: item.formulationId, scanId: item.scanId, itemId: item.id, lastScannedAt: at, removedAt: null, removedReason: null })
      return
    }
    this.shelf.rows.push({ id: crypto.randomUUID(), profileId, kind: 'product', productId: item.productId, formulationId: item.formulationId, scanId: item.scanId, itemId: item.id, addedAt: at, lastScannedAt: at, removedAt: null, removedReason: null })
  }

  /** Sets each field the patch names; a field left out (undefined) is unchanged, and null clears. */
  private apply(row: ScanItem | ScanPhoto, patch: ItemPatch | PhotoPatch): void {
    for (const [field, value] of Object.entries(patch)) {
      if (value !== undefined) (row as Record<string, unknown>)[field] = value
    }
  }

  private photoTimes(ownsItem: (item: ScanItem) => boolean, ownsUpload: (upload: NewBackPhoto) => boolean, since: Date) {
    const times: number[] = []
    for (const item of this.items.values()) {
      if (ownsItem(item) && item.createdAt.getTime() >= since.getTime()) times.push(item.createdAt.getTime())
    }
    for (const upload of [...this.backPhotos.values(), ...this.retakes.values()]) {
      if (ownsUpload(upload) && upload.uploadedAt.getTime() >= since.getTime()) times.push(upload.uploadedAt.getTime())
    }
    return { count: times.length, oldest: times.length === 0 ? null : new Date(Math.min(...times)) }
  }
}
