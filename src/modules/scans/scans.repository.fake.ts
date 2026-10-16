import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import type { ScansRepository } from './scans.repository'
import type { ItemPatch, ItemState, NewBackPhoto, NewScan, NewScanItem, Scan, ScanItem } from './scans.types'

const copyItem = (item: ScanItem): ScanItem => ({ ...item })

/**
 * In-memory ScansRepository for unit tests. Its behaviour is pinned by scansRepositoryContract, which the D1 class also
 * passes: the doc comments below say what each method promises, and the D1 class must keep the same promises.
 */
export class FakeScansRepository implements ScansRepository {
  private scans = new Map<string, Scan>()
  private items = new Map<string, ScanItem>()
  private backPhotos = new Map<string, NewBackPhoto>()
  private readonly profiles: FakeProfilesRepository

  /** Pass the fake profiles repository a test writes defaults into: `adoptOrphanScans` reads each owner's default from it, as D1 reads the profiles table. */
  constructor(options: { profiles?: FakeProfilesRepository } = {}) {
    this.profiles = options.profiles ?? new FakeProfilesRepository()
  }

  /**
   * Stores the scan and all its items, or nothing. Every item starts `recognising` with no reason, no recognised
   * fields, no product, no back photo, and `updatedAt` equal to `createdAt`. Rejects (storing nothing) if any id is taken.
   */
  async createScan(scan: NewScan, items: NewScanItem[]): Promise<void> {
    const ids = items.map((i) => i.id)
    if (this.scans.has(scan.id) || new Set(ids).size !== ids.length || ids.some((id) => this.items.has(id))) {
      throw new Error('duplicate id')
    }
    this.scans.set(scan.id, { ...scan, doneAt: null })
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
        updatedAt: item.createdAt,
      })
    }
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
   * not at all when it does not.
   */
  async updateItem(itemId: string, expected: ItemState, patch: ItemPatch, backPhoto?: NewBackPhoto): Promise<boolean> {
    const item = this.items.get(itemId)
    if (!item || item.state !== expected) return false
    for (const [field, value] of Object.entries(patch)) {
      if (value !== undefined) (item as Record<string, unknown>)[field] = value
    }
    if (backPhoto) this.backPhotos.set(backPhoto.id, { ...backPhoto })
    return true
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
   * Photos uploaded by the user at or after `since`: one per item created then, plus one per back photo uploaded then
   * (a record that survives the back photo being deleted, and that every upload adds). `oldest` is the earliest of them,
   * or null when there are none.
   */
  async photosSince(userId: string, since: Date): Promise<{ count: number; oldest: Date | null }> {
    return this.photoTimes((item) => item.userId === userId, (upload) => upload.userId === userId, since)
  }

  /** The same count for every scan made from the given IP hash (and every back photo uploaded from it), whoever made them. */
  async photosSinceIp(ipHash: string, since: Date): Promise<{ count: number; oldest: Date | null }> {
    const scanIds = new Set([...this.scans.values()].filter((s) => s.ipHash === ipHash && s.createdAt.getTime() >= since.getTime()).map((s) => s.id))
    return this.photoTimes((item) => scanIds.has(item.scanId), (upload) => upload.ipHash === ipHash, since)
  }

  /** Every photo key and back-photo key still stored for these users' items (nulls left out). */
  async photoKeysForUsers(userIds: string[]): Promise<string[]> {
    const wanted = new Set(userIds)
    const keys: string[] = []
    for (const item of this.items.values()) {
      if (!wanted.has(item.userId)) continue
      if (item.photoKey !== null) keys.push(item.photoKey)
      if (item.backPhotoKey !== null) keys.push(item.backPhotoKey)
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

  /** Deletes the users' scans, items and back-photo records. Safe to repeat; an empty list or unknown users delete nothing. */
  async deleteForUsers(userIds: string[]): Promise<void> {
    const wanted = new Set(userIds)
    for (const [id, scan] of this.scans) {
      if (wanted.has(scan.userId)) this.scans.delete(id)
    }
    for (const [id, item] of this.items) {
      if (wanted.has(item.userId)) this.items.delete(id)
    }
    for (const [id, upload] of this.backPhotos) {
      if (wanted.has(upload.userId)) this.backPhotos.delete(id)
    }
  }

  private photoTimes(ownsItem: (item: ScanItem) => boolean, ownsUpload: (upload: NewBackPhoto) => boolean, since: Date) {
    const times: number[] = []
    for (const item of this.items.values()) {
      if (ownsItem(item) && item.createdAt.getTime() >= since.getTime()) times.push(item.createdAt.getTime())
    }
    for (const upload of this.backPhotos.values()) {
      if (ownsUpload(upload) && upload.uploadedAt.getTime() >= since.getTime()) times.push(upload.uploadedAt.getTime())
    }
    return { count: times.length, oldest: times.length === 0 ? null : new Date(Math.min(...times)) }
  }
}
