import type { FaceScansRepository } from './face-scans.repository'
import type {
  FaceConsent,
  FaceMask,
  FacePhotoPosition,
  FaceResult,
  FaceScan,
  FaceScanCompletion,
  FaceScanPatch,
  FaceScanPhoto,
  FaceScanState,
  GiveFaceConsent,
  NewFacePhoto,
  NewFaceScan,
  ProfileFitzpatrick,
} from './face-scans.types'

const ORDER: readonly FacePhotoPosition[] = ['front', 'right', 'left']

/**
 * In-memory FaceScansRepository for unit tests. Its behaviour is pinned by faceScansRepositoryContract, which the D1 class also
 * passes: the doc comments on the D1 class say what each method promises, and this one keeps the same promises. It holds no profiles,
 * so any profile id counts as existing (the D1 twin enforces that the profile is real).
 */
export class FakeFaceScansRepository implements FaceScansRepository {
  private consents = new Map<string, FaceConsent>()
  // A Map keeps insertion order, which is what "the scan written last" means for scans made at the same time.
  private scans = new Map<string, FaceScan>()
  private photos = new Map<string, FaceScanPhoto[]>()
  private results = new Map<string, FaceResult[]>()
  private masks = new Map<string, FaceMask[]>()
  private fitzpatricks = new Map<string, ProfileFitzpatrick>()

  async consentOf(profileId: string): Promise<FaceConsent | null> {
    const found = this.consents.get(profileId)
    return found ? { ...found } : null
  }

  async giveConsent({ profileId, userId, version, at }: GiveFaceConsent): Promise<void> {
    this.consents.set(profileId, { profileId, userId, version, givenAt: at, withdrawnAt: null })
  }

  async withdrawConsent(profileId: string, at: Date): Promise<void> {
    const found = this.consents.get(profileId)
    if (found && found.withdrawnAt === null) this.consents.set(profileId, { ...found, withdrawnAt: at })
  }

  // No await between the check and the write, so of simultaneous calls the first to run writes and the rest see its scan: the atomic step D1 gets from one batch.
  async createFaceScan(scan: NewFaceScan, photos: NewFacePhoto[], options?: { expectLatestId: string | null }): Promise<boolean> {
    if (this.scans.has(scan.id) || new Set(photos.map((photo) => photo.position)).size !== photos.length) throw new Error('duplicate id or position')
    if (options && (this.latest(scan.profileId)?.id ?? null) !== options.expectLatestId) return false
    this.scans.set(scan.id, {
      ...scan,
      state: 'analysing',
      reason: null,
      pcAnalysisTaskId: null,
      pcFitzpatrickTaskId: null,
      pcEnvironment: null,
      skinAge: null,
      skinType: null,
      tablesVersion: null,
      reaperCheckedAt: null,
      updatedAt: scan.createdAt,
    })
    this.photos.set(scan.id, photos.map((photo) => ({ ...photo })))
    return true
  }

  async findFaceScan(id: string): Promise<FaceScan | null> {
    const found = this.scans.get(id)
    return found ? { ...found } : null
  }

  async photosOf(faceScanId: string): Promise<FaceScanPhoto[]> {
    return [...(this.photos.get(faceScanId) ?? [])].sort((a, b) => ORDER.indexOf(a.position) - ORDER.indexOf(b.position)).map((photo) => ({ ...photo }))
  }

  async latestForProfile(profileId: string): Promise<FaceScan | null> {
    const latest = this.latest(profileId)
    return latest ? { ...latest } : null
  }

  async updateFaceScan(id: string, expected: FaceScanState, patch: FaceScanPatch, options?: { onlyIfNoAnalysisTask?: true }): Promise<boolean> {
    const found = this.scans.get(id)
    if (!found || found.state !== expected) return false
    if (options?.onlyIfNoAnalysisTask && found.pcAnalysisTaskId !== null) return false
    this.scans.set(id, { ...found, ...patch })
    return true
  }

