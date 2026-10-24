import type { faceConsents, faceMasks, faceResults, faceScanPhotos, faceScans, profileFitzpatrick } from './face-scans.table'

export type FaceConsent = typeof faceConsents.$inferSelect
export type FaceScan = typeof faceScans.$inferSelect
export type FaceScanPhoto = typeof faceScanPhotos.$inferSelect
export type FaceResult = typeof faceResults.$inferSelect
export type FaceMask = typeof faceMasks.$inferSelect
export type ProfileFitzpatrick = typeof profileFitzpatrick.$inferSelect

export type FaceScanState = FaceScan['state']
export type FaceScanReason = NonNullable<FaceScan['reason']>
export type FacePhotoPosition = FaceScanPhoto['position']

/**
 * What a new face scan needs: it always starts `analysing`, with no reason, task, result or skin reading, and `updatedAt` equal to `createdAt`.
 * `checkIn` is optional, defaulting to false: only the chase's wider review-point scan is one (issue #145).
 */
export type NewFaceScan = Pick<FaceScan, 'id' | 'userId' | 'profileId' | 'goalAtScan' | 'createdAt'> & Partial<Pick<FaceScan, 'checkIn'>>

export type NewFacePhoto = Pick<FaceScanPhoto, 'faceScanId' | 'userId' | 'position' | 'photoKey' | 'createdAt'>

/** A change to a face scan: any column but its identity, owner, goal and creation time, and when it was made. A field left out is unchanged; null clears it. */
export type FaceScanPatch = Partial<Omit<FaceScan, 'id' | 'userId' | 'profileId' | 'goalAtScan' | 'createdAt' | 'updatedAt'>> & { updatedAt: Date }

export type GiveFaceConsent = { profileId: string; userId: string; version: number; at: Date }

/** What a finished analysis writes, all together: the rows, the skin reading and the version of the tables that wrote it. The scan becomes `ready` at `updatedAt`. */
export type FaceScanCompletion = {
  results: FaceResult[]
  masks: FaceMask[]
  skinType: FaceScan['skinType']
  skinAge: FaceScan['skinAge']
  tablesVersion: string
  updatedAt: Date
}
