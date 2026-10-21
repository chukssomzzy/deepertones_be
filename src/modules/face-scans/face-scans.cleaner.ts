import type { PhotoStore } from '../../providers/photo-store/photo-store.provider'
import type { FaceScansRepository } from './face-scans.repository'

/**
 * The face scans' part of the daily guest cleanup. Like ScanDataCleaner it needs only the repository and the bucket. The rows cascade
 * from the guest's profile, but the bucket does not, so the photos and masks are deleted here.
 */
export class FaceDataCleaner {
  private readonly repository: FaceScansRepository
  private readonly photos: PhotoStore

  constructor(deps: { repository: FaceScansRepository; photos: PhotoStore }) {
    this.repository = deps.repository
    this.photos = deps.photos
  }

  /** Deletes these users' face photos and masks, then their face rows. The bucket goes first, so if it fails the rows stay and the next run finds the same keys; both halves are safe to repeat. */
  async deleteForUsers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return
    await this.photos.deleteMany(await this.repository.photoKeysForUsers(userIds))
    await this.repository.deleteForUsers(userIds)
  }
}