  async markReaperChecked(id: string, at: Date): Promise<boolean> {
    const found = this.scans.get(id)
    if (!found || found.state !== 'analysing' || found.reaperCheckedAt !== null) return false
    this.scans.set(id, { ...found, reaperCheckedAt: at })
    return true
  }

  async findByTaskId(taskId: string): Promise<FaceScan | null> {
    for (const scan of this.scans.values()) {
      if (scan.pcAnalysisTaskId === taskId || scan.pcFitzpatrickTaskId === taskId) return { ...scan }
    }
    return null
  }

  async staleAnalysing(before: Date, limit: number, options?: { unchecked?: true }): Promise<FaceScan[]> {
    return [...this.scans.values()]
      .filter((scan) => scan.state === 'analysing' && scan.updatedAt.getTime() < before.getTime() && (!options?.unchecked || scan.reaperCheckedAt === null))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit)
      .map((scan) => ({ ...scan }))
  }

  // One step, like the D1 batch: the state is checked and everything is written with no await between.
  async completeFaceScan(id: string, completion: FaceScanCompletion): Promise<boolean> {
    const found = this.scans.get(id)
    if (!found || found.state !== 'analysing') return false
    this.results.set(id, completion.results.map((row) => ({ ...row })))
    this.masks.set(id, completion.masks.map((row) => ({ ...row })))
    this.scans.set(id, {
      ...found,
      state: 'ready',
      skinType: completion.skinType,
      skinAge: completion.skinAge,
      tablesVersion: completion.tablesVersion,
      updatedAt: completion.updatedAt,
    })
    return true
  }

  async resultsOf(faceScanId: string): Promise<FaceResult[]> {
    return (this.results.get(faceScanId) ?? []).map((row) => ({ ...row }))
  }

  async masksOf(faceScanId: string): Promise<FaceMask[]> {
    return (this.masks.get(faceScanId) ?? []).map((row) => ({ ...row }))
  }

  async fitzpatrickOf(profileId: string): Promise<ProfileFitzpatrick | null> {
    const found = this.fitzpatricks.get(profileId)
    return found ? { ...found } : null
  }

  async saveFitzpatrick(row: ProfileFitzpatrick): Promise<void> {
    if (!this.fitzpatricks.has(row.profileId)) this.fitzpatricks.set(row.profileId, { ...row })
  }

  private latest(profileId: string): FaceScan | null {
    let latest: FaceScan | null = null
    for (const scan of this.scans.values()) {
      if (scan.profileId !== profileId || scan.state === 'failed') continue
      if (!latest || scan.createdAt.getTime() >= latest.createdAt.getTime()) latest = scan
    }
    return latest
  }

  async keysOfFaceScan(faceScanId: string): Promise<string[]> {
    return [...(this.photos.get(faceScanId) ?? []).map((photo) => photo.photoKey), ...(this.masks.get(faceScanId) ?? []).map((mask) => mask.maskKey)]
  }

  async deleteFaceScan(id: string): Promise<void> {
    this.scans.delete(id)
    this.photos.delete(id)
    this.results.delete(id)
    this.masks.delete(id)
  }

  async photoKeysForUsers(userIds: string[]): Promise<string[]> {
    const users = new Set(userIds)
    const photos = [...this.photos.values()].flat().filter((photo) => users.has(photo.userId)).map((photo) => photo.photoKey)
    const masks = [...this.masks.values()].flat().filter((mask) => users.has(mask.userId)).map((mask) => mask.maskKey)
    return [...photos, ...masks]
  }

  async deleteForUsers(userIds: string[]): Promise<void> {
    const users = new Set(userIds)
    for (const [id, scan] of this.scans) {
      if (!users.has(scan.userId)) continue
      this.scans.delete(id)
      this.photos.delete(id)
      this.results.delete(id)
      this.masks.delete(id)
    }
    for (const [profileId, fitzpatrick] of this.fitzpatricks) if (users.has(fitzpatrick.userId)) this.fitzpatricks.delete(profileId)
    for (const [profileId, consent] of this.consents) if (users.has(consent.userId)) this.consents.delete(profileId)
  }
}
