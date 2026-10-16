import type { PhotoStore } from '../../providers/photo-store/photo-store.provider'
import type { ScansRepository } from './scans.repository'

/**
 * The scan module's part of the daily guest cleanup. Apart from ScanService on purpose: it needs only the repository and
 * the photo bucket, so the cleanup does not build the catalog and the model clients (or need their settings) to delete rows.
 */
export class ScanDataCleaner {
  readonly #repository: ScansRepository
  readonly #photos: PhotoStore

  constructor(deps: { repository: ScansRepository; photos: PhotoStore }) {
    this.#repository = deps.repository
    this.#photos = deps.photos
  }

  /**
   * Deletes these users' photos and back photos, then their scans, items and back-photo records. The photos go first, so
   * if the bucket fails the rows stay and the next run finds the same keys; both halves are safe to repeat.
   */
  async deleteForUsers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return
    await this.#photos.deleteMany(await this.#repository.photoKeysForUsers(userIds))
    await this.#repository.deleteForUsers(userIds)
  }
}
